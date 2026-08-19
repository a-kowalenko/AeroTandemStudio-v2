//! Tauri commands for config and customer validation.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::model::{validate_kunde, Kunde, ValidationResult};
use crate::storage::default_media_dirs::{
    ensure_default_media_dir, propose_default_media_dirs, DefaultMediaDirKind,
    DefaultMediaDirsProposal, EnsureDefaultMediaDirResult,
};
use crate::storage::{AppConfig, ConfigStore};

pub struct ConfigState {
    pub store: Mutex<ConfigStore>,
    pub cache: Mutex<AppConfig>,
}

impl ConfigState {
    pub fn new() -> Result<Self, String> {
        let (store, cfg) = ConfigStore::open_default().map_err(|e| e.to_string())?;
        Ok(Self {
            store: Mutex::new(store),
            cache: Mutex::new(cfg),
        })
    }
}

pub fn ensure_ams_bridge_identity(state: &ConfigState) -> Result<AppConfig, String> {
    let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
    if !cache.ensure_ams_bridge_instance_id() {
        return Ok(cache.clone());
    }
    let cfg = cache.clone();
    drop(cache);
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.save(&cfg).map_err(|e| e.to_string())?;
    }
    {
        let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
        *cache = cfg.clone();
    }
    Ok(cfg)
}

#[derive(Debug, Serialize)]
pub struct ConfigPathInfo {
    pub config_dir: String,
    pub db_path: String,
}

#[tauri::command]
pub fn get_config(state: State<'_, ConfigState>) -> Result<AppConfig, String> {
    let cache = state.cache.lock().map_err(|e| e.to_string())?;
    Ok(cache.clone())
}

#[tauri::command]
pub fn save_config(state: State<'_, ConfigState>, config: AppConfig) -> Result<AppConfig, String> {
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.save(&config).map_err(|e| e.to_string())?;
    }
    {
        let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
        *cache = config.clone();
    }
    Ok(config)
}

#[tauri::command]
pub fn reload_config(state: State<'_, ConfigState>) -> Result<AppConfig, String> {
    let cfg = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.load().map_err(|e| e.to_string())?
    };
    {
        let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
        *cache = cfg.clone();
    }
    Ok(cfg)
}

/// Persist factory defaults (`AppConfig::default`) and refresh the in-memory cache.
#[tauri::command]
pub fn reset_config(state: State<'_, ConfigState>) -> Result<AppConfig, String> {
    let config = AppConfig::default();
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.save(&config).map_err(|e| e.to_string())?;
    }
    {
        let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
        *cache = config.clone();
    }
    Ok(config)
}

#[tauri::command]
pub fn get_config_paths() -> Result<ConfigPathInfo, String> {
    let dir = crate::storage::app_config_dir().map_err(|e| e.to_string())?;
    let db = crate::storage::config_db_path().map_err(|e| e.to_string())?;
    Ok(ConfigPathInfo {
        config_dir: dir.to_string_lossy().into_owned(),
        db_path: db.to_string_lossy().into_owned(),
    })
}

#[tauri::command(rename = "validate_kunde")]
pub fn validate_kunde_cmd(
    state: State<'_, ConfigState>,
    kunde: Kunde,
    video_paths: Option<Vec<String>>,
    oldschool_mode: Option<bool>,
) -> Result<ValidationResult, String> {
    let oldschool = if let Some(v) = oldschool_mode {
        v
    } else {
        state
            .cache
            .lock()
            .map_err(|e| e.to_string())?
            .oldschool_mode
    };
    let paths = video_paths.unwrap_or_default();
    Ok(validate_kunde(&kunde, &paths, oldschool))
}

#[tauri::command(rename = "propose_default_media_dirs")]
pub fn propose_default_media_dirs_cmd() -> Result<DefaultMediaDirsProposal, String> {
    propose_default_media_dirs().map_err(|e| e.to_string())
}

#[tauri::command(rename = "ensure_default_media_dir")]
pub fn ensure_default_media_dirs_cmd(
    kind: DefaultMediaDirKind,
    root: Option<String>,
) -> Result<EnsureDefaultMediaDirResult, String> {
    let override_root = root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    ensure_default_media_dir(kind, override_root.as_deref()).map_err(|e| e.to_string())
}
