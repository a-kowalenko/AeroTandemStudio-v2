//! Session working folder for imported media (Legacy drag_drop / video_preview.temp_dir).
//!
//! On import, videos and photos are copied into a temp dir (`aero_studio_preview_*`).
//! Cuts/splits operate on those copies so originals (SD / backup / user files) stay intact.
//! The folder is deleted on session reset / after create / explicit clear.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;

use crate::media::datetime::{
    build_chrono_photo_filename_sequenced, build_chrono_photo_filename_sequenced_with_instant,
    collect_used_filenames_in, photos_sorted_by_capture_time,
};
use crate::storage::cache::PREVIEW_DIR_PREFIX;
use crate::storage::file_link;
use crate::storage::logging::{self, file_name};
use crate::video::ffmpeg::WORKFLOW_CANCELLED;

static WORKING_SESSION: Lazy<Mutex<WorkingSession>> =
    Lazy::new(|| Mutex::new(WorkingSession::default()));

static WORKING_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default)]
pub struct WorkingSession {
    temp_dir: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum WorkingSessionError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl WorkingSession {
    pub fn current_dir(&self) -> Option<&Path> {
        self.temp_dir.as_deref()
    }

    /// Ensure a session working directory exists (`%TEMP%/aero_studio_preview_*`).
    pub fn ensure_dir(&mut self) -> Result<PathBuf, WorkingSessionError> {
        if let Some(dir) = &self.temp_dir {
            if dir.is_dir() {
                return Ok(dir.clone());
            }
            self.temp_dir = None;
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let seq = WORKING_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "{PREVIEW_DIR_PREFIX}{}_{}_{seq}",
            std::process::id(),
            stamp
        ));
        fs::create_dir_all(&dir)?;
        self.temp_dir = Some(dir.clone());
        logging::info(
            "import",
            format!("Arbeitsordner angelegt: {}", dir.display()),
        );
        Ok(dir)
    }

    pub fn is_under_working_dir(&self, path: &Path) -> bool {
        let Some(root) = self.temp_dir.as_ref() else {
            return false;
        };
        if !root.is_dir() {
            return false;
        }
        let Ok(canon_root) = fs::canonicalize(root) else {
            return path_starts_with(path, root);
        };
        if let Ok(canon_path) = fs::canonicalize(path) {
            return path_starts_with(&canon_path, &canon_root);
        }
        path_starts_with(path, root)
    }

    /// Copy a video into the working folder root (or return path if already there).
    pub fn import_video(&mut self, source: &Path) -> Result<PathBuf, WorkingSessionError> {
        self.import_video_with_progress(source, |_| {})
    }

    /// Like [`Self::import_video`], reporting each written chunk via `on_chunk`.
    ///
    /// When the source is already under the working folder (no copy), `on_chunk` is
    /// invoked once with the full file size so overall byte progress stays consistent.
    pub fn import_video_with_progress<F>(
        &mut self,
        source: &Path,
        mut on_chunk: F,
    ) -> Result<PathBuf, WorkingSessionError>
    where
        F: FnMut(u64),
    {
        if !source.is_file() {
            return Err(WorkingSessionError::Message(format!(
                "Datei nicht gefunden: {}",
                source.display()
            )));
        }
        let root = self.ensure_dir()?;
        if self.is_under_working_dir(source) {
            logging::debug(
                "import",
                format!("Video bereits im Arbeitsordner: {}", file_name(source)),
            );
            let size = fs::metadata(source).map(|m| m.len()).unwrap_or(0);
            if size > 0 {
                on_chunk(size);
            }
            return Ok(source.to_path_buf());
        }
        let dest = unique_dest_in(&root, &safe_filename(source))?;
        copy_file_reporting(source, &dest, &mut on_chunk)?;
        logging::info(
            "import",
            format!(
                "Video importiert: {} → {}",
                file_name(source),
                file_name(&dest)
            ),
        );
        Ok(dest)
    }

    /// Copy a photo into `{temp}/photos/` (or return path if already there).
    ///
    /// Destination name is chronological from EXIF DateTimeOriginal
    /// (`Foto_yyyyMMddHHmmssSSS_NNNN.JPG`). Sequence is for uniqueness within a
    /// single-file import; prefer [`Self::import_photos_by_capture_time`] for batches.
    pub fn import_photo(&mut self, source: &Path) -> Result<PathBuf, WorkingSessionError> {
        self.import_photo_sequenced(source, 1)
    }

