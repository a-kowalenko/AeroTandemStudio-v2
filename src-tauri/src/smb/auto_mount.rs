//! OPT-19: App-owned OS SMB auto-mount (Windows map / macOS smbfs / Linux gvfs).
//!
//! When config is `smb://…` and no OPT-17/18 match exists, optionally create a
//! temporary OS mount so Health/Upload can use `ServerTarget::Local`.
//! Failures fall back to smb2. Quit unmounts **only** mounts tracked in the
//! App-owned registry — never Finder/`net use`/user mounts.

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};

use super::windows_mapping::{
    canonicalize_unc, resolve_mapped_local_path, unc_from_smb_parts,
};

const REGISTRY_FILE: &str = "smb_app_mounts.json";
const FAILURE_BACKOFF: Duration = Duration::from_secs(60);
const MOUNT_SETTLE_POLL: Duration = Duration::from_millis(200);
const MOUNT_SETTLE_MAX: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy)]
pub struct AutoMountParams<'a> {
    pub enabled: bool,
    pub login: &'a str,
    pub password: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OwnedMountEntry {
    pub unc: String,
    pub local_path: String,
    pub created_at: String,
    pub platform: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct OwnedMountRegistry {
    #[serde(default)]
    mounts: Vec<OwnedMountEntry>,
}

#[derive(Debug, Clone)]
struct AttemptState {
    /// Last successful mount for this share-root UNC (this process).
    succeeded: bool,
    last_failure: Option<Instant>,
}

static ATTEMPTS: Lazy<Mutex<std::collections::HashMap<String, AttemptState>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

/// Ensure an OS mount exists for the SMB share root when enabled and needed.
///
/// Returns `Ok(Some(local))` when a reachable mapping exists after ensure,
/// `Ok(None)` when auto-mount is off / skipped / failed (caller keeps smb2),
/// never hard-blocks the transfer path.
pub fn ensure_os_smb_mount(
    host: &str,
    share: &str,
    subpath: &str,
    params: AutoMountParams<'_>,
) -> Result<Option<PathBuf>, String> {
    if !params.enabled {
        return Ok(None);
    }

    let host = host.trim();
    let share = share.trim();
    if host.is_empty() || share.is_empty() {
        return Ok(None);
    }

    let config_unc = unc_from_smb_parts(host, share, subpath);
    if let Some(existing) = resolve_mapped_local_path(&config_unc) {
        return Ok(Some(existing));
    }

    let share_unc = unc_from_smb_parts(host, share, "");
    if should_skip_after_failure(&share_unc) {
        return Ok(None);
    }

    // Idempotent: share-root already mapped (subpath join failed above only if dead).
    if let Some(existing) = resolve_mapped_local_path(&share_unc) {
        if let Some(full) = resolve_mapped_local_path(&config_unc) {
            return Ok(Some(full));
        }
        return Ok(Some(join_subpath(&existing, subpath)));
    }

    match mount_share_root(host, share, &share_unc, params.login, params.password) {
        Ok(local_root) => {
            mark_attempt_ok(&share_unc);
            register_owned(&share_unc, &local_root);
            crate::storage::logging::info(
                "smb",
                format!(
                    "SMB auto-mounted {} ({})",
                    display_local(&local_root),
                    share_unc
                ),
            );
            if let Some(full) = resolve_mapped_local_path(&config_unc) {
                return Ok(Some(full));
            }
            let full = join_subpath(&local_root, subpath);
            if full.exists() || local_root.exists() {
                Ok(Some(full))
            } else {
                Ok(Some(local_root))
            }
        }
        Err(e) => {
            mark_attempt_failed(&share_unc);
            crate::storage::logging::warn(
                "smb",
                format!("SMB auto-mount failed ({share_unc}): {e}; using smb2"),
            );
            Ok(None)
        }
    }
}

/// Drop unreachable App-owned registry rows (crash leftovers). Does not unmount.
pub fn startup_sweep_owned_registry() {
    let mut reg = load_registry();
    let before = reg.mounts.len();
    reg.mounts.retain(|m| {
        let p = PathBuf::from(&m.local_path);
        let ok = path_reachable(&p);
        if !ok {
            crate::storage::logging::info(
                "smb",
                format!(
                    "SMB auto-mount registry: dropping stale {} ({})",
                    m.local_path, m.unc
                ),
            );
        }
        ok
    });
    if reg.mounts.len() != before {
        let _ = save_registry(&reg);
    }
}

/// Quit cleanup: unmount **only** App-owned mounts, then clear the registry.
pub fn unmount_all_owned() {
    let mut reg = load_registry();
    if reg.mounts.is_empty() {
        return;
    }
    let entries = std::mem::take(&mut reg.mounts);
    let _ = save_registry(&reg);

    for entry in entries {
        match unmount_owned_entry(&entry) {
            Ok(()) => crate::storage::logging::info(
                "smb",
                format!(
                    "SMB auto-mount released {} ({})",
                    entry.local_path, entry.unc
                ),
            ),
            Err(e) => crate::storage::logging::warn(
                "smb",
                format!(
                    "SMB auto-mount release failed {} ({}): {e}",
                    entry.local_path, entry.unc
                ),
            ),
        }
    }
}

fn mount_share_root(
    host: &str,
    share: &str,
    share_unc: &str,
    login: &str,
    password: &str,
) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let _ = (host, share);
        mount_windows(share_unc, login, password)
    }
    #[cfg(target_os = "macos")]
    {
        mount_macos(host, share, login, password)
    }
    #[cfg(target_os = "linux")]
    {
        mount_linux_gvfs(host, share, login, password)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (host, share, share_unc, login, password);
        Err("SMB auto-mount unsupported on this platform".into())
    }
}

