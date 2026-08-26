//! Vorgang (created customer) history commands.

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::config::{ensure_ams_bridge_identity, ConfigState};
use crate::storage::logging;
use crate::storage::vorgang_history::{
    AmsHandoffStatusUpdate, VorgangAppendEntry, VorgangEntry, VorgangFileEntry, VorgangHistoryStore,
};
use crate::video::append_job::{self, AppendJobResult, AppendMediaItem};
use crate::video::ffmpeg::{find_ffmpeg_with_resource_dir, reset_cancel_flag};
use crate::video::handoff_manifest::{
    handoff_share_roots, read_status_outbox_any, OutboxAmsMeta, OutboxError, StatusOutboxV1,
};
use crate::video::progress::EncodeProgress;
use crate::video::upload_preflight::{
    preflight_vorgang_upload as run_upload_preflight, UploadPreflightInput, UploadPreflightResult,
};

fn open_store() -> Result<VorgangHistoryStore, String> {
    VorgangHistoryStore::open_default().map_err(|e| e.to_string())
}

async fn blocking_hist<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn read_config(state: &ConfigState) -> Result<crate::storage::config::AppConfig, String> {
    ensure_ams_bridge_identity(state)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HandoffStatusDto {
    pub correlation_id: String,
    pub state: String,
    pub updated_at: String,
    pub error: Option<OutboxError>,
    pub ams: OutboxAmsMeta,
    /// `bridge` | `outbox` | `cached` | `local` — where the status was resolved from.
    pub source: String,
    /// Live Bridge/Outbox could not be read this round; payload may be cached.
    pub offline: bool,
}

impl HandoffStatusDto {
    fn from_outbox(v: StatusOutboxV1, source: &str, offline: bool) -> Self {
        Self {
            correlation_id: v.correlation_id,
            state: v.state,
            updated_at: v.updated_at,
            error: v.error,
            ams: v.ams,
            source: source.to_string(),
            offline,
        }
    }

    fn from_cached(correlation_id: &str, cached: AmsHandoffStatusUpdate, offline: bool) -> Self {
        let error = if cached.error_code.trim().is_empty() && cached.error_message.trim().is_empty()
        {
            None
        } else {
            Some(OutboxError {
                code: cached.error_code,
                message: cached.error_message,
            })
        };
        Self {
            correlation_id: correlation_id.to_string(),
            state: cached.state,
            updated_at: cached.updated_at,
            error,
            ams: OutboxAmsMeta {
                history_id: None,
                archive: if cached.archive.trim().is_empty() {
                    None
                } else {
                    Some(cached.archive)
                },
            },
            source: if cached.source.trim().is_empty() {
                "cached".into()
            } else {
                cached.source
            },
            offline,
        }
    }

    fn pending_local(correlation_id: &str) -> Self {
        Self {
            correlation_id: correlation_id.to_string(),
            state: "pending".into(),
            updated_at: String::new(),
            error: None,
            ams: OutboxAmsMeta::default(),
            source: "local".into(),
            offline: false,
        }
    }
}

fn is_ams_cancelled_update(update: &AmsHandoffStatusUpdate) -> bool {
    let state = update.state.trim().to_ascii_lowercase();
    let code = update.error_code.trim().to_ascii_lowercase();
    state == "cancelled"
        || state == "canceled"
        || code == "cancelled"
        || code == "canceled"
}

fn live_state_reopens_cancelled(live_state: &str, live_error_code: &str) -> bool {
    let state = live_state.trim().to_ascii_lowercase();
    let code = live_error_code.trim().to_ascii_lowercase();
    if state == "cancelled"
        || state == "canceled"
        || code == "cancelled"
        || code == "canceled"
        || state == "rejected"
        || state == "failed"
    {
        return false;
    }
    // pending/accepted/queued/uploading/completed after ATS cancel → keep local cancelled
    true
}

fn prefer_cached_cancelled(
    store: &VorgangHistoryStore,
    vorgang_id: Option<i64>,
    cid: &str,
    live_state: &str,
    live_error_code: &str,
) -> Option<HandoffStatusDto> {
    let Ok(Some(cached)) = store.get_cached_ams_status(vorgang_id, cid) else {
        return None;
    };
    if !is_ams_cancelled_update(&cached) {
        return None;
    }
    if !live_state_reopens_cancelled(live_state, live_error_code) {
        return None;
    }
    Some(HandoffStatusDto::from_cached(cid, cached, false))
}

fn resolve_live_or_cached_cancelled(
    store: &VorgangHistoryStore,
    vorgang_id: Option<i64>,
    job: StatusOutboxV1,
    source: &str,
) -> HandoffStatusDto {
    let live_code = job
        .error
        .as_ref()
        .map(|e| e.code.as_str())
        .unwrap_or("");
    if let Some(cached) =
        prefer_cached_cancelled(store, vorgang_id, &job.correlation_id, &job.state, live_code)
    {
        logging::debug(
            "vorgang_history",
            format!(
                "AMS-Live-Status {} ignoriert — lokal bereits cancelled (correlation_id={})",
                job.state.trim(),
                job.correlation_id.trim()
            ),
        );
        return cached;
    }
    persist_live_status(store, vorgang_id, &job, source);
    HandoffStatusDto::from_outbox(job, source, false)
}

fn persist_live_status(
    store: &VorgangHistoryStore,
    vorgang_id: Option<i64>,
    job: &StatusOutboxV1,
    source: &str,
) {
    let update = AmsHandoffStatusUpdate {
        state: job.state.clone(),
        updated_at: job.updated_at.clone(),
        error_code: job
            .error
            .as_ref()
            .map(|e| e.code.clone())
            .unwrap_or_default(),
        error_message: job
            .error
            .as_ref()
            .map(|e| e.message.clone())
            .unwrap_or_default(),
        archive: job.ams.archive.clone().unwrap_or_default(),
        source: source.to_string(),
    };
    if let Err(e) = store.update_ams_handoff_status(vorgang_id, &job.correlation_id, &update) {
        logging::warn(
            "vorgang_history",
            format!("AMS-Status konnte nicht persistiert werden: {e}"),
        );
    }
}

fn cached_or_pending(
    store: &VorgangHistoryStore,
    vorgang_id: Option<i64>,
    cid: &str,
    offline: bool,
) -> Option<HandoffStatusDto> {
    match store.get_cached_ams_status(vorgang_id, cid) {
        Ok(Some(cached)) => Some(HandoffStatusDto::from_cached(cid, cached, offline)),
        Ok(None) => {
            if cid.is_empty() {
                None
            } else {
                Some(HandoffStatusDto::pending_local(cid))
            }
        }
        Err(e) => {
            logging::warn(
                "vorgang_history",
                format!("AMS-Cache lesen fehlgeschlagen: {e}"),
            );
            if cid.is_empty() {
                None
            } else {
                Some(HandoffStatusDto::pending_local(cid))
            }
        }
    }
}

#[tauri::command]
pub async fn list_vorgaenge(
    limit: Option<u32>,
    search: Option<String>,
) -> Result<Vec<VorgangEntry>, String> {
    blocking_hist(move || {
        let store = open_store()?;
        let entries = store
            .list_vorgaenge(limit.unwrap_or(500) as usize, search.as_deref())
            .map_err(|e| e.to_string())?;
        logging::debug(
            "vorgang_history",
            format!(
                "Vorgänge geladen: {}{}",
                entries.len(),
                search
                    .as_ref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(" (Suche: {s})"))
                    .unwrap_or_default()
            ),
        );
        Ok(entries)
    })
    .await
}

