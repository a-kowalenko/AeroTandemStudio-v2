//! Auto-update helpers (Tauri updater plugin) + manual version switching.
//!
//! Production feed: public releases repo
//! `a-kowalenko/aero-tandem-studio-releases` → `latest.json`.
//!
//! Signing: `TAURI_SIGNING_PRIVATE_KEY` (+ password) in CI; pubkey in
//! `tauri.conf.json` → `plugins.updater.pubkey`.

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime};

/// Frontend listens for download/install progress while applying an update.
pub const EVENT_UPDATE_INSTALL_PROGRESS: &str = "update-install-progress";

/// Marker substring that means “stub / not ready” (keep for safety if config regresses).
pub const UPDATER_STUB_MARKER: &str = "releases.example.invalid";

const UPDATER_ENDPOINT: &str =
    "https://github.com/a-kowalenko/aero-tandem-studio-releases/releases/latest/download/latest.json";

const RELEASES_API_URL: &str =
    "https://api.github.com/repos/a-kowalenko/aero-tandem-studio-releases/releases?per_page=100";

/// Oldest version offered in the manual switcher (matches first public v2 builds).
pub const MIN_SWITCHABLE_VERSION: &str = "0.1.0";

const USER_AGENT: &str = "AeroTandemStudio-Updater";

#[derive(Debug, Clone, Serialize)]
pub struct UpdaterStatus {
    pub configured: bool,
    pub current_version: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub configured: bool,
    pub available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub body: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AvailableRelease {
    pub tag_name: String,
    pub published_at: String,
    pub body: String,
    pub installer_url: String,
    pub prerelease: bool,
}

fn updater_endpoints() -> Vec<String> {
    // Keep in sync with tauri.conf.json → plugins.updater.endpoints
    vec![UPDATER_ENDPOINT.to_string()]
}

pub fn is_updater_configured() -> bool {
    let endpoints = updater_endpoints();
    if endpoints.is_empty() {
        return false;
    }
    !endpoints.iter().any(|e| e.contains(UPDATER_STUB_MARKER))
}

#[tauri::command]
pub fn get_updater_status(app: AppHandle) -> UpdaterStatus {
    let current_version = app.package_info().version.to_string();
    if is_updater_configured() {
        UpdaterStatus {
            configured: true,
            current_version,
            message: "Update-Prüfung über GitHub Releases möglich.".into(),
        }
    } else {
        UpdaterStatus {
            configured: false,
            current_version,
            message: "Auto-Update ist derzeit nicht verfügbar.".into(),
        }
    }
}

/// Check for updates. When stub config is active, returns `configured: false`
/// without contacting the network. When configured, uses the updater plugin.
#[tauri::command]
pub async fn check_for_updates<R: Runtime>(app: AppHandle<R>) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();

    if !is_updater_configured() {
        return Ok(UpdateCheckResult {
            configured: false,
            available: false,
            current_version,
            latest_version: None,
            body: None,
            message: "Auto-Update ist derzeit nicht verfügbar.".into(),
        });
    }

    #[cfg(desktop)]
    {
        use tauri_plugin_updater::UpdaterExt;
        let updater = app
            .updater_builder()
            .build()
            .map_err(|e| format!("Updater konnte nicht initialisiert werden: {e}"))?;
        match updater.check().await {
            Ok(Some(update)) => {
                // Always from GitHub Release body (editable after publish), never latest.json notes.
                let body = fetch_release_notes(&update.version).await;
                Ok(UpdateCheckResult {
                    configured: true,
                    available: true,
                    current_version,
                    latest_version: Some(update.version.clone()),
                    body,
                    message: format!("Update verfügbar: {}", update.version),
                })
            }
            Ok(None) => Ok(UpdateCheckResult {
                configured: true,
                available: false,
                current_version: current_version.clone(),
                latest_version: None,
                body: None,
                message: format!("Sie haben bereits die neueste Version ({current_version})."),
            }),
            Err(e) => Err(format!("Update-Prüfung fehlgeschlagen: {e}")),
        }
    }

