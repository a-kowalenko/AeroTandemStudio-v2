//! Shared MTP/USB catalog types (macOS ICA + Windows WPD).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraCatalogFile {
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub mtime: f64,
}

/// Virtual path used as the SD-selector key (file may not exist until backup).
pub fn virtual_media_path(source_id: &str, filename: &str) -> PathBuf {
    cache_dir_for(source_id).join(filename)
}

pub fn cache_dir_for(source_id: &str) -> PathBuf {
    // Keep macOS path stable (ICA thumbs / held-session cache).
    #[cfg(target_os = "macos")]
    let base = std::env::temp_dir().join("aero_tandem_ica");
    #[cfg(not(target_os = "macos"))]
    let base = std::env::temp_dir().join("aero_tandem_mtp");

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
