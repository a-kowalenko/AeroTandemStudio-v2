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
    collect_media_paths_from_tree, expand_basenames_for_camera_clear, expand_files_for_sd_clear,
    filter_listable_media_paths, filter_media_paths_for_backup,
    is_photo_ext, is_video_ext, media_type_from_filename, resolve_drive_dcim_path,
    unique_dest_name, write_backup_manifest, ManifestEntry,
};
use crate::sd_card::copy_progress::copy_file_with_progress;
use crate::sd_card::secondary_backup::{
    new_job_id, SecondaryBackupJob, SECONDARY_BACKUP,
};
use crate::video::ffmpeg::{is_cancelled, WORKFLOW_CANCELLED};
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
    /// Volume label when available (Windows API; Unix last path segment).
    pub volume_name: String,
}

fn make_sd_drive_info(drive: String) -> SdDriveInfo {
    if is_mtp_source(&drive) {
        return SdDriveInfo {
            drive: drive.clone(),
            dcim_path: String::new(),
            ready: true,
            volume_name: usb_camera_label_for(&drive).unwrap_or_default(),
        };
    }
    let dcim_path = resolve_drive_dcim_path(&drive);
    let raw = volume_name_for_drive(&drive);
    let volume_name = if is_generic_volume_name(&raw) {
        String::new()
    } else {
        raw
    };
    SdDriveInfo {
        drive,
        dcim_path,
        ready: true,
        volume_name,
    }
}

/// Opaque USB/MTP camera source id (`mtp:gopro:…`).
pub fn is_mtp_source(drive: &str) -> bool {
    drive.starts_with("mtp:")
}

fn usb_camera_label_for(source_id: &str) -> Option<String> {
    crate::sd_card::mtp::usb_enumerate::list_allowlisted_usb_cameras()
        .into_iter()
        .find(|c| c.source_id == source_id)
        .map(|c| c.label)
}

fn usb_action_cam_source_ids_attached() -> HashSet<String> {
    crate::sd_card::mtp::usb_enumerate::list_allowlisted_usb_cameras()
        .into_iter()
        .map(|c| c.source_id)
        .collect()
}

/// Attached USB action cams visible in the UI (excludes software-ejected).
fn usb_action_cam_source_ids() -> HashSet<String> {
    SD_MONITOR.visible_usb_action_cam_ids()
}

/// Volume label for UI (empty when unavailable).
pub fn volume_name_for_drive(drive: &str) -> String {
    #[cfg(windows)]
    {
        windows_volume_name(drive)
    }
    #[cfg(not(windows))]
    {
        unix_volume_name(drive)
    }
}

/// True for empty / vendor-default labels that add no disambiguation value.
pub fn is_generic_volume_name(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    n.is_empty()
        || matches!(
            n.as_str(),
            "no name"
                | "untitled"
                | "removable disk"
                | "wechseldatenträger"
                | "neuer datenträger"
                | "unbenannt"
        )
}

