//! OPT-18: Resolve macOS/Linux OS SMB mounts to a local path.
//!
//! When config is `smb://host/share[/sub]` and Finder / gvfs / CIFS already
//! mounts the same UNC, prefer `ServerTarget::Local` (no second `smb2` session).
//!
//! No automatic mounting. Parse helpers are always compiled (fixture unit tests
//! on every CI host); live enumeration runs only on macOS/Linux.

// On Windows this module is compile-tested only (OPT-17 owns live maps).
#![cfg_attr(
    not(any(target_os = "macos", target_os = "linux")),
    allow(dead_code)
)]

#[cfg(any(test, target_os = "linux", target_os = "macos"))]
use std::path::PathBuf;

use percent_encoding::percent_decode_str;

use super::windows_mapping::{canonicalize_unc, DriveMapping};

/// Enumerate live OS SMB mounts. Empty on Windows and on unsupported Unix.
pub fn list_os_smb_mounts() -> Vec<DriveMapping> {
    #[cfg(target_os = "macos")]
    {
        list_macos_smb_mounts()
    }
    #[cfg(target_os = "linux")]
    {
        list_linux_smb_mounts()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Vec::new()
    }
}

/// Parse `//host/share[/sub…]`, `smb://…`, or `\\host\share` into a canonical UNC.
/// Strips `user@` / `domain;user@` from the host component. Returns `None` if
/// host or share is missing (share-name-only sources are not matched).
pub fn unc_from_mount_source(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }

    let without_scheme = if trimmed.to_ascii_lowercase().starts_with("smb://") {
        trimmed.get(6..).unwrap_or("").trim()
    } else {
        trimmed
    };

    let body = without_scheme
        .trim_start_matches(['/', '\\'])
        .replace('\\', "/");
    if body.is_empty() {
        return None;
    }

    let mut parts = body.split('/').filter(|p| !p.is_empty());
    let host_part = parts.next()?;
    let share = parts.next()?;
    let mut segments = vec![share.to_string()];
    for p in parts {
        segments.push(p.to_string());
    }

    let host = strip_auth_from_host(host_part);
    if host.is_empty() || segments.iter().any(|s| s.is_empty()) {
        return None;
    }

    let mut unc = format!(r"\\{host}");
    for seg in segments {
        unc.push('\\');
        unc.push_str(&seg);
    }
    Some(canonicalize_unc(&unc))
}

/// Parse gvfs directory basename `smb-share:server=…,share=…[,…]`.
pub fn unc_from_gvfs_smb_share_name(name: &str) -> Option<String> {
    let name = name.trim();
    // Accept `smb-share:server=…` and bare `server=…,share=…`.
    let kv_src = if let Some(rest) = name.strip_prefix("smb-share:") {
        rest
    } else if name.contains("server=") && name.contains("share=") {
        name
    } else {
        return None;
    };

    let mut server: Option<String> = None;
    let mut share: Option<String> = None;
    for part in kv_src.split(',') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            let key = k.trim().to_ascii_lowercase();
            let val = decode_gvfs_value(v.trim());
            if val.is_empty() {
                continue;
            }
            match key.as_str() {
                "server" => server = Some(val),
                "share" => share = Some(val),
                _ => {}
            }
        }
    }
    let host = server?;
    let share = share?;
    Some(canonicalize_unc(&format!(r"\\{host}\{share}")))
}

/// Parse one `/proc/mounts` line for `cifs` / `smb3`. Returns mapping when
/// source yields host+share.
pub fn mapping_from_proc_mounts_line(line: &str) -> Option<DriveMapping> {
    let fields = split_proc_mounts_fields(line);
    if fields.len() < 3 {
        return None;
    }
    let fstype = fields[2].to_ascii_lowercase();
    if fstype != "cifs" && fstype != "smb3" && fstype != "smb" {
        return None;
    }
    let source = unescape_proc_mounts(&fields[0]);
    let target = unescape_proc_mounts(&fields[1]);
    if target.is_empty() {
        return None;
    }
    let unc = unc_from_mount_source(&source).or_else(|| {
        // Fallback: options may carry server=/share=
        fields
            .get(3)
            .and_then(|opts| unc_from_mount_options(opts))
    })?;
    Some(DriveMapping {
        local_name: target,
        remote_unc: unc,
    })
}

