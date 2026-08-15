//! Vorgang (created customer) history commands.

use std::path::Path;

use tauri::State;

use crate::commands::config::ConfigState;
use crate::storage::logging;
use crate::storage::vorgang_history::{VorgangEntry, VorgangFileEntry, VorgangHistoryStore};
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
    /// `bridge` | `outbox` — where the status was resolved from.
    pub source: String,
}

impl HandoffStatusDto {
    fn from_outbox(v: StatusOutboxV1, source: &str) -> Self {
        Self {
            correlation_id: v.correlation_id,
            state: v.state,
            updated_at: v.updated_at,
            error: v.error,
            ams: v.ams,
            source: source.to_string(),
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
#[tauri::command]
pub async fn get_handoff_status(
    state: State<'_, ConfigState>,
    correlation_id: String,
    base_output_dir: String,
) -> Result<Option<HandoffStatusDto>, String> {
    let cid = correlation_id.trim().to_string();
    if cid.is_empty() {
        return Ok(None);
    }
    let job_dir = Path::new(base_output_dir.trim());
    let Some(share_root) = share_root_from_job_dir(job_dir) else {
        return Ok(None);
    };
    let config = read_config(&state)?;
    Ok(
        crate::bridge::resolve_handoff_status(&config, &cid, &share_root)
            .await?
            .map(|(job, source)| HandoffStatusDto::from_outbox(job, source)),
    )
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
