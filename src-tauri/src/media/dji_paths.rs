//! DJI SD path helpers (port of legacy `dji_media_paths.py`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

pub const BACKUP_MANIFEST_NAME: &str = ".aerotandem_manifest.json";

pub const PHOTO_EXTENSIONS: &[&str] = &[
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".heic", ".raw", ".cr2",
    ".nef", ".arw", ".dng",
];

pub const VIDEO_EXTENSIONS: &[&str] = &[
    ".mp4", ".mov", ".avi", ".mkv", ".m4v", ".mpg", ".mpeg", ".wmv", ".flv", ".webm",
];

pub const MEDIA_EXTENSIONS: &[&str] = &[
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".heic", ".raw", ".cr2",
    ".nef", ".arw", ".dng", ".mp4", ".mov", ".avi", ".mkv", ".m4v", ".mpg", ".mpeg", ".wmv",
    ".flv", ".webm",
];

fn ext_of(path: &Path) -> String {
    // Prefer last path segment after `/` or `\` so Windows-style strings work on Unix.
    let raw = path.to_string_lossy();
    let name = raw.rsplit(['/', '\\']).next().unwrap_or(raw.as_ref());
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_default()
}

pub fn is_photo_ext(ext: &str) -> bool {
    let e = if ext.starts_with('.') {
        ext.to_ascii_lowercase()
    } else {
        format!(".{}", ext.to_ascii_lowercase())
    };
    PHOTO_EXTENSIONS.contains(&e.as_str())
}

pub fn is_video_ext(ext: &str) -> bool {
    let e = if ext.starts_with('.') {
        ext.to_ascii_lowercase()
    } else {
        format!(".{}", ext.to_ascii_lowercase())
    };
    VIDEO_EXTENSIONS.contains(&e.as_str())
}

pub fn is_media_ext(ext: &str) -> bool {
    is_photo_ext(ext) || is_video_ext(ext)
}

pub fn media_type_from_filename(filename: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    if VIDEO_EXTENSIONS.iter().any(|e| lower.ends_with(e)) {
        "video"
    } else if PHOTO_EXTENSIONS.iter().any(|e| lower.ends_with(e)) {
        "photo"
    } else {
        "video"
    }
}

/// Normalize Windows drive-relative joins (`E:DCIM` → `E:\DCIM`).
pub fn normalize_media_path(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let norm = PathBuf::from(path);
    let s = norm.to_string_lossy().into_owned();

    #[cfg(windows)]
    {
        if s.len() >= 2 && s.as_bytes()[1] == b':' {
            let drive = &s[..2];
            let rest = s[2..].trim_start_matches(['\\', '/']);
            if rest.is_empty() {
                return format!("{drive}\\");
            }
            return format!("{drive}\\{rest}");
        }
    }
    s
}

pub fn resolve_drive_dcim_path(drive: &str) -> String {
    let drive = drive.trim_end_matches(['\\', '/']);
    if drive.is_empty() {
        return String::new();
    }
    normalize_media_path(&format!("{drive}{}DCIM", std::path::MAIN_SEPARATOR))
}

fn path_parts(path: &str) -> Vec<String> {
    // Accept Windows-style `\` even on Unix (tests / imported path strings).
    let normalized = normalize_media_path(path).replace('\\', "/");
    Path::new(&normalized)
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            Component::Prefix(p) => Some(p.as_os_str().to_string_lossy().into_owned()),
            _ => None,
        })
        .collect()
}

fn dcim_index(parts: &[String]) -> Option<usize> {
    parts.iter().position(|p| p.eq_ignore_ascii_case("DCIM"))
}

pub fn resolve_dcim_root(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let mut current = PathBuf::from(normalize_media_path(path));
    if !current.exists() {
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        }
    }
    loop {
        if current
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("DCIM"))
            .unwrap_or(false)
            && current.is_dir()
        {
            return Some(normalize_media_path(&current.to_string_lossy()));
        }
        if !current.pop() {
            break;
        }
    }
    let child = PathBuf::from(normalize_media_path(path)).join("DCIM");
    if child.is_dir() {
        return Some(normalize_media_path(&child.to_string_lossy()));
    }
    None
}

fn path_has_timelapse_segment(parts: &[String], dcim_idx: usize) -> bool {
    parts
        .iter()
        .skip(dcim_idx + 1)
        .any(|p| p.eq_ignore_ascii_case("timelapse"))
}

pub fn is_under_dji_timelapse_tree(file_path: &str) -> bool {
    let parts = path_parts(file_path);
    match dcim_index(&parts) {
        Some(idx) => path_has_timelapse_segment(&parts, idx),
        None => false,
    }
}

pub fn is_timelapse_photo_path(file_path: &str) -> bool {
    if file_path.is_empty() {
        return false;
    }
    if !is_photo_ext(&ext_of(Path::new(file_path))) {
        return false;
    }
    is_under_dji_timelapse_tree(file_path)
}

pub fn paths_indicate_timelapse_session(media_paths: &[String]) -> bool {
    media_paths.iter().any(|p| is_timelapse_photo_path(p))
}

