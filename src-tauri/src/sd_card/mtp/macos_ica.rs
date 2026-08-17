//! macOS Image Capture (Phase 23.2b).
//!
//! List = catalog only (held PTP session). Backup downloads selected files
//! into the SD backup folder. Clear uses the same session.

#![cfg(target_os = "macos")]

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::media::dji_paths::is_listable_media_path;
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum IcaError {
    Message(String),
}

impl std::fmt::Display for IcaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(m) => write!(f, "{m}"),
        }
    }
}

#[link(name = "ats_image_capture", kind = "static")]
unsafe extern "C" {
    fn ats_ica_list_catalog(
        dest_dir_utf8: *const c_char,
        name_hint_utf8: *const c_char,
        tick: Option<unsafe extern "C" fn(ctx: *mut c_void)>,
        tick_ctx: *mut c_void,
        err_buf: *mut c_char,
        err_len: usize,
    ) -> i32;

    fn ats_ica_download_named(
        dest_dir_utf8: *const c_char,
        name_hint_utf8: *const c_char,
        names_utf8: *const c_char,
        progress: Option<
            unsafe extern "C" fn(
                file_index: u32,
                file_total: u32,
                filename_utf8: *const c_char,
                bytes_done: u64,
                bytes_total: u64,
                ctx: *mut c_void,
            ),
        >,
        progress_ctx: *mut c_void,
        err_buf: *mut c_char,
        err_len: usize,
    ) -> i32;

    fn ats_ica_delete_named(
        name_hint_utf8: *const c_char,
        names_utf8: *const c_char,
        out_deleted: *mut i32,
        err_buf: *mut c_char,
        err_len: usize,
    ) -> i32;

    fn ats_ica_release_held();

    fn ats_ica_has_held() -> i32;

    fn ats_ica_thumbnail_named(
        name_utf8: *const c_char,
        dest_jpeg_utf8: *const c_char,
        max_edge: u32,
        err_buf: *mut c_char,
        err_len: usize,
    ) -> i32;
}

const CATALOG_NAME: &str = ".ats_ica_catalog.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraCatalogFile {
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mtime: f64,
}

/// Virtual path used as the SD-selector key (file may not exist until backup).
pub fn virtual_media_path(source_id: &str, filename: &str) -> PathBuf {
    ica_cache_dir_for(source_id).join(filename)
}

#[derive(Debug, Serialize, Deserialize)]
struct StageMeta {
    source_id: String,
    staged_at_unix: u64,
    file_count: usize,
}

const STAGE_META_NAME: &str = ".ats_ica_stage.json";
const STAGE_TTL: Duration = Duration::from_secs(30 * 60);

