//! SMB upload client — path normalization + local/SMB transfer.
//!
//! Behaviour ported from legacy `file_utils.py` (not a 1:1 copy):
//! - Accept `smb://`, UNC (`\\` / `//`), and local paths
//! - Test connection / upload with credentials from config
//! - Progress callbacks for UI events
//!
//! Network transfers use the pure-Rust `smb2` crate (cross-platform).
//! Local destinations use direct filesystem copy (handy for tests).

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use smb2::{ClientConfig, FileWriter, SmbClient};
use tokio::sync::Mutex as AsyncMutex;

use crate::video::ffmpeg::{is_upload_cancelled, UploadCancelPolicy, WORKFLOW_CANCELLED};

use super::auto_mount::{ensure_os_smb_mount, AutoMountParams};
use super::health_event;
use super::host_lock;
use super::parallel_upload::{partition_upload_phases, upload_smb_media_parallel};
use super::quiet_budget::{
    self, log_quiet_skip, note_quiet_smb2_fail, note_quiet_smb2_ok, quiet_skip_result,
};
use super::reconnect::{
    self, note_smb2_bridge, probe_local, start_prefer_local_promote, ProbeOutcome,
    LOCAL_PROBE_TIMEOUT,
};
use super::remote_conflict;
use super::session_pool;
use super::staging_gc::{
    dequeue_staging_gc, enqueue_new_staging_gc, list_due_staging_gc, record_gc_attempt,
    staging_prefix,
};
use super::windows_mapping::{lookup_mapped_local, unc_from_smb_parts};

const CHUNK_SIZE: usize = 1024 * 1024;
/// Min interval between upload progress UI events (local + SMB).
const UPLOAD_PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(150);
/// How often in-flight `write_chunk` is interrupted to honor cancel.
const WRITE_CANCEL_POLL: Duration = Duration::from_millis(50);
/// Max time to wait for `FileWriter::abort()` before dropping the writer
/// (session teardown releases locks; hanging abort blocked cleanup for 15s+).
const WRITER_ABORT_TIMEOUT: Duration = Duration::from_secs(1);
/// Pause after hard-dropping the upload TCP session so Samba releases exclusive locks.
const SESSION_TEARDOWN_PAUSE: Duration = Duration::from_secs(2);
/// How long background staging GC waits after enqueue before the first delete.
const STAGING_GC_INITIAL_DELAY: Duration = Duration::from_secs(3);
/// Background GC delete rounds after a cancel (each round = one fresh connection).
const STAGING_GC_BG_ROUNDS: u32 = 4;
const STAGING_GC_BG_ROUND_GAP: Duration = Duration::from_secs(2);

/// Result of `normalize_server_path` (mirrors legacy tuple).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedServerPath {
    pub path: String,
    pub is_network: bool,
    pub was_smb_url: bool,
}

/// Parsed destination for upload / connection tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerTarget {
    Local {
        path: PathBuf,
    },
    Smb {
        host: String,
        port: u16,
        share: String,
        /// Relative path inside the share (may be empty). Forward slashes.
        subpath: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub message: String,
    /// Quiet-Poll (OPT-20B): Local map still waking and smb2 failed — UI should
    /// keep the previous phase instead of flipping to red.
    #[serde(default)]
    pub soft_hold: bool,
    /// Quiet TCP-OK: the server answers, but Login + Share were not checked.
    #[serde(default)]
    pub login_unverified: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadResult {
    pub success: bool,
    pub message: String,
    pub remote_path: String,
    /// Share-relative staging root when a staged SMB upload did not promote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staging_root: Option<String>,
    /// Set when the transfer used smb2 (OPT-23E piggyback). Absent for Local / cancel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smb_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smb_share: Option<String>,
}

impl UploadResult {
    pub(crate) fn fail(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
            remote_path: String::new(),
            staging_root: None,
            smb_host: None,
            smb_share: None,
        }
    }

    fn ok(message: impl Into<String>, remote_path: impl Into<String>) -> Self {
        Self {
            success: true,
            message: message.into(),
            remote_path: remote_path.into(),
            staging_root: None,
            smb_host: None,
            smb_share: None,
        }
    }

    fn with_staging(mut self, staging_root: Option<String>) -> Self {
        self.staging_root = staging_root;
        self
    }

    fn with_smb_endpoint(mut self, host: &str, share: &str) -> Self {
        self.smb_host = Some(host.to_string());
        self.smb_share = Some(share.to_string());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadProgress {
    pub percent: f64,
    /// Files fully uploaded so far (`0…total_files`). Monotonic; not a parallel worker slot.
    pub current_file: u32,
    pub total_files: u32,
    pub current_bytes: u64,
    pub total_bytes: u64,
    /// Average throughput since upload start (bytes per second).
    pub speed_bps: f64,
    /// Optional basename for diagnostics; UI should not treat this as “current file”.
    pub filename: String,
}

/// Normalize various server path formats (legacy `normalize_server_path`).
///
/// Accepts:
/// - `smb://server/share` → `\\server\share` (Windows UNC display)
/// - `smb://user@server/share` (user stripped; credentials come from config)
/// - `\\server\share` / `//server/share`
/// - local paths unchanged (Windows drive letters **or** Unix absolute paths)
pub fn normalize_server_path(server_url: &str) -> Option<NormalizedServerPath> {
    let trimmed = server_url.trim();
    if trimmed.is_empty() {
        return None;
    }

    let was_smb_url = trimmed.to_ascii_lowercase().starts_with("smb://");
    // "smb://" is 6 chars; remaining may start with host (no extra slash) or //host
    let without_scheme = if was_smb_url {
        trimmed.get(6..).unwrap_or("").trim()
    } else {
        trimmed
    };

    if was_smb_url && without_scheme.is_empty() {
        return None;
    }

    let is_network =
        was_smb_url || without_scheme.starts_with(r"\\") || without_scheme.starts_with("//");

    if is_network {
        let mut body = without_scheme
            .trim_start_matches(r"\\")
            .trim_start_matches("//")
            .replace('/', r"\");
        // Collapse accidental leading backslashes left after replace
        while body.starts_with('\\') {
            body = body[1..].to_string();
        }
        if body.is_empty() {
            return None;
        }
        // smb://user@host/share → host\share (login still from config)
        if let Some((maybe_userhost, rest)) = body.split_once('\\') {
            if let Some((_user, host)) = maybe_userhost.rsplit_once('@') {
                if !host.is_empty() {
                    body = if rest.is_empty() {
                        host.to_string()
                    } else {
                        format!("{host}\\{rest}")
                    };
                }
            }
        } else if let Some((_user, host)) = body.rsplit_once('@') {
            if !host.is_empty() {
                body = host.to_string();
            }
        }
        let normalized = format!(r"\\{body}");
        return Some(NormalizedServerPath {
            path: normalized,
            is_network: true,
            was_smb_url,
        });
    }

    Some(NormalizedServerPath {
        path: trimmed.to_string(),
        is_network: false,
        was_smb_url: false,
    })
}

/// Parse a server URL into a concrete local or SMB target.
pub fn parse_server_target(server_url: &str) -> Result<ServerTarget, String> {
    let normalized =
        normalize_server_path(server_url).ok_or_else(|| "Ungültige Server-URL".to_string())?;

    if !normalized.is_network {
        return Ok(ServerTarget::Local {
            path: PathBuf::from(&normalized.path),
        });
    }

    // \\server\share[\sub\path]
    let body = normalized
        .path
        .trim_start_matches(r"\\")
        .trim_start_matches("//");
    let mut parts = body.split('\\').filter(|p| !p.is_empty());
    let host = parts
        .next()
        .ok_or_else(|| format!("Ungültiger Server-Pfad: {}", normalized.path))?
        .to_string();
    let share = parts
        .next()
        .ok_or_else(|| format!("Ungültiger Server-Pfad (Share fehlt): {}", normalized.path))?
        .to_string();
    let subpath = parts.collect::<Vec<_>>().join("/");

    let (host, port) = split_host_port(&host);

    Ok(ServerTarget::Smb {
        host,
        port,
        share,
        subpath,
    })
}

/// Like [`parse_server_target`], but remaps `Smb` → `Local` when the UNC is
/// already available as an OS mapping: Windows drive map (OPT-17) or
/// macOS/Linux SMB mount (OPT-18). With [`AutoMountParams::enabled`], may
/// create an App-owned OS mount (OPT-19) before remapping. Dead/unreachable
/// maps and mount failures fall back to `Smb` (smb2).
pub fn resolve_server_target(
    server_url: &str,
    auto_mount: Option<AutoMountParams<'_>>,
) -> Result<ServerTarget, String> {
    let target = parse_server_target(server_url)?;
    Ok(apply_os_smb_mapping(target, auto_mount))
}

/// OPT-23B: WNet / mount / timed probe must not run on a Tokio worker.
async fn resolve_server_target_blocking(
    server_url: &str,
    auto_mount_enabled: bool,
    login: &str,
    password: &str,
) -> Result<ServerTarget, String> {
    let server_url = server_url.to_string();
    let login = login.to_string();
    let password = password.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        resolve_server_target(
            &server_url,
            Some(AutoMountParams {
                enabled: auto_mount_enabled,
                login: &login,
                password: &password,
            }),
        )
    })
    .await
    .map_err(|e| format!("Server-Pfad konnte nicht aufgelöst werden: {e}"))?
}

fn apply_os_smb_mapping(
    target: ServerTarget,
    auto_mount: Option<AutoMountParams<'_>>,
) -> ServerTarget {
    let ServerTarget::Smb {
        host,
        share,
        subpath,
        ..
    } = &target
    else {
        return target;
    };

    let config_unc = unc_from_smb_parts(host, share, subpath);

    // OPT-17/18 + OPT-20B + OPT-23B/D: probe the mapping root (drive letter
    // first, then a deviceless UNC connection). A missing or denied child
    // stays Local. Asleep root → smb2 bridge. Do not open a second connection
    // for a UNC that is already listed.
    if let Some(mapped) = lookup_mapped_local(&config_unc) {
        let outcome = reconnect::classify_mapped_path(&mapped.root, &mapped.full);
        if outcome.prefers_local() {
            return local_via_os_map(mapped.full, &config_unc, outcome);
        }
        if matches!(outcome, ProbeOutcome::TimedOut) {
            reconnect::note_map_needs_reconnect(&config_unc, &mapped.root);
        }
        note_smb2_bridge(&config_unc, &mapped.full);
        start_prefer_local_promote(config_unc, mapped.full);
        return target;
    }

    // OPT-23D: no listed connection. The redirector may still reach `\\host\share`
    // with credentials it already has (Explorer / Credential Manager).
    #[cfg(windows)]
    if let Some(local) = try_windows_unc_redirector(host, share, subpath, &config_unc) {
        return local;
    }

    if let Some(params) = auto_mount.filter(|p| p.enabled) {
        match ensure_os_smb_mount(host, share, subpath, params) {
            Ok(Some(path)) => {
                return local_via_os_map(path, &config_unc, ProbeOutcome::Reachable);
            }
            Ok(None) => {}
            Err(e) => {
                crate::storage::logging::warn(
                    "smb",
                    format!("SMB auto-mount error ({config_unc}): {e}; using smb2"),
                );
            }
        }
    }

    target
}

/// Timed probe of `\\host\share` (OPT-23D). Reachable share root ⇒ Local via redirector.
#[cfg(windows)]
fn try_windows_unc_redirector(
    host: &str,
    share: &str,
    subpath: &str,
    config_unc: &str,
) -> Option<ServerTarget> {
    let mapped = super::windows_mapping::unc_redirector_local(host, share, subpath);
    let root_outcome = probe_local(&mapped.root, LOCAL_PROBE_TIMEOUT);
    if !root_outcome.is_reachable() {
        return None;
    }
    let outcome = reconnect::classify_mapped_path(&mapped.root, &mapped.full);
    if outcome.prefers_local() {
        Some(local_via_os_map(mapped.full, config_unc, outcome))
    } else {
        None
    }
}

fn local_via_os_map(path: PathBuf, config_unc: &str, outcome: ProbeOutcome) -> ServerTarget {
    let display = path
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    let via = local_via_label(&display);
    let note = match outcome {
        ProbeOutcome::Missing => " — Zielordner fehlt, wird angelegt",
        ProbeOutcome::Denied => " — Zugriff verweigert",
        _ => "",
    };
    crate::storage::logging::info(
        "smb",
        format!("SMB via {via} {display} ({config_unc}){note}"),
    );
    ServerTarget::Local { path }
}

fn local_via_label(display: &str) -> &'static str {
    if display.starts_with(r"\\") || display.starts_with("//") {
        "UNC"
    } else if cfg!(windows) {
        "mapped drive"
    } else {
        "OS mount"
    }
}

fn local_health_result(path: &Path, outcome: ProbeOutcome, quiet: bool) -> ConnectionTestResult {
    if outcome.is_reachable() {
        ConnectionTestResult {
            ok: true,
            message: format!("Lokaler Pfad erreichbar: {}", path.display()),
            soft_hold: false,
            login_unverified: false,
        }
    } else if matches!(outcome, ProbeOutcome::Missing) {
        ConnectionTestResult {
            ok: true,
            message: format!("Zielordner fehlt, wird angelegt: {}", path.display()),
            soft_hold: false,
            login_unverified: false,
        }
    } else if matches!(outcome, ProbeOutcome::Denied) {
        ConnectionTestResult {
            ok: false,
            message: format!("Zugriff verweigert: {}", path.display()),
            soft_hold: false,
            login_unverified: false,
        }
    } else if quiet {
        ConnectionTestResult {
            ok: false,
            message: format!(
                "Lokaler Pfad noch nicht bereit (Reconnect…): {}",
                path.display()
            ),
            soft_hold: true,
            login_unverified: false,
        }
    } else {
        ConnectionTestResult {
            ok: false,
            message: format!("Lokaler Pfad nicht gefunden: {}", path.display()),
            soft_hold: false,
            login_unverified: false,
        }
    }
}

