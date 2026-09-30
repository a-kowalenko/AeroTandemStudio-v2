//! OPT-17 / OPT-18: Resolve OS SMB mappings to a local path.
//!
//! When config is `smb://host/share[/sub]` and the OS already has a mapped
//! drive (Windows) or SMB mount (macOS/Linux) to the same UNC (or a prefix),
//! prefer `ServerTarget::Local` so the app does not open a second `smb2`
//! session against hosts with tight session limits.
//!
//! - Windows (OPT-17): `WNetGetConnectionW` drive letters
//! - Windows (OPT-23D): `WNetOpenEnum(RESOURCE_CONNECTED)` deviceless UNC
//! - Unix (OPT-18): see [`super::unix_mapping`]
//!
//! Reachability uses a **timed** Local-Probe (OPT-20B) — never unbounded
//! `Path::exists()` on a sleeping Windows redirector.
//!
//! No automatic `net use` / mount creation (→ OPT-19).
//!
//! Host spelling (OPT-23C): string match first. Only when that misses and a
//! mapping's share path is a prefix of the config do we ask the alias resolver
//! (short name ↔ FQDN, then IP-set intersection).

use std::path::{Path, PathBuf};

use super::host_alias::HostResolver;

/// One connected disk mapping (`Z:` → `\\host\share[\…]`), a deviceless
/// Windows connection whose local root **is** the UNC, or a Unix mount
/// (`/Volumes/…` / gvfs / CIFS → same UNC form).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveMapping {
    /// Local root: Windows `Z:`, deviceless `\\host\share`, or Unix mount path.
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

/// Mapping root plus the config path joined under it.
///
/// `root` is what OPT-23B probes for liveness (`Z:\`, mount root). `full` is
/// the upload/health target and may be a missing subdirectory of `root`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedLocal {
    pub root: PathBuf,
    pub full: PathBuf,
}

/// If `config_unc` matches a mapping (equal or map is a prefix of config),
/// return the local filesystem path under that drive / mount.
///
/// Map deeper than config → no match (cannot write to parent of mapped root).
/// Host aliases (IP ↔ name, short name ↔ FQDN) are stage 2 — see
/// [`match_unc_to_mapped_local`].
pub fn match_unc_to_mapped_path(config_unc: &str, mappings: &[DriveMapping]) -> Option<PathBuf> {
    match_unc_to_mapped_local(config_unc, mappings).map(|m| m.full)
}

/// Like [`match_unc_to_mapped_path`], but also returns the mapping root.
///
/// Stage 1 is a string compare (no DNS). Stage 2 runs only after a miss, and
/// only for mappings whose share path is a prefix of the config.
pub fn match_unc_to_mapped_local(
    config_unc: &str,
    mappings: &[DriveMapping],
) -> Option<MappedLocal> {
    match_unc_to_mapped_local_with(config_unc, mappings, super::host_alias::global())
}

/// Same as [`match_unc_to_mapped_local`] with an injected resolver (tests).
pub(crate) fn match_unc_to_mapped_local_with(
    config_unc: &str,
    mappings: &[DriveMapping],
    resolver: &HostResolver,
) -> Option<MappedLocal> {
    if let Some(hit) = match_unc_by_string(config_unc, mappings) {
        return Some(hit);
    }
    match_unc_by_alias(config_unc, mappings, resolver)
}

/// Stage 1: canonical UNC string prefix. No resolver calls.
fn match_unc_by_string(config_unc: &str, mappings: &[DriveMapping]) -> Option<MappedLocal> {
    let config = canonicalize_unc(config_unc);
    if config == r"\\" || config.len() < 5 {
        return None;
    }

    let mut best: Option<(usize, u8, MappedLocal)> = None;

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
        } else if config.starts_with(&remote) && config.as_bytes().get(remote.len()) == Some(&b'\\')
        {
            Some(config[remote.len() + 1..].replace('/', r"\"))
        } else {
            // Map deeper than config, or unrelated — skip
            None
        };

        let Some(rest) = remainder else {
            continue;
        };

        // Longest remote prefix wins. Equal length: drive letter before UNC
        // (OPT-23D order: mapped drive, then deviceless).
        consider_mapping(&mut best, remote.len(), local_root_name, &rest);
    }

    best.map(|(_, _, mapped)| mapped)
}

