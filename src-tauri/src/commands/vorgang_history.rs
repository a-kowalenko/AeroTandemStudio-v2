//! Vorgang (created customer) history commands.

use crate::storage::logging;
use crate::storage::vorgang_history::{VorgangEntry, VorgangFileEntry, VorgangHistoryStore};

fn open_store() -> Result<VorgangHistoryStore, String> {
    VorgangHistoryStore::open_default().map_err(|e| e.to_string())
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
