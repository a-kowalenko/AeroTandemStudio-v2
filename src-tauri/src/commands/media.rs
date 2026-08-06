//! Media import helpers (folder expand, working-session copy, etc.).

use serde::Serialize;

use crate::media::dji_paths::{expand_import_paths, is_photo_ext};
use crate::storage::working_session;
use crate::util::natural_sort::sort_paths_by_basename;

/// Expand file/folder paths into a flat list of media files (videos + photos).
/// Directories are walked recursively.
#[tauri::command]
pub fn expand_media_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    Ok(expand_import_paths(&paths))
}

#[derive(Debug, Serialize)]
pub struct FileSizeEntry {
    pub path: String,
    pub size_bytes: u64,
}

/// Return on-disk sizes for existing files (missing paths are omitted).
#[tauri::command]
pub fn get_file_sizes(paths: Vec<String>) -> Vec<FileSizeEntry> {
    paths
        .into_iter()
        .filter_map(|path| {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                return None;
            }
            let meta = std::fs::metadata(trimmed).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(FileSizeEntry {
                path: path,
                size_bytes: meta.len(),
            })
        })
        .collect()
}

fn is_photo_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(is_photo_ext)
        .unwrap_or(false)
}

/// Copy photos into the session working folder (`…/photos/`) and return dest paths.
#[tauri::command]
pub fn import_photos(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let photo_paths: Vec<String> = paths
        .into_iter()
        .filter(|p| is_photo_path(p))
        .collect();
    let sorted = sort_paths_by_basename(&photo_paths);
    if sorted.is_empty() {
        return Ok(Vec::new());
    }
    working_session::import_photos_to_session(&sorted).map_err(|e| e.to_string())
}

/// Active session working directory, if any.
#[tauri::command]
pub fn get_working_dir() -> Option<String> {
    working_session::get_working_dir().map(|p| p.to_string_lossy().into_owned())
}

/// Delete the session working folder (imported copies). Safe no-op if none.
#[tauri::command]
pub fn clear_working_session() {
    working_session::clear_working_session();
}

/// Delete a single file if it belongs to the session working folder.
#[tauri::command]
pub fn delete_working_copy(path: String) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    working_session::delete_working_copy(trimmed)
}