#[tauri::command]
pub async fn list_vorgang_dateien(vorgang_id: i64) -> Result<Vec<VorgangFileEntry>, String> {
    blocking_hist(move || {
        let store = open_store()?;
        store.list_files(vorgang_id).map_err(|e| e.to_string())
    })
    .await
}

/// Read AMS status: Bridge `GET /v1/jobs/{id}` first, else Outbox file (P1b).
/// Persists last-known status when `vorgang_id` is set; falls back to cache if live is unavailable.
#[tauri::command]
pub async fn get_handoff_status(
    state: State<'_, ConfigState>,
    correlation_id: String,
    base_output_dir: String,
    vorgang_id: Option<i64>,
) -> Result<Option<HandoffStatusDto>, String> {
    let cid = correlation_id.trim().to_string();
    if cid.is_empty() {
        return Ok(None);
    }
    let store = open_store()?;
    let config = read_config(&state)?;
    let job_dir = Path::new(base_output_dir.trim());
    let mut share_roots = handoff_share_roots(job_dir, &config.speicherort);
    if let Some(id) = vorgang_id {
        if let Ok(Some(vorgang)) = store.get_by_id(id) {
            let main_dir = vorgang.base_output_dir.trim();
            if !main_dir.is_empty() {
                for root in handoff_share_roots(Path::new(main_dir), &config.speicherort) {
                    if !share_roots.iter().any(|r| r == &root) {
                        share_roots.push(root);
                    }
                }
            }
        }
    }
    let offline_hint = share_roots.is_empty() && !crate::bridge::bridge_configured(&config);

    if crate::bridge::bridge_configured(&config) {
        if let Ok(base) = crate::bridge::resolve_bridge_base_url(&config) {
            let identity = crate::bridge::build_ats_bridge_identity(&config);
            match crate::bridge::fetch_job_status(
                &base,
                &config.ams_bridge_token,
                &cid,
                &identity,
            )
            .await
            {
                Ok(Some(job)) => {
                    return Ok(Some(resolve_live_or_cached_cancelled(
                        &store, vorgang_id, job, "bridge",
                    )));
                }
                Ok(None) => {}
                Err(e) if e.contains("nicht erreichbar") => {}
                Err(e) => {
                    logging::warn(
                        "vorgang_history",
                        format!("AMS-Bridge Job-Status fehlgeschlagen, Outbox-Fallback: {e}"),
                    );
                }
            }
        }
    }

    match read_status_outbox_any(&share_roots, &cid) {
        Ok(Some(job)) => Ok(Some(resolve_live_or_cached_cancelled(
            &store, vorgang_id, job, "outbox",
        ))),
        Ok(None) => Ok(cached_or_pending(
            &store,
            vorgang_id,
            &cid,
            offline_hint,
        )),
        Err(e) => {
            logging::warn(
                "vorgang_history",
                format!("AMS-Outbox lesen fehlgeschlagen, Cache: {e}"),
            );
            Ok(cached_or_pending(&store, vorgang_id, &cid, true))
        }
    }
}