    fn import_photo_sequenced(
        &mut self,
        source: &Path,
        sequence: u32,
    ) -> Result<PathBuf, WorkingSessionError> {
        if !source.is_file() {
            return Err(WorkingSessionError::Message(format!(
                "Datei nicht gefunden: {}",
                source.display()
            )));
        }
        let root = self.ensure_dir()?;
        if self.is_under_working_dir(source) {
            logging::debug(
                "import",
                format!("Foto bereits im Arbeitsordner: {}", file_name(source)),
            );
            return Ok(source.to_path_buf());
        }
        let photos = root.join("photos");
        fs::create_dir_all(&photos)?;
        let mut used = collect_used_filenames_in(&photos);
        let dest_name = build_chrono_photo_filename_sequenced(source, sequence, &mut used);
        let dest = photos.join(&dest_name);
        if dest.exists() {
            return Err(WorkingSessionError::Message(format!(
                "Zielname bereits vorhanden: {dest_name}"
            )));
        }
        copy_file(source, &dest)?;
        logging::info(
            "import",
            format!(
                "Foto importiert: {} → {}",
                file_name(source),
                file_name(&dest)
            ),
        );
        Ok(dest)
    }

    /// Import photos sorted by EXIF capture time, rename with matching sequence, return
    /// paths sorted by the new filename (dialog order is ignored).
    pub fn import_photos_by_capture_time(
        &mut self,
        sources: &[String],
    ) -> Result<Vec<PathBuf>, WorkingSessionError> {
        self.import_photos_by_capture_time_with_progress(sources, |_, _, _| {})
    }

    /// Like [`Self::import_photos_by_capture_time`], reporting copy progress.
    ///
    /// `on_progress(file_index_1based, file_name, delta_bytes)` — `delta_bytes` is 0 at
    /// file start; when a source is already under the working folder, one call reports
    /// the full file size so overall byte progress stays consistent.
    pub fn import_photos_by_capture_time_with_progress<F>(
        &mut self,
        sources: &[String],
        mut on_progress: F,
    ) -> Result<Vec<PathBuf>, WorkingSessionError>
    where
        F: FnMut(u64, &str, u64),
    {
        // One EXIF/mtime resolve per file for sort + rename (not O(n log n) opens).
        let sorted = photos_sorted_by_capture_time(sources);

        let root = self.ensure_dir()?;
        let photos = root.join("photos");
        fs::create_dir_all(&photos)?;
        let mut used = collect_used_filenames_in(&photos);
        let mut dests: Vec<PathBuf> = Vec::with_capacity(sorted.len());
        let total = sorted.len() as u64;

        for (idx, (source, instant)) in sorted.iter().enumerate() {
            if crate::video::ffmpeg::is_cancelled() {
                for d in &dests {
                    let _ = self.delete_owned_file(d);
                }
                return Err(WorkingSessionError::Message(WORKFLOW_CANCELLED.into()));
            }
            let source_path = Path::new(source);
            let file_index = (idx as u64) + 1;
            let name = file_name(source_path);
            on_progress(file_index, &name, 0);
            if self.is_under_working_dir(source_path) {
                let size = fs::metadata(source_path).map(|m| m.len()).unwrap_or(0);
                if size > 0 {
                    on_progress(file_index, &name, size);
                }
                dests.push(source_path.to_path_buf());
                continue;
            }
            let seq = (idx + 1) as u32;
            let dest_name = build_chrono_photo_filename_sequenced_with_instant(
                source_path,
                instant,
                seq,
                &mut used,
            );
            let dest = photos.join(&dest_name);
            if dest.exists() {
                return Err(WorkingSessionError::Message(format!(
                    "Zielname bereits vorhanden: {dest_name}"
                )));
            }
            if let Err(e) = copy_file_reporting(source_path, &dest, &mut |delta| {
                on_progress(file_index, &name, delta);
            }) {
                for d in &dests {
                    let _ = self.delete_owned_file(d);
                }
                return Err(e.into());
            }
            let msg = format!(
                "Foto importiert: {} → {}",
                file_name(source_path),
                file_name(&dest)
            );
            // Avoid flooding the UI log bus on large batches (each INFO emits IPC).
            if should_log_photo_import(file_index, total) {
                logging::info("import", msg);
            } else {
                logging::debug("import", msg);
            }
            dests.push(dest);
        }

        dests.sort_by(|a, b| {
            a.file_name()
                .unwrap_or_default()
                .cmp(b.file_name().unwrap_or_default())
        });
        Ok(dests)
    }

    /// Delete a file if it lives under the session working folder.
    pub fn delete_owned_file(&self, path: &Path) -> bool {
        if !self.is_under_working_dir(path) {
            return false;
        }
        if path.is_file() {
            match fs::remove_file(path) {
                Ok(()) => {
                    logging::info(
                        "import",
                        format!("Arbeitskopie entfernt: {}", file_name(path)),
                    );
                    return true;
                }
                Err(e) => {
                    logging::warn(
                        "import",
                        format!("Löschen fehlgeschlagen ({}): {e}", file_name(path)),
                    );
                    return false;
                }
            }
        }
        false
    }