    #[cfg(not(desktop))]
    {
        Ok(UpdateCheckResult {
            configured: false,
            available: false,
            current_version,
            latest_version: None,
            body: None,
            message: "Updater nur auf Desktop verfügbar.".into(),
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallProgress {
    /// `"download"` while bytes arrive, `"install"` after download finishes.
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: f64,
    /// Approximate download throughput in bytes/sec (0 while installing).
    pub speed_bps: f64,
}

fn emit_update_progress<R: Runtime>(app: &AppHandle<R>, progress: &UpdateInstallProgress) {
    let _ = app.emit(EVENT_UPDATE_INSTALL_PROGRESS, progress);
}

/// Download + install a pending update (plugin API) with progress events.
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    if !is_updater_configured() {
        return Err("Update-Installation ist derzeit nicht möglich.".into());
    }

    #[cfg(desktop)]
    {
        use tauri_plugin_updater::UpdaterExt;
        let updater = app
            .updater_builder()
            .build()
            .map_err(|e| format!("Updater konnte nicht initialisiert werden: {e}"))?;
        let update = updater
            .check()
            .await
            .map_err(|e| format!("Update-Prüfung fehlgeschlagen: {e}"))?
            .ok_or_else(|| "Kein Update verfügbar.".to_string())?;

        let version = update.version.clone();
        let app_for_progress = app.clone();
        let downloaded = Arc::new(AtomicU64::new(0));
        let started = Instant::now();

        emit_update_progress(
            &app,
            &UpdateInstallProgress {
                phase: "download".into(),
                downloaded_bytes: 0,
                total_bytes: None,
                percent: 0.0,
                speed_bps: 0.0,
            },
        );

        let downloaded_cb = Arc::clone(&downloaded);
        update
            .download_and_install(
                move |chunk, total| {
                    let done = downloaded_cb.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    let speed_bps = done as f64 / elapsed;
                    let percent = match total {
                        Some(t) if t > 0 => (done as f64 / t as f64 * 100.0).clamp(0.0, 100.0),
                        _ => 0.0,
                    };
                    emit_update_progress(
                        &app_for_progress,
                        &UpdateInstallProgress {
                            phase: "download".into(),
                            downloaded_bytes: done,
                            total_bytes: total,
                            percent,
                            speed_bps,
                        },
                    );
                },
                || {
                    let done = downloaded.load(Ordering::Relaxed);
                    emit_update_progress(
                        &app,
                        &UpdateInstallProgress {
                            phase: "install".into(),
                            downloaded_bytes: done,
                            total_bytes: Some(done).filter(|&n| n > 0),
                            percent: 100.0,
                            speed_bps: 0.0,
                        },
                    );
                },
            )
            .await
            .map_err(|e| format!("Update-Installation fehlgeschlagen: {e}"))?;

        Ok(format!("Update {version} installiert — App wird neu gestartet."))
    }

    #[cfg(not(desktop))]
    {
        Err("Updater nur auf Desktop verfügbar.".into())
    }
}

/// List published releases that include a platform installer (for version switching).
#[tauri::command]
pub async fn list_available_versions() -> Result<Vec<AvailableRelease>, String> {
    let client = http_client()?;
    let response = client
        .get(RELEASES_API_URL)
        .send()
        .await
        .map_err(|e| format!("Releases konnten nicht geladen werden: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Releases konnten nicht geladen werden (HTTP {}).",
            response.status()
        ));
    }

    let payload: Vec<GitHubRelease> = response
        .json()
        .await
        .map_err(|e| format!("Release-Antwort ungültig: {e}"))?;

    let mut releases = Vec::new();
    for release in payload {
        if release.draft {
            continue;
        }
        let tag = normalize_tag(&release.tag_name);
        if tag.is_empty() {
            continue;
        }
        if !version_at_least(&tag, MIN_SWITCHABLE_VERSION) {
            continue;
        }
        let Some(installer_url) = pick_installer_url(&release.assets) else {
            continue;
        };
        releases.push(AvailableRelease {
            tag_name: tag,
            published_at: release.published_at.unwrap_or_default(),
            body: release
                .body
                .unwrap_or_else(|| "Keine Details verfügbar.".into()),
            installer_url,
            prerelease: release.prerelease,
        });
    }

    releases.sort_by(|a, b| compare_versions_desc(&a.tag_name, &b.tag_name));
    Ok(releases)
}

/// Download a specific release installer and launch it (upgrade or downgrade).
#[tauri::command]
pub async fn install_specific_version(installer_url: String) -> Result<String, String> {
    if installer_url.trim().is_empty() {
        return Err("Keine Installer-URL angegeben.".into());
    }
    if !(installer_url.starts_with("https://github.com/a-kowalenko/aero-tandem-studio-releases/")
        || installer_url.starts_with("https://objects.githubusercontent.com/"))
    {
        return Err("Installer-URL ist nicht erlaubt.".into());
    }

    let dest = installer_download_path(&installer_url)?;
    download_file(&installer_url, &dest).await?;
    launch_installer(&dest)?;

    Ok(format!(
        "Installer gestartet ({})",
        dest.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("setup")
    ))
}

fn nonempty_notes(notes: Option<&str>) -> Option<String> {
    notes
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Fall back to the GitHub release body when `latest.json` notes are empty.
async fn fetch_release_notes(version: &str) -> Option<String> {
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    let url = format!(
        "https://api.github.com/repos/a-kowalenko/aero-tandem-studio-releases/releases/tags/{tag}"
    );
    let client = http_client().ok()?;
    let response = client.get(&url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let release: GitHubRelease = response.json().await.ok()?;
    nonempty_notes(release.body.as_deref())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("HTTP-Client konnte nicht erstellt werden: {e}"))
}

async fn download_file(url: &str, dest: &PathBuf) -> Result<(), String> {
    let client = http_client()?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download fehlgeschlagen: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download fehlgeschlagen (HTTP {}).",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Download konnte nicht gelesen werden: {e}"))?;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Temp-Ordner konnte nicht erstellt werden: {e}"))?;
    }

