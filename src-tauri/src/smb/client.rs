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

use crate::video::ffmpeg::{is_upload_cancelled, UploadCancelPolicy, WORKFLOW_CANCELLED};

use super::parallel_upload::{partition_upload_phases, upload_smb_media_parallel};

const CHUNK_SIZE: usize = 1024 * 1024;
/// Min interval between upload progress UI events (local + SMB).
const UPLOAD_PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(150);
/// How often in-flight `write_chunk` is interrupted to honor cancel.
const WRITE_CANCEL_POLL: Duration = Duration::from_millis(50);

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
    Local { path: PathBuf },
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
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadResult {
    pub success: bool,
    pub message: String,
    pub remote_path: String,
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

    let is_network = was_smb_url
        || without_scheme.starts_with(r"\\")
        || without_scheme.starts_with("//");

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

async fn connect_smb(
    host: &str,
    port: u16,
    login: &str,
    password: &str,
) -> Result<SmbClient, String> {
    let (username, password, domain) = parse_credentials(login, password);
    let addr = smb_addr(host, port);
    SmbClient::connect(ClientConfig {
        addr,
        timeout: Duration::from_secs(10),
        username,
        password,
        domain,
        auto_reconnect: false,
        compression: true,
        dfs_enabled: true,
        dfs_target_overrides: Default::default(),
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
pub async fn test_connection(
    server_url: &str,
    login: &str,
    password: &str,
) -> ConnectionTestResult {
    let target = match parse_server_target(server_url) {
        Ok(t) => t,
        Err(e) => {
            return ConnectionTestResult {
                ok: false,
                message: e,
            }
        }
    };

    match target {
        ServerTarget::Local { path } => {
            if path.exists() {
                ConnectionTestResult {
                    ok: true,
                    message: format!("Lokaler Pfad erreichbar: {}", path.display()),
                }
            } else {
                ConnectionTestResult {
                    ok: false,
                    message: format!("Lokaler Pfad nicht gefunden: {}", path.display()),
                }
            }
        }
        ServerTarget::Smb {
            host,
            port,
            share,
            subpath,
        } => match connect_smb(&host, port, login, password).await {
            Ok(mut client) => match client.connect_share(&share).await {
                Ok(mut tree) => {
                    let list_path = if subpath.is_empty() {
                        ""
                    } else {
                        subpath.as_str()
                    };
                    match client.list_directory(&mut tree, list_path).await {
                        Ok(_) => ConnectionTestResult {
                            ok: true,
                            message: format!("Verbindung zum Server erfolgreich (//{host}/{share})"),
                        },
                        Err(e) => {
                            // Share connected but subpath list failed — still count as reachable
                            // if subpath empty failed hard; for non-empty try fs_info as fallback
                            if subpath.is_empty() {
                                ConnectionTestResult {
                                    ok: false,
                                    message: format!("Share erreichbar, Listing fehlgeschlagen: {e}"),
                                }
                            } else {
                                match client.fs_info(&mut tree).await {
                                    Ok(_) => ConnectionTestResult {
                                        ok: true,
                                        message: format!(
                                            "Verbindung zum Server erfolgreich (//{host}/{share})"
                                        ),
                                    },
                                    Err(e2) => ConnectionTestResult {
                                        ok: false,
                                        message: format!("Verbindung fehlgeschlagen: {e2}"),
                                    },
                                }
                            }
                        }
                    }
                }
                Err(e) => ConnectionTestResult {
                    ok: false,
                    message: map_smb_error(&e.to_string(), &share),
                },
            },
            Err(e) => ConnectionTestResult {
                ok: false,
                message: e,
            },
        },
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

fn map_smb_error(err: &str, share: &str) -> String {
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
        let size = fs::metadata(local)
            .map(|m| m.len())
            .unwrap_or(0);
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
            last_emit: now
                .checked_sub(UPLOAD_PROGRESS_MIN_INTERVAL)
                .unwrap_or(now),
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
    UploadResult {
        success: false,
        message: WORKFLOW_CANCELLED.into(),
        remote_path: String::new(),
    }
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
    cancel: UploadCancelPolicy,
    on_progress: F,
) -> UploadResult
where
    F: FnMut(UploadProgress) + Send + 'static,
{
    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        return cancelled;
    }

    let target = match parse_server_target(server_url) {
        Ok(t) => t,
        Err(e) => {
            return UploadResult {
                success: false,
                message: e,
                remote_path: String::new(),
            }
        }
    };

    let files = match collect_upload_files(local_path) {
        Ok(f) => f,
        Err(e) => {
            return UploadResult {
                success: false,
                message: e,
                remote_path: String::new(),
            }
        }
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
                upload_local(&dest, &files, total_files, total_bytes, cancel, &mut progress)
            })
            .await
            {
                Ok(result) => result,
                Err(e) => UploadResult {
                    success: false,
                    message: if is_upload_cancelled(cancel) {
                        WORKFLOW_CANCELLED.into()
                    } else {
                        format!("Upload fehlgeschlagen: {e}")
                    },
                    remote_path: String::new(),
                },
            }
        }
        ServerTarget::Smb {
            host,
            port,
            share,
            subpath,
        } => {
            upload_smb(
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
            .await
        }
    }
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
        return UploadResult {
            success: false,
            message: format!("Zielverzeichnis konnte nicht erstellt werden: {e}"),
            remote_path: String::new(),
        };
    }

    // Same barrier order as SMB: media → manifest → marker (never marker mid-media).
    let phases = partition_upload_phases(files);
    let ordered = phases.ordered();
    let mut copied_bytes = 0u64;

    for (idx, file) in ordered.into_iter().enumerate() {
        if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
            return cancelled;
        }
        let file_index = (idx + 1) as u32;
        let dest = dest_root.join(file.relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = dest.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                return UploadResult {
                    success: false,
                    message: format!("Ordner erstellen fehlgeschlagen: {e}"),
                    remote_path: String::new(),
                };
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
            let message = if e == WORKFLOW_CANCELLED {
                WORKFLOW_CANCELLED.into()
            } else {
                format!("Kopieren fehlgeschlagen ({}): {e}", file.relative)
            };
            return UploadResult {
                success: false,
                message,
                remote_path: String::new(),
            };
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
        return cancelled;
    }

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
    UploadResult {
        success: true,
        message: format!("Erfolgreich auf Server kopiert: {remote}"),
        remote_path: remote,
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

/// Drop the shared SMB upload session, then pause on cancel so remote cleanup
/// does not hit STATUS_SHARING_VIOLATION on still-open writers.
async fn release_smb_session_for_cleanup<F>(
    result: UploadResult,
    cancel: UploadCancelPolicy,
    progress: Arc<Mutex<UploadProgressGate<F>>>,
    tree: Arc<smb2::client::Tree>,
    client: Arc<SmbClient>,
) -> UploadResult
where
    F: FnMut(UploadProgress) + Send + 'static,
{
    let cancelled =
        result.message.trim() == WORKFLOW_CANCELLED || is_upload_cancelled(cancel);
    drop(progress);
    drop(tree);
    drop(client);
    if cancelled {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    result
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
    let mut client = match connect_smb(host, port, login, password).await {
        Ok(c) => c,
        Err(e) => {
            return UploadResult {
                success: false,
                message: e,
                remote_path: String::new(),
            }
        }
    };

    let mut tree = match client.connect_share(share).await {
        Ok(t) => t,
        Err(e) => {
            return UploadResult {
                success: false,
                message: map_smb_error(&e.to_string(), share),
                remote_path: String::new(),
            }
        }
    };

    let mut created_dirs = std::collections::HashSet::<String>::new();
    if !subpath.is_empty() {
        if let Err(e) =
            ensure_remote_dirs(&mut client, &mut tree, subpath, &mut created_dirs).await
        {
            return UploadResult {
                success: false,
                message: e,
                remote_path: String::new(),
            };
        }
    }

    let phases = partition_upload_phases(files);

    // Create every parent directory before any parallel write (no races on mkdir).
    for file in phases.ordered() {
        if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
            return cancelled;
        }
        let remote_rel = join_smb_path(subpath, &file.relative);
        if let Some(parent) = Path::new(&remote_rel).parent() {
            let parent_str = parent.to_string_lossy().replace('\\', "/");
            if !parent_str.is_empty() && parent_str != "." {
                if let Err(e) =
                    ensure_remote_dirs(&mut client, &mut tree, &parent_str, &mut created_dirs)
                        .await
                {
                    return UploadResult {
                        success: false,
                        message: e,
                        remote_path: String::new(),
                    };
                }
            }
        }
    }

    let progress = Arc::new(Mutex::new(progress));
    let client = Arc::new(client);
    let tree = Arc::new(tree);

    let media_remotes: Vec<String> = phases
        .media
        .iter()
        .map(|f| join_smb_path(subpath, &f.relative))
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
            return release_smb_session_for_cleanup(e, cancel, progress, tree, client).await;
        }
    };

    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        return release_smb_session_for_cleanup(cancelled, cancel, progress, tree, client)
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
            &join_smb_path(subpath, &manifest.relative),
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
                return release_smb_session_for_cleanup(e, cancel, progress, tree, client).await;
            }
        }
    }

    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        return release_smb_session_for_cleanup(cancelled, cancel, progress, tree, client)
            .await;
    }

    if let Some(marker) = &phases.marker {
        let file_index = phases.total_files();
        match upload_smb_one(
            client.as_ref(),
            tree.as_ref(),
            marker,
            &join_smb_path(subpath, &marker.relative),
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
                return release_smb_session_for_cleanup(e, cancel, progress, tree, client).await;
            }
        }
    }

    let _ = copied_bytes;
    if let Err(cancelled) = ensure_upload_not_cancelled(cancel) {
        return release_smb_session_for_cleanup(cancelled, cancel, progress, tree, client)
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

    let remote = display_remote(
        &ServerTarget::Smb {
            host: host.to_string(),
            port,
            share: share.to_string(),
            subpath: subpath.to_string(),
        },
        files
            .first()
            .map(|f| f.relative.split('/').next().unwrap_or(&f.relative))
            .unwrap_or(""),
    );

    UploadResult {
        success: true,
        message: format!("Erfolgreich auf Server kopiert: {remote}"),
        remote_path: remote,
    }
}

