//! Tauri commands for config and customer validation.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

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

/// When the frontend saves settings it does not edit hidden bridge identity fields; merge from cache/disk.
fn preserve_ams_bridge_identity(state: &ConfigState, config: &mut AppConfig) -> Result<(), String> {
    preserve_ams_bridge_instance_id(state, config)?;
    preserve_cloud_lookup_token(state, config)?;
    if !config.ams_bridge_display_name.trim().is_empty()
        && !config.ams_bridge_server_instance_id.trim().is_empty()
    {
        return Ok(());
    }
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        config.preserve_ams_bridge_server_identity_from(&cache);
    }
    if config.ams_bridge_display_name.trim().is_empty()
        || config.ams_bridge_server_instance_id.trim().is_empty()
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        if let Ok(disk) = store.load() {
            config.preserve_ams_bridge_server_identity_from(&disk);
        }
    }
    Ok(())
}

/// Frontend settings saves omit Cloud-Lookup JWT fields; keep them from cache/disk.
fn preserve_cloud_lookup_token(state: &ConfigState, config: &mut AppConfig) -> Result<(), String> {
    if !config.cloud_lookup_access_token.trim().is_empty() {
        return Ok(());
    }
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        config.preserve_cloud_lookup_token_from(&cache);
        if !config.cloud_lookup_access_token.trim().is_empty() {
            return Ok(());
        }
    }
    let store = state.store.lock().map_err(|e| e.to_string())?;
    if let Ok(disk) = store.load() {
        config.preserve_cloud_lookup_token_from(&disk);
    }
    Ok(())
}

/// When the frontend saves settings it does not edit `ams_bridge_instance_id`; merge from cache/disk.
fn preserve_ams_bridge_instance_id(
    state: &ConfigState,
    config: &mut AppConfig,
) -> Result<(), String> {
    if !config.ams_bridge_instance_id.trim().is_empty() {
        return Ok(());
    }
    {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        config.preserve_ams_bridge_instance_id_from(&cache);
        if !config.ams_bridge_instance_id.trim().is_empty() {
            return Ok(());
        }
    }
    let store = state.store.lock().map_err(|e| e.to_string())?;
    if let Ok(disk) = store.load() {
        config.preserve_ams_bridge_instance_id_from(&disk);
    }
    Ok(())
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

/// Run `f` on the blocking pool with the managed [`ConfigState`] (SQLite writes stay off the main thread).
pub(crate) async fn with_config_state<T, F>(app: AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&ConfigState) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(app.state::<ConfigState>().inner()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_config(app: AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    with_config_state(app, move |state| {
        let mut config = config;
        preserve_ams_bridge_identity(state, &mut config)?;
        config.sync_auto_cleanup_retention();
        {
            let store = state.store.lock().map_err(|e| e.to_string())?;
            store.save(&config).map_err(|e| e.to_string())?;
        }
        {
            let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
            *cache = config.clone();
        }
        Ok(config)
    })
    .await
}

#[tauri::command]
pub async fn reload_config(app: AppHandle) -> Result<AppConfig, String> {
    with_config_state(app, |state| {
        let cfg = {
            let store = state.store.lock().map_err(|e| e.to_string())?;
            store.load().map_err(|e| e.to_string())?
        };
        {
            let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
            *cache = cfg.clone();
        }
        Ok(cfg)
    })
    .await
}

/// Persist factory defaults (`AppConfig::default`) and refresh the in-memory cache.
#[tauri::command]
pub async fn reset_config(app: AppHandle) -> Result<AppConfig, String> {
    with_config_state(app, |state| {
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
    })
    .await
}

#[tauri::command]
pub async fn get_config_paths() -> Result<ConfigPathInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = crate::storage::app_config_dir().map_err(|e| e.to_string())?;
        let db = crate::storage::config_db_path().map_err(|e| e.to_string())?;
        Ok(ConfigPathInfo {
            config_dir: dir.to_string_lossy().into_owned(),
            db_path: db.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
    let manual_entry_mode = state
        .cache
        .lock()
        .map_err(|e| e.to_string())?
        .manual_entry_mode
        .clone();
    let paths = video_paths.unwrap_or_default();
    Ok(validate_kunde(
        &kunde,
        &paths,
        oldschool,
        crate::model::require_api_ids(&kunde, &manual_entry_mode),
    ))
}

#[tauri::command(rename = "propose_default_media_dirs")]
pub async fn propose_default_media_dirs_cmd() -> Result<DefaultMediaDirsProposal, String> {
    tauri::async_runtime::spawn_blocking(|| propose_default_media_dirs().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command(rename = "ensure_default_media_dir")]
pub async fn ensure_default_media_dirs_cmd(
    kind: DefaultMediaDirKind,
    root: Option<String>,
) -> Result<EnsureDefaultMediaDirResult, String> {
    let override_root = root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_default_media_dir(kind, override_root.as_deref()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