pub fn ica_cache_dir_for(source_id: &str) -> PathBuf {
    let base = std::env::temp_dir().join("aero_tandem_ica");
    let safe: String = source_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    base.join(safe)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_existing_stage(dest_dir: &Path, source_id: &str) -> Option<Vec<PathBuf>> {
    let meta_path = dest_dir.join(STAGE_META_NAME);
    let raw = std::fs::read_to_string(&meta_path).ok()?;
    let meta: StageMeta = serde_json::from_str(&raw).ok()?;
    if meta.source_id != source_id {
        return None;
    }
    let age = now_unix().saturating_sub(meta.staged_at_unix);
    if age > STAGE_TTL.as_secs() {
        return None;
    }
    let paths = collect_media_files(dest_dir);
    // Older stages may still contain `.lrv` proxies; accept if any listable media remains.
    if paths.is_empty() {
        return None;
    }
    if paths.len() > meta.file_count && meta.file_count > 0 {
        // Unexpected growth — force re-stage.
        return None;
    }
    Some(paths)
}

fn write_stage_meta(dest_dir: &Path, source_id: &str, file_count: usize) {
    let meta = StageMeta {
        source_id: source_id.to_string(),
        staged_at_unix: now_unix(),
        file_count,
    };
    if let Ok(raw) = serde_json::to_string_pretty(&meta) {
        let _ = std::fs::write(dest_dir.join(STAGE_META_NAME), raw);
    }
}

fn clear_stage_dir(dest_dir: &Path) {
    if !dest_dir.is_dir() {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(dest_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_file() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

/// Drop staging cache so a later list/backup cannot resurrect deleted camera files.
pub fn invalidate_stage_cache(source_id: &str) {
    let dest = ica_cache_dir_for(source_id);
    clear_stage_dir(&dest);
    let _ = std::fs::remove_file(dest.join(STAGE_META_NAME));
    unsafe {
        ats_ica_release_held();
    }
}

fn ica_session_held() -> bool {
    unsafe { ats_ica_has_held() != 0 }
}

fn collect_media_files(dest_dir: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(rd) = std::fs::read_dir(dest_dir) else {
        return paths;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.file_name().and_then(|n| n.to_str()) == Some(STAGE_META_NAME)
            || p.file_name().and_then(|n| n.to_str()) == Some(CATALOG_NAME)
        {
            continue;
        }
        if !is_listable_media_path(&p) {
            continue;
        }
        paths.push(p);
    }
    paths.sort();
    paths
}

fn hint_cstring(label: &str, source_id: &str) -> CString {
    let hint_raw = format!("{label}|{source_id}");
    CString::new(hint_raw.as_bytes()).unwrap_or_else(|_| CString::new("gopro").unwrap())
}

fn read_err_buf(err: &[i8]) -> String {
    unsafe { CStr::from_ptr(err.as_ptr() as *const c_char) }
        .to_string_lossy()
        .trim()
        .to_string()
}

fn map_ica_failure(source_id: &str, label: &str, msg: String) -> IcaError {
    if let Some(block) = crate::sd_card::mtp::usb_enumerate::media_access_block_for(source_id) {
        return IcaError::Message(block.user_message(label));
    }
    let msg = if msg.is_empty() {
        format!(
            "USB-Import über Bildübernahme fehlgeschlagen ({label}). \
             Bitte Kamera wecken, USB-Modus „MTP“ wählen oder MicroSD im Kartenleser nutzen."
        )
    } else if msg.contains("Gefunden: (keine)") {
        format!(
            "{msg} USB-Modus ist in Ordnung (MTP/PTP). „Bildübernahme“ und „Fotos“ beenden, \
             Kamera wecken, ggf. App neu starten — oder MicroSD im Kartenleser nutzen."
        )
    } else {
        msg
    };
    IcaError::Message(msg)
}

pub(crate) fn parse_catalog_json(raw: &str) -> Result<Vec<CameraCatalogFile>, IcaError> {
    let rows: Vec<CameraCatalogFile> =
        serde_json::from_str(raw).map_err(|e| IcaError::Message(e.to_string()))?;
    Ok(rows
        .into_iter()
        .filter(|e| !e.name.is_empty() && is_listable_media_path(Path::new(&e.name)))
        .collect())
}

fn read_catalog_file(dest_dir: &Path) -> Result<Vec<CameraCatalogFile>, IcaError> {
    let path = dest_dir.join(CATALOG_NAME);
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        IcaError::Message(format!("Kamera-Katalog konnte nicht gelesen werden: {e}"))
    })?;
    parse_catalog_json(&raw)
}

struct CatalogTickBridge {
    dest: PathBuf,
    inner: Mutex<Box<dyn FnMut(Vec<CameraCatalogFile>) + Send>>,
}

unsafe extern "C" fn ica_catalog_tick_trampoline(ctx: *mut c_void) {
    if ctx.is_null() {
        return;
    }
    let bridge = unsafe { &*(ctx as *const CatalogTickBridge) };
    let Ok(entries) = read_catalog_file(&bridge.dest) else {
        return;
    };
    if let Ok(mut cb) = bridge.inner.lock() {
        cb(entries);
    }
}

/// List camera media (names/sizes/dates) without downloading. Holds the PTP session.
/// `on_tick` is called from a background queue as the catalog grows.
pub fn list_camera_catalog(
    source_id: &str,
    label: &str,
    dest_dir: &Path,
    mut on_tick: Option<Box<dyn FnMut(Vec<CameraCatalogFile>) + Send>>,
) -> Result<Vec<CameraCatalogFile>, IcaError> {
    if let Some(block) = crate::sd_card::mtp::usb_enumerate::media_access_block_for(source_id) {
        return Err(IcaError::Message(block.user_message(label)));
    }

    std::fs::create_dir_all(dest_dir).map_err(|e| IcaError::Message(e.to_string()))?;

    let dest = CString::new(dest_dir.to_string_lossy().as_bytes())
        .map_err(|_| IcaError::Message("Ungültiger Staging-Pfad (NUL)".into()))?;
    let hint = hint_cstring(label, source_id);

    let bridge = on_tick.take().map(|cb| CatalogTickBridge {
        dest: dest_dir.to_path_buf(),
        inner: Mutex::new(cb),
    });
    let (tick_fn, tick_ctx) = if let Some(ref b) = bridge {
        (
            Some(ica_catalog_tick_trampoline as unsafe extern "C" fn(*mut c_void)),
            b as *const CatalogTickBridge as *mut c_void,
        )
    } else {
        (None, std::ptr::null_mut())
    };

    let mut err = vec![0i8; 1024];
    let rc = unsafe {
        ats_ica_list_catalog(
            dest.as_ptr(),
            hint.as_ptr(),
            tick_fn,
            tick_ctx,
            err.as_mut_ptr() as *mut c_char,
            err.len(),
        )
    };
    drop(bridge);
    if rc != 0 {
        return Err(map_ica_failure(source_id, label, read_err_buf(&err)));
    }
    read_catalog_file(dest_dir)
}

struct ProgressBridge {
    inner: Mutex<Box<dyn FnMut(u32, u32, String, u64, u64) + Send>>,
}

unsafe extern "C" fn ica_progress_trampoline(
    file_index: u32,
    file_total: u32,
    filename_utf8: *const c_char,
    bytes_done: u64,
    bytes_total: u64,
    ctx: *mut c_void,
) {
    if ctx.is_null() {
        return;
    }
    let name = if filename_utf8.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(filename_utf8) }
            .to_string_lossy()
            .into_owned()
    };
    let bridge = unsafe { &*(ctx as *const ProgressBridge) };
    if let Ok(mut cb) = bridge.inner.lock() {
        cb(file_index, file_total, name, bytes_done, bytes_total);
    }
}

