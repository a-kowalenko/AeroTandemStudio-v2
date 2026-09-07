//! OPT-17: Resolve Windows SMB drive mappings to a local path.
//!
//! When config is `smb://host/share[/sub]` and Windows already has a mapped
//! drive to the same UNC (or a prefix), prefer `ServerTarget::Local` so the
//! app does not open a second `smb2` session against hosts with tight
//! session limits.
//!
//! Non-Windows: always `None` (stub). No automatic `net use` / map creation.

use std::path::PathBuf;

/// One connected disk mapping (`Z:` → `\\host\share[\…]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveMapping {
    /// Local name including colon, e.g. `Z:`.
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
/// return the local filesystem path under that drive.
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
        let local_root_name = m.local_name.clone();
        // Validate local name early (same rules as join).
        if mapping_drive_letter(&local_root_name).is_none() {
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
        let path = join_under_drive(&local_root_name, &rest);
        match &best {
            Some((best_score, _)) if *best_score >= score => {}
            _ => best = Some((score, path)),
        }
    }

    best.map(|(_, p)| p)
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
        // Already something like `Z:`-prefixed path — treat full string as root name.
        Some(t.to_string())
    }
}

/// Local FS path under a mapped drive. Uses `Z:\` (root) so `.exists()` checks the
/// volume root on Windows, not the process CWD on that drive.
fn join_under_drive(local_name: &str, remainder: &str) -> PathBuf {
    let letter = mapping_drive_letter(local_name).unwrap_or_else(|| local_name.to_string());
    let mut path = PathBuf::from(format!(r"{letter}\"));
    for part in remainder.split(['\\', '/']).filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

/// List connected SMB/disk mappings. Empty on non-Windows or on API failure.
pub fn list_smb_drive_mappings() -> Vec<DriveMapping> {
    #[cfg(windows)]
    {
        list_smb_drive_mappings_windows()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Resolve config UNC against live mappings; require local root reachable.
pub fn resolve_mapped_local_path(config_unc: &str) -> Option<PathBuf> {
    let mappings = list_smb_drive_mappings();
    let path = match_unc_to_mapped_path(config_unc, &mappings)?;
    // Prefer smb2 fallback when the map exists but the letter is dead/offline.
    if path.exists() {
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
}
