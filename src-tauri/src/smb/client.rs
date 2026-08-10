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
use std::time::Duration;

use serde::Serialize;
use smb2::{ClientConfig, SmbClient};

const CHUNK_SIZE: usize = 1024 * 1024;

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
    pub current_file: u32,
    pub total_files: u32,
    pub current_bytes: u64,
    pub total_bytes: u64,
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

struct FileEntry {
    relative: String,
    absolute: PathBuf,
    size: u64,
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

fn emit_progress<F: FnMut(UploadProgress)>(
    cb: &mut F,
    percent: f64,
    current_file: u32,
    total_files: u32,
    current_bytes: u64,
    total_bytes: u64,
    filename: &str,
) {
    cb(UploadProgress {
        percent: percent.clamp(0.0, 100.0),
        current_file,
        total_files,
        current_bytes,
        total_bytes,
        filename: filename.to_string(),
    });
}

/// Upload a local file or directory to the configured server.
pub async fn upload_path<F>(
    local_path: &Path,
    server_url: &str,
    login: &str,
    password: &str,
    mut on_progress: F,
) -> UploadResult
where
    F: FnMut(UploadProgress) + Send,
{
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
    emit_progress(
        &mut on_progress,
        0.0,
        0,
        total_files,
        0,
        total_bytes,
        "",
    );

    match &target {
        ServerTarget::Local { path } => {
            upload_local(path, &files, total_files, total_bytes, &mut on_progress)
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
                &mut on_progress,
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
    on_progress: &mut F,
) -> UploadResult {
    if let Err(e) = fs::create_dir_all(dest_root) {
        return UploadResult {
            success: false,
            message: format!("Zielverzeichnis konnte nicht erstellt werden: {e}"),
            remote_path: String::new(),
        };
    }

    let mut copied_bytes = 0u64;
    for (idx, file) in files.iter().enumerate() {
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

        if let Err(e) = copy_file_chunked(&file.absolute, &dest, |copied_in_file| {
            let current = bytes_before + copied_in_file;
            let percent = if total_bytes > 0 {
                (current as f64 / total_bytes as f64) * 100.0
            } else {
                ((file_index - 1) as f64 / total_files as f64) * 100.0
            };
            emit_progress(
                on_progress,
                percent,
                file_index,
                total_files,
                current,
                total_bytes,
                &filename,
            );
        }) {
            return UploadResult {
                success: false,
                message: format!("Kopieren fehlgeschlagen ({}): {e}", file.relative),
                remote_path: String::new(),
            };
        }

        copied_bytes += file.size;
        let percent = if total_bytes > 0 {
            (copied_bytes as f64 / total_bytes as f64) * 100.0
        } else {
            (file_index as f64 / total_files as f64) * 100.0
        };
        emit_progress(
            on_progress,
            percent,
            file_index,
            total_files,
            copied_bytes,
            total_bytes,
            &filename,
        );
    }

    emit_progress(
        on_progress,
        100.0,
        total_files,
        total_files,
        total_bytes,
        total_bytes,
        "",
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
    mut on_chunk: impl FnMut(u64),
) -> Result<(), String> {
    let mut input = File::open(src).map_err(|e| e.to_string())?;
    let mut output = File::create(dst).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut copied = 0u64;
    loop {
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

async fn upload_smb<F: FnMut(UploadProgress) + Send>(
    host: &str,
    port: u16,
    share: &str,
    subpath: &str,
    files: &[FileEntry],
    total_files: u32,
    total_bytes: u64,
    login: &str,
    password: &str,
    on_progress: &mut F,
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

    let mut copied_bytes = 0u64;
    for (idx, file) in files.iter().enumerate() {
        let file_index = (idx + 1) as u32;
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

        let filename = file
            .absolute
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bytes_before = copied_bytes;

        match stream_upload_file(
            &client,
            &tree,
            &file.absolute,
            &remote_rel,
            |copied_in_file| {
                let current = bytes_before + copied_in_file;
                let percent = if total_bytes > 0 {
                    (current as f64 / total_bytes as f64) * 100.0
                } else {
                    ((file_index - 1) as f64 / total_files as f64) * 100.0
                };
                emit_progress(
                    on_progress,
                    percent,
                    file_index,
                    total_files,
                    current,
                    total_bytes,
                    &filename,
                );
            },
        )
        .await
        {
            Ok(_) => {}
            Err(e) => {
                return UploadResult {
                    success: false,
                    message: format!("Upload fehlgeschlagen ({}): {e}", file.relative),
                    remote_path: String::new(),
                }
            }
        }

        copied_bytes += file.size;
        let percent = if total_bytes > 0 {
            (copied_bytes as f64 / total_bytes as f64) * 100.0
        } else {
            (file_index as f64 / total_files as f64) * 100.0
        };
        emit_progress(
            on_progress,
            percent,
            file_index,
            total_files,
            copied_bytes,
            total_bytes,
            &filename,
        );
    }

    emit_progress(
        on_progress,
        100.0,
        total_files,
        total_files,
        total_bytes,
        total_bytes,
        "",
    );

    let remote = display_remote(
        &ServerTarget::Smb {
            host: host.to_string(),
            port,
            share: share.to_string(),
            subpath: subpath.to_string(),
        },
        files
            .first()
            .map(|f| {
                // Show the top-level folder or file name
                f.relative.split('/').next().unwrap_or(&f.relative)
            })
            .unwrap_or(""),
    );

    UploadResult {
        success: true,
        message: format!("Erfolgreich auf Server kopiert: {remote}"),
        remote_path: remote,
    }
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

async fn stream_upload_file(
    client: &SmbClient,
    tree: &smb2::client::Tree,
    local: &Path,
    remote: &str,
    mut on_chunk: impl FnMut(u64),
) -> Result<u64, String> {
    let mut writer = client
        .create_file_writer(tree, remote)
        .await
        .map_err(|e| e.to_string())?;

    let mut input = File::open(local).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut copied = 0u64;
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        writer
            .write_chunk(&buf[..n])
            .await
            .map_err(|e| e.to_string())?;
        copied += n as u64;
        on_chunk(copied);
    }
    writer.finish().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