fn split_host_port(host: &str) -> (String, u16) {
    // IPv6 in brackets: [2001:db8::1]:445
    if let Some(rest) = host.strip_prefix('[') {
        if let Some((addr, port_part)) = rest.split_once("]:") {
            if let Ok(port) = port_part.parse::<u16>() {
                return (addr.to_string(), port);
            }
        }
        return (host.to_string(), 445);
    }
    // Avoid splitting IPv6 without brackets by requiring a single colon + numeric port
    if let Some((h, p)) = host.rsplit_once(':') {
        if !h.contains(':') {
            if let Ok(port) = p.parse::<u16>() {
                return (h.to_string(), port);
            }
        }
    }
    (host.to_string(), 445)
}

/// Remove characters that are invalid in Windows filenames (legacy `sanitize_filename`).
#[allow(dead_code)]
pub fn sanitize_filename(filename: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    filename
        .chars()
        .filter(|c| !invalid.contains(c))
        .collect::<String>()
        .trim()
        .to_string()
}

fn parse_credentials(login: &str, password: &str) -> (String, String, String) {
    let login = login.trim();
    let password = password.to_string(); // keep exact
    if login.is_empty() {
        // Anonymous / guest share (common on link-local NAS; smbclient -N on Unix)
        return ("Guest".into(), password, String::new());
    }
    if let Some((domain, user)) = login.split_once('\\') {
        return (user.to_string(), password, domain.to_string());
    }
    if let Some((domain, user)) = login.split_once('/') {
        // Avoid treating user@host as domain/user — only DOMAIN/user
        if !domain.contains('@') {
            return (user.to_string(), password, domain.to_string());
        }
    }
    // user@DOMAIN (macOS / Kerberos-style) → domain + user
    if let Some((user, domain)) = login.split_once('@') {
        if !user.is_empty() && !domain.is_empty() && !domain.contains('/') {
            return (user.to_string(), password, domain.to_string());
        }
    }
    (login.to_string(), password, String::new())
}

fn smb_addr(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        // bare IPv6
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// SessionSetup budget for Upload and Staging-GC (OPT-23A A6).
pub(crate) const SMB_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Health SessionSetup budget — a dead NAS must not stall the check.
pub(crate) const SMB_HEALTH_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Loud health when a transfer still holds the host after the lock wait (A4).
const LOUD_HOST_BUSY_MESSAGE: &str = "Übertragung aktiv — Verbindung besteht";
/// OPT-23E: Quiet smb2 health is a TCP connect only — no SessionSetup.
const QUIET_TCP_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const QUIET_TCP_OK_MESSAGE: &str = "Server erreichbar";

pub(crate) async fn connect_smb(
    host: &str,
    port: u16,
    login: &str,
    password: &str,
    timeout: Duration,
) -> Result<SmbClient, String> {
    let (username, password, domain) = parse_credentials(login, password);
    let addr = smb_addr(host, port);
    SmbClient::connect(ClientConfig {
        addr,
        timeout,
        username,
        password,
        domain,
        auto_reconnect: false,
        compression: true,
        dfs_enabled: true,
        dfs_target_overrides: Default::default(),
        connect_options: None,
    })
    .await
    .map_err(|e| map_connect_error(&e.to_string()))
}

fn join_smb_path(base: &str, rest: &str) -> String {
    let base = base.trim_matches('/').trim_matches('\\');
    let rest = rest.trim_matches('/').trim_matches('\\').replace('\\', "/");
    if base.is_empty() {
        rest
    } else if rest.is_empty() {
        base.replace('\\', "/")
    } else {
        format!("{}/{rest}", base.replace('\\', "/"))
    }
}

fn display_remote(target: &ServerTarget, relative: &str) -> String {
    match target {
        ServerTarget::Local { path } => path.join(relative).to_string_lossy().into_owned(),
        ServerTarget::Smb {
            host,
            share,
            subpath,
            ..
        } => {
            let full = join_smb_path(subpath, relative);
            if full.is_empty() {
                format!("//{host}/{share}")
            } else {
                format!("//{host}/{share}/{full}")
            }
        }
    }
}

/// Test reachability of the configured server (local path or SMB share).
///
/// `quiet`: Quiet-Poll (OPT-23E). Local stays a timed probe. The smb2 path is
/// only `TcpStream::connect` (2s) — no SessionSetup and no Quiet backoff.
/// A sticky loud Login/Share error is not cleared by TCP-OK (`soft_hold`).
/// A loud check (boot, manual, visibility after a long hide) still does
/// SessionSetup + TreeConnect. It waits up to 3s on the host lock; if a
/// transfer is still running it reports success without SessionSetup. A pooled
/// health session is disconnected afterwards (not returned to the pool).
pub async fn test_connection(
    server_url: &str,
    login: &str,
    password: &str,
    auto_mount_enabled: bool,
    quiet: bool,
) -> ConnectionTestResult {
    let parsed = match parse_server_target(server_url) {
        Ok(t) => t,
        Err(e) => {
            return ConnectionTestResult {
                ok: false,
                message: e,
                soft_hold: false,
                login_unverified: false,
            }
        }
    };

    let bridge_unc = match &parsed {
        ServerTarget::Smb {
            host,
            share,
            subpath,
            ..
        } => Some(unc_from_smb_parts(host, share, subpath)),
        ServerTarget::Local { .. } => None,
    };

    let target =
        match resolve_server_target_blocking(server_url, auto_mount_enabled, login, password).await
        {
            Ok(t) => t,
            Err(e) => {
                return ConnectionTestResult {
                    ok: false,
                    message: e,
                    soft_hold: false,
                    login_unverified: false,
                }
            }
        };

    match target {
        ServerTarget::Local { path } => {
            // OPT-20B B8 / OPT-22A A1 / OPT-23B: timed probe only, never smb2.
            // Missing/Denied were cached by the mapping classifier moments ago.
            let outcome = probe_local(&path, LOCAL_PROBE_TIMEOUT);
            local_health_result(&path, outcome, quiet)
        }
        ServerTarget::Smb {
            host,
            port,
            share,
            subpath,
        } => {
            // OPT-23E: Quiet never opens a session. TCP is cheap — no backoff.
            if quiet {
                let host_for_probe = host.clone();
                let tcp = match tauri::async_runtime::spawn_blocking(move || {
                    probe_smb_tcp_blocking(&host_for_probe, port)
                })
                .await
                {
                    Ok(result) => result,
                    Err(e) => Err(format!("TCP-Probe fehlgeschlagen: {e}")),
                };
                return quiet_tcp_health_result(&host, &share, tcp);
            }

            let result =
                test_smb_connection(&host, port, &share, &subpath, login, password, false).await;
            if result.ok && result.message != LOUD_HOST_BUSY_MESSAGE {
                // A live SessionSetup proved Login + Share (E3).
                quiet_budget::clear_loud_auth_failure(&host, &share);
            } else if !result.ok && !result.soft_hold {
                quiet_budget::note_loud_auth_failure(&host, &share, &result.message);
            }
            if let Some(unc) = bridge_unc.as_ref() {
                if result.ok {
                    // Loud OK → Quiet SessionSetup path backs off (E5). TCP ignores it.
                    note_quiet_smb2_ok(unc);
                } else if !result.soft_hold && quiet_budget::is_session_rejected(&result.message) {
                    // Loud reject still cools a later SessionSetup so a kick cannot storm.
                    note_quiet_smb2_fail(unc, &result.message);
                }
            }
            result
        }
    }
}

/// TCP connect to `host:port` (2s per address). Open means the server accepts
/// SMB's port. Does not SessionSetup. Caller runs this off the Tokio worker.
pub(crate) fn probe_smb_tcp_blocking(host: &str, port: u16) -> Result<(), String> {
    use std::net::{TcpStream, ToSocketAddrs};

    let addr = smb_addr(host, port);
    let addrs: Vec<_> = match addr.to_socket_addrs() {
        Ok(iter) => iter.collect(),
        Err(e) => return Err(map_connect_error(&e.to_string())),
    };
    if addrs.is_empty() {
        return Err("Server nicht erreichbar (Host nicht gefunden).".into());
    }
    let mut last_err: Option<String> = None;
    for sock in addrs {
        match TcpStream::connect_timeout(&sock, QUIET_TCP_PROBE_TIMEOUT) {
            Ok(stream) => {
                drop(stream);
                return Ok(());
            }
            Err(e) => last_err = Some(map_connect_error(&e.to_string())),
        }
    }
    Err(last_err.unwrap_or_else(|| "Server nicht erreichbar.".into()))
}

/// Quiet smb2 health from a TCP probe (OPT-23E E1/E3). No backoff side effects.
fn quiet_tcp_health_result(
    host: &str,
    share: &str,
    tcp: Result<(), String>,
) -> ConnectionTestResult {
    match tcp {
        Ok(()) => {
            if let Some(prev) = quiet_budget::loud_auth_failure(host, share) {
                ConnectionTestResult {
                    ok: false,
                    message: format!(
                        "Server erreichbar — Anmeldung/Freigabe zuletzt fehlgeschlagen: {prev}"
                    ),
                    soft_hold: true,
                    login_unverified: false,
                }
            } else {
                ConnectionTestResult {
                    ok: true,
                    message: QUIET_TCP_OK_MESSAGE.to_string(),
                    soft_hold: false,
                    login_unverified: true,
                }
            }
        }
        Err(message) => ConnectionTestResult {
            ok: false,
            message,
            soft_hold: false,
            login_unverified: false,
        },
    }
}

async fn test_smb_connection(
    host: &str,
    port: u16,
    share: &str,
    subpath: &str,
    login: &str,
    password: &str,
    quiet: bool,
) -> ConnectionTestResult {
    // Hold the host mutex for the whole check so Health cannot SessionSetup
    // beside Upload, SD-Backup, or GC (same host, any share).
    let _host_guard = match host_lock::gate_health_connect(host, quiet).await {
        host_lock::HealthConnectGate::Ready(guard) => guard,
        host_lock::HealthConnectGate::QuietBusy => {
            let unc = unc_from_smb_parts(host, share, subpath);
            let reason = quiet_budget::QuietSkipReason::HostBusy;
            log_quiet_skip(&unc, reason);
            let (ok, message, soft_hold) = quiet_skip_result(reason);
            return ConnectionTestResult {
                ok,
                message,
                soft_hold,
                login_unverified: false,
            };
        }
        host_lock::HealthConnectGate::LoudBusy => {
            // A4: transfer still running — connection exists, no SessionSetup.
            return ConnectionTestResult {
                ok: true,
                message: LOUD_HOST_BUSY_MESSAGE.to_string(),
                soft_hold: false,
                login_unverified: false,
            };
        }
    };

    // OPT-22B / OPT-23A: one pooled session. Success disconnects (A1) so Health
    // does not keep a host slot. A dead pool hit retries once (A5); only that
    // second failure is a Quiet-backoff.
    let mut already_retried = false;
    loop {
        let mut pooled = match session_pool::acquire(
            host,
            port,
            share,
            login,
            password,
            SMB_HEALTH_CONNECT_TIMEOUT,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                return ConnectionTestResult {
                    ok: false,
                    message: e,
                    soft_hold: false,
                    login_unverified: false,
                };
            }
        };

        let was_hit = pooled.was_hit();
        let result = probe_pooled_share(&mut pooled, host, share, subpath).await;
        match health_probe_disposition(result.ok, was_hit, already_retried) {
            HealthProbeDisposition::Discard => {
                pooled.discard().await;
                return result;
            }
            HealthProbeDisposition::RetryFresh => {
                // Stale hit: drop the dead session without Quiet-backoff.
                crate::storage::logging::info(
                    "smb",
                    format!("SMB pool stale hit — reconnect once ({host})"),
                );
                pooled.discard().await;
                already_retried = true;
            }
            HealthProbeDisposition::Fail => {
                session_pool::discard_on_error(pooled, &result.message).await;
                return result;
            }
        }
    }
}

/// What to do with a health probe against a pooled session (OPT-23A A1/A5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HealthProbeDisposition {
    /// Check succeeded — disconnect, do not park in the pool.
    Discard,
    /// Error immediately after a pool hit — drop it and connect once more.
    /// This attempt does not count as Quiet-backoff.
    RetryFresh,
    /// Miss, or the fresh retry failed — discard and count Quiet-backoff.
    Fail,
}

fn health_probe_disposition(
    ok: bool,
    was_hit: bool,
    already_retried: bool,
) -> HealthProbeDisposition {
    if ok {
        HealthProbeDisposition::Discard
    } else if was_hit && !already_retried {
        HealthProbeDisposition::RetryFresh
    } else {
        HealthProbeDisposition::Fail
    }
}

