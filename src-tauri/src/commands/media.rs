//! Media import helpers (folder expand, working-session copy, etc.).

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::media::datetime::get_photo_import_metadata;
use crate::media::dji_paths::{expand_import_paths, is_photo_ext};
use crate::media::http_server::{ensure_media_file, MediaServerState};
use crate::storage::logging::{self, file_name};
use crate::storage::working_session;
use crate::video::probe::format_camera_label;

/// Expand file/folder paths into a flat list of media files (videos + photos).
/// Directories are walked recursively.
#[tauri::command]
pub async fn expand_media_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<String> = paths
            .into_iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        logging::info(
            "import",
            format!("Expandiere {} Pfad(e)…", paths.len()),
        );
        let expanded = expand_import_paths(&paths);
        logging::info(
            "import",
            format!(
                "Expansion fertig: {} → {} Mediendatei(en)",
                paths.len(),
                expanded.len()
            ),
        );
        Ok(expanded)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
pub struct FileSizeEntry {
    pub path: String,
    pub size_bytes: u64,
}

/// Return on-disk sizes for existing files (missing paths are omitted).
#[tauri::command]
pub async fn get_file_sizes(paths: Vec<String>) -> Vec<FileSizeEntry> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .unwrap_or_default()
}

fn is_photo_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(is_photo_ext)
        .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
pub struct PhotoMetadata {
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
    /// Camera brand from EXIF Make (empty if unknown).
    pub camera_make: String,
    /// Camera model from EXIF Model (empty if unknown).
    pub camera_model: String,
}

fn photo_metadata_for(path: &str) -> PhotoMetadata {
    let pb = Path::new(path);
    let filename = pb
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string();
    let size_bytes = std::fs::metadata(pb).map(|m| m.len()).unwrap_or(0);
    let ((camera_make, camera_model), (width, height)) = get_photo_import_metadata(pb);
    PhotoMetadata {
        path: path.to_string(),
        filename,
        size_bytes,
        width,
        height,
        camera_make,
        camera_model,
    }
}

/// Parallel EXIF/dimension pass after copy (keeps import IPC off the critical path).
///
/// Processes small batches in parallel and reports progress after each batch so the
/// UI can advance during the metadata phase without Send bounds on the callback.
fn photo_metadata_batch<F>(paths: &[String], mut on_progress: F) -> Vec<PhotoMetadata>
where
    F: FnMut(u64, u64, &str),
{
    let n = paths.len();
    if n == 0 {
        return Vec::new();
    }
    let total = n as u64;
    let batch_size = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(4)
        .clamp(2, 8);
    let mut out = Vec::with_capacity(n);
    let mut done = 0u64;
    for batch in paths.chunks(batch_size) {
        let batch_metas: Vec<PhotoMetadata> = std::thread::scope(|scope| {
            let handles: Vec<_> = batch
                .iter()
                .map(|p| scope.spawn(|| photo_metadata_for(p)))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_else(|_| photo_metadata_for(&batch[0])))
                .collect()
        });
        for meta in batch_metas {
            done += 1;
            let name = meta.filename.clone();
            out.push(meta);
            on_progress(done, total, &name);
        }
    }
    out
}