/// `server=host,share=name` (and similar) from mount option strings.
/// Prefers `server=` over `addr=` when both are present (string match, no DNS).
pub fn unc_from_mount_options(options: &str) -> Option<String> {
    let mut server: Option<String> = None;
    let mut addr: Option<String> = None;
    let mut share: Option<String> = None;
    for part in options.split(',') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim();
            if val.is_empty() {
                continue;
            }
            match key.as_str() {
                "server" => server = Some(val.to_string()),
                "addr" => addr = Some(val.to_string()),
                "share" => share = Some(val.to_string()),
                _ => {}
            }
        }
    }
    let host = server.or(addr)?;
    let share = share?;
    Some(canonicalize_unc(&format!(r"\\{host}\{share}")))
}

fn strip_auth_from_host(host_part: &str) -> String {
    // domain;user@host  or  user@host  or  domain;host (rare)
    let after_semicolon = host_part
        .rsplit_once(';')
        .map(|(_, rest)| rest)
        .unwrap_or(host_part);
    let host = after_semicolon
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(after_semicolon);
    host.trim().trim_matches(|c| c == '/' || c == '\\').to_string()
}

fn decode_gvfs_value(raw: &str) -> String {
    percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

/// Split `/proc/mounts` fields; octal escapes stay inside field tokens.
fn split_proc_mounts_fields(line: &str) -> Vec<String> {
    line.split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

fn unescape_proc_mounts(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            let b1 = bytes[i + 1];
            let b2 = bytes[i + 2];
            let b3 = bytes[i + 3];
            if b1.is_ascii_digit() && b2.is_ascii_digit() && b3.is_ascii_digit() {
                let code =
                    ((b1 - b'0') as u32) * 64 + ((b2 - b'0') as u32) * 8 + ((b3 - b'0') as u32);
                if let Some(ch) = char::from_u32(code) {
                    out.push(ch);
                    i += 4;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn push_unique(out: &mut Vec<DriveMapping>, mapping: DriveMapping) {
    if out.iter().any(|m| {
        m.local_name == mapping.local_name && m.remote_unc == mapping.remote_unc
    }) {
        return;
    }
    out.push(mapping);
}

#[cfg(target_os = "linux")]
fn list_linux_smb_mounts() -> Vec<DriveMapping> {
    let mut out = Vec::new();

    if let Ok(text) = std::fs::read_to_string("/proc/mounts") {
        for line in text.lines() {
            if let Some(m) = mapping_from_proc_mounts_line(line) {
                push_unique(&mut out, m);
            }
        }
    }

    if let Some(gvfs_root) = gvfs_root_dir() {
        if let Ok(entries) = std::fs::read_dir(&gvfs_root) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let Some(unc) = unc_from_gvfs_smb_share_name(&name) else {
                    continue;
                };
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                push_unique(
                    &mut out,
                    DriveMapping {
                        local_name: path.to_string_lossy().into_owned(),
                        remote_unc: unc,
                    },
                );
            }
        }
    }

    out
}

#[cfg(target_os = "linux")]
fn gvfs_root_dir() -> Option<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        let p = PathBuf::from(xdg).join("gvfs");
        if p.is_dir() {
            return Some(p);
        }
    }
    let uid = unsafe { libc::getuid() };
    let p = PathBuf::from(format!("/run/user/{uid}/gvfs"));
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn list_macos_smb_mounts() -> Vec<DriveMapping> {
    use std::ffi::CStr;
    use std::mem::MaybeUninit;

    let mut out = Vec::new();
    unsafe {
        let flags = libc::MNT_NOWAIT;
        let count = libc::getfsstat(std::ptr::null_mut(), 0, flags);
        if count <= 0 {
            return out;
        }
        // Extra slots in case mounts appear between calls.
        let capacity = (count as usize).saturating_add(8);
        let mut buf: Vec<MaybeUninit<libc::statfs>> = Vec::with_capacity(capacity);
        buf.set_len(capacity);
        let byte_size = (capacity * std::mem::size_of::<libc::statfs>()) as libc::c_int;
        let got = libc::getfsstat(buf.as_mut_ptr() as *mut libc::statfs, byte_size, flags);
        if got <= 0 {
            return out;
        }
        for i in 0..got as usize {
            let st = *buf[i].as_ptr();
            let fstype = CStr::from_ptr(st.f_fstypename.as_ptr())
                .to_string_lossy()
                .to_ascii_lowercase();
            if fstype != "smbfs" && fstype != "cifs" && fstype != "smb" {
                continue;
            }
            let mnton = CStr::from_ptr(st.f_mntonname.as_ptr())
                .to_string_lossy()
                .into_owned();
            let mntfrom = CStr::from_ptr(st.f_mntfromname.as_ptr())
                .to_string_lossy()
                .into_owned();
            if mnton.is_empty() {
                continue;
            }
            let Some(unc) = unc_from_mount_source(&mntfrom) else {
                // Share-name-only (no host in mntfrom): skip — cannot match config host.
                continue;
            };
            push_unique(
                &mut out,
                DriveMapping {
                    local_name: mnton,
                    remote_unc: unc,
                },
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smb::windows_mapping::match_unc_to_mapped_path;

    #[test]
    fn parse_unc_style_with_user() {
        assert_eq!(
            unc_from_mount_source("//alice@nas.local/aktuell"),
            Some(r"\\nas.local\aktuell".into())
        );
        assert_eq!(
            unc_from_mount_source(r"\\CORP;bob@host\videos\jobs"),
            Some(r"\\host\videos\jobs".into())
        );
    }

    #[test]
    fn parse_smb_url_source() {
        assert_eq!(
            unc_from_mount_source("smb://169.254.169.254/aktuell"),
            Some(r"\\169.254.169.254\aktuell".into())
        );
    }

    #[test]
    fn parse_rejects_share_only() {
        assert!(unc_from_mount_source("aktuell").is_none());
        assert!(unc_from_mount_source("//aktuell").is_none());
    }

    #[test]
    fn gvfs_name_basic() {
        assert_eq!(
            unc_from_gvfs_smb_share_name("smb-share:server=nas,share=aktuell"),
            Some(r"\\nas\aktuell".into())
        );
    }

    #[test]
    fn gvfs_name_with_user_and_encoding() {
        assert_eq!(
            unc_from_gvfs_smb_share_name(
                "smb-share:server=my%2dhost,share=my%20share,user=alice"
            ),
            Some(r"\\my-host\my share".into())
        );
    }

    #[test]
    fn proc_mounts_cifs_line() {
        let line = "//nas/aktuell /mnt/aktuell cifs rw,relatime,vers=3.0,username=a 0 0";
        let m = mapping_from_proc_mounts_line(line).unwrap();
        assert_eq!(m.local_name, "/mnt/aktuell");
        assert_eq!(m.remote_unc, r"\\nas\aktuell");
    }

    #[test]
    fn proc_mounts_escaped_space() {
        let line = r"//nas/my\040share /media/share cifs rw 0 0";
        let m = mapping_from_proc_mounts_line(line).unwrap();
        assert_eq!(m.remote_unc, r"\\nas\my share");
        assert_eq!(m.local_name, "/media/share");
    }

    #[test]
    fn proc_mounts_ignores_ext4() {
        let line = "/dev/sda1 / ext4 rw,relatime 0 0";
        assert!(mapping_from_proc_mounts_line(line).is_none());
    }

    #[test]
    fn match_unix_mount_subpath() {
        let maps = [DriveMapping {
            local_name: "/Volumes/aktuell".into(),
            remote_unc: r"\\169.254.169.254\aktuell".into(),
        }];
        let p = match_unc_to_mapped_path(r"\\169.254.169.254\aktuell\jobs\a", &maps).unwrap();
        assert_eq!(
            p,
            PathBuf::from("/Volumes/aktuell").join("jobs").join("a")
        );
    }

    #[test]
    fn match_gvfs_style_root() {
        let maps = [DriveMapping {
            local_name: "/run/user/1000/gvfs/smb-share:server=nas,share=aktuell".into(),
            remote_unc: r"\\nas\aktuell".into(),
        }];
        let p = match_unc_to_mapped_path(r"\\nas\aktuell", &maps).unwrap();
        assert_eq!(
            p,
            PathBuf::from("/run/user/1000/gvfs/smb-share:server=nas,share=aktuell")
        );
    }

    #[test]
    fn options_server_share() {
        assert_eq!(
            unc_from_mount_options("rw,server=nas.local,share=videos,vers=3.0"),
            Some(r"\\nas.local\videos".into())
        );
    }
}
