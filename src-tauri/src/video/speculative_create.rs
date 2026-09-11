//! Phase 46 — Speculative Create Staging (Compatible, Intro off).
//!
//! Prepares body video + original photo copies under a temp layout while the
//! operator has not yet clicked Erstellen. No marker / manifest / AMS / history
//! until commit via [`promote_into_create_job`].

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::model::Kunde;
use crate::storage::config::{normalize_body_concat_mode, AppConfig};
use crate::storage::logging::{self, file_name};
use crate::video::export_job::{self, CreateJobOptions, CreateJobResult};
use crate::video::export_paths::{
    create_base_output_dir, needs_foto_product, needs_video_product, video_output_path,
    video_subdir_name, OutputLayout, SUBDIR_HANDCAM_FOTO, SUBDIR_OUTSIDE_FOTO,
    SUBDIR_PREVIEW_FOTO, SUBDIR_PREVIEW_VIDEO,
};
use crate::video::ffmpeg::{
    cancel_encode, is_cancelled, reset_cancel_flag, ProgressCallback,
};
use crate::video::handoff_manifest::write_handoff_manifest;
use crate::video::marker::write_marker_file;
use crate::video::processor::{
    create_video, CreateVideoOptions, CreateVideoResult, IntroMuxAskFn, ProcessorError,
};
use crate::video::body_concat_fallback::{BodyConcatAskFn, BodyConcatChoice};
use crate::video::intro_mux_fallback::IntroMuxChoice;
use crate::video::progress::EncodeProgress;
use crate::video::reencode_confirm::{ReencodeAskFn, ReencodeDecision};
use crate::video::watermark::{
    create_photo_with_watermark, create_video_with_watermark, resolve_stamp,
};
use crate::video::export_paths::{
    foto_unpaid, video_unpaid, watermark_photo_dir, watermark_video_path,
};

pub const STAGING_DIR_PREFIX: &str = "aero_studio_speculative_";
pub const STAGING_BODY_FILENAME: &str = "body.mp4";

const DISK_MARGIN_BYTES: u64 = 256 * 1024 * 1024; // 256 MiB headroom
const DISK_FACTOR_NUM: u64 = 11;
const DISK_FACTOR_DEN: u64 = 10; // 1.1× estimate

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeculativePhase {
    Idle,
    Running,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeculativeStatus {
    pub phase: SpeculativePhase,
    pub fingerprint: Option<String>,
    pub staging_id: Option<String>,
    pub percent: f64,
    pub status: String,
    pub video_ready: bool,
    pub photos_ready: bool,
    pub wm_ready: bool,
    pub attached: bool,
}

impl Default for SpeculativeStatus {
    fn default() -> Self {
        Self {
            phase: SpeculativePhase::Idle,
            fingerprint: None,
            staging_id: None,
            percent: 0.0,
            status: String::new(),
            video_ready: false,
            photos_ready: false,
            wm_ready: false,
            attached: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SpeculativeStartRequest {
    #[serde(default)]
    pub watermark_clip_index: Option<usize>,
    #[serde(default)]
    pub watermark_photo_indices: Vec<usize>,
    #[serde(default)]
    pub video: CreateVideoOptions,
    /// Frontend cut/media revision tag (sorted `path:rev` lines).
    #[serde(default)]
    pub media_revision_tag: String,
}

#[derive(Debug, Clone)]
pub(crate) struct StagingArtifacts {
    staging_dir: PathBuf,
    fingerprint: String,
    body_fp: String,
    photos_fp: String,
    wm_fp: String,
    wm_video_fp: String,
    wm_photos_fp: String,
    staging_id: String,
    video_rel: Option<PathBuf>,
    encoder: String,
    intro_created: bool,
    body_clips: usize,
    photos_copied: usize,
    rename_map: std::collections::HashMap<String, String>,
    wm_video_rel: Option<PathBuf>,
    wm_photos: usize,
    wm_ready: bool,
}

struct SlotInner {
    phase: SpeculativePhase,
    fingerprint: String,
    body_fp: String,
    photos_fp: String,
    wm_fp: String,
    wm_video_fp: String,
    wm_photos_fp: String,
    staging_id: String,
    staging_dir: PathBuf,
    percent: f64,
    status: String,
    video_ready: bool,
    photos_ready: bool,
    wm_ready: bool,
    attached: bool,
    cancel: Arc<AtomicBool>,
    artifacts: Option<StagingArtifacts>,
    fail_reason: Option<String>,
    /// Coalesced desire while a job is Running (body_fp must match).
    pending: Option<PendingStaging>,
    /// Paths + rev used to build fingerprints (attach without re-stat when FFmpeg locks inputs).
    video_paths: Vec<String>,
    photo_paths: Vec<String>,
    media_revision_tag: String,
}

/// Latest desired staging content deferred until the running job finishes.
#[derive(Debug, Clone)]
struct PendingStaging {
    fingerprint: String,
    body_fp: String,
    photos_fp: String,
    wm_fp: String,
    wm_video_fp: String,
    wm_photos_fp: String,
    video_paths: Vec<String>,
    photo_paths: Vec<String>,
    request: SpeculativeStartRequest,
    resource_dir: Option<PathBuf>,
    kunde: Kunde,
}

struct Slot {
    inner: Mutex<SlotInner>,
    cv: Condvar,
}

static SLOT: Lazy<Mutex<Option<Arc<Slot>>>> = Lazy::new(|| Mutex::new(None));

fn log_event(event: &str, detail: impl AsRef<str>) {
    logging::info(
        "speculative_create",
        format!("{event}: {}", detail.as_ref()),
    );
}

/// Content fingerprint for speculative invalidation (body + photos + WM + encode).
pub fn build_fingerprint(
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    video_opts: &CreateVideoOptions,
    media_revision_tag: &str,
    watermark_clip_index: Option<usize>,
    watermark_photo_indices: &[usize],
    resource_dir: Option<&Path>,
) -> Result<String, String> {
    let body = build_body_fingerprint(kunde, video_paths, video_opts, media_revision_tag)?;
    let photos = build_photos_fingerprint(kunde, photo_paths, media_revision_tag)?;
    let wm = build_wm_fingerprint(
        kunde,
        video_paths,
        photo_paths,
        watermark_clip_index,
        watermark_photo_indices,
        resource_dir,
        None,
    )?;
    Ok(combine_fingerprints(&body, &photos, &wm))
}

fn combine_fingerprints(body_fp: &str, photos_fp: &str, wm_fp: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(b"body:");
    hasher.update(body_fp.as_bytes());
    hasher.update(b"\nphotos:");
    hasher.update(photos_fp.as_bytes());
    hasher.update(b"\nwm:");
    hasher.update(wm_fp.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Body-only fingerprint (clips + video products + encode options + video rev lines).
pub fn build_body_fingerprint(
    kunde: &Kunde,
    video_paths: &[String],
    video_opts: &CreateVideoOptions,
    media_revision_tag: &str,
) -> Result<String, String> {
    let mut payload = String::with_capacity(512 + video_paths.len() * 128);
    payload.push_str(&format!(
        "products:hv={}|ov={}\n",
        kunde.handcam_video as u8,
        kunde.outside_video as u8,
    ));
    payload.push_str(&format!(
        "mode={}|outside={}\n",
        kunde.video_mode, kunde.is_outside_video() as u8
    ));
    for path in video_paths {
        append_file_identity(&mut payload, "clip", path)?;
    }
    let mode = normalize_body_concat_mode(&video_opts.body_concat_mode);
    payload.push_str(&format!(
        "enc:intro={}|mode={}|codec={:?}|crf={}|par={}|hw={}\n",
        video_opts.intro_enabled as u8,
        mode,
        video_opts.video_codec,
        video_opts.crf,
        video_opts.parallel_enabled as u8,
        video_opts.hw_accel_enabled as u8,
    ));
    append_rev_lines(&mut payload, media_revision_tag, 'v');
    hash_payload(&payload)
}

/// Photos-only fingerprint (photo products + files + photo rev lines).
pub fn build_photos_fingerprint(
    kunde: &Kunde,
    photo_paths: &[String],
    media_revision_tag: &str,
) -> Result<String, String> {
    let mut payload = String::with_capacity(256 + photo_paths.len() * 128);
    payload.push_str(&format!(
        "products:hf={}|of={}\n",
        kunde.handcam_foto as u8,
        kunde.outside_foto as u8,
    ));
    for path in photo_paths {
        append_file_identity(&mut payload, "photo", path)?;
    }
    append_rev_lines(&mut payload, media_revision_tag, 'p');
    hash_payload(&payload)
}

fn stamp_identity(resource_dir: Option<&Path>) -> String {
    resolve_stamp(resource_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "stamp:missing".into())
}

/// WM-video half (clip selection + unpaid video + stamp). Stable when only photo WM changes.
///
/// When `resolved_wm_clip` is set (path of the clip that will actually be watermarked),
/// fingerprint that file only — deleting unrelated clips (and FE index remap) does not
/// invalidate WM video. Do not include `clip_idx` in that case: the same file at a new
/// list index must keep the same fingerprint.
pub fn build_wm_video_fingerprint(
    kunde: &Kunde,
    video_paths: &[String],
    watermark_clip_index: Option<usize>,
    resource_dir: Option<&Path>,
    resolved_wm_clip: Option<&str>,
) -> Result<String, String> {
    let mut payload = String::with_capacity(256);
    let need_wm_video = video_unpaid(kunde) && !video_paths.is_empty();
    payload.push_str(&format!("need:v={}\n", need_wm_video as u8));
    if need_wm_video {
        payload.push_str(&format!("stamp:{}\n", stamp_identity(resource_dir)));
        if let Some(path) = resolved_wm_clip {
            append_file_identity(&mut payload, "wm_clip", path)?;
        } else if let Some(i) = watermark_clip_index {
            payload.push_str(&format!("clip_idx:{watermark_clip_index:?}\n"));
            if i < video_paths.len() {
                append_file_identity(&mut payload, "wm_clip", &video_paths[i])?;
            } else {
                payload.push_str("wm_clip:oob\n");
            }
        } else {
            // No resolved pick yet — fingerprint all candidates (default = longest).
            payload.push_str("clip_idx:None\n");
            for path in video_paths {
                append_file_identity(&mut payload, "wm_clip_cand", path)?;
            }
        }
    } else {
        payload.push_str("wm_video:none\n");
    }
    hash_payload(&payload)
}

/// WM-photos half (selection + unpaid foto + stamp). Changes on WM photo toggle.
pub fn build_wm_photos_fingerprint(
    kunde: &Kunde,
    photo_paths: &[String],
    watermark_photo_indices: &[usize],
    resource_dir: Option<&Path>,
) -> Result<String, String> {
    let mut payload = String::with_capacity(256);
    let need_wm_photos = foto_unpaid(kunde) && !photo_paths.is_empty();
    payload.push_str(&format!("need:p={}\n", need_wm_photos as u8));
    if need_wm_photos {
        payload.push_str(&format!("stamp:{}\n", stamp_identity(resource_dir)));
        let mut idxs: Vec<usize> = watermark_photo_indices.to_vec();
        idxs.sort_unstable();
        idxs.dedup();
        if idxs.is_empty() {
            payload.push_str("wm_photos:pending\n");
        } else {
            payload.push_str("wm_photos:\n");
            for i in idxs {
                if i < photo_paths.len() {
                    append_file_identity(&mut payload, "wm_photo", &photo_paths[i])?;
                } else {
                    payload.push_str(&format!("wm_photo:oob:{i}\n"));
                }
            }
        }
    } else {
        payload.push_str("wm_photos:none\n");
    }
    hash_payload(&payload)
}

fn combine_wm_halves(wm_video_fp: &str, wm_photos_fp: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(b"wm_v:");
    hasher.update(wm_video_fp.as_bytes());
    hasher.update(b"\nwm_p:");
    hasher.update(wm_photos_fp.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Watermark-only fingerprint (paid flags, clip/photo selection, stamp path).
///
/// Pass `resolved_wm_clip` (same as staging) so commit can match staged `wm_fp` /
/// `wm_video_fp` after FE index remaps.
pub fn build_wm_fingerprint(
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    watermark_clip_index: Option<usize>,
    watermark_photo_indices: &[usize],
    resource_dir: Option<&Path>,
    resolved_wm_clip: Option<&str>,
) -> Result<String, String> {
    let v = build_wm_video_fingerprint(
        kunde,
        video_paths,
        watermark_clip_index,
        resource_dir,
        resolved_wm_clip,
    )?;
    let p = build_wm_photos_fingerprint(
        kunde,
        photo_paths,
        watermark_photo_indices,
        resource_dir,
    )?;
    Ok(combine_wm_halves(&v, &p))
}

/// True when unpaid WM work can actually be produced now.
/// Unpaid WM *video* may stage without photo selection; unpaid photo WM needs indices.
fn wm_can_stage(
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    watermark_photo_indices: &[usize],
) -> bool {
    let need_wm_video = video_unpaid(kunde) && !video_paths.is_empty();
    let need_wm_photos = foto_unpaid(kunde) && !photo_paths.is_empty();
    if !need_wm_video && !need_wm_photos {
        return true; // nothing to do → considered satisfied
    }
    if need_wm_video {
        return true;
    }
    !watermark_photo_indices.is_empty()
}

/// Skip speculative WM when foto product is active but photos are not imported yet
/// (WM will follow via pending drain / photo refresh).
fn skip_wm_until_photos(kunde: &Kunde, photo_paths: &[String]) -> bool {
    needs_foto_product(kunde) && photo_paths.is_empty()
}

fn append_rev_lines(payload: &mut String, media_revision_tag: &str, prefix: char) {
    let needle = format!("{prefix}:");
    for line in media_revision_tag.lines() {
        let t = line.trim();
        if t.starts_with(&needle) {
            payload.push_str("rev:");
            payload.push_str(t);
            payload.push('\n');
        }
    }
}

fn hash_payload(payload: &str) -> Result<String, String> {
    let mut hasher = Sha1::new();
    hasher.update(payload.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

fn append_file_identity(payload: &mut String, kind: &str, path: &str) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|e| format!("cannot stat {path}: {e}"))?;
    let len = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    payload.push_str(&format!("{kind}:{path}|{len}|{mtime}\n"));
    Ok(())
}

/// Estimate bytes needed for staging (videos + photos) with margin.
pub fn estimate_staging_bytes(video_paths: &[String], photo_paths: &[String]) -> u64 {
    let mut total = 0u64;
    for p in video_paths.iter().chain(photo_paths.iter()) {
        if let Ok(meta) = fs::metadata(p) {
            total = total.saturating_add(meta.len());
        }
    }
    // Body output ≈ sum of videos (compatible is mostly copy/remux).
    for p in video_paths {
        if let Ok(meta) = fs::metadata(p) {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

pub fn disk_preflight_ok(staging_root_parent: &Path, needed: u64) -> bool {
    let required = (needed.saturating_mul(DISK_FACTOR_NUM) / DISK_FACTOR_DEN)
        .saturating_add(DISK_MARGIN_BYTES);
    match available_bytes_for_path(staging_root_parent) {
        Some(free) => free >= required,
        None => true, // fail-open when OS probe unavailable
    }
}

fn available_bytes_for_path(path: &Path) -> Option<u64> {
    let mut cur = path.to_path_buf();
    loop {
        if cur.exists() {
            return disk_available_bytes(&cur);
        }
        if !cur.pop() {
            return disk_available_bytes(path);
        }
    }
}

#[cfg(windows)]
fn disk_available_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_for_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut free_total: u64 = 0;
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free_for_caller),
            Some(&mut total),
            Some(&mut free_total),
        )
        .ok()?;
    }
    Some(free_for_caller)
}

#[cfg(unix)]
fn disk_available_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut stat) != 0 {
            return None;
        }
        Some(stat.f_bavail as u64 * stat.f_frsize as u64)
    }
}

#[cfg(not(any(windows, unix)))]
fn disk_available_bytes(_path: &Path) -> Option<u64> {
    None
}

pub fn status() -> SpeculativeStatus {
    let guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        None => SpeculativeStatus::default(),
        Some(slot) => {
            let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
            status_from_inner(&inner)
        }
    }
}

/// Preconditions that must hold before starting (caller also checks UI createReady).
pub fn preconditions_ok(video_opts: &CreateVideoOptions) -> Result<(), String> {
    if video_opts.intro_enabled {
        return Err("intro_enabled".into());
    }
    let mode = normalize_body_concat_mode(&video_opts.body_concat_mode);
    if mode != "compatible" {
        return Err(format!("body_concat_mode={mode}"));
    }
    Ok(())
}

/// Cancel current slot (if any), delete staging dir, clear state.
///
/// Only raises the global FFmpeg cancel flag when a staging encode is **running**.
/// Ready/idle cleanup must not touch `cancel_encode` — that races photo/video imports.
pub fn cancel_and_cleanup(reason: &str) {
    let slot = {
        let mut guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        guard.take()
    };
    if let Some(slot) = slot {
        let (was_running, dir) = {
            let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
            let was_running = inner.phase == SpeculativePhase::Running;
            inner.cancel.store(true, Ordering::SeqCst);
            inner.phase = SpeculativePhase::Failed;
            inner.fail_reason = Some(reason.into());
            (was_running, inner.staging_dir.clone())
        };
        if was_running {
            cancel_encode();
            // Give worker a moment to notice cancel before deleting.
            std::thread::sleep(Duration::from_millis(50));
            reset_cancel_flag();
        }
        slot.cv.notify_all();
        remove_staging_dir(&dir);
        log_event("speculative_cleanup", reason);
    }
}

/// App-exit / session-clear hook.
pub fn cleanup_all() {
    cancel_and_cleanup("session_clear");
    // Sweep any leftover speculative dirs under temp.
    sweep_orphan_staging_dirs();
}

fn sweep_orphan_staging_dirs() {
    let temp = std::env::temp_dir();
    let Ok(entries) = fs::read_dir(&temp) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with(STAGING_DIR_PREFIX) {
            remove_staging_dir(&path);
        }
    }
}

fn remove_staging_dir(dir: &Path) {
    if dir.is_dir() {
        let _ = fs::remove_dir_all(dir);
    }
}

fn new_staging_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}_{}", std::process::id())
}

