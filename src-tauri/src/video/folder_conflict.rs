//! Soft folder-conflict check before create (Phase 30).
//!
//! When the deterministic output folder already has files, a second create would
//! leave stale media in place (e.g. old photos when only video is rebuilt) and
//! upload them with the new job. Soft confirm → replace (clear) or back.
//!
//! Never a hard error in `validate_create_job`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::video::export_paths::{
    build_base_filename, MARKER_FILENAME, SUBDIR_HANDCAM_FOTO, SUBDIR_HANDCAM_VIDEO,
    SUBDIR_OUTSIDE_FOTO, SUBDIR_OUTSIDE_VIDEO, SUBDIR_PREVIEW_FOTO, SUBDIR_PREVIEW_VIDEO,
};

const VIDEO_SUBDIRS: &[&str] = &[
    SUBDIR_HANDCAM_VIDEO,
    SUBDIR_OUTSIDE_VIDEO,
    SUBDIR_PREVIEW_VIDEO,
];
const PHOTO_SUBDIRS: &[&str] = &[
    SUBDIR_HANDCAM_FOTO,
    SUBDIR_OUTSIDE_FOTO,
    SUBDIR_PREVIEW_FOTO,
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OutputFolderProbe {
    pub exists: bool,
    /// True when the directory exists but contains no files (only empty dirs ok).
    pub is_empty: bool,
    pub folder_name: String,
    pub folder_path: String,
    pub has_marker: bool,
    pub video_file_count: u32,
    pub photo_file_count: u32,
    pub other_file_count: u32,
    pub total_file_count: u32,
}

impl OutputFolderProbe {
    pub fn should_warn(&self) -> bool {
        self.exists && !self.is_empty
    }
}

/// Resolve the would-be output folder and summarise existing contents (read-only).
pub fn probe_output_folder(
    speicherort: &Path,
    gast: &str,
    tandemmaster: &str,
    videospringer: &str,
    datum: &str,
    outside_video: bool,
    ort: &str,
) -> Result<OutputFolderProbe, String> {
    if speicherort.as_os_str().is_empty() {
        return Err("Speicherort ist leer".into());
    }

    let folder_name = build_base_filename(
        gast,
        tandemmaster,
        videospringer,
        datum,
        outside_video,
        ort,
    );
    let folder_path = speicherort.join(&folder_name);
    let path_str = folder_path.to_string_lossy().to_string();

    if !folder_path.exists() {
        return Ok(OutputFolderProbe {
            exists: false,
            is_empty: true,
            folder_name,
            folder_path: path_str,
            has_marker: false,
            video_file_count: 0,
            photo_file_count: 0,
            other_file_count: 0,
            total_file_count: 0,
        });
    }

    if !folder_path.is_dir() {
        return Err(format!(
            "Ausgabeziel existiert, ist aber kein Ordner: {}",
            folder_path.display()
        ));
    }

    let mut video_file_count = 0u32;
    let mut photo_file_count = 0u32;
    let mut other_file_count = 0u32;

    for sub in VIDEO_SUBDIRS {
        video_file_count = video_file_count.saturating_add(count_files_in(&folder_path.join(sub))?);
    }
    for sub in PHOTO_SUBDIRS {
        photo_file_count = photo_file_count.saturating_add(count_files_in(&folder_path.join(sub))?);
    }

    let has_marker = folder_path.join(MARKER_FILENAME).is_file();
    // Root + unknown subdirs (manifest, leftovers) count as other — avoid double-counting
    // known media subdirs by walking the tree and skipping those prefixes.
    other_file_count = count_other_files(&folder_path)?;

    let total_file_count = video_file_count
        .saturating_add(photo_file_count)
        .saturating_add(other_file_count);

    Ok(OutputFolderProbe {
        exists: true,
        is_empty: total_file_count == 0,
        folder_name,
        folder_path: path_str,
        has_marker,
        video_file_count,
        photo_file_count,
        other_file_count,
        total_file_count,
    })
}

/// Delete job folder contents and recreate an empty directory.
/// Only operates on `dir` itself — never on its parent (speicherort).
pub fn clear_job_output_dir(dir: &Path) -> Result<(), String> {
    if dir.as_os_str().is_empty() {
        return Err("Ausgabeordner-Pfad ist leer".into());
    }
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| {
            format!(
                "Ausgabeordner konnte nicht erstellt werden '{}': {e}",
                dir.display()
            )
        })?;
        return Ok(());
    }
    if !dir.is_dir() {
        return Err(format!(
            "Ausgabeziel ist kein Ordner und kann nicht ersetzt werden: {}",
            dir.display()
        ));
    }
    fs::remove_dir_all(dir).map_err(|e| {
        format!(
            "Ausgabeordner konnte nicht geleert werden '{}': {e}",
            dir.display()
        )
    })?;
    fs::create_dir_all(dir).map_err(|e| {
        format!(
            "Ausgabeordner konnte nicht neu angelegt werden '{}': {e}",
            dir.display()
        )
    })?;
    Ok(())
}