    /// Remove the entire working directory and clear session state.
    pub fn clear(&mut self) {
        if let Some(dir) = self.temp_dir.take() {
            logging::info(
                "import",
                format!("Arbeitsordner wird gelöscht: {}", dir.display()),
            );
            if let Err(e) = fs::remove_dir_all(&dir) {
                logging::warn(
                    "import",
                    format!("Arbeitsordner löschen fehlgeschlagen: {e}"),
                );
            }
        }
        file_link::clear_hardlink_registry();
    }
}

fn path_starts_with(path: &Path, root: &Path) -> bool {
    let path_s = normalize_cmp(path);
    let root_s = normalize_cmp(root);
    path_s == root_s || path_s.starts_with(&(root_s + std::path::MAIN_SEPARATOR_STR))
}

fn normalize_cmp(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR);
    #[cfg(windows)]
    {
        s.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s
    }
}

fn safe_filename(source: &Path) -> String {
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("media");
    name.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect()
}

fn unique_dest_in(dir: &Path, filename: &str) -> Result<PathBuf, WorkingSessionError> {
    let mut dest = dir.join(filename);
    if !dest.exists() {
        return Ok(dest);
    }
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("media");
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let mut counter = 1u32;
    loop {
        dest = dir.join(format!("{stem}_{counter}{ext}"));
        if !dest.exists() {
            return Ok(dest);
        }
        counter += 1;
        if counter > 10_000 {
            return Err(WorkingSessionError::Message(
                "Zu viele Namenskollisionen im Arbeitsordner".into(),
            ));
        }
    }
}

fn copy_file(src: &Path, dest: &Path) -> Result<(), WorkingSessionError> {
    copy_file_reporting(src, dest, &mut |_| {})
}

/// Log first, last, and every 50th photo at INFO so large imports do not flood IPC.
fn should_log_photo_import(file_index: u64, total: u64) -> bool {
    file_index == 1 || file_index == total || file_index % 50 == 0
}

fn copy_file_reporting<F>(
    src: &Path,
    dest: &Path,
    on_chunk: &mut F,
) -> Result<(), WorkingSessionError>
where
    F: FnMut(u64),
{
    file_link::import_copy_or_hardlink(src, dest, on_chunk)?;
    // Best-effort: preserve modified time like shutil.copy2 (hardlinks share inode mtime).
    if let Ok(meta) = fs::metadata(src) {
        if let Ok(mtime) = meta.modified() {
            let _ = filetime_set_mtime(dest, mtime);
        }
    }
    Ok(())
}

fn filetime_set_mtime(path: &Path, mtime: SystemTime) -> io::Result<()> {
    let file = fs::File::options().write(true).open(path)?;
    file.set_modified(mtime)
}

/// Lock the global working session.
pub fn with_session<T>(f: impl FnOnce(&mut WorkingSession) -> T) -> Result<T, WorkingSessionError> {
    let mut guard = WORKING_SESSION
        .lock()
        .map_err(|_| WorkingSessionError::Message("working session lock poisoned".into()))?;
    Ok(f(&mut guard))
}

pub fn get_working_dir() -> Option<PathBuf> {
    with_session(|s| s.current_dir().map(|p| p.to_path_buf())).ok().flatten()
}

pub fn clear_working_session() {
    crate::video::cut_undo::clear_cut_undo();
    crate::media::photo_edit_undo::clear_photo_edit_undo();
    let _ = with_session(|s| s.clear());
}

pub fn import_video_to_session(source: &str) -> Result<PathBuf, WorkingSessionError> {
    with_session(|s| s.import_video(Path::new(source)))?
}

pub fn import_video_to_session_with_progress<F>(
    source: &str,
    on_chunk: F,
) -> Result<PathBuf, WorkingSessionError>
where
    F: FnMut(u64),
{
    with_session(|s| s.import_video_with_progress(Path::new(source), on_chunk))?
}

pub fn import_photo_to_session(source: &str) -> Result<PathBuf, WorkingSessionError> {
    with_session(|s| s.import_photo(Path::new(source)))?
}

pub fn delete_working_copy(path: &str) -> bool {
    with_session(|s| s.delete_owned_file(Path::new(path))).unwrap_or(false)
}

/// Remove working-folder copies from a cancelled import batch.
pub fn rollback_working_import_paths(paths: &[String]) {
    for path in paths {
        let _ = delete_working_copy(path);
    }
}

#[allow(dead_code)]
pub fn import_videos_to_session(paths: &[String]) -> Result<Vec<String>, WorkingSessionError> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let dest = import_video_to_session(path)?;
        out.push(dest.to_string_lossy().into_owned());
    }
    Ok(out)
}