#[tauri::command]
pub fn delete_vorgaenge(ids: Vec<i64>) -> Result<(), String> {
    logging::info(
        "vorgang_history",
        format!("Lösche {} Vorgang/Vorgänge", ids.len()),
    );
    let store = open_store()?;
    store.delete_by_ids(&ids).map_err(|e| {
        let msg = e.to_string();
        logging::error(
            "vorgang_history",
            format!("Vorgänge löschen fehlgeschlagen: {msg}"),
        );
        msg
    })?;
    Ok(())
}

/// Update SMB upload lifecycle (`none` / `pending` / `uploading` / `done` / `failed`).
#[tauri::command]
pub fn set_vorgang_upload_state(
    vorgang_id: Option<i64>,
    correlation_id: Option<String>,
    upload_state: String,
) -> Result<(), String> {
    let store = open_store()?;
    store
        .update_upload_state(
            vorgang_id,
            correlation_id.as_deref().unwrap_or(""),
            &upload_state,
        )
        .map_err(|e| e.to_string())
}

/// Prefight local job folder against `_ams_manifest.v1.json` before SMB retry (Phase 31.2).
#[tauri::command]
pub fn preflight_vorgang_upload(vorgang_id: i64) -> Result<UploadPreflightResult, String> {
    let store = open_store()?;
    let entry = store
        .get_by_id(vorgang_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Vorgang {vorgang_id} nicht gefunden."))?;
    Ok(run_upload_preflight(&UploadPreflightInput {
        base_output_dir: &entry.base_output_dir,
        correlation_id: &entry.correlation_id,
        upload_state: &entry.upload_state,
        ams_state: &entry.ams_state,
    }))
}

#[tauri::command]
pub async fn list_vorgang_appends(vorgang_id: i64) -> Result<Vec<VorgangAppendEntry>, String> {
    blocking_hist(move || {
        let store = open_store()?;
        store.list_appends(vorgang_id).map_err(|e| e.to_string())
    })
    .await
}

/// Copy extra media into a new `aktuell` staging folder and signal AMS (append handoff).
#[tauri::command]
pub async fn create_append_job(
    app: AppHandle,
    state: State<'_, ConfigState>,
    vorgang_id: i64,
    items: Vec<AppendMediaItem>,
) -> Result<AppendJobResult, String> {
    logging::info(
        "append",
        format!(
            "Nachreichung starten: vorgang_id={vorgang_id}, dateien={}",
            items.len()
        ),
    );
    reset_cancel_flag();
    let store = open_store()?;
    let vorgang = store
        .get_by_id(vorgang_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Vorgang nicht gefunden.".to_string())?;
    if vorgang.correlation_id.trim().is_empty() {
        return Err("Dieser Vorgang hat keinen AMS-Handoff.".into());
    }
    let state_ok = vorgang.ams_state.trim().to_ascii_lowercase();
    if state_ok != "completed" {
        return Err(format!(
            "Nachreichen erst nach erfolgreichem AMS-Upload (Status: {}).",
            if vorgang.ams_state.trim().is_empty() {
                "wartend"
            } else {
                vorgang.ams_state.trim()
            }
        ));
    }

    let resource_dir = app.path().resource_dir().ok();
    let ffmpeg = find_ffmpeg_with_resource_dir(resource_dir.as_deref()).map_err(|e| e.to_string())?;
    let config = read_config(&state)?;
    let config_for_ready = config.clone();
    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let mut result = tauri::async_runtime::spawn_blocking(move || {
        append_job::create_append_job(
            &ffmpeg,
            &vorgang,
            &items,
            &config,
            resource_dir.as_deref(),
            on_progress,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let local_folder_path = result.folder_path.clone();

    if config_for_ready.upload_to_server {
        if crate::video::ffmpeg::is_cancelled() {
            return Err(crate::video::ffmpeg::WORKFLOW_CANCELLED.into());
        }
        logging::info(
            "append",
            format!("Nachreichung auf Server kopieren: {}", result.folder_name),
        );
        let local_folder = result.folder_path.clone();
        let app_for_progress = app.clone();
        let uploaded = crate::smb::upload_path(
            Path::new(&local_folder),
            &config_for_ready.server_url,
            &config_for_ready.server_login,
            &config_for_ready.server_password,
            move |progress| {
                let event =
                    crate::commands::smb::UploadProgressEvent::from(progress);
                let _ = app_for_progress.emit(crate::commands::smb::UPLOAD_PROGRESS_EVENT, &event);
            },
        )
        .await;
        if !uploaded.success {
            let cancelled = crate::smb::upload_failure_is_cancelled(&uploaded.message);
            if cancelled {
                logging::warn(
                    "append",
                    format!(
                        "Nachreichung-Upload abgebrochen ({}): {}",
                        result.folder_name, uploaded.message
                    ),
                );
            } else {
                logging::error(
                    "append",
                    format!(
                        "Nachreichung-Upload fehlgeschlagen ({}): {}",
                        result.folder_name, uploaded.message
                    ),
                );
            }
            if cancelled {
                let handoff = crate::smb::HandoffUploadContext {
                    correlation_id: Some(result.correlation_id.clone()),
                    folder_name: Some(result.folder_name.clone()),
                };
                crate::smb::abort_handoff_upload(
                    &config_for_ready,
                    Path::new(&local_folder),
                    &handoff,
                    &config_for_ready.server_url,
                    &config_for_ready.server_login,
                    &config_for_ready.server_password,
                )
                .await;
            }
            return Err(uploaded.message);
        }
        logging::info(
            "append",
            format!(
                "Nachreichung auf Server kopiert: {}",
                uploaded.remote_path
            ),
        );
        result.folder_path = uploaded.remote_path;
    }

    let append_id = match store.record_append(
        vorgang_id,
        &result.correlation_id,
        &result.folder_name,
        &result.folder_path,
        result.file_count as i64,
        result.preview_count as i64,
        &result.categories,
    ) {
        Ok(id) => Some(id),
        Err(e) => {
            logging::warn(
                "append",
                format!("Nachreichung-Historie nicht gespeichert: {e}"),
            );
            None
        }
    };

    if let Some(append_id) = append_id {
        if let Err(e) = store.record_append_files(
            append_id,
            vorgang_id,
            Path::new(&local_folder_path),
        ) {
            logging::warn(
                "append",
                format!("Nachreichung-Dateien nicht in Historie gespeichert: {e}"),
            );
        }
    }

    if !result.correlation_id.trim().is_empty() {
        match crate::bridge::maybe_notify_handoff_ready(
            &config_for_ready,
            &result.correlation_id,
            Some(&result.folder_name),
        )
        .await
        {
            Ok(Some(_)) => logging::info(
                "bridge",
                format!(
                    "AMS handoff/ready (append) correlation_id={}",
                    result.correlation_id
                ),
            ),
            Ok(None) => {}
            Err(e) => logging::warn("bridge", format!("handoff/ready append: {e}")),
        }
    }

    Ok(result)
}
