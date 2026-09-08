//! OPT-17 / OPT-18: Resolve OS SMB mappings to a local path.
//!
//! When config is `smb://host/share[/sub]` and the OS already has a mapped
//! drive (Windows) or SMB mount (macOS/Linux) to the same UNC (or a prefix),
//! prefer `ServerTarget::Local` so the app does not open a second `smb2`
//! session against hosts with tight session limits.
//!
//! - Windows (OPT-17): `WNetGetConnectionW` drive letters
//! - Unix (OPT-18): see [`super::unix_mapping`]
//!
//! Reachability uses a **timed** Local-Probe (OPT-20B) — never unbounded
//! `Path::exists()` on a sleeping Windows redirector.
//!
//! No automatic `net use` / mount creation (→ OPT-19).

use std::path::{Path, PathBuf};

/// One connected disk mapping (`Z:` → `\\host\share[\…]`) or Unix mount
/// (`/Volumes/…` / gvfs / CIFS → same UNC form).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveMapping {
    /// Local root: Windows `Z:` or Unix absolute mount path.
    pub local_name: String,
    /// Remote UNC, normalized (`\\host\share…`, backslashes).
    pub remote_unc: String,
}

/// Canonical UNC for matching: `\\host\share[\sub…]`, lowercase, `\` separators,
/// no trailing slash (except the leading `\\`).
pub fn canonicalize_unc(raw: &str) -> String {
    let s = raw.trim().replace('/', r"\");
    let body = s.trim_start_matches('\\').trim_end_matches('\\');
    let collapsed = body
        .split('\\')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(r"\");
    format!(r"\\{}", collapsed.to_ascii_lowercase())
}

/// Build canonical UNC from parsed SMB parts (host without port).
pub fn unc_from_smb_parts(host: &str, share: &str, subpath: &str) -> String {
    let host = host.trim().trim_matches(|c| c == '\\' || c == '/');
    let share = share.trim().trim_matches(|c| c == '\\' || c == '/');
    let sub = subpath
        .trim()
        .trim_matches(|c| c == '\\' || c == '/')
        .replace('/', r"\");
    if sub.is_empty() {
        canonicalize_unc(&format!(r"\\{host}\{share}"))
    } else {
        canonicalize_unc(&format!(r"\\{host}\{share}\{sub}"))
    }
}

/// If `config_unc` matches a mapping (equal or map is a prefix of config),
/// return the local filesystem path under that drive / mount.
///
/// Map deeper than config → no match (cannot write to parent of mapped root).
pub fn match_unc_to_mapped_path(config_unc: &str, mappings: &[DriveMapping]) -> Option<PathBuf> {
    let config = canonicalize_unc(config_unc);
    if config == r"\\" || config.len() < 5 {
        return None;
    }

    let mut best: Option<(usize, PathBuf)> = None;

    for m in mappings {
        let remote = canonicalize_unc(&m.remote_unc);
        if remote == r"\\" {
            continue;
        }
        let local_root_name = m.local_name.trim();
        if local_root_name.is_empty() || !is_usable_local_root(local_root_name) {
            continue;
        }

        let remainder = if config == remote {
            Some(String::new())
        } else if config.starts_with(&remote)
            && config.as_bytes().get(remote.len()) == Some(&b'\\')
        {
            Some(config[remote.len() + 1..].replace('/', r"\"))
        } else {
            // Map deeper than config, or unrelated — skip
            None
        };

        let Some(rest) = remainder else {
            continue;
        };

        // Prefer the longest matching remote prefix (most specific map).
        let score = remote.len();
        let path = join_under_local_root(local_root_name, &rest);
        match &best {
            Some((best_score, _)) if *best_score >= score => {}
            _ => best = Some((score, path)),
        }
    }

    best.map(|(_, p)| p)
}

/// Windows drive letter (`Z:`) or Unix absolute path (`/Volumes/…`).
fn is_usable_local_root(local_name: &str) -> bool {
    let t = local_name.trim().trim_end_matches(['\\', '/']);
    if t.is_empty() {
        return false;
    }
    if is_windows_drive_root(t) {
        return true;
    }
    // Unix absolute mount / explicit local path (also allows `Z:\subdir` style).
    Path::new(t).is_absolute() || t.contains(['/', '\\'])
}

fn is_windows_drive_root(local_name: &str) -> bool {
    let t = local_name.trim().trim_end_matches(['\\', '/']);
    if t.ends_with(':') {
        let letter = &t[..t.len() - 1];
        return letter.len() == 1 && letter.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    }
    t.len() == 1 && t.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
}

/// `Z:` / `Z:\` → `Z:`
fn mapping_drive_letter(local_name: &str) -> Option<String> {
    let t = local_name.trim().trim_end_matches(['\\', '/']);
    if t.is_empty() {
        return None;
    }
    if t.ends_with(':') {
        Some(t.to_string())
    } else if t.len() == 1 && t.chars().next()?.is_ascii_alphabetic() {
        Some(format!("{t}:"))
    } else {
        None
    }
}

/// Local FS path under a mapped drive or Unix mount root.
///
/// Windows drive roots use `Z:\` so `.exists()` checks the volume root, not the
/// process CWD on that drive.
fn join_under_local_root(local_name: &str, remainder: &str) -> PathBuf {
    let mut path = if let Some(letter) = mapping_drive_letter(local_name) {
        PathBuf::from(format!(r"{letter}\"))
    } else {
        PathBuf::from(local_name.trim().trim_end_matches(['\\', '/']))
    };
    for part in remainder.split(['\\', '/']).filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

/// List connected SMB mappings: Windows drive maps (OPT-17) or Unix OS mounts (OPT-18).
pub fn list_smb_drive_mappings() -> Vec<DriveMapping> {
    #[cfg(windows)]
    {
        list_smb_drive_mappings_windows()
    }
    #[cfg(not(windows))]
    {
        super::unix_mapping::list_os_smb_mounts()
    }
}

/// Match config UNC to a mapped local path **without** FS reachability checks.
///
/// Use this when Prefer-Local / smb2-bridge logic needs to know a map is listed
/// even if `Z:` is still waking (OPT-20B).
pub fn lookup_mapped_local_path(config_unc: &str) -> Option<PathBuf> {
    let mappings = list_smb_drive_mappings();
    match_unc_to_mapped_path(config_unc, &mappings)
}

/// Resolve config UNC against live mappings; require local root reachable
/// via timed probe (OPT-20B — no unbounded `exists()`).
#[allow(dead_code)] // public helper for callers outside Prefer-Local bridge path
pub fn resolve_mapped_local_path(config_unc: &str) -> Option<PathBuf> {
    let path = lookup_mapped_local_path(config_unc)?;
    // Prefer smb2 fallback when the map exists but the letter is dead/offline.
    if super::reconnect::prefer_local_now(&path) {
        Some(path)
    } else {
        None
    }
}

#[cfg(windows)]
fn list_smb_drive_mappings_windows() -> Vec<DriveMapping> {
    use std::os::windows::ffi::OsStringExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::NetworkManagement::WNet::WNetGetConnectionW;

    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let local = format!("{}:", letter as char);
        let local_wide: Vec<u16> = local
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // First call: query required buffer length (chars, including NUL).
        let mut needed: u32 = 0;
        let status = unsafe {
            WNetGetConnectionW(PCWSTR(local_wide.as_ptr()), None, &mut needed)
        };
        // Not a network drive / not connected → skip.
        if status != ERROR_MORE_DATA && status != ERROR_SUCCESS {
            continue;
        }
        if needed == 0 {
            continue;
        }

        let mut buf = vec![0u16; needed as usize];
        let mut len = needed;
        let status = unsafe {
            WNetGetConnectionW(
                PCWSTR(local_wide.as_ptr()),
                Some(PWSTR(buf.as_mut_ptr())),
                &mut len,
            )
        };
        if status != ERROR_SUCCESS {
            continue;
        }

        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        if end == 0 {
            continue;
        }
        let remote = std::ffi::OsString::from_wide(&buf[..end]);
        let remote = remote.to_string_lossy();
        if remote.is_empty() {
            continue;
        }
        // Only UNC remotes (skip non-SMB providers without \\).
        let remote_str = remote.as_ref();
        if !(remote_str.starts_with(r"\\") || remote_str.starts_with("//")) {
            continue;
        }
        out.push(DriveMapping {
            local_name: local,
            remote_unc: canonicalize_unc(remote_str),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slash(p: &std::path::Path) -> String {
        p.to_string_lossy()
            .replace('/', r"\")
            .trim_end_matches('\\')
            .to_string()
    }

    #[test]
    fn canonicalize_slashes_and_case() {
        assert_eq!(
            canonicalize_unc(r"\\Host\Share\Sub"),
            r"\\host\share\sub"
        );
        assert_eq!(
            canonicalize_unc("//Host/Share/Sub/"),
            r"\\host\share\sub"
        );
    }

    #[test]
    fn unc_from_parts_with_subpath() {
        assert_eq!(
            unc_from_smb_parts("169.254.169.254", "aktuell", "jobs/a"),
            r"\\169.254.169.254\aktuell\jobs\a"
        );
        assert_eq!(
            unc_from_smb_parts("NAS", "videos", ""),
            r"\\nas\videos"
        );
    }

    #[test]
    fn match_exact_share_root() {
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\169.254.169.254\aktuell".into(),
        }];
        let p = match_unc_to_mapped_path(r"\\169.254.169.254\aktuell", &maps).unwrap();
        assert_eq!(slash(&p), "Z:");
    }

    #[test]
    fn match_share_root_plus_config_subpath() {
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\host\share".into(),
        }];
        let p = match_unc_to_mapped_path(r"\\host\share\sub\deep", &maps).unwrap();
        assert_eq!(slash(&p), r"Z:\sub\deep");
    }

    #[test]
    fn match_case_insensitive() {
        let maps = [DriveMapping {
            local_name: "Y:".into(),
            remote_unc: r"\\SERVER\Share".into(),
        }];
        let p = match_unc_to_mapped_path(r"\\server\share\x", &maps).unwrap();
        assert_eq!(slash(&p), r"Y:\x");
    }

    #[test]
    fn no_match_unrelated() {
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\other\share".into(),
        }];
        assert!(match_unc_to_mapped_path(r"\\host\share", &maps).is_none());
    }

    #[test]
    fn no_match_when_map_deeper_than_config() {
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\host\share\a\b\c".into(),
        }];
        assert!(match_unc_to_mapped_path(r"\\host\share\a\b", &maps).is_none());
    }

    #[test]
    fn prefer_longest_remote_prefix() {
        let maps = [
            DriveMapping {
                local_name: "Z:".into(),
                remote_unc: r"\\host\share".into(),
            },
            DriveMapping {
                local_name: "Y:".into(),
                remote_unc: r"\\host\share\sub".into(),
            },
        ];
        let p = match_unc_to_mapped_path(r"\\host\share\sub\file", &maps).unwrap();
        assert_eq!(slash(&p), r"Y:\file");
    }

    #[test]
    fn empty_mappings_no_match() {
        assert!(match_unc_to_mapped_path(r"\\host\share", &[]).is_none());
    }

    #[test]
    fn match_unix_absolute_mount_root() {
        let maps = [DriveMapping {
            local_name: "/Volumes/aktuell".into(),
            remote_unc: r"\\host\share".into(),
        }];
        let p = match_unc_to_mapped_path(r"\\host\share\sub", &maps).unwrap();
        assert_eq!(p, PathBuf::from("/Volumes/aktuell").join("sub"));
    }

    #[test]
    fn lookup_mapped_without_exists_check() {
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\host\share".into(),
        }];
        // match helper only — lookup uses live OS maps; here we assert join logic.
        let p = match_unc_to_mapped_path(r"\\host\share\sub", &maps).unwrap();
        assert_eq!(slash(&p), r"Z:\sub");
    }
}