/// Download selected camera files (empty `names` = all) into `dest_dir`.
pub fn download_camera_files(
    source_id: &str,
    label: &str,
    dest_dir: &Path,
    names: &[String],
    mut on_progress: Option<Box<dyn FnMut(u32, u32, String, u64, u64) + Send>>,
) -> Result<Vec<PathBuf>, IcaError> {
    if let Some(block) = crate::sd_card::mtp::usb_enumerate::media_access_block_for(source_id) {
        return Err(IcaError::Message(block.user_message(label)));
    }

    std::fs::create_dir_all(dest_dir).map_err(|e| IcaError::Message(e.to_string()))?;

    let dest = CString::new(dest_dir.to_string_lossy().as_bytes())
        .map_err(|_| IcaError::Message("Ungültiger Staging-Pfad (NUL)".into()))?;
    let hint = hint_cstring(label, source_id);
    let joined = names.join("\n");
    let names_c = CString::new(joined.as_bytes())
        .map_err(|_| IcaError::Message("Ungültige Dateinamen (NUL)".into()))?;

    let bridge = on_progress.take().map(|cb| ProgressBridge {
        inner: Mutex::new(cb),
    });
    let (progress_fn, progress_ctx) = if let Some(ref b) = bridge {
        (
            Some(ica_progress_trampoline as unsafe extern "C" fn(_, _, _, _, _, _)),
            b as *const ProgressBridge as *mut c_void,
        )
    } else {
        (None, std::ptr::null_mut())
    };

    let mut err = vec![0i8; 1024];
    let rc = unsafe {
        ats_ica_download_named(
            dest.as_ptr(),
            hint.as_ptr(),
            names_c.as_ptr(),
            progress_fn,
            progress_ctx,
            err.as_mut_ptr() as *mut c_char,
            err.len(),
        )
    };
    // Keep bridge alive across the FFI call.
    drop(bridge);

    if rc != 0 {
        return Err(map_ica_failure(source_id, label, read_err_buf(&err)));
    }

    let paths = collect_media_files(dest_dir);
    if paths.is_empty() {
        return Err(IcaError::Message(format!(
            "{label}: Bildübernahme meldete Erfolg, aber keine Dateien im Zielordner."
        )));
    }
    Ok(paths)
}

/// Download all media (legacy staging helper). Prefers a held list session.
pub fn stage_camera_media_to(
    source_id: &str,
    label: &str,
    dest_dir: &Path,
) -> Result<Vec<PathBuf>, IcaError> {
    if let Some(existing) = read_existing_stage(dest_dir, source_id) {
        if ica_session_held() {
            return Ok(existing);
        }
    }
    clear_stage_dir(dest_dir);
    let paths = download_camera_files(source_id, label, dest_dir, &[], None)?;
    write_stage_meta(dest_dir, source_id, paths.len());
    Ok(paths)
}

