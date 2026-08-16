//! Vorgang (created customer) history commands.

use std::path::Path;

use tauri::State;

use crate::commands::config::ConfigState;
use crate::storage::logging;
use crate::storage::vorgang_history::{
    AmsHandoffStatusUpdate, VorgangEntry, VorgangFileEntry, VorgangHistoryStore,
};
use crate::video::handoff_manifest::{
    share_root_from_job_dir, OutboxAmsMeta, OutboxError, StatusOutboxV1,
};

fn open_store() -> Result<VorgangHistoryStore, String> {
    VorgangHistoryStore::open_default().map_err(|e| e.to_string())
}

fn read_config(state: &ConfigState) -> Result<crate::storage::config::AppConfig, String> {
    state
        .cache
        .lock()
        .map_err(|e| e.to_string())
        .map(|c| c.clone())
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
pub fn list_vorgaenge(
    limit: Option<u32>,
    search: Option<String>,
) -> Result<Vec<VorgangEntry>, String> {
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
}

#[tauri::command]
pub fn list_vorgang_dateien(vorgang_id: i64) -> Result<Vec<VorgangFileEntry>, String> {
    let store = open_store()?;
    store
        .list_files(vorgang_id)
        .map_err(|e| e.to_string())
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
    let job_dir = Path::new(base_output_dir.trim());
    let Some(share_root) = share_root_from_job_dir(job_dir) else {
        return Ok(cached_or_pending(&store, vorgang_id, &cid, true));
    };
    let config = read_config(&state)?;
    match crate::bridge::resolve_handoff_status(&config, &cid, &share_root).await {
        Ok(Some((job, source))) => {
            persist_live_status(&store, vorgang_id, &job, source);
            Ok(Some(HandoffStatusDto::from_outbox(job, source, false)))
        }
        Ok(None) => Ok(cached_or_pending(&store, vorgang_id, &cid, false)),
        Err(e) => {
            logging::warn(
                "vorgang_history",
                format!("AMS-Status live fehlgeschlagen, Cache: {e}"),
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
