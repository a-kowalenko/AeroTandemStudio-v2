//! App-shell commands: startup checks, cache cleanup, version info.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::config::ConfigState;
use crate::storage::cache::{
    cleanup_all, cleanup_orphans_only, collect_work_base_paths, measure_cache_usage,
    CacheCleanupResult, CacheUsageResult,
};
use crate::storage::local_folders::{
    clear_local_backup_folders as clear_backup_folders_impl,
    clear_local_job_folders as clear_job_folders_impl,
    probe_clear_local_backup_folders as probe_backup_folders_impl,
    probe_clear_local_job_folders as probe_job_folders_impl, LocalFolderClearProbe,
};
use crate::storage::logging::{self, log_error, log_info, log_warn, LogEntry};
use crate::storage::vorgang_history::VorgangHistoryStore;
use crate::video::ffmpeg::find_ffmpeg_with_resource_dir;
use crate::video::hw_accel::{detect_hardware, HwAccelInfo};

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub product_name: String,
    pub version: String,
    pub log_path: Option<String>,
    pub config_dir: Option<String>,
    /// Current OS computer name (legacy settings default for `sd_pc_name`).
    pub computer_name: String,
}

#[derive(Debug, Serialize)]
pub struct StartupCheckResult {
    pub ok: bool,
    pub ffmpeg_path: Option<String>,
    pub ffmpeg_error: Option<String>,
    pub hw: Option<HwAccelInfo>,
    pub cache: Option<CacheCleanupResult>,
    pub version: String,
    pub message: String,
    /// Linux: GStreamer / H.264 missing → HTML5 video will not play.
    pub media_warning: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct CleanupCacheArgs {
    pub speicherort: Option<String>,
    pub import_paths: Option<Vec<String>>,
    pub exclude_temp_dir: Option<String>,
    pub include_hw_cache: Option<bool>,
    pub orphans_only: Option<bool>,
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    let log = logging::log_path().map(|p| p.to_string_lossy().into_owned());
    let config_dir = crate::storage::app_config_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    AppInfo {
        product_name: "Aero Tandem Studio".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        log_path: log,
        config_dir,
        computer_name: crate::util::host::current_computer_name(),
    }
}

/// Recent in-memory log lines for the debug console (oldest → newest).
#[tauri::command]
pub fn get_recent_logs(limit: Option<usize>) -> Vec<LogEntry> {
    logging::recent_logs(limit)
}

/// Clear the in-memory console buffer only (`app.log` is kept).
#[tauri::command]
pub fn clear_log_buffer() {
    logging::clear_ring_buffer();
}

/// Current minimum log level (`debug` | `info` | `warn` | `error`).
#[tauri::command]
pub fn get_log_min_level() -> String {
    logging::min_level_name()
}

/// Set minimum log level (persists into config when available).
#[tauri::command]
pub fn set_log_min_level(
    state: State<'_, ConfigState>,
    level: String,
) -> Result<String, String> {
    let name = logging::set_min_level_name(&level);
    let mut cfg = {
        let cache = state.cache.lock().map_err(|e| e.to_string())?;
        cache.clone()
    };
    if cfg.log_min_level != name {
        cfg.log_min_level = name.clone();
        {
            let store = state.store.lock().map_err(|e| e.to_string())?;
            store.save(&cfg).map_err(|e| e.to_string())?;
        }
        {
            let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
            *cache = cfg;
        }
    }
    Ok(name)
}

/// FFmpeg find + HW detect + optional orphan cache sweep (used by SplashScreen).
#[tauri::command]
pub fn run_startup_checks(
    app: AppHandle,
    auto_cleanup: Option<bool>,
) -> Result<StartupCheckResult, String> {
    let version = env!("CARGO_PKG_VERSION").to_string();
    let do_cleanup = auto_cleanup.unwrap_or(true);

    log_info("Startup checks: locating FFmpeg...");
    let resource_dir = app.path().resource_dir().ok();
    let ffmpeg_result = find_ffmpeg_with_resource_dir(resource_dir.as_deref());

    let (ffmpeg_path, ffmpeg_error) = match &ffmpeg_result {
        Ok(p) => {
            log_info(&format!("FFmpeg found: {}", p.display()));
            (Some(p.to_string_lossy().into_owned()), None)
        }
        Err(e) => {
            let msg = e.to_string();
            log_error(&format!("FFmpeg not found: {msg}"));
            (None, Some(msg))
        }
    };

    log_info("Startup checks: detecting hardware encoder...");
    let hw = detect_hardware();
    log_info(&format!(
        "Hardware encoder: {} (available={})",
        hw.encoder, hw.available
    ));

    // Prefer an explicit splash step (`cleanup_cache` orphans_only) so the UI can show
    // "clearing cache…" instead of freezing after Ready (see App.tsx boot).
    // `auto_cleanup: true` still sweeps here for callers that skip the separate step.
    let cache = if do_cleanup {
        log_info("Startup checks: orphan cache sweep (sync)…");
        let result = cleanup_orphans_only(None);
        if result.deleted_dirs.is_empty()
            && result.deleted_files.is_empty()
            && result.errors.is_empty()
        {
            log_info("Startup checks: cache sweep — nothing to remove");
        } else {
            log_info(&format!("Startup checks: cache sweep — {}", result.summary));
        }
        Some(result)
    } else {
        None
    };

    // Deferred SMB staging GC (best-effort; does not block splash on network).
    if let Ok((_store, cfg)) = crate::storage::ConfigStore::open_default() {
        crate::smb::spawn_smb_staging_gc(&cfg.server_login, &cfg.server_password);
    }

    log_info("Startup checks: Linux media (GStreamer)…");
    let media_warning = match crate::media::linux_gst::check_linux_media_playback() {
        crate::media::linux_gst::LinuxMediaStatus::Ok => {
            log_info("GStreamer H.264 decode: OK (or non-Linux)");
            None
        }
        crate::media::linux_gst::LinuxMediaStatus::Warning(msg) => {
            log_warn(&msg);
            Some(msg)
        }
    };

    let ok = ffmpeg_path.is_some();
    let message = if ok {
        format!("Bereit — FFmpeg OK, Encoder {}", hw.encoder)
    } else {
        "FFmpeg nicht gefunden — Encoding nicht möglich.".into()
    };

    if !ok {
        log_warn(&message);
    } else {
        log_info(&message);
    }

    Ok(StartupCheckResult {
        ok,
        ffmpeg_path,
        ffmpeg_error,
        hw: Some(hw),
        cache,
        version,
        message,
        media_warning,
    })
}

#[tauri::command]
pub fn cleanup_cache(
    state: tauri::State<'_, ConfigState>,
    args: Option<CleanupCacheArgs>,
) -> Result<CacheCleanupResult, String> {
    let args = args.unwrap_or(CleanupCacheArgs {
        speicherort: None,
        import_paths: None,
        exclude_temp_dir: None,
        include_hw_cache: Some(false),
        orphans_only: Some(false),
    });

    let exclude = args
        .exclude_temp_dir
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(crate::storage::working_session::get_working_dir);

    let orphans_only = args.orphans_only.unwrap_or(false);
    if orphans_only {
        let result = cleanup_orphans_only(exclude.as_deref());
        log_info(&format!("cleanup_cache (orphans): {}", result.summary));
        return Ok(result);
    }

    let speicherort = args.speicherort.or_else(|| {
        state
            .cache
            .lock()
            .ok()
            .map(|g| g.speicherort.clone())
            .filter(|s| !s.is_empty())
    });

    let import_paths = args.import_paths.unwrap_or_default();
    let bases = collect_work_base_paths(
        speicherort.as_deref(),
        if import_paths.is_empty() {
            None
        } else {
            Some(&import_paths)
        },
    );

    let include_hw = args.include_hw_cache.unwrap_or(false);
    let result = cleanup_all(exclude.as_deref(), Some(&bases), include_hw);
    log_info(&format!("cleanup_cache: {}", result.summary));
    Ok(result)
}

/// Measure cache/temp footprint (same discovery as full cleanup; no deletes).
#[tauri::command]
pub fn measure_cache(
    state: tauri::State<'_, ConfigState>,
    args: Option<CleanupCacheArgs>,
) -> Result<CacheUsageResult, String> {
    let args = args.unwrap_or(CleanupCacheArgs {
        speicherort: None,
        import_paths: None,
        exclude_temp_dir: None,
        include_hw_cache: Some(false),
        orphans_only: Some(false),
    });

    let exclude = args
        .exclude_temp_dir
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(crate::storage::working_session::get_working_dir);

    let speicherort = args.speicherort.or_else(|| {
        state
            .cache
            .lock()
            .ok()
            .map(|g| g.speicherort.clone())
            .filter(|s| !s.is_empty())
    });

    let import_paths = args.import_paths.unwrap_or_default();
    let bases = collect_work_base_paths(
        speicherort.as_deref(),
        if import_paths.is_empty() {
            None
        } else {
            Some(&import_paths)
        },
    );

    // Parity with Settings Clear button (include_hw_cache: false).
    let include_hw = args.include_hw_cache.unwrap_or(false);
    measure_cache_usage(exclude.as_deref(), Some(&bases), include_hw)
}

#[derive(Debug, serde::Deserialize)]
pub struct ClearLocalJobFoldersArgs {
    pub speicherort: Option<String>,
    pub include_orphans: Option<bool>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ClearLocalBackupFoldersArgs {
    pub sd_backup_folder: Option<String>,
}

fn resolve_speicherort(
    state: &ConfigState,
    override_path: Option<String>,
) -> String {
    override_path
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            state
                .cache
                .lock()
                .ok()
                .map(|g| g.speicherort.clone())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_default()
}

fn resolve_sd_backup_folder(
    state: &ConfigState,
    override_path: Option<String>,
) -> String {
    override_path
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            state
                .cache
                .lock()
                .ok()
                .map(|g| g.sd_backup_folder.clone())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_default()
}

/// Probe local Vorgang folders under speicherort (history kept; disk only).
#[tauri::command]
pub fn probe_clear_local_job_folders(
    state: tauri::State<'_, ConfigState>,
    args: Option<ClearLocalJobFoldersArgs>,
) -> Result<LocalFolderClearProbe, String> {
    let args = args.unwrap_or(ClearLocalJobFoldersArgs {
        speicherort: None,
        include_orphans: Some(false),
    });
    let speicherort = resolve_speicherort(&state, args.speicherort);
    let include_orphans = args.include_orphans.unwrap_or(false);
    let store = VorgangHistoryStore::open_default().map_err(|e| e.to_string())?;
    probe_job_folders_impl(&speicherort, &store, include_orphans)
}

/// Delete local Vorgang folders under speicherort; `vorgang_history` unchanged.
#[tauri::command]
pub fn clear_local_job_folders(
    state: tauri::State<'_, ConfigState>,
    args: Option<ClearLocalJobFoldersArgs>,
) -> Result<CacheCleanupResult, String> {
    let args = args.unwrap_or(ClearLocalJobFoldersArgs {
        speicherort: None,
        include_orphans: Some(false),
    });
    let speicherort = resolve_speicherort(&state, args.speicherort);
    let include_orphans = args.include_orphans.unwrap_or(false);
    let store = VorgangHistoryStore::open_default().map_err(|e| e.to_string())?;
    let result = clear_job_folders_impl(&speicherort, &store, include_orphans)?;
    log_info(&format!("clear_local_job_folders: {}", result.summary));
    Ok(result)
}

/// Probe direct child folders under `sd_backup_folder`.
#[tauri::command]
pub fn probe_clear_local_backup_folders(
    state: tauri::State<'_, ConfigState>,
    args: Option<ClearLocalBackupFoldersArgs>,
) -> Result<LocalFolderClearProbe, String> {
    let args = args.unwrap_or(ClearLocalBackupFoldersArgs {
        sd_backup_folder: None,
    });
    let root = resolve_sd_backup_folder(&state, args.sd_backup_folder);
    Ok(probe_backup_folders_impl(&root))
}

/// Delete direct child folders under `sd_backup_folder`; media-history hashes kept.
#[tauri::command]
pub fn clear_local_backup_folders(
    state: tauri::State<'_, ConfigState>,
    args: Option<ClearLocalBackupFoldersArgs>,
) -> Result<CacheCleanupResult, String> {
    let args = args.unwrap_or(ClearLocalBackupFoldersArgs {
        sd_backup_folder: None,
    });
    let root = resolve_sd_backup_folder(&state, args.sd_backup_folder);
    let result = clear_backup_folders_impl(&root);
    log_info(&format!("clear_local_backup_folders: {}", result.summary));
    Ok(result)
}

/// After an auto-update restart, bring the main window to the foreground.
#[tauri::command]
pub fn focus_main_window_after_update(app: AppHandle) -> bool {
    crate::util::window_focus::focus_main_window_if_update_restart(&app)
}
