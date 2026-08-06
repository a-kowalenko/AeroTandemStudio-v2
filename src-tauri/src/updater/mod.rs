//! Auto-update helpers (Tauri updater plugin + stub when not configured).
//!
//! Production update feed is **not** live yet. Configure:
//!
//! 1. Private key: `src-tauri/keys/updater.key` (gitignored) — password in
//!    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when signing builds
//! 2. Public key: already in `tauri.conf.json` → `plugins.updater.pubkey`
//! 3. Replace the stub endpoint containing `releases.example.invalid` with your
//!    `latest.json` URL(s), and update `updater_endpoints()` in this module so
//!    `is_updater_configured()` returns true
//!
//! Until the endpoint is real, `check_for_updates` returns `configured: false`
//! and the UI still shows an Update-Dialog (install disabled).

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// Marker substring in the configured endpoint that means “stub / not ready”.
pub const UPDATER_STUB_MARKER: &str = "releases.example.invalid";

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
    vec![
        "https://releases.example.invalid/aero-tandem-studio/{{target}}/{{arch}}/{{current_version}}"
            .to_string(),
    ]
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
            message: "Updater konfiguriert — Prüfung über Plugin möglich.".into(),
        }
    } else {
        UpdaterStatus {
            configured: false,
            current_version,
            message: "Updater-Stub: Endpoint noch nicht gesetzt (releases.example.invalid). Siehe updater/mod.rs.".into(),
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
(releases.example.invalid). Pubkey ist gesetzt — Endpoint in tauri.conf.json ersetzen."
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

/// Download + install a pending update (plugin API). No-op stub when unconfigured.
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
