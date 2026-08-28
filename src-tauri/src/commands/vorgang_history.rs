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
    delete_extra_files_from_disk, handoff_share_roots, read_status_outbox_any,
    resync_integrity_from_disk, DeleteExtraFilesReport, DeliveryResyncReport, OutboxAmsMeta,
    OutboxError, StatusOutboxV1,
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
    /// When ATS last successfully read Bridge/Outbox for this response.
    pub verified_at: String,
    pub error: Option<OutboxError>,
    pub ams: OutboxAmsMeta,
    /// `bridge` | `outbox` | `cached` | `local` — where the status was resolved from.
    pub source: String,
    /// Live Bridge/Outbox could not be read this round; payload may be cached.
    pub offline: bool,
}

impl HandoffStatusDto {
    fn from_outbox(
        v: StatusOutboxV1,
        source: &str,
        offline: bool,
        verified_at: String,
    ) -> Self {
        Self {
            correlation_id: v.correlation_id,
            state: v.state,
            updated_at: v.updated_at,
            verified_at,
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
            verified_at: cached.verified_at,
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
            verified_at: String::new(),
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

fn is_live_terminal_problem(state: &str, error_code: &str) -> bool {
    let state = state.trim().to_ascii_lowercase();
    let code = error_code.trim().to_ascii_lowercase();
    state == "cancelled"
        || state == "canceled"
        || state == "rejected"
        || state == "failed"
        || code == "cancelled"
        || code == "canceled"
}

/// When AMS Historie says „Abgebrochen“ but the share outbox still says `completed`, ATS must see cancel.
fn normalize_cancelled_outbox_state(job: &mut StatusOutboxV1) {
    let code = job
        .error
        .as_ref()
        .map(|e| e.code.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if code == "cancelled" || code == "canceled" {
        job.state = "cancelled".into();
    }
}

/// AMS may move a job to an "Abgebrochen" archive while outbox `state` still says completed.
fn apply_archive_cancelled_hint(job: &mut StatusOutboxV1) {
    let state = job.state.trim().to_ascii_lowercase();
    if is_live_terminal_problem(&state, "") {
        return;
    }
    let code = job
        .error
        .as_ref()
        .map(|e| e.code.as_str())
        .unwrap_or("");
    if is_live_terminal_problem("", code) {
        return;
    }
    let archive = job
        .ams
        .archive
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !archive.contains("abgebrochen") {
        return;
    }
    job.state = "cancelled".into();
    let needs_error = job
        .error
        .as_ref()
        .map(|e| e.code.trim().is_empty() && e.message.trim().is_empty())
        .unwrap_or(true);
    if needs_error {
        job.error = Some(OutboxError {
            code: "cancelled".into(),
            message: "Abgebrochen".into(),
        });
    }
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
    mut job: StatusOutboxV1,
    source: &str,
) -> HandoffStatusDto {
    apply_archive_cancelled_hint(&mut job);
    normalize_cancelled_outbox_state(&mut job);
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
    let verified_at = persist_live_status(store, vorgang_id, &job, source);
    HandoffStatusDto::from_outbox(job, source, false, verified_at)
}

fn persist_live_status(
    store: &VorgangHistoryStore,
    vorgang_id: Option<i64>,
    job: &StatusOutboxV1,
    source: &str,
) -> String {
    let verified_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let update = AmsHandoffStatusUpdate {
        state: job.state.clone(),
        updated_at: job.updated_at.clone(),
        verified_at: verified_at.clone(),
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
    verified_at
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
async fn resolve_handoff_status(
    store: &VorgangHistoryStore,
    config: &crate::storage::config::AppConfig,
    correlation_id: &str,
    base_output_dir: &str,
    vorgang_id: Option<i64>,
) -> Result<Option<HandoffStatusDto>, String> {
    let cid = correlation_id.trim();
    if cid.is_empty() {
        return Ok(None);
    }
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
    let offline_hint = share_roots.is_empty() && !crate::bridge::bridge_configured(config);

    if crate::bridge::bridge_configured(config) {
        if let Ok(base) = crate::bridge::resolve_bridge_base_url(config) {
            let identity = crate::bridge::build_ats_bridge_identity(config);
            match crate::bridge::fetch_job_status(
                &base,
                &config.ams_bridge_token,
                cid,
                &identity,
            )
            .await
            {
                Ok(Some(job)) => {
                    return Ok(Some(resolve_live_or_cached_cancelled(
                        store, vorgang_id, job, "bridge",
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

    match read_status_outbox_any(&share_roots, cid) {
        Ok(Some(job)) => Ok(Some(resolve_live_or_cached_cancelled(
            store, vorgang_id, job, "outbox",
        ))),
        Ok(None) => Ok(cached_or_pending(store, vorgang_id, cid, offline_hint)),
        Err(e) => {
            logging::warn(
                "vorgang_history",
                format!("AMS-Outbox lesen fehlgeschlagen, Cache: {e}"),
            );
            Ok(cached_or_pending(store, vorgang_id, cid, true))
        }
    }
}

fn is_ams_handoff_settled(entry: &VorgangEntry) -> bool {
    let state = entry.ams_state.trim().to_ascii_lowercase();
    if matches!(
        state.as_str(),
        "completed" | "rejected" | "failed" | "cancelled" | "canceled"
    ) {
        return true;
    }
    let code = entry.ams_error_code.trim().to_ascii_lowercase();
    code == "cancelled" || code == "canceled"
}

fn job_folder_missing(base_output_dir: &str) -> bool {
    let path = base_output_dir.trim();
    path.is_empty() || !Path::new(path).is_dir()
}

fn should_sync_handoff_entry(entry: &VorgangEntry) -> bool {
    if entry.correlation_id.trim().is_empty() {
        return false;
    }
    // Re-verify completed — AMS may cancel or re-archive after ATS recorded success.
    if entry
        .ams_state
        .trim()
        .eq_ignore_ascii_case("completed")
    {
        return true;
    }
    if entry.upload_state.trim().eq_ignore_ascii_case("none") {
        return false;
    }
    if is_ams_handoff_settled(entry) {
        return false;
    }
    if job_folder_missing(&entry.base_output_dir) {
        return entry.upload_state.trim().eq_ignore_ascii_case("done");
    }
    true
}

fn handoff_dto_changed(entry: &VorgangEntry, dto: &HandoffStatusDto) -> bool {
    if dto.state.trim() != entry.ams_state.trim() {
        return true;
    }
    let live_code = dto
        .error
        .as_ref()
        .map(|e| e.code.as_str())
        .unwrap_or("");
    if live_code.trim() != entry.ams_error_code.trim() {
        return true;
    }
    let live_archive = dto.ams.archive.as_deref().unwrap_or("");
    live_archive.trim() != entry.ams_archive.trim()
}

#[tauri::command]
pub async fn get_handoff_status(
    state: State<'_, ConfigState>,
    correlation_id: String,
    base_output_dir: String,
    vorgang_id: Option<i64>,
) -> Result<Option<HandoffStatusDto>, String> {
    let store = open_store()?;
    let config = read_config(&state)?;
    resolve_handoff_status(
        &store,
        &config,
        &correlation_id,
        &base_output_dir,
        vorgang_id,
    )
    .await
}

/// Batch-sync unsettled AMS handoffs (bridge/outbox); works when local folders were removed post-upload.
#[tauri::command]
pub async fn sync_open_handoffs(
    state: State<'_, ConfigState>,
    limit: Option<u32>,
) -> Result<u32, String> {
    let store = open_store()?;
    let config = read_config(&state)?;
    let entries = store
        .list_vorgaenge(limit.unwrap_or(500) as usize, None)
        .map_err(|e| e.to_string())?;
    let mut updated = 0u32;
    for entry in entries {
        if !should_sync_handoff_entry(&entry) {
            continue;
        }
        match resolve_handoff_status(
            &store,
            &config,
            &entry.correlation_id,
            &entry.base_output_dir,
            Some(entry.id),
        )
        .await
        {
            Ok(Some(dto)) if handoff_dto_changed(&entry, &dto) => updated += 1,
            Ok(_) => {}
            Err(e) => logging::warn(
                "vorgang_history",
                format!("sync_open_handoffs id={}: {e}", entry.id),
            ),
        }
    }
    if updated > 0 {
        logging::info(
            "vorgang_history",
            format!("sync_open_handoffs: {updated} AMS-Status aktualisiert"),
        );
    }
    Ok(updated)
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

#[derive(Debug, Clone, serde::Deserialize)]
pub struct VorgangFolderProbeItem {
    pub vorgang_id: i64,
    pub base_output_dir: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct VorgangFolderProbeResult {
    pub vorgang_id: i64,
    pub folder_missing: bool,
}

/// Batch probe: is each Vorgang's `base_output_dir` still present on disk?
#[tauri::command]
pub fn probe_vorgang_folders(
    items: Vec<VorgangFolderProbeItem>,
) -> Result<Vec<VorgangFolderProbeResult>, String> {
    Ok(items
        .into_iter()
        .map(|item| VorgangFolderProbeResult {
            vorgang_id: item.vorgang_id,
            folder_missing: job_folder_missing(&item.base_output_dir),
        })
        .collect())
}

/// Reset stale `uploading` rows to `pending` when no upload-slot job covers them.
#[tauri::command]
pub fn reconcile_stale_uploads(active_vorgang_ids: Vec<i64>) -> Result<u32, String> {
    let store = open_store()?;
    store
        .reconcile_stale_uploads(&active_vorgang_ids)
        .map_err(|e| e.to_string())
}

/// Update SMB upload lifecycle
/// (`none` / `pending` / `uploading` / `done` / `failed` / `cancelled`).
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

/// Align manifest delivery list with files currently in the job folder (Phase 31.4).
#[tauri::command]
pub fn resync_vorgang_delivery_list(vorgang_id: i64) -> Result<DeliveryResyncReport, String> {
    let store = open_store()?;
    let entry = store
        .get_by_id(vorgang_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Vorgang {vorgang_id} nicht gefunden."))?;
    let job_dir = Path::new(entry.base_output_dir.trim());
    if entry.base_output_dir.trim().is_empty() || !job_dir.is_dir() {
        return Err(format!(
            "Ausgabeordner fehlt: {}",
            entry.base_output_dir.trim()
        ));
    }
    let report = resync_integrity_from_disk(job_dir)?;
    if !report.removed_paths.is_empty() {
        logging::info(
            "upload",
            format!(
                "Lieferliste angepasst: vorgang_id={vorgang_id}, entfernt={}",
                report.removed_paths.len()
            ),
        );
    }
    Ok(report)
}

/// Delete extra payload files listed by upload preflight before SMB retry (Phase 31.5).
#[tauri::command]
pub fn delete_vorgang_extra_files(
    vorgang_id: i64,
    relative_paths: Vec<String>,
) -> Result<DeleteExtraFilesReport, String> {
    if relative_paths.is_empty() {
        return Ok(DeleteExtraFilesReport {
            deleted_paths: Vec::new(),
        });
    }
    let store = open_store()?;
    let entry = store
        .get_by_id(vorgang_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Vorgang {vorgang_id} nicht gefunden."))?;
    let job_dir = Path::new(entry.base_output_dir.trim());
    if entry.base_output_dir.trim().is_empty() || !job_dir.is_dir() {
        return Err(format!(
            "Ausgabeordner fehlt: {}",
            entry.base_output_dir.trim()
        ));
    }
    let report = delete_extra_files_from_disk(job_dir, &relative_paths)?;
    if !report.deleted_paths.is_empty() {
        logging::info(
            "upload",
            format!(
                "Extra-Dateien gelöscht: vorgang_id={vorgang_id}, count={}",
                report.deleted_paths.len()
            ),
        );
    }
    Ok(report)
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
    let app_for_cb = app.clone();
    let on_progress: crate::video::ffmpeg::ProgressCallback = Arc::new(move |p: EncodeProgress| {
        let _ = app_for_cb.emit("encode-progress", &p);
    });

    let result = tauri::async_runtime::spawn_blocking(move || {
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

    // Local staging only. SMB upload runs via the shared frontend upload slot
    // (Phase 37.3) so Append does not hold the session for transfer.
    let local_folder_path = result.folder_path.clone();

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

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        apply_archive_cancelled_hint, job_folder_missing, probe_vorgang_folders,
        should_sync_handoff_entry, VorgangFolderProbeItem,
    };
    use crate::storage::vorgang_history::VorgangEntry;
    use crate::video::handoff_manifest::{OutboxAmsMeta, StatusOutboxV1};
    use std::fs;
    use tempfile::tempdir;

    fn handoff_test_entry(
        upload_state: &str,
        ams_state: &str,
        base_output_dir: &str,
    ) -> VorgangEntry {
        VorgangEntry {
            id: 1,
            created_at: String::new(),
            gast: String::new(),
            vorname: None,
            nachname: None,
            kunden_id: None,
            booking_id: None,
            kunden_id_hash: None,
            booking_id_hash: None,
            datum: String::new(),
            ort: String::new(),
            tandemmaster: String::new(),
            videospringer: String::new(),
            video_mode: String::new(),
            form_mode: String::new(),
            manual_entry_mode: String::new(),
            handcam_foto: false,
            handcam_video: false,
            outside_foto: false,
            outside_video: false,
            ist_bezahlt_handcam_foto: false,
            ist_bezahlt_handcam_video: false,
            ist_bezahlt_outside_foto: false,
            ist_bezahlt_outside_video: false,
            base_output_dir: base_output_dir.into(),
            base_filename: String::new(),
            encoder: String::new(),
            intro_created: false,
            body_clips: 0,
            photos_copied: 0,
            watermark_photos: 0,
            marker_path: String::new(),
            reused_preview: false,
            qr_preview: None,
            file_count: 0,
            correlation_id: "abc".into(),
            ams_state: ams_state.into(),
            ams_updated_at: String::new(),
            ams_verified_at: String::new(),
            ams_error_code: String::new(),
            ams_error_message: String::new(),
            ams_archive: String::new(),
            ams_source: String::new(),
            upload_state: upload_state.into(),
            append_count: 0,
            last_append_correlation_id: String::new(),
            last_append_ams_state: String::new(),
            last_append_ams_error_code: String::new(),
            last_append_ams_error_message: String::new(),
            last_append_folder_path: String::new(),
        }
    }

    #[test]
    fn should_sync_handoff_entry_rules() {
        let mut entry = handoff_test_entry("done", "pending", "/nonexistent/job");
        assert!(should_sync_handoff_entry(&entry));
        entry.upload_state = "pending".into();
        assert!(!should_sync_handoff_entry(&entry));
        entry.ams_state = "completed".into();
        assert!(should_sync_handoff_entry(&entry));
        entry.ams_state = "cancelled".into();
        assert!(!should_sync_handoff_entry(&entry));
        entry.upload_state = "none".into();
        entry.ams_state = "pending".into();
        assert!(!should_sync_handoff_entry(&entry));
        entry.ams_state = "completed".into();
        assert!(should_sync_handoff_entry(&entry));
    }

    #[test]
    fn apply_archive_cancelled_hint_from_abgebrochen_path() {
        let mut job = StatusOutboxV1 {
            schema: 1,
            correlation_id: "abc".into(),
            updated_at: String::new(),
            state: "completed".into(),
            error: None,
            ams: OutboxAmsMeta {
                history_id: None,
                archive: Some(
                    r"C:\Archiv\2 Abgebrochen\20260826_Andreas_Kowalenko".into(),
                ),
            },
            extensions: serde_json::json!({}),
        };
        apply_archive_cancelled_hint(&mut job);
        assert_eq!(job.state, "cancelled");
        assert_eq!(
            job.error.as_ref().map(|e| e.code.as_str()),
            Some("cancelled")
        );
    }

    #[test]
    fn probe_vorgang_folders_detects_missing_and_present() {
        let dir = tempdir().unwrap();
        let present = dir.path().join("job");
        fs::create_dir(&present).unwrap();
        let rows = probe_vorgang_folders(vec![
            VorgangFolderProbeItem {
                vorgang_id: 1,
                base_output_dir: present.to_string_lossy().into_owned(),
            },
            VorgangFolderProbeItem {
                vorgang_id: 2,
                base_output_dir: dir.path().join("gone").to_string_lossy().into_owned(),
            },
            VorgangFolderProbeItem {
                vorgang_id: 3,
                base_output_dir: String::new(),
            },
        ])
        .unwrap();
        assert!(!rows[0].folder_missing);
        assert!(rows[1].folder_missing);
        assert!(rows[2].folder_missing);
        assert!(job_folder_missing(""));
        assert!(job_folder_missing("/path/that/does/not/exist/for/ats"));
    }
}