    let mut file =
        File::create(dest).map_err(|e| format!("Installer-Datei konnte nicht angelegt werden: {e}"))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Installer-Datei konnte nicht geschrieben werden: {e}"))?;
    Ok(())
}

fn installer_download_path(url: &str) -> Result<PathBuf, String> {
    let name = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(default_installer_name());
    let safe = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    Ok(std::env::temp_dir().join(format!("ats_version_switch_{safe}")))
}

fn default_installer_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "setup.exe"
    }
    #[cfg(target_os = "macos")]
    {
        "setup.dmg"
    }
    #[cfg(target_os = "linux")]
    {
        "setup.AppImage"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "setup.bin"
    }
}

fn launch_installer(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new(path)
            .spawn()
            .map_err(|e| format!("Installer konnte nicht gestartet werden: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Installer konnte nicht geöffnet werden: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(path)
                .map_err(|e| format!("AppImage konnte nicht gelesen werden: {e}"))?;
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o755);
            std::fs::set_permissions(path, perms)
                .map_err(|e| format!("AppImage konnte nicht ausführbar gemacht werden: {e}"))?;
        }
        Command::new(path)
            .spawn()
            .map_err(|e| format!("AppImage konnte nicht gestartet werden: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        Err("Versionswechsel auf dieser Plattform nicht unterstützt.".into())
    }
}

fn normalize_tag(tag: &str) -> String {
    tag.trim().trim_start_matches('v').to_string()
}

/// Loose semver compare: `candidate >= minimum` (numeric segments only).
fn version_at_least(candidate: &str, minimum: &str) -> bool {
    compare_version_parts(&parse_version_parts(candidate), &parse_version_parts(minimum))
        != std::cmp::Ordering::Less
}

fn compare_versions_desc(a: &str, b: &str) -> std::cmp::Ordering {
    compare_version_parts(&parse_version_parts(a), &parse_version_parts(b)).reverse()
}

fn parse_version_parts(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<u64>().ok())
        .collect()
}