async fn probe_pooled_share(
    pooled: &mut session_pool::PooledSession,
    host: &str,
    share: &str,
    subpath: &str,
) -> ConnectionTestResult {
    let list_path = if subpath.is_empty() { "" } else { subpath };
    let list_result = {
        let (client, tree) = pooled.parts_mut();
        client.list_directory(tree, list_path).await
    };
    match list_result {
        Ok(_) => ConnectionTestResult {
            ok: true,
            message: format!("Verbindung zum Server erfolgreich (//{host}/{share})"),
            soft_hold: false,
            login_unverified: false,
        },
        Err(e) => {
            if subpath.is_empty() {
                ConnectionTestResult {
                    ok: false,
                    message: format!("Share erreichbar, Listing fehlgeschlagen: {e}"),
                    soft_hold: false,
                    login_unverified: false,
                }
            } else {
                let fs_result = {
                    let (client, tree) = pooled.parts_mut();
                    client.fs_info(tree).await
                };
                match fs_result {
                    Ok(_) => ConnectionTestResult {
                        ok: true,
                        message: format!("Verbindung zum Server erfolgreich (//{host}/{share})"),
                        soft_hold: false,
                        login_unverified: false,
                    },
                    Err(e2) => ConnectionTestResult {
                        ok: false,
                        message: format!("Verbindung fehlgeschlagen: {e2}"),
                        soft_hold: false,
                        login_unverified: false,
                    },
                }
            }
        }
    }
}

fn map_connect_error(err: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("os error 10060")
        || lower.contains("os error 110")
    {
        "Server nicht erreichbar (Zeitüberschreitung).".into()
    } else if lower.contains("connection refused")
        || lower.contains("actively refused")
        || lower.contains("os error 10061")
        || lower.contains("os error 111")
    {
        "Server nicht erreichbar (Verbindung abgelehnt).".into()
    } else if lower.contains("failed to lookup")
        || lower.contains("name or service not known")
        || lower.contains("no such host")
        || lower.contains("nodename nor servname")
        || lower.contains("dns")
    {
        "Server nicht erreichbar (Host nicht gefunden).".into()
    } else if lower.contains("network is unreachable")
        || lower.contains("no route to host")
        || lower.contains("host is unreachable")
    {
        "Server nicht erreichbar (Netzwerk).".into()
    } else if lower.contains("logon")
        || (lower.contains("access_denied") && lower.contains("session"))
        || lower.contains("status_logon_failure")
        || lower.contains("wrong password")
    {
        "Verbindung fehlgeschlagen: Ungültiger Benutzername oder Passwort.".into()
    } else {
        format!("SMB-Verbindung fehlgeschlagen: {err}")
    }
}

pub(crate) fn map_smb_error(err: &str, share: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("logon")
        || (lower.contains("access_denied") && lower.contains("session"))
        || lower.contains("status_logon_failure")
        || lower.contains("wrong password")
    {
        "Verbindung fehlgeschlagen: Ungültiger Benutzername oder Passwort.".into()
    } else if lower.contains("bad_network_name")
        || lower.contains("object_name_not_found")
        || lower.contains("status_bad_network_name")
    {
        format!("Verbindung fehlgeschlagen: Server oder Freigabe '{share}' nicht gefunden.")
    } else if lower.contains("access_denied") {
        format!("Verbindung fehlgeschlagen: Kein Zugriff auf Freigabe '{share}'.")
    } else {
        // Reuse connect mapping for transport-ish share errors, else keep short.
        let mapped = map_connect_error(err);
        if mapped.starts_with("Server nicht erreichbar")
            || mapped.starts_with("Verbindung fehlgeschlagen: Ungültiger")
        {
            mapped
        } else {
            format!("Verbindung fehlgeschlagen: {err}")
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct FileEntry {
    pub(crate) relative: String,
    pub(crate) absolute: PathBuf,
    pub(crate) size: u64,
}

fn collect_upload_files(local: &Path) -> Result<Vec<FileEntry>, String> {
    if local.is_file() {
        let size = fs::metadata(local).map(|m| m.len()).unwrap_or(0);
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "upload.bin".into());
        return Ok(vec![FileEntry {
            relative: name,
            absolute: local.to_path_buf(),
            size,
        }]);
    }

    if !local.is_dir() {
        return Err(format!("Lokaler Pfad existiert nicht: {}", local.display()));
    }

    let dir_name = local
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload".into());

    let mut files = Vec::new();
    collect_dir_files(local, local, &dir_name, &mut files)?;
    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    if files.is_empty() {
        return Err(format!("Lokales Verzeichnis ist leer: {}", local.display()));
    }
    Ok(files)
}

fn collect_dir_files(
    root: &Path,
    current: &Path,
    prefix: &str,
    out: &mut Vec<FileEntry>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|e| format!("Verzeichnis nicht lesbar {}: {e}", current.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            let next_prefix = format!("{prefix}/{name}");
            collect_dir_files(root, &path, &next_prefix, out)?;
        } else if path.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(FileEntry {
                relative: format!("{prefix}/{name}"),
                absolute: path,
                size,
            });
        }
    }
    Ok(())
}

pub(crate) struct UploadProgressGate<F> {
    cb: F,
    last_emit: Instant,
    last_percent: f64,
    last_file: u32,
    started: Instant,
    cancel: UploadCancelPolicy,
}

impl<F: FnMut(UploadProgress)> UploadProgressGate<F> {
    fn new(cb: F, cancel: UploadCancelPolicy) -> Self {
        let now = Instant::now();
        Self {
            cb,
            last_emit: now.checked_sub(UPLOAD_PROGRESS_MIN_INTERVAL).unwrap_or(now),
            last_percent: -1.0,
            last_file: 0,
            started: now,
            cancel,
        }
    }

    pub(crate) fn emit(
        &mut self,
        percent: f64,
        current_file: u32,
        total_files: u32,
        current_bytes: u64,
        total_bytes: u64,
        filename: &str,
        force: bool,
    ) {
        if is_upload_cancelled(self.cancel) {
            return;
        }
        let percent = percent.clamp(0.0, 100.0);
        let file_changed = current_file != self.last_file;
        let percent_jump = (percent - self.last_percent).abs() >= 1.0;
        let interval_elapsed = self.last_emit.elapsed() >= UPLOAD_PROGRESS_MIN_INTERVAL;
        if !force
            && percent > 0.0
            && percent < 100.0
            && !file_changed
            && !percent_jump
            && !interval_elapsed
        {
            return;
        }
        self.last_emit = Instant::now();
        self.last_percent = percent;
        self.last_file = current_file;
        let elapsed = self.started.elapsed().as_secs_f64().max(0.001);
        let speed_bps = if current_bytes > 0 {
            current_bytes as f64 / elapsed
        } else {
            0.0
        };
        (self.cb)(UploadProgress {
            percent,
            current_file,
            total_files,
            current_bytes,
            total_bytes,
            speed_bps,
            filename: filename.to_string(),
        });
    }
}

fn cancelled_upload_result() -> UploadResult {
    UploadResult::fail(WORKFLOW_CANCELLED)
}

fn ensure_upload_not_cancelled(cancel: UploadCancelPolicy) -> Result<(), UploadResult> {
    if is_upload_cancelled(cancel) {
        Err(cancelled_upload_result())
    } else {
        Ok(())
    }
}

/// Upload a local file or directory to the configured server.
///
/// `cancel` selects whether Vorgang-slot cancel aborts this transfer
/// ([`UploadCancelPolicy::SlotOnly`]) or backup-only cancel
/// ([`UploadCancelPolicy::BackupOnly`] — SD server-backup mirrors).
pub async fn upload_path<F>(
    local_path: &Path,
    server_url: &str,
    login: &str,
    password: &str,
    auto_mount_enabled: bool,
    cancel: UploadCancelPolicy,
    on_progress: F,
) -> UploadResult
where
    F: FnMut(UploadProgress) + Send + 'static,
{
    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        return cancelled;
    }

    let target =
        match resolve_server_target_blocking(server_url, auto_mount_enabled, login, password).await
        {
            Ok(t) => t,
            Err(e) => return UploadResult::fail(e),
        };

    let files = match collect_upload_files(local_path) {
        Ok(f) => f,
        Err(e) => return UploadResult::fail(e),
    };

    let total_files = files.len() as u32;
    let total_bytes: u64 = files.iter().map(|f| f.size).sum();
    let mut progress = UploadProgressGate::new(on_progress, cancel);
    progress.emit(0.0, 0, total_files, 0, total_bytes, "", true);

    match &target {
        ServerTarget::Local { path } => {
            let dest = path.clone();
            let files = files.to_vec();
            match tauri::async_runtime::spawn_blocking(move || {
                upload_local(
                    &dest,
                    &files,
                    total_files,
                    total_bytes,
                    cancel,
                    &mut progress,
                )
            })
            .await
            {
                Ok(result) => result,
                Err(e) => UploadResult::fail(if is_upload_cancelled(cancel) {
                    WORKFLOW_CANCELLED.into()
                } else {
                    format!("Upload fehlgeschlagen: {e}")
                }),
            }
        }
        ServerTarget::Smb {
            host,
            port,
            share,
            subpath,
        } => {
            let result = upload_smb(
                host,
                *port,
                share,
                subpath,
                &files,
                total_files,
                total_bytes,
                login,
                password,
                cancel,
                progress,
            )
            .await;
            // Cancel is not a health signal. Callers emit `smb-health` otherwise.
            if result.message.trim() == WORKFLOW_CANCELLED {
                result
            } else {
                result.with_smb_endpoint(host, share)
            }
        }
    }
}

fn copy_file_chunked(
    src: &Path,
    dst: &Path,
    cancel: UploadCancelPolicy,
    mut on_chunk: impl FnMut(u64),
) -> Result<(), String> {
    let mut input = File::open(src).map_err(|e| e.to_string())?;
    let mut output = File::create(dst).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut copied = 0u64;
    loop {
        if is_upload_cancelled(cancel) {
            let _ = fs::remove_file(dst);
            return Err(WORKFLOW_CANCELLED.into());
        }
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        copied += n as u64;
        on_chunk(copied);
    }
    Ok(())
}

fn job_top_name(files: &[FileEntry]) -> String {
    files
        .first()
        .map(|f| {
            f.relative
                .split('/')
                .next()
                .unwrap_or(f.relative.as_str())
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "upload".into())
}

fn upload_local<F: FnMut(UploadProgress)>(
    dest_root: &Path,
    files: &[FileEntry],
    total_files: u32,
    total_bytes: u64,
    cancel: UploadCancelPolicy,
    progress: &mut UploadProgressGate<F>,
) -> UploadResult {
    if let Err(e) = fs::create_dir_all(dest_root) {
        return UploadResult::fail(format!("Zielverzeichnis konnte nicht erstellt werden: {e}"));
    }

    let job_name = job_top_name(files);
    let staging_id = uuid::Uuid::new_v4().to_string();
    let staging_base = dest_root
        .join(super::staging_gc::staging_dir_name())
        .join(&staging_id);

    let cleanup_local_staging = |base: &Path| {
        let _ = fs::remove_dir_all(base);
        let staging_parent = dest_root.join(super::staging_gc::staging_dir_name());
        let _ = fs::remove_dir(staging_parent); // only if empty
    };

    // Same barrier order as SMB: media → manifest → marker (never marker mid-media).
    let phases = partition_upload_phases(files);
    let ordered = phases.ordered();
    let mut copied_bytes = 0u64;

    for (idx, file) in ordered.into_iter().enumerate() {
        if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
            cleanup_local_staging(&staging_base);
            return cancelled;
        }
        let file_index = (idx + 1) as u32;
        let dest = staging_base.join(file.relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = dest.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                cleanup_local_staging(&staging_base);
                return UploadResult::fail(format!("Ordner erstellen fehlgeschlagen: {e}"));
            }
        }

        let bytes_before = copied_bytes;
        let filename = file
            .absolute
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        // `current_file` = completed count (0 while first file is in flight).
        let completed_before = idx as u32;
        if let Err(e) = copy_file_chunked(&file.absolute, &dest, cancel, |copied_in_file| {
            let current = bytes_before + copied_in_file;
            let percent = if total_bytes > 0 {
                (current as f64 / total_bytes as f64) * 100.0
            } else {
                (completed_before as f64 / total_files as f64) * 100.0
            };
            // Keep <100 until the final file finishes (marker barrier UX).
            let percent = if file_index < total_files {
                percent.min(99.9)
            } else {
                percent
            };
            progress.emit(
                percent,
                completed_before,
                total_files,
                current,
                total_bytes,
                &filename,
                false,
            );
        }) {
            cleanup_local_staging(&staging_base);
            let message = if e == WORKFLOW_CANCELLED {
                WORKFLOW_CANCELLED.into()
            } else {
                format!("Kopieren fehlgeschlagen ({}): {e}", file.relative)
            };
            return UploadResult::fail(message);
        }

        copied_bytes += file.size;
        let percent = if total_bytes > 0 {
            (copied_bytes as f64 / total_bytes as f64) * 100.0
        } else {
            (file_index as f64 / total_files as f64) * 100.0
        };
        progress.emit(
            percent,
            file_index,
            total_files,
            copied_bytes,
            total_bytes,
            &filename,
            true,
        );
    }

    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        cleanup_local_staging(&staging_base);
        return cancelled;
    }

    // Promote staging → final job root.
    let staged_job = staging_base.join(&job_name);
    let final_job = dest_root.join(&job_name);
    if final_job.exists() {
        cleanup_local_staging(&staging_base);
        return UploadResult::fail(remote_conflict::remote_job_exists_message());
    }
    if let Err(e) = fs::rename(&staged_job, &final_job) {
        cleanup_local_staging(&staging_base);
        if e.kind() == std::io::ErrorKind::AlreadyExists
            || remote_conflict::is_remote_job_exists_message(&e.to_string())
        {
            return UploadResult::fail(remote_conflict::remote_job_exists_message());
        }
        return UploadResult::fail(format!("Staging-Promote fehlgeschlagen: {e}"));
    }
    cleanup_local_staging(&staging_base);

    progress.emit(
        100.0,
        total_files,
        total_files,
        total_bytes,
        total_bytes,
        "",
        true,
    );

    let remote = dest_root.to_string_lossy().into_owned();
    UploadResult::ok(format!("Erfolgreich auf Server kopiert: {remote}"), remote)
}