#[cfg(windows)]
fn windows_volume_name(drive: &str) -> String {
    use std::os::windows::ffi::OsStrExt;

    let trimmed = drive.trim_end_matches(['\\', '/']);
    let root = format!("{trimmed}\\");
    let wide: Vec<u16> = std::ffi::OsStr::new(&root)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe extern "system" {
        fn GetVolumeInformationW(
            lp_root_path_name: *const u16,
            lp_volume_name_buffer: *mut u16,
            n_volume_name_size: u32,
            lp_volume_serial_number: *mut u32,
            lp_maximum_component_length: *mut u32,
            lp_file_system_flags: *mut u32,
            lp_file_system_name_buffer: *mut u16,
            n_file_system_name_size: u32,
        ) -> i32;
    }

    let mut name_buf = [0u16; 261];
    let ok = unsafe {
        GetVolumeInformationW(
            wide.as_ptr(),
            name_buf.as_mut_ptr(),
            name_buf.len() as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ok == 0 {
        return String::new();
    }
    let end = name_buf.iter().position(|&c| c == 0).unwrap_or(name_buf.len());
    String::from_utf16_lossy(&name_buf[..end]).trim().to_string()
}

#[cfg(not(windows))]
fn unix_volume_name(drive: &str) -> String {
    let trimmed = drive.trim_end_matches(['/', '\\']);
    Path::new(trimmed)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
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

/// Deferred EXIF / history fields for the SD file selector (after fast list).
#[derive(Debug, Clone, Serialize)]
pub struct SdFileEnrichment {
    pub path: String,
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
    /// 1-based index of the file currently being copied (omit at start).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

/// File-count progress for clear / import (i/n).
///
/// Import copy phase may also fill optional byte / file-name fields so the UI can
/// show `MB · MB/s · Datei x/n · name` like backup.
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowProgress {
    /// `"clear"` | `"import"`
    pub stage: String,
    pub current: u64,
    pub total: u64,
    pub percent: f64,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_mb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_mb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_mbps: Option<f64>,
    /// 1-based index of the file currently being copied / probed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

fn workflow_percent(current: u64, total: u64) -> f64 {
    if total > 0 {
        ((current as f64 / total as f64) * 100.0).min(100.0)
    } else {
        0.0
    }
}

pub fn workflow_progress(stage: &str, current: u64, total: u64, label: &str) -> WorkflowProgress {
    WorkflowProgress {
        stage: stage.to_string(),
        current,
        total,
        percent: workflow_percent(current, total),
        label: label.to_string(),
        current_mb: None,
        total_mb: None,
        speed_mbps: None,
        file_index: None,
        file_total: None,
        file_name: None,
    }
}

/// Byte-level import copy progress (overall MB + speed + current file).
pub fn workflow_progress_import_copy(
    copied_bytes: u64,
    total_bytes: u64,
    speed_mbps: f64,
    file_index: u64,
    file_total: u64,
    file_name: &str,
    label: &str,
) -> WorkflowProgress {
    let current_mb = copied_bytes as f64 / (1024.0 * 1024.0);
    let total_mb = total_bytes as f64 / (1024.0 * 1024.0);
    let percent = if total_bytes > 0 {
        ((copied_bytes as f64 / total_bytes as f64) * 100.0).min(100.0)
    } else {
        workflow_percent(file_index, file_total)
    };
    WorkflowProgress {
        stage: "import".to_string(),
        current: file_index,
        total: file_total,
        percent,
        label: label.to_string(),
        current_mb: Some(current_mb),
        total_mb: Some(total_mb),
        speed_mbps: Some(speed_mbps),
        file_index: Some(file_index),
        file_total: Some(file_total),
        file_name: Some(file_name.to_string()),
    }
}

/// Import probe / analyse progress (file counter only, no MB/s).
pub fn workflow_progress_import_probe(
    file_index: u64,
    file_total: u64,
    file_name: &str,
    label: &str,
) -> WorkflowProgress {
    WorkflowProgress {
        stage: "import".to_string(),
        current: file_index,
        total: file_total,
        percent: workflow_percent(file_index, file_total),
        label: label.to_string(),
        current_mb: None,
        total_mb: None,
        speed_mbps: None,
        file_index: Some(file_index),
        file_total: Some(file_total),
        file_name: Some(file_name.to_string()),
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
    /// True when a background mirror to the second path was queued (async mode).
    pub secondary_async_started: bool,
    /// `None` = clear not requested; `Some(n)` = files removed (SD) / deleted on camera (MTP).
    pub clear_deleted_count: Option<usize>,
    /// Soft-fail for clear-after-backup (backup may still succeed).
    pub clear_warning: Option<String>,
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
            secondary_async_started: false,
            clear_deleted_count: None,
            clear_warning: None,
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

/// Short-lived DCIM scan cache so insert sizing and list_files share one walk.
struct DcimListCache {
    drive: String,
    filtered_paths: Vec<String>,
    total_bytes: u64,
    at: Instant,
}

const DCIM_LIST_CACHE_TTL: Duration = Duration::from_secs(45);

pub struct SdCardMonitor {
    monitoring: AtomicBool,
    known_drives: Mutex<HashSet<String>>,
    action_cam_drives: Mutex<HashSet<String>>,
    pending_drives: Mutex<HashSet<String>>,
    declined_drives: Mutex<HashSet<String>>,
    processed_drives: Mutex<HashSet<String>>,
    processing_drives: Mutex<HashSet<String>>,
    /// USB cameras hidden after logical eject until the cable is unplugged.
    ejected_mtp_sources: Mutex<HashSet<String>>,
    backup_in_progress: AtomicBool,
    history: Mutex<MediaHistoryStore>,
    list_cache: Mutex<Option<DcimListCache>>,
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
            ejected_mtp_sources: Mutex::new(HashSet::new()),
            backup_in_progress: AtomicBool::new(false),
            history: Mutex::new(history),
            list_cache: Mutex::new(None),
            config_provider: Mutex::new(Box::new(config_provider)),
            on_progress: Mutex::new(None),
            on_workflow: Mutex::new(None),
            on_status: Mutex::new(None),
            on_inserted: Mutex::new(None),
            on_removed: Mutex::new(None),
        })
    }

    /// USB cameras still on the bus minus ones logically ejected (cable still in).
    pub fn visible_usb_action_cam_ids(&self) -> HashSet<String> {
        let attached = usb_action_cam_source_ids_attached();
        self.prune_ejected_mtp(&attached);
        let ejected = self.ejected_mtp_sources.lock().unwrap().clone();
        attached
            .into_iter()
            .filter(|id| !ejected.contains(id))
            .collect()
    }

    /// Drop software-eject marks once the device is gone from USB (allows replug).
    fn prune_ejected_mtp(&self, attached: &HashSet<String>) {
        let mut ejected = self.ejected_mtp_sources.lock().unwrap();
        ejected.retain(|id| attached.contains(id));
    }

    fn release_mtp_session_resources(&self, source_id: &str) {
        self.invalidate_list_cache_for(&[source_id.to_string()]);
        #[cfg(target_os = "macos")]
        {
            crate::sd_card::mtp::macos_ica::invalidate_stage_cache(source_id);
        }
    }

    /// Eject SD volume or logically release a USB/MTP camera (ICA session + hide until unplug).
    pub fn eject_source(&self, drive: &str) -> Result<(), SdError> {
        let drive = drive.trim();
        if drive.is_empty() {
            return Err(SdError::Message("Kein Laufwerk angegeben".into()));
        }
        if is_mtp_source(drive) {
            self.software_eject_mtp(drive);
            return Ok(());
        }
        crate::sd_card::eject::eject_drive(drive).map_err(|e| SdError::Message(e.to_string()))
    }

    fn software_eject_mtp(&self, source_id: &str) {
        self.release_mtp_session_resources(source_id);
        self.ejected_mtp_sources
            .lock()
            .unwrap()
            .insert(source_id.to_string());
        self.pending_drives.lock().unwrap().remove(source_id);
        self.processing_drives.lock().unwrap().remove(source_id);
        self.declined_drives.lock().unwrap().remove(source_id);
        // Allow a fresh insert event after the user unplugs and replugs.
        self.processed_drives.lock().unwrap().remove(source_id);
        self.action_cam_drives.lock().unwrap().remove(source_id);
        self.known_drives.lock().unwrap().remove(source_id);
        self.emit_status(
            "usb_camera_ejected",
            serde_json::json!({
                "drive": source_id,
                "message": "USB-Kamera freigegeben. Bitte Kabel trennen; erst nach erneutem Anstecken wieder importieren.",
            }),
        );
        self.notify_removed(&[source_id.to_string()]);
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
        let mut known = ready.clone();
        known.extend(usb_action_cam_source_ids());
        *self.known_drives.lock().unwrap() = known;

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
        let mut current_action = ready_action_cam_drives(&ready);
        // USB cameras are not volume mounts — keep them in `known` so removal is detected.
        let usb_now = usb_action_cam_source_ids();
        current_action.extend(usb_now.iter().cloned());

        let known = self.known_drives.lock().unwrap().clone();
        let previous_action = self.action_cam_drives.lock().unwrap().clone();

        let mut ready_with_usb = ready.clone();
        ready_with_usb.extend(usb_now.iter().cloned());

        let new_drives: HashSet<_> = ready_with_usb.difference(&known).cloned().collect();
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
        self.cleanup_removed(&ready_with_usb);
        *self.known_drives.lock().unwrap() = ready_with_usb;
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
        let info = self.gather_drive_info(drive);
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
            let info = self.gather_drive_info(drive);
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
            if is_mtp_source(d) {
                self.release_mtp_session_resources(d);
            }
        }
        self.invalidate_list_cache_for(drives);
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
            self.invalidate_list_cache_for(&removed);
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
    /// Fast listing for the confirm dialog: walk + metadata only.
    /// EXIF dates and `already_processed` are filled later via [`Self::enrich_files`].
    pub fn list_files(&self, drive: &str) -> Result<ListSdFilesResult, SdError> {
        if is_mtp_source(drive) {
            return self.list_mtp_files(drive);
        }
        let (filtered, _total) = self.scan_drive_media(drive)?;
        // Defense: drop proxies even if an older list/ICA cache still held them.
        let filtered = filter_listable_media_paths(filtered);
        let total: u64 = filtered
            .iter()
            .filter_map(|p| fs::metadata(p).ok().map(|m| m.len()))
            .sum();
        let mut files = Vec::with_capacity(filtered.len());
        for path in filtered {
            if let Some(info) = sd_file_info_light(&path) {
                files.push(info);
            }
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

    /// Fill EXIF display dates + history flags after a fast [`Self::list_files`].
    pub fn enrich_files(
        &self,
        drive: &str,
        paths: Option<Vec<String>>,
    ) -> Result<Vec<SdFileEnrichment>, SdError> {
        let paths = match paths {
            Some(p) if !p.is_empty() => p,
            _ => self.scan_drive_media(drive)?.0,
        };

        let mut identities: Vec<(String, Option<String>)> = Vec::with_capacity(paths.len());
        let mut enrichments = Vec::with_capacity(paths.len());

        for path in &paths {
            let pb = Path::new(path);
            if !pb.is_file() {
                continue;
            }
            let mtime = get_mtime_timestamp(pb).unwrap_or(0.0);
            let display_epoch = resolve_video_display_epoch(pb, Some(mtime), None);
            let hash = MediaHistoryStore::compute_identity(pb)
                .ok()
                .map(|(h, _)| h);
            identities.push((path.clone(), hash));
            enrichments.push(SdFileEnrichment {
                path: path.clone(),
                display_epoch,
                already_processed: false,
            });
        }

        let hashes: Vec<String> = identities
            .iter()
            .filter_map(|(_, h)| h.clone())
            .collect();
        let known = {
            let history = self.history.lock().unwrap();
            history.known_hashes(&hashes).unwrap_or_default()
        };
        for (i, (_, hash)) in identities.iter().enumerate() {
            if let Some(h) = hash {
                enrichments[i].already_processed = known.contains(h);
            }
        }

        Ok(enrichments)
    }

    fn invalidate_list_cache_for(&self, drives: &[String]) {
        let mut cache = self.list_cache.lock().unwrap();
        if let Some(c) = cache.as_ref() {
            if drives.iter().any(|d| drive_keys_equal(d, &c.drive)) {
                *cache = None;
            }
        }
    }

    fn gather_drive_info(&self, drive: &str) -> (String, usize, f64) {
        // USB/MTP: never stage via Image Capture here — that blocks for minutes and
        // can freeze the app. Counts are filled later by list_sd_files / backup.
        if is_mtp_source(drive) {
            return (drive.to_string(), 0, 0.0);
        }
        match self.scan_drive_media(drive) {
            Ok((paths, total)) => (
                drive.to_string(),
                paths.len(),
                total as f64 / (1024.0 * 1024.0),
            ),
            Err(_) => (drive.to_string(), 0, 0.0),
        }
    }

    /// Walk DCIM once (cached briefly) and return filtered media paths + total bytes.
    fn scan_drive_media(&self, drive: &str) -> Result<(Vec<String>, u64), SdError> {
        if is_mtp_source(drive) {
            // Reuse staging cache when still warm (avoids a second ICA download).
            if let Ok(cache) = self.list_cache.lock() {
                if let Some(c) = cache.as_ref() {
                    if drive_keys_equal(&c.drive, drive) && c.at.elapsed() < DCIM_LIST_CACHE_TTL {
                        return Ok((c.filtered_paths.clone(), c.total_bytes));
                    }
                }
            }
            return self.scan_mtp_media(drive);
        }
        if let Ok(cache) = self.list_cache.lock() {
            if let Some(c) = cache.as_ref() {
                if drive_keys_equal(&c.drive, drive) && c.at.elapsed() < DCIM_LIST_CACHE_TTL {
                    return Ok((c.filtered_paths.clone(), c.total_bytes));
                }
            }
        }

        let dcim = resolve_drive_dcim_path(drive);
        let dcim_path = PathBuf::from(&dcim);
        if !dcim_path.is_dir() {
            return Err(SdError::Message(format!("DCIM nicht gefunden: {dcim}")));
        }

        let all = collect_media_paths_from_tree(&dcim_path);
        let (filtered, _) = filter_media_paths_for_backup(&all, &dcim, true);
        let total: u64 = filtered
            .iter()
            .filter_map(|p| fs::metadata(p).ok().map(|m| m.len()))
            .sum();

        if let Ok(mut cache) = self.list_cache.lock() {
            *cache = Some(DcimListCache {
                drive: drive.to_string(),
                filtered_paths: filtered.clone(),
                total_bytes: total,
                at: Instant::now(),
            });
        }

        Ok((filtered, total))
    }

    /// USB/MTP: catalog only (no download). Call from list/backup, never detect/hotplug.
    fn scan_mtp_media(&self, drive: &str) -> Result<(Vec<String>, u64), SdError> {
        let listed = self.list_mtp_files(drive)?;
        let paths: Vec<String> = listed.files.iter().map(|f| f.path.clone()).collect();
        Ok((paths, listed.total_size_bytes))
    }

    fn list_mtp_files(&self, drive: &str) -> Result<ListSdFilesResult, SdError> {
        let label = usb_camera_label_for(drive).unwrap_or_else(|| drive.to_string());

        #[cfg(target_os = "macos")]
        {
            use crate::sd_card::mtp::macos_ica::{
                ica_cache_dir_for, list_camera_catalog, CameraCatalogFile,
            };
            self.emit_status(
                "usb_camera_staging",
                serde_json::json!({
                    "drive": drive,
                    "label": label,
                    "state": "started",
                }),
            );
            let dest = ica_cache_dir_for(drive);
            let drive_owned = drive.to_string();
            let status_cb = self.on_status.lock().unwrap().clone();
            let on_tick = status_cb.map(|cb| {
                let drive_tick = drive_owned.clone();
                let last_n = std::sync::atomic::AtomicUsize::new(0);
                Box::new(move |catalog: Vec<CameraCatalogFile>| {
                    let n = catalog.len();
                    if n <= last_n.load(std::sync::atomic::Ordering::Relaxed) {
                        return;
                    }
                    last_n.store(n, std::sync::atomic::Ordering::Relaxed);
                    let listed = list_result_from_mtp_catalog(&drive_tick, &catalog);
                    cb(
                        "mtp_catalog",
                        serde_json::json!({
                            "drive": drive_tick,
                            "files": listed.files,
                            "total_size_mb": listed.total_size_mb,
                            "file_count": listed.files.len(),
                            "done": false,
                        }),
                    );
                }) as Box<dyn FnMut(Vec<CameraCatalogFile>) + Send>
            });
            match list_camera_catalog(drive, &label, &dest, on_tick) {
                Ok(catalog) => {
                    let listed = list_result_from_mtp_catalog(drive, &catalog);
                    self.emit_status(
                        "usb_camera_staging",
                        serde_json::json!({
                            "drive": drive,
                            "label": label,
                            "state": "done",
                            "file_count": listed.files.len(),
                            "total_size_mb": listed.total_size_mb,
                        }),
                    );
                    self.emit_status(
                        "mtp_catalog",
                        serde_json::json!({
                            "drive": drive,
                            "files": listed.files,
                            "total_size_mb": listed.total_size_mb,
                            "file_count": listed.files.len(),
                            "done": true,
                        }),
                    );
                    if let Ok(mut cache) = self.list_cache.lock() {
                        *cache = Some(DcimListCache {
                            drive: drive.to_string(),
                            filtered_paths: listed.files.iter().map(|f| f.path.clone()).collect(),
                            total_bytes: listed.total_size_bytes,
                            at: Instant::now(),
                        });
                    }
                    Ok(listed)
                }
                Err(e) => {
                    let msg = e.to_string();
                    self.emit_status(
                        "usb_camera_staging",
                        serde_json::json!({
                            "drive": drive,
                            "label": label,
                            "state": "failed",
                            "message": msg,
                        }),
                    );
                    Err(SdError::Message(msg))
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = label;
            Err(SdError::Message(format!(
                "{drive}: USB-Kamera-Import ist auf dieser Plattform noch nicht implementiert. \
                 Bitte SD-Karte / Kartenleser nutzen."
            )))
        }
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

        if is_mtp_source(drive) {
            return self.backup_mtp_drive(drive, selected_files, clear_after);
        }

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
        let filter_root = dcim;

        let (media_files, _tl_skipped) =
            filter_media_paths_for_backup(&media_files, &filter_root, true);
        if media_files.is_empty() {
            return Ok(BackupResult::fail(
                if is_mtp_source(drive) {
                    "Keine Mediendateien auf der USB-Kamera gefunden".to_string()
                } else {
                    "Keine Mediendateien auf der SD-Karte gefunden".to_string()
                },
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
            match m {
                "local_then_server" => "local_then_server",
                "local_then_server_async" => "local_then_server_async",
                _ => "direct_dual_write",
            }
        };
        let async_secondary = dual_mode == "local_then_server_async";
        let mut secondary_active = cfg.sd_server_backup_enabled;
        let dual_root = cfg.sd_server_backup_path.trim().to_string();
        let mut secondary_path: Option<PathBuf> = None;
        let mut secondary_warning: Option<String> = None;
        let mut secondary_async_started = false;

        if secondary_active {
            if dual_root.is_empty() || !Path::new(&dual_root).is_dir() {
                secondary_warning = Some(format!(
                    "Zweiter Backup-Pfad ungültig (Primär bleibt erfolgreich): {dual_root}"
                ));
                secondary_active = false;
            } else if async_secondary {
                // Folder is created by the background worker after primary returns.
                secondary_path = None;
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
        let file_total = filtered.len() as u64;

        let emit_progress = |copied_size: u64,
                             total_mb: f64,
                             start: SystemTime,
                             force: bool,
                             last: &mut Instant,
                             file_index: u64,
                             file_name: &str| {
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
                    file_index: if file_index > 0 {
                        Some(file_index)
                    } else {
                        None
                    },
                    file_total: Some(file_total),
                    file_name: if file_name.is_empty() {
                        None
                    } else {
                        Some(file_name.to_string())
                    },
                });
                *last = Instant::now();
            }
        };

        emit_progress(0, total_mb, start, true, &mut last_progress_emit, 0, "");

        for (i, src_file) in filtered.iter().enumerate() {
            if is_cancelled() {
                let _ = fs::remove_dir_all(&backup_path);
                if let Some(ref sp) = secondary_path {
                    let _ = fs::remove_dir_all(sp);
                }
                return Ok(BackupResult {
                    success: false,
                    backup_path: None,
                    error_message: Some(WORKFLOW_CANCELLED.into()),
                    copied_count: copied_sources.len(),
                    skipped_count,
                    copied_dest_paths: Vec::new(),
                    copied_source_paths: Vec::new(),
                    secondary_backup_path: None,
                    secondary_warning: None,
                    secondary_async_started: false,
                    clear_deleted_count: None,
                    clear_warning: None,
                });
            }
            let file_index = (i as u64) + 1;
            let src_path = Path::new(src_file);
            let original_name = src_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            let dst_filename = unique_dest_name(&original_name, &mut used_names);
            let dst = backup_path.join(&dst_filename);

            emit_progress(
                copied_size,
                total_mb,
                start,
                true,
                &mut last_progress_emit,
                file_index,
                &original_name,
            );

            match copy_file_with_progress(src_path, &dst, |delta| {
                copied_size += delta;
                emit_progress(
                    copied_size,
                    total_mb,
                    start,
                    false,
                    &mut last_progress_emit,
                    file_index,
                    &original_name,
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

                    if secondary_active && !async_secondary {
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
                    } else if secondary_active && async_secondary {
                        local_to_secondary.push((dst.clone(), dst_filename.clone()));
                    }

                    if let Ok(hist) = self.history.lock() {
                        let _ = hist.mark_backed_up(src_path);
                    }
                    // Always emit once per completed file (smooth bar + accurate end-of-file %).
                    emit_progress(
                        copied_size,
                        total_mb,
                        start,
                        true,
                        &mut last_progress_emit,
                        file_index,
                        &original_name,
                    );
                }
                Err(e) => {
                    let _ = fs::remove_dir_all(&backup_path);
                    if let Some(ref sp) = secondary_path {
                        let _ = fs::remove_dir_all(sp);
                    }
                    let msg = if is_cancelled() || e.to_string().contains(WORKFLOW_CANCELLED) {
                        WORKFLOW_CANCELLED.to_string()
                    } else {
                        format!("SD-Karte wurde während des Backups entfernt: {e}")
                    };
                    return Ok(BackupResult {
                        success: false,
                        backup_path: None,
                        error_message: Some(msg),
                        copied_count: copied_sources.len(),
                        skipped_count,
                        copied_dest_paths: Vec::new(),
                        copied_source_paths: Vec::new(),
                        secondary_backup_path: None,
                        secondary_warning: None,
                        secondary_async_started: false,
                        clear_deleted_count: None,
                        clear_warning: None,
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
            &filter_root,
            &copied_sources,
            None,
        );
        let _ = write_backup_manifest(
            &backup_path,
            &filter_root,
            &manifest_entries,
            session_active,
        );

        if secondary_active && async_secondary && !local_to_secondary.is_empty() {
            let filenames: Vec<String> = local_to_secondary
                .iter()
                .map(|(_, name)| name.clone())
                .collect();
            SECONDARY_BACKUP.enqueue(SecondaryBackupJob {
                id: new_job_id(),
                primary_path: backup_path.clone(),
                secondary_root: PathBuf::from(&dual_root),
                backup_dir_name: backup_dir_name.clone(),
                filenames,
                dcim_source: filter_root.clone(),
                manifest_entries: manifest_entries.clone(),
                timelapse_session_active: session_active,
            });
            secondary_async_started = true;
            self.emit_status(
                "secondary_backup_queued",
                serde_json::json!({
                    "primary_path": backup_path.to_string_lossy(),
                    "secondary_root": dual_root,
                }),
            );
        }

        let secondary_ok = secondary_active
            && !async_secondary
            && secondary_path.is_some()
            && secondary_warning.is_none()
            && !copied_sources.is_empty();
        if secondary_ok {
            if let Some(ref sp) = secondary_path {
                let _ = write_backup_manifest(sp, &filter_root, &manifest_entries, session_active);
            }
        }

        // Only ever clear files that were successfully copied in THIS backup run.
        // Never clear from config alone when the caller did not opt in via `clear_after`.
        // USB/MTP: delete on camera via Image Capture (same config gate as SD volumes).
        let want_clear = matches!(clear_after, Some(true))
            || (clear_after.is_none() && cfg.sd_clear_after_backup);
        let mut clear_warning: Option<String> = None;
        let mut clear_deleted_count: Option<usize> = None;
        if want_clear && !copied_sources.is_empty() {
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
                    file_index: if file_total > 0 {
                        Some(file_total)
                    } else {
                        None
                    },
                    file_total: Some(file_total),
                    file_name: None,
                });
            }
            self.emit_status("clearing_started", serde_json::json!(drive));
            if is_mtp_source(drive) {
                let (deleted, warn) = self.clear_mtp_after_backup(drive, &copied_sources);
                clear_deleted_count = deleted;
                clear_warning = warn;
            } else {
                let before = copied_sources.len();
                clear_sd_files(&copied_sources, Some(|current, total| {
                    self.emit_workflow(workflow_progress(
                        "clear",
                        current,
                        total,
                        "SD wird bereinigt…",
                    ));
                }));
                // Volume clear expands sidecars; report at least the backed-up masters.
                clear_deleted_count = Some(before);
            }
            self.emit_status(
                "clearing_finished",
                serde_json::json!({
                    "drive": drive,
                    "deleted": clear_deleted_count,
                    "warning": clear_warning,
                }),
            );
        } else if want_clear && copied_sources.is_empty() {
            // Safety: requested clear but nothing was backed up → do not touch SD/camera.
            self.emit_status(
                "clearing_skipped",
                serde_json::json!({
                    "drive": drive,
                    "reason": "no_files_backed_up",
                }),
            );
            clear_deleted_count = Some(0);
            clear_warning = Some("Nicht bereinigt (keine Dateien im Backup).".into());
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
            secondary_async_started,
            clear_deleted_count,
            clear_warning,
        })
    }

    /// Backup USB/MTP camera media: catalog already listed; download selection into the
    /// normal SD backup folder with the same progress events as a volume copy.
    fn backup_mtp_drive(
        &self,
        drive: &str,
        selected_files: Option<Vec<String>>,
        clear_after: Option<bool>,
    ) -> Result<BackupResult, SdError> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (drive, selected_files, clear_after);
            return Ok(BackupResult::fail(
                format!(
                    "{drive}: USB-Kamera-Import ist auf dieser Plattform noch nicht implementiert. \
                     Bitte SD-Karte / Kartenleser nutzen."
                ),
                0,
            ));
        }

        #[cfg(target_os = "macos")]
        {
            use crate::sd_card::mtp::macos_ica::{
                download_camera_files, ica_cache_dir_for, virtual_media_path,
            };

            let cfg = self.config();
            let listed = self.list_mtp_files(drive)?;
            if listed.files.is_empty() {
                return Ok(BackupResult::fail(
                    "Keine Mediendateien auf der USB-Kamera gefunden".to_string(),
                    0,
                ));
            }

            let wanted: Option<HashSet<String>> = selected_files.as_ref().map(|sel| {
                sel.iter()
                    .filter_map(|p| {
                        Path::new(p)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .map(|s| s.to_ascii_lowercase())
                    })
                    .collect()
            });

            let mut chosen: Vec<&SdFileInfo> = listed
                .files
                .iter()
                .filter(|f| match &wanted {
                    Some(set) => set.contains(&f.filename.to_ascii_lowercase()),
                    None => true,
                })
                .collect();

            let virtual_paths: Vec<String> = chosen.iter().map(|f| f.path.clone()).collect();
            let cache_root = ica_cache_dir_for(drive).to_string_lossy().into_owned();
            let (filtered_paths, _tl) =
                filter_media_paths_for_backup(&virtual_paths, &cache_root, true);
            let keep: HashSet<String> = filtered_paths.iter().cloned().collect();
            chosen.retain(|f| keep.contains(&f.path));
            if chosen.is_empty() {
                return Ok(BackupResult::fail(
                    "Keine Mediendateien auf der USB-Kamera gefunden".to_string(),
                    0,
                ));
            }

            let names: Vec<String> = chosen.iter().map(|f| f.filename.clone()).collect();
            let total_size: u64 = chosen.iter().map(|f| f.size_bytes).sum();
            let total_mb = total_size as f64 / (1024.0 * 1024.0);
            let file_total = names.len() as u64;

            let backup_folder = cfg.sd_backup_folder.trim().to_string();
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
                match m {
                    "local_then_server" => "local_then_server",
                    "local_then_server_async" => "local_then_server_async",
                    _ => "direct_dual_write",
                }
            };
            let async_secondary = dual_mode == "local_then_server_async";
            let mut secondary_active = cfg.sd_server_backup_enabled;
            let dual_root = cfg.sd_server_backup_path.trim().to_string();
            let mut secondary_path: Option<PathBuf> = None;
            let mut secondary_warning: Option<String> = None;
            let mut secondary_async_started = false;

            if secondary_active {
                if dual_root.is_empty() || !Path::new(&dual_root).is_dir() {
                    secondary_warning = Some(format!(
                        "Zweiter Backup-Pfad ungültig (Primär bleibt erfolgreich): {dual_root}"
                    ));
                    secondary_active = false;
                } else if async_secondary {
                    secondary_path = None;
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

            let start = SystemTime::now();

            if let Some(cb) = self.on_progress.lock().unwrap().as_ref() {
                cb(BackupProgress {
                    current_mb: 0.0,
                    total_mb,
                    speed_mbps: 0.0,
                    percent: 0.0,
                    file_index: None,
                    file_total: Some(file_total),
                    file_name: None,
                });
            }

            let label = usb_camera_label_for(drive).unwrap_or_else(|| drive.to_string());
            let progress_cb = {
                let on_progress = self.on_progress.lock().unwrap().clone();
                move |file_index: u32, file_total_cb: u32, name: String, bytes_done: u64, bytes_total: u64| {
                    let Some(cb) = on_progress.as_ref() else {
                        return;
                    };
                    let done_mb = bytes_done as f64 / (1024.0 * 1024.0);
                    let tot = if bytes_total > 0 {
                        bytes_total as f64 / (1024.0 * 1024.0)
                    } else {
                        total_mb
                    };
                    let elapsed = start.elapsed().unwrap_or_default().as_secs_f64();
                    let speed = if elapsed > 0.0 { done_mb / elapsed } else { 0.0 };
                    let percent = if tot > 0.0 {
                        ((done_mb / tot) * 100.0).min(100.0)
                    } else {
                        0.0
                    };
                    cb(BackupProgress {
                        current_mb: done_mb,
                        total_mb: tot,
                        speed_mbps: speed,
                        percent,
                        file_index: if file_index > 0 {
                            Some(u64::from(file_index))
                        } else {
                            None
                        },
                        file_total: Some(u64::from(file_total_cb).max(file_total)),
                        file_name: if name.is_empty() { None } else { Some(name) },
                    });
                }
            };

            if is_cancelled() {
                let _ = fs::remove_dir_all(&backup_path);
                return Ok(BackupResult {
                    success: false,
                    backup_path: None,
                    error_message: Some(WORKFLOW_CANCELLED.into()),
                    copied_count: 0,
                    skipped_count: 0,
                    copied_dest_paths: Vec::new(),
                    copied_source_paths: Vec::new(),
                    secondary_backup_path: None,
                    secondary_warning: None,
                    secondary_async_started: false,
                    clear_deleted_count: None,
                    clear_warning: None,
                });
            }

            let downloaded = match download_camera_files(
                drive,
                &label,
                &backup_path,
                &names,
                Some(Box::new(progress_cb)),
            ) {
                Ok(paths) => paths,
                Err(e) => {
                    let _ = fs::remove_dir_all(&backup_path);
                    if let Some(ref sp) = secondary_path {
                        let _ = fs::remove_dir_all(sp);
                    }
                    let msg = e.to_string();
                    let msg = if is_cancelled() || msg.contains(WORKFLOW_CANCELLED) {
                        WORKFLOW_CANCELLED.to_string()
                    } else {
                        format!("SD-Karte wurde während des Backups entfernt: {msg}")
                    };
                    return Ok(BackupResult::fail(msg, 0));
                }
            };

            let mut copied_dests: Vec<String> = Vec::new();
            let mut copied_sources: Vec<String> = Vec::new();
            let mut manifest_entries = Vec::new();
            let mut local_to_secondary: Vec<(PathBuf, String)> = Vec::new();
            let mut used_names = HashSet::new();

            for dest in downloaded {
                let original_name = dest
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("file")
                    .to_string();
                let dst_filename = unique_dest_name(&original_name, &mut used_names);
                let final_dest = if dst_filename == original_name {
                    dest.clone()
                } else {
                    let renamed = backup_path.join(&dst_filename);
                    if fs::rename(&dest, &renamed).is_ok() {
                        renamed
                    } else {
                        dest.clone()
                    }
                };
                let src_virtual = virtual_media_path(drive, &original_name)
                    .to_string_lossy()
                    .into_owned();
                copied_sources.push(src_virtual.clone());
                copied_dests.push(final_dest.to_string_lossy().into_owned());
                manifest_entries.push(ManifestEntry {
                    dest: dst_filename.clone(),
                    src: Some(src_virtual),
                    media_type: media_type_from_filename(&original_name).to_string(),
                });
                if let Ok(hist) = self.history.lock() {
                    let _ = hist.mark_backed_up(&final_dest);
                }
                if secondary_active && !async_secondary {
                    if let Some(ref sp) = secondary_path {
                        if dual_mode == "direct_dual_write" {
                            let secondary_dst = sp.join(&dst_filename);
                            if let Err(e) = fs::copy(&final_dest, &secondary_dst) {
                                secondary_warning =
                                    Some(format!("Zweiter Backup teilweise fehlgeschlagen: {e}"));
                                secondary_active = false;
                            }
                        } else {
                            local_to_secondary.push((final_dest.clone(), dst_filename.clone()));
                        }
                    }
                } else if secondary_active && async_secondary {
                    local_to_secondary.push((final_dest.clone(), dst_filename.clone()));
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
                    }
                }
            }

            let session_active = crate::media::dji_paths::resolve_timelapse_session_active_for_paths(
                &cache_root,
                &copied_sources,
                None,
            );
            let _ = write_backup_manifest(
                &backup_path,
                &cache_root,
                &manifest_entries,
                session_active,
            );

            if secondary_active && async_secondary && !local_to_secondary.is_empty() {
                let filenames: Vec<String> = local_to_secondary
                    .iter()
                    .map(|(_, name)| name.clone())
                    .collect();
                SECONDARY_BACKUP.enqueue(SecondaryBackupJob {
                    id: new_job_id(),
                    primary_path: backup_path.clone(),
                    secondary_root: PathBuf::from(&dual_root),
                    backup_dir_name: backup_dir_name.clone(),
                    filenames,
                    dcim_source: cache_root.clone(),
                    manifest_entries: manifest_entries.clone(),
                    timelapse_session_active: session_active,
                });
                secondary_async_started = true;
                self.emit_status(
                    "secondary_backup_queued",
                    serde_json::json!({
                        "primary_path": backup_path.to_string_lossy(),
                        "secondary_root": dual_root,
                    }),
                );
            }

            let secondary_ok = secondary_active
                && !async_secondary
                && secondary_path.is_some()
                && secondary_warning.is_none()
                && !copied_sources.is_empty();
            if secondary_ok {
                if let Some(ref sp) = secondary_path {
                    let _ = write_backup_manifest(sp, &cache_root, &manifest_entries, session_active);
                }
            }

            let want_clear = matches!(clear_after, Some(true))
                || (clear_after.is_none() && cfg.sd_clear_after_backup);
            let mut clear_warning: Option<String> = None;
            let mut clear_deleted_count: Option<usize> = None;
            if want_clear && !copied_sources.is_empty() {
                self.emit_status("clearing_started", serde_json::json!(drive));
                let (deleted, warn) = self.clear_mtp_after_backup(drive, &copied_sources);
                clear_deleted_count = deleted;
                clear_warning = warn;
                self.emit_status(
                    "clearing_finished",
                    serde_json::json!({
                        "drive": drive,
                        "deleted": clear_deleted_count,
                        "warning": clear_warning,
                    }),
                );
            }

            return Ok(BackupResult {
                success: true,
                backup_path: Some(backup_path.to_string_lossy().into_owned()),
                error_message: None,
                copied_count: copied_sources.len(),
                skipped_count: 0,
                copied_dest_paths: copied_dests,
                copied_source_paths: copied_sources,
                secondary_backup_path: if secondary_ok {
                    secondary_path.map(|p| p.to_string_lossy().into_owned())
                } else {
                    None
                },
                secondary_warning,
                secondary_async_started,
                clear_deleted_count,
                clear_warning,
            })
        }
    }

    /// Delete backed-up masters (+ sidecar candidates) on an MTP/USB camera.
    /// Returns `(Some(deleted), None)` on success, or `(None/Some(0), Some(warning))` on failure.
    fn clear_mtp_after_backup(
        &self,
        drive: &str,
        copied_sources: &[String],
    ) -> (Option<usize>, Option<String>) {
        let names = expand_basenames_for_camera_clear(copied_sources);
        // Do not use expanded sidecar candidate count as progress total (looks like 0/7).
        let masters = copied_sources.len().max(1) as u64;
        self.emit_workflow(workflow_progress(
            "clear",
            0,
            masters,
            "USB-Kamera wird bereinigt…",
        ));

        #[cfg(target_os = "macos")]
        {
            use crate::sd_card::mtp::macos_ica::delete_camera_files_named;
            let label = usb_camera_label_for(drive).unwrap_or_else(|| drive.to_string());
            match delete_camera_files_named(drive, &label, &names) {
                Ok(deleted) if deleted > 0 => {
                    self.invalidate_list_cache_for(&[drive.to_string()]);
                    self.emit_workflow(workflow_progress(
                        "clear",
                        deleted as u64,
                        deleted as u64,
                        &format!("USB-Kamera bereinigt ({deleted} Datei(en))."),
                    ));
                    (Some(deleted), None)
                }
                Ok(_) => {
                    let msg = "Kamera-Bereinigung meldete Erfolg, aber es wurde nichts gelöscht."
                        .to_string();
                    self.emit_status(
                        "clearing_failed",
                        serde_json::json!({
                            "drive": drive,
                            "message": msg,
                        }),
                    );
                    (Some(0), Some(msg))
                }
                Err(e) => {
                    let msg = e.to_string();
                    let soft = if msg.contains("Gefunden: (keine)") || msg.contains("Bildübernahme") {
                        format!(
                            "Backup ist gespeichert. Kamera-Bereinigung über USB nicht möglich \
                             ({msg}). GoPro kurz ab/an stecken und erneut importieren, oder \
                             MicroSD im Kartenleser / an der Kamera löschen."
                        )
                    } else {
                        format!("Kamera-Bereinigung fehlgeschlagen: {msg}")
                    };
                    self.emit_status(
                        "clearing_failed",
                        serde_json::json!({
                            "drive": drive,
                            "message": soft,
                        }),
                    );
                    (Some(0), Some(soft))
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (drive, names, masters);
            (
                Some(0),
                Some(
                    "Kamera-Bereinigung über USB ist auf dieser Plattform noch nicht verfügbar. \
                     Bitte MicroSD im Kartenleser nutzen."
                        .into(),
                ),
            )
        }
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
            .map(make_sd_drive_info)
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

fn drive_keys_equal(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        a.trim_end_matches(['/', '\\'])
            .eq_ignore_ascii_case(b.trim_end_matches(['/', '\\']))
    }
    #[cfg(not(windows))]
    {
        a.trim_end_matches('/') == b.trim_end_matches('/')
    }
}

fn sd_file_info_light(path: &str) -> Option<SdFileInfo> {
    let pb = PathBuf::from(path);
    let meta = fs::metadata(&pb).ok()?;
    let size = meta.len();
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
    let mtime = get_mtime_timestamp(&pb).unwrap_or(0.0);
    Some(SdFileInfo {
        path: path.to_string(),
        filename,
        size_bytes: size,
        is_video: is_video_ext(&ext),
        mtime,
        // Provisional: EXIF capture time is filled by enrich_files.
        display_epoch: mtime,
        already_processed: false,
    })
}

fn sd_file_info_from_catalog(path: String, filename: &str, size: u64, mtime: f64) -> SdFileInfo {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_default();
    SdFileInfo {
        path,
        filename: filename.to_string(),
        size_bytes: size,
        is_video: is_video_ext(&ext),
        mtime,
        display_epoch: mtime,
        already_processed: false,
    }
}

#[cfg(target_os = "macos")]
fn list_result_from_mtp_catalog(
    drive: &str,
    catalog: &[crate::sd_card::mtp::macos_ica::CameraCatalogFile],
) -> ListSdFilesResult {
    use crate::sd_card::mtp::macos_ica::virtual_media_path;
    let mut files: Vec<SdFileInfo> = catalog
        .iter()
        .map(|e| {
            sd_file_info_from_catalog(
                virtual_media_path(drive, &e.name)
                    .to_string_lossy()
                    .into_owned(),
                &e.name,
                e.size,
                e.mtime,
            )
        })
        .collect();
    files.sort_by(|a, b| {
        let by_date = a
            .display_epoch
            .partial_cmp(&b.display_epoch)
            .unwrap_or(std::cmp::Ordering::Equal);
        if by_date != std::cmp::Ordering::Equal {
            return by_date;
        }
        a.filename.cmp(&b.filename)
    });
    let total: u64 = files.iter().map(|f| f.size_bytes).sum();
    ListSdFilesResult {
        drive: drive.to_string(),
        total_size_mb: total as f64 / (1024.0 * 1024.0),
        total_size_bytes: total,
        files,
    }
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
    let mut set: HashSet<String> = ready
        .iter()
        .filter(|d| is_removable_drive(d) && is_action_cam_sd_card(d))
        .cloned()
        .collect();
    set.extend(usb_action_cam_source_ids());
    set
}

/// Also accept non-removable drives that have DCIM (card readers sometimes report FIXED).
/// Plus allowlisted USB cameras (MTP / Image Capture — no `/Volumes` mount on macOS).
pub fn find_dcim_drives() -> Vec<SdDriveInfo> {
    let mut drives: Vec<_> = available_drives()
        .into_iter()
        .filter(|d| is_drive_ready(d) && is_action_cam_sd_card(d))
        .map(make_sd_drive_info)
        .collect();
    let visible_usb = SD_MONITOR.visible_usb_action_cam_ids();
    for cam in crate::sd_card::mtp::usb_enumerate::list_allowlisted_usb_cameras() {
        if !visible_usb.contains(&cam.source_id) {
            continue;
        }
        if drives.iter().any(|d| d.drive == cam.source_id) {
            continue;
        }
        drives.push(SdDriveInfo {
            drive: cam.source_id,
            dcim_path: String::new(),
            ready: true,
            volume_name: cam.label,
        });
    }
    drives
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generic_volume_names_filtered() {
        assert!(is_generic_volume_name(""));
        assert!(is_generic_volume_name("  "));
        assert!(is_generic_volume_name("NO NAME"));
        assert!(is_generic_volume_name("Untitled"));
        assert!(is_generic_volume_name("Removable Disk"));
        assert!(is_generic_volume_name("Wechseldatenträger"));
        assert!(is_generic_volume_name("Neuer Datenträger"));
        assert!(!is_generic_volume_name("DJI_001"));
        assert!(!is_generic_volume_name("GOPRO"));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_volume_name_uses_basename() {
        assert_eq!(unix_volume_name("/Volumes/DJI_001"), "DJI_001");
        assert_eq!(unix_volume_name("/run/media/alice/SDCARD/"), "SDCARD");
        assert_eq!(unix_volume_name("/media/usb"), "usb");
    }

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
            ejected_mtp_sources: Mutex::new(HashSet::new()),
            backup_in_progress: AtomicBool::new(false),
            history: Mutex::new(MediaHistoryStore::open_at(hist.path().join("h.db")).unwrap()),
            list_cache: Mutex::new(None),
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
            ejected_mtp_sources: Mutex::new(HashSet::new()),
            backup_in_progress: AtomicBool::new(false),
            history: Mutex::new(MediaHistoryStore::open_at(hist.path().join("h.db")).unwrap()),
            list_cache: Mutex::new(None),
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
            ejected_mtp_sources: Mutex::new(HashSet::new()),
            backup_in_progress: AtomicBool::new(false),
            history: Mutex::new(MediaHistoryStore::open_at(hist.path().join("h.db")).unwrap()),
            list_cache: Mutex::new(None),
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
        assert!(!result.secondary_async_started);
        let primary = PathBuf::from(result.backup_path.unwrap());
        assert!(primary.join("clip.mp4").is_file());
    }

    #[test]
    fn backup_async_secondary_returns_before_mirror_finishes() {
        use crate::sd_card::secondary_backup::{with_queue_lock, SECONDARY_BACKUP};
        use std::time::Duration;

        with_queue_lock(|| {
            let src = tempdir().unwrap();
            let dcim = src.path().join("DCIM").join("100");
            fs::create_dir_all(&dcim).unwrap();
            fs::write(dcim.join("clip.mp4"), b"async-bytes").unwrap();

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
                ejected_mtp_sources: Mutex::new(HashSet::new()),
                backup_in_progress: AtomicBool::new(false),
                history: Mutex::new(
                    MediaHistoryStore::open_at(hist.path().join("h.db")).unwrap(),
                ),
                list_cache: Mutex::new(None),
                config_provider: Mutex::new(Box::new({
                    let p = primary_root.path().to_path_buf();
                    let s = secondary_root.path().to_path_buf();
                    move || {
                        let mut c = AppConfig::default();
                        c.sd_backup_folder = p.to_string_lossy().into_owned();
                        c.sd_server_backup_enabled = true;
                        c.sd_server_backup_path = s.to_string_lossy().into_owned();
                        c.sd_server_backup_mode = "local_then_server_async".into();
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
            assert!(result.secondary_async_started);
            assert!(result.secondary_backup_path.is_none());
            assert!(result.secondary_warning.is_none());
            let primary = PathBuf::from(result.backup_path.as_ref().unwrap());
            assert!(primary.join("clip.mp4").is_file());

            assert!(SECONDARY_BACKUP.wait_idle(Duration::from_secs(5)));
            let folder_name = primary.file_name().unwrap().to_string_lossy();
            let secondary = secondary_root.path().join(folder_name.as_ref());
            assert!(secondary.join("clip.mp4").is_file());
            assert!(secondary
                .join(crate::media::dji_paths::BACKUP_MANIFEST_NAME)
                .is_file());
        });
    }

    #[test]
    fn workflow_progress_steps_has_no_byte_fields() {
        let p = workflow_progress("clear", 2, 5, "SD wird bereinigt…");
        assert_eq!(p.percent, 40.0);
        assert!(p.current_mb.is_none());
        assert!(p.file_index.is_none());
    }

    #[test]
    fn workflow_progress_import_copy_uses_bytes_for_percent() {
        let p = workflow_progress_import_copy(
            512 * 1024,
            1024 * 1024,
            12.5,
            2,
            4,
            "DJI_0002.MP4",
            "Kopiere Videos…",
        );
        assert_eq!(p.stage, "import");
        assert!((p.percent - 50.0).abs() < 0.01);
        assert!((p.current_mb.unwrap() - 0.5).abs() < 0.01);
        assert!((p.total_mb.unwrap() - 1.0).abs() < 0.01);
        assert_eq!(p.speed_mbps, Some(12.5));
        assert_eq!(p.file_index, Some(2));
        assert_eq!(p.file_total, Some(4));
        assert_eq!(p.file_name.as_deref(), Some("DJI_0002.MP4"));
    }

    #[test]
    fn workflow_progress_import_probe_has_no_speed() {
        let p = workflow_progress_import_probe(3, 5, "clip.mp4", "Analysiere Videos…");
        assert_eq!(p.percent, 60.0);
        assert!(p.current_mb.is_none());
        assert!(p.speed_mbps.is_none());
        assert_eq!(p.file_index, Some(3));
        assert_eq!(p.file_name.as_deref(), Some("clip.mp4"));
    }

    #[test]
    fn list_files_is_metadata_only_until_enrich() {
        let src = tempdir().unwrap();
        let dcim = src.path().join("DCIM").join("100");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("a.jpg"), vec![0u8; 2048]).unwrap();
        fs::write(dcim.join("b.mp4"), vec![0u8; 4096]).unwrap();

        let hist = tempdir().unwrap();
        let monitor = SdCardMonitor {
            monitoring: AtomicBool::new(false),
            known_drives: Mutex::new(HashSet::new()),
            action_cam_drives: Mutex::new(HashSet::new()),
            pending_drives: Mutex::new(HashSet::new()),
            declined_drives: Mutex::new(HashSet::new()),
            processed_drives: Mutex::new(HashSet::new()),
            processing_drives: Mutex::new(HashSet::new()),
            ejected_mtp_sources: Mutex::new(HashSet::new()),
            backup_in_progress: AtomicBool::new(false),
            history: Mutex::new(MediaHistoryStore::open_at(hist.path().join("h.db")).unwrap()),
            list_cache: Mutex::new(None),
            config_provider: Mutex::new(Box::new(AppConfig::default)),
            on_progress: Mutex::new(None),
            on_workflow: Mutex::new(None),
            on_status: Mutex::new(None),
            on_inserted: Mutex::new(None),
            on_removed: Mutex::new(None),
        };

        let drive = src.path().to_string_lossy().into_owned();
        let listed = monitor.list_files(&drive).unwrap();
        assert_eq!(listed.files.len(), 2);
        for f in &listed.files {
            assert!(!f.already_processed);
            assert_eq!(f.display_epoch, f.mtime);
        }

        // Second list should hit cache (same paths / totals).
        let listed2 = monitor.list_files(&drive).unwrap();
        assert_eq!(listed2.files.len(), 2);
        assert_eq!(listed2.total_size_bytes, listed.total_size_bytes);

        let enriched = monitor.enrich_files(&drive, None).unwrap();
        assert_eq!(enriched.len(), 2);
        for e in &enriched {
            assert!(!e.already_processed);
            assert!(e.display_epoch > 0.0 || e.display_epoch == 0.0);
        }
    }

    #[test]
    fn catalog_entry_builds_sd_file_info_without_local_file() {
        let info = sd_file_info_from_catalog(
            "/tmp/aero_tandem_ica/mtp_gopro_x/GX010123.MP4".into(),
            "GX010123.MP4",
            1_048_576,
            1_690_000_000.0,
        );
        assert_eq!(info.filename, "GX010123.MP4");
        assert!(info.is_video);
        assert_eq!(info.size_bytes, 1_048_576);
        assert_eq!(info.display_epoch, info.mtime);
        assert!(!info.already_processed);
        let photo = sd_file_info_from_catalog(
            "/tmp/aero_tandem_ica/mtp_gopro_x/GOPR0001.JPG".into(),
            "GOPR0001.JPG",
            2048,
            1.0,
        );
        assert!(!photo.is_video);
    }
}
