//! OPT-19 / OPT-20A / OPT-23D / OPT-23F: App-owned OS SMB auto-mount.
//! Windows mounts are deviceless (`WNetAddConnection2W` with `lpLocalName = NULL`).
//! macOS prefers `NetFSMountURLSync` (user and password are API parameters, never
//! argv) and mounts under `smb-mounts/`. Fallback is `mount_smbfs` **without** a
//! password in the URL (`-N` only for guest / Keychain). Linux `gio mount` gets a
//! credential-free URL; User, Domain, and Password are written to stdin only.
//!
//! When config is `smb://…` and no OPT-17/18 match exists, optionally create a
//! temporary OS mount so Health/Upload can use `ServerTarget::Local`.
//! Failures fall back to smb2. Quit unmounts **only** mounts tracked in the
//! App-owned registry — never Finder/`net use`/user mounts.
//!
//! OPT-20A (macOS): mount under `{app_local_data}/smb-mounts/…` — never
//! `mkdir /Volumes/…` (Permission denied for non-root).

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};

use super::windows_mapping::{canonicalize_unc, lookup_mapped_local_path, unc_from_smb_parts};

const REGISTRY_FILE: &str = "smb_app_mounts.json";
/// Subdir under [`crate::storage::app_config_dir`] for macOS mount points (OPT-20A).
#[cfg(any(test, target_os = "macos"))]
const SMB_MOUNTS_SUBDIR: &str = "smb-mounts";
const FAILURE_BACKOFF: Duration = Duration::from_secs(60);
const MOUNT_SETTLE_POLL: Duration = Duration::from_millis(200);
const MOUNT_SETTLE_MAX: Duration = Duration::from_secs(8);
/// OPT-23F: a credential prompt must not block the worker indefinitely.
#[cfg(any(target_os = "macos", target_os = "linux"))]
const OS_MOUNT_CMD_TIMEOUT: Duration = Duration::from_secs(20);
/// Encode bytes that are not RFC 3986 unreserved. Dots stay so `nas.local` is literal.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
const SMB_ENCODE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');
/// `ERROR_SESSION_CREDENTIAL_CONFLICT` — another logon to this server is active.
#[cfg(any(windows, test))]
const WIN32_SESSION_CREDENTIAL_CONFLICT: u32 = 1219;
#[cfg(any(windows, test))]
const CREDENTIAL_CONFLICT_MESSAGE: &str = "andere Anmeldung zu diesem Server aktiv";

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
    // OPT-20B: listed map (even if asleep) — do not create a second mount.
    if let Some(existing) = lookup_mapped_local_path(&config_unc) {
        if super::reconnect::prefer_local_now(&existing) {
            return Ok(Some(existing));
        }
        return Ok(None);
    }

    let share_unc = unc_from_smb_parts(host, share, "");
    if should_skip_after_failure(&share_unc) {
        return Ok(None);
    }

    // Idempotent: share-root already mapped (subpath join failed above only if dead).
    if let Some(existing) = lookup_mapped_local_path(&share_unc) {
        if super::reconnect::prefer_local_now(&existing) {
            if let Some(full) = lookup_mapped_local_path(&config_unc) {
                if super::reconnect::prefer_local_now(&full) {
                    return Ok(Some(full));
                }
            }
            return Ok(Some(join_subpath(&existing, subpath)));
        }
        return Ok(None);
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
            if let Some(full) = lookup_mapped_local_path(&config_unc) {
                if super::reconnect::prefer_local_now(&full) {
                    return Ok(Some(full));
                }
            }
            let full = join_subpath(&local_root, subpath);
            if path_reachable(&full) || path_reachable(&local_root) {
                Ok(Some(full))
            } else {
                Ok(Some(local_root))
            }
        }
        Err(e) => {
            mark_attempt_failed(&share_unc);
            crate::storage::logging::warn(
                "smb",
                format!(
                    "SMB auto-mount failed ({share_unc}): {}; using smb2",
                    redact_for_log(&e, params.password)
                ),
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
        let ok = path_reachable_registry(&p);
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
    let remote = wnet_remote_name(share_unc);
    let first = add_deviceless_connection(&remote, Some((login, password)));
    let created_by_us = first == 0;
    if first == WIN32_SESSION_CREDENTIAL_CONFLICT {
        let retry = add_deviceless_connection(&remote, None);
        deviceless_add_outcome(first, Some(retry))?;
        crate::storage::logging::info(
            "smb",
            format!("SMB auto-mount reused existing session for {remote} (ERROR 1219)"),
        );
    } else {
        deviceless_add_outcome(first, None)?;
    }

    let root = PathBuf::from(&remote);
    if let Err(e) = wait_until_reachable(&root) {
        // Roll back a connection we just created. A 1219 retry rides an existing
        // server session — cancelling it would drop that logon.
        if created_by_us {
            let _ = unmount_windows(&remote);
        }
        return Err(e);
    }
    Ok(root)
}

#[cfg(windows)]
fn wnet_remote_name(share_unc: &str) -> String {
    let remote = share_unc.replace('/', r"\");
    if remote.starts_with(r"\\") {
        remote
    } else {
        format!(r"\\{remote}")
    }
}

/// `lpLocalName = NULL`. `creds = None` passes NULL user and password (existing session).
#[cfg(windows)]
fn add_deviceless_connection(remote: &str, creds: Option<(&str, &str)>) -> u32 {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::NetworkManagement::WNet::{
        WNetAddConnection2W, CONNECT_TEMPORARY, NETRESOURCEW, RESOURCETYPE_DISK,
    };

    let remote_wide = wide_null(remote);
    let (user_wide, pass_wide) = match creds {
        None => (None, None),
        Some((login, password)) => {
            let (user, pass, domain) = split_creds(login, password);
            let user_for_api = if domain.is_empty() {
                user
            } else {
                format!("{domain}\\{user}")
            };
            let user_wide = if user_for_api.is_empty() {
                None
            } else {
                Some(wide_null(&user_for_api))
            };
            let pass_wide = if pass.is_empty() && user_for_api.is_empty() {
                None
            } else {
                Some(wide_null(&pass))
            };
            (user_wide, pass_wide)
        }
    };

    let resource = NETRESOURCEW {
        dwType: RESOURCETYPE_DISK,
        lpLocalName: PWSTR::null(),
        lpRemoteName: PWSTR(remote_wide.as_ptr() as *mut u16),
        ..Default::default()
    };

    let status = unsafe {
        WNetAddConnection2W(
            &resource,
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
    status.0
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// First `WNetAddConnection2` status, then the NULL-credential retry when `first` is 1219.
#[cfg(any(windows, test))]
fn deviceless_add_outcome(first: u32, retry: Option<u32>) -> Result<(), String> {
    if first == 0 {
        return Ok(());
    }
    if first == WIN32_SESSION_CREDENTIAL_CONFLICT {
        return match retry {
            Some(0) => Ok(()),
            Some(code) => Err(format!(
                "{CREDENTIAL_CONFLICT_MESSAGE} (retry Win32 {code})"
            )),
            None => Err(CREDENTIAL_CONFLICT_MESSAGE.to_string()),
        };
    }
    Err(format!("WNetAddConnection2W failed: Win32 {first}"))
}

/// Legacy letter picker (OPT-19). OPT-23D mounts are deviceless (`lpLocalName = NULL`).
/// Existing app-owned letter rows still unmount by the stored `Z:` path (D7).
#[cfg(windows)]
#[allow(dead_code)]
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
        let status = unsafe { WNetGetConnectionW(PCWSTR(local_wide.as_ptr()), None, &mut needed) };
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
    let prepared = prepare_os_mount(host, share, login, password);
    let (user, pass, domain) = split_creds(login, password);

    // OPT-20A: writable user path — never mkdir under /Volumes (EACCES).
    let mounts_root = smb_mounts_root()?;
    fs::create_dir_all(&mounts_root)
        .map_err(|e| format!("smb-mounts root {}: {e}", mounts_root.display()))?;
    let mount_point = pick_user_mount_point(&mounts_root, share);
    ensure_mount_point_dir(&mount_point)?;

    match netfs::mount_url(
        &prepared.smb_url,
        &mount_point,
        &user,
        &pass,
        &domain,
        prepared.guest,
    ) {
        Ok(()) => match wait_until_reachable(&mount_point) {
            Ok(()) => return Ok(mount_point),
            Err(wait_err) => {
                crate::storage::logging::warn(
                    "smb",
                    format!(
                        "NetFS auto-mount did not become reachable ({}), falling back to mount_smbfs: {}",
                        unc_from_smb_parts(host, share, ""),
                        redact_for_log(&wait_err, password)
                    ),
                );
                let _ = unmount_macos(&mount_point.to_string_lossy());
                ensure_mount_point_dir(&mount_point)?;
            }
        },
        Err(e) => {
            crate::storage::logging::warn(
                "smb",
                format!(
                    "NetFS auto-mount failed ({}), falling back to mount_smbfs: {}",
                    unc_from_smb_parts(host, share, ""),
                    redact_for_log(&e, password)
                ),
            );
            let _ = unmount_macos(&mount_point.to_string_lossy());
            ensure_mount_point_dir(&mount_point)?;
        }
    }

    mount_macos_smbfs(&prepared, &mount_point, password)
}

#[cfg(target_os = "macos")]
fn ensure_mount_point_dir(mount_point: &Path) -> Result<(), String> {
    if !mount_point.exists() {
        fs::create_dir_all(mount_point)
            .map_err(|e| format!("mount point {}: {e}", mount_point.display()))?;
    }
    Ok(())
}

/// `mount_smbfs` without a password in argv. Guest uses `-N`. Authenticated
/// mounts rely on the Keychain; stdin is null so a prompt cannot hang forever.
#[cfg(target_os = "macos")]
fn mount_macos_smbfs(
    prepared: &PreparedOsMount,
    mount_point: &Path,
    password: &str,
) -> Result<PathBuf, String> {
    let args = mount_smbfs_args(
        &prepared.smbfs_remote,
        mount_point,
        prepared.smbfs_no_prompt,
    );
    let output = run_command_timeout(
        "mount_smbfs",
        &args,
        None,
        OS_MOUNT_CMD_TIMEOUT,
        "mount_smbfs",
        password,
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let _ = fs::remove_dir(mount_point);
        return Err(format!(
            "mount_smbfs failed: {}",
            redact_for_log(&format!("{} {}", stderr.trim(), stdout.trim()), password)
        ));
    }

    wait_until_reachable(mount_point)?;
    Ok(mount_point.to_path_buf())
}

/// `{app_local_data}/smb-mounts` — macOS auto-mount root (OPT-20A).
#[cfg(any(test, target_os = "macos"))]
fn smb_mounts_root() -> Result<PathBuf, String> {
    let dir = crate::storage::app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(SMB_MOUNTS_SUBDIR))
}

/// Choose a mount-point directory under `mounts_root` for `share`.
/// Prefers missing or empty dirs; avoids colliding with a live share tree.
#[cfg(any(test, target_os = "macos"))]
fn pick_user_mount_point(mounts_root: &Path, share: &str) -> PathBuf {
    let safe = sanitize_mount_name(share);
    let base = mounts_root.join(&safe);
    if is_reusable_mount_point(&base) {
        return base;
    }
    for i in 1..50 {
        let candidate = mounts_root.join(format!("{safe}-{i}"));
        if is_reusable_mount_point(&candidate) {
            return candidate;
        }
    }
    mounts_root.join(format!("{safe}-ats-{}", now_unix_secs()))
}

#[cfg(any(test, target_os = "macos"))]
fn is_reusable_mount_point(path: &Path) -> bool {
    if !path.exists() {
        return true;
    }
    if !path.is_dir() {
        return false;
    }
    match fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => false,
    }
}

#[cfg(target_os = "linux")]
fn mount_linux_gvfs(
    host: &str,
    share: &str,
    login: &str,
    password: &str,
) -> Result<PathBuf, String> {
    let prepared = prepare_os_mount(host, share, login, password);
    // Credential-free URL so gio asks User, then Domain, then Password.
    // Answers go to stdin only — never into argv or a temp file.
    let stdin = if prepared.guest {
        None
    } else {
        Some(prepared.gio_stdin.as_str())
    };
    let output = run_command_timeout(
        "gio",
        &prepared.gio_args,
        stdin,
        OS_MOUNT_CMD_TIMEOUT,
        "gio mount",
        password,
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Already mounted often returns non-zero with a clear message — try locate.
        if !stderr.to_ascii_lowercase().contains("already") {
            return Err(format!(
                "gio mount failed: {}",
                redact_for_log(stderr.trim(), password)
            ));
        }
    }

    let path = find_gvfs_mount_path(host, share)
        .ok_or_else(|| "gio mount reported ok but gvfs path not found".to_string())?;
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
    use windows::Win32::NetworkManagement::WNet::{WNetCancelConnection2W, NET_CONNECT_FLAGS};

    let name = connection_name_for_cancel(local_path)
        .ok_or_else(|| format!("invalid SMB mapping local_path: {local_path}"))?;
    let wide: Vec<u16> = std::ffi::OsStr::new(&name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let status =
        unsafe { WNetCancelConnection2W(PCWSTR(wide.as_ptr()), NET_CONNECT_FLAGS(0), true) };
    if status != NO_ERROR {
        return Err(format!("WNetCancelConnection2W failed: Win32 {status:?}"));
    }
    Ok(())
}

/// Drive letter (`Z:`) or deviceless UNC passed to `WNetCancelConnection2W`.
///
/// Letter rows stay valid so mounts created before OPT-23D still unmount (D7).
#[cfg(any(windows, test))]
fn connection_name_for_cancel(local_path: &str) -> Option<String> {
    if let Some(letter) = drive_letter_cancel_name(local_path) {
        return Some(letter);
    }
    let trimmed = local_path.trim();
    if !(trimmed.starts_with(r"\\") || trimmed.starts_with("//")) {
        return None;
    }
    let unc = canonicalize_unc(trimmed);
    let body = unc.trim_start_matches('\\');
    let mut parts = body.split('\\').filter(|part| !part.is_empty());
    let host = parts.next()?;
    let share = parts.next()?;
    if host.is_empty() || share.is_empty() {
        return None;
    }
    Some(unc)
}

#[cfg(any(windows, test))]
fn drive_letter_cancel_name(local_path: &str) -> Option<String> {
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
        .or_else(|_| Command::new("umount").arg(local_path).output())
        .map_err(|e| format!("unmount failed: {e}"))?;
    if output.status.success() {
        maybe_remove_app_mount_dir(Path::new(local_path));
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// After unmount, remove empty App-owned mount dirs under `smb-mounts/` (not `/Volumes`).
#[cfg(any(test, target_os = "macos"))]
fn maybe_remove_app_mount_dir(local_path: &Path) {
    let Ok(root) = smb_mounts_root() else {
        return;
    };
    if !local_path.starts_with(&root) {
        return;
    }
    let _ = fs::remove_dir(local_path);
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

fn is_guest_mount(user: &str, password: &str) -> bool {
    password.is_empty() && (user.is_empty() || user.eq_ignore_ascii_case("Guest"))
}

/// Credential material for macOS/Linux auto-mount. Passwords never appear in
/// `smb_url`, `smbfs_remote`, or `gio_args` (those are the process argv).
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
struct PreparedOsMount {
    /// `smb://host/share` — no userinfo. Safe to pass to NetFS and `gio mount`.
    smb_url: String,
    /// `//[domain;]user@host/share` or `//host/share` for guest. No password.
    smbfs_remote: String,
    /// `-N` only for guest (no Keychain password, no prompt).
    smbfs_no_prompt: bool,
    /// `gio mount` argv. The URL has no userinfo.
    gio_args: Vec<String>,
    /// Stdin payload `user\ndomain\npassword\n`. Empty for guest.
    gio_stdin: String,
    guest: bool,
}

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn prepare_os_mount(host: &str, share: &str, login: &str, password: &str) -> PreparedOsMount {
    let (user, pass, domain) = split_creds(login, password);
    let guest = is_guest_mount(&user, &pass);
    let smb_url = smb_url_without_credentials(host, share);
    PreparedOsMount {
        smbfs_remote: mount_smbfs_remote(host, share, &user, &domain, guest),
        smbfs_no_prompt: guest,
        gio_args: gio_mount_args(&smb_url),
        // gio asks User, then Domain, then Password when the URL has no userinfo.
        // Feeding that sequence up front avoids a prompt-order race. The bytes
        // stay on the stdin pipe — not in argv and not in a world-readable file.
        gio_stdin: if guest {
            String::new()
        } else {
            gio_mount_answers(&user, &domain, &pass)
        },
        smb_url,
        guest,
    }
}

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn smb_url_without_credentials(host: &str, share: &str) -> String {
    let h = utf8_percent_encode(host, SMB_ENCODE);
    let s = utf8_percent_encode(share, SMB_ENCODE);
    format!("smb://{h}/{s}")
}

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn mount_smbfs_remote(host: &str, share: &str, user: &str, domain: &str, guest: bool) -> String {
    if guest {
        return format!("//{host}/{share}");
    }
    let u = utf8_percent_encode(user, SMB_ENCODE);
    if domain.is_empty() {
        format!("//{u}@{host}/{share}")
    } else {
        let d = utf8_percent_encode(domain, SMB_ENCODE);
        format!("//{d};{u}@{host}/{share}")
    }
}

#[cfg(any(test, target_os = "macos"))]
fn mount_smbfs_args(remote: &str, mount_point: &Path, no_prompt: bool) -> Vec<String> {
    let mut args = Vec::new();
    if no_prompt {
        args.push("-N".to_string());
    }
    args.push(remote.to_string());
    args.push(mount_point.display().to_string());
    args
}

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn gio_mount_args(smb_url: &str) -> Vec<String> {
    vec!["mount".to_string(), smb_url.to_string()]
}

/// Answer sequence gio reads for a credential-free `smb://` URL.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn gio_mount_answers(user: &str, domain: &str, password: &str) -> String {
    format!(
        "{}\n{}\n{}\n",
        answer_line(user),
        answer_line(domain),
        answer_line(password)
    )
}

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
fn answer_line(value: &str) -> String {
    value.chars().filter(|c| *c != '\n' && *c != '\r').collect()
}

/// `DOMAIN\user` for `NetFSMountURLSync`'s user parameter. Password stays separate.
#[cfg(any(test, target_os = "macos"))]
fn netfs_account(user: &str, domain: &str) -> String {
    if domain.is_empty() {
        user.to_string()
    } else {
        format!("{domain}\\{user}")
    }
}

/// Strip SMB userinfo (`user:password@` / `user@`) so logs never contain credentials.
fn redact_smb_auth(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if starts_with_ignore_ascii_case(&bytes[i..], b"smb://") {
            out.push_str(&text[i..i + 6]);
            i += 6;
            if let Some(len) = userinfo_prefix_len(&text[i..]) {
                i += len;
            }
            continue;
        }
        let preceded_by_colon = i > 0 && bytes[i - 1] == b':';
        if bytes[i..].starts_with(b"//") && !preceded_by_colon {
            if let Some(len) = userinfo_prefix_len(&text[i + 2..]) {
                out.push_str("//");
                i += 2 + len;
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap_or('\u{FFFD}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// URL userinfo plus a literal password (only when long enough to not shred the message).
fn redact_for_log(text: &str, secret: &str) -> String {
    let text = redact_smb_auth(text);
    if secret.len() >= 4 {
        text.replace(secret, "••••")
    } else {
        text
    }
}

fn starts_with_ignore_ascii_case(hay: &[u8], needle: &[u8]) -> bool {
    hay.len() >= needle.len() && hay[..needle.len()].eq_ignore_ascii_case(needle)
}

/// Length of `userinfo@` at the start of `s`, if an `@` appears before the path.
fn userinfo_prefix_len(s: &str) -> Option<usize> {
    for (n, &c) in s.as_bytes().iter().enumerate() {
        match c {
            b'/' | b'?' | b'#' | b' ' | b'\t' | b'\r' | b'\n' => return None,
            b'@' => return Some(n + 1),
            _ => {}
        }
    }
    None
}

/// Run `program` and kill it if it is still waiting after `timeout`.
///
/// Stdin is either null (guest / Keychain) or a pipe that is closed after
/// `stdin_data` is written. Output pipes are collected on a helper thread so a
/// full buffer cannot deadlock the wait.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_command_timeout(
    program: &str,
    args: &[String],
    stdin_data: Option<&str>,
    timeout: Duration,
    label: &str,
    secret: &str,
) -> Result<Output, String> {
    use std::io::Write;
    use std::sync::mpsc;
    use std::thread;

    let mut child = Command::new(program)
        .args(args)
        .stdin(if stdin_data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{label} unavailable: {e}"))?;

    if let Some(data) = stdin_data {
        if let Some(mut pipe) = child.stdin.take() {
            let _ = pipe.write_all(data.as_bytes());
        }
    }
    drop(child.stdin.take());

    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("{label} failed: {e}")),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("{label} failed")),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            kill_process(pid);
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(Ok(output)) if output.status.success() => Ok(output),
                Ok(Ok(output)) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    Err(mount_timeout_message(label, timeout, stderr.trim(), secret))
                }
                _ => Err(mount_timeout_message(label, timeout, "", secret)),
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn mount_timeout_message(label: &str, timeout: Duration, stderr: &str, secret: &str) -> String {
    let detail = redact_for_log(stderr, secret);
    if detail.is_empty() {
        format!(
            "{label} timed out after {}s — credential prompt did not finish",
            timeout.as_secs()
        )
    } else {
        format!(
            "{label} timed out after {}s — credential prompt did not finish: {detail}",
            timeout.as_secs()
        )
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn kill_process(pid: u32) {
    if pid == 0 {
        return;
    }
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
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
    // OPT-23B: settle polls and post-mount checks use the timed single-flight
    // probe — a sleeping redirector must not block on naked `exists()`.
    super::reconnect::path_reachable_timed(path, super::reconnect::LOCAL_PROBE_TIMEOUT)
        .is_reachable()
}

fn path_reachable_registry(path: &Path) -> bool {
    path_reachable(path)
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

/// `NetFSMountURLSync` — password is a CFString parameter, not a process argument.
#[cfg(target_os = "macos")]
mod netfs {
    use std::os::raw::c_void;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr;

    use super::netfs_account;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;

        fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external: u8,
        ) -> *const c_void;

        fn CFURLCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            base_url: *const c_void,
        ) -> *const c_void;

        fn CFURLCreateFromFileSystemRepresentation(
            allocator: *const c_void,
            buffer: *const u8,
            buf_len: isize,
            is_directory: u8,
        ) -> *const c_void;

        fn CFDictionaryCreateMutable(
            allocator: *const c_void,
            capacity: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;

        fn CFDictionarySetValue(dict: *const c_void, key: *const c_void, value: *const c_void);

        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "NetFS", kind = "framework")]
    unsafe extern "C" {
        fn NetFSMountURLSync(
            url: *const c_void,
            mountpoint: *const c_void,
            user: *const c_void,
            passwd: *const c_void,
            open_options: *const c_void,
            mount_options: *const c_void,
            mountpoints: *mut *const c_void,
        ) -> i32;
    }

    struct Cf(*const c_void);

    impl Drop for Cf {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
                self.0 = ptr::null();
            }
        }
    }

    impl Cf {
        fn as_ptr(&self) -> *const c_void {
            self.0
        }

        /// Dictionary retained this object. Drop our extra reference.
        fn release_now(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
                self.0 = ptr::null();
            }
        }
    }

    fn cf_string(value: &str) -> Result<Cf, String> {
        let ptr = unsafe {
            CFStringCreateWithBytes(
                ptr::null(),
                value.as_ptr(),
                value.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
                0,
            )
        };
        if ptr.is_null() {
            Err("CFStringCreateWithBytes failed".into())
        } else {
            Ok(Cf(ptr))
        }
    }

    fn cf_url_string(url: &str) -> Result<Cf, String> {
        let ptr = unsafe {
            CFURLCreateWithBytes(
                ptr::null(),
                url.as_ptr(),
                url.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
                ptr::null(),
            )
        };
        if ptr.is_null() {
            Err(format!("CFURLCreateWithBytes failed for {url}"))
        } else {
            Ok(Cf(ptr))
        }
    }

    fn cf_url_dir(path: &Path) -> Result<Cf, String> {
        let bytes = path.as_os_str().as_bytes();
        let ptr = unsafe {
            CFURLCreateFromFileSystemRepresentation(
                ptr::null(),
                bytes.as_ptr(),
                bytes.len() as isize,
                1,
            )
        };
        if ptr.is_null() {
            Err(format!(
                "CFURLCreateFromFileSystemRepresentation failed for {}",
                path.display()
            ))
        } else {
            Ok(Cf(ptr))
        }
    }

    fn cf_dict() -> Result<Cf, String> {
        let key_cb = &raw const kCFTypeDictionaryKeyCallBacks as *const c_void;
        let val_cb = &raw const kCFTypeDictionaryValueCallBacks as *const c_void;
        let ptr = unsafe { CFDictionaryCreateMutable(ptr::null(), 0, key_cb, val_cb) };
        if ptr.is_null() {
            Err("CFDictionaryCreateMutable failed".into())
        } else {
            Ok(Cf(ptr))
        }
    }

    fn dict_set(dict: &Cf, key: &mut Cf, value: &mut Cf) {
        unsafe { CFDictionarySetValue(dict.as_ptr(), key.as_ptr(), value.as_ptr()) };
        key.release_now();
        value.release_now();
    }

    /// `value` is not owned (`kCFBooleanTrue`). The dictionary retains it; we must not release it.
    fn dict_set_borrowed(dict: &Cf, key: &mut Cf, value: *const c_void) {
        unsafe { CFDictionarySetValue(dict.as_ptr(), key.as_ptr(), value) };
        key.release_now();
    }

    pub(super) fn mount_url(
        smb_url: &str,
        mount_point: &Path,
        user: &str,
        password: &str,
        domain: &str,
        guest: bool,
    ) -> Result<(), String> {
        let url = cf_url_string(smb_url)?;
        let mount_url = cf_url_dir(mount_point)?;

        let k_true = unsafe { kCFBooleanTrue };
        if k_true.is_null() {
            return Err("kCFBooleanTrue missing".into());
        }

        let open_opts = cf_dict()?;
        let mut ui_key = cf_string("UIOption")?;
        let mut no_ui = cf_string("NoUI")?;
        dict_set(&open_opts, &mut ui_key, &mut no_ui);
        if guest {
            let mut guest_key = cf_string("Guest")?;
            dict_set_borrowed(&open_opts, &mut guest_key, k_true);
        }

        let mount_opts = cf_dict()?;
        let mut at_key = cf_string("MountAtMountDir")?;
        dict_set_borrowed(&mount_opts, &mut at_key, k_true);

        let user_cf = if guest {
            None
        } else {
            Some(cf_string(&netfs_account(user, domain))?)
        };
        let pass_cf = if guest {
            None
        } else {
            Some(cf_string(password)?)
        };
        let user_ptr = user_cf.as_ref().map(Cf::as_ptr).unwrap_or(ptr::null());
        let pass_ptr = pass_cf.as_ref().map(Cf::as_ptr).unwrap_or(ptr::null());

        let mut mounted: *const c_void = ptr::null();
        let rc = unsafe {
            NetFSMountURLSync(
                url.as_ptr(),
                mount_url.as_ptr(),
                user_ptr,
                pass_ptr,
                open_opts.as_ptr(),
                mount_opts.as_ptr(),
                &mut mounted,
            )
        };
        if !mounted.is_null() {
            unsafe { CFRelease(mounted) };
        }
        if rc != 0 {
            let err = std::io::Error::from_raw_os_error(rc);
            return Err(format!("NetFSMountURLSync failed ({rc}: {err})"));
        }
        Ok(())
    }
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
    fn join_subpath_under_user_mount() {
        let root = Path::new("/tmp/AeroTandemStudio/smb-mounts/aktuell");
        let p = join_subpath(root, "jobs/a");
        assert_eq!(
            p,
            PathBuf::from("/tmp/AeroTandemStudio/smb-mounts/aktuell/jobs/a")
        );
    }

    #[test]
    fn sanitize_mount_name_strips() {
        assert_eq!(sanitize_mount_name("my share"), "my_share");
        assert_eq!(sanitize_mount_name(""), "ats-smb");
        assert_eq!(sanitize_mount_name("aktuell"), "aktuell");
        assert_eq!(sanitize_mount_name("a/b\\c"), "a_b_c");
    }

    #[test]
    fn pick_user_mount_point_prefers_free_share_name() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(SMB_MOUNTS_SUBDIR);
        fs::create_dir_all(&root).unwrap();
        let p = pick_user_mount_point(&root, "aktuell");
        assert_eq!(p, root.join("aktuell"));
        assert!(!p.starts_with("/Volumes"));
    }

    #[test]
    fn pick_user_mount_point_skips_nonempty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(SMB_MOUNTS_SUBDIR);
        let occupied = root.join("aktuell");
        fs::create_dir_all(&occupied).unwrap();
        fs::write(occupied.join("marker.txt"), b"x").unwrap();
        let p = pick_user_mount_point(&root, "aktuell");
        assert_eq!(p, root.join("aktuell-1"));
    }

    #[test]
    fn pick_user_mount_point_reuses_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(SMB_MOUNTS_SUBDIR);
        let empty = root.join("aktuell");
        fs::create_dir_all(&empty).unwrap();
        let p = pick_user_mount_point(&root, "aktuell");
        assert_eq!(p, empty);
    }

    #[test]
    fn smb_mounts_root_uses_app_data_subdir() {
        let root = smb_mounts_root().unwrap();
        assert!(root.ends_with(SMB_MOUNTS_SUBDIR));
        assert!(!root.starts_with("/Volumes"));
    }

    #[test]
    fn maybe_remove_only_under_smb_mounts() {
        let tmp = tempfile::tempdir().unwrap();
        // Outside app smb-mounts → no-op even if empty (path won't match root).
        let foreign = tmp.path().join("foreign-empty");
        fs::create_dir_all(&foreign).unwrap();
        maybe_remove_app_mount_dir(&foreign);
        assert!(foreign.exists());
    }

    #[test]
    fn mount_urls_and_argv_omit_password() {
        let secret = "p@ss w:ord";
        let encoded = utf8_percent_encode(secret, SMB_ENCODE).to_string();
        assert_ne!(encoded, secret);

        let prepared = prepare_os_mount("nas.local", "my share", r"CORP\alice", secret);
        assert!(!prepared.guest);
        assert!(!prepared.smbfs_no_prompt);
        assert_eq!(prepared.smb_url, "smb://nas.local/my%20share");
        assert_eq!(prepared.smbfs_remote, "//CORP;alice@nas.local/my share");
        assert_eq!(
            prepared.gio_args,
            vec![
                "mount".to_string(),
                "smb://nas.local/my%20share".to_string()
            ]
        );
        assert_eq!(prepared.gio_stdin, format!("alice\nCORP\n{secret}\n"));
        assert_eq!(netfs_account("alice", "CORP"), r"CORP\alice");

        let argv = prepared
            .gio_args
            .iter()
            .chain(std::iter::once(&prepared.smb_url))
            .chain(std::iter::once(&prepared.smbfs_remote));
        for part in argv {
            assert!(!part.contains(secret), "{part}");
            assert!(!part.contains(&encoded), "{part}");
        }
        let smbfs_args = mount_smbfs_args(&prepared.smbfs_remote, Path::new("/tmp/mnt"), false);
        assert!(!smbfs_args.iter().any(|a| a == "-N"));
        for part in &smbfs_args {
            assert!(!part.contains(secret), "{part}");
            assert!(!part.contains(&encoded), "{part}");
        }
    }

    #[test]
    fn guest_mount_uses_no_prompt_and_no_stdin() {
        let prepared = prepare_os_mount("nas.local", "share", "", "");
        assert!(prepared.guest);
        assert!(prepared.smbfs_no_prompt);
        assert_eq!(prepared.smb_url, "smb://nas.local/share");
        assert_eq!(prepared.smbfs_remote, "//nas.local/share");
        assert!(prepared.gio_stdin.is_empty());
        assert!(!prepared.smb_url.contains('@'));

        let args = mount_smbfs_args(&prepared.smbfs_remote, Path::new("/tmp/mnt"), true);
        assert_eq!(
            args,
            vec![
                "-N".to_string(),
                "//nas.local/share".to_string(),
                "/tmp/mnt".to_string()
            ]
        );

        let named_guest = prepare_os_mount("nas", "share", "Guest", "");
        assert!(named_guest.guest);
        assert_eq!(named_guest.smbfs_remote, "//nas/share");

        let guest_with_password = prepare_os_mount("nas", "share", "Guest", "secret");
        assert!(!guest_with_password.guest);
        assert!(!guest_with_password.smbfs_remote.contains("secret"));
        assert!(guest_with_password.gio_stdin.starts_with("Guest\n"));
    }

    #[test]
    fn gio_answers_are_user_domain_password_one_line_each() {
        assert_eq!(
            gio_mount_answers("alice", "CORP", "s3cret"),
            "alice\nCORP\ns3cret\n"
        );
        let answers = gio_mount_answers("alice", "", "a\nb\rc");
        assert_eq!(answers, "alice\n\nabc\n");
        assert_eq!(answers.lines().count(), 3);
        assert!(!answers.contains('\r'));
    }

    #[test]
    fn redact_smb_auth_strips_userinfo_from_logs() {
        assert_eq!(
            redact_smb_auth("mount_smbfs failed: //alice:s3cret@nas/share Permission denied"),
            "mount_smbfs failed: //nas/share Permission denied"
        );
        assert_eq!(
            redact_smb_auth("gio: smb://CORP;alice:s3cret@nas.local/my%20share"),
            "gio: smb://nas.local/my%20share"
        );
        assert_eq!(
            redact_smb_auth("SMB://Alice:Secret@Host/Share and smb://bob@other/x"),
            "SMB://Host/Share and smb://other/x"
        );
        let unc = r"failed (\\nas\share): win32";
        assert_eq!(redact_smb_auth(unc), unc);
        assert_eq!(
            redact_smb_auth("plain //nas/share without auth"),
            "plain //nas/share without auth"
        );
        assert_eq!(
            redact_for_log("echo s3cret then smb://alice:s3cret@nas/share", "s3cret"),
            "echo •••• then smb://nas/share"
        );
        assert_eq!(
            redact_for_log("smb://alice:ab@nas/share still ab", "ab"),
            "smb://nas/share still ab"
        );
        assert!(!redact_smb_auth("smb://alice:hunter2@host/share").contains("hunter2"));
        assert!(!redact_smb_auth("smb://alice:hunter2@host/share").contains("alice"));
    }

    #[test]
    fn userinfo_with_at_in_name_stays_out_of_the_remote() {
        // `login` of `ali@ce` is domain form (user `ali`, domain `ce`), same as split_creds.
        let prepared = prepare_os_mount("nas", "share", "ali@ce", "p:ass");
        assert_eq!(prepared.smbfs_remote, "//ce;ali@nas/share");
        assert!(!prepared.smbfs_remote.contains("p:ass"));
        assert!(!prepared.smbfs_remote.contains("p%3Aass"));
        assert!(!prepared.smb_url.contains("ali"));
        assert_eq!(prepared.gio_stdin, "ali\nce\np:ass\n");

        // A user segment that itself contains `@` is percent-encoded so the
        // separator before the host stays unambiguous — and the password is absent.
        let remote = mount_smbfs_remote("nas", "share", "ali@ce", "", false);
        assert_eq!(remote, "//ali%40ce@nas/share");
        assert_eq!(netfs_account("ali@ce", ""), "ali@ce");
        assert_eq!(netfs_account("alice", ""), "alice");
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

    #[test]
    fn cancel_name_accepts_drive_letter_and_deviceless_unc() {
        assert_eq!(connection_name_for_cancel("Z:").as_deref(), Some("Z:"));
        assert_eq!(connection_name_for_cancel(r"Z:\").as_deref(), Some("Z:"));
        assert_eq!(connection_name_for_cancel(r"Z:\sub").as_deref(), Some("Z:"));
        assert_eq!(connection_name_for_cancel("Y").as_deref(), Some("Y:"));
        assert_eq!(
            connection_name_for_cancel(r"\\Host\Share").as_deref(),
            Some(r"\\host\share")
        );
        assert_eq!(
            connection_name_for_cancel("//Host/Share/sub").as_deref(),
            Some(r"\\host\share\sub")
        );
        assert!(connection_name_for_cancel(r"\\host").is_none());
        assert!(connection_name_for_cancel("/Volumes/aktuell").is_none());
    }

    #[test]
    fn owned_registry_roundtrip_deviceless_unc() {
        let entry = OwnedMountEntry {
            unc: r"\\nas\aktuell".into(),
            local_path: r"\\nas\aktuell".into(),
            created_at: "2".into(),
            platform: "windows".into(),
        };
        let reg = OwnedMountRegistry {
            mounts: vec![entry.clone()],
        };
        let text = serde_json::to_string(&reg).unwrap();
        let back: OwnedMountRegistry = serde_json::from_str(&text).unwrap();
        assert_eq!(back.mounts, vec![entry]);
        assert!(back.mounts[0].local_path.starts_with(r"\\"));
        assert!(!back.mounts[0].local_path.contains(':'));
    }

    #[test]
    fn credential_conflict_1219_reuses_session_or_warns() {
        assert!(deviceless_add_outcome(0, None).is_ok());
        assert!(deviceless_add_outcome(WIN32_SESSION_CREDENTIAL_CONFLICT, Some(0)).is_ok());
        let err = deviceless_add_outcome(WIN32_SESSION_CREDENTIAL_CONFLICT, Some(5)).unwrap_err();
        assert!(err.contains(CREDENTIAL_CONFLICT_MESSAGE), "{err}");
        let err = deviceless_add_outcome(WIN32_SESSION_CREDENTIAL_CONFLICT, None).unwrap_err();
        assert!(err.contains(CREDENTIAL_CONFLICT_MESSAGE));
        let other = deviceless_add_outcome(86, None).unwrap_err();
        assert!(!other.contains(CREDENTIAL_CONFLICT_MESSAGE));
        assert!(other.contains("WNetAddConnection2W failed"));
    }

    #[cfg(windows)]
    #[test]
    fn legacy_drive_letter_helper_still_runs() {
        let _ = find_free_drive_letter();
    }
}