/// Start (or incrementally update) the single speculative staging slot.
pub fn start_staging(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    request: &SpeculativeStartRequest,
    resource_dir: Option<&Path>,
) -> Result<SpeculativeStatus, String> {
    preconditions_ok(&request.video).map_err(|e| {
        log_event("speculative_miss_gate", &e);
        e
    })?;

    let body_fp = build_body_fingerprint(
        kunde,
        video_paths,
        &request.video,
        &request.media_revision_tag,
    )?;
    let photos_fp =
        build_photos_fingerprint(kunde, photo_paths, &request.media_revision_tag)?;
    let resolved_wm_clip = if video_unpaid(kunde) && !video_paths.is_empty() {
        export_job::pick_watermark_clip(ffmpeg, video_paths, request.watermark_clip_index)
    } else {
        None
    };
    let wm_video_fp = build_wm_video_fingerprint(
        kunde,
        video_paths,
        request.watermark_clip_index,
        resource_dir,
        resolved_wm_clip.as_deref(),
    )?;
    let wm_photos_fp = build_wm_photos_fingerprint(
        kunde,
        photo_paths,
        &request.watermark_photo_indices,
        resource_dir,
    )?;
    let wm_fp = combine_wm_halves(&wm_video_fp, &wm_photos_fp);
    let fp = combine_fingerprints(&body_fp, &photos_fp, &wm_fp);

    // Same fingerprint already ready/running → keep (drop stale pending).
    // Ready + partial match → incremental update (keep valid halves).
    // Running + body same → defer into pending (do not cancel_encode).
    {
        let guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = guard.as_ref() {
            let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(
                inner.phase,
                SpeculativePhase::Running | SpeculativePhase::Ready
            ) {
                if inner.fingerprint == fp {
                    inner.pending = None;
                    return Ok(status_from_inner(&inner));
                }
                if inner.phase == SpeculativePhase::Running && inner.body_fp == body_fp {
                    // Photos and/or WM changed while body encode runs — queue, don't kill.
                    inner.pending = Some(PendingStaging {
                        fingerprint: fp.clone(),
                        body_fp: body_fp.clone(),
                        photos_fp: photos_fp.clone(),
                        wm_fp: wm_fp.clone(),
                        wm_video_fp: wm_video_fp.clone(),
                        wm_photos_fp: wm_photos_fp.clone(),
                        video_paths: video_paths.to_vec(),
                        photo_paths: photo_paths.to_vec(),
                        request: request.clone(),
                        resource_dir: resource_dir.map(|p| p.to_path_buf()),
                        kunde: kunde.clone(),
                    });
                    log_event(
                        "speculative_defer",
                        format!(
                            "running id={} photos={} wm_changed={}",
                            inner.staging_id,
                            photo_paths.len(),
                            inner.wm_fp != wm_fp
                        ),
                    );
                    return Ok(status_from_inner(&inner));
                }
                if inner.phase == SpeculativePhase::Ready {
                    let body_same = inner.body_fp == body_fp;
                    let photos_same = inner.photos_fp == photos_fp;
                    let wm_same = inner.wm_fp == wm_fp;
                    inner.pending = None;
                    if body_same && photos_same && !wm_same {
                        // Photo-WM selection changes must not re-encode. Keep body/photos
                        // (and WM video if clip half stable); photo WMs happen at commit.
                        let video_same = inner.wm_video_fp == wm_video_fp;
                        if video_same {
                            inner.pending = None;
                            inner.fingerprint = fp.clone();
                            inner.wm_fp = wm_fp.clone();
                            inner.wm_video_fp = wm_video_fp.clone();
                            inner.wm_photos_fp = wm_photos_fp.clone();
                            let photos_half_same = inner
                                .artifacts
                                .as_ref()
                                .is_some_and(|a| a.wm_photos_fp == wm_photos_fp);
                            if !photos_half_same {
                                inner.wm_ready = false;
                            }
                            if let Some(art) = inner.artifacts.as_mut() {
                                art.fingerprint = fp.clone();
                                art.wm_fp = wm_fp.clone();
                                art.wm_video_fp = wm_video_fp.clone();
                                if art.wm_photos_fp != wm_photos_fp {
                                    art.wm_photos_fp = wm_photos_fp.clone();
                                    art.wm_ready = false;
                                    art.wm_photos = 0;
                                }
                            }
                            log_event(
                                "speculative_hit",
                                "wm_photos_desire_only_no_work",
                            );
                            return Ok(status_from_inner(&inner));
                        }
                        drop(inner);
                        drop(guard);
                        return refresh_wm_incremental(
                            ffmpeg,
                            kunde,
                            video_paths,
                            photo_paths,
                            request,
                            resource_dir,
                            &fp,
                            &body_fp,
                            &photos_fp,
                            &wm_fp,
                            &wm_video_fp,
                            &wm_photos_fp,
                        );
                    }
                    if body_same && !photos_same {
                        drop(inner);
                        drop(guard);
                        return refresh_photos_incremental(
                            ffmpeg,
                            kunde,
                            video_paths,
                            photo_paths,
                            request,
                            resource_dir,
                            &fp,
                            &body_fp,
                            &photos_fp,
                            &wm_fp,
                            &wm_video_fp,
                            &wm_photos_fp,
                        );
                    }
                    if photos_same && !body_same {
                        let staging_dir = inner.staging_dir.clone();
                        let staging_id = inner.staging_id.clone();
                        let keep_photos = inner
                            .artifacts
                            .as_ref()
                            .map(|a| (a.photos_copied, a.rename_map.clone()));
                        let keep_wm_video = if inner.wm_video_fp == wm_video_fp {
                            inner
                                .artifacts
                                .as_ref()
                                .and_then(|a| a.wm_video_rel.as_ref())
                                .filter(|rel| inner.staging_dir.join(rel).is_file())
                                .cloned()
                        } else {
                            None
                        };
                        drop(inner);
                        drop(guard);
                        return rebuild_body_incremental(
                            ffmpeg,
                            kunde,
                            video_paths,
                            photo_paths,
                            request,
                            resource_dir,
                            staging_dir,
                            staging_id,
                            fp,
                            body_fp,
                            photos_fp,
                            wm_fp,
                            wm_video_fp,
                            wm_photos_fp,
                            keep_photos,
                            keep_wm_video,
                        );
                    }
                }
            }
        }
    }

    cancel_and_cleanup("speculative_miss_invalidate");

    let needed = estimate_staging_bytes(video_paths, photo_paths);
    let temp_root = std::env::temp_dir();
    if !disk_preflight_ok(&temp_root, needed) {
        log_event(
            "speculative_skip_disk",
            format!("needed≈{needed} under {}", temp_root.display()),
        );
        return Ok(SpeculativeStatus::default());
    }

    if is_cancelled() {
        log_event("speculative_skip_busy", "cancel_flag set");
        return Ok(SpeculativeStatus::default());
    }

    let staging_id = new_staging_id();
    let staging_dir = temp_root.join(format!("{STAGING_DIR_PREFIX}{staging_id}"));
    fs::create_dir_all(&staging_dir).map_err(|e| e.to_string())?;

    spawn_full_staging_job(
        ffmpeg,
        kunde,
        video_paths,
        photo_paths,
        request,
        resource_dir,
        staging_dir,
        staging_id,
        fp,
        body_fp,
        photos_fp,
        wm_fp,
        wm_video_fp,
        wm_photos_fp,
        None,
        None,
    )
}