fn compare_version_parts(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let len = a.len().max(b.len());
    for i in 0..len {
        let left = a.get(i).copied().unwrap_or(0);
        let right = b.get(i).copied().unwrap_or(0);
        match left.cmp(&right) {
            std::cmp::Ordering::Equal => {}
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

fn pick_installer_url(assets: &[GitHubAsset]) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        assets
            .iter()
            .find(|a| {
                let n = a.name.to_lowercase();
                n.ends_with("-setup.exe") && !n.ends_with(".sig")
            })
            .or_else(|| {
                assets.iter().find(|a| {
                    let n = a.name.to_lowercase();
                    n.ends_with(".exe") && !n.ends_with(".sig")
                })
            })
            .map(|a| a.browser_download_url.clone())
    }
    #[cfg(target_os = "macos")]
    {
        let prefer_arch = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x64"
        };
        assets
            .iter()
            .find(|a| {
                let n = a.name.to_lowercase();
                n.ends_with(".dmg") && n.contains(prefer_arch) && !n.ends_with(".sig")
            })
            .or_else(|| {
                assets.iter().find(|a| {
                    let n = a.name.to_lowercase();
                    n.ends_with(".dmg") && !n.ends_with(".sig")
                })
            })
            .map(|a| a.browser_download_url.clone())
    }
    #[cfg(target_os = "linux")]
    {
        let prefer_arch = |n: &str| {
            n.contains("amd64")
                || n.contains("x86_64")
                || n.contains("x86-64")
                || n.contains("_x64")
                || n.contains("-x64")
        };
        assets
            .iter()
            .find(|a| {
                let n = a.name.to_lowercase();
                n.ends_with(".appimage") && prefer_arch(&n) && !n.ends_with(".sig")
            })
            .or_else(|| {
                assets.iter().find(|a| {
                    let n = a.name.to_lowercase();
                    n.ends_with(".appimage") && !n.ends_with(".sig")
                })
            })
            .map(|a| a.browser_download_url.clone())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = assets;
        None
    }
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_is_configured_for_releases_repo() {
        assert!(is_updater_configured());
        assert!(updater_endpoints()
            .iter()
            .any(|e| e.contains("aero-tandem-studio-releases")));
    }

    #[test]
    fn version_compare_and_filter() {
        assert!(version_at_least("0.1.3", "0.1.0"));
        assert!(version_at_least("0.1.0", "0.1.0"));
        assert!(!version_at_least("0.0.9", "0.1.0"));
        assert_eq!(
            compare_versions_desc("0.1.3", "0.1.2"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn normalize_strips_v_prefix() {
        assert_eq!(normalize_tag("v0.1.3"), "0.1.3");
        assert_eq!(normalize_tag("0.1.3"), "0.1.3");
    }

    #[test]
    fn pick_windows_setup_prefers_nsis() {
        let assets = vec![
            GitHubAsset {
                name: "Aero.Tandem.Studio_0.1.3_x64_en-US.msi".into(),
                browser_download_url: "https://example/msi".into(),
            },
            GitHubAsset {
                name: "Aero.Tandem.Studio_0.1.3_x64-setup.exe".into(),
                browser_download_url: "https://example/setup".into(),
            },
            GitHubAsset {
                name: "Aero.Tandem.Studio_0.1.3_x64-setup.exe.sig".into(),
                browser_download_url: "https://example/sig".into(),
            },
            GitHubAsset {
                name: "Aero.Tandem.Studio_0.1.3_amd64.AppImage".into(),
                browser_download_url: "https://example/appimage".into(),
            },
        ];
        #[cfg(target_os = "windows")]
        {
            assert_eq!(
                pick_installer_url(&assets).as_deref(),
                Some("https://example/setup")
            );
        }
        #[cfg(target_os = "macos")]
        {
            let _ = &assets;
            assert!(pick_installer_url(&[]).is_none());
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(
                pick_installer_url(&assets).as_deref(),
                Some("https://example/appimage")
            );
        }
    }

    #[test]
    fn pick_linux_appimage_prefers_arch_token() {
        let assets = vec![
            GitHubAsset {
                name: "Aero.Tandem.Studio_0.1.7_aarch64.AppImage".into(),
                browser_download_url: "https://example/arm".into(),
            },
            GitHubAsset {
                name: "Aero.Tandem.Studio_0.1.7_amd64.AppImage".into(),
                browser_download_url: "https://example/amd64".into(),
            },
            GitHubAsset {
                name: "Aero.Tandem.Studio_0.1.7_amd64.AppImage.sig".into(),
                browser_download_url: "https://example/sig".into(),
            },
        ];
        #[cfg(target_os = "linux")]
        {
            assert_eq!(
                pick_installer_url(&assets).as_deref(),
                Some("https://example/amd64")
            );
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            // Win/Mac must ignore Linux AppImage assets when no native installer present.
            assert!(pick_installer_url(&assets).is_none());
        }
    }

    #[test]
    fn nonempty_notes_trims_and_rejects_blank() {
        assert_eq!(nonempty_notes(Some("  hello  ")).as_deref(), Some("hello"));
        assert!(nonempty_notes(Some("   ")).is_none());
        assert!(nonempty_notes(Some("")).is_none());
        assert!(nonempty_notes(None).is_none());
    }
}
