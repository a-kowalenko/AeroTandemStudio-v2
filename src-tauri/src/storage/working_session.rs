//! Session working folder for imported media (Legacy drag_drop / video_preview.temp_dir).
//!
//! On import, videos and photos are copied into a temp dir (`aero_studio_preview_*`).
//! Cuts/splits operate on those copies so originals (SD / backup / user files) stay intact.
//! The folder is deleted on session reset / after create / explicit clear.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;

use crate::media::datetime::{build_chrono_photo_filename, collect_used_filenames_in};
use crate::storage::cache::PREVIEW_DIR_PREFIX;
use crate::storage::logging::{self, file_name};

static WORKING_SESSION: Lazy<Mutex<WorkingSession>> =
    Lazy::new(|| Mutex::new(WorkingSession::default()));

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
        let dir = std::env::temp_dir().join(format!(
            "{PREVIEW_DIR_PREFIX}{}_{}",
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
            return Ok(source.to_path_buf());
        }
        let dest = unique_dest_in(&root, &safe_filename(source))?;
        copy_file(source, &dest)?;
        logging::info(
            "import",
            format!(
                "Video kopiert: {} → {}",
                file_name(source),
                file_name(&dest)
            ),
        );
        Ok(dest)
    }

    /// Copy a photo into `{temp}/photos/` (or return path if already there).
    ///
    /// Destination name is chronological (`Foto_yyyyMMddHHmmssSSS[_nnn].JPG`) so
    /// DJI series with identical camera filenames stay in capture order when sorted.
    pub fn import_photo(&mut self, source: &Path) -> Result<PathBuf, WorkingSessionError> {
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
        let dest_name = build_chrono_photo_filename(source, &mut used);
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
                "Foto kopiert: {} → {}",
                file_name(source),
                file_name(&dest)
            ),
        );
        Ok(dest)
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
    fs::copy(src, dest)?;
    // Best-effort: preserve modified time like shutil.copy2
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
    let _ = with_session(|s| s.clear());
}

pub fn import_video_to_session(source: &str) -> Result<PathBuf, WorkingSessionError> {
    with_session(|s| s.import_video(Path::new(source)))?
}

pub fn import_photo_to_session(source: &str) -> Result<PathBuf, WorkingSessionError> {
    with_session(|s| s.import_photo(Path::new(source)))?
}

pub fn delete_working_copy(path: &str) -> bool {
    with_session(|s| s.delete_owned_file(Path::new(path))).unwrap_or(false)
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

#[allow(dead_code)]
pub fn import_photos_to_session(paths: &[String]) -> Result<Vec<String>, WorkingSessionError> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let dest = import_photo_to_session(path)?;
        out.push(dest.to_string_lossy().into_owned());
    }
    Ok(out)
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
        assert_ne!(p_name, p2_name);
        assert!(p2_name.contains("_001"), "{p2_name}");
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
    fn safe_filename_strips_illegal_chars() {
        // Use a basename only — `Path` treats `\` as a normal char on Unix.
        let p = Path::new("bad:name?.mp4");
        assert_eq!(safe_filename(p), "bad_name_.mp4");
        let nested = PathBuf::from("folder").join("bad:name?.mp4");
        assert_eq!(safe_filename(&nested), "bad_name_.mp4");
    }

    #[test]
    fn delete_owned_ignores_outside_paths() {
        let mut session = WorkingSession::default();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let _ = session.ensure_dir().unwrap();
        assert!(!session.delete_owned_file(outside.path()));
        assert!(outside.path().is_file());
        session.clear();
    }
}
