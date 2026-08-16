//! macOS Image Capture staging (Phase 23.2b).
//!
//! Downloads media from USB cameras (GoPro etc.) via Image Capture Core into a
//! local cache directory, then the existing SD pipeline works on real paths.

#![cfg(target_os = "macos")]

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
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
    fn ats_ica_stage_all(
        dest_dir_utf8: *const c_char,
        name_hint_utf8: *const c_char,
        err_buf: *mut c_char,
        err_len: usize,
    ) -> i32;
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
        if p.file_name().and_then(|n| n.to_str()) == Some(STAGE_META_NAME) {
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

/// Stage media from an Image Capture camera into `dest_dir`.
///
/// Reuses a recent cache for the same `source_id` when present.
pub fn stage_camera_media_to(
    source_id: &str,
    label: &str,
    dest_dir: &Path,
) -> Result<Vec<PathBuf>, IcaError> {
    if let Some(existing) = read_existing_stage(dest_dir, source_id) {
        return Ok(existing);
    }

    std::fs::create_dir_all(dest_dir).map_err(|e| IcaError::Message(e.to_string()))?;
    clear_stage_dir(dest_dir);

    let dest = CString::new(dest_dir.to_string_lossy().as_bytes()).map_err(|_| {
        IcaError::Message("Ungültiger Staging-Pfad (NUL)".into())
    })?;
    let hint_raw = format!("{label}|{source_id}");
    let hint = CString::new(hint_raw.as_bytes()).unwrap_or_else(|_| CString::new("gopro").unwrap());

    let mut err = vec![0i8; 1024];
    let rc = unsafe {
        ats_ica_stage_all(
            dest.as_ptr(),
            hint.as_ptr(),
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
            format!(
                "USB-Import über Bildübernahme fehlgeschlagen ({label}). \
                 Bitte Kamera wecken oder MicroSD im Kartenleser nutzen."
            )
        } else {
            msg
        };
        return Err(IcaError::Message(msg));
    }

    let paths = collect_media_files(dest_dir);
    if paths.is_empty() {
        return Err(IcaError::Message(format!(
            "{label}: Bildübernahme meldete Erfolg, aber keine Dateien im Staging-Ordner."
        )));
    }
    write_stage_meta(dest_dir, source_id, paths.len());
    Ok(paths)
}
