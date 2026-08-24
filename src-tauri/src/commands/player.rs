//! Tauri commands for the optional mpv player backend (OPT-13).

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::media::http_server::MediaServerState;
use crate::player::{self, MpvAvailability, MpvSessionInfo, SessionSnapshot};
use crate::commands::config::ConfigState;

#[tauri::command]
pub fn mpv_player_status(
    app: AppHandle,
    config: State<'_, ConfigState>,
) -> Result<MpvAvailability, String> {
    let resource_dir = app.path().resource_dir().ok();
    player::session::set_global_resource_dir(resource_dir.clone());
    let mut avail = player::mpv_availability(resource_dir.as_deref());
    let use_flag = config
        .cache
        .lock()
        .map(|c| c.use_libmpv)
        .unwrap_or(true);
    if !use_flag {
        avail.available = false;
        avail.backend = "none".into();
        avail.detail = "use_libmpv disabled — HTML5 fallback".into();
    }
    Ok(avail)
}

#[tauri::command]
pub fn mpv_player_open(
    app: AppHandle,
    path: String,
) -> Result<MpvSessionInfo, String> {
    let resource_dir = app.path().resource_dir().ok();
    player::session::set_global_resource_dir(resource_dir);
    let p = PathBuf::from(&path);
    player::session::with_manager(|mgr| mgr.open(&p))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mpv_player_close(session_id: u64) -> Result<(), String> {
    player::session::with_manager(|mgr| mgr.close(session_id))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mpv_player_seek(session_id: u64, ms: f64) -> Result<SessionSnapshot, String> {
    player::session::with_manager(|mgr| mgr.seek_ms(session_id, ms))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mpv_player_play(session_id: u64) -> Result<SessionSnapshot, String> {
    player::session::with_manager(|mgr| mgr.play(session_id))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mpv_player_pause(session_id: u64) -> Result<SessionSnapshot, String> {
    player::session::with_manager(|mgr| mgr.pause(session_id))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mpv_player_set_volume(
    session_id: u64,
    volume: f64,
    muted: bool,
) -> Result<(), String> {
    player::session::with_manager(|mgr| mgr.set_volume(session_id, volume, muted))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mpv_player_tick(session_id: u64) -> Result<SessionSnapshot, String> {
    player::session::with_manager(|mgr| mgr.tick(session_id))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mpv_player_snapshot(session_id: u64) -> Result<SessionSnapshot, String> {
    player::session::with_manager(|mgr| mgr.snapshot(session_id))?
        .map_err(|e| e.to_string())
}

/// Loopback HTTP URL for the current JPEG frame (working-copy sibling temp file).
#[tauri::command]
pub fn mpv_player_frame_url(
    session_id: u64,
    frame_rev: u64,
    media: State<'_, MediaServerState>,
) -> Result<String, String> {
    let path = player::session::with_manager(|mgr| mgr.frame_path(session_id))?
        .map_err(|e| e.to_string())?;
    let mut url = media.url_for_path(&path.display().to_string());
    url.push_str(&format!("?rev={frame_rev}"));
    Ok(url)
}

/// Whether config prefers mpv when available (does not probe the binary).
#[tauri::command]
pub fn mpv_player_config_enabled(config: State<'_, ConfigState>) -> Result<bool, String> {
    let cfg = config.cache.lock().map_err(|e| e.to_string())?;
    Ok(cfg.use_libmpv)
}
