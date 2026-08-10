//! SD card monitoring, DCIM detection, and backup coordination
//! (port of legacy `sd_card_monitor.py`).

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;
use thiserror::Error;

use crate::media::datetime::resolve_video_display_epoch;
use crate::media::dji_paths::{
    collect_media_paths_from_tree, expand_files_for_sd_clear, filter_media_paths_for_backup,
    is_photo_ext, is_video_ext, media_type_from_filename, resolve_drive_dcim_path,
    unique_dest_name, write_backup_manifest, ManifestEntry,
};
use crate::sd_card::copy_progress::copy_file_with_progress;
use crate::storage::media_history::MediaHistoryStore;
use crate::storage::AppConfig;
use crate::util::file_times::get_mtime_timestamp;

pub const EVENT_SD_INSERTED: &str = "sd-card-inserted";
pub const EVENT_SD_REMOVED: &str = "sd-card-removed";
pub const EVENT_BACKUP_PROGRESS: &str = "sd-backup-progress";
pub const EVENT_BACKUP_STATUS: &str = "sd-backup-status";
pub const EVENT_WORKFLOW_PROGRESS: &str = "sd-workflow-progress";
#[allow(dead_code)]
pub const EVENT_BACKUP_CONFIRM: &str = "sd-backup-confirmation-required";
#[allow(dead_code)]
pub const EVENT_SIZE_LIMIT: &str = "sd-size-limit-exceeded";