/// Hard-drop the upload SMB session (disconnect share + drop TCP), then pause on cancel.
///
/// Cancelled parallel writers often skip CLOSE; Samba keeps exclusive locks until the
/// **TCP session** dies. A plain `drop(Arc)` can race Arc clones from aborted tasks —
/// we wait for unique ownership, call `disconnect_share`, then drop the client.
async fn release_smb_session_for_cleanup<F>(
    result: UploadResult,
    cancel: UploadCancelPolicy,
    progress: Arc<Mutex<UploadProgressGate<F>>>,
    tree: Arc<smb2::client::Tree>,
    client: Arc<AsyncMutex<SmbClient>>,
) -> UploadResult
where
    F: FnMut(UploadProgress) + Send + 'static,
{
    let cancelled = result.message.trim() == WORKFLOW_CANCELLED || is_upload_cancelled(cancel);
    drop(progress);

    // Aborted JoinSet tasks may still hold Connection Arc clones briefly.
    for _ in 0..40 {
        if Arc::strong_count(&client) == 1 && Arc::strong_count(&tree) == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if Arc::strong_count(&client) > 1 {
        crate::storage::logging::warn(
            "smb",
            format!(
                "SMB-Client noch geteilt (Arc={}) — erzwinge Drop (Cancel-Lock-Risiko)",
                Arc::strong_count(&client)
            ),
        );
    }

    let tree_for_disconnect = (*tree).clone();
    match Arc::try_unwrap(client).map(AsyncMutex::into_inner) {
        Ok(client) => {
            drop(tree);
            // OPT-22B B6: explicit disconnect before Drop (shared with success path).
            session_pool::disconnect_owned(client, tree_for_disconnect).await;
        }
        Err(client) => {
            drop(tree);
            drop(client);
        }
    }

    if cancelled {
        tokio::time::sleep(SESSION_TEARDOWN_PAUSE).await;
    }
    result
}

/// Enqueue staging GC and schedule a non-blocking background delete (does not stall Cancel-UX).
fn schedule_staging_gc(
    host: &str,
    port: u16,
    share: &str,
    staging_root: &str,
    login: &str,
    password: &str,
) {
    enqueue_new_staging_gc(host, port, share, staging_root);
    let host = host.to_string();
    let share = share.to_string();
    let staging_root = staging_root.to_string();
    let login = login.to_string();
    let password = password.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STAGING_GC_INITIAL_DELAY).await;
        for round in 1..=STAGING_GC_BG_ROUNDS {
            match cleanup_smb_remote_tree(
                &host,
                port,
                &share,
                &login,
                &password,
                &staging_root,
                true,
                1,
            )
            .await
            {
                Ok(()) => {
                    dequeue_staging_gc(&host, port, &share, &staging_root);
                    crate::storage::logging::info("smb", format!("Staging-GC OK: {staging_root}"));
                    return;
                }
                Err(e) => {
                    let sharing = smb_sharing_violation(&e);
                    if round < STAGING_GC_BG_ROUNDS && sharing {
                        tokio::time::sleep(STAGING_GC_BG_ROUND_GAP * round).await;
                        continue;
                    }
                    record_gc_attempt(&host, port, &share, &staging_root, false);
                    crate::storage::logging::warn(
                        "smb",
                        format!("Staging-GC später (.ats_staging…): {}", shorten_smb_err(&e)),
                    );
                    return;
                }
            }
        }
    });
}

fn shorten_smb_err(err: &str) -> String {
    let e = err.to_ascii_lowercase();
    if e.contains("sharing_violation") {
        "STATUS_SHARING_VIOLATION (Handle noch offen)".into()
    } else if e.contains("directory_not_empty") {
        "STATUS_DIRECTORY_NOT_EMPTY".into()
    } else if err.len() > 160 {
        format!("{}…", &err[..160])
    } else {
        err.to_string()
    }
}

/// Fire-and-forget drain of due staging GC entries (startup / idle).
pub fn spawn_smb_staging_gc(login: &str, password: &str) {
    let login = login.to_string();
    let password = password.to_string();
    tauri::async_runtime::spawn(async move {
        let n = drain_smb_staging_gc(&login, &password).await;
        if n > 0 {
            crate::storage::logging::info("smb", format!("Staging-GC: {n} Ordner entfernt"));
        }
    });
}

/// After a failed/cancelled staged upload: hard-drop session, enqueue + background GC.
async fn abandon_smb_staging<F>(
    result: UploadResult,
    cancel: UploadCancelPolicy,
    progress: Arc<Mutex<UploadProgressGate<F>>>,
    tree: Arc<smb2::client::Tree>,
    client: Arc<AsyncMutex<SmbClient>>,
    host: &str,
    port: u16,
    share: &str,
    staging_root: &str,
    login: &str,
    password: &str,
) -> UploadResult
where
    F: FnMut(UploadProgress) + Send + 'static,
{
    let result = release_smb_session_for_cleanup(result, cancel, progress, tree, client).await;
    // OPT-22B: upload session torn down — clear any Health/GC pool entry.
    session_pool::invalidate(host, port, share, login).await;
    schedule_staging_gc(host, port, share, staging_root, login, password);
    result.with_staging(Some(staging_root.to_string()))
}

async fn upload_smb<F: FnMut(UploadProgress) + Send + 'static>(
    host: &str,
    port: u16,
    share: &str,
    subpath: &str,
    files: &[FileEntry],
    total_files: u32,
    total_bytes: u64,
    login: &str,
    password: &str,
    cancel: UploadCancelPolicy,
    progress: UploadProgressGate<F>,
) -> UploadResult {
    // OPT-22C: one writing pipeline per host (Upload ↔ Backup ↔ GC).
    // Guard drops on every return path (success / cancel / fail).
    let _host_lock = host_lock::acquire(host).await;

    // Never block a new upload on leftover GC — run in background.
    // GC acquires the same host lock → waits until this transfer finishes.
    spawn_smb_staging_gc(login, password);

    // OPT-22B B3: upload owns its session — drop any Health/GC pool entry first.
    session_pool::invalidate(host, port, share, login).await;

    let mut client = match connect_smb(host, port, login, password, SMB_CONNECT_TIMEOUT).await {
        Ok(c) => c,
        Err(e) => return UploadResult::fail(e),
    };

    let mut tree = match client.connect_share(share).await {
        Ok(t) => t,
        Err(e) => return UploadResult::fail(map_smb_error(&e.to_string(), share)),
    };

    let job_name = job_top_name(files);
    let staging_id = uuid::Uuid::new_v4().to_string();
    let staging_root = staging_prefix(subpath, &staging_id);
    let write_root = staging_root.clone();

    let mut created_dirs = std::collections::HashSet::<String>::new();
    if let Err(e) = ensure_remote_dirs(&mut client, &mut tree, &write_root, &mut created_dirs).await
    {
        return UploadResult::fail(e);
    }

    let phases = partition_upload_phases(files);

    // Create every parent directory before any parallel write (no races on mkdir).
    for file in phases.ordered() {
        if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
            session_pool::disconnect_owned(client, tree).await;
            session_pool::invalidate(host, port, share, login).await;
            schedule_staging_gc(host, port, share, &staging_root, login, password);
            return cancelled.with_staging(Some(staging_root));
        }
        let remote_rel = join_smb_path(&write_root, &file.relative);
        if let Some(parent) = Path::new(&remote_rel).parent() {
            let parent_str = parent.to_string_lossy().replace('\\', "/");
            if !parent_str.is_empty() && parent_str != "." {
                if let Err(e) =
                    ensure_remote_dirs(&mut client, &mut tree, &parent_str, &mut created_dirs).await
                {
                    session_pool::disconnect_owned(client, tree).await;
                    session_pool::invalidate(host, port, share, login).await;
                    schedule_staging_gc(host, port, share, &staging_root, login, password);
                    return UploadResult::fail(e).with_staging(Some(staging_root));
                }
            }
        }
    }

    let progress = Arc::new(Mutex::new(progress));
    let client = Arc::new(AsyncMutex::new(client));
    let tree = Arc::new(tree);

    let media_remotes: Vec<String> = phases
        .media
        .iter()
        .map(|f| join_smb_path(&write_root, &f.relative))
        .collect();

    let mut copied_bytes = match upload_smb_media_parallel(
        Arc::clone(&client),
        Arc::clone(&tree),
        &phases.media,
        &media_remotes,
        total_files,
        total_bytes,
        Arc::clone(&progress),
        0,
        cancel,
    )
    .await
    {
        Ok(b) => b,
        Err(e) => {
            return abandon_smb_staging(
                e,
                cancel,
                progress,
                tree,
                client,
                host,
                port,
                share,
                &staging_root,
                login,
                password,
            )
            .await;
        }
    };

    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        return abandon_smb_staging(
            cancelled,
            cancel,
            progress,
            tree,
            client,
            host,
            port,
            share,
            &staging_root,
            login,
            password,
        )
        .await;
    }

    // Barrier: media fully flushed before commit files.
    let commit_start_index = phases.media.len() as u32;
    if let Some(manifest) = &phases.manifest {
        let file_index = commit_start_index + 1;
        match upload_smb_one(
            client.as_ref(),
            tree.as_ref(),
            manifest,
            &join_smb_path(&write_root, &manifest.relative),
            file_index,
            total_files,
            total_bytes,
            copied_bytes,
            &progress,
            false,
            cancel,
        )
        .await
        {
            Ok(b) => copied_bytes = b,
            Err(e) => {
                return abandon_smb_staging(
                    e,
                    cancel,
                    progress,
                    tree,
                    client,
                    host,
                    port,
                    share,
                    &staging_root,
                    login,
                    password,
                )
                .await;
            }
        }
    }

    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        return abandon_smb_staging(
            cancelled,
            cancel,
            progress,
            tree,
            client,
            host,
            port,
            share,
            &staging_root,
            login,
            password,
        )
        .await;
    }

    if let Some(marker) = &phases.marker {
        let file_index = phases.total_files();
        match upload_smb_one(
            client.as_ref(),
            tree.as_ref(),
            marker,
            &join_smb_path(&write_root, &marker.relative),
            file_index,
            total_files,
            total_bytes,
            copied_bytes,
            &progress,
            true,
            cancel,
        )
        .await
        {
            Ok(b) => copied_bytes = b,
            Err(e) => {
                return abandon_smb_staging(
                    e,
                    cancel,
                    progress,
                    tree,
                    client,
                    host,
                    port,
                    share,
                    &staging_root,
                    login,
                    password,
                )
                .await;
            }
        }
    }

    let _ = copied_bytes;
    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        return abandon_smb_staging(
            cancelled,
            cancel,
            progress,
            tree,
            client,
            host,
            port,
            share,
            &staging_root,
            login,
            password,
        )
        .await;
    }

    if let Ok(mut gate) = progress.lock() {
        gate.emit(
            100.0,
            total_files,
            total_files,
            total_bytes,
            total_bytes,
            "",
            true,
        );
    }
    drop(progress);

    // Promote staging job folder → final name (same share).
    let staged_job = join_smb_path(&staging_root, &job_name);
    let final_job = join_smb_path(subpath, &job_name);

    let mut client = match Arc::try_unwrap(client).map(AsyncMutex::into_inner) {
        Ok(c) => c,
        Err(_) => {
            drop(tree);
            schedule_staging_gc(host, port, share, &staging_root, login, password);
            return UploadResult::fail(
                "Upload-Session konnte für Promote nicht exklusiv übernommen werden",
            )
            .with_staging(Some(staging_root));
        }
    };
    let mut tree = match Arc::try_unwrap(tree) {
        Ok(t) => t,
        Err(_) => {
            drop(client);
            schedule_staging_gc(host, port, share, &staging_root, login, password);
            return UploadResult::fail(
                "Upload-Tree konnte für Promote nicht exklusiv übernommen werden",
            )
            .with_staging(Some(staging_root));
        }
    };

    if remote_job_presence(&mut client, &mut tree, &final_job).await == RemotePresence::Present {
        session_pool::disconnect_owned(client, tree).await;
        session_pool::invalidate(host, port, share, login).await;
        schedule_staging_gc(host, port, share, &staging_root, login, password);
        return UploadResult::fail(remote_conflict::remote_job_exists_message())
            .with_staging(Some(staging_root));
    }

    if let Err(e) = client.rename(&mut tree, &staged_job, &final_job).await {
        let msg = e.to_string();
        session_pool::disconnect_owned(client, tree).await;
        session_pool::invalidate(host, port, share, login).await;
        schedule_staging_gc(host, port, share, &staging_root, login, password);
        let message = if remote_conflict::is_remote_job_exists_message(&msg) {
            remote_conflict::remote_job_exists_message()
        } else {
            format!("Staging-Promote fehlgeschlagen: {msg}")
        };
        return UploadResult::fail(message).with_staging(Some(staging_root));
    }

    // Best-effort remove empty `.ats_staging/<id>` parent.
    let _ = client.delete_directory(&mut tree, &staging_root).await;
    // OPT-22B B6: disconnect_share before Drop (symmetry with cancel path).
    session_pool::disconnect_owned(client, tree).await;
    session_pool::invalidate(host, port, share, login).await;

    let remote = display_remote(
        &ServerTarget::Smb {
            host: host.to_string(),
            port,
            share: share.to_string(),
            subpath: subpath.to_string(),
        },
        &job_name,
    );

    UploadResult::ok(format!("Erfolgreich auf Server kopiert: {remote}"), remote)
}