/// Apply coalesced pending after a job reaches Ready (photos/WM only; body already matches).
fn try_drain_pending(ffmpeg: &Path, slot: &Arc<Slot>) {
    let pending = {
        let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.phase != SpeculativePhase::Ready {
            return;
        }
        inner.pending.take()
    };
    let Some(pending) = pending else {
        return;
    };

    {
        let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.fingerprint == pending.fingerprint {
            log_event("speculative_drain", "noop_same_fp");
            return;
        }
        let photos_same = inner.photos_fp == pending.photos_fp;
        let wm_same = inner.wm_fp == pending.wm_fp;
        if photos_same && wm_same {
            log_event("speculative_drain", "noop_halves");
            return;
        }
        drop(inner);
    }

    log_event(
        "speculative_drain",
        format!(
            "photos={} fp={}",
            pending.photo_paths.len(),
            &pending.fingerprint[..8.min(pending.fingerprint.len())]
        ),
    );

    let resource = pending.resource_dir.as_deref();
    let photos_same = {
        let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.photos_fp == pending.photos_fp
    };

    let result = if !photos_same {
        refresh_photos_incremental(
            ffmpeg,
            &pending.kunde,
            &pending.video_paths,
            &pending.photo_paths,
            &pending.request,
            resource,
            &pending.fingerprint,
            &pending.body_fp,
            &pending.photos_fp,
            &pending.wm_fp,
            &pending.wm_video_fp,
            &pending.wm_photos_fp,
        )
    } else {
        // Photos already match — WM photo selection is desire-only (commit generates).
        // Only refresh when unpaid WM *video* half changed (clip / paid flags).
        let video_same = {
            let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.wm_video_fp == pending.wm_video_fp
        };
        if video_same {
            let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.fingerprint = pending.fingerprint.clone();
            inner.wm_fp = pending.wm_fp.clone();
            inner.wm_video_fp = pending.wm_video_fp.clone();
            inner.wm_photos_fp = pending.wm_photos_fp.clone();
            if let Some(art) = inner.artifacts.as_mut() {
                if art.wm_photos_fp != pending.wm_photos_fp {
                    art.wm_photos_fp = pending.wm_photos_fp.clone();
                    art.wm_fp = pending.wm_fp.clone();
                    art.fingerprint = pending.fingerprint.clone();
                    art.wm_ready = false;
                    art.wm_photos = 0;
                    inner.wm_ready = false;
                }
            }
            log_event("speculative_drain", "wm_photos_desire_only");
            Ok(status_from_inner(&inner))
        } else {
            refresh_wm_incremental(
                ffmpeg,
                &pending.kunde,
                &pending.video_paths,
                &pending.photo_paths,
                &pending.request,
                resource,
                &pending.fingerprint,
                &pending.body_fp,
                &pending.photos_fp,
                &pending.wm_fp,
                &pending.wm_video_fp,
                &pending.wm_photos_fp,
            )
        }
    };
    if let Err(e) = result {
        log_event("speculative_miss_gate", format!("drain failed: {e}"));
    }
}

fn refresh_wm_incremental(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    request: &SpeculativeStartRequest,
    resource_dir: Option<&Path>,
    fp: &str,
    body_fp: &str,
    photos_fp: &str,
    wm_fp: &str,
    wm_video_fp: &str,
    wm_photos_fp: &str,
) -> Result<SpeculativeStatus, String> {
    let slot = {
        let guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone()
    };
    let Some(slot) = slot else {
        return Ok(SpeculativeStatus::default());
    };

    let (staging_dir, rename_map, reuse_wm_video) = {
        let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.phase != SpeculativePhase::Ready {
            return Ok(status_from_inner(&inner));
        }
        let reuse = if inner.wm_video_fp == wm_video_fp {
            inner
                .artifacts
                .as_ref()
                .and_then(|a| a.wm_video_rel.as_ref())
                .filter(|rel| inner.staging_dir.join(rel).is_file())
                .cloned()
        } else {
            None
        };
        inner.phase = SpeculativePhase::Running;
        inner.fingerprint = fp.to_string();
        inner.wm_fp = wm_fp.to_string();
        inner.wm_video_fp = wm_video_fp.to_string();
        inner.wm_photos_fp = wm_photos_fp.to_string();
        inner.wm_ready = false;
        inner.percent = 80.0;
        inner.status = if reuse.is_some() {
            "Foto-Wasserzeichen…".into()
        } else {
            "Wasserzeichen…".into()
        };
        inner.video_paths = video_paths.to_vec();
        inner.photo_paths = photo_paths.to_vec();
        inner.media_revision_tag = request.media_revision_tag.clone();
        let rename_map = inner
            .artifacts
            .as_ref()
            .map(|a| a.rename_map.clone())
            .unwrap_or_default();
        (inner.staging_dir.clone(), rename_map, reuse)
    };
    slot.cv.notify_all();

    log_event(
        "speculative_start",
        format!(
            "incremental wm id={} reuse_video={}",
            staging_dir.display(),
            reuse_wm_video.is_some()
        ),
    );

    let ffmpeg = ffmpeg.to_path_buf();
    let kunde = kunde.clone();
    let video_paths = video_paths.to_vec();
    let photo_paths = photo_paths.to_vec();
    let request = request.clone();
    let resource_dir = resource_dir.map(|p| p.to_path_buf());
    let fp = fp.to_string();
    let body_fp = body_fp.to_string();
    let photos_fp = photos_fp.to_string();
    let wm_fp = wm_fp.to_string();
    let wm_video_fp = wm_video_fp.to_string();
    let wm_photos_fp = wm_photos_fp.to_string();
    let slot_worker = Arc::clone(&slot);

    std::thread::Builder::new()
        .name("speculative-wm".into())
        .spawn(move || {
            if reuse_wm_video.is_some() {
                clear_wm_photo_dir(&staging_dir);
            } else {
                clear_wm_dirs(&staging_dir);
            }
            let layout = OutputLayout {
                base_dir: staging_dir.clone(),
                base_filename: "body".into(),
            };
            let on_progress: ProgressCallback = {
                let slot = Arc::clone(&slot_worker);
                Arc::new(move |p: EncodeProgress| {
                    push_progress(&slot, p);
                })
            };
            let wm = match stage_watermarks(
                &ffmpeg,
                &kunde,
                &video_paths,
                &photo_paths,
                &request,
                resource_dir.as_deref(),
                &layout,
                &rename_map,
                &on_progress,
                reuse_wm_video,
            ) {
                Ok(w) => w,
                Err(e) => {
                    log_event("speculative_miss_gate", e.to_string());
                    let mut inner = slot_worker.inner.lock().unwrap_or_else(|e| e.into_inner());
                    // Keep body/photos ready; mark WM failed → not ready.
                    inner.phase = SpeculativePhase::Ready;
                    inner.wm_ready = false;
                    inner.status = "Bereit".into();
                    inner.percent = 100.0;
                    slot_worker.cv.notify_all();
                    return;
                }
            };
            let mut inner = slot_worker.inner.lock().unwrap_or_else(|e| e.into_inner());
            if inner.cancel.load(Ordering::SeqCst) {
                return;
            }
            inner.phase = SpeculativePhase::Ready;
            inner.fingerprint = fp.clone();
            inner.body_fp = body_fp.clone();
            inner.photos_fp = photos_fp.clone();
            inner.wm_fp = wm_fp.clone();
            inner.wm_video_fp = wm_video_fp.clone();
            inner.wm_photos_fp = wm_photos_fp.clone();
            inner.wm_ready = wm.ready;
            inner.percent = 100.0;
            inner.status = "Bereit".into();
            if let Some(art) = inner.artifacts.as_mut() {
                art.fingerprint = fp;
                art.body_fp = body_fp;
                art.photos_fp = photos_fp;
                art.wm_fp = wm_fp;
                art.wm_video_fp = wm_video_fp;
                art.wm_photos_fp = wm_photos_fp;
                art.wm_video_rel = wm.video_rel;
                art.wm_photos = wm.photos;
                art.wm_ready = wm.ready;
                if !wm.encoder.is_empty() && art.encoder.is_empty() {
                    art.encoder = wm.encoder;
                }
            }
            slot_worker.cv.notify_all();
            log_event(
                "speculative_hit",
                if wm.reused_video {
                    "incremental_wm_photos_only"
                } else {
                    "incremental_wm"
                },
            );
            try_drain_pending(&ffmpeg, &slot_worker);
        })
        .map_err(|e| e.to_string())?;

    Ok(status())
}