/// Copy photos into the session working folder (`…/photos/`) and return metadata.
#[tauri::command]
pub async fn import_photos(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<PhotoMetadata>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    crate::video::ffmpeg::reset_cancel_flag();
    let app_progress = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use crate::sd_card::monitor::{
            workflow_progress_import_copy, workflow_progress_import_probe, EVENT_WORKFLOW_PROGRESS,
        };
        use std::time::{Duration, Instant, SystemTime};
        use tauri::Emitter;

        let photo_paths: Vec<String> = paths
            .into_iter()
            .filter(|p| is_photo_path(p))
            .collect();
        if photo_paths.is_empty() {
            logging::warn("import", "Foto-Import: keine gültigen Bildpfade");
            return Ok(Vec::new());
        }
        logging::info(
            "import",
            format!(
                "Importiere {} Foto(s) in Arbeitsordner (Sortierung: EXIF DateTimeOriginal)…",
                photo_paths.len()
            ),
        );
        let n = photo_paths.len() as u64;
        let total_bytes: u64 = photo_paths
            .iter()
            .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
            .sum();
        let mut copied_bytes: u64 = 0;
        let start = SystemTime::now();
        let mut last_emit = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);

        let emit_copy = |copied_bytes: u64,
                         file_index: u64,
                         file_name: &str,
                         force: bool,
                         last: &mut Instant| {
            if !force && last.elapsed() < Duration::from_millis(150) {
                return;
            }
            let elapsed = start.elapsed().unwrap_or_default().as_secs_f64();
            let current_mb = copied_bytes as f64 / (1024.0 * 1024.0);
            let speed = if elapsed > 0.0 {
                current_mb / elapsed
            } else {
                0.0
            };
            let _ = app_progress.emit(
                EVENT_WORKFLOW_PROGRESS,
                workflow_progress_import_copy(
                    copied_bytes,
                    total_bytes,
                    speed,
                    file_index,
                    n,
                    file_name,
                    "Kopiere Fotos…",
                ),
            );
            *last = Instant::now();
        };

        let mut last_probe = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let emit_probe = |done: u64,
                          total: u64,
                          file_name: &str,
                          label: &str,
                          force: bool,
                          last: &mut Instant| {
            if !force && last.elapsed() < Duration::from_millis(150) {
                return;
            }
            let _ = app_progress.emit(
                EVENT_WORKFLOW_PROGRESS,
                workflow_progress_import_probe(done, total, file_name, label),
            );
            *last = Instant::now();
        };

        emit_probe(0, n, "", "Sortiere Fotos…", true, &mut last_probe);
        // Sort by EXIF capture time, rename with sequence, return filename order.
        // Confirm-dialog order is intentionally ignored.
        // Progress: throttle sort/copy emits (~150ms) so large batches do not freeze the UI.
        let dest = working_session::import_photos_to_session_with_progress(
            &photo_paths,
            |done, total, name| {
                emit_probe(done, total, name, "Sortiere Fotos…", false, &mut last_probe);
            },
            |file_index, name, delta| {
                if delta == 0 {
                    emit_copy(copied_bytes, file_index, name, false, &mut last_emit);
                    return;
                }
                copied_bytes += delta;
                emit_copy(copied_bytes, file_index, name, false, &mut last_emit);
            },
        )
        .map_err(|e| e.to_string())?;
        emit_probe(n, n, "", "Sortiere Fotos…", true, &mut last_probe);
        emit_copy(copied_bytes, n, "", true, &mut last_emit);

        emit_probe(0, n, "", "Lese Foto-Metadaten…", true, &mut last_probe);
        let out = photo_metadata_batch(&dest, |done, total, name| {
            emit_probe(
                done,
                total,
                name,
                "Lese Foto-Metadaten…",
                false,
                &mut last_probe,
            );
        });
        emit_probe(n, n, "", "Lese Foto-Metadaten…", true, &mut last_probe);
        let with_device = out
            .iter()
            .filter(|m| format_camera_label(&m.camera_make, &m.camera_model).is_some())
            .count();
        logging::info(
            "import",
            format!(
                "Foto-Import fertig: {} Datei(en), {} mit Geräte-Tag",
                out.len(),
                with_device
            ),
        );
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Active session working directory, if any.
#[tauri::command]
pub fn get_working_dir() -> Option<String> {
    working_session::get_working_dir().map(|p| p.to_string_lossy().into_owned())
}

/// Delete the session working folder (imported copies). Safe no-op if none.
/// Runs on a blocking pool so heavy `remove_dir_all` does not stall the UI thread.
#[tauri::command]
pub async fn clear_working_session() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        if let Some(dir) = working_session::get_working_dir() {
            logging::info(
                "import",
                format!("Lösche Arbeitsordner: {}", dir.display()),
            );
        } else {
            logging::info("import", "Kein Arbeitsordner zum Löschen");
        }
        working_session::clear_working_session();
    })
    .await
    .map_err(|e| e.to_string())
}