async fn upload_smb_one<F: FnMut(UploadProgress) + Send>(
    client: &AsyncMutex<SmbClient>,
    tree: &smb2::client::Tree,
    file: &FileEntry,
    remote_rel: &str,
    file_index: u32,
    total_files: u32,
    total_bytes: u64,
    bytes_before: u64,
    progress: &Arc<Mutex<UploadProgressGate<F>>>,
    allow_100: bool,
    cancel: UploadCancelPolicy,
) -> Result<u64, UploadResult> {
    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        return Err(cancelled);
    }

    let filename = file
        .absolute
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    // `file_index` is the completed count after this file finishes.
    let completed_before = file_index.saturating_sub(1);
    match stream_upload_file(
        client,
        tree,
        &file.absolute,
        remote_rel,
        cancel,
        |copied_in_file| {
            let current = bytes_before + copied_in_file;
            let mut percent = if total_bytes > 0 {
                (current as f64 / total_bytes as f64) * 100.0
            } else {
                (completed_before as f64 / total_files.max(1) as f64) * 100.0
            };
            if !allow_100 {
                percent = percent.min(99.9);
            }
            if let Ok(mut gate) = progress.lock() {
                gate.emit(
                    percent,
                    completed_before,
                    total_files,
                    current,
                    total_bytes,
                    &filename,
                    false,
                );
            }
        },
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            let message = if e == WORKFLOW_CANCELLED {
                WORKFLOW_CANCELLED.into()
            } else {
                format!("Upload fehlgeschlagen ({}): {e}", file.relative)
            };
            return Err(UploadResult::fail(message));
        }
    }

    let copied_bytes = bytes_before + file.size;
    let percent = if total_bytes > 0 {
        (copied_bytes as f64 / total_bytes as f64) * 100.0
    } else {
        (file_index as f64 / total_files.max(1) as f64) * 100.0
    };
    if let Ok(mut gate) = progress.lock() {
        gate.emit(
            percent,
            file_index,
            total_files,
            copied_bytes,
            total_bytes,
            &filename,
            true,
        );
    }
    Ok(copied_bytes)
}

async fn ensure_remote_dirs(
    client: &mut SmbClient,
    tree: &mut smb2::client::Tree,
    path: &str,
    created: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    let mut cumulative = String::new();
    for part in path.replace('\\', "/").split('/').filter(|p| !p.is_empty()) {
        if cumulative.is_empty() {
            cumulative = part.to_string();
        } else {
            cumulative = format!("{cumulative}/{part}");
        }
        if created.contains(&cumulative) {
            continue;
        }
        match client.create_directory(tree, &cumulative).await {
            Ok(()) => {
                created.insert(cumulative.clone());
            }
            Err(e) => {
                let msg = e.to_string().to_lowercase();
                // Already exists is fine
                if msg.contains("already")
                    || msg.contains("exists")
                    || msg.contains("object_name_collision")
                    || msg.contains("collision")
                {
                    created.insert(cumulative.clone());
                } else {
                    // Directory may already exist — try listing to confirm
                    match client.list_directory(tree, &cumulative).await {
                        Ok(_) => {
                            created.insert(cumulative.clone());
                        }
                        Err(_) => {
                            return Err(format!(
                                "Kann Remote-Ordner nicht erstellen ({cumulative}): {e}"
                            ));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// Poll until the upload cancel flag is set (or return immediately if already set).
async fn wait_until_upload_cancelled(cancel: UploadCancelPolicy) {
    loop {
        if is_upload_cancelled(cancel) {
            return;
        }
        tokio::time::sleep(WRITE_CANCEL_POLL).await;
    }
}

/// Best-effort `FileWriter::abort` with a hard timeout.
///
/// A hung abort (desynced in-flight WRITEs after cancelling `write_chunk`) used
/// to block cooperative cancel for 15s until JoinSet force-abort leaked handles.
/// Timing out drops the writer; the upload session is torn down right after.
async fn abort_writer_bounded(writer: FileWriter) {
    tokio::select! {
        _ = writer.abort() => {}
        _ = tokio::time::sleep(WRITER_ABORT_TIMEOUT) => {
            // abort() future dropped → FileWriter Drop without CLOSE; OK because
            // release_smb_session_for_cleanup kills the TCP session next.
        }
    }
}

/// Write one chunk, but bail within ~50ms of a cancel request so `FileWriter::abort`
/// can run instead of waiting out a multi-second SMB write.
async fn write_chunk_unless_cancelled(
    writer: &mut FileWriter,
    chunk: &[u8],
    cancel: UploadCancelPolicy,
) -> Result<(), String> {
    if is_upload_cancelled(cancel) {
        return Err(WORKFLOW_CANCELLED.into());
    }
    tokio::select! {
        biased;
        result = writer.write_chunk(chunk) => {
            result.map_err(|e| e.to_string())
        }
        _ = wait_until_upload_cancelled(cancel) => {
            Err(WORKFLOW_CANCELLED.into())
        }
    }
}

/// The client lock is held only while opening; the returned writer streams
/// without it, so parallel workers still upload concurrently.
pub(crate) async fn stream_upload_file(
    client: &AsyncMutex<SmbClient>,
    tree: &smb2::client::Tree,
    local: &Path,
    remote: &str,
    cancel: UploadCancelPolicy,
    mut on_chunk: impl FnMut(u64),
) -> Result<u64, String> {
    let mut writer = client
        .lock()
        .await
        .create_file_writer(tree, remote)
        .await
        .map_err(|e| e.to_string())?;

    let file_size = fs::metadata(local).map(|m| m.len()).unwrap_or(0);
    // Inline whole-file read for typical JPGs so disk IO stays off the async pool.
    const INLINE_READ_MAX: u64 = 8 * 1024 * 1024;

    if file_size > 0 && file_size <= INLINE_READ_MAX {
        let path = local.to_path_buf();
        let data = match tauri::async_runtime::spawn_blocking(move || fs::read(path)).await {
            Ok(Ok(data)) => data,
            Ok(Err(e)) => {
                abort_writer_bounded(writer).await;
                return Err(e.to_string());
            }
            Err(e) => {
                abort_writer_bounded(writer).await;
                return Err(e.to_string());
            }
        };
        if is_upload_cancelled(cancel) {
            abort_writer_bounded(writer).await;
            return Err(WORKFLOW_CANCELLED.into());
        }
        let mut offset = 0usize;
        while offset < data.len() {
            if is_upload_cancelled(cancel) {
                abort_writer_bounded(writer).await;
                return Err(WORKFLOW_CANCELLED.into());
            }
            let end = (offset + CHUNK_SIZE).min(data.len());
            if let Err(e) =
                write_chunk_unless_cancelled(&mut writer, &data[offset..end], cancel).await
            {
                abort_writer_bounded(writer).await;
                return Err(e);
            }
            offset = end;
            on_chunk(offset as u64);
        }
        return writer.finish().await.map_err(|e| e.to_string());
    }

    // Large files: dedicated reader thread → async writer (no sync disk on async workers).
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(2);
    let path = local.to_path_buf();
    let reader = tauri::async_runtime::spawn_blocking(move || {
        let mut input = File::open(&path).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            if is_upload_cancelled(cancel) {
                let _ = tx.blocking_send(Err(WORKFLOW_CANCELLED.into()));
                return Ok::<(), String>(());
            }
            let n = input.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            if tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                break;
            }
        }
        Ok(())
    });

    let mut copied = 0u64;
    while let Some(chunk) = rx.recv().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = reader.await;
                abort_writer_bounded(writer).await;
                return Err(e);
            }
        };
        if is_upload_cancelled(cancel) {
            let _ = reader.await;
            abort_writer_bounded(writer).await;
            return Err(WORKFLOW_CANCELLED.into());
        }
        if let Err(e) = write_chunk_unless_cancelled(&mut writer, &chunk, cancel).await {
            let _ = reader.await;
            abort_writer_bounded(writer).await;
            return Err(e);
        }
        copied += chunk.len() as u64;
        on_chunk(copied);
    }

    match reader.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            abort_writer_bounded(writer).await;
            return Err(e);
        }
        Err(e) => {
            abort_writer_bounded(writer).await;
            if is_upload_cancelled(cancel) {
                return Err(WORKFLOW_CANCELLED.into());
            }
            return Err(format!("Disk-Read fehlgeschlagen: {e}"));
        }
    }

    writer.finish().await.map_err(|e| e.to_string())
}

/// Public helper for abort path: delete a share-relative staging root.
pub async fn cleanup_staging_path(
    server_url: &str,
    login: &str,
    password: &str,
    auto_mount_enabled: bool,
    staging_root: &str,
) -> Result<(), String> {
    let target = resolve_server_target(
        server_url,
        Some(AutoMountParams {
            enabled: auto_mount_enabled,
            login,
            password,
        }),
    )?;
    match target {
        ServerTarget::Local { path } => {
            let top = path.join(staging_root.replace('/', std::path::MAIN_SEPARATOR_STR));
            if top.is_dir() {
                fs::remove_dir_all(&top).map_err(|e| e.to_string())?;
            } else if top.is_file() {
                let _ = fs::remove_file(&top);
            }
            Ok(())
        }
        ServerTarget::Smb {
            host, port, share, ..
        } => {
            cleanup_smb_remote_tree(&host, port, &share, login, password, staging_root, true, 1)
                .await?;
            dequeue_staging_gc(&host, port, &share, staging_root);
            Ok(())
        }
    }
}

/// Removal of a partial upload tree on the configured server.
///
/// Deletes the **job root** (folder name of `local_path`) under the share
/// target — recursive list/delete, not one SMB call per local file. That
/// also removes remote leftovers that are no longer in the local tree.
///
/// SMB deletes are retried: cancelled parallel writers can briefly leave
/// sharing-violation locks until the upload session fully tears down.
pub async fn cleanup_remote_upload_folder(
    local_path: &Path,
    server_url: &str,
    login: &str,
    password: &str,
    auto_mount_enabled: bool,
) -> Result<(), String> {
    let target = resolve_server_target(
        server_url,
        Some(AutoMountParams {
            enabled: auto_mount_enabled,
            login,
            password,
        }),
    )?;
    let job_name = local_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Kein Upload-Ziel zum Aufräumen".to_string())?;

    match target {
        ServerTarget::Local { path } => cleanup_local_job_root(&path, &job_name),
        ServerTarget::Smb {
            host,
            port,
            share,
            subpath,
        } => cleanup_smb_job_root(&host, port, &share, &subpath, login, password, &job_name).await,
    }
}

fn cleanup_local_job_root(dest_root: &Path, job_name: &str) -> Result<(), String> {
    let top = dest_root.join(job_name);
    if top.is_dir() {
        fs::remove_dir_all(&top).map_err(|e| format!("Remote-Ordner löschen: {e}"))?;
    } else if top.is_file() {
        let _ = fs::remove_file(&top);
    }
    Ok(())
}

fn smb_path_not_found(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("not_found")
        || e.contains("no_such_file")
        || e.contains("no such file")
        || e.contains("object_name_not_found")
        || e.contains("object_path_not_found")
        || e.contains("path_not_found")
        || e.contains("does not exist")
}