fn count_files_in(dir: &Path) -> Result<u32, String> {
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut n = 0u32;
    walk_files(dir, &mut |_: &Path| {
        n = n.saturating_add(1);
    })?;
    Ok(n)
}

fn count_other_files(job_root: &Path) -> Result<u32, String> {
    let mut n = 0u32;
    let entries = fs::read_dir(job_root).map_err(|e| {
        format!(
            "Ausgabeordner konnte nicht gelesen werden '{}': {e}",
            job_root.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if is_known_media_subdir(name.as_ref()) {
                continue;
            }
            walk_files(&path, &mut |_: &Path| {
                n = n.saturating_add(1);
            })?;
        } else if path.is_file() {
            n = n.saturating_add(1);
        }
    }
    Ok(n)
}

fn is_known_media_subdir(name: &str) -> bool {
    VIDEO_SUBDIRS
        .iter()
        .chain(PHOTO_SUBDIRS.iter())
        .any(|s| s.eq_ignore_ascii_case(name))
}

fn walk_files(dir: &Path, on_file: &mut dyn FnMut(&Path)) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| {
        format!(
            "Ordner konnte nicht gelesen werden '{}': {e}",
            dir.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, on_file)?;
        } else if path.is_file() {
            on_file(&path);
        }
    }
    Ok(())
}

/// Absolute path that `create_base_output_dir` would use (without creating it).
pub fn planned_output_dir(
    speicherort: &Path,
    gast: &str,
    tandemmaster: &str,
    videospringer: &str,
    datum: &str,
    outside_video: bool,
    ort: &str,
) -> PathBuf {
    let name = build_base_filename(
        gast,
        tandemmaster,
        videospringer,
        datum,
        outside_video,
        ort,
    );
    speicherort.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_folder_no_warn() {
        let dir = tempdir().unwrap();
        let probe = probe_output_folder(
            dir.path(),
            "Max",
            "Anna",
            "Bob",
            "06.08.2026",
            false,
            "Calden",
        )
        .unwrap();
        assert!(!probe.exists);
        assert!(probe.is_empty);
        assert!(!probe.should_warn());
        assert!(probe.folder_name.contains("Max"));
    }

    #[test]
    fn empty_folder_no_warn() {
        let dir = tempdir().unwrap();
        let name = build_base_filename("Max", "Anna", "Bob", "06.08.2026", false, "Calden");
        let job = dir.path().join(&name);
        fs::create_dir_all(job.join(SUBDIR_HANDCAM_FOTO)).unwrap();
        let probe = probe_output_folder(
            dir.path(),
            "Max",
            "Anna",
            "Bob",
            "06.08.2026",
            false,
            "Calden",
        )
        .unwrap();
        assert!(probe.exists);
        assert!(probe.is_empty);
        assert!(!probe.should_warn());
    }

    #[test]
    fn leftover_photos_warn() {
        let dir = tempdir().unwrap();
        let name = build_base_filename("Max", "Anna", "Bob", "06.08.2026", false, "Calden");
        let job = dir.path().join(&name);
        let foto = job.join(SUBDIR_HANDCAM_FOTO);
        fs::create_dir_all(&foto).unwrap();
        fs::write(foto.join("a.jpg"), b"x").unwrap();
        fs::write(foto.join("b.jpg"), b"y").unwrap();
        fs::write(job.join(MARKER_FILENAME), b"ok").unwrap();

        let probe = probe_output_folder(
            dir.path(),
            "Max",
            "Anna",
            "Bob",
            "06.08.2026",
            false,
            "Calden",
        )
        .unwrap();
        assert!(probe.should_warn());
        assert_eq!(probe.photo_file_count, 2);
        assert_eq!(probe.video_file_count, 0);
        assert!(probe.has_marker);
        assert_eq!(probe.other_file_count, 1); // marker
        assert_eq!(probe.total_file_count, 3);
    }

    #[test]
    fn clear_removes_leftovers() {
        let dir = tempdir().unwrap();
        let job = dir.path().join("job");
        let foto = job.join(SUBDIR_HANDCAM_FOTO);
        fs::create_dir_all(&foto).unwrap();
        fs::write(foto.join("a.jpg"), b"x").unwrap();
        fs::write(job.join(MARKER_FILENAME), b"ok").unwrap();

        clear_job_output_dir(&job).unwrap();
        assert!(job.is_dir());
        assert!(!job.join(SUBDIR_HANDCAM_FOTO).exists());
        assert!(!job.join(MARKER_FILENAME).exists());
        let entries: Vec<_> = fs::read_dir(&job).unwrap().collect();
        assert!(entries.is_empty());
    }
}