#[cfg(windows)]
fn mount_windows(share_unc: &str, login: &str, password: &str) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::NO_ERROR;
    use windows::Win32::NetworkManagement::WNet::{
        WNetAddConnection2W, CONNECT_TEMPORARY, NETRESOURCEW, RESOURCETYPE_DISK,
    };

    let letter = find_free_drive_letter().ok_or_else(|| {
        "Kein freier Laufwerksbuchstabe für SMB auto-mount".to_string()
    })?;
    let local = format!("{letter}:");
    let remote = share_unc.replace('/', r"\");
    // Ensure \\server\share form for WNet.
    let remote = if remote.starts_with(r"\\") {
        remote
    } else {
        format!(r"\\{remote}")
    };

    let local_wide: Vec<u16> = std::ffi::OsStr::new(&local)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let remote_wide: Vec<u16> = std::ffi::OsStr::new(&remote)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let (user, pass, domain) = split_creds(login, password);
    let user_for_api = if domain.is_empty() {
        user.clone()
    } else {
        format!("{domain}\\{user}")
    };
    let user_wide: Option<Vec<u16>> = if user_for_api.is_empty() {
        None
    } else {
        Some(
            std::ffi::OsStr::new(&user_for_api)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect(),
        )
    };
    let pass_wide: Option<Vec<u16>> = if pass.is_empty() && user_for_api.is_empty() {
        None
    } else {
        Some(
            std::ffi::OsStr::new(&pass)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect(),
        )
    };

    let mut resource = NETRESOURCEW {
        dwType: RESOURCETYPE_DISK,
        lpLocalName: PWSTR(local_wide.as_ptr() as *mut u16),
        lpRemoteName: PWSTR(remote_wide.as_ptr() as *mut u16),
        ..Default::default()
    };

    let status = unsafe {
        WNetAddConnection2W(
            &mut resource,
            pass_wide
                .as_ref()
                .map(|v| PCWSTR(v.as_ptr()))
                .unwrap_or(PCWSTR::null()),
            user_wide
                .as_ref()
                .map(|v| PCWSTR(v.as_ptr()))
                .unwrap_or(PCWSTR::null()),
            CONNECT_TEMPORARY,
        )
    };

    if status != NO_ERROR {
        return Err(format!(
            "WNetAddConnection2W failed: Win32 {status:?} ({remote} → {local})"
        ));
    }

    let root = PathBuf::from(format!(r"{local}\"));
    wait_until_reachable(&root)?;
    Ok(PathBuf::from(local))
}

#[cfg(windows)]
fn find_free_drive_letter() -> Option<char> {
    use std::os::windows::ffi::OsStringExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::NetworkManagement::WNet::WNetGetConnectionW;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;

    // DRIVE_NO_ROOT_DIR = 1 (path does not exist as a root).
    const DRIVE_NO_ROOT_DIR: u32 = 1;

    for letter in (b'D'..=b'Z').rev() {
        let root = format!("{}:\\", letter as char);
        let root_wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let dtype = unsafe { GetDriveTypeW(PCWSTR(root_wide.as_ptr())) };
        if dtype != DRIVE_NO_ROOT_DIR {
            continue;
        }
        // Double-check no lingering WNet mapping without a live volume.
        let local = format!("{}:", letter as char);
        let local_wide: Vec<u16> = local.encode_utf16().chain(std::iter::once(0)).collect();
        let mut needed: u32 = 0;
        let status = unsafe {
            WNetGetConnectionW(PCWSTR(local_wide.as_ptr()), None, &mut needed)
        };
        if status == ERROR_MORE_DATA || status == ERROR_SUCCESS {
            let mut buf = vec![0u16; needed.max(1) as usize];
            let mut len = needed.max(1);
            let status2 = unsafe {
                WNetGetConnectionW(
                    PCWSTR(local_wide.as_ptr()),
                    Some(PWSTR(buf.as_mut_ptr())),
                    &mut len,
                )
            };
            if status2 == ERROR_SUCCESS {
                let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                let remote = std::ffi::OsString::from_wide(&buf[..end]);
                if !remote.is_empty() {
                    continue;
                }
            }
        }
        return Some(letter as char);
    }
    None
}

#[cfg(target_os = "macos")]
fn mount_macos(host: &str, share: &str, login: &str, password: &str) -> Result<PathBuf, String> {
    let (user, pass, domain) = split_creds(login, password);
    let auth = format_smb_auth(&user, &pass, &domain);
    let remote = format!("//{auth}{host}/{share}");
    let mount_point = unique_volumes_path(share);

    // Create mount point if missing (mount_smbfs requires it).
    if !mount_point.exists() {
        fs::create_dir_all(&mount_point).map_err(|e| {
            format!("mount point {}: {e}", mount_point.display())
        })?;
    }

    let output = Command::new("mount_smbfs")
        .arg("-N")
        .arg(&remote)
        .arg(&mount_point)
        .output()
        .map_err(|e| format!("mount_smbfs not available: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Clean empty dir we created if mount failed.
        let _ = fs::remove_dir(&mount_point);
        return Err(format!(
            "mount_smbfs failed: {} {}",
            stderr.trim(),
            stdout.trim()
        ));
    }

    wait_until_reachable(&mount_point)?;
    Ok(mount_point)
}

#[cfg(target_os = "macos")]
fn unique_volumes_path(share: &str) -> PathBuf {
    let safe = sanitize_mount_name(share);
    let base = PathBuf::from("/Volumes").join(&safe);
    if !base.exists() {
        return base;
    }
    for i in 1..50 {
        let candidate = PathBuf::from("/Volumes").join(format!("{safe}-{i}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("/Volumes").join(format!(
        "{safe}-ats-{}",
        now_unix_secs()
    ))
}

#[cfg(target_os = "linux")]
fn mount_linux_gvfs(host: &str, share: &str, login: &str, password: &str) -> Result<PathBuf, String> {
    let (user, pass, domain) = split_creds(login, password);
    let smb_url = format_gio_smb_url(host, share, &user, &pass, &domain);

    let mut cmd = Command::new("gio");
    cmd.args(["mount", &smb_url]);
    // Non-interactive: feed password if gio asks (best-effort).
    let output = if !pass.is_empty() {
        use std::io::Write;
        use std::process::Stdio;
        let mut child = Command::new("gio")
            .args(["mount", &smb_url])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("gvfs unavailable (gio mount): {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = writeln!(stdin, "{pass}");
            let _ = writeln!(stdin, "y");
        }
        child
            .wait_with_output()
            .map_err(|e| format!("gio mount failed: {e}"))?
    } else {
        cmd.output()
            .map_err(|e| format!("gvfs unavailable (gio mount): {e}"))?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Already mounted often returns non-zero with a clear message — try locate.
        if !stderr.to_ascii_lowercase().contains("already") {
            return Err(format!("gio mount failed: {}", stderr.trim()));
        }
    }

    let path = find_gvfs_mount_path(host, share).ok_or_else(|| {
        "gio mount reported ok but gvfs path not found".to_string()
    })?;
    wait_until_reachable(&path)?;
    Ok(path)
}

#[cfg(target_os = "linux")]
fn find_gvfs_mount_path(host: &str, share: &str) -> Option<PathBuf> {
    let want = canonicalize_unc(&format!(r"\\{host}\{share}"));
    for m in super::unix_mapping::list_os_smb_mounts() {
        if canonicalize_unc(&m.remote_unc) == want {
            return Some(PathBuf::from(m.local_name));
        }
    }
    None
}

fn unmount_owned_entry(entry: &OwnedMountEntry) -> Result<(), String> {
    #[cfg(windows)]
    {
        unmount_windows(&entry.local_path)
    }
    #[cfg(target_os = "macos")]
    {
        unmount_macos(&entry.local_path)
    }
    #[cfg(target_os = "linux")]
    {
        unmount_linux_gvfs(&entry.local_path, &entry.unc)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = entry;
        Ok(())
    }
}

#[cfg(windows)]
fn unmount_windows(local_path: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::NO_ERROR;
    use windows::Win32::NetworkManagement::WNet::{
        WNetCancelConnection2W, NET_CONNECT_FLAGS,
    };

    let letter = normalize_drive_letter(local_path)
        .ok_or_else(|| format!("invalid drive mapping local_path: {local_path}"))?;
    let wide: Vec<u16> = std::ffi::OsStr::new(&letter)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let status = unsafe {
        WNetCancelConnection2W(PCWSTR(wide.as_ptr()), NET_CONNECT_FLAGS(0), true)
    };
    if status != NO_ERROR {
        return Err(format!("WNetCancelConnection2W failed: Win32 {status:?}"));
    }
    Ok(())
}

#[cfg(windows)]
fn normalize_drive_letter(local_path: &str) -> Option<String> {
    let t = local_path.trim().trim_end_matches(['\\', '/']);
    if t.ends_with(':') && t.len() == 2 {
        return Some(t.to_string());
    }
    if t.len() == 1 && t.chars().next()?.is_ascii_alphabetic() {
        return Some(format!("{t}:"));
    }
    // Z:\ or Z:\sub → Z:
    let bytes = t.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Some(format!("{}:", bytes[0] as char));
    }
    None
}

#[cfg(target_os = "macos")]
fn unmount_macos(local_path: &str) -> Result<(), String> {
    let output = Command::new("diskutil")
        .args(["unmount", local_path])
        .output()
        .or_else(|_| {
            Command::new("umount")
                .arg(local_path)
                .output()
        })
        .map_err(|e| format!("unmount failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "linux")]
fn unmount_linux_gvfs(local_path: &str, unc: &str) -> Result<(), String> {
    // Prefer gio mount -u on the gvfs URI derived from UNC.
    if let Some(uri) = gio_uri_from_unc(unc) {
        let output = Command::new("gio")
            .args(["mount", "-u", &uri])
            .output()
            .map_err(|e| format!("gio unmount: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
    }
    let output = Command::new("gio")
        .args(["mount", "-u", local_path])
        .output()
        .map_err(|e| format!("gio unmount path: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "linux")]
fn gio_uri_from_unc(unc: &str) -> Option<String> {
    let c = canonicalize_unc(unc);
    let body = c.trim_start_matches('\\');
    let mut parts = body.split('\\').filter(|p| !p.is_empty());
    let host = parts.next()?;
    let share = parts.next()?;
    Some(format!("smb://{host}/{share}"))
}

fn split_creds(login: &str, password: &str) -> (String, String, String) {
    let login = login.trim();
    let password = password.to_string();
    if login.is_empty() {
        return ("Guest".into(), password, String::new());
    }
    if let Some((domain, user)) = login.split_once('\\') {
        return (user.to_string(), password, domain.to_string());
    }
    if let Some((user, domain)) = login.split_once('@') {
        return (user.to_string(), password, domain.to_string());
    }
    (login.to_string(), password, String::new())
}

fn format_smb_auth(user: &str, pass: &str, domain: &str) -> String {
    if user.is_empty() || user.eq_ignore_ascii_case("Guest") && pass.is_empty() {
        return String::new();
    }
    let u = utf8_percent_encode(user, NON_ALPHANUMERIC).to_string();
    let p = utf8_percent_encode(pass, NON_ALPHANUMERIC).to_string();
    if domain.is_empty() {
        format!("{u}:{p}@")
    } else {
        let d = utf8_percent_encode(domain, NON_ALPHANUMERIC).to_string();
        format!("{d};{u}:{p}@")
    }
}

#[cfg(target_os = "linux")]
fn format_gio_smb_url(
    host: &str,
    share: &str,
    user: &str,
    pass: &str,
    domain: &str,
) -> String {
    let h = utf8_percent_encode(host, NON_ALPHANUMERIC).to_string();
    let s = utf8_percent_encode(share, NON_ALPHANUMERIC).to_string();
    if user.is_empty() || (user.eq_ignore_ascii_case("Guest") && pass.is_empty()) {
        return format!("smb://{h}/{s}");
    }
    let u = utf8_percent_encode(user, NON_ALPHANUMERIC).to_string();
    let p = utf8_percent_encode(pass, NON_ALPHANUMERIC).to_string();
    if domain.is_empty() {
        format!("smb://{u}:{p}@{h}/{s}")
    } else {
        let d = utf8_percent_encode(domain, NON_ALPHANUMERIC).to_string();
        format!("smb://{d};{u}:{p}@{h}/{s}")
    }
}

fn sanitize_mount_name(share: &str) -> String {
    let s: String = share
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "ats-smb".into()
    } else {
        s
    }
}

fn join_subpath(root: &Path, subpath: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in subpath.split(['/', '\\']).filter(|s| !s.is_empty()) {
        p.push(part);
    }
    p
}

fn display_local(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string()
}

fn path_reachable(path: &Path) -> bool {
    path.exists()
}

fn wait_until_reachable(path: &Path) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < MOUNT_SETTLE_MAX {
        if path_reachable(path) {
            return Ok(());
        }
        std::thread::sleep(MOUNT_SETTLE_POLL);
    }
    if path_reachable(path) {
        Ok(())
    } else {
        Err(format!(
            "mount path not reachable within {:?}: {}",
            MOUNT_SETTLE_MAX,
            path.display()
        ))
    }
}

fn should_skip_after_failure(share_unc: &str) -> bool {
    let key = canonicalize_unc(share_unc);
    let Ok(map) = ATTEMPTS.lock() else {
        return false;
    };
    match map.get(&key) {
        Some(s) if s.succeeded => false,
        Some(s) => s
            .last_failure
            .is_some_and(|t| t.elapsed() < FAILURE_BACKOFF),
        None => false,
    }
}

fn mark_attempt_ok(share_unc: &str) {
    let key = canonicalize_unc(share_unc);
    if let Ok(mut map) = ATTEMPTS.lock() {
        map.insert(
            key,
            AttemptState {
                succeeded: true,
                last_failure: None,
            },
        );
    }
}

fn mark_attempt_failed(share_unc: &str) {
    let key = canonicalize_unc(share_unc);
    if let Ok(mut map) = ATTEMPTS.lock() {
        map.insert(
            key,
            AttemptState {
                succeeded: false,
                last_failure: Some(Instant::now()),
            },
        );
    }
}

fn registry_path() -> Result<PathBuf, String> {
    let dir = crate::storage::app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(REGISTRY_FILE))
}

fn load_registry() -> OwnedMountRegistry {
    let Ok(path) = registry_path() else {
        return OwnedMountRegistry::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return OwnedMountRegistry::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_registry(reg: &OwnedMountRegistry) -> Result<(), String> {
    let path = registry_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(reg).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

fn register_owned(share_unc: &str, local_root: &Path) {
    let unc = canonicalize_unc(share_unc);
    let local = display_local(local_root);
    let mut reg = load_registry();
    if reg
        .mounts
        .iter()
        .any(|m| canonicalize_unc(&m.unc) == unc && m.local_path == local)
    {
        return;
    }
    // Replace prior owned entry for same UNC (letter/path change).
    reg.mounts.retain(|m| canonicalize_unc(&m.unc) != unc);
    reg.mounts.push(OwnedMountEntry {
        unc,
        local_path: local,
        created_at: now_rfc3339(),
        platform: current_platform().into(),
    });
    let _ = save_registry(&reg);
}

fn current_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_rfc3339() -> String {
    // Keep dependency-free; chrono is available but this is enough for registry.
    let secs = now_unix_secs();
    format!("{secs}")
}

/// Test helpers / pure logic.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_returns_none_without_mount() {
        let r = ensure_os_smb_mount(
            "opt19-no-host.invalid",
            "share",
            "",
            AutoMountParams {
                enabled: false,
                login: "",
                password: "",
            },
        )
        .unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn empty_host_skipped() {
        let r = ensure_os_smb_mount(
            "",
            "share",
            "",
            AutoMountParams {
                enabled: true,
                login: "u",
                password: "p",
            },
        )
        .unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn join_subpath_appends() {
        let p = join_subpath(Path::new("/Volumes/aktuell"), "jobs/a");
        assert_eq!(p, PathBuf::from("/Volumes/aktuell/jobs/a"));
    }

    #[test]
    fn sanitize_mount_name_strips() {
        assert_eq!(sanitize_mount_name("my share"), "my_share");
        assert_eq!(sanitize_mount_name(""), "ats-smb");
    }

    #[test]
    fn format_auth_encodes() {
        let a = format_smb_auth("alice", "p@ss", "");
        assert!(a.contains("alice"));
        assert!(a.contains('@'));
        assert!(a.ends_with('@'));
    }

    #[test]
    fn owned_registry_roundtrip_in_memory() {
        let entry = OwnedMountEntry {
            unc: r"\\host\share".into(),
            local_path: "Z:".into(),
            created_at: "1".into(),
            platform: "windows".into(),
        };
        let reg = OwnedMountRegistry {
            mounts: vec![entry.clone()],
        };
        let text = serde_json::to_string(&reg).unwrap();
        let back: OwnedMountRegistry = serde_json::from_str(&text).unwrap();
        assert_eq!(back.mounts, vec![entry]);
    }

    #[test]
    fn backoff_skips_recent_failure() {
        let unc = r"\\opt19-backoff-test.invalid\share";
        mark_attempt_failed(unc);
        assert!(should_skip_after_failure(unc));
        // Fresh UNC not failed.
        assert!(!should_skip_after_failure(r"\\other-opt19.invalid\x"));
    }

    #[test]
    fn split_creds_domain_backslash() {
        let (u, p, d) = split_creds(r"CORP\alice", "secret");
        assert_eq!(u, "alice");
        assert_eq!(p, "secret");
        assert_eq!(d, "CORP");
    }

    #[cfg(windows)]
    #[test]
    fn normalize_drive_letter_variants() {
        assert_eq!(normalize_drive_letter("Z:").as_deref(), Some("Z:"));
        assert_eq!(normalize_drive_letter(r"Z:\").as_deref(), Some("Z:"));
        assert_eq!(normalize_drive_letter(r"Z:\sub").as_deref(), Some("Z:"));
    }
}