struct UncParts {
    host: String,
    /// Share plus optional subpath. Never empty.
    segments: Vec<String>,
}

fn parse_unc_parts(unc: &str) -> Option<UncParts> {
    let body = unc.trim_start_matches('\\');
    if body.is_empty() {
        return None;
    }
    let mut iter = body.split('\\').filter(|part| !part.is_empty());
    let host = iter.next()?.to_string();
    let segments: Vec<String> = iter.map(str::to_string).collect();
    if host.is_empty() || segments.is_empty() {
        return None;
    }
    Some(UncParts { host, segments })
}

/// Map segments are a prefix of the config path. `None` when the map is deeper
/// or the share differs — those cannot be a local root for this config.
fn remainder_after_prefix(config: &[String], map: &[String]) -> Option<String> {
    if map.is_empty() || map.len() > config.len() || config[..map.len()] != map[..] {
        return None;
    }
    Some(config[map.len()..].join(r"\"))
}

/// Stage 2 (OPT-23C): same share path, host compared via the alias resolver.
///
/// DNS runs only for a candidate that can actually win (share path is a
/// prefix). A string-equal host returns before any lookup.
fn match_unc_by_alias(
    config_unc: &str,
    mappings: &[DriveMapping],
    resolver: &HostResolver,
) -> Option<MappedLocal> {
    let config = canonicalize_unc(config_unc);
    let cfg = parse_unc_parts(&config)?;

    let mut best: Option<(usize, u8, MappedLocal)> = None;
    let mut matched_host: Option<String> = None;

    for m in mappings {
        let remote = canonicalize_unc(&m.remote_unc);
        let Some(map) = parse_unc_parts(&remote) else {
            continue;
        };
        let Some(rest) = remainder_after_prefix(&cfg.segments, &map.segments) else {
            continue;
        };
        let local_root_name = m.local_name.trim();
        if local_root_name.is_empty() || !is_usable_local_root(local_root_name) {
            continue;
        }
        // Prefix already failed stage 1, so the hosts differ — unless stage 1
        // skipped this row for another reason. String equality still skips DNS.
        if cfg.host != map.host && !resolver.hosts_equivalent(&cfg.host, &map.host) {
            continue;
        }

        let rank = local_root_rank(local_root_name);
        let replaces = match &best {
            Some((best_len, best_rank, _)) => {
                mapping_is_better(remote.len(), rank, *best_len, *best_rank)
            }
            None => true,
        };
        if replaces {
            matched_host = Some(map.host);
            best = Some((
                remote.len(),
                rank,
                MappedLocal {
                    root: local_root_path(local_root_name),
                    full: join_under_local_root(local_root_name, &rest),
                },
            ));
        }
    }

    let (mapped, map_host) = best.map(|(_, _, mapped)| (mapped, matched_host))?;
    if let Some(map_host) = map_host {
        if map_host != cfg.host {
            crate::storage::logging::info(
                "smb",
                format!(
                    "SMB host alias match {} ↔ {map_host} (share {})",
                    cfg.host,
                    cfg.segments.first().map(String::as_str).unwrap_or("")
                ),
            );
        }
    }
    Some(mapped)
}

/// Longer remote prefix wins. On a tie, a drive letter outranks a deviceless UNC.
fn mapping_is_better(len: usize, rank: u8, best_len: usize, best_rank: u8) -> bool {
    len > best_len || (len == best_len && rank > best_rank)
}

fn local_root_rank(local_name: &str) -> u8 {
    if mapping_drive_letter(local_name).is_some() {
        1
    } else {
        0
    }
}

fn consider_mapping(
    best: &mut Option<(usize, u8, MappedLocal)>,
    remote_len: usize,
    local_root_name: &str,
    rest: &str,
) {
    let rank = local_root_rank(local_root_name);
    let replaces = match best {
        Some((best_len, best_rank, _)) => {
            mapping_is_better(remote_len, rank, *best_len, *best_rank)
        }
        None => true,
    };
    if replaces {
        *best = Some((
            remote_len,
            rank,
            MappedLocal {
                root: local_root_path(local_root_name),
                full: join_under_local_root(local_root_name, rest),
            },
        ));
    }
}

/// Windows drive letter (`Z:`), deviceless UNC share root, or Unix absolute path.
fn is_usable_local_root(local_name: &str) -> bool {
    let t = local_name.trim().trim_end_matches(['\\', '/']);
    if t.is_empty() {
        return false;
    }
    if is_windows_drive_root(t) || is_unc_share_path(t) {
        return true;
    }
    // Unix absolute mount / explicit local path (also allows `Z:\subdir` style).
    // A bare `\\host` (no share) is not a redirector root.
    if t.starts_with(r"\\") || t.starts_with("//") {
        return false;
    }
    Path::new(t).is_absolute() || t.contains(['/', '\\'])
}

/// `\\host\share` or `//host/share` (optional deeper suffix). Not `\\host` alone.
fn is_unc_share_path(raw: &str) -> bool {
    let normalized = raw.trim().replace('/', r"\");
    if !normalized.starts_with(r"\\") {
        return false;
    }
    let body = normalized.trim_start_matches('\\').trim_end_matches('\\');
    let mut parts = body.split('\\').filter(|part| !part.is_empty());
    matches!(
        (parts.next(), parts.next()),
        (Some(host), Some(share)) if !host.is_empty() && !share.is_empty()
    )
}

fn is_windows_drive_root(local_name: &str) -> bool {
    let t = local_name.trim().trim_end_matches(['\\', '/']);
    if t.ends_with(':') {
        let letter = &t[..t.len() - 1];
        return letter.len() == 1
            && letter
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic());
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

/// `Z:` → `Z:\` (volume root, not the process CWD on that drive). Unix mount
/// paths stay as given, without a trailing slash.
fn local_root_path(local_name: &str) -> PathBuf {
    if let Some(letter) = mapping_drive_letter(local_name) {
        PathBuf::from(format!(r"{letter}\"))
    } else {
        PathBuf::from(local_name.trim().trim_end_matches(['\\', '/']))
    }
}

/// Local FS path under a mapped drive, deviceless UNC, or Unix mount root.
fn join_under_local_root(local_name: &str, remainder: &str) -> PathBuf {
    let mut path = local_root_path(local_name);
    for part in remainder.split(['\\', '/']).filter(|p| !p.is_empty()) {
        path.push(part);
    }
    path
}

/// Share-root and full path the Windows redirector would use for `\\host\share[\sub]`.
///
/// OPT-23D probes [`MappedLocal::root`] when no drive letter or deviceless
/// connection is listed. Both paths are canonical UNC (lowercase).
#[cfg(any(windows, test))]
pub(crate) fn unc_redirector_local(host: &str, share: &str, subpath: &str) -> MappedLocal {
    MappedLocal {
        root: PathBuf::from(unc_from_smb_parts(host, share, "")),
        full: PathBuf::from(unc_from_smb_parts(host, share, subpath)),
    }
}

/// List connected SMB mappings: Windows drive letters (OPT-17) plus deviceless
/// UNC connections (OPT-23D), or Unix OS mounts (OPT-18).
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
pub fn lookup_mapped_local(config_unc: &str) -> Option<MappedLocal> {
    let mappings = list_smb_drive_mappings();
    match_unc_to_mapped_local(config_unc, &mappings)
}

pub fn lookup_mapped_local_path(config_unc: &str) -> Option<PathBuf> {
    lookup_mapped_local(config_unc).map(|m| m.full)
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
        let local_wide: Vec<u16> = local.encode_utf16().chain(std::iter::once(0)).collect();

        // First call: query required buffer length (chars, including NUL).
        let mut needed: u32 = 0;
        let status = unsafe { WNetGetConnectionW(PCWSTR(local_wide.as_ptr()), None, &mut needed) };
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
    // Drive letters stay first so an equal-length match prefers `Z:` (D6).
    out.extend(list_deviceless_disk_connections());
    out
}

/// `net use \\host\share` (no drive letter) → local root is the UNC itself.
///
/// Drive-letter rows are omitted; [`list_smb_drive_mappings_windows`] already
/// collected those via `WNetGetConnectionW`.
#[cfg(any(windows, test))]
fn deviceless_mapping(local_name: Option<&str>, remote_name: &str) -> Option<DriveMapping> {
    let remote = remote_name.trim();
    if !is_unc_share_path(remote) {
        return None;
    }
    let local = local_name.unwrap_or("").trim();
    if mapping_drive_letter(local).is_some() {
        return None;
    }
    if !local.is_empty() && !is_unc_share_path(local) {
        return None;
    }
    let local_root = if is_unc_share_path(local) {
        local.trim_end_matches(['\\', '/']).to_string()
    } else {
        remote.trim_end_matches(['\\', '/']).to_string()
    };
    Some(DriveMapping {
        local_name: local_root,
        remote_unc: canonicalize_unc(remote),
    })
}

#[cfg(windows)]
fn list_deviceless_disk_connections() -> Vec<DriveMapping> {
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, HANDLE};
    use windows::Win32::NetworkManagement::WNet::{
        WNetCloseEnum, WNetEnumResourceW, WNetOpenEnumW, NETRESOURCEW, RESOURCETYPE_DISK,
        RESOURCE_CONNECTED, WNET_OPEN_ENUM_USAGE,
    };

    let mut handle = HANDLE::default();
    let status = unsafe {
        WNetOpenEnumW(
            RESOURCE_CONNECTED,
            RESOURCETYPE_DISK,
            WNET_OPEN_ENUM_USAGE(0),
            None,
            &mut handle,
        )
    };
    if status != ERROR_SUCCESS || handle.is_invalid() {
        if !handle.is_invalid() {
            unsafe {
                let _ = WNetCloseEnum(handle);
            }
        }
        crate::storage::logging::warn(
            "smb",
            format!("WNetOpenEnum connected disks failed: Win32 {status:?}"),
        );
        return Vec::new();
    }

    struct CloseEnum(HANDLE);
    impl Drop for CloseEnum {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = WNetCloseEnum(self.0);
                }
            }
        }
    }
    let guard = CloseEnum(handle);

    // 16 KiB is what MSDN suggests; grow if a single entry does not fit.
    let mut storage = vec![0u64; (16 * 1024) / 8];
    const MAX_WORDS: usize = (1024 * 1024) / 8;
    let mut out = Vec::new();

    for _ in 0..64 {
        let mut count: u32 = u32::MAX;
        let mut byte_len = u32::try_from(storage.len() * 8).unwrap_or(u32::MAX);
        let status = unsafe {
            WNetEnumResourceW(
                guard.0,
                &mut count,
                storage.as_mut_ptr() as *mut core::ffi::c_void,
                &mut byte_len,
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status == ERROR_MORE_DATA {
            let words = (byte_len as usize).div_ceil(8);
            if words <= storage.len() || storage.len() >= MAX_WORDS {
                crate::storage::logging::warn(
                    "smb",
                    "WNetEnumResource buffer could not grow; skipping remaining connections",
                );
                break;
            }
            storage.resize(words.min(MAX_WORDS), 0);
            continue;
        }
        if status != ERROR_SUCCESS {
            crate::storage::logging::warn(
                "smb",
                format!("WNetEnumResource failed: Win32 {status:?}"),
            );
            break;
        }
        if count == 0 {
            break;
        }
        let max_entries = storage.len() * 8 / std::mem::size_of::<NETRESOURCEW>();
        let n = (count as usize).min(max_entries);
        let entries =
            unsafe { std::slice::from_raw_parts(storage.as_ptr() as *const NETRESOURCEW, n) };
        for entry in entries {
            let remote = match pwstr_to_string(entry.lpRemoteName) {
                Some(remote) => remote,
                None => continue,
            };
            let local = pwstr_to_string(entry.lpLocalName);
            if let Some(mapping) = deviceless_mapping(local.as_deref(), &remote) {
                out.push(mapping);
            }
        }
    }
    out
}

#[cfg(windows)]
fn pwstr_to_string(ptr: windows::core::PWSTR) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let text = unsafe { String::from_utf16_lossy(ptr.as_wide()) };
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
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
        assert_eq!(canonicalize_unc(r"\\Host\Share\Sub"), r"\\host\share\sub");
        assert_eq!(canonicalize_unc("//Host/Share/Sub/"), r"\\host\share\sub");
    }

    #[test]
    fn unc_from_parts_with_subpath() {
        assert_eq!(
            unc_from_smb_parts("169.254.169.254", "aktuell", "jobs/a"),
            r"\\169.254.169.254\aktuell\jobs\a"
        );
        assert_eq!(unc_from_smb_parts("NAS", "videos", ""), r"\\nas\videos");
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

    #[test]
    fn mapped_local_root_stops_at_drive() {
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\host\share".into(),
        }];
        let mapped = match_unc_to_mapped_local(r"\\host\share\jobs\neu", &maps).unwrap();
        assert_eq!(slash(&mapped.root), "Z:");
        assert_eq!(slash(&mapped.full), r"Z:\jobs\neu");
    }

    #[test]
    fn mapped_local_root_unix_mount() {
        let maps = [DriveMapping {
            local_name: "/Volumes/aktuell".into(),
            remote_unc: r"\\host\share".into(),
        }];
        let mapped = match_unc_to_mapped_local(r"\\host\share\jobs\neu", &maps).unwrap();
        assert_eq!(mapped.root, PathBuf::from("/Volumes/aktuell"));
        assert_eq!(
            mapped.full,
            PathBuf::from("/Volumes/aktuell").join("jobs").join("neu")
        );
    }

    fn resolver_counting(
        lookup: impl Fn(&str) -> Option<Vec<std::net::IpAddr>> + Send + Sync + 'static,
    ) -> (
        super::super::host_alias::HostResolver,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls_lookup = std::sync::Arc::clone(&calls);
        let resolver = super::super::host_alias::HostResolver::new(move |host| {
            calls_lookup.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            lookup(host)
        });
        (resolver, calls)
    }

    #[test]
    fn stage1_string_hit_does_not_resolve() {
        let (resolver, calls) =
            resolver_counting(|_| Some(vec![std::net::IpAddr::from([1, 2, 3, 4])]));
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\192.168.1.10\aktuell".into(),
        }];
        let mapped =
            match_unc_to_mapped_local_with(r"\\192.168.1.10\aktuell\jobs", &maps, &resolver)
                .unwrap();
        assert_eq!(slash(&mapped.full), r"Z:\jobs");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(resolver.lookup_count(), 0);
    }

    #[test]
    fn stage2_skipped_when_share_differs() {
        let (resolver, calls) =
            resolver_counting(|_| Some(vec![std::net::IpAddr::from([1, 2, 3, 4])]));
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\nas\other".into(),
        }];
        assert!(
            match_unc_to_mapped_local_with(r"\\192.168.1.10\aktuell", &maps, &resolver).is_none()
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn stage2_deeper_map_does_not_resolve() {
        let (resolver, calls) =
            resolver_counting(|_| Some(vec![std::net::IpAddr::from([1, 2, 3, 4])]));
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\nas\aktuell\jobs\neu".into(),
        }];
        assert!(
            match_unc_to_mapped_local_with(r"\\192.168.1.10\aktuell\jobs", &maps, &resolver)
                .is_none()
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn public_match_short_name_without_injected_resolver() {
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\nas.local\aktuell".into(),
        }];
        let p = match_unc_to_mapped_path(r"\\nas\aktuell\jobs", &maps).unwrap();
        assert_eq!(slash(&p), r"Z:\jobs");
    }

    #[test]
    fn short_name_matches_fqdn_without_dns() {
        let (resolver, calls) =
            resolver_counting(|_| Some(vec![std::net::IpAddr::from([9, 9, 9, 9])]));
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\NAS.local\aktuell".into(),
        }];
        let mapped =
            match_unc_to_mapped_local_with(r"\\nas\aktuell\jobs\neu", &maps, &resolver).unwrap();
        assert_eq!(slash(&mapped.root), "Z:");
        assert_eq!(slash(&mapped.full), r"Z:\jobs\neu");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn ip_matches_name_via_fake_resolver() {
        let (resolver, calls) = resolver_counting(|host| match host {
            "nas" => Some(vec![std::net::IpAddr::from([192, 168, 1, 10])]),
            _ => None,
        });
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\NAS\aktuell".into(),
        }];
        let mapped =
            match_unc_to_mapped_local_with(r"\\192.168.1.10\aktuell", &maps, &resolver).unwrap();
        assert_eq!(slash(&mapped.full), "Z:");
        assert!(calls.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    }

    #[test]
    fn alias_prefers_longest_share_prefix() {
        let (resolver, _) = resolver_counting(|host| match host {
            "nas" | "nas.local" => Some(vec![std::net::IpAddr::from([10, 1, 2, 3])]),
            _ => None,
        });
        let maps = [
            DriveMapping {
                local_name: "Z:".into(),
                remote_unc: r"\\nas\aktuell".into(),
            },
            DriveMapping {
                local_name: "Y:".into(),
                remote_unc: r"\\nas.local\aktuell\sub".into(),
            },
        ];
        let mapped =
            match_unc_to_mapped_local_with(r"\\10.1.2.3\aktuell\sub\file", &maps, &resolver)
                .unwrap();
        assert_eq!(slash(&mapped.full), r"Y:\file");
    }

    #[test]
    fn disjoint_ip_sets_do_not_match() {
        let (resolver, _) = resolver_counting(|host| match host {
            "nas" => Some(vec![std::net::IpAddr::from([10, 0, 0, 5])]),
            _ => None,
        });
        let maps = [DriveMapping {
            local_name: "Z:".into(),
            remote_unc: r"\\nas\aktuell".into(),
        }];
        assert!(
            match_unc_to_mapped_local_with(r"\\192.168.1.10\aktuell", &maps, &resolver).is_none()
        );
    }

    #[test]
    fn unc_redirector_root_joins_subpath() {
        let mapped = unc_redirector_local("NAS", "Aktuell", "jobs/neu");
        assert_eq!(slash(&mapped.root), r"\\nas\aktuell");
        assert_eq!(slash(&mapped.full), r"\\nas\aktuell\jobs\neu");
    }

    #[test]
    fn match_deviceless_unc_local_name() {
        let maps = [DriveMapping {
            local_name: r"\\nas\aktuell".into(),
            remote_unc: r"\\nas\aktuell".into(),
        }];
        let mapped = match_unc_to_mapped_local(r"\\nas\aktuell\jobs\neu", &maps).unwrap();
        assert_eq!(slash(&mapped.root), r"\\nas\aktuell");
        assert_eq!(slash(&mapped.full), r"\\nas\aktuell\jobs\neu");
    }

    #[test]
    fn drive_letter_beats_equal_deviceless_unc() {
        let maps = [
            DriveMapping {
                local_name: r"\\host\share".into(),
                remote_unc: r"\\host\share".into(),
            },
            DriveMapping {
                local_name: "Z:".into(),
                remote_unc: r"\\host\share".into(),
            },
        ];
        let mapped = match_unc_to_mapped_local(r"\\host\share\sub", &maps).unwrap();
        assert_eq!(slash(&mapped.root), "Z:");
        assert_eq!(slash(&mapped.full), r"Z:\sub");
    }

    #[test]
    fn longer_deviceless_prefix_beats_shorter_drive() {
        let maps = [
            DriveMapping {
                local_name: "Z:".into(),
                remote_unc: r"\\host\share".into(),
            },
            DriveMapping {
                local_name: r"\\host\share\sub".into(),
                remote_unc: r"\\host\share\sub".into(),
            },
        ];
        let p = match_unc_to_mapped_path(r"\\host\share\sub\file", &maps).unwrap();
        assert_eq!(slash(&p), r"\\host\share\sub\file");
    }

    #[test]
    fn deviceless_enum_row_uses_unc_local_name() {
        assert!(deviceless_mapping(None, r"\\host").is_none());
        assert!(deviceless_mapping(Some("Z:"), r"\\host\share").is_none());
        assert!(deviceless_mapping(Some(r"Z:\"), r"\\host\share").is_none());
        let mapped = deviceless_mapping(None, r"\\NAS\Aktuell").unwrap();
        assert_eq!(mapped.local_name, r"\\NAS\Aktuell");
        assert_eq!(mapped.remote_unc, r"\\nas\aktuell");
        let empty_local = deviceless_mapping(Some("  "), r"\\nas\aktuell").unwrap();
        assert_eq!(empty_local.local_name, r"\\nas\aktuell");
        let explicit = deviceless_mapping(Some(r"\\NAS\Aktuell\"), r"\\nas\aktuell").unwrap();
        assert_eq!(explicit.local_name, r"\\NAS\Aktuell");
    }

    #[test]
    fn bare_unc_host_is_not_a_local_root() {
        let maps = [DriveMapping {
            local_name: r"\\host".into(),
            remote_unc: r"\\host\share".into(),
        }];
        assert!(match_unc_to_mapped_path(r"\\host\share", &maps).is_none());
    }
}