fn refresh_photos_incremental(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    request: &SpeculativeStartRequest,
    resource_dir: Option<&Path>,
    fp: &str,
    body_fp: &str,
    photos_fp: &str,
    wm_fp: &str,
    wm_video_fp: &str,
    wm_photos_fp: &str,
) -> Result<SpeculativeStatus, String> {
    let slot = {
        let guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone()
    };
    let Some(slot) = slot else {
        return Ok(SpeculativeStatus::default());
    };

    let reuse_wm_video = {
        let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.phase != SpeculativePhase::Ready {
            return Ok(status_from_inner(&inner));
        }
        let reuse = if inner.wm_video_fp == wm_video_fp {
            inner
                .artifacts
                .as_ref()
                .and_then(|a| a.wm_video_rel.as_ref())
                .filter(|rel| inner.staging_dir.join(rel).is_file())
                .cloned()
        } else {
            None
        };
        inner.phase = SpeculativePhase::Running;
        inner.fingerprint = fp.to_string();
        inner.photos_fp = photos_fp.to_string();
        inner.wm_fp = wm_fp.to_string();
        inner.wm_video_fp = wm_video_fp.to_string();
        inner.wm_photos_fp = wm_photos_fp.to_string();
        inner.photos_ready = false;
        inner.wm_ready = false;
        inner.percent = 75.0;
        inner.status = "Kopiere Fotos…".into();
        inner.video_paths = video_paths.to_vec();
        inner.photo_paths = photo_paths.to_vec();
        inner.media_revision_tag = request.media_revision_tag.clone();
        reuse
    };
    slot.cv.notify_all();

    let staging_dir = {
        let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.staging_dir.clone()
    };

    log_event(
        "speculative_start",
        format!(
            "incremental photos id={} n={} reuse_wm_video={}",
            staging_dir.display(),
            photo_paths.len(),
            reuse_wm_video.is_some()
        ),
    );

    let ffmpeg = ffmpeg.to_path_buf();
    let kunde = kunde.clone();
    let video_paths = video_paths.to_vec();
    let photo_paths = photo_paths.to_vec();
    let request = request.clone();
    let resource_dir = resource_dir.map(|p| p.to_path_buf());
    let fp = fp.to_string();
    let body_fp = body_fp.to_string();
    let photos_fp = photos_fp.to_string();
    let wm_fp = wm_fp.to_string();
    let wm_video_fp = wm_video_fp.to_string();
    let wm_photos_fp = wm_photos_fp.to_string();
    let slot_worker = Arc::clone(&slot);

    std::thread::Builder::new()
        .name("speculative-photos".into())
        .spawn(move || {
            clear_photo_product_dirs(&staging_dir);
            if reuse_wm_video.is_some() {
                clear_wm_photo_dir(&staging_dir);
            } else {
                clear_wm_dirs(&staging_dir);
            }
            let layout = OutputLayout {
                base_dir: staging_dir.clone(),
                base_filename: "body".into(),
            };
            let on_progress: ProgressCallback = {
                let slot = Arc::clone(&slot_worker);
                Arc::new(move |p: EncodeProgress| {
                    push_progress(&slot, p);
                })
            };
            let rename_map = export_job::build_photo_rename_map(&photo_paths);
            let photos_copied = match export_job::copy_photos(
                &photo_paths,
                &layout,
                &kunde,
                &rename_map,
                &on_progress,
            ) {
                Ok(n) => n,
                Err(e) => {
                    log_event("speculative_miss_gate", e.to_string());
                    let mut inner = slot_worker.inner.lock().unwrap_or_else(|e| e.into_inner());
                    inner.phase = SpeculativePhase::Failed;
                    inner.fail_reason = Some(e.to_string());
                    slot_worker.cv.notify_all();
                    return;
                }
            };

            // Publish photos Ready before WM so attach/commit is not blocked on WM encode.
            {
                let mut inner = slot_worker.inner.lock().unwrap_or_else(|e| e.into_inner());
                if inner.cancel.load(Ordering::SeqCst) {
                    return;
                }
                inner.phase = SpeculativePhase::Ready;
                inner.fingerprint = fp.clone();
                inner.body_fp = body_fp.clone();
                inner.photos_fp = photos_fp.clone();
                inner.wm_fp = wm_fp.clone();
                inner.wm_video_fp = wm_video_fp.clone();
                inner.wm_photos_fp = wm_photos_fp.clone();
                inner.photos_ready = photos_copied > 0
                    || photo_paths.is_empty()
                    || !needs_foto_product(&kunde);
                inner.wm_ready = false;
                inner.percent = 90.0;
                inner.status = "Fotos bereit".into();
                if let Some(art) = inner.artifacts.as_mut() {
                    art.fingerprint = fp.clone();
                    art.body_fp = body_fp.clone();
                    art.photos_fp = photos_fp.clone();
                    art.wm_fp = wm_fp.clone();
                    art.wm_video_fp = wm_video_fp.clone();
                    art.wm_photos_fp = wm_photos_fp.clone();
                    art.photos_copied = photos_copied;
                    art.rename_map = rename_map.clone();
                    if reuse_wm_video.is_none() {
                        art.wm_video_rel = None;
                    }
                    art.wm_photos = 0;
                    art.wm_ready = false;
                }
                slot_worker.cv.notify_all();
            }
            log_event("speculative_hit", "incremental_photos");

            // If Erstellen already attached/took artifacts, skip speculative WM (commit does it).
            let skip_wm = {
                let inner = slot_worker.inner.lock().unwrap_or_else(|e| e.into_inner());
                inner.attached || inner.artifacts.is_none()
            };
            if skip_wm {
                try_drain_pending(&ffmpeg, &slot_worker);
                return;
            }

            let wm = stage_watermarks(
                &ffmpeg,
                &kunde,
                &video_paths,
                &photo_paths,
                &request,
                resource_dir.as_deref(),
                &layout,
                &rename_map,
                &on_progress,
                reuse_wm_video,
            )
            .unwrap_or(WmStageResult {
                video_rel: None,
                photos: 0,
                encoder: String::new(),
                ready: false,
                reused_video: false,
            });

            {
                let mut inner = slot_worker.inner.lock().unwrap_or_else(|e| e.into_inner());
                if inner.cancel.load(Ordering::SeqCst) || inner.artifacts.is_none() {
                    return;
                }
                inner.phase = SpeculativePhase::Ready;
                inner.wm_fp = wm_fp.clone();
                inner.wm_video_fp = wm_video_fp.clone();
                inner.wm_photos_fp = wm_photos_fp.clone();
                inner.wm_ready = wm.ready;
                inner.percent = 100.0;
                inner.status = "Bereit".into();
                if let Some(art) = inner.artifacts.as_mut() {
                    art.wm_fp = wm_fp;
                    art.wm_video_fp = wm_video_fp;
                    art.wm_photos_fp = wm_photos_fp;
                    art.wm_video_rel = wm.video_rel;
                    art.wm_photos = wm.photos;
                    art.wm_ready = wm.ready;
                    if !wm.encoder.is_empty() && art.encoder.is_empty() {
                        art.encoder = wm.encoder;
                    }
                }
                slot_worker.cv.notify_all();
            }
            log_event("speculative_hit", "incremental_photos_wm");
            try_drain_pending(&ffmpeg, &slot_worker);
        })
        .map_err(|e| e.to_string())?;

    Ok(status())
}

fn rebuild_body_incremental(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    request: &SpeculativeStartRequest,
    resource_dir: Option<&Path>,
    staging_dir: PathBuf,
    staging_id: String,
    fp: String,
    body_fp: String,
    photos_fp: String,
    wm_fp: String,
    wm_video_fp: String,
    wm_photos_fp: String,
    keep_photos: Option<(usize, std::collections::HashMap<String, String>)>,
    keep_wm_video: Option<PathBuf>,
) -> Result<SpeculativeStatus, String> {
    let needed = estimate_staging_bytes(video_paths, &[]);
    if !disk_preflight_ok(staging_dir.parent().unwrap_or(staging_dir.as_path()), needed) {
        log_event(
            "speculative_skip_disk",
            format!("incremental body needed≈{needed}"),
        );
        return Ok(SpeculativeStatus::default());
    }

    // Drop old slot entry but keep the staging directory (photos / WM video may stay).
    {
        let mut guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }
    if keep_wm_video.is_some() {
        // Body clips changed but WM source clip is stable — keep Preview video.
        clear_wm_photo_dir(&staging_dir);
    } else {
        clear_wm_dirs(&staging_dir);
    }
    log_event(
        "speculative_start",
        format!(
            "incremental body id={staging_id} videos={} reuse_wm_video={}",
            video_paths.len(),
            keep_wm_video.is_some()
        ),
    );
    spawn_full_staging_job(
        ffmpeg,
        kunde,
        video_paths,
        photo_paths,
        request,
        resource_dir,
        staging_dir,
        staging_id,
        fp,
        body_fp,
        photos_fp,
        wm_fp,
        wm_video_fp,
        wm_photos_fp,
        keep_photos,
        keep_wm_video,
    )
}