/// Delete files on the USB camera by basename (masters + sidecar candidates).
///
/// Returns how many camera files Image Capture reported as deleted.
pub fn delete_camera_files_named(
    source_id: &str,
    label: &str,
    basenames: &[String],
) -> Result<usize, IcaError> {
    if basenames.is_empty() {
        return Ok(0);
    }
    let joined = basenames.join("\n");
    let names = CString::new(joined.as_bytes()).map_err(|_| {
        IcaError::Message("Ungültige Dateinamen für Kamera-Löschen (NUL)".into())
    })?;
    let hint_raw = format!("{label}|{source_id}");
    let hint = CString::new(hint_raw.as_bytes()).unwrap_or_else(|_| CString::new("gopro").unwrap());

    let mut err = vec![0i8; 1024];
    let mut deleted: i32 = 0;
    let rc = unsafe {
        ats_ica_delete_named(
            hint.as_ptr(),
            names.as_ptr(),
            &mut deleted,
            err.as_mut_ptr() as *mut c_char,
            err.len(),
        )
    };
    if rc != 0 {
        let msg = unsafe { CStr::from_ptr(err.as_ptr() as *const c_char) }
            .to_string_lossy()
            .trim()
            .to_string();
        let msg = if msg.is_empty() {
            format!("Löschen auf der USB-Kamera fehlgeschlagen ({label}).")
        } else {
            msg
        };
        return Err(IcaError::Message(msg));
    }

    invalidate_stage_cache(source_id);
    Ok(deleted.max(0) as usize)
}

/// True when `path` is a catalog virtual file under the ICA temp cache.
pub fn is_ica_cache_media_path(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| s == "aero_tandem_ica")
    })
}

/// JPEG thumbnail from the held Image Capture session (no media download).
pub fn camera_thumbnail_jpeg(filename: &str, dest_jpeg: &Path, max_edge: u32) -> Result<Vec<u8>, IcaError> {
    if dest_jpeg.is_file() {
        if let Ok(bytes) = std::fs::read(dest_jpeg) {
            if bytes.len() > 32 {
                return Ok(bytes);
            }
        }
    }
    if let Some(parent) = dest_jpeg.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let name = CString::new(filename.as_bytes())
        .map_err(|_| IcaError::Message("Ungültiger Dateiname (NUL)".into()))?;
    let dest = CString::new(dest_jpeg.to_string_lossy().as_bytes())
        .map_err(|_| IcaError::Message("Ungültiger Thumbnail-Pfad (NUL)".into()))?;
    let mut last_err = String::new();
    for attempt in 0..6 {
        let mut err = vec![0i8; 512];
        let rc = unsafe {
            ats_ica_thumbnail_named(
                name.as_ptr(),
                dest.as_ptr(),
                max_edge,
                err.as_mut_ptr() as *mut c_char,
                err.len(),
            )
        };
        if rc == 0 {
            let bytes = std::fs::read(dest_jpeg).map_err(|e| IcaError::Message(e.to_string()))?;
            if bytes.len() < 32 {
                return Err(IcaError::Message("Thumbnail leer.".into()));
            }
            return Ok(bytes);
        }
        last_err = read_err_buf(&err);
        // 3 = ICA lock busy (backup / other op) — retry briefly.
        if rc == 3 || last_err == "busy" {
            std::thread::sleep(Duration::from_millis(80 + attempt * 20));
            continue;
        }
        return Err(IcaError::Message(last_err));
    }
    Err(IcaError::Message(if last_err.is_empty() {
        "Kein Thumbnail von der Kamera.".into()
    } else {
        last_err
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_catalog_json_filters_proxies_and_empty() {
        let raw = r#"[
            {"name": "GX010123.MP4", "size": 1024, "mtime": 1690000000.0},
            {"name": "GX010123.LRV", "size": 10, "mtime": 1690000000.0},
            {"name": "", "size": 1, "mtime": 0.0},
            {"name": "GOPR0123.JPG", "size": 2048, "mtime": 1690000001.5}
        ]"#;
        let files = parse_catalog_json(raw).unwrap();
        let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["GX010123.MP4", "GOPR0123.JPG"]);
        assert_eq!(files[0].size, 1024);
        assert!((files[1].mtime - 1690000001.5).abs() < f64::EPSILON);
    }

    #[test]
    fn virtual_media_path_stays_under_cache_dir() {
        let p = virtual_media_path("mtp:gopro:ABC", "GX010123.MP4");
        assert_eq!(p.file_name().unwrap(), "GX010123.MP4");
        assert!(p.to_string_lossy().contains("aero_tandem_ica"));
    }

    #[test]
    fn ica_cache_path_detects_virtual_media() {
        let p = virtual_media_path("mtp:gopro:ABC", "GX010123.MP4");
        assert!(is_ica_cache_media_path(&p));
        assert!(!is_ica_cache_media_path(Path::new("/Volumes/GOPRO/DCIM/GX010123.MP4")));
    }
}
