//! Auto-update helpers (Tauri updater plugin).
//!
//! Production feed: public releases repo
//! `a-kowalenko/aero-tandem-studio-releases` → `latest.json`.
//!
//! Signing: `TAURI_SIGNING_PRIVATE_KEY` (+ password) in CI; pubkey in
//! `tauri.conf.json` → `plugins.updater.pubkey`.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// Marker substring that means “stub / not ready” (keep for safety if config regresses).
pub const UPDATER_STUB_MARKER: &str = "releases.example.invalid";

const UPDATER_ENDPOINT: &str =
    "https://github.com/a-kowalenko/aero-tandem-studio-releases/releases/latest/download/latest.json";

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
            message: "Updater konfiguriert — Prüfung über GitHub Releases möglich.".into(),
        }
    } else {
        UpdaterStatus {
            configured: false,
            current_version,
            message: "Updater-Stub: Endpoint noch Platzhalter (releases.example.invalid)."
                .into(),
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
            message: "Update-Prüfung übersprungen: Endpoint ist Platzhalter \
(releases.example.invalid)."
                .into(),
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
            Ok(Some(update)) => Ok(UpdateCheckResult {
                configured: true,
                available: true,
                current_version,
                latest_version: Some(update.version.clone()),
                body: update.body.clone(),
                message: format!("Update verfügbar: {}", update.version),
            }),
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

/// Download + install a pending update (plugin API).
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    if !is_updater_configured() {
        return Err(
            "Update-Installation nicht möglich: Update-Endpoint ist noch Platzhalter."
                .into(),
        );
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
        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|e| format!("Update-Installation fehlgeschlagen: {e}"))?;

        Ok(format!("Update {version} installiert — App wird neu gestartet."))
    }

    #[cfg(not(desktop))]
    {
        Err("Updater nur auf Desktop verfügbar.".into())
    }
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
}