#[derive(Debug, Error)]
pub enum SdError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct SdDriveInfo {
    pub drive: String,
    pub dcim_path: String,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SdFileInfo {
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub is_video: bool,
    pub mtime: f64,
    pub display_epoch: f64,
    pub already_processed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListSdFilesResult {
    pub drive: String,
    pub files: Vec<SdFileInfo>,
    pub total_size_mb: f64,
    pub total_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupProgress {
    pub current_mb: f64,
    pub total_mb: f64,
    pub speed_mbps: f64,
    pub percent: f64,
}

/// File-count progress for clear / import (i/n).
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowProgress {
    /// `"clear"` | `"import"`
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub percent: f64,
    pub label: String,
}

pub fn workflow_progress(stage: &str, current: u64, total: u64, label: &str) -> WorkflowProgress {
    let percent = if total > 0 {
        ((current as f64 / total as f64) * 100.0).min(100.0)
    } else {
        0.0
    };
    WorkflowProgress {
        stage: stage.to_string(),
        current,
        total,
        percent,
        label: label.to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupResult {
    pub success: bool,
    pub backup_path: Option<String>,
    pub error_message: Option<String>,
    pub copied_count: usize,
    pub skipped_count: usize,
    /// Destination paths inside the primary backup folder (for import after clear).
    pub copied_dest_paths: Vec<String>,
    /// Source paths on the SD card that were successfully copied.
    pub copied_source_paths: Vec<String>,
    /// Second backup root folder when dual-write succeeded.
    pub secondary_backup_path: Option<String>,
    /// Soft-fail message for the optional second path (primary may still succeed).
    pub secondary_warning: Option<String>,
}

impl BackupResult {
    fn fail(msg: impl Into<String>, skipped: usize) -> Self {
        Self {
            success: false,
            backup_path: None,
            error_message: Some(msg.into()),
            copied_count: 0,
            skipped_count: skipped,
            copied_dest_paths: Vec::new(),
            copied_source_paths: Vec::new(),
            secondary_backup_path: None,
            secondary_warning: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportSdResult {
    pub imported_videos: Vec<String>,
    pub imported_photos: Vec<String>,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SdInsertedPayload {
    pub drive: String,
    pub file_count: usize,
    pub total_size_mb: f64,
    pub needs_confirmation: bool,
    pub size_limit_exceeded: bool,
    pub limit_mb: u32,
    /// True when the card was just plugged in (not merely present at monitor start).
    pub hotplug: bool,
}

type ProgressCb = Arc<dyn Fn(BackupProgress) + Send + Sync>;
type WorkflowCb = Arc<dyn Fn(WorkflowProgress) + Send + Sync>;
type StatusCb = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;
type InsertedCb = Arc<dyn Fn(SdInsertedPayload) + Send + Sync>;
type RemovedCb = Arc<dyn Fn(Vec<String>) + Send + Sync>;

pub struct SdCardMonitor {
    monitoring: AtomicBool,
    known_drives: Mutex<HashSet<String>>,
    action_cam_drives: Mutex<HashSet<String>>,
    pending_drives: Mutex<HashSet<String>>,
    declined_drives: Mutex<HashSet<String>>,
    processed_drives: Mutex<HashSet<String>>,
    processing_drives: Mutex<HashSet<String>>,
    backup_in_progress: AtomicBool,
    history: Mutex<MediaHistoryStore>,
    config_provider: Mutex<Box<dyn Fn() -> AppConfig + Send>>,
    on_progress: Mutex<Option<ProgressCb>>,
    on_workflow: Mutex<Option<WorkflowCb>>,
    on_status: Mutex<Option<StatusCb>>,
    on_inserted: Mutex<Option<InsertedCb>>,
    on_removed: Mutex<Option<RemovedCb>>,
}

pub static SD_MONITOR: Lazy<Arc<SdCardMonitor>> = Lazy::new(|| {
    Arc::new(SdCardMonitor::new(|| AppConfig::default()).expect("media history init"))
});

impl SdCardMonitor {
    pub fn new<F>(config_provider: F) -> Result<Self, SdError>
    where
        F: Fn() -> AppConfig + Send + 'static,
    {
        let history = MediaHistoryStore::open_default()
            .map_err(|e| SdError::Message(e.to_string()))?;
        Ok(Self {
            monitoring: AtomicBool::new(false),
            known_drives: Mutex::new(HashSet::new()),
            action_cam_drives: Mutex::new(HashSet::new()),
            pending_drives: Mutex::new(HashSet::new()),
            declined_drives: Mutex::new(HashSet::new()),
            processed_drives: Mutex::new(HashSet::new()),
            processing_drives: Mutex::new(HashSet::new()),
            backup_in_progress: AtomicBool::new(false),
            history: Mutex::new(history),
            config_provider: Mutex::new(Box::new(config_provider)),
            on_progress: Mutex::new(None),
            on_workflow: Mutex::new(None),
            on_status: Mutex::new(None),
            on_inserted: Mutex::new(None),
            on_removed: Mutex::new(None),
        })
    }

    pub fn set_config_provider<F>(&self, provider: F)
    where
        F: Fn() -> AppConfig + Send + 'static,
    {
        if let Ok(mut g) = self.config_provider.lock() {
            *g = Box::new(provider);
        }
    }

    pub fn set_callbacks(
        &self,
        on_progress: Option<ProgressCb>,
        on_workflow: Option<WorkflowCb>,
        on_status: Option<StatusCb>,
        on_inserted: Option<InsertedCb>,
        on_removed: Option<RemovedCb>,
    ) {
        *self.on_progress.lock().unwrap() = on_progress;
        *self.on_workflow.lock().unwrap() = on_workflow;
        *self.on_status.lock().unwrap() = on_status;
        *self.on_inserted.lock().unwrap() = on_inserted;
        *self.on_removed.lock().unwrap() = on_removed;
    }

    fn emit_workflow(&self, progress: WorkflowProgress) {
        if let Some(cb) = self.on_workflow.lock().unwrap().as_ref() {
            cb(progress);
        }
    }

    fn config(&self) -> AppConfig {
        (self.config_provider.lock().unwrap())()
    }

    pub fn is_monitoring(&self) -> bool {
        self.monitoring.load(Ordering::SeqCst)
    }

    #[allow(dead_code)]
    pub fn current_drives(&self) -> Vec<String> {
        self.action_cam_drives
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect()
    }

    pub fn start_monitoring(self: &Arc<Self>) {
        if self.monitoring.swap(true, Ordering::SeqCst) {
            return;
        }

        let ready: HashSet<String> = available_drives()
            .into_iter()
            .filter(|d| is_drive_ready(d))
            .collect();
        *self.known_drives.lock().unwrap() = ready.clone();

        // Scan already-inserted action cams (no auto-backup on start).
        for drive in ready_action_cam_drives(&ready) {
            self.pending_drives.lock().unwrap().insert(drive.clone());
            self.action_cam_drives.lock().unwrap().insert(drive.clone());
            self.emit_inserted(&drive, false, false);
        }

        let this = Arc::clone(self);
        thread::spawn(move || this.monitor_loop());
        self.emit_status("monitoring_started", serde_json::json!(true));
    }

    pub fn stop_monitoring(&self) {
        self.monitoring.store(false, Ordering::SeqCst);
        self.emit_status("monitoring_stopped", serde_json::json!(false));
    }

    fn monitor_loop(self: Arc<Self>) {
        while self.monitoring.load(Ordering::SeqCst) {
            if let Err(e) = self.poll_once() {
                eprintln!("SD monitor error: {e}");
            }
            thread::sleep(Duration::from_secs(2));
        }
    }

    fn poll_once(&self) -> Result<(), SdError> {
        let current = available_drives();
        let ready: HashSet<String> = current.into_iter().filter(|d| is_drive_ready(d)).collect();
        let current_action = ready_action_cam_drives(&ready);

        let known = self.known_drives.lock().unwrap().clone();
        let previous_action = self.action_cam_drives.lock().unwrap().clone();

        let new_drives: HashSet<_> = ready.difference(&known).cloned().collect();
        let newly_action: HashSet<_> = current_action.difference(&previous_action).cloned().collect();

        let mut candidates = HashSet::new();
        for d in &new_drives {
            if current_action.contains(d) {
                candidates.insert(d.clone());
            }
        }
        candidates.extend(newly_action);

        for drive in candidates {
            if self.processed_drives.lock().unwrap().contains(&drive) {
                continue;
            }
            if self.processing_drives.lock().unwrap().contains(&drive) {
                continue;
            }
            if self.declined_drives.lock().unwrap().contains(&drive) {
                continue;
            }
            let is_new = new_drives.contains(&drive);
            self.handle_sd_detection(&drive, is_new);
        }

        let lost: Vec<String> = previous_action
            .difference(&current_action)
            .cloned()
            .collect();
        if !lost.is_empty() {
            self.notify_removed(&lost);
        }

        *self.action_cam_drives.lock().unwrap() = current_action;
        self.cleanup_removed(&ready);
        *self.known_drives.lock().unwrap() = ready;
        Ok(())
    }

    fn handle_sd_detection(&self, drive: &str, is_new_insertion: bool) {
        self.pending_drives.lock().unwrap().insert(drive.to_string());
        let mode = self.config().sd_backup_mode;

        // Frontend orchestrates backup/import/clear for both auto and confirm.
        let needs_confirmation = mode == "confirm" || (mode == "auto" && !is_new_insertion);
        self.emit_inserted(
            drive,
            needs_confirmation && mode != "disabled",
            is_new_insertion,
        );

        if mode == "disabled" {
            return;
        }

        if mode == "auto" && is_new_insertion {
            // Auto pipeline runs in the UI (settings-driven, no file dialog).
            return;
        }

        // confirm (or auto on already-present): frontend shows file selector
        let info = gather_drive_info(drive);
        self.emit_status(
            "backup_confirmation_required",
            serde_json::json!({
                "drive": info.0,
                "file_count": info.1,
                "total_size_mb": info.2,
            }),
        );
    }

    fn emit_inserted(&self, drive: &str, needs_confirmation: bool, hotplug: bool) {
        let cfg = self.config();
        let (file_count, total_mb) = {
            let info = gather_drive_info(drive);
            (info.1, info.2)
        };
        let size_limit_exceeded =
            cfg.sd_size_limit_enabled && total_mb > f64::from(cfg.sd_size_limit_mb);
        let payload = SdInsertedPayload {
            drive: drive.to_string(),
            file_count,
            total_size_mb: total_mb,
            needs_confirmation,
            size_limit_exceeded,
            limit_mb: cfg.sd_size_limit_mb,
            hotplug,
        };
        if let Some(cb) = self.on_inserted.lock().unwrap().as_ref() {
            cb(payload);
        }
    }

    fn notify_removed(&self, drives: &[String]) {
        for d in drives {
            self.pending_drives.lock().unwrap().remove(d);
            self.declined_drives.lock().unwrap().remove(d);
            self.processed_drives.lock().unwrap().remove(d);
            self.processing_drives.lock().unwrap().remove(d);
        }
        if let Some(cb) = self.on_removed.lock().unwrap().as_ref() {
            cb(drives.to_vec());
        }
    }

    fn cleanup_removed(&self, ready: &HashSet<String>) {
        let mut pending = self.pending_drives.lock().unwrap();
        let mut declined = self.declined_drives.lock().unwrap();
        let mut processed = self.processed_drives.lock().unwrap();
        let mut action = self.action_cam_drives.lock().unwrap();
        let mut processing = self.processing_drives.lock().unwrap();

        let tracked: HashSet<_> = pending
            .union(&declined)
            .cloned()
            .collect::<HashSet<_>>()
            .union(&processed)
            .cloned()
            .collect();
        let removed: Vec<_> = tracked.difference(ready).cloned().collect();
        for d in &removed {
            pending.remove(d);
            declined.remove(d);
            processed.remove(d);
            action.remove(d);
            processing.remove(d);
        }
        if !removed.is_empty() {
            drop(pending);
            drop(declined);
            drop(processed);
            drop(action);
            drop(processing);
            if let Some(cb) = self.on_removed.lock().unwrap().as_ref() {
                cb(removed);
            }
        }
    }

    fn emit_status(&self, kind: &str, data: serde_json::Value) {
        if let Some(cb) = self.on_status.lock().unwrap().as_ref() {
            cb(kind, data);
        }
    }

    pub fn decline_drive(&self, drive: &str) {
        self.declined_drives.lock().unwrap().insert(drive.to_string());
        self.pending_drives.lock().unwrap().remove(drive);
        self.processing_drives.lock().unwrap().remove(drive);
    }

    pub fn mark_processed(&self, drive: &str) {
        self.processed_drives.lock().unwrap().insert(drive.to_string());
        self.pending_drives.lock().unwrap().remove(drive);
        self.processing_drives.lock().unwrap().remove(drive);
    }

    /// List media files on an SD drive (or any path with DCIM).
    pub fn list_files(&self, drive: &str) -> Result<ListSdFilesResult, SdError> {
        let dcim = resolve_drive_dcim_path(drive);
        let dcim_path = PathBuf::from(&dcim);
        if !dcim_path.is_dir() {
            return Err(SdError::Message(format!("DCIM nicht gefunden: {dcim}")));
        }

        let cfg = self.config();
        let all = collect_media_paths_from_tree(&dcim_path);
        let (filtered, _) =
            filter_media_paths_for_backup(&all, &dcim, true);

        let history = self.history.lock().unwrap();
        let mut files = Vec::new();
        let mut total: u64 = 0;

        for path in filtered {
            let pb = PathBuf::from(&path);
            let meta = match fs::metadata(&pb) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size = meta.len();
            total += size;
            let filename = pb
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let ext = pb
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{}", e.to_ascii_lowercase()))
                .unwrap_or_default();
            let already = if cfg.sd_skip_processed {
                MediaHistoryStore::compute_identity(&pb)
                    .ok()
                    .and_then(|(h, _)| history.contains(&h).ok())
                    .unwrap_or(false)
            } else {
                MediaHistoryStore::compute_identity(&pb)
                    .ok()
                    .and_then(|(h, _)| history.contains(&h).ok())
                    .unwrap_or(false)
            };
            let mtime = get_mtime_timestamp(&pb).unwrap_or(0.0);
            let display_epoch = resolve_video_display_epoch(&pb, Some(mtime), None);
            files.push(SdFileInfo {
                path,
                filename,
                size_bytes: size,
                is_video: is_video_ext(&ext),
                mtime,
                display_epoch,
                already_processed: already,
            });
        }

        files.sort_by(|a, b| {
            b.display_epoch
                .partial_cmp(&a.display_epoch)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(ListSdFilesResult {
            drive: drive.to_string(),
            total_size_mb: total as f64 / (1024.0 * 1024.0),
            total_size_bytes: total,
            files,
        })
    }

    /// Backup SD card media to configured folder (flat structure + manifest).
    pub fn backup_drive(
        &self,
        drive: &str,
        selected_files: Option<Vec<String>>,
    ) -> Result<BackupResult, SdError> {
        self.backup_drive_with_options(drive, selected_files, None)
    }

    /// `clear_after`: `None` uses config `sd_clear_after_backup`; `Some(v)` overrides.
    pub fn backup_drive_with_options(
        &self,
        drive: &str,
        selected_files: Option<Vec<String>>,
        clear_after: Option<bool>,
    ) -> Result<BackupResult, SdError> {
        if self.backup_in_progress.swap(true, Ordering::SeqCst) {
            return Err(SdError::Message("Backup läuft bereits".into()));
        }
        let result = self.backup_drive_inner(drive, selected_files, clear_after);
        self.backup_in_progress.store(false, Ordering::SeqCst);
        if result.as_ref().map(|r| r.success).unwrap_or(false) {
            self.mark_processed(drive);
        }
        self.emit_status(
            "backup_finished",
            serde_json::json!({
                "success": result.as_ref().map(|r| r.success).unwrap_or(false),
                "drive": drive,
                "backup_path": result.as_ref().ok().and_then(|r| r.backup_path.clone()),
            }),
        );
        result
    }

    fn backup_drive_inner(
        &self,
        drive: &str,
        selected_files: Option<Vec<String>>,
        clear_after: Option<bool>,
    ) -> Result<BackupResult, SdError> {
        let cfg = self.config();
        let backup_folder = cfg.sd_backup_folder.trim().to_string();
        if backup_folder.is_empty() || !Path::new(&backup_folder).is_dir() {
            return Ok(BackupResult::fail(
                format!("Ungültiger Backup-Ordner: {backup_folder}"),
                0,
            ));
        }

        self.emit_status("backup_started", serde_json::json!(drive));

        let dcim = resolve_drive_dcim_path(drive);
        let dcim_path = PathBuf::from(&dcim);
        if !dcim_path.is_dir() {
            return Ok(BackupResult::fail(
                format!("DCIM Ordner nicht gefunden: {dcim}"),
                0,
            ));
        }

        let media_files: Vec<String> = if let Some(selected) = selected_files {
            selected
                .into_iter()
                .filter(|p| Path::new(p).is_file())
                .collect()
        } else {
            collect_media_paths_from_tree(&dcim_path)
        };

        let (media_files, _tl_skipped) =
            filter_media_paths_for_backup(&media_files, &dcim, true);
        if media_files.is_empty() {
            return Ok(BackupResult::fail(
                "Keine Mediendateien auf der SD-Karte gefunden",
                0,
            ));
        }

        let history = self.history.lock().unwrap();
        let mut filtered = Vec::new();
        let mut skipped_count = 0usize;
        if cfg.sd_skip_processed {
            for src in &media_files {
                match MediaHistoryStore::compute_identity(Path::new(src)) {
                    Ok((hash, _)) if history.contains(&hash).unwrap_or(false) => {
                        skipped_count += 1;
                    }
                    _ => filtered.push(src.clone()),
                }
            }
        } else {
            filtered = media_files;
        }
        drop(history);

        if filtered.is_empty() {
            return Ok(BackupResult::fail(
                format!("Keine neuen Dateien zum Sichern. Übersprungen: {skipped_count}"),
                skipped_count,
            ));
        }

        let total_size: u64 = filtered
            .iter()
            .filter_map(|p| fs::metadata(p).ok().map(|m| m.len()))
            .sum();
        let total_mb = total_size as f64 / (1024.0 * 1024.0);

        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let short_hash = format!(
            "{:04x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as u16)
                .unwrap_or(0)
        );
        let backup_dir_name =
            build_backup_dir_name(&timestamp.to_string(), &cfg.sd_pc_name, &short_hash);
        let backup_path = PathBuf::from(&backup_folder).join(&backup_dir_name);
        fs::create_dir_all(&backup_path)?;

        let dual_mode = {
            let m = cfg.sd_server_backup_mode.trim();
            if m == "local_then_server" {
                "local_then_server"
            } else {
                "direct_dual_write"
            }
        };
        let mut secondary_active = cfg.sd_server_backup_enabled;
        let dual_root = cfg.sd_server_backup_path.trim().to_string();
        let mut secondary_path: Option<PathBuf> = None;
        let mut secondary_warning: Option<String> = None;

        if secondary_active {
            if dual_root.is_empty() || !Path::new(&dual_root).is_dir() {
                secondary_warning = Some(format!(
                    "Zweiter Backup-Pfad ungültig (Primär bleibt erfolgreich): {dual_root}"
                ));
                secondary_active = false;
            } else {
                let sp = PathBuf::from(&dual_root).join(&backup_dir_name);
                match fs::create_dir_all(&sp) {
                    Ok(()) => secondary_path = Some(sp),
                    Err(e) => {
                        secondary_warning = Some(format!(
                            "Zweiter Backup-Pfad nicht erstellbar (Primär bleibt erfolgreich): {e}"
                        ));
                        secondary_active = false;
                    }
                }
            }
        }

        let mut used_names = HashSet::new();
        let mut copied_sources = Vec::new();
        let mut copied_dests = Vec::new();
        let mut manifest_entries = Vec::new();
        let mut local_to_secondary: Vec<(PathBuf, String)> = Vec::new();
        let mut copied_size: u64 = 0;
        let start = SystemTime::now();
        let mut last_progress_emit = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);

        let emit_progress = |copied_size: u64, total_mb: f64, start: SystemTime, force: bool, last: &mut Instant| {
            if !force && last.elapsed() < Duration::from_millis(150) {
                return;
            }
            if let Some(cb) = self.on_progress.lock().unwrap().as_ref() {
                let current_mb = copied_size as f64 / (1024.0 * 1024.0);
                let elapsed = start.elapsed().unwrap_or_default().as_secs_f64();
                let speed = if elapsed > 0.0 {
                    current_mb / elapsed
                } else {
                    0.0
                };
                let percent = if total_mb > 0.0 {
                    ((current_mb / total_mb) * 100.0).min(100.0)
                } else {
                    0.0
                };
                cb(BackupProgress {
                    current_mb,
                    total_mb,
                    speed_mbps: speed,
                    percent,
                });
                *last = Instant::now();
            }
        };

        emit_progress(0, total_mb, start, true, &mut last_progress_emit);

        for src_file in &filtered {
            let src_path = Path::new(src_file);
            let original_name = src_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            let dst_filename = unique_dest_name(&original_name, &mut used_names);
            let dst = backup_path.join(&dst_filename);

            match copy_file_with_progress(src_path, &dst, |delta| {
                copied_size += delta;
                emit_progress(
                    copied_size,
                    total_mb,
                    start,
                    false,
                    &mut last_progress_emit,
                );
            }) {
                Ok(_) => {
                    // Preserve mtime roughly via copy; copy2 equivalent:
                    if let Ok(meta) = fs::metadata(src_path) {
                        if let Ok(mtime) = meta.modified() {
                            let _ = filetime_set_mtime(&dst, mtime);
                        }
                    }
                    copied_sources.push(src_file.clone());
                    copied_dests.push(dst.to_string_lossy().into_owned());
                    manifest_entries.push(ManifestEntry {
                        dest: dst_filename.clone(),
                        src: Some(src_file.clone()),
                        media_type: media_type_from_filename(&original_name).to_string(),
                    });

                    if secondary_active {
                        if let Some(ref sp) = secondary_path {
                            if dual_mode == "direct_dual_write" {
                                let secondary_dst = sp.join(&dst_filename);
                                if let Err(e) = fs::copy(src_path, &secondary_dst) {
                                    secondary_warning = Some(format!(
                                        "Zweiter Backup teilweise fehlgeschlagen: {e}"
                                    ));
                                    secondary_active = false;
                                } else if let Ok(meta) = fs::metadata(src_path) {
                                    if let Ok(mtime) = meta.modified() {
                                        let _ = filetime_set_mtime(&secondary_dst, mtime);
                                    }
                                }
                            } else {
                                local_to_secondary.push((dst.clone(), dst_filename.clone()));
                            }
                        }
                    }

                    if let Ok(hist) = self.history.lock() {
                        let _ = hist.mark_backed_up(src_path);
                    }
                    // Always emit once per completed file (smooth bar + accurate end-of-file %).
                    emit_progress(copied_size, total_mb, start, true, &mut last_progress_emit);
                }
                Err(e) => {
                    // Card removed mid-backup
                    let _ = fs::remove_dir_all(&backup_path);
                    if let Some(ref sp) = secondary_path {
                        let _ = fs::remove_dir_all(sp);
                    }
                    return Ok(BackupResult {
                        success: false,
                        backup_path: None,
                        error_message: Some(format!(
                            "SD-Karte wurde während des Backups entfernt: {e}"
                        )),
                        copied_count: copied_sources.len(),
                        skipped_count,
                        copied_dest_paths: Vec::new(),
                        copied_source_paths: Vec::new(),
                        secondary_backup_path: None,
                        secondary_warning: None,
                    });
                }
            }
        }

        if secondary_active && dual_mode == "local_then_server" {
            if let Some(ref sp) = secondary_path {
                for (local_file, dst_filename) in &local_to_secondary {
                    let secondary_dst = sp.join(dst_filename);
                    if let Err(e) = fs::copy(local_file, &secondary_dst) {
                        secondary_warning =
                            Some(format!("Zweiter Backup teilweise fehlgeschlagen: {e}"));
                        secondary_active = false;
                        break;
                    }
                    if let Ok(meta) = fs::metadata(local_file) {
                        if let Ok(mtime) = meta.modified() {
                            let _ = filetime_set_mtime(&secondary_dst, mtime);
                        }
                    }
                }
            }
        }

        let session_active = crate::media::dji_paths::resolve_timelapse_session_active_for_paths(
            &dcim,
            &copied_sources,
            None,
        );
        let _ = write_backup_manifest(
            &backup_path,
            &dcim,
            &manifest_entries,
            session_active,
        );

        let secondary_ok = secondary_active
            && secondary_path.is_some()
            && secondary_warning.is_none()
            && !copied_sources.is_empty();
        if secondary_ok {
            if let Some(ref sp) = secondary_path {
                let _ = write_backup_manifest(sp, &dcim, &manifest_entries, session_active);
            }
        }

        // Only ever clear files that were successfully copied in THIS backup run.
        // Never clear from config alone when the caller did not opt in via `clear_after`.
        let should_clear = matches!(clear_after, Some(true))
            || (clear_after.is_none() && cfg.sd_clear_after_backup);
        if should_clear && !copied_sources.is_empty() {
            if let Some(cb) = self.on_progress.lock().unwrap().as_ref() {
                let elapsed = start.elapsed().unwrap_or_default().as_secs_f64();
                let current_mb = copied_size as f64 / (1024.0 * 1024.0);
                cb(BackupProgress {
                    current_mb,
                    total_mb,
                    speed_mbps: if elapsed > 0.0 {
                        current_mb / elapsed
                    } else {
                        0.0
                    },
                    percent: 100.0,
                });
            }
            self.emit_status("clearing_started", serde_json::json!(drive));
            clear_sd_files(&copied_sources, Some(|current, total| {
                self.emit_workflow(workflow_progress(
                    "clear",
                    current,
                    total,
                    "SD wird bereinigt…",
                ));
            }));
            self.emit_status("clearing_finished", serde_json::json!(drive));
        } else if should_clear && copied_sources.is_empty() {
            // Safety: requested clear but nothing was backed up → do not touch SD.
            self.emit_status(
                "clearing_skipped",
                serde_json::json!({
                    "drive": drive,
                    "reason": "no_files_backed_up",
                }),
            );
        }

        Ok(BackupResult {
            success: true,
            backup_path: Some(backup_path.to_string_lossy().into_owned()),
            error_message: None,
            copied_count: copied_sources.len(),
            skipped_count,
            copied_dest_paths: copied_dests,
            copied_source_paths: copied_sources,
            secondary_backup_path: if secondary_ok {
                secondary_path.map(|p| p.to_string_lossy().into_owned())
            } else {
                None
            },
            secondary_warning,
        })
    }

    /// Standalone SD wipe is intentionally disabled — clear only after a successful backup.
    #[allow(dead_code)]
    pub fn clear_media_files(&self, _paths: &[String]) -> Result<usize, SdError> {
        Err(SdError::Message(
            "SD-Bereinigung ist nur nach erfolgreichem Backup erlaubt".into(),
        ))
    }

    /// Import selected SD/backup files: mark history + return video/photo paths for UI.
    pub fn import_files(&self, paths: &[String]) -> Result<ImportSdResult, SdError> {
        let mut videos = Vec::new();
        let mut photos = Vec::new();
        let mut skipped = 0usize;
        let cfg = self.config();
        let history = self.history.lock().unwrap();

        for path in paths {
            let pb = Path::new(path);
            if !pb.is_file() {
                skipped += 1;
                continue;
            }
            let ext = pb
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{}", e.to_ascii_lowercase()))
                .unwrap_or_default();

            if cfg.sd_skip_processed {
                if let Ok((hash, _)) = MediaHistoryStore::compute_identity(pb) {
                    if history.was_imported(&hash).unwrap_or(false) {
                        skipped += 1;
                        continue;
                    }
                }
            }

            if is_video_ext(&ext) {
                videos.push(path.clone());
            } else if is_photo_ext(&ext) {
                photos.push(path.clone());
            } else {
                skipped += 1;
            }
        }
        drop(history);

        let all_paths: Vec<PathBuf> = videos
            .iter()
            .chain(photos.iter())
            .map(PathBuf::from)
            .collect();
        if let Ok(hist) = self.history.lock() {
            let _ = hist.mark_imported_batch(&all_paths);
        }

        Ok(ImportSdResult {
            imported_videos: videos,
            imported_photos: photos,
            skipped,
        })
    }

    pub fn history(&self) -> Result<std::sync::MutexGuard<'_, MediaHistoryStore>, SdError> {
        self.history
            .lock()
            .map_err(|_| SdError::Message("media history lock poisoned".into()))
    }

    /// Discover currently available action-cam drives (DCIM on removable).
    #[allow(dead_code)]
    pub fn scan_drives(&self) -> Vec<SdDriveInfo> {
        let ready: HashSet<_> = available_drives()
            .into_iter()
            .filter(|d| is_drive_ready(d))
            .collect();
        ready_action_cam_drives(&ready)
            .into_iter()
            .map(|drive| {
                let dcim = resolve_drive_dcim_path(&drive);
                SdDriveInfo {
                    drive,
                    dcim_path: dcim,
                    ready: true,
                }
            })
            .collect()
    }
}

/// Sanitize PC name for use inside backup folder names (legacy regex + 32-char cap).
pub fn sanitize_pc_name_for_backup(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control()
        {
            out.push('_');
        } else {
            out.push(ch);
        }
        if out.chars().count() >= 32 {
            break;
        }
    }
    out
}

/// `SD_Backup_{timestamp}[{pc}]_{hash}` — PC segment omitted when empty (legacy).
pub fn build_backup_dir_name(timestamp: &str, pc_name: &str, short_hash: &str) -> String {
    let safe = sanitize_pc_name_for_backup(pc_name);
    let pc_part = if safe.is_empty() {
        String::new()
    } else {
        format!("[{safe}]")
    };
    format!("SD_Backup_{timestamp}{pc_part}_{short_hash}")
}

fn gather_drive_info(drive: &str) -> (String, usize, f64) {
    let dcim = resolve_drive_dcim_path(drive);
    let paths = collect_media_paths_from_tree(Path::new(&dcim));
    let (filtered, _) = filter_media_paths_for_backup(&paths, &dcim, true);
    let total: u64 = filtered
        .iter()
        .filter_map(|p| fs::metadata(p).ok().map(|m| m.len()))
        .sum();
    (
        drive.to_string(),
        filtered.len(),
        total as f64 / (1024.0 * 1024.0),
    )
}

fn clear_sd_files<F>(files: &[String], mut on_progress: Option<F>)
where
    F: FnMut(u64, u64),
{
    let expanded = expand_files_for_sd_clear(files);
    let total = expanded.len() as u64;
    if let Some(ref mut cb) = on_progress {
        cb(0, total);
    }
    for (idx, path) in expanded.iter().enumerate() {
        let _ = fs::remove_file(path);
        if let Some(ref mut cb) = on_progress {
            cb((idx as u64) + 1, total);
        }
    }
    // Remove empty dirs deepest-first
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    for path in &expanded {
        if let Some(parent) = Path::new(path).parent() {
            dirs.insert(parent.to_path_buf());
        }
    }
    let mut sorted: Vec<_> = dirs.into_iter().collect();
    sorted.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for dir in sorted {
        if fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = fs::remove_dir(&dir);
        }
    }
}

fn filetime_set_mtime(_path: &Path, _mtime: SystemTime) {
    // Best-effort; std has no set_mtime without extra crate — skip.
}

pub fn available_drives() -> HashSet<String> {
    #[cfg(windows)]
    {
        windows_drives()
    }
    #[cfg(target_os = "macos")]
    {
        macos_volumes()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        unix_media_mounts()
    }
}

#[cfg(windows)]
fn windows_drives() -> HashSet<String> {
    let mut drives = HashSet::new();
    // Bitmask of logical drives
    unsafe extern "system" {
        fn GetLogicalDrives() -> u32;
    }
    let mask = unsafe { GetLogicalDrives() };
    for (i, letter) in (b'A'..=b'Z').enumerate() {
        if mask & (1 << i) != 0 {
            drives.insert(format!("{}:", letter as char));
        }
    }
    drives
}

#[cfg(target_os = "macos")]
fn macos_volumes() -> HashSet<String> {
    let mut drives = HashSet::new();
    if let Ok(entries) = fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let s = path.to_string_lossy().into_owned();
            if is_macos_volume_candidate(&s) {
                drives.insert(s);
            }
        }
    }
    drives
}

/// Heuristic: treat `/Volumes/<name>` as a candidate removable volume.
///
/// Skips macOS system / Time Machine volumes so the SD monitor does not treat
/// the boot disk as an "SD card" when it happens to have a DCIM folder.
/// Pure string logic — unit-tested on all platforms.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn is_macos_volume_candidate(path: &str) -> bool {
    let trimmed = path.trim_end_matches('/');
    let Some(name) = trimmed.strip_prefix("/Volumes/") else {
        return false;
    };
    if name.is_empty() || name.contains('/') {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    // Boot / data volumes and Time Machine locals
    if lower == "macintosh hd"
        || lower == "macintosh hd - data"
        || lower == "mac hd"
        || lower.starts_with("com.apple.timemachine.")
        || lower.starts_with(".timemachine")
        || lower.starts_with("backups of ")
    {
        return false;
    }
    true
}

#[cfg(all(unix, not(target_os = "macos")))]
fn unix_media_mounts() -> HashSet<String> {
    let mut drives = HashSet::new();
    for root in ["/media", "/run/media", "/mnt"] {
        let root_path = Path::new(root);
        if !root_path.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(root_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let s = path.to_string_lossy().into_owned();
                    if is_linux_mount_candidate(&s) {
                        drives.insert(s);
                    }
                    if let Ok(sub) = fs::read_dir(&path) {
                        for s in sub.flatten() {
                            let sp = s.path();
                            if sp.is_dir() {
                                let ss = sp.to_string_lossy().into_owned();
                                if is_linux_mount_candidate(&ss) {
                                    drives.insert(ss);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    drives
}

/// Heuristic: treat a Unix path as a candidate removable / user media mount.
///
/// Prefer `/run/media/$USER/<label>` and `/media/$USER/<label>` (or `/media/<label>`).
/// Under `/mnt`, accept only a single label and skip common fixed-disk names to
/// reduce false positives (e.g. `/mnt/data` with a DCIM folder).
/// Pure string logic — unit-tested on all platforms.
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
pub fn is_linux_mount_candidate(path: &str) -> bool {
    let trimmed = path.trim_end_matches('/');

    if let Some(rest) = trimmed.strip_prefix("/run/media/") {
        let parts: Vec<_> = rest.split('/').filter(|p| !p.is_empty()).collect();
        // /run/media/<user>/<label>
        return parts.len() == 2
            && !parts[0].starts_with('.')
            && !parts[1].starts_with('.');
    }

    if let Some(rest) = trimmed.strip_prefix("/media/") {
        let parts: Vec<_> = rest.split('/').filter(|p| !p.is_empty()).collect();
        // /media/<label> or /media/<user>/<label>
        if parts.is_empty() || parts.len() > 2 {
            return false;
        }
        return parts.iter().all(|p| !p.starts_with('.'));
    }

    if let Some(rest) = trimmed.strip_prefix("/mnt/") {
        let parts: Vec<_> = rest.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() != 1 {
            return false;
        }
        let lower = parts[0].to_ascii_lowercase();
        if lower.starts_with('.') {
            return false;
        }
        // Common long-lived mounts that often host random DCIM trees
        const SKIP: &[&str] = &[
            "data", "storage", "hdd", "ssd", "home", "backup", "backups", "nas", "cifs", "nfs",
            "share", "shares", "disk", "drive",
        ];
        if SKIP.contains(&lower.as_str()) {
            return false;
        }
        return true;
    }

    false
}

pub fn is_removable_drive(drive: &str) -> bool {
    #[cfg(windows)]
    {
        windows_is_removable(drive)
    }
    #[cfg(target_os = "macos")]
    {
        is_macos_volume_candidate(drive)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        is_linux_mount_candidate(drive)
    }
}

#[cfg(windows)]
fn windows_is_removable(drive: &str) -> bool {
    unsafe extern "system" {
        fn GetDriveTypeW(lpRootPathName: *const u16) -> u32;
    }
    const DRIVE_REMOVABLE: u32 = 2;
    let root = format!("{}\\", drive.trim_end_matches(['\\', '/']));
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let dtype = unsafe { GetDriveTypeW(wide.as_ptr()) };
    dtype == DRIVE_REMOVABLE
}

pub fn is_drive_ready(drive: &str) -> bool {
    let path = if cfg!(windows) {
        format!("{}\\", drive.trim_end_matches(['\\', '/']))
    } else {
        drive.to_string()
    };
    fs::read_dir(path).is_ok()
}

pub fn is_action_cam_sd_card(drive: &str) -> bool {
    Path::new(&resolve_drive_dcim_path(drive)).is_dir()
}

fn ready_action_cam_drives(ready: &HashSet<String>) -> HashSet<String> {
    ready
        .iter()
        .filter(|d| is_removable_drive(d) && is_action_cam_sd_card(d))
        .cloned()
        .collect()
}

/// Also accept non-removable drives that have DCIM (card readers sometimes report FIXED).
pub fn find_dcim_drives() -> Vec<SdDriveInfo> {
    available_drives()
        .into_iter()
        .filter(|d| is_drive_ready(d) && is_action_cam_sd_card(d))
        .map(|drive| {
            let dcim = resolve_drive_dcim_path(&drive);
            SdDriveInfo {
                drive,
                dcim_path: dcim,
                ready: true,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolve_dcim_join() {
        let p = resolve_drive_dcim_path("F:");
        assert!(p.contains("DCIM"));
    }

    #[test]
    fn sanitize_pc_name_replaces_invalid_and_caps_length() {
        assert_eq!(sanitize_pc_name_for_backup("  Desk:Top  "), "Desk_Top");
        assert_eq!(
            sanitize_pc_name_for_backup("a".repeat(40).as_str()).chars().count(),
            32
        );
        assert!(sanitize_pc_name_for_backup("   ").is_empty());
    }

    #[test]
    fn backup_dir_name_includes_bracketed_pc() {
        assert_eq!(
            build_backup_dir_name("20240101_120000", "Office-PC", "ab12"),
            "SD_Backup_20240101_120000[Office-PC]_ab12"
        );
        assert_eq!(
            build_backup_dir_name("20240101_120000", "", "ab12"),
            "SD_Backup_20240101_120000_ab12"
        );
    }

    #[test]
    fn resolve_dcim_macos_volume_path() {
        let p = resolve_drive_dcim_path("/Volumes/NO NAME");
        let normalized = p.replace('\\', "/");
        assert!(
            normalized.ends_with("/Volumes/NO NAME/DCIM")
                || normalized == "/Volumes/NO NAME/DCIM",
            "unexpected DCIM path: {normalized}"
        );
    }

    #[test]
    fn macos_volume_candidate_filters_system() {
        assert!(is_macos_volume_candidate("/Volumes/Untitled"));
        assert!(is_macos_volume_candidate("/Volumes/DJI_001"));
        assert!(is_macos_volume_candidate("/Volumes/NO NAME"));
        assert!(!is_macos_volume_candidate("/Volumes/Macintosh HD"));
        assert!(!is_macos_volume_candidate("/Volumes/Macintosh HD - Data"));
        assert!(!is_macos_volume_candidate("/Volumes/com.apple.TimeMachine.localsnapshots"));
        assert!(!is_macos_volume_candidate("/Volumes/"));
        assert!(!is_macos_volume_candidate("/media/usb"));
        assert!(!is_macos_volume_candidate("/Volumes/nested/path"));
    }

    #[test]
    fn linux_mount_candidate_prefers_user_media() {
        assert!(is_linux_mount_candidate("/run/media/alice/SDCARD"));
        assert!(is_linux_mount_candidate("/run/media/bob/NO NAME"));
        assert!(is_linux_mount_candidate("/media/alice/USB"));
        assert!(is_linux_mount_candidate("/media/DJI_001"));
        assert!(is_linux_mount_candidate("/mnt/CAMERA"));
        assert!(is_linux_mount_candidate("/mnt/sdcard"));

        assert!(!is_linux_mount_candidate("/run/media/alice"));
        assert!(!is_linux_mount_candidate("/run/media/"));
        assert!(!is_linux_mount_candidate("/run/media/alice/nested/path"));
        assert!(!is_linux_mount_candidate("/media/"));
        assert!(!is_linux_mount_candidate("/media/a/b/c"));
        assert!(!is_linux_mount_candidate("/mnt/data"));
        assert!(!is_linux_mount_candidate("/mnt/storage"));
        assert!(!is_linux_mount_candidate("/mnt/backup"));
        assert!(!is_linux_mount_candidate("/mnt/nested/path"));
        assert!(!is_linux_mount_candidate("/home/alice"));
        assert!(!is_linux_mount_candidate("/Volumes/USB"));
    }

    #[test]
    fn collect_from_fake_dcim_tree() {
        let dir = tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("100MEDIA");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("clip.mp4"), vec![0u8; 1024]).unwrap();
        fs::write(dcim.join("pic.jpg"), vec![0u8; 512]).unwrap();

        let paths = collect_media_paths_from_tree(&dir.path().join("DCIM"));
        assert_eq!(paths.len(), 2);

        let (kept, _) = filter_media_paths_for_backup(
            &paths,
            &dir.path().join("DCIM").to_string_lossy(),
            true,
        );
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn media_extensions_cover_common_types() {
        assert!(crate::media::dji_paths::MEDIA_EXTENSIONS.contains(&".mp4"));
        assert!(crate::media::dji_paths::MEDIA_EXTENSIONS.contains(&".jpg"));
    }

    #[test]
    fn backup_copies_to_flat_folder() {
        let src = tempdir().unwrap();
        let dcim = src.path().join("DCIM").join("100");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("a.mp4"), b"video-bytes").unwrap();
        fs::write(dcim.join("b.jpg"), b"photo-bytes").unwrap();

        let backup_root = tempdir().unwrap();
        let hist = tempdir().unwrap();
        let backup_path = backup_root.path().to_path_buf();

        let monitor = SdCardMonitor {
            monitoring: AtomicBool::new(false),
            known_drives: Mutex::new(HashSet::new()),
            action_cam_drives: Mutex::new(HashSet::new()),
            pending_drives: Mutex::new(HashSet::new()),
            declined_drives: Mutex::new(HashSet::new()),
            processed_drives: Mutex::new(HashSet::new()),
            processing_drives: Mutex::new(HashSet::new()),
            backup_in_progress: AtomicBool::new(false),
            history: Mutex::new(MediaHistoryStore::open_at(hist.path().join("h.db")).unwrap()),
            config_provider: Mutex::new(Box::new({
                let bp = backup_path.clone();
                move || {
                    let mut c = AppConfig::default();
                    c.sd_backup_folder = bp.to_string_lossy().into_owned();
                    c.sd_pc_name = "TestPC".into();
                    c
                }
            })),
            on_progress: Mutex::new(None),
            on_workflow: Mutex::new(None),
            on_status: Mutex::new(None),
            on_inserted: Mutex::new(None),
            on_removed: Mutex::new(None),
        };

        let drive = src.path().to_string_lossy().into_owned();
        let result = monitor.backup_drive(&drive, None).unwrap();
        assert!(result.success, "{:?}", result.error_message);
        assert_eq!(result.copied_count, 2);
        assert!(result.secondary_backup_path.is_none());
        let primary = PathBuf::from(result.backup_path.unwrap());
        let folder_name = primary.file_name().unwrap().to_string_lossy();
        assert!(
            folder_name.contains("[TestPC]"),
            "expected PC tag in folder name: {folder_name}"
        );
        assert!(primary.join("a.mp4").is_file());
        assert!(primary.join("b.jpg").is_file());
        assert_eq!(result.copied_dest_paths.len(), 2);
        assert_eq!(result.copied_source_paths.len(), 2);
        assert!(primary.join(crate::media::dji_paths::BACKUP_MANIFEST_NAME).is_file());
    }

    #[test]
    fn backup_dual_write_copies_to_both_roots() {
        let src = tempdir().unwrap();
        let dcim = src.path().join("DCIM").join("100");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("clip.mp4"), b"dual-video").unwrap();

        let primary_root = tempdir().unwrap();
        let secondary_root = tempdir().unwrap();
        let hist = tempdir().unwrap();

        let monitor = SdCardMonitor {
            monitoring: AtomicBool::new(false),
            known_drives: Mutex::new(HashSet::new()),
            action_cam_drives: Mutex::new(HashSet::new()),
            pending_drives: Mutex::new(HashSet::new()),
            declined_drives: Mutex::new(HashSet::new()),
            processed_drives: Mutex::new(HashSet::new()),
            processing_drives: Mutex::new(HashSet::new()),
            backup_in_progress: AtomicBool::new(false),
            history: Mutex::new(MediaHistoryStore::open_at(hist.path().join("h.db")).unwrap()),
            config_provider: Mutex::new(Box::new({
                let p = primary_root.path().to_path_buf();
                let s = secondary_root.path().to_path_buf();
                move || {
                    let mut c = AppConfig::default();
                    c.sd_backup_folder = p.to_string_lossy().into_owned();
                    c.sd_server_backup_enabled = true;
                    c.sd_server_backup_path = s.to_string_lossy().into_owned();
                    c.sd_server_backup_mode = "direct_dual_write".into();
                    c
                }
            })),
            on_progress: Mutex::new(None),
            on_workflow: Mutex::new(None),
            on_status: Mutex::new(None),
            on_inserted: Mutex::new(None),
            on_removed: Mutex::new(None),
        };

        let drive = src.path().to_string_lossy().into_owned();
        let result = monitor.backup_drive(&drive, None).unwrap();
        assert!(result.success, "{:?}", result.error_message);
        assert!(result.secondary_warning.is_none(), "{:?}", result.secondary_warning);
        let primary = PathBuf::from(result.backup_path.as_ref().unwrap());
        let secondary = PathBuf::from(result.secondary_backup_path.as_ref().unwrap());
        assert!(primary.join("clip.mp4").is_file());
        assert!(secondary.join("clip.mp4").is_file());
        assert_eq!(
            fs::read(primary.join("clip.mp4")).unwrap(),
            fs::read(secondary.join("clip.mp4")).unwrap()
        );
        assert!(secondary.join(crate::media::dji_paths::BACKUP_MANIFEST_NAME).is_file());
    }

    #[test]
    fn backup_dual_write_soft_fails_invalid_secondary() {
        let src = tempdir().unwrap();
        let dcim = src.path().join("DCIM").join("100");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("clip.mp4"), b"ok").unwrap();

        let primary_root = tempdir().unwrap();
        let hist = tempdir().unwrap();

        let monitor = SdCardMonitor {
            monitoring: AtomicBool::new(false),
            known_drives: Mutex::new(HashSet::new()),
            action_cam_drives: Mutex::new(HashSet::new()),
            pending_drives: Mutex::new(HashSet::new()),
            declined_drives: Mutex::new(HashSet::new()),
            processed_drives: Mutex::new(HashSet::new()),
            processing_drives: Mutex::new(HashSet::new()),
            backup_in_progress: AtomicBool::new(false),
            history: Mutex::new(MediaHistoryStore::open_at(hist.path().join("h.db")).unwrap()),
            config_provider: Mutex::new(Box::new({
                let p = primary_root.path().to_path_buf();
                move || {
                    let mut c = AppConfig::default();
                    c.sd_backup_folder = p.to_string_lossy().into_owned();
                    c.sd_server_backup_enabled = true;
                    c.sd_server_backup_path = "Z:\\does\\not\\exist\\backup".into();
                    c
                }
            })),
            on_progress: Mutex::new(None),
            on_workflow: Mutex::new(None),
            on_status: Mutex::new(None),
            on_inserted: Mutex::new(None),
            on_removed: Mutex::new(None),
        };

        let drive = src.path().to_string_lossy().into_owned();
        let result = monitor.backup_drive(&drive, None).unwrap();
        assert!(result.success, "{:?}", result.error_message);
        assert!(result.secondary_backup_path.is_none());
        assert!(result.secondary_warning.is_some());
        let primary = PathBuf::from(result.backup_path.unwrap());
        assert!(primary.join("clip.mp4").is_file());
    }
}