/// Delete a single file if it belongs to the session working folder.
#[tauri::command]
pub fn delete_working_copy(path: String) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    let name = file_name(trimmed);
    let ok = working_session::delete_working_copy(trimmed);
    if ok {
        logging::info("import", format!("Arbeitskopie gelöscht: {name}"));
    } else {
        logging::warn(
            "import",
            format!("Löschen übersprungen (nicht im Arbeitsordner): {name}"),
        );
    }
    ok
}

/// Batch-delete working copies on a blocking pool (clear list / clear tab).
#[tauri::command]
pub async fn delete_working_copies(paths: Vec<String>) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut deleted = 0usize;
        for path in paths {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                continue;
            }
            if working_session::delete_working_copy(trimmed) {
                deleted += 1;
            }
        }
        deleted
    })
    .await
    .map_err(|e| e.to_string())
}

/// Base URL of the loopback media HTTP server (`http://127.0.0.1:<port>`).
#[tauri::command]
pub fn get_media_server_base(state: State<'_, MediaServerState>) -> String {
    state.base_url.clone()
}

/// Playback URL for a local video file (loopback HTTP with Range support).
#[tauri::command]
pub fn media_file_url(path: String, state: State<'_, MediaServerState>) -> Result<String, String> {
    ensure_media_file(&path)?;
    Ok(state.url_for_path(path.trim()))
}

/// Rotate a photo working copy by 90° steps (pixels + EXIF orientation baked).
#[tauri::command]
pub async fn rotate_photo(
    input: String,
    degrees: i32,
    output: Option<String>,
    overwrite: Option<bool>,
) -> Result<crate::media::rotate::PhotoRotateResult, String> {
    if input.trim().is_empty() {
        return Err("input path is required".into());
    }
    if !Path::new(&input).is_file() {
        return Err(format!("input file not found: {input}"));
    }
    let overwrite = overwrite.unwrap_or(true);
    logging::info(
        "edit",
        format!(
            "Photo rotate: {} by {degrees}° overwrite={overwrite}",
            file_name(&input)
        ),
    );
    tauri::async_runtime::spawn_blocking(move || {
        crate::media::rotate::rotate_photo(&input, degrees, output.as_deref(), overwrite)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Crop a photo working copy (normalized rect 0–1 after EXIF bake).
#[tauri::command]
pub async fn crop_photo(
    input: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    output: Option<String>,
    overwrite: Option<bool>,
) -> Result<crate::media::crop::PhotoCropResult, String> {
    if input.trim().is_empty() {
        return Err("input path is required".into());
    }
    if !Path::new(&input).is_file() {
        return Err(format!("input file not found: {input}"));
    }
    let overwrite = overwrite.unwrap_or(true);
    logging::info(
        "edit",
        format!(
            "Photo crop: {} rect=({x:.3},{y:.3},{w:.3},{h:.3}) overwrite={overwrite}",
            file_name(&input)
        ),
    );
    tauri::async_runtime::spawn_blocking(move || {
        crate::media::crop::crop_photo(&input, x, y, w, h, output.as_deref(), overwrite)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn undo_photo_edit_for_path(
    path: String,
) -> Result<crate::media::photo_edit_undo::UndoPhotoEditResult, String> {
    if path.trim().is_empty() {
        return Err("path is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::media::photo_edit_undo::undo_edit_for_path(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn has_photo_edit_undo() -> bool {
    crate::media::photo_edit_undo::has_photo_edit_undo()
}

#[tauri::command]
pub fn list_photo_edit_marks() -> Vec<String> {
    crate::media::photo_edit_undo::photo_edit_mark_paths()
}

#[tauri::command]
pub fn clear_photo_edit_undo() {
    crate::media::photo_edit_undo::clear_photo_edit_undo();
}

#[tauri::command]
pub fn discard_photo_edit_undo_for_path(path: String) {
    if path.trim().is_empty() {
        return;
    }
    crate::media::photo_edit_undo::discard_edit_undo_for_path(&path);
}