pub fn should_skip_file_for_timelapse_session(
    file_path: &str,
    is_video: bool,
    timelapse_session_active: bool,
    exclude_timelapse_videos: bool,
) -> bool {
    if !exclude_timelapse_videos || !is_video {
        return false;
    }
    if timelapse_session_active {
        return true;
    }
    is_under_dji_timelapse_tree(file_path)
}

pub fn resolve_timelapse_session_active_for_paths(
    _dcim_source: &str,
    media_paths: &[String],
    manifest: Option<&BackupManifest>,
) -> bool {
    if let Some(m) = manifest {
        if m.timelapse_session_active {
            return true;
        }
        if m.files.iter().any(|e| {
            e.media_type == "photo" && is_timelapse_photo_path(e.src.as_deref().unwrap_or(""))
        }) {
            return true;
        }
    }
    paths_indicate_timelapse_session(media_paths)
}

/// Filter media paths for SD backup/import; returns (kept, skipped_count).
pub fn filter_media_paths_for_backup(
    media_paths: &[String],
    dcim_root: &str,
    exclude_timelapse_videos: bool,
) -> (Vec<String>, usize) {
    if !exclude_timelapse_videos {
        return (media_paths.to_vec(), 0);
    }
    let effective = resolve_dcim_root(dcim_root)
        .map(|p| normalize_media_path(&p))
        .unwrap_or_else(|| normalize_media_path(dcim_root));
    let session_active =
        resolve_timelapse_session_active_for_paths(&effective, media_paths, None);
    let mut kept = Vec::new();
    let mut skipped = 0;
    for path in media_paths {
        let is_video = is_video_ext(&ext_of(Path::new(path)));
        if should_skip_file_for_timelapse_session(path, is_video, session_active, true) {
            skipped += 1;
            continue;
        }
        kept.push(path.clone());
    }
    (kept, skipped)
}

pub fn collect_media_paths_from_tree(scan_root: &Path) -> Vec<String> {
    if !scan_root.is_dir() {
        return Vec::new();
    }
    let mut found = Vec::new();
    let walker = walkdir_simple(scan_root);
    for path in walker {
        let ext = ext_of(&path);
        if is_media_ext(&ext) {
            found.push(path.to_string_lossy().into_owned());
        }
    }
    found
}

/// Expand dropped/picked paths: files keep as-is (if media), directories are walked recursively.
/// Deduplicates case-insensitively on Windows. Order: first-seen (stable).
pub fn expand_import_paths(paths: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if path.is_dir() {
            for media in collect_media_paths_from_tree(&path) {
                let key = normalize_key(&media);
                if seen.insert(key) {
                    out.push(media);
                }
            }
        } else if path.is_file() {
            let ext = ext_of(&path);
            if !is_media_ext(&ext) {
                continue;
            }
            let media = path.to_string_lossy().into_owned();
            let key = normalize_key(&media);
            if seen.insert(key) {
                out.push(media);
            }
        }
    }

    out
}

fn walkdir_simple(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                out.push(path);
            }
        }
    }
    out
}

/// Expand delete list with sidecar files (same stem, non-media extension).
pub fn expand_files_for_sd_clear(backed_up_paths: &[String]) -> Vec<String> {
    let media: HashSet<String> = MEDIA_EXTENSIONS.iter().map(|e| e.to_string()).collect();
    let mut to_delete: HashMap<String, String> = HashMap::new();
    let mut stems_by_dir: HashMap<PathBuf, HashSet<String>> = HashMap::new();

    for path in backed_up_paths {
        if path.is_empty() {
            continue;
        }
        let pb = PathBuf::from(path);
        let key = normalize_key(path);
        to_delete.insert(key, path.clone());
        if let (Some(dir), Some(stem)) = (
            pb.parent().map(|p| p.to_path_buf()),
            pb.file_stem().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()),
        ) {
            stems_by_dir.entry(dir).or_default().insert(stem);
        }
    }

    for (directory, stems) in &stems_by_dir {
        let names = match fs::read_dir(directory) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in names.flatten() {
            let full = entry.path();
            if !full.is_file() {
                continue;
            }
            let full_s = full.to_string_lossy().into_owned();
            let key = normalize_key(&full_s);
            if to_delete.contains_key(&key) {
                continue;
            }
            let stem = full
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            if !stems.contains(&stem) {
                continue;
            }
            let ext = ext_of(&full);
            if media.contains(&ext) {
                continue;
            }
            to_delete.insert(key, full_s);
        }
    }

    to_delete.into_values().collect()
}

