//! Tauri commands for config and customer validation.

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::model::{validate_kunde, Kunde, ValidationResult};
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
