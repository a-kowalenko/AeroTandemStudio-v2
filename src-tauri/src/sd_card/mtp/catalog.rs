//! Shared MTP/USB catalog types (macOS ICA + Windows WPD).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraCatalogFile {
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mtime: f64,
}

/// Virtual path used as the SD-selector key (file may not exist until backup/preview stage).
pub fn virtual_media_path(source_id: &str, filename: &str) -> PathBuf {
    cache_dir_for(source_id).join(filename)
}

pub fn cache_dir_for(source_id: &str) -> PathBuf {
    // Keep macOS path stable (ICA thumbs / held-session cache).
    #[cfg(target_os = "macos")]
    let base = std::env::temp_dir().join("aero_tandem_ica");
    #[cfg(not(target_os = "macos"))]
    let base = std::env::temp_dir().join("aero_tandem_mtp");

    base.join(sanitize_source_id(source_id))
}

pub fn sanitize_source_id(source_id: &str) -> String {
    source_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Temp cache folder name used by ICA (macOS) or WPD (Windows).
pub fn is_mtp_virtual_cache_component(name: &str) -> bool {
    name == "aero_tandem_ica" || name == "aero_tandem_mtp"
}

/// True when `path` is under the MTP/ICA virtual media cache (may not exist on disk yet).
pub fn is_mtp_virtual_media_path(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(os) => os.to_str().is_some_and(is_mtp_virtual_cache_component),
        _ => false,
    })
}

/// Recover `(source_id, filename)` from a virtual catalog path.
pub fn parse_mtp_virtual_media_path(path: &Path) -> Option<(String, String)> {
    let mut comps = path.components();
    while let Some(c) = comps.next() {
        let Component::Normal(os) = c else {
            continue;
        };
        let Some(name) = os.to_str() else {
            continue;
        };
        if !is_mtp_virtual_cache_component(name) {
            continue;
        }
        let Component::Normal(safe_os) = comps.next()? else {
            return None;
        };
        let safe = safe_os.to_str()?;
        let filename = path.file_name()?.to_str()?.to_string();
        let source_id = reconstruct_source_id(safe)?;
        return Some((source_id, filename));
    }
    None
}

/// Camera thumbnails must start with an image signature (JPEG / PNG / BMP).
/// Rejects truncated or non-image payloads left over from aborted transfers.
pub fn is_plausible_thumbnail(bytes: &[u8]) -> bool {
    if bytes.len() < 32 {
        return false;
    }
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(&[0x89, b'P', b'N', b'G'])
        || bytes.starts_with(b"BM")
}

/// Read a cached camera thumbnail; drops the file when it is not a valid image.
pub fn read_cached_thumbnail(path: &Path) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    match std::fs::read(path) {
        Ok(bytes) if is_plausible_thumbnail(&bytes) => Some(bytes),
        _ => {
            let _ = std::fs::remove_file(path);
            None
        }
    }
}

type StageLock = Arc<Mutex<()>>;

static PREVIEW_STAGE_LOCKS: Lazy<Mutex<HashMap<PathBuf, StageLock>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn preview_stage_lock(path: &Path) -> StageLock {
    let mut map = PREVIEW_STAGE_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Run `stage` for one virtual path at a time; concurrent callers wait and reuse the result.
pub fn with_preview_stage_lock<T>(path: &Path, stage: impl FnOnce() -> T) -> T {
    let lock = preview_stage_lock(path);
    let out = {
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        stage()
    };
    let mut map = PREVIEW_STAGE_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Map + our clone: nobody else is waiting on this path.
    if Arc::strong_count(&lock) <= 2 {
        map.remove(path);
    }
    out
}

/// True while a preview download for `path` is running (file on disk may be partial).
pub fn is_preview_staging(path: &Path) -> bool {
    let lock = {
        let map = PREVIEW_STAGE_LOCKS
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match map.get(path) {
            Some(l) => l.clone(),
            None => return false,
        }
    };
    let busy = lock.try_lock().is_err();
    busy
}

fn reconstruct_source_id(safe: &str) -> Option<String> {
    for vendor in ["gopro", "dji", "insta360"] {
        let prefix = format!("mtp_{vendor}_");
        if let Some(serial) = safe.strip_prefix(&prefix) {
            if !serial.is_empty() {
                return Some(format!("mtp:{vendor}:{serial}"));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_virtual_path_parse() {
        let p = virtual_media_path("mtp:gopro:C3441324595747", "GX010123.MP4");
        assert!(is_mtp_virtual_media_path(&p));
        let (sid, name) = parse_mtp_virtual_media_path(&p).expect("parse");
        assert_eq!(sid, "mtp:gopro:C3441324595747");
        assert_eq!(name, "GX010123.MP4");
    }

    #[test]
    fn plausible_thumbnail_requires_image_signature() {
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        jpeg.resize(64, 0);
        assert!(is_plausible_thumbnail(&jpeg));
        let mut png = vec![0x89, b'P', b'N', b'G'];
        png.resize(64, 0);
        assert!(is_plausible_thumbnail(&png));
        assert!(!is_plausible_thumbnail(&[0xFF, 0xD8, 0xFF]));
        assert!(!is_plausible_thumbnail(&[0u8; 64]));
    }

    #[test]
    fn preview_stage_lock_reports_busy_only_while_staging() {
        let p = virtual_media_path("mtp:gopro:LOCKTEST", "GX019999.MP4");
        assert!(!is_preview_staging(&p));
        let seen = with_preview_stage_lock(&p, || is_preview_staging(&p));
        assert!(seen);
        assert!(!is_preview_staging(&p));
    }

    #[test]
    fn non_mtp_path_rejected() {
        assert!(!is_mtp_virtual_media_path(Path::new(
            r"E:\DCIM\100GOPRO\GX01.MP4"
        )));
        assert!(parse_mtp_virtual_media_path(Path::new(r"E:\DCIM\GX01.MP4")).is_none());
    }
}