async fn upload_smb_one<F: FnMut(UploadProgress) + Send>(
    client: &SmbClient,
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
    match stream_upload_file(client, tree, &file.absolute, remote_rel, cancel, |copied_in_file| {
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
    })
    .await
    {
        Ok(_) => {}
        Err(e) => {
            let message = if e == WORKFLOW_CANCELLED {
                WORKFLOW_CANCELLED.into()
            } else {
                format!("Upload fehlgeschlagen ({}): {e}", file.relative)
            };
            return Err(UploadResult {
                success: false,
                message,
                remote_path: String::new(),
            });
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

pub(crate) async fn stream_upload_file(
    client: &SmbClient,
    tree: &smb2::client::Tree,
    local: &Path,
    remote: &str,
    cancel: UploadCancelPolicy,
    mut on_chunk: impl FnMut(u64),
) -> Result<u64, String> {
    let mut writer = client
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
                let _ = writer.abort().await;
                return Err(e.to_string());
            }
            Err(e) => {
                let _ = writer.abort().await;
                return Err(e.to_string());
            }
        };
        if is_upload_cancelled(cancel) {
            let _ = writer.abort().await;
            return Err(WORKFLOW_CANCELLED.into());
        }
        let mut offset = 0usize;
        while offset < data.len() {
            if is_upload_cancelled(cancel) {
                let _ = writer.abort().await;
                return Err(WORKFLOW_CANCELLED.into());
            }
            let end = (offset + CHUNK_SIZE).min(data.len());
            if let Err(e) = write_chunk_unless_cancelled(
                &mut writer,
                &data[offset..end],
                cancel,
            )
            .await
            {
                let _ = writer.abort().await;
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
                let _ = writer.abort().await;
                return Err(e);
            }
        };
        if is_upload_cancelled(cancel) {
            let _ = reader.await;
            let _ = writer.abort().await;
            return Err(WORKFLOW_CANCELLED.into());
        }
        if let Err(e) = write_chunk_unless_cancelled(&mut writer, &chunk, cancel).await {
            let _ = reader.await;
            let _ = writer.abort().await;
            return Err(e);
        }
        copied += chunk.len() as u64;
        on_chunk(copied);
    }

    match reader.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = writer.abort().await;
            return Err(e);
        }
        Err(e) => {
            let _ = writer.abort().await;
            if is_upload_cancelled(cancel) {
                return Err(WORKFLOW_CANCELLED.into());
            }
            return Err(format!("Disk-Read fehlgeschlagen: {e}"));
        }
    }

    writer.finish().await.map_err(|e| e.to_string())
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
) -> Result<(), String> {
    let target = parse_server_target(server_url)?;
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
        } => {
            cleanup_smb_job_root(
                &host,
                port,
                &share,
                &subpath,
                login,
                password,
                &job_name,
            )
            .await
        }
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
    if job_root.is_empty() {
        return Err("Leerer Cleanup-Pfad".into());
    }

    // Give the cancelled upload session time to release file handles after
    // FileWriter::abort / TCP teardown.
    tokio::time::sleep(Duration::from_millis(400)).await;

    const ATTEMPTS: u32 = 6;
    let mut last_err: Option<String> = None;
    for attempt in 1..=ATTEMPTS {
        // Fresh connection each attempt — avoids a poisoned tree after
        // SHARING_VIOLATION / DIRECTORY_NOT_EMPTY mid-delete.
        let mut client = connect_smb(host, port, login, password).await?;
        let mut tree = client
            .connect_share(share)
            .await
            .map_err(|e| map_smb_error(&e.to_string(), share))?;

        match delete_smb_tree_recursive(&mut client, &mut tree, &job_root).await {
            Ok(()) => {
                if smb_remote_gone(&mut client, &mut tree, &job_root).await {
                    return Ok(());
                }
                last_err = Some(format!(
                    "Remote-Ordner noch vorhanden nach Löschen: {job_root}"
                ));
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
        drop(tree);
        drop(client);
        if attempt < ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(300 * u64::from(attempt))).await;
        }
    }
    Err(last_err.unwrap_or_else(|| format!("Aufräumen fehlgeschlagen: {job_root}")))
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
                    Err(dir_err) => {
                        match client.delete_file(tree, path).await {
                            Ok(()) => Ok(()),
                            Err(e) if smb_path_not_found(&e.to_string()) => Ok(()),
                            Err(file_err) => Err(format!(
                                "{path}: list={list_msg}; dir={dir_err}; file={file_err}"
                            )),
                        }
                    }
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
            ServerTarget::Smb { host, port, share, .. } => {
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
        let mut gate = UploadProgressGate::new(|_| count.set(count.get() + 1), UploadCancelPolicy::SlotOnly);
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
        let mut gate = UploadProgressGate::new(|_| count.set(count.get() + 1), UploadCancelPolicy::SlotOnly);
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
        let mut gate = UploadProgressGate::new(|p| speed.set(p.speed_bps), UploadCancelPolicy::SlotOnly);
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
            cancel_upload_slot, reset_cancel_flag, reset_upload_slot_cancel,
            UploadCancelPolicy,
        };
        use std::io::Write;

        let _guard = upload_test_lock();
        reset_cancel_flag();
        reset_upload_slot_cancel();
        let dir = std::env::temp_dir().join(format!(
            "aero_upload_slot_cancel_{}",
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
}