fn smb_sharing_violation(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("sharing_violation") || e.contains("directory_not_empty")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RemotePresence {
    Present,
    Absent,
    Unknown,
}

async fn remote_job_presence(
    client: &mut SmbClient,
    tree: &mut smb2::client::Tree,
    path: &str,
) -> RemotePresence {
    match client.list_directory(tree, path).await {
        Ok(_) => RemotePresence::Present,
        Err(e) if smb_path_not_found(&e.to_string()) => RemotePresence::Absent,
        Err(_) => RemotePresence::Unknown,
    }
}

const REMOTE_SNAPSHOT_MAX_FILES: usize = 8000;
const REMOTE_SNAPSHOT_MAX_DEPTH: usize = 16;

#[derive(Debug, Clone)]
pub(crate) struct RemoteJobSnapshot {
    pub folder_present: bool,
    pub listed: bool,
    pub truncated: bool,
    pub has_fertig: bool,
    pub has_processing: bool,
    pub relative_files: Vec<String>,
}

struct RemoteListAcc {
    folder_present: bool,
    listed: bool,
    truncated: bool,
    has_fertig: bool,
    has_processing: bool,
    files: Vec<String>,
}

impl RemoteListAcc {
    fn new() -> Self {
        Self {
            folder_present: true,
            listed: true,
            truncated: false,
            has_fertig: false,
            has_processing: false,
            files: Vec::new(),
        }
    }

    fn into_snapshot(self) -> RemoteJobSnapshot {
        let listed = if self.folder_present { self.listed } else { true };
        RemoteJobSnapshot {
            folder_present: self.folder_present,
            listed,
            truncated: self.truncated,
            has_fertig: self.has_fertig,
            has_processing: self.has_processing,
            relative_files: self.files,
        }
    }
}

/// List the configured destination job folder (local map or smb2).
pub(crate) async fn snapshot_upload_destination(
    server_url: &str,
    login: &str,
    password: &str,
    auto_mount_enabled: bool,
    local_job: &Path,
) -> Result<RemoteJobSnapshot, String> {
    let job_name = local_job
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Kein Job-Ordnername".to_string())?;
    let target = resolve_server_target_blocking(server_url, auto_mount_enabled, login, password)
        .await?;
    match target {
        ServerTarget::Local { path } => Ok(snapshot_local_job(&path, &job_name)),
        ServerTarget::Smb {
            host,
            port,
            share,
            subpath,
        } => snapshot_smb_job(&host, port, &share, &subpath, login, password, &job_name).await,
    }
}

fn snapshot_local_job(dest_root: &Path, job_name: &str) -> RemoteJobSnapshot {
    let top = dest_root.join(job_name);
    if !top.exists() {
        let mut acc = RemoteListAcc::new();
        acc.folder_present = false;
        return acc.into_snapshot();
    }
    if !top.is_dir() {
        let mut acc = RemoteListAcc::new();
        acc.listed = false;
        return acc.into_snapshot();
    }
    let mut acc = RemoteListAcc::new();
    walk_local_job(&top, "", 0, &mut acc);
    acc.into_snapshot()
}

fn walk_local_job(dir: &Path, prefix: &str, depth: usize, acc: &mut RemoteListAcc) {
    if acc.truncated || !acc.listed {
        return;
    }
    if depth > REMOTE_SNAPSHOT_MAX_DEPTH {
        acc.truncated = true;
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => {
            acc.listed = false;
            return;
        }
    };
    for ent in rd.flatten() {
        if acc.truncated || !acc.listed {
            return;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if name.eq_ignore_ascii_case(".ams-handoff") {
                continue;
            }
            walk_local_job(&ent.path(), &rel, depth + 1, acc);
        } else {
            note_root_marker(prefix, &name, acc);
            acc.files.push(rel);
            if acc.files.len() >= REMOTE_SNAPSHOT_MAX_FILES {
                acc.truncated = true;
                return;
            }
        }
    }
}

fn note_root_marker(prefix: &str, name: &str, acc: &mut RemoteListAcc) {
    if !prefix.is_empty() {
        return;
    }
    if name.eq_ignore_ascii_case(remote_conflict::MARKER_FERTIG) {
        acc.has_fertig = true;
    } else if name.eq_ignore_ascii_case(remote_conflict::MARKER_PROCESSING) {
        acc.has_processing = true;
    }
}

async fn snapshot_smb_job(
    host: &str,
    port: u16,
    share: &str,
    subpath: &str,
    login: &str,
    password: &str,
    job_name: &str,
) -> Result<RemoteJobSnapshot, String> {
    let _host_lock = host_lock::acquire(host).await;
    let mut pooled =
        session_pool::acquire(host, port, share, login, password, SMB_CONNECT_TIMEOUT).await?;
    let job_root = join_smb_path(subpath, job_name);
    let mut acc = RemoteListAcc::new();
    {
        let (client, tree) = pooled.parts_mut();
        walk_smb_job(client, tree, &job_root, "", 0, &mut acc).await;
    }
    pooled.release().await;
    Ok(acc.into_snapshot())
}

fn walk_smb_job<'a>(
    client: &'a mut SmbClient,
    tree: &'a mut smb2::client::Tree,
    path: &'a str,
    prefix: &'a str,
    depth: usize,
    acc: &'a mut RemoteListAcc,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        if acc.truncated || !acc.listed {
            return;
        }
        if depth > REMOTE_SNAPSHOT_MAX_DEPTH {
            acc.truncated = true;
            return;
        }
        let entries = match client.list_directory(tree, path).await {
            Ok(entries) => entries,
            Err(e) => {
                if prefix.is_empty() && smb_path_not_found(&e.to_string()) {
                    acc.folder_present = false;
                } else {
                    acc.listed = false;
                }
                return;
            }
        };
        for entry in entries {
            if acc.truncated || !acc.listed {
                return;
            }
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            let rel = if prefix.is_empty() {
                entry.name.clone()
            } else {
                format!("{prefix}/{}", entry.name)
            };
            if entry.is_directory {
                if entry.name.eq_ignore_ascii_case(".ams-handoff") {
                    continue;
                }
                let child = format!("{path}/{}", entry.name);
                walk_smb_job(client, tree, &child, &rel, depth + 1, acc).await;
            } else {
                note_root_marker(prefix, &entry.name, acc);
                acc.files.push(rel);
                if acc.files.len() >= REMOTE_SNAPSHOT_MAX_FILES {
                    acc.truncated = true;
                    return;
                }
            }
        }
    })
}

async fn cleanup_smb_job_root(
    host: &str,
    port: u16,
    share: &str,
    subpath: &str,
    login: &str,
    password: &str,
    job_name: &str,
) -> Result<(), String> {
    let job_root = join_smb_path(subpath, job_name);
    // Final job cleanup: few quick attempts (legacy / promote race). Staging uses schedule_staging_gc.
    cleanup_smb_remote_tree(host, port, share, login, password, &job_root, false, 2).await
}

/// Delete an arbitrary share-relative path (job root or `.ats_staging/<id>`).
///
/// When `already_paused` is true, skips the initial session-teardown sleep
/// (caller already waited after dropping the upload session).
/// `max_attempts` caps reconnect/delete rounds (use 1 on hot paths).
/// OPT-22B: uses the smb2 session pool so GC rounds reuse a warm session.
/// OPT-22C: waits for the host transfer mutex before any pool connect.
async fn cleanup_smb_remote_tree(
    host: &str,
    port: u16,
    share: &str,
    login: &str,
    password: &str,
    remote_root: &str,
    already_paused: bool,
    max_attempts: u32,
) -> Result<(), String> {
    if remote_root.is_empty() {
        return Err("Leerer Cleanup-Pfad".into());
    }

    // Do not open a GC/cleanup session while Upload/Backup holds the host.
    let _host_lock = host_lock::acquire(host).await;

    if !already_paused {
        tokio::time::sleep(SESSION_TEARDOWN_PAUSE).await;
    }

    let attempts = max_attempts.max(1);
    let mut last_err: Option<String> = None;
    for attempt in 1..=attempts {
        let mut pooled =
            session_pool::acquire(host, port, share, login, password, SMB_CONNECT_TIMEOUT).await?;

        let delete_result = {
            let (client, tree) = pooled.parts_mut();
            delete_smb_tree_recursive(client, tree, remote_root).await
        };

        match delete_result {
            Ok(()) => {
                let gone = {
                    let (client, tree) = pooled.parts_mut();
                    smb_remote_gone(client, tree, remote_root).await
                };
                if gone {
                    pooled.release().await;
                    return Ok(());
                }
                last_err = Some(format!(
                    "Remote-Ordner noch vorhanden nach Löschen: {remote_root}"
                ));
                pooled.release().await;
            }
            Err(e) => {
                let sharing = smb_sharing_violation(&e);
                let reject = quiet_budget::is_session_rejected(&e);
                if reject || e.to_ascii_lowercase().contains("protocol error") {
                    session_pool::discard_on_error(pooled, &e).await;
                } else {
                    // Sharing-violation: keep pool warm for the next retry round.
                    pooled.release().await;
                }
                last_err = Some(e);
                if attempt < attempts {
                    let backoff_ms = if sharing {
                        400 * u64::from(attempt)
                    } else {
                        250 * u64::from(attempt)
                    };
                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                }
                continue;
            }
        }
        let retry_sharing = last_err.as_deref().is_some_and(smb_sharing_violation);
        if attempt < attempts {
            let backoff_ms = if retry_sharing {
                400 * u64::from(attempt)
            } else {
                250 * u64::from(attempt)
            };
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        }
    }
    Err(last_err.unwrap_or_else(|| format!("Aufräumen fehlgeschlagen: {remote_root}")))
}

/// Process due deferred staging GC entries (fresh connections, credentials from caller).
///
/// One attempt per due entry — failures stay queued with backoff (see `record_gc_attempt`).
pub async fn drain_smb_staging_gc(login: &str, password: &str) -> usize {
    let due = list_due_staging_gc();
    if due.is_empty() {
        return 0;
    }
    let mut cleared = 0usize;
    for entry in due {
        match cleanup_smb_remote_tree(
            &entry.host,
            entry.port,
            &entry.share,
            login,
            password,
            &entry.staging_root,
            true,
            1,
        )
        .await
        {
            Ok(()) => {
                record_gc_attempt(
                    &entry.host,
                    entry.port,
                    &entry.share,
                    &entry.staging_root,
                    true,
                );
                cleared += 1;
                health_event::publish(
                    true,
                    &entry.host,
                    &entry.share,
                    health_event::SMB_HEALTH_OK_MESSAGE,
                );
                crate::storage::logging::info(
                    "smb",
                    format!("Staging-GC OK: {}", entry.staging_root),
                );
            }
            Err(e) => {
                record_gc_attempt(
                    &entry.host,
                    entry.port,
                    &entry.share,
                    &entry.staging_root,
                    false,
                );
                health_event::publish_gc(&entry.host, &entry.share, &Err(e.clone()));
                crate::storage::logging::warn(
                    "smb",
                    format!(
                        "Staging-GC Versuch fehlgeschlagen ({}): {}",
                        entry.staging_root,
                        shorten_smb_err(&e)
                    ),
                );
            }
        }
    }
    cleared
}

async fn smb_remote_gone(
    client: &mut SmbClient,
    tree: &mut smb2::client::Tree,
    path: &str,
) -> bool {
    match client.list_directory(tree, path).await {
        Ok(_) => false,
        Err(e) => smb_path_not_found(&e.to_string()),
    }
}