/// Import photos sorted by EXIF capture time; returns paths sorted by new filename.
pub fn import_photos_to_session(paths: &[String]) -> Result<Vec<String>, WorkingSessionError> {
    import_photos_to_session_with_progress(paths, |_, _, _| {})
}

/// Like [`import_photos_to_session`], reporting copy progress.
///
/// Callback: `(file_index_1based, file_name, delta_bytes)`.
pub fn import_photos_to_session_with_progress<F>(
    paths: &[String],
    on_progress: F,
) -> Result<Vec<String>, WorkingSessionError>
where
    F: FnMut(u64, &str, u64),
{
    with_session(|s| {
        let dests = s.import_photos_by_capture_time_with_progress(paths, on_progress)?;
        Ok(dests
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<_>>())
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp_file(dir: &Path, name: &str, contents: &[u8]) -> PathBuf {
        let p = dir.join(name);
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(contents).unwrap();
        p
    }

    #[test]
    fn copy_video_and_photo_into_session() {
        let _guard = crate::storage::cache::test_temp_sweep_lock();
        let mut session = WorkingSession::default();
        let src_root = tempfile::tempdir().unwrap();
        let video = write_temp_file(src_root.path(), "DJI_0001.MP4", b"video-bytes");
        let photo = write_temp_file(src_root.path(), "DJI_0002.JPG", b"photo-bytes");

        let v_dest = session.import_video(&video).unwrap();
        let p_dest = session.import_photo(&photo).unwrap();

        assert!(v_dest.is_file());
        assert!(p_dest.is_file());
        assert!(session.is_under_working_dir(&v_dest));
        assert!(session.is_under_working_dir(&p_dest));
        assert!(p_dest
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .eq("photos"));
        assert_ne!(v_dest, video);
        assert_ne!(p_dest, photo);

        // Second import of same photo → chrono name with `_001` collision suffix
        let p2 = session.import_photo(&photo).unwrap();
        let p_name = p_dest.file_name().unwrap().to_string_lossy().to_string();
        let p2_name = p2.file_name().unwrap().to_string_lossy().to_string();
        assert!(p_name.starts_with("Foto_"), "{p_name}");
        assert!(crate::media::datetime::is_chrono_photo_filename(&p_name));
        assert!(p_name.contains("_0001"), "{p_name}");
        assert_ne!(p_name, p2_name);
        assert!(p2_name.contains("_0001") || p2_name.contains("_0002") || p2_name.contains("_001"), "{p2_name}");
        assert!(crate::media::datetime::is_chrono_photo_filename(&p2_name));

        // Second import of same video names → unique suffix
        let v2 = session.import_video(&video).unwrap();
        assert!(v2
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("DJI_0001_1"));

        // Already in working dir → no re-copy
        let again = session.import_video(&v_dest).unwrap();
        assert_eq!(again, v_dest);

        assert!(session.delete_owned_file(&v_dest));
        assert!(!v_dest.is_file());
        // Original untouched
        assert!(video.is_file());

        session.clear();
        assert!(session.current_dir().is_none());
    }

    #[test]
    fn import_video_reports_chunk_progress() {
        let _guard = crate::storage::cache::test_temp_sweep_lock();
        let mut session = WorkingSession::default();
        let src_root = tempfile::tempdir().unwrap();
        let payload = vec![0xABu8; 64 * 1024];
        let video = write_temp_file(src_root.path(), "BIG.MP4", &payload);

        let mut reported = 0u64;
        let dest = session
            .import_video_with_progress(&video, |delta| {
                reported += delta;
            })
            .unwrap();
        assert_eq!(reported, payload.len() as u64);
        assert_eq!(fs::read(&dest).unwrap(), payload);

        // Already in working dir → one callback with full size
        let mut skip_reported = 0u64;
        let again = session
            .import_video_with_progress(&dest, |delta| {
                skip_reported += delta;
            })
            .unwrap();
        assert_eq!(again, dest);
        assert_eq!(skip_reported, payload.len() as u64);

        session.clear();
    }

    #[test]
    fn safe_filename_strips_illegal_chars() {
        // Use a basename only — `Path` treats `\` as a normal char on Unix.
        let p = Path::new("bad:name?.mp4");
        assert_eq!(safe_filename(p), "bad_name_.mp4");
        let nested = PathBuf::from("folder").join("bad:name?.mp4");
        assert_eq!(safe_filename(&nested), "bad_name_.mp4");
    }

    #[test]
    fn delete_owned_ignores_outside_paths() {
        let _guard = crate::storage::cache::test_temp_sweep_lock();
        let mut session = WorkingSession::default();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let _ = session.ensure_dir().unwrap();
        assert!(!session.delete_owned_file(outside.path()));
        assert!(outside.path().is_file());
        session.clear();
    }
}