fn normalize_key(path: &str) -> String {
    #[cfg(windows)]
    {
        normalize_media_path(path).to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalize_media_path(path)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BackupManifest {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub dcim_source: String,
    #[serde(default)]
    pub timelapse_session_active: bool,
    #[serde(default)]
    pub files: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub dest: String,
    #[serde(default)]
    pub src: Option<String>,
    #[serde(default)]
    pub media_type: String,
}

pub fn write_backup_manifest(
    backup_path: &Path,
    dcim_source: &str,
    copied_entries: &[ManifestEntry],
    timelapse_session_active: bool,
) -> Result<(), String> {
    let manifest = BackupManifest {
        version: 2,
        dcim_source: normalize_media_path(dcim_source),
        timelapse_session_active,
        files: copied_entries
            .iter()
            .map(|e| ManifestEntry {
                dest: e.dest.clone(),
                src: e.src.as_ref().map(|s| normalize_media_path(s)),
                media_type: e.media_type.clone(),
            })
            .collect(),
    };
    let path = backup_path.join(BACKUP_MANIFEST_NAME);
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[allow(dead_code)]
pub fn read_backup_manifest(backup_path: &Path) -> Option<BackupManifest> {
    let path = backup_path.join(BACKUP_MANIFEST_NAME);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Build unique destination filename for a conflict.
pub fn unique_dest_name(original: &str, used: &mut HashSet<String>) -> String {
    let mut candidate = original.to_string();
    let (stem, ext) = match Path::new(original).extension().and_then(|e| e.to_str()) {
        Some(e) => {
            let stem = Path::new(original)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(original);
            (stem.to_string(), format!(".{e}"))
        }
        None => (original.to_string(), String::new()),
    };
    let mut counter = 1u32;
    while used.contains(&candidate.to_ascii_lowercase()) {
        candidate = format!("{stem}_{counter}{ext}");
        counter += 1;
    }
    used.insert(candidate.to_ascii_lowercase());
    candidate
}

/// Timelapse photo filename pattern from legacy.
#[allow(dead_code)]
pub fn is_timelapse_photo_filename(filename: &str) -> bool {
    static RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"(?i)^Foto_\d{17}(?:_\d{3})?\.(jpg|jpeg)$").unwrap()
    });
    let base = Path::new(filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(filename);
    RE.is_match(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_windows_drive_path() {
        let p = normalize_media_path("E:DCIM");
        #[cfg(windows)]
        assert_eq!(p, "E:\\DCIM");
        #[cfg(not(windows))]
        assert!(!p.is_empty());
    }

    #[test]
    fn resolve_dcim_from_drive() {
        let p = resolve_drive_dcim_path("E:");
        #[cfg(windows)]
        assert_eq!(p, "E:\\DCIM");
        #[cfg(not(windows))]
        assert!(p.ends_with("DCIM"));
    }

    #[test]
    fn timelapse_path_detection() {
        let photo = "E:\\DCIM\\DJI_001\\TIMELAPSE\\IMG_001.JPG";
        assert!(is_timelapse_photo_path(photo));
        assert!(is_under_dji_timelapse_tree(photo));
        let video = "E:\\DCIM\\DJI_001\\TIMELAPSE\\VID_001.MP4";
        assert!(!is_timelapse_photo_path(video));
        assert!(is_under_dji_timelapse_tree(video));
    }

    #[test]
    fn filter_skips_videos_when_timelapse_session() {
        let paths = vec![
            "E:\\DCIM\\DJI_001\\TIMELAPSE\\IMG_001.JPG".into(),
            "E:\\DCIM\\DJI_001\\movie.MP4".into(),
            "E:\\DCIM\\DJI_001\\photo.JPG".into(),
        ];
        let (kept, skipped) =
            filter_media_paths_for_backup(&paths, "E:\\DCIM", true);
        assert_eq!(skipped, 1);
        assert_eq!(kept.len(), 2);
        assert!(kept.iter().all(|p| !p.to_ascii_lowercase().ends_with(".mp4")));
    }

    #[test]
    fn media_type_from_name() {
        assert_eq!(media_type_from_filename("a.MP4"), "video");
        assert_eq!(media_type_from_filename("b.JPG"), "photo");
    }

    #[test]
    fn unique_names_avoid_collision() {
        let mut used = HashSet::new();
        let a = unique_dest_name("clip.mp4", &mut used);
        let b = unique_dest_name("clip.mp4", &mut used);
        assert_eq!(a, "clip.mp4");
        assert_eq!(b, "clip_1.mp4");
    }

    #[test]
    fn expand_import_paths_walks_folder() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("sub");
        fs::create_dir_all(&nested).unwrap();
        fs::write(dir.path().join("a.mp4"), b"x").unwrap();
        fs::write(nested.join("b.jpg"), b"y").unwrap();
        fs::write(nested.join("readme.txt"), b"z").unwrap();

        let paths = expand_import_paths(&[dir.path().to_string_lossy().into_owned()]);
        assert_eq!(paths.len(), 2);
        assert!(paths.iter().any(|p| p.ends_with("a.mp4")));
        assert!(paths.iter().any(|p| p.ends_with("b.jpg")));
    }

    #[test]
    fn timelapse_filename_regex() {
        assert!(is_timelapse_photo_filename("Foto_20240101120000000.JPG"));
        assert!(is_timelapse_photo_filename("Foto_20240101120000000_001.jpg"));
        assert!(!is_timelapse_photo_filename("DJI_0001.JPG"));
    }
}