fn clear_photo_product_dirs(staging_dir: &Path) {
    for sub in [SUBDIR_HANDCAM_FOTO, SUBDIR_OUTSIDE_FOTO] {
        let dir = staging_dir.join(sub);
        if dir.is_dir() {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

fn clear_wm_photo_dir(staging_dir: &Path) {
    let dir = staging_dir.join(SUBDIR_PREVIEW_FOTO);
    if dir.is_dir() {
        let _ = fs::remove_dir_all(&dir);
    }
}

fn clear_wm_dirs(staging_dir: &Path) {
    for sub in [SUBDIR_PREVIEW_VIDEO, SUBDIR_PREVIEW_FOTO] {
        let dir = staging_dir.join(sub);
        if dir.is_dir() {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

struct WmStageResult {
    video_rel: Option<PathBuf>,
    photos: usize,
    encoder: String,
    ready: bool,
    reused_video: bool,
}

fn stage_watermarks(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    request: &SpeculativeStartRequest,
    resource_dir: Option<&Path>,
    layout: &OutputLayout,
    rename_map: &std::collections::HashMap<String, String>,
    on_progress: &ProgressCallback,
    reuse_wm_video: Option<PathBuf>,
) -> Result<WmStageResult, ProcessorError> {
    // Foto-Produkt aktiv, aber noch keine Fotos → WM später mit Photo-Refresh/Drain.
    if skip_wm_until_photos(kunde, photo_paths) {
        return Ok(WmStageResult {
            video_rel: reuse_wm_video,
            photos: 0,
            encoder: String::new(),
            ready: false,
            reused_video: false,
        });
    }

    let can = wm_can_stage(
        kunde,
        video_paths,
        photo_paths,
        &request.watermark_photo_indices,
    );
    if !can {
        // Pending photo WM selection — body/photos may still be ready.
        // Keep reused WM video on disk for a later selection.
        return Ok(WmStageResult {
            video_rel: reuse_wm_video,
            photos: 0,
            encoder: String::new(),
            ready: false,
            reused_video: false,
        });
    }

    let need_wm_video = video_unpaid(kunde) && !video_paths.is_empty();
    let need_wm_photos =
        foto_unpaid(kunde) && !request.watermark_photo_indices.is_empty();
    if !need_wm_video && !need_wm_photos {
        return Ok(WmStageResult {
            video_rel: None,
            photos: 0,
            encoder: String::new(),
            ready: true,
            reused_video: false,
        });
    }

    let mut encoder = String::new();
    let mut video_rel = None;
    let mut photos = 0usize;
    let mut reused_video = false;

    if need_wm_video {
        if let Some(rel) = reuse_wm_video {
            // Photo-selection-only refresh: keep existing unpaid WM clip.
            video_rel = Some(rel);
            reused_video = true;
        } else {
            // Match create_job: start WM phase at 0% so attach UI can climb with FFmpeg
            // (a fixed 85% + monotonic FE bar freezes the progress panel).
            on_progress(EncodeProgress {
                percent: 0.0,
                current_secs: 0.0,
                total_secs: 100.0,
                status: "Erstelle Wasserzeichen-Video…".into(),
                task_id: None,
            });
            if let Some(clip) = export_job::pick_watermark_clip(
                ffmpeg,
                video_paths,
                request.watermark_clip_index,
            ) {
                let wm_path = watermark_video_path(layout).map_err(ProcessorError::Message)?;
                let wm_str = wm_path.to_string_lossy().to_string();
                let on_wm: ProgressCallback = {
                    let on_progress = Arc::clone(on_progress);
                    Arc::new(move |p: EncodeProgress| {
                        // Keep the WM stage label while FFmpeg emits "continue".
                        let status = if p.status == "continue"
                            || p.status.is_empty()
                            || p.status == "end"
                        {
                            "Erstelle Wasserzeichen-Video…".into()
                        } else {
                            p.status
                        };
                        on_progress(EncodeProgress {
                            percent: p.percent,
                            current_secs: p.current_secs,
                            total_secs: p.total_secs,
                            status,
                            task_id: p.task_id,
                        });
                    })
                };
                encoder = create_video_with_watermark(
                    ffmpeg,
                    &clip,
                    &wm_str,
                    resource_dir,
                    on_wm,
                )?;
                video_rel = Some(
                    wm_path
                        .strip_prefix(&layout.base_dir)
                        .unwrap_or(&wm_path)
                        .to_path_buf(),
                );
            }
        }
    }

    if need_wm_photos {
        on_progress(EncodeProgress {
            percent: 90.0,
            current_secs: 90.0,
            total_secs: 100.0,
            status: "Erstelle Foto-Wasserzeichen…".into(),
            task_id: None,
        });
        let preview_dir = watermark_photo_dir(layout).map_err(ProcessorError::Message)?;
        let stamp = resolve_stamp(resource_dir)?;
        let wm_total = request.watermark_photo_indices.len().max(1);
        for (wi, &i) in request.watermark_photo_indices.iter().enumerate() {
            if i >= photo_paths.len() {
                continue;
            }
            let src = Path::new(&photo_paths[i]);
            if !src.is_file() {
                continue;
            }
            let out_name = rename_map
                .get(&photo_paths[i])
                .cloned()
                .unwrap_or_else(|| {
                    src.file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "photo.jpg".into())
                });
            let out_stem = Path::new(&out_name)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "photo".into());
            let out_path = preview_dir.join(format!("{out_stem}.jpg"));
            on_progress(EncodeProgress {
                percent: 90.0 + 10.0 * ((wi + 1) as f64 / wm_total as f64),
                current_secs: 0.0,
                total_secs: 100.0,
                status: format!("Foto-Wasserzeichen ({}/{})", wi + 1, wm_total),
                task_id: None,
            });
            create_photo_with_watermark(src, &out_path, &stamp)?;
            photos += 1;
        }
    }

    Ok(WmStageResult {
        video_rel,
        photos,
        encoder,
        ready: true,
        reused_video,
    })
}

fn spawn_full_staging_job(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    request: &SpeculativeStartRequest,
    resource_dir: Option<&Path>,
    staging_dir: PathBuf,
    staging_id: String,
    fp: String,
    body_fp: String,
    photos_fp: String,
    wm_fp: String,
    wm_video_fp: String,
    wm_photos_fp: String,
    // When set, skip photo copy and reuse existing rename map / count (body rebuild).
    reuse_photos: Option<(usize, std::collections::HashMap<String, String>)>,
    // When set, skip WM-video encode and keep existing Preview clip (body rebuild).
    reuse_wm_video: Option<PathBuf>,
) -> Result<SpeculativeStatus, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let reuse_photos_flag = reuse_photos.is_some();
    let reuse_wm_flag = reuse_wm_video.is_some();
    let slot = Arc::new(Slot {
        inner: Mutex::new(SlotInner {
            phase: SpeculativePhase::Running,
            fingerprint: fp.clone(),
            body_fp: body_fp.clone(),
            photos_fp: photos_fp.clone(),
            wm_fp: wm_fp.clone(),
            wm_video_fp: wm_video_fp.clone(),
            wm_photos_fp: wm_photos_fp.clone(),
            staging_id: staging_id.clone(),
            staging_dir: staging_dir.clone(),
            percent: 0.0,
            status: "Vorbereitung…".into(),
            video_ready: false,
            photos_ready: reuse_photos_flag,
            wm_ready: false,
            attached: false,
            cancel: Arc::clone(&cancel),
            artifacts: None,
            fail_reason: None,
            pending: None,
            video_paths: video_paths.to_vec(),
            photo_paths: photo_paths.to_vec(),
            media_revision_tag: request.media_revision_tag.clone(),
        }),
        cv: Condvar::new(),
    });

    {
        let mut guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(Arc::clone(&slot));
    }

    log_event(
        "speculative_start",
        format!(
            "id={staging_id} videos={} photos={} fp={} reuse_photos={reuse_photos_flag} reuse_wm_video={reuse_wm_flag}",
            video_paths.len(),
            photo_paths.len(),
            &fp[..8.min(fp.len())]
        ),
    );

    let ffmpeg = ffmpeg.to_path_buf();
    let kunde = kunde.clone();
    let video_paths = video_paths.to_vec();
    let photo_paths = photo_paths.to_vec();
    let request = request.clone();
    let resource_dir = resource_dir.map(|p| p.to_path_buf());
    let slot_worker = Arc::clone(&slot);
    let body_fp_w = body_fp;
    let photos_fp_w = photos_fp;
    let wm_fp_w = wm_fp;
    let wm_video_fp_w = wm_video_fp;
    let wm_photos_fp_w = wm_photos_fp;
    let fp_w = fp;

    std::thread::Builder::new()
        .name("speculative-create".into())
        .spawn(move || {
            let outcome = run_staging_job(
                &ffmpeg,
                &kunde,
                &video_paths,
                &photo_paths,
                &request,
                resource_dir.as_deref(),
                &slot_worker,
                &fp_w,
                &body_fp_w,
                &photos_fp_w,
                &wm_fp_w,
                &wm_video_fp_w,
                &wm_photos_fp_w,
                reuse_photos,
                reuse_wm_video,
            );
            match outcome {
                Ok(artifacts) => {
                    let mut inner = slot_worker.inner.lock().unwrap_or_else(|e| e.into_inner());
                    if inner.cancel.load(Ordering::SeqCst) {
                        drop(inner);
                        remove_staging_dir(&artifacts.staging_dir);
                        clear_slot_if_same(&slot_worker);
                        return;
                    }
                    inner.phase = SpeculativePhase::Ready;
                    inner.percent = 100.0;
                    inner.status = "Bereit".into();
                    inner.video_ready = artifacts.video_rel.is_some()
                        || !needs_video_product(&kunde)
                        || video_paths.is_empty();
                    inner.photos_ready = artifacts.photos_copied > 0
                        || photo_paths.is_empty()
                        || !needs_foto_product(&kunde);
                    inner.wm_ready = artifacts.wm_ready;
                    inner.body_fp = artifacts.body_fp.clone();
                    inner.photos_fp = artifacts.photos_fp.clone();
                    inner.wm_fp = artifacts.wm_fp.clone();
                    inner.wm_video_fp = artifacts.wm_video_fp.clone();
                    inner.wm_photos_fp = artifacts.wm_photos_fp.clone();
                    inner.fingerprint = artifacts.fingerprint.clone();
                    inner.artifacts = Some(artifacts);
                    slot_worker.cv.notify_all();
                    drop(inner);
                    try_drain_pending(&ffmpeg, &slot_worker);
                }
                Err(e) => {
                    let reason = e.to_string();
                    log_event("speculative_miss_gate", &reason);
                    let dir = {
                        let mut inner =
                            slot_worker.inner.lock().unwrap_or_else(|e| e.into_inner());
                        inner.phase = SpeculativePhase::Failed;
                        inner.fail_reason = Some(reason);
                        inner.staging_dir.clone()
                    };
                    slot_worker.cv.notify_all();
                    remove_staging_dir(&dir);
                    clear_slot_if_same(&slot_worker);
                }
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(status())
}

fn status_from_inner(inner: &SlotInner) -> SpeculativeStatus {
    SpeculativeStatus {
        phase: inner.phase,
        fingerprint: Some(inner.fingerprint.clone()),
        staging_id: Some(inner.staging_id.clone()),
        percent: inner.percent,
        status: inner.status.clone(),
        video_ready: inner.video_ready,
        photos_ready: inner.photos_ready,
        wm_ready: inner.wm_ready,
        attached: inner.attached,
    }
}

fn clear_slot_if_same(slot: &Arc<Slot>) {
    let mut guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_ref().is_some_and(|s| Arc::ptr_eq(s, slot)) {
        *guard = None;
    }
}

fn update_progress(slot: &Slot, percent: f64, status: &str) {
    let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.percent = percent.clamp(0.0, 100.0);
    if !status.is_empty() && status != "continue" && status != "end" {
        inner.status = status.to_string();
    }
}

/// Slot progress + mirror to create attach channel when Erstellen is waiting.
fn push_progress(slot: &Slot, p: EncodeProgress) {
    update_progress(slot, p.percent, &p.status);
    let attached = {
        let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.attached
    };
    if attached {
        if let Ok(mut sink) = ATTACH_PROGRESS.lock() {
            *sink = Some(p);
        }
    }
}

fn staging_cancelled(slot: &Slot) -> bool {
    let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.cancel.load(Ordering::SeqCst) || is_cancelled()
}

fn run_staging_job(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    request: &SpeculativeStartRequest,
    resource_dir: Option<&Path>,
    slot: &Arc<Slot>,
    fingerprint: &str,
    body_fp: &str,
    photos_fp: &str,
    wm_fp: &str,
    wm_video_fp: &str,
    wm_photos_fp: &str,
    reuse_photos: Option<(usize, std::collections::HashMap<String, String>)>,
    reuse_wm_video: Option<PathBuf>,
) -> Result<StagingArtifacts, ProcessorError> {
    let (staging_dir, staging_id) = {
        let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        (inner.staging_dir.clone(), inner.staging_id.clone())
    };

    let layout = OutputLayout {
        base_dir: staging_dir.clone(),
        base_filename: "body".into(),
    };

    let on_progress: ProgressCallback = {
        let slot = Arc::clone(slot);
        Arc::new(move |p: EncodeProgress| {
            push_progress(&slot, p);
        })
    };

    let on_reencode: ReencodeAskFn = Arc::new(|_intent| Ok(ReencodeDecision::Abort));
    let on_body_fallback: BodyConcatAskFn =
        Arc::new(|_reason| Ok(BodyConcatChoice::Abort));
    let on_intro: IntroMuxAskFn = Arc::new(|_reason| Ok(IntroMuxChoice::WithoutIntro));

    let mut video_rel: Option<PathBuf> = None;
    let mut encoder = String::new();
    let mut intro_created = false;
    let mut body_clips = 0usize;

    let do_video = needs_video_product(kunde) && !video_paths.is_empty();
    if do_video {
        if staging_cancelled(slot) {
            return Err(ProcessorError::Ffmpeg(crate::video::ffmpeg::FfmpegError::Cancelled));
        }
        let out_path = video_output_path(&layout, kunde).map_err(ProcessorError::Message)?;
        let out_path = out_path.with_file_name(STAGING_BODY_FILENAME);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let out_str = out_path.to_string_lossy().to_string();
        update_progress(slot, 0.0, "Erstelle Video…");

        let mut video_opts = request.video.clone();
        video_opts.intro_enabled = false;
        video_opts.body_concat_mode = "compatible".into();

        let res: CreateVideoResult = create_video(
            ffmpeg,
            kunde,
            video_paths,
            &out_str,
            &video_opts,
            resource_dir,
            Arc::clone(&on_progress),
            Some(on_intro),
            Some(on_body_fallback),
            Some(on_reencode),
        )?;
        encoder = res.encoder;
        intro_created = res.intro_created;
        body_clips = res.body_clips;
        let rel = out_path
            .strip_prefix(&staging_dir)
            .unwrap_or(&out_path)
            .to_path_buf();
        video_rel = Some(rel);
        {
            let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.video_ready = true;
        }
        update_progress(slot, 70.0, "Video fertig");
    }

    if staging_cancelled(slot) {
        return Err(ProcessorError::Ffmpeg(crate::video::ffmpeg::FfmpegError::Cancelled));
    }

    let (photos_copied, rename_map) = if let Some((n, map)) = reuse_photos {
        update_progress(slot, 75.0, "Fotos übernommen");
        (n, map)
    } else {
        let rename_map = export_job::build_photo_rename_map(photo_paths);
        update_progress(slot, 75.0, "Kopiere Fotos…");
        let photos_copied =
            export_job::copy_photos(photo_paths, &layout, kunde, &rename_map, &on_progress)?;
        (photos_copied, rename_map)
    };
    {
        let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.photos_ready = true;
    }

    if staging_cancelled(slot) {
        return Err(ProcessorError::Ffmpeg(crate::video::ffmpeg::FfmpegError::Cancelled));
    }

    if reuse_wm_video.is_none() {
        clear_wm_dirs(&staging_dir);
    } else {
        // Keep Preview video on disk; refresh photo WMs only if needed below.
        clear_wm_photo_dir(&staging_dir);
    }
    let wm = stage_watermarks(
        ffmpeg,
        kunde,
        video_paths,
        photo_paths,
        request,
        resource_dir,
        &layout,
        &rename_map,
        &on_progress,
        reuse_wm_video,
    )?;
    if !wm.encoder.is_empty() && encoder.is_empty() {
        encoder = wm.encoder.clone();
    }
    if wm.reused_video {
        log_event("speculative_hit", "body_rebuild_reused_wm_video");
    }
    {
        let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.wm_ready = wm.ready;
    }
    update_progress(slot, 100.0, "Bereit");

    Ok(StagingArtifacts {
        staging_dir,
        fingerprint: fingerprint.to_string(),
        body_fp: body_fp.to_string(),
        photos_fp: photos_fp.to_string(),
        wm_fp: wm_fp.to_string(),
        wm_video_fp: wm_video_fp.to_string(),
        wm_photos_fp: wm_photos_fp.to_string(),
        staging_id,
        video_rel,
        encoder,
        intro_created,
        body_clips,
        photos_copied,
        rename_map,
        wm_video_rel: wm.video_rel,
        wm_photos: wm.photos,
        wm_ready: wm.ready,
    })
}

static ATTACH_PROGRESS: Lazy<Mutex<Option<EncodeProgress>>> =
    Lazy::new(|| Mutex::new(None));

/// Body+photos match, or pending will supply the desired photos after body finishes.
fn slot_matches_core(inner: &SlotInner, body_fp: &str, photos_fp: &str) -> bool {
    if inner.body_fp != body_fp {
        return false;
    }
    if inner.photos_fp == photos_fp {
        return true;
    }
    inner
        .pending
        .as_ref()
        .is_some_and(|p| p.body_fp == body_fp && p.photos_fp == photos_fp)
}

fn pending_needs_photos(inner: &SlotInner, photos_fp: &str) -> bool {
    inner
        .pending
        .as_ref()
        .is_some_and(|p| p.photos_fp == photos_fp && inner.photos_fp != photos_fp)
}

/// Wait for a matching running/ready slot (body + photos).
///
/// Once Ready and photos match, artifacts are handed off even if a WM-only pending
/// remains — commit regenerates WM if needed.
///
/// While Running after attach: do **not** cancel an in-flight WM encode. Body/Fotos
/// steps are announced as soon as those halves exist; live FFmpeg % for WM is
/// forwarded until Ready, then commit reuses the finished Preview video.
pub(crate) fn wait_for_matching(
    ffmpeg: &Path,
    body_fp: &str,
    photos_fp: &str,
    on_progress: &ProgressCallback,
) -> Result<Option<StagingArtifacts>, ProcessorError> {
    let slot = {
        let guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone()
    };
    let Some(slot) = slot else {
        return Ok(None);
    };

    {
        let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !slot_matches_core(&inner, body_fp, photos_fp) {
            return Ok(None);
        }
        // Mark attached for any wait path so incremental workers forward progress.
        inner.attached = true;
        log_event("speculative_attach", &inner.staging_id);

        match inner.phase {
            SpeculativePhase::Ready => {
                // Photos already match → commit now (don't wait on WM-only pending).
                if inner.photos_fp == photos_fp {
                    // Drop WM-only pending; commit will create WM if needed.
                    if inner.pending.is_some() {
                        log_event("speculative_drain", "skip_wm_pending_on_attach");
                        inner.pending = None;
                    }
                    log_event("speculative_hit", &inner.staging_id);
                    return Ok(inner.artifacts.take());
                }
                // Photos still coming via pending → drain then wait.
                if pending_needs_photos(&inner, photos_fp) {
                    drop(inner);
                    try_drain_pending(ffmpeg, &slot);
                } else {
                    // Matched only via stale pending that is gone/inconsistent → miss.
                    log_event("speculative_miss_gate", "ready_photos_mismatch");
                    return Ok(None);
                }
            }
            SpeculativePhase::Running => {
                // Wait loop below.
            }
            SpeculativePhase::Idle | SpeculativePhase::Failed => return Ok(None),
        }
    }

    // Poll until Ready (body+photos; WM encode may still be finishing — do not cancel it).
    // While attached, advance create pipeline for finished halves and forward live WM %.
    let deadline = Instant::now() + Duration::from_secs(60 * 60);
    let mut empty_spin: u32 = 0;
    let mut announced_body_photos = false;
    let mut announced_waiting_wm = false;
    loop {
        if Instant::now() > deadline {
            return Err(ProcessorError::Message(
                "Speculative staging timeout".into(),
            ));
        }
        if is_cancelled() {
            cancel_and_cleanup("attach_cancel");
            return Err(ProcessorError::Ffmpeg(
                crate::video::ffmpeg::FfmpegError::Cancelled,
            ));
        }

        if let Ok(mut sink) = ATTACH_PROGRESS.lock() {
            if let Some(p) = sink.take() {
                on_progress(p);
            }
        }

        {
            let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !slot_matches_core(&inner, body_fp, photos_fp) {
                return Ok(None);
            }
            match inner.phase {
                SpeculativePhase::Ready => {
                    let status = inner.status.clone();
                    let pct = inner.percent;
                    let photos_ready_match = inner.photos_fp == photos_fp;
                    let need_photo_drain = pending_needs_photos(&inner, photos_fp);
                    drop(inner);
                    on_progress(EncodeProgress {
                        percent: pct,
                        current_secs: pct,
                        total_secs: 100.0,
                        status,
                        task_id: None,
                    });
                    if photos_ready_match {
                        let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
                        if inner.phase != SpeculativePhase::Ready || inner.photos_fp != photos_fp {
                            empty_spin = 0;
                            continue;
                        }
                        if inner.pending.is_some() {
                            log_event("speculative_drain", "skip_wm_pending_on_attach");
                            inner.pending = None;
                        }
                        log_event("speculative_hit", &inner.staging_id);
                        return Ok(inner.artifacts.take());
                    }
                    if need_photo_drain {
                        empty_spin = 0;
                        try_drain_pending(ffmpeg, &slot);
                        continue;
                    }
                    // Ready but photos don't match and no useful pending → miss.
                    empty_spin += 1;
                    if empty_spin >= 5 {
                        log_event(
                            "speculative_miss_gate",
                            "attach_ready_without_photos_pending",
                        );
                        return Ok(None);
                    }
                }
                SpeculativePhase::Failed => {
                    let reason = inner
                        .fail_reason
                        .clone()
                        .unwrap_or_else(|| "staging failed".into());
                    drop(inner);
                    clear_slot_if_same(&slot);
                    log_event("speculative_miss_gate", &reason);
                    return Ok(None);
                }
                SpeculativePhase::Running => {
                    empty_spin = 0;
                    let video_ready = inner.video_ready;
                    let photos_ready = inner.photos_ready;
                    let photos_match = inner.photos_fp == photos_fp;
                    let pct = inner.percent;
                    let status = inner.status.clone();
                    let staging_id = inner.staging_id.clone();
                    drop(inner);

                    // Body+photos already on disk — mark create steps done while WM FFmpeg continues.
                    if video_ready && photos_ready && photos_match && !announced_body_photos {
                        announced_body_photos = true;
                        on_progress(EncodeProgress {
                            percent: 100.0,
                            current_secs: 100.0,
                            total_secs: 100.0,
                            status: "Video fertig".into(),
                            task_id: None,
                        });
                        on_progress(EncodeProgress {
                            percent: 100.0,
                            current_secs: 100.0,
                            total_secs: 100.0,
                            status: "Fotos kopiert".into(),
                            task_id: None,
                        });
                        if !announced_waiting_wm {
                            announced_waiting_wm = true;
                            log_event(
                                "speculative_attach",
                                format!("waiting_wm_encode id={staging_id}"),
                            );
                        }
                    }

                    on_progress(EncodeProgress {
                        percent: pct,
                        current_secs: pct,
                        total_secs: 100.0,
                        status,
                        task_id: None,
                    });
                }
                SpeculativePhase::Idle => return Ok(None),
            }
        }

        let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (_guard, _) = slot
            .cv
            .wait_timeout(inner, Duration::from_millis(200))
            .unwrap_or_else(|e| e.into_inner());
    }
}

fn promote_tree(src_root: &Path, dest_root: &Path) -> Result<usize, String> {
    if !src_root.is_dir() {
        return Ok(0);
    }
    let mut moved = 0usize;
    for entry in fs::read_dir(src_root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let name = entry.file_name();
        let dest = dest_root.join(&name);
        if src.is_dir() {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            moved += promote_tree(&src, &dest)?;
            let _ = fs::remove_dir(&src);
        } else if src.is_file() {
            promote_file(&src, &dest)?;
            moved += 1;
        }
    }
    Ok(moved)
}

fn promote_file(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    match fs::hard_link(src, dest) {
        Ok(()) => {
            let _ = fs::remove_file(src);
            Ok(())
        }
        Err(_) => {
            fs::copy(src, dest).map_err(|e| format!("promote copy failed: {e}"))?;
            let _ = fs::remove_file(src);
            Ok(())
        }
    }
}

/// Commit staging into the final job folder (WM extras + marker/manifest).
pub(crate) fn commit_from_staging(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    config: &AppConfig,
    options: &CreateJobOptions,
    resource_dir: Option<&Path>,
    artifacts: StagingArtifacts,
    on_progress: ProgressCallback,
) -> Result<CreateJobResult, ProcessorError> {
    let speicherort = config.speicherort.trim();
    if speicherort.is_empty() {
        return Err(ProcessorError::Message(
            "Speicherort ist nicht gesetzt. Bitte Ordner wählen.".into(),
        ));
    }

    let outside_mode = kunde.is_outside_video() || kunde.video_mode == "outside";
    let gast = kunde.resolve_gast();

    on_progress(EncodeProgress {
        percent: 2.0,
        current_secs: 2.0,
        total_secs: 100.0,
        status: "Generiere Ausgabe-Verzeichnis…".into(),
        task_id: None,
    });

    if options.replace_existing_dir {
        let planned = crate::video::folder_conflict::planned_output_dir(
            Path::new(speicherort),
            &gast,
            kunde.tandemmaster.trim(),
            kunde.videospringer.trim(),
            kunde.datum.trim(),
            outside_mode,
            kunde.ort.trim(),
        );
        if planned.exists() {
            crate::video::folder_conflict::clear_job_output_dir(&planned)
                .map_err(ProcessorError::Message)?;
        }
    }

    let layout = create_base_output_dir(
        Path::new(speicherort),
        &gast,
        kunde.tandemmaster.trim(),
        kunde.videospringer.trim(),
        kunde.datum.trim(),
        outside_mode,
        kunde.ort.trim(),
    )
    .map_err(ProcessorError::Message)?;

    let mut video_out: Option<String> = None;
    let mut encoder = artifacts.encoder.clone();
    let intro_created = artifacts.intro_created;
    let body_clips = artifacts.body_clips;
    let photos_copied = artifacts.photos_copied;

    // Promote product subtrees from staging → final (except we rewrite video name).
    on_progress(EncodeProgress {
        percent: 10.0,
        current_secs: 10.0,
        total_secs: 100.0,
        status: "Übernehme vorbereitete Medien…".into(),
        task_id: None,
    });

    if let Some(rel) = &artifacts.video_rel {
        let src = artifacts.staging_dir.join(rel);
        let dest = video_output_path(&layout, kunde).map_err(ProcessorError::Message)?;
        promote_file(&src, &dest).map_err(ProcessorError::Message)?;
        video_out = Some(dest.to_string_lossy().to_string());
        logging::info(
            "create",
            format!(
                "Speculative body übernommen: {}",
                file_name(&video_out.as_deref().unwrap_or(""))
            ),
        );
    }

    // Promote photo product dirs.
    for sub in [SUBDIR_HANDCAM_FOTO, SUBDIR_OUTSIDE_FOTO] {
        let src = artifacts.staging_dir.join(sub);
        if src.is_dir() {
            let dest = layout.base_dir.join(sub);
            fs::create_dir_all(&dest).map_err(|e| ProcessorError::Message(e.to_string()))?;
            promote_tree(&src, &dest).map_err(ProcessorError::Message)?;
        }
    }

    // Also promote any other leftover product dirs (e.g. video subdir empties).
    let _ = video_subdir_name(kunde);

    // Match staging: fingerprint the resolved WM source clip so commit can promote
    // reused Preview video instead of re-encoding (FE index remap must not miss).
    let resolved_wm_clip = if video_unpaid(kunde) && !video_paths.is_empty() {
        export_job::pick_watermark_clip(ffmpeg, video_paths, options.watermark_clip_index)
    } else {
        None
    };
    let want_wm_video = build_wm_video_fingerprint(
        kunde,
        video_paths,
        options.watermark_clip_index,
        resource_dir,
        resolved_wm_clip.as_deref(),
    )
    .unwrap_or_default();
    let want_wm_photos = build_wm_photos_fingerprint(
        kunde,
        photo_paths,
        &options.watermark_photo_indices,
        resource_dir,
    )
    .unwrap_or_default();
    let reuse_wm_video = artifacts.wm_video_fp == want_wm_video
        && artifacts
            .wm_video_rel
            .as_ref()
            .is_some_and(|rel| artifacts.staging_dir.join(rel).is_file());
    let reuse_wm_photos = artifacts.wm_photos_fp == want_wm_photos && artifacts.wm_photos > 0;

    let mut wm_video: Option<String> = None;
    let do_wm_video = video_unpaid(kunde) && !video_paths.is_empty();
    if do_wm_video {
        if is_cancelled() {
            cleanup_after_failed_commit(&artifacts, &layout);
            return Err(ProcessorError::Ffmpeg(
                crate::video::ffmpeg::FfmpegError::Cancelled,
            ));
        }
        if reuse_wm_video {
            if let Some(rel) = &artifacts.wm_video_rel {
                let src = artifacts.staging_dir.join(rel);
                on_progress(EncodeProgress {
                    percent: 100.0,
                    current_secs: 100.0,
                    total_secs: 100.0,
                    status: "Wasserzeichen-Video übernommen".into(),
                    task_id: None,
                });
                let dest =
                    watermark_video_path(&layout).map_err(ProcessorError::Message)?;
                promote_file(&src, &dest).map_err(ProcessorError::Message)?;
                wm_video = Some(dest.to_string_lossy().to_string());
                log_event("speculative_hit", "commit_reused_wm_video");
            }
        }
        if wm_video.is_none() {
            on_progress(EncodeProgress {
                percent: 0.0,
                current_secs: 0.0,
                total_secs: 100.0,
                status: "Erstelle Wasserzeichen-Video…".into(),
                task_id: None,
            });
            if let Some(clip) = resolved_wm_clip.clone().or_else(|| {
                export_job::pick_watermark_clip(ffmpeg, video_paths, options.watermark_clip_index)
            }) {
                let wm_path = watermark_video_path(&layout).map_err(ProcessorError::Message)?;
                let wm_str = wm_path.to_string_lossy().to_string();
                let enc = create_video_with_watermark(
                    ffmpeg,
                    &clip,
                    &wm_str,
                    resource_dir,
                    Arc::clone(&on_progress),
                )?;
                if encoder.is_empty() {
                    encoder = enc;
                }
                wm_video = Some(wm_str);
            }
        }
    }

    let mut watermark_photos = 0usize;
    if foto_unpaid(kunde) && !options.watermark_photo_indices.is_empty() {
        if is_cancelled() {
            cleanup_after_failed_commit(&artifacts, &layout);
            return Err(ProcessorError::Ffmpeg(
                crate::video::ffmpeg::FfmpegError::Cancelled,
            ));
        }
        if reuse_wm_photos {
            let src = artifacts.staging_dir.join(SUBDIR_PREVIEW_FOTO);
            if src.is_dir() {
                on_progress(EncodeProgress {
                    percent: 100.0,
                    current_secs: 100.0,
                    total_secs: 100.0,
                    status: "Foto-Wasserzeichen übernommen".into(),
                    task_id: None,
                });
                let dest = watermark_photo_dir(&layout).map_err(ProcessorError::Message)?;
                watermark_photos =
                    promote_tree(&src, &dest).map_err(ProcessorError::Message)?;
            }
        }
        if watermark_photos == 0 {
            on_progress(EncodeProgress {
                percent: 0.0,
                current_secs: 0.0,
                total_secs: 100.0,
                status: "Erstelle Foto-Wasserzeichen…".into(),
                task_id: None,
            });
            let preview_dir = watermark_photo_dir(&layout).map_err(ProcessorError::Message)?;
            let stamp = resolve_stamp(resource_dir)?;
            let wm_total = options.watermark_photo_indices.len().max(1);
            for (wi, &i) in options.watermark_photo_indices.iter().enumerate() {
                if is_cancelled() {
                    cleanup_after_failed_commit(&artifacts, &layout);
                    return Err(ProcessorError::Ffmpeg(
                        crate::video::ffmpeg::FfmpegError::Cancelled,
                    ));
                }
                if i >= photo_paths.len() {
                    continue;
                }
                let src = Path::new(&photo_paths[i]);
                if !src.is_file() {
                    continue;
                }
                let out_name = artifacts
                    .rename_map
                    .get(&photo_paths[i])
                    .cloned()
                    .unwrap_or_else(|| {
                        src.file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_else(|| "photo.jpg".into())
                    });
                let out_stem = Path::new(&out_name)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "photo".into());
                let out_path = preview_dir.join(format!("{out_stem}.jpg"));
                on_progress(EncodeProgress {
                    percent: 100.0 * ((wi + 1) as f64 / wm_total as f64),
                    current_secs: 0.0,
                    total_secs: 100.0,
                    status: format!("Foto-Wasserzeichen ({}/{})", wi + 1, wm_total),
                    task_id: None,
                });
                create_photo_with_watermark(src, &out_path, &stamp)?;
                watermark_photos += 1;
            }
        }
    }

    let (marker_path, correlation_id) = if config.skip_marker_file(&kunde.form_mode) {
        on_progress(EncodeProgress {
            percent: 50.0,
            current_secs: 50.0,
            total_secs: 100.0,
            status: "Überspringe _fertig.txt (Lokal)…".into(),
            task_id: None,
        });
        (String::new(), String::new())
    } else {
        on_progress(EncodeProgress {
            percent: 40.0,
            current_secs: 40.0,
            total_secs: 100.0,
            status: "Schreibe AMS-Manifest…".into(),
            task_id: None,
        });
        let (correlation_id, _) =
            write_handoff_manifest(&layout, kunde, config).map_err(ProcessorError::Message)?;
        on_progress(EncodeProgress {
            percent: 80.0,
            current_secs: 80.0,
            total_secs: 100.0,
            status: "Schreibe _fertig.txt…".into(),
            task_id: None,
        });
        let marker = write_marker_file(&layout, kunde, config).map_err(ProcessorError::Message)?;
        (marker.to_string_lossy().to_string(), correlation_id)
    };

    on_progress(EncodeProgress {
        percent: 100.0,
        current_secs: 100.0,
        total_secs: 100.0,
        status: "Vorgang fertig".into(),
        task_id: None,
    });

    remove_staging_dir(&artifacts.staging_dir);
    // Clear slot
    {
        let mut guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }
    log_event("speculative_cleanup", "commit_success");

    Ok(CreateJobResult {
        base_output_dir: layout.base_dir.to_string_lossy().to_string(),
        base_filename: layout.base_filename,
        video_output: video_out,
        watermark_video: wm_video,
        photos_copied,
        watermark_photos,
        marker_path,
        encoder,
        intro_created,
        body_clips,
        reused_preview: false,
        correlation_id,
        vorgang_id: None,
    })
}

fn cleanup_after_failed_commit(artifacts: &StagingArtifacts, layout: &OutputLayout) {
    remove_staging_dir(&artifacts.staging_dir);
    let _ = fs::remove_dir_all(&layout.base_dir);
    let mut guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

/// Put artifacts back on the slot after a refused attach, or delete staging if the slot moved on.
fn restore_artifacts_or_cleanup(artifacts: StagingArtifacts) {
    let slot = {
        let guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone()
    };
    if let Some(slot) = slot {
        let mut inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.staging_id == artifacts.staging_id {
            inner.artifacts = Some(artifacts);
            inner.attached = false;
            inner.phase = SpeculativePhase::Ready;
            slot.cv.notify_all();
            return;
        }
    }
    remove_staging_dir(&artifacts.staging_dir);
}

fn path_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

fn media_paths_match(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .all(|(x, y)| path_key(x) == path_key(y))
}

/// When FFmpeg holds concat inputs open, Windows `metadata`/`exists` can fail with
/// sharing violation — reuse the running slot's fingerprints if paths + rev match.
fn slot_fingerprints_if_paths_match(
    video_paths: &[String],
    photo_paths: &[String],
    media_revision_tag: &str,
) -> Option<(String, String)> {
    let guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let slot = guard.as_ref()?;
    let inner = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
    if !matches!(
        inner.phase,
        SpeculativePhase::Running | SpeculativePhase::Ready
    ) {
        return None;
    }
    if inner.media_revision_tag != media_revision_tag {
        return None;
    }
    if !media_paths_match(&inner.video_paths, video_paths)
        || !media_paths_match(&inner.photo_paths, photo_paths)
    {
        return None;
    }
    Some((inner.body_fp.clone(), inner.photos_fp.clone()))
}

fn resolve_attach_fingerprints(
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    video_opts: &CreateVideoOptions,
    media_revision_tag: &str,
) -> Option<(String, String)> {
    let body = build_body_fingerprint(kunde, video_paths, video_opts, media_revision_tag);
    let photos = build_photos_fingerprint(kunde, photo_paths, media_revision_tag);
    match (body, photos) {
        (Ok(b), Ok(p)) => Some((b, p)),
        (Err(e), _) | (_, Err(e)) => {
            let reused = slot_fingerprints_if_paths_match(
                video_paths,
                photo_paths,
                media_revision_tag,
            );
            if reused.is_some() {
                log_event(
                    "speculative_attach",
                    format!("fingerprint_via_slot_paths ({e})"),
                );
            }
            reused
        }
    }
}

/// Try speculative hit/attach then commit; `Ok(None)` means caller should full-create.
pub fn try_promote_into_create_job(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    config: &AppConfig,
    options: &CreateJobOptions,
    resource_dir: Option<&Path>,
    media_revision_tag: &str,
    on_progress: ProgressCallback,
) -> Result<Option<CreateJobResult>, ProcessorError> {
    if options.video.intro_enabled {
        return Ok(None);
    }
    if normalize_body_concat_mode(&options.video.body_concat_mode) != "compatible" {
        return Ok(None);
    }

    let Some((body_fp, photos_fp)) = resolve_attach_fingerprints(
        kunde,
        video_paths,
        photo_paths,
        &options.video,
        media_revision_tag,
    ) else {
        return Ok(None);
    };

    let Some(artifacts) = wait_for_matching(ffmpeg, &body_fp, &photos_fp, &on_progress)? else {
        return Ok(None);
    };

    // Safety: never commit a photo-only staging hit when a body video is required.
    // (e.g. clips present but product was off during staging — fall back to full create.)
    if needs_video_product(kunde) && !video_paths.is_empty() && artifacts.video_rel.is_none() {
        log_event(
            "speculative_miss_gate",
            "attach_missing_body_video",
        );
        restore_artifacts_or_cleanup(artifacts);
        return Ok(None);
    }
    if needs_foto_product(kunde) && !photo_paths.is_empty() && artifacts.photos_copied == 0 {
        log_event(
            "speculative_miss_gate",
            "attach_missing_photos",
        );
        restore_artifacts_or_cleanup(artifacts);
        return Ok(None);
    }

    // Fast-forward body/photo stages for hit UX.
    on_progress(EncodeProgress {
        percent: 100.0,
        current_secs: 100.0,
        total_secs: 100.0,
        status: "Video fertig".into(),
        task_id: None,
    });
    if needs_foto_product(kunde) {
        on_progress(EncodeProgress {
            percent: 100.0,
            current_secs: 100.0,
            total_secs: 100.0,
            status: "Fotos kopiert".into(),
            task_id: None,
        });
    }
    if artifacts.wm_ready {
        on_progress(EncodeProgress {
            percent: 100.0,
            current_secs: 100.0,
            total_secs: 100.0,
            status: "Wasserzeichen fertig".into(),
            task_id: None,
        });
    }

    let result = commit_from_staging(
        ffmpeg,
        kunde,
        video_paths,
        photo_paths,
        config,
        options,
        resource_dir,
        artifacts,
        on_progress,
    )?;
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::{tempdir, NamedTempFile};

    fn write_temp(bytes: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().expect("temp");
        f.write_all(bytes).expect("write");
        f.flush().expect("flush");
        f
    }

    fn base_kunde() -> Kunde {
        let mut k = Kunde::default();
        k.handcam_video = true;
        k.handcam_foto = true;
        k
    }

    fn opts() -> CreateVideoOptions {
        CreateVideoOptions {
            intro_enabled: false,
            body_concat_mode: "compatible".into(),
            ..CreateVideoOptions::default()
        }
    }

    fn fp(
        k: &Kunde,
        videos: &[String],
        photos: &[String],
        o: &CreateVideoOptions,
        tag: &str,
    ) -> String {
        build_fingerprint(k, videos, photos, o, tag, None, &[], None).unwrap()
    }

    #[test]
    fn fingerprint_stable() {
        let v = write_temp(b"video-bytes");
        let p = write_temp(b"photo");
        let k = base_kunde();
        let o = opts();
        let a = fp(
            &k,
            &[v.path().to_string_lossy().into()],
            &[p.path().to_string_lossy().into()],
            &o,
            "rev1",
        );
        let b = fp(
            &k,
            &[v.path().to_string_lossy().into()],
            &[p.path().to_string_lossy().into()],
            &o,
            "rev1",
        );
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_changes_on_media_rev() {
        let v = write_temp(b"video-bytes");
        let path = v.path().to_string_lossy().to_string();
        let k = base_kunde();
        let o = opts();
        let a = fp(&k, &[path.clone()], &[], &o, &format!("v:{path}:1"));
        let b = fp(&k, &[path.clone()], &[], &o, &format!("v:{path}:2"));
        assert_ne!(a, b);
    }

    #[test]
    fn body_fp_stable_when_only_photos_change() {
        let v = write_temp(b"video-bytes");
        let p1 = write_temp(b"photo-a");
        let p2 = write_temp(b"photo-b");
        let k = base_kunde();
        let o = opts();
        let vp = v.path().to_string_lossy().to_string();
        let body_a = build_body_fingerprint(&k, &[vp.clone()], &o, "").unwrap();
        let body_b = build_body_fingerprint(&k, &[vp], &o, "").unwrap();
        assert_eq!(body_a, body_b);
        let photos_a = build_photos_fingerprint(
            &k,
            &[p1.path().to_string_lossy().into()],
            "",
        )
        .unwrap();
        let photos_b = build_photos_fingerprint(
            &k,
            &[p2.path().to_string_lossy().into()],
            "",
        )
        .unwrap();
        assert_ne!(photos_a, photos_b);
        let wm = "wm";
        assert_ne!(
            combine_fingerprints(&body_a, &photos_a, wm),
            combine_fingerprints(&body_b, &photos_b, wm)
        );
    }

    #[test]
    fn photos_fp_stable_when_only_body_rev_changes() {
        let v = write_temp(b"video-bytes");
        let p = write_temp(b"photo");
        let k = base_kunde();
        let o = opts();
        let vp = v.path().to_string_lossy().to_string();
        let pp = p.path().to_string_lossy().to_string();
        let photos = build_photos_fingerprint(&k, &[pp.clone()], &format!("p:{pp}:1")).unwrap();
        let body_a = build_body_fingerprint(&k, &[vp.clone()], &o, &format!("v:{vp}:1")).unwrap();
        let body_b = build_body_fingerprint(&k, &[vp.clone()], &o, &format!("v:{vp}:2")).unwrap();
        assert_ne!(body_a, body_b);
        let photos_b = build_photos_fingerprint(&k, &[pp.clone()], &format!("p:{pp}:1")).unwrap();
        assert_eq!(photos, photos_b);
    }

    #[test]
    fn wm_fp_changes_on_photo_selection_only() {
        let v = write_temp(b"video-bytes");
        let p1 = write_temp(b"photo-a");
        let p2 = write_temp(b"photo-b");
        let mut k = base_kunde();
        k.ist_bezahlt_handcam_foto = false;
        k.ist_bezahlt_handcam_video = true;
        let vp = v.path().to_string_lossy().to_string();
        let photos = vec![
            p1.path().to_string_lossy().into(),
            p2.path().to_string_lossy().into(),
        ];
        let a = build_wm_fingerprint(&k, &[vp.clone()], &photos, None, &[], None, None).unwrap();
        let b = build_wm_fingerprint(&k, &[vp], &photos, None, &[0], None, None).unwrap();
        assert_ne!(a, b);
        let body = build_body_fingerprint(&k, &[v.path().to_string_lossy().into()], &opts(), "").unwrap();
        let photos_fp = build_photos_fingerprint(&k, &photos, "").unwrap();
        // Body/photos stable while WM selection changes.
        assert_ne!(
            combine_fingerprints(&body, &photos_fp, &a),
            combine_fingerprints(&body, &photos_fp, &b)
        );
    }

    #[test]
    fn wm_video_fp_stable_when_only_photo_selection_changes() {
        let v = write_temp(b"video-bytes");
        let p1 = write_temp(b"photo-a");
        let p2 = write_temp(b"photo-b");
        let mut k = base_kunde();
        k.ist_bezahlt_handcam_foto = false;
        k.ist_bezahlt_handcam_video = false;
        let vp = v.path().to_string_lossy().to_string();
        let photos = vec![
            p1.path().to_string_lossy().into(),
            p2.path().to_string_lossy().into(),
        ];
        let video_a =
            build_wm_video_fingerprint(&k, &[vp.clone()], None, None, Some(&vp)).unwrap();
        let video_b =
            build_wm_video_fingerprint(&k, &[vp.clone()], None, None, Some(&vp)).unwrap();
        assert_eq!(video_a, video_b);
        let photos_a =
            build_wm_photos_fingerprint(&k, &photos, &[0], None).unwrap();
        let photos_b =
            build_wm_photos_fingerprint(&k, &photos, &[0, 1], None).unwrap();
        assert_ne!(photos_a, photos_b);
        assert_eq!(
            combine_wm_halves(&video_a, &photos_a),
            combine_wm_halves(
                &build_wm_video_fingerprint(&k, &[vp.clone()], None, None, Some(&vp)).unwrap(),
                &photos_a
            )
        );
        assert_ne!(
            combine_wm_halves(&video_a, &photos_a),
            combine_wm_halves(&video_b, &photos_b)
        );
    }

    #[test]
    fn wm_video_fp_stable_when_unrelated_clip_removed() {
        let v_wm = write_temp(b"wm-source-clip");
        let v_other = write_temp(b"other-clip-bytes");
        let mut k = base_kunde();
        k.ist_bezahlt_handcam_video = false;
        let wm = v_wm.path().to_string_lossy().to_string();
        let other = v_other.path().to_string_lossy().to_string();
        // Same resolved file; FE remaps index after deleting an earlier clip (1 → 0).
        let with_both =
            build_wm_video_fingerprint(&k, &[other, wm.clone()], Some(1), None, Some(&wm))
                .unwrap();
        let wm_only =
            build_wm_video_fingerprint(&k, &[wm.clone()], Some(0), None, Some(&wm)).unwrap();
        assert_eq!(with_both, wm_only);
    }

    #[test]
    fn wm_video_fp_changes_when_resolved_clip_changes() {
        let v_a = write_temp(b"clip-a-bytes");
        let v_b = write_temp(b"clip-b-bytes");
        let mut k = base_kunde();
        k.ist_bezahlt_handcam_video = false;
        let a = v_a.path().to_string_lossy().to_string();
        let b = v_b.path().to_string_lossy().to_string();
        let fp_a =
            build_wm_video_fingerprint(&k, &[a.clone(), b.clone()], Some(0), None, Some(&a))
                .unwrap();
        let fp_b =
            build_wm_video_fingerprint(&k, &[a, b.clone()], Some(1), None, Some(&b)).unwrap();
        assert_ne!(fp_a, fp_b);
    }

    #[test]
    fn fingerprint_changes_on_product_flag() {
        let v = write_temp(b"video-bytes");
        let k1 = base_kunde();
        let mut k2 = base_kunde();
        k2.outside_video = true;
        let o = opts();
        let a = fp(&k1, &[v.path().to_string_lossy().into()], &[], &o, "");
        let b = fp(&k2, &[v.path().to_string_lossy().into()], &[], &o, "");
        assert_ne!(a, b);
    }

    #[test]
    fn preconditions_reject_intro() {
        let mut o = opts();
        o.intro_enabled = true;
        assert!(preconditions_ok(&o).is_err());
    }

    #[test]
    fn preconditions_reject_fast() {
        let mut o = opts();
        o.body_concat_mode = "fast".into();
        assert!(preconditions_ok(&o).is_err());
    }

    #[test]
    fn disk_preflight_accepts_small() {
        let dir = tempdir().unwrap();
        assert!(disk_preflight_ok(dir.path(), 1024));
    }

    #[test]
    fn cleanup_removes_staging_dir() {
        let dir = tempdir().unwrap();
        let staging = dir.path().join(format!("{STAGING_DIR_PREFIX}test"));
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("x.txt"), b"x").unwrap();
        remove_staging_dir(&staging);
        assert!(!staging.exists());
    }

    #[test]
    fn estimate_counts_files() {
        let v = write_temp(b"12345");
        let p = write_temp(b"ab");
        let n = estimate_staging_bytes(
            &[v.path().to_string_lossy().into()],
            &[p.path().to_string_lossy().into()],
        );
        assert!(n >= 5 + 2 + 5); // video counted twice + photo
    }

    #[test]
    fn skip_wm_until_photos_when_foto_product_empty() {
        let k = base_kunde();
        assert!(skip_wm_until_photos(&k, &[]));
        assert!(!skip_wm_until_photos(&k, &["a.jpg".into()]));
        let mut video_only = Kunde::default();
        video_only.handcam_video = true;
        assert!(!skip_wm_until_photos(&video_only, &[]));
    }

    #[test]
    fn wm_can_stage_video_without_photo_selection() {
        let mut k = base_kunde();
        k.ist_bezahlt_handcam_video = false;
        k.ist_bezahlt_handcam_foto = false;
        assert!(wm_can_stage(
            &k,
            &["v.mp4".into()],
            &["p.jpg".into()],
            &[]
        ));
        let mut foto_only = base_kunde();
        foto_only.handcam_video = false;
        foto_only.ist_bezahlt_handcam_foto = false;
        assert!(!wm_can_stage(&foto_only, &[], &["p.jpg".into()], &[]));
        assert!(wm_can_stage(&foto_only, &[], &["p.jpg".into()], &[0]));
    }

    #[test]
    fn media_paths_match_ignores_slash_case() {
        assert!(media_paths_match(
            &["C:\\A\\b.MP4".into()],
            &["c:/a/b.mp4".into()]
        ));
        assert!(!media_paths_match(&["a.mp4".into()], &["b.mp4".into()]));
    }

    #[test]
    fn slot_matches_core_accepts_pending_photos() {
        let inner = SlotInner {
            phase: SpeculativePhase::Running,
            fingerprint: "a".into(),
            body_fp: "body1".into(),
            photos_fp: "photos0".into(),
            wm_fp: "wm0".into(),
            wm_video_fp: "wmv0".into(),
            wm_photos_fp: "wmp0".into(),
            staging_id: "id".into(),
            staging_dir: PathBuf::from("/tmp"),
            percent: 10.0,
            status: String::new(),
            video_ready: false,
            photos_ready: false,
            wm_ready: false,
            attached: false,
            cancel: Arc::new(AtomicBool::new(false)),
            artifacts: None,
            fail_reason: None,
            video_paths: vec![],
            photo_paths: vec![],
            media_revision_tag: String::new(),
            pending: Some(PendingStaging {
                fingerprint: "b".into(),
                body_fp: "body1".into(),
                photos_fp: "photos1".into(),
                wm_fp: "wm1".into(),
                wm_video_fp: "wmv1".into(),
                wm_photos_fp: "wmp1".into(),
                video_paths: vec![],
                photo_paths: vec![],
                request: SpeculativeStartRequest::default(),
                resource_dir: None,
                kunde: base_kunde(),
            }),
        };
        assert!(slot_matches_core(&inner, "body1", "photos1"));
        assert!(slot_matches_core(&inner, "body1", "photos0"));
        assert!(!slot_matches_core(&inner, "body2", "photos1"));
    }

    #[test]
    fn promote_file_moves_or_copies() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("a.bin");
        let dest = dir.path().join("sub").join("b.bin");
        fs::write(&src, b"hello").unwrap();
        promote_file(&src, &dest).unwrap();
        assert!(dest.is_file());
        assert_eq!(fs::read(&dest).unwrap(), b"hello");
    }
}