/// Recursively delete a remote directory (or a single file) under `path`.
///
/// Returns `Err` when the tree could not be cleared (callers retry). Individual
/// "not found" races are treated as success.
fn delete_smb_tree_recursive<'a>(
    client: &'a mut SmbClient,
    tree: &'a mut smb2::client::Tree,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if path.is_empty() {
            return Err("Leerer Cleanup-Pfad".into());
        }
        match client.list_directory(tree, path).await {
            Ok(entries) => {
                let mut errors: Vec<String> = Vec::new();
                for entry in entries {
                    if entry.name == "." || entry.name == ".." {
                        continue;
                    }
                    let child = format!("{path}/{}", entry.name);
                    if entry.is_directory {
                        if let Err(e) = delete_smb_tree_recursive(client, tree, &child).await {
                            errors.push(e);
                        }
                    } else if let Err(e) = client.delete_file(tree, &child).await {
                        let msg = e.to_string();
                        if !smb_path_not_found(&msg) {
                            errors.push(format!("{child}: {msg}"));
                        }
                    }
                }
                match client.delete_directory(tree, path).await {
                    Ok(()) => {}
                    Err(e) => {
                        let msg = e.to_string();
                        if !smb_path_not_found(&msg) {
                            errors.push(format!("{path} (dir): {msg}"));
                        }
                    }
                }
                if errors.is_empty() {
                    Ok(())
                } else {
                    Err(errors.join("; "))
                }
            }
            Err(list_err) => {
                let list_msg = list_err.to_string();
                if smb_path_not_found(&list_msg) {
                    return Ok(());
                }
                // list failed for another reason — try directory then file delete.
                match client.delete_directory(tree, path).await {
                    Ok(()) => return Ok(()),
                    Err(e) if smb_path_not_found(&e.to_string()) => return Ok(()),
                    Err(dir_err) => match client.delete_file(tree, path).await {
                        Ok(()) => Ok(()),
                        Err(e) if smb_path_not_found(&e.to_string()) => Ok(()),
                        Err(file_err) => Err(format!(
                            "{path}: list={list_msg}; dir={dir_err}; file={file_err}"
                        )),
                    },
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::ffmpeg::cancel_test_lock;

    /// Serializes tests that touch the global cancel flag / upload_local.
    fn upload_test_lock() -> std::sync::MutexGuard<'static, ()> {
        cancel_test_lock()
    }

    #[test]
    fn normalize_smb_url() {
        let n = normalize_server_path("smb://169.254.169.254/aktuell").unwrap();
        assert!(n.is_network);
        assert!(n.was_smb_url);
        assert_eq!(n.path, r"\\169.254.169.254\aktuell");
    }

    #[test]
    fn normalize_unc() {
        let n = normalize_server_path(r"\\server\share\sub").unwrap();
        assert!(n.is_network);
        assert!(!n.was_smb_url);
        assert_eq!(n.path, r"\\server\share\sub");
    }

    #[test]
    fn normalize_unix_style_unc() {
        let n = normalize_server_path("//server/share").unwrap();
        assert!(n.is_network);
        assert_eq!(n.path, r"\\server\share");
    }

    #[test]
    fn normalize_local_windows() {
        let n = normalize_server_path(r"C:\tmp\upload").unwrap();
        assert!(!n.is_network);
        assert_eq!(n.path, r"C:\tmp\upload");
    }

    #[test]
    fn normalize_empty() {
        assert!(normalize_server_path("").is_none());
        assert!(normalize_server_path("   ").is_none());
    }

    #[test]
    fn parse_smb_with_subpath() {
        let t = parse_server_target("smb://nas.local/videos/2024/june").unwrap();
        match t {
            ServerTarget::Smb {
                host,
                port,
                share,
                subpath,
            } => {
                assert_eq!(host, "nas.local");
                assert_eq!(port, 445);
                assert_eq!(share, "videos");
                assert_eq!(subpath, "2024/june");
            }
            _ => panic!("expected SMB"),
        }
    }

    #[test]
    fn parse_host_with_port() {
        let t = parse_server_target("smb://192.168.1.10:1445/share").unwrap();
        match t {
            ServerTarget::Smb {
                host, port, share, ..
            } => {
                assert_eq!(host, "192.168.1.10");
                assert_eq!(port, 1445);
                assert_eq!(share, "share");
            }
            _ => panic!("expected SMB"),
        }
    }

    #[test]
    fn parse_local() {
        let t = parse_server_target(r"D:\out").unwrap();
        match t {
            ServerTarget::Local { path } => assert_eq!(path, PathBuf::from(r"D:\out")),
            _ => panic!("expected local"),
        }
    }

    #[test]
    fn sanitize_strips_invalid() {
        assert_eq!(sanitize_filename(r#"a<b>c:d"e/f\g|h?i*j"#), "abcdefghij");
        assert_eq!(sanitize_filename("  ok  "), "ok");
    }

    #[test]
    fn join_smb_path_cases() {
        assert_eq!(join_smb_path("", "a/b"), "a/b");
        assert_eq!(join_smb_path("base", ""), "base");
        assert_eq!(join_smb_path("base", "a/b"), "base/a/b");
        assert_eq!(join_smb_path(r"base\x", r"y\z"), "base/x/y/z");
    }

    #[test]
    fn normalize_smb_url_with_embedded_user() {
        let n = normalize_server_path("smb://ops@169.254.169.254/aktuell").unwrap();
        assert!(n.is_network);
        assert_eq!(n.path, r"\\169.254.169.254\aktuell");
    }

    #[test]
    fn normalize_local_unix_path() {
        let n = normalize_server_path("/Users/shared/upload").unwrap();
        assert!(!n.is_network);
        assert_eq!(n.path, "/Users/shared/upload");
    }

    #[test]
    fn parse_local_unix() {
        let t = parse_server_target("/tmp/out").unwrap();
        match t {
            ServerTarget::Local { path } => assert_eq!(path, PathBuf::from("/tmp/out")),
            _ => panic!("expected local"),
        }
    }

    /// Without a matching OS map/mount (CI / no net use / no Finder mount), resolve == parse.
    #[test]
    fn resolve_without_map_stays_smb() {
        let url = "smb://opt17-no-such-host.invalid/share/sub";
        let parsed = parse_server_target(url).unwrap();
        let resolved = resolve_server_target(url, None).unwrap();
        // Live maps to this fake host are extremely unlikely; equal to parse.
        assert_eq!(resolved, parsed);
        assert!(matches!(resolved, ServerTarget::Smb { .. }));
    }

    #[test]
    fn apply_mapping_leaves_explicit_local() {
        let local = ServerTarget::Local {
            path: PathBuf::from(r"D:\out"),
        };
        assert_eq!(apply_os_smb_mapping(local.clone(), None), local);
    }

    #[test]
    fn missing_under_root_health_stays_local() {
        let tmp = tempfile::tempdir().unwrap();
        let child = tmp.path().join("jobs").join("neu");
        let outcome = reconnect::classify_mapped_path(tmp.path(), &child);
        assert_eq!(outcome, ProbeOutcome::Missing);
        assert!(outcome.prefers_local());
        let health = local_health_result(&child, outcome, false);
        assert!(health.ok);
        assert!(!health.soft_hold);
        assert!(health.message.contains("Zielordner fehlt, wird angelegt"));
    }

    #[test]
    fn denied_health_is_explicit_and_not_soft_hold() {
        let health = local_health_result(Path::new(r"Z:\jobs"), ProbeOutcome::Denied, true);
        assert!(!health.ok);
        assert!(!health.soft_hold);
        assert!(health.message.contains("Zugriff verweigert"));
    }

    fn tcp_probe_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn quiet_tcp_probe_open_port_is_ok() {
        use std::net::TcpListener;
        let _guard = tcp_probe_test_lock();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let health = quiet_tcp_health_result(
            "127.0.0.1",
            "opt23e-open",
            probe_smb_tcp_blocking("127.0.0.1", port),
        );
        assert!(health.ok, "{}", health.message);
        assert!(!health.soft_hold);
        assert_eq!(health.message, QUIET_TCP_OK_MESSAGE);
        drop(listener);
    }

    #[test]
    fn quiet_tcp_probe_closed_port_is_unreachable() {
        use std::net::TcpListener;
        let _guard = tcp_probe_test_lock();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let health = quiet_tcp_health_result(
            "127.0.0.1",
            "opt23e-closed",
            probe_smb_tcp_blocking("127.0.0.1", port),
        );
        assert!(!health.ok, "{}", health.message);
        assert!(!health.soft_hold);
        assert!(
            health.message.contains("nicht erreichbar") || health.message.contains("abgelehnt"),
            "{}",
            health.message
        );
    }

    #[test]
    fn quiet_tcp_ok_does_not_clear_sticky_auth_failure() {
        let host = format!(
            "opt23e-sticky-{}.invalid",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let share = "videos";
        let auth = "Verbindung fehlgeschlagen: Ungültiger Benutzername oder Passwort.";
        quiet_budget::clear_loud_auth_failure(&host, share);
        quiet_budget::note_loud_auth_failure(&host, share, auth);
        let unc = format!(r"\\{host}\{share}");
        assert!(
            quiet_budget::should_skip_quiet_smb2(&unc).is_none(),
            "TCP probe must not arm SessionSetup backoff"
        );
        let health = quiet_tcp_health_result(&host, share, Ok(()));
        assert!(!health.ok);
        assert!(health.soft_hold);
        assert!(health.message.contains("Benutzername oder Passwort"));
        assert!(quiet_budget::should_skip_quiet_smb2(&unc).is_none());
        assert!(quiet_budget::loud_auth_failure(&host, share).is_some());
        quiet_budget::clear_loud_auth_failure(&host, share);
        let cleared = quiet_tcp_health_result(&host, share, Ok(()));
        assert!(cleared.ok);
        assert!(!cleared.soft_hold);
        assert!(cleared.login_unverified, "TCP-OK proves no Login");
        assert_eq!(cleared.message, QUIET_TCP_OK_MESSAGE);
    }

    #[test]
    fn resolve_auto_mount_disabled_stays_smb() {
        let url = "smb://opt19-no-such-host.invalid/share";
        let resolved = resolve_server_target(
            url,
            Some(AutoMountParams {
                enabled: false,
                login: "u",
                password: "p",
            }),
        )
        .unwrap();
        assert!(matches!(resolved, ServerTarget::Smb { .. }));
    }

    #[test]
    fn credentials_domain_split() {
        let (u, p, d) = parse_credentials(r"CORP\alice", "secret");
        assert_eq!(u, "alice");
        assert_eq!(p, "secret");
        assert_eq!(d, "CORP");
    }

    #[test]
    fn credentials_empty_becomes_guest() {
        let (u, p, d) = parse_credentials("", "");
        assert_eq!(u, "Guest");
        assert_eq!(p, "");
        assert!(d.is_empty());
    }

    #[test]
    fn credentials_user_at_domain() {
        let (u, p, d) = parse_credentials("alice@CORP.LOCAL", "secret");
        assert_eq!(u, "alice");
        assert_eq!(p, "secret");
        assert_eq!(d, "CORP.LOCAL");
    }

    #[test]
    fn map_connect_timeout() {
        let msg = map_connect_error("io error: timed out");
        assert!(msg.contains("nicht erreichbar"));
        assert!(msg.contains("Zeitüberschreitung"));
    }

    #[test]
    fn map_connect_refused() {
        let msg = map_connect_error("Connection refused (os error 111)");
        assert!(msg.contains("nicht erreichbar"));
        assert!(msg.contains("abgelehnt"));
    }

    #[test]
    fn map_smb_logon_failure() {
        let msg = map_smb_error("STATUS_LOGON_FAILURE", "videos");
        assert!(msg.contains("Benutzername oder Passwort"));
    }

    #[test]
    fn map_smb_bad_share() {
        let msg = map_smb_error("STATUS_BAD_NETWORK_NAME", "videos");
        assert!(msg.contains("videos"));
        assert!(msg.contains("nicht gefunden"));
    }

    #[test]
    fn display_remote_uses_forward_slashes() {
        let target = ServerTarget::Smb {
            host: "nas.local".into(),
            port: 445,
            share: "aktuell".into(),
            subpath: "2024".into(),
        };
        assert_eq!(
            display_remote(&target, "clip.mp4"),
            "//nas.local/aktuell/2024/clip.mp4"
        );
    }

    #[test]
    fn upload_progress_gate_skips_redundant_chunk_updates() {
        use crate::video::ffmpeg::{
            reset_cancel_flag, reset_upload_slot_cancel, UploadCancelPolicy,
        };
        use std::cell::Cell;

        let _guard = upload_test_lock();
        reset_cancel_flag();
        reset_upload_slot_cancel();
        let count = Cell::new(0);
        let mut gate =
            UploadProgressGate::new(|_| count.set(count.get() + 1), UploadCancelPolicy::SlotOnly);
        gate.emit(10.0, 1, 5, 100, 1000, "a.bin", true);
        gate.emit(10.4, 1, 5, 104, 1000, "a.bin", false);
        assert_eq!(count.get(), 1);
        gate.emit(11.5, 1, 5, 115, 1000, "a.bin", false);
        assert_eq!(count.get(), 2);
    }

    #[test]
    fn upload_progress_gate_emits_on_file_change() {
        use crate::video::ffmpeg::{
            reset_cancel_flag, reset_upload_slot_cancel, UploadCancelPolicy,
        };
        use std::cell::Cell;

        let _guard = upload_test_lock();
        reset_cancel_flag();
        reset_upload_slot_cancel();
        let count = Cell::new(0);
        let mut gate =
            UploadProgressGate::new(|_| count.set(count.get() + 1), UploadCancelPolicy::SlotOnly);
        gate.emit(50.0, 1, 3, 500, 1000, "a.bin", true);
        gate.emit(50.0, 2, 3, 500, 1000, "b.bin", false);
        assert_eq!(count.get(), 2);
    }

    #[test]
    fn upload_progress_gate_reports_average_speed_bps() {
        use crate::video::ffmpeg::{
            reset_cancel_flag, reset_upload_slot_cancel, UploadCancelPolicy,
        };
        use std::cell::Cell;

        let _guard = upload_test_lock();
        reset_cancel_flag();
        reset_upload_slot_cancel();
        let speed = Cell::new(0.0_f64);
        let mut gate =
            UploadProgressGate::new(|p| speed.set(p.speed_bps), UploadCancelPolicy::SlotOnly);
        gate.emit(10.0, 1, 5, 1_000_000, 10_000_000, "a.bin", true);
        assert!(speed.get() > 0.0);
    }

    #[test]
    fn local_cleanup_removes_upload_tree() {
        let dir = tempfile::tempdir().unwrap();
        let job = dir.path().join("JobA");
        fs::create_dir_all(job.join("Handcam_Video")).unwrap();
        fs::write(job.join("Handcam_Video/clip.mp4"), b"video").unwrap();

        let dest_root = dir.path().join("server");
        fs::create_dir_all(&dest_root).unwrap();
        let files = collect_upload_files(&job).unwrap();
        for file in &files {
            let remote = dest_root.join(
                file.relative
                    .replace('/', std::path::MAIN_SEPARATOR_STR)
                    .as_str(),
            );
            fs::create_dir_all(remote.parent().unwrap()).unwrap();
            fs::write(&remote, b"x").unwrap();
        }
        // Extra remote leftover not in a fresh local list must still vanish.
        fs::write(dest_root.join("JobA").join("orphan.bin"), b"x").unwrap();
        assert!(dest_root.join("JobA").is_dir());
        cleanup_local_job_root(&dest_root, "JobA").unwrap();
        assert!(!dest_root.join("JobA").exists());
    }

    #[test]
    fn smb_path_not_found_matches_common_status_strings() {
        assert!(smb_path_not_found("STATUS_OBJECT_NAME_NOT_FOUND"));
        assert!(smb_path_not_found("STATUS_OBJECT_PATH_NOT_FOUND"));
        assert!(smb_path_not_found("path_not_found"));
        assert!(smb_path_not_found("No such file"));
        assert!(!smb_path_not_found("STATUS_SHARING_VIOLATION"));
        assert!(!smb_path_not_found("STATUS_ACCESS_DENIED"));
    }

    #[test]
    fn smb_sharing_violation_matches_lock_errors() {
        assert!(smb_sharing_violation(
            "STATUS_SHARING_VIOLATION during Create"
        ));
        assert!(smb_sharing_violation(
            "STATUS_DIRECTORY_NOT_EMPTY during SetInfo"
        ));
        assert!(!smb_sharing_violation("STATUS_OBJECT_NAME_NOT_FOUND"));
    }

    #[test]
    fn slot_cancel_does_not_trip_backup_only_policy() {
        use crate::video::ffmpeg::{
            cancel_encode, cancel_secondary_backup, cancel_upload_slot, is_upload_cancelled,
            reset_cancel_flag, reset_secondary_backup_cancel, reset_upload_slot_cancel,
            UploadCancelPolicy,
        };

        let _guard = upload_test_lock();
        reset_cancel_flag();
        reset_upload_slot_cancel();
        reset_secondary_backup_cancel();
        cancel_upload_slot();
        assert!(!is_upload_cancelled(UploadCancelPolicy::WorkflowOnly));
        assert!(!is_upload_cancelled(UploadCancelPolicy::BackupOnly));
        assert!(is_upload_cancelled(UploadCancelPolicy::SlotOnly));
        reset_upload_slot_cancel();
        assert!(!is_upload_cancelled(UploadCancelPolicy::SlotOnly));

        cancel_secondary_backup();
        assert!(is_upload_cancelled(UploadCancelPolicy::BackupOnly));
        assert!(!is_upload_cancelled(UploadCancelPolicy::SlotOnly));
        assert!(!is_upload_cancelled(UploadCancelPolicy::WorkflowOnly));
        reset_secondary_backup_cancel();

        // Session/import cancel must not trip backup or slot transfers.
        cancel_encode();
        assert!(!is_upload_cancelled(UploadCancelPolicy::BackupOnly));
        assert!(!is_upload_cancelled(UploadCancelPolicy::SlotOnly));
        assert!(is_upload_cancelled(UploadCancelPolicy::WorkflowOnly));
        reset_cancel_flag();
    }

    #[test]
    fn local_upload_respects_slot_cancel_flag() {
        use crate::video::ffmpeg::{
            cancel_upload_slot, reset_cancel_flag, reset_upload_slot_cancel, UploadCancelPolicy,
        };
        use std::io::Write;

        let _guard = upload_test_lock();
        reset_cancel_flag();
        reset_upload_slot_cancel();
        let dir =
            std::env::temp_dir().join(format!("aero_upload_slot_cancel_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        {
            let mut f = File::create(&src).unwrap();
            let chunk = vec![0u8; CHUNK_SIZE + 64];
            f.write_all(&chunk).unwrap();
        }
        let dest = dir.join("dest");
        cancel_upload_slot();
        let result = upload_local(
            &dest,
            &[FileEntry {
                absolute: src.clone(),
                relative: "src.bin".into(),
                size: fs::metadata(&src).unwrap().len(),
            }],
            1,
            fs::metadata(&src).unwrap().len(),
            UploadCancelPolicy::SlotOnly,
            &mut UploadProgressGate::new(|_| {}, UploadCancelPolicy::SlotOnly),
        );
        // BackupOnly ignores slot cancel — production server-backup policy.
        let backup_style = upload_local(
            &dest,
            &[FileEntry {
                absolute: src.clone(),
                relative: "src2.bin".into(),
                size: fs::metadata(&src).unwrap().len(),
            }],
            1,
            fs::metadata(&src).unwrap().len(),
            UploadCancelPolicy::BackupOnly,
            &mut UploadProgressGate::new(|_| {}, UploadCancelPolicy::BackupOnly),
        );
        reset_upload_slot_cancel();
        reset_cancel_flag();
        let _ = fs::remove_dir_all(&dir);
        assert!(!result.success);
        assert_eq!(result.message, WORKFLOW_CANCELLED);
        assert!(
            backup_style.success,
            "BackupOnly must ignore slot cancel: {}",
            backup_style.message
        );
    }

    #[test]
    fn local_backup_ignores_workflow_cancel_flag() {
        use crate::video::ffmpeg::{
            cancel_encode, reset_cancel_flag, reset_secondary_backup_cancel, UploadCancelPolicy,
        };
        use std::io::Write;

        let _guard = upload_test_lock();
        reset_cancel_flag();
        reset_secondary_backup_cancel();
        let dir = std::env::temp_dir().join(format!(
            "aero_backup_ignore_workflow_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        {
            let mut f = File::create(&src).unwrap();
            let chunk = vec![0u8; CHUNK_SIZE + 64];
            f.write_all(&chunk).unwrap();
        }
        let dest = dir.join("dest");
        cancel_encode();
        let result = upload_local(
            &dest,
            &[FileEntry {
                absolute: src.clone(),
                relative: "src.bin".into(),
                size: fs::metadata(&src).unwrap().len(),
            }],
            1,
            fs::metadata(&src).unwrap().len(),
            UploadCancelPolicy::BackupOnly,
            &mut UploadProgressGate::new(|_| {}, UploadCancelPolicy::BackupOnly),
        );
        reset_cancel_flag();
        reset_secondary_backup_cancel();
        let _ = fs::remove_dir_all(&dir);
        assert!(
            result.success,
            "BackupOnly must ignore workflow cancel: {}",
            result.message
        );
    }

    #[test]
    fn local_upload_slot_only_ignores_workflow_cancel_flag() {
        use crate::video::ffmpeg::{
            cancel_encode, reset_cancel_flag, reset_upload_slot_cancel, UploadCancelPolicy,
        };
        use std::io::Write;

        let _guard = upload_test_lock();
        reset_cancel_flag();
        reset_upload_slot_cancel();
        let dir = std::env::temp_dir().join(format!(
            "aero_upload_ignore_workflow_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        {
            let mut f = File::create(&src).unwrap();
            let chunk = vec![0u8; CHUNK_SIZE + 64];
            f.write_all(&chunk).unwrap();
        }
        let dest = dir.join("dest");
        // Session/import cancel must not abort background Vorgang upload.
        cancel_encode();
        let result = upload_local(
            &dest,
            &[FileEntry {
                absolute: src.clone(),
                relative: "src.bin".into(),
                size: fs::metadata(&src).unwrap().len(),
            }],
            1,
            fs::metadata(&src).unwrap().len(),
            UploadCancelPolicy::SlotOnly,
            &mut UploadProgressGate::new(|_| {}, UploadCancelPolicy::SlotOnly),
        );
        reset_cancel_flag();
        reset_upload_slot_cancel();
        let _ = fs::remove_dir_all(&dir);
        assert!(
            result.success,
            "SlotOnly must ignore workflow cancel: {}",
            result.message
        );
    }

    #[test]
    fn local_upload_current_file_is_completed_count() {
        use crate::video::ffmpeg::reset_cancel_flag;

        let _guard = upload_test_lock();
        reset_cancel_flag();

        let dir = tempfile::tempdir().unwrap();
        let job = dir.path().join("JobCount");
        fs::create_dir_all(job.join("Handcam_Foto")).unwrap();
        fs::write(job.join("Handcam_Foto/a.jpg"), b"a").unwrap();
        fs::write(job.join("Handcam_Foto/b.jpg"), b"b").unwrap();
        fs::write(job.join("_fertig.txt"), b"m").unwrap();

        let files = collect_upload_files(&job).unwrap();
        let dest = dir.path().join("server");
        let total_files = files.len() as u32;
        let total_bytes: u64 = files.iter().map(|f| f.size).sum();
        let mut seen = Vec::<u32>::new();
        let result = upload_local(
            &dest,
            &files,
            total_files,
            total_bytes,
            crate::video::ffmpeg::UploadCancelPolicy::SlotOnly,
            &mut UploadProgressGate::new(
                |p| {
                    seen.push(p.current_file);
                },
                crate::video::ffmpeg::UploadCancelPolicy::SlotOnly,
            ),
        );
        assert!(result.success, "{}", result.message);
        assert!(!seen.is_empty());
        for w in seen.windows(2) {
            assert!(
                w[1] >= w[0],
                "current_file must be monotonic completed count: {seen:?}"
            );
        }
        assert_eq!(*seen.last().unwrap(), total_files);
    }

    #[test]
    fn local_upload_barrier_writes_marker_after_media() {
        use crate::video::ffmpeg::reset_cancel_flag;

        let _guard = upload_test_lock();
        reset_cancel_flag();

        let dir = tempfile::tempdir().unwrap();
        let job = dir.path().join("JobBarrier");
        fs::create_dir_all(job.join("Handcam_Foto")).unwrap();
        fs::write(job.join("Handcam_Foto/z_last.jpg"), b"photo").unwrap();
        fs::write(job.join("_fertig.txt"), b"{\"ok\":1}").unwrap();
        fs::write(job.join("_ams_manifest.v1.json"), b"{}").unwrap();
        // Alpha-sort would place _ams / _fertig among underscores; barrier must still
        // finish media first.
        fs::write(job.join("zzz_note.txt"), b"note").unwrap();

        let files = collect_upload_files(&job).unwrap();
        let phases = partition_upload_phases(&files);
        assert_eq!(phases.media.len(), 2);
        assert!(phases.manifest.is_some());
        assert!(phases.marker.is_some());

        let order = Mutex::new(Vec::<String>::new());
        let dest = dir.path().join("server");
        let total_files = files.len() as u32;
        let total_bytes: u64 = files.iter().map(|f| f.size).sum();
        let result = upload_local(
            &dest,
            &files,
            total_files,
            total_bytes,
            crate::video::ffmpeg::UploadCancelPolicy::SlotOnly,
            &mut UploadProgressGate::new(
                |p| {
                    if !p.filename.is_empty() {
                        order.lock().unwrap().push(p.filename.clone());
                    }
                },
                crate::video::ffmpeg::UploadCancelPolicy::SlotOnly,
            ),
        );
        assert!(result.success, "{}", result.message);
        let seen = order.into_inner().unwrap();
        let marker_pos = seen.iter().rposition(|f| f == "_fertig.txt");
        let manifest_pos = seen.iter().rposition(|f| f == "_ams_manifest.v1.json");
        let media_last = seen
            .iter()
            .rposition(|f| f != "_fertig.txt" && f != "_ams_manifest.v1.json");
        assert!(marker_pos.is_some());
        assert!(manifest_pos.is_some());
        assert!(media_last.is_some());
        assert!(media_last.unwrap() < manifest_pos.unwrap());
        assert!(manifest_pos.unwrap() < marker_pos.unwrap());
        assert!(dest.join("JobBarrier").join("_fertig.txt").is_file());
    }

    #[test]
    fn local_upload_cancel_before_marker_leaves_no_marker() {
        use crate::video::ffmpeg::{
            cancel_upload_slot, reset_cancel_flag, reset_upload_slot_cancel,
        };
        use std::sync::atomic::{AtomicU32, Ordering};

        let _guard = upload_test_lock();
        reset_cancel_flag();
        reset_upload_slot_cancel();
        let dir = tempfile::tempdir().unwrap();
        let job = dir.path().join("JobCancel");
        fs::create_dir_all(job.join("Handcam_Foto")).unwrap();
        // Large enough for cancel to land between files.
        let big = vec![0u8; CHUNK_SIZE + 128];
        fs::write(job.join("Handcam_Foto/a.jpg"), &big).unwrap();
        fs::write(job.join("Handcam_Foto/b.jpg"), &big).unwrap();
        fs::write(job.join("_fertig.txt"), b"marker").unwrap();

        let files = collect_upload_files(&job).unwrap();
        let dest = dir.path().join("server");
        let total_files = files.len() as u32;
        let total_bytes: u64 = files.iter().map(|f| f.size).sum();
        let started = AtomicU32::new(0);
        let result = upload_local(
            &dest,
            &files,
            total_files,
            total_bytes,
            crate::video::ffmpeg::UploadCancelPolicy::SlotOnly,
            &mut UploadProgressGate::new(
                |p| {
                    if !p.filename.is_empty() {
                        let n = started.fetch_add(1, Ordering::SeqCst);
                        if n >= 1 {
                            cancel_upload_slot();
                        }
                    }
                },
                crate::video::ffmpeg::UploadCancelPolicy::SlotOnly,
            ),
        );
        reset_upload_slot_cancel();
        reset_cancel_flag();
        assert!(!result.success);
        assert_eq!(result.message, WORKFLOW_CANCELLED);
        assert!(
            !dest.join("JobCancel").join("_fertig.txt").exists(),
            "marker must not appear on cancel mid-upload"
        );
    }

    #[test]
    fn health_connect_timeout_is_shorter_than_transfer() {
        assert_eq!(SMB_HEALTH_CONNECT_TIMEOUT, Duration::from_secs(5));
        assert_eq!(SMB_CONNECT_TIMEOUT, Duration::from_secs(10));
        assert!(SMB_HEALTH_CONNECT_TIMEOUT < SMB_CONNECT_TIMEOUT);
    }

    #[test]
    fn loud_host_busy_message_matches_spec() {
        assert_eq!(
            LOUD_HOST_BUSY_MESSAGE,
            "Übertragung aktiv — Verbindung besteht"
        );
    }

    #[test]
    fn stale_pool_hit_retries_once_then_failure_counts() {
        assert_eq!(
            health_probe_disposition(true, true, false),
            HealthProbeDisposition::Discard,
            "success disconnects the health session instead of parking it"
        );
        assert_eq!(
            health_probe_disposition(false, true, false),
            HealthProbeDisposition::RetryFresh,
            "an error right after a pool hit retries once and does not count yet"
        );
        assert_eq!(
            health_probe_disposition(false, false, true),
            HealthProbeDisposition::Fail,
            "only the fresh connect's error counts for Quiet-backoff"
        );
        assert_eq!(
            health_probe_disposition(true, false, true),
            HealthProbeDisposition::Discard
        );
        assert_eq!(
            health_probe_disposition(false, false, false),
            HealthProbeDisposition::Fail,
            "a pool miss does not open a second SessionSetup"
        );
        assert_eq!(
            health_probe_disposition(false, true, true),
            HealthProbeDisposition::Fail,
            "stale-hit retry happens only once"
        );
    }
}
