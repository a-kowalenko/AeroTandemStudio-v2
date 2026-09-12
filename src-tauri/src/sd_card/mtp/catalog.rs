//! Shared MTP/USB catalog types (macOS ICA + Windows WPD).

use std::path::{Component, Path, PathBuf};

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
        Component::Normal(os) => os
            .to_str()
            .is_some_and(is_mtp_virtual_cache_component),
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
    fn non_mtp_path_rejected() {
        assert!(!is_mtp_virtual_media_path(Path::new(r"E:\DCIM\100GOPRO\GX01.MP4")));
        assert!(parse_mtp_virtual_media_path(Path::new(r"E:\DCIM\GX01.MP4")).is_none());
    }
}
