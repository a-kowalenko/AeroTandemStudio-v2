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

/// Camera proxies / companions: never import or list as media; delete with the master on SD clear.
pub const SIDECAR_EXTENSIONS: &[&str] = &[".lrv", ".lrf", ".thm", ".wav"];

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

pub fn is_sidecar_ext(ext: &str) -> bool {
    let e = if ext.starts_with('.') {
        ext.to_ascii_lowercase()
    } else {
        format!(".{}", ext.to_ascii_lowercase())
    };
    SIDECAR_EXTENSIONS.contains(&e.as_str())
}

/// GoPro full-res stems `GX…` / `GH…` map to low-res proxy stem `GL…`.
fn gopro_proxy_stem(stem: &str) -> Option<String> {
    let s = stem.to_ascii_lowercase();
    let b = s.as_bytes();
    if b.len() >= 3 && b[0] == b'g' && (b[1] == b'x' || b[1] == b'h') {
        Some(format!("gl{}", &s[2..]))
    } else {
        None
    }
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

/// macOS AppleDouble / Finder junk that still has a media-looking extension
/// (e.g. `._DJI_0123.JPG` on FAT/exFAT SD cards after Finder copy).
pub fn is_ignored_media_filename(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return true;
    }
    // AppleDouble resource-fork sidecar, or any other dotted/hidden name.
    name.starts_with('.')
}

fn should_include_media_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if is_ignored_media_filename(name) {
        return false;
    }
    // Proxies / companions must never appear in list / backup / import.
    let ext = ext_of(path);
    if is_sidecar_ext(&ext) {
        return false;
    }
    is_media_ext(&ext)
}

/// Public filter for staged MTP/ICA paths and any external file lists.
pub fn is_listable_media_path(path: &Path) -> bool {
    should_include_media_path(path)
}

pub fn filter_listable_media_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| is_listable_media_path(Path::new(p)))
        .collect()
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

/// Parsed DJI Foto-Timelapse context for backup skip + SD clear.
#[derive(Debug, Clone, Default)]
pub struct TimelapseFilterContext {
    /// Session suffix from `TIMELAPSE/001_NNNN/` folders (e.g. `"0006"`).
    pub session_ids: HashSet<String>,
    /// Legacy layout: timelapse photos directly under `DJI_*/TIMELAPSE/` without `001_NNNN`.
    pub legacy_dji_folders: HashSet<String>,
}

impl TimelapseFilterContext {
    pub fn is_active(&self) -> bool {
        !self.session_ids.is_empty() || !self.legacy_dji_folders.is_empty()
    }
}

/// Result of [`filter_media_paths_for_backup`].
#[derive(Debug, Clone, Default)]
pub struct BackupMediaFilterResult {
    pub kept: Vec<String>,
    pub skipped_timelapse_videos: Vec<String>,
}

impl BackupMediaFilterResult {
    pub fn skipped_count(&self) -> usize {
        self.skipped_timelapse_videos.len()
    }
}

/// Session suffix from a timelapse folder name (`001_0006` → `0006`).
pub fn timelapse_session_id_from_folder(folder: &str) -> Option<String> {
    static RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"(?i)^\d+_(\d+)$").unwrap()
    });
    RE.captures(folder.trim())
        .map(|caps| caps[1].to_string())
}

/// Session suffix from a DJI master video basename (`DJI_20260827_0006.MP4` → `0006`).
/// Osmo Action timelapse companions may end with `_D` (`…_0006_D.MP4`).
pub fn dji_video_session_suffix(filename: &str) -> Option<String> {
    static RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"(?i)^DJI_.*_(\d+)(?:_D)?$").unwrap()
    });
    let base = Path::new(filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(filename);
    let stem = Path::new(base)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(base);
    RE.captures(stem).map(|caps| caps[1].to_string())
}

fn timelapse_session_id_from_photo_path(file_path: &str) -> Option<String> {
    if !is_timelapse_photo_path(file_path) {
        return None;
    }
    let parent = Path::new(file_path).parent()?;
    let folder = parent.file_name()?.to_str()?;
    if folder.eq_ignore_ascii_case("timelapse") {
        return None;
    }
    timelapse_session_id_from_folder(folder)
}

fn legacy_dji_folder_for_timelapse_photo(file_path: &str) -> Option<String> {
    if !is_timelapse_photo_path(file_path) || timelapse_session_id_from_photo_path(file_path).is_some()
    {
        return None;
    }
    let parts = path_parts(file_path);
    let dcim_idx = dcim_index(&parts)?;
    for part in parts.iter().skip(dcim_idx + 1) {
        let lower = part.to_ascii_lowercase();
        if lower.starts_with("dji_") {
            return Some(lower);
        }
    }
    None
}

fn direct_dji_folder_name(file_path: &str) -> Option<String> {
    let parts = path_parts(file_path);
    let dcim_idx = dcim_index(&parts)?;
    if parts.len() < dcim_idx + 3 {
        return None;
    }
    let parent = parts.get(parts.len() - 2)?;
    let lower = parent.to_ascii_lowercase();
    if lower.starts_with("dji_") {
        Some(lower)
    } else {
        None
    }
}

fn timelapse_folder_has_photos(folder: &Path) -> bool {
    let Ok(entries) = fs::read_dir(folder) else {
        return false;
    };
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
            && is_photo_ext(&ext_of(&entry.path()))
        {
            return true;
        }
    }
    false
}

/// Collect timelapse session suffixes from photo paths and optionally `DCIM/TIMELAPSE/*/`.
pub fn build_timelapse_filter_context(
    dcim_root: &str,
    media_paths: &[String],
) -> TimelapseFilterContext {
    let mut ctx = TimelapseFilterContext::default();
    for path in media_paths {
        if let Some(id) = timelapse_session_id_from_photo_path(path) {
            ctx.session_ids.insert(id);
        }
        if let Some(dji) = legacy_dji_folder_for_timelapse_photo(path) {
            ctx.legacy_dji_folders.insert(dji);
        }
    }

    let Some(dcim) = resolve_dcim_root(dcim_root) else {
        return ctx;
    };
    let timelapse_root = PathBuf::from(&dcim).join("TIMELAPSE");
    if !timelapse_root.is_dir() {
        return ctx;
    }
    let Ok(entries) = fs::read_dir(&timelapse_root) else {
        return ctx;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name_owned = entry.file_name();
        let Some(name) = name_owned.to_str() else {
            continue;
        };
        if !timelapse_folder_has_photos(&entry.path()) {
            continue;
        }
        if let Some(id) = timelapse_session_id_from_folder(name) {
            ctx.session_ids.insert(id);
        }
    }
    ctx
}

pub fn is_timelapse_companion_video(file_path: &str, ctx: &TimelapseFilterContext) -> bool {
    if ctx.session_ids.is_empty() {
        return false;
    }
    if !is_video_ext(&ext_of(Path::new(file_path))) {
        return false;
    }
    let Some(dji_folder) = direct_dji_folder_name(file_path) else {
        return false;
    };
    if !dji_folder.starts_with("dji_") {
        return false;
    }
    let name = Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_path);
    let Some(suffix) = dji_video_session_suffix(name) else {
        return false;
    };
    ctx.session_ids.contains(&suffix)
}

pub fn should_skip_file_for_timelapse_session(
    file_path: &str,
    is_video: bool,
    ctx: &TimelapseFilterContext,
    exclude_timelapse_videos: bool,
) -> bool {
    if !exclude_timelapse_videos || !is_video {
        return false;
    }
    if is_under_dji_timelapse_tree(file_path) {
        return true;
    }
    if is_timelapse_companion_video(file_path, ctx) {
        return true;
    }
    if let Some(dji_folder) = direct_dji_folder_name(file_path) {
        return ctx.legacy_dji_folders.contains(&dji_folder);
    }
    false
}

/// Merge backed-up masters with skipped timelapse companion videos for SD/MTP clear.
pub fn paths_for_sd_clear(copied_sources: &[String], skipped_timelapse_videos: &[String]) -> Vec<String> {
    let mut out = copied_sources.to_vec();
    out.extend_from_slice(skipped_timelapse_videos);
    out
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

/// Filter media paths for SD backup/import.
pub fn filter_media_paths_for_backup(
    media_paths: &[String],
    dcim_root: &str,
    exclude_timelapse_videos: bool,
) -> BackupMediaFilterResult {
    if !exclude_timelapse_videos {
        return BackupMediaFilterResult {
            kept: media_paths.to_vec(),
            skipped_timelapse_videos: Vec::new(),
        };
    }
    let ctx = build_timelapse_filter_context(dcim_root, media_paths);
    let mut kept = Vec::new();
    let mut skipped_timelapse_videos = Vec::new();
    for path in media_paths {
        let is_video = is_video_ext(&ext_of(Path::new(path)));
        if should_skip_file_for_timelapse_session(path, is_video, &ctx, true) {
            if is_video {
                skipped_timelapse_videos.push(path.clone());
            }
            continue;
        }
        kept.push(path.clone());
    }
    BackupMediaFilterResult {
        kept,
        skipped_timelapse_videos,
    }
}

pub fn collect_media_paths_from_tree(scan_root: &Path) -> Vec<String> {
    if !scan_root.is_dir() {
        return Vec::new();
    }
    let mut found = Vec::new();
    let walker = walkdir_simple(scan_root);
    for path in walker {
        if should_include_media_path(&path) {
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
            if !should_include_media_path(&path) {
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
            // Prefer DirEntry::file_type — avoids an extra stat per path on many FS.
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                out.push(path);
            }
        }
    }
    out
}

/// Unique camera basenames for MTP clear (masters only). Sidecars/proxies are
/// matched on the camera by stem (`GX…` → `GL…`) so we do not send thousands of
/// candidate names over the Image Capture FFI.
pub fn camera_clear_basenames(backed_up_paths: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for path in backed_up_paths {
        let Some(fname) = Path::new(path).file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let key = fname.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(fname.to_string());
        }
    }
    out
}

/// Candidate basenames to delete on a camera (MTP / Image Capture).
///
/// Unlike [`expand_files_for_sd_clear`], this does not scan a directory — it emits
/// the master names plus likely sidecar names (same stem + GoPro `GL…` proxies).
/// The camera layer deletes whatever exists (case-insensitive match).
pub fn expand_basenames_for_camera_clear(backed_up_paths: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();

    let mut push = |name: String| {
        if name.is_empty() {
            return;
        }
        let key = name.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(name);
        }
    };

    for path in backed_up_paths {
        let pb = Path::new(path);
        let Some(fname) = pb.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        push(fname.to_string());

        let stem = pb
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if stem.is_empty() {
            continue;
        }

        for &ext in SIDECAR_EXTENSIONS {
            push(format!("{stem}{ext}"));
            // Cameras often use uppercase extensions (`.LRV` / `.THM`).
            push(format!("{stem}{}", ext.to_ascii_uppercase()));
        }

        if let Some(proxy_lower) = gopro_proxy_stem(&stem) {
            // Prefer GoPro-style `GL` + original digit suffix casing.
            let proxy = if stem.len() >= 2 {
                format!("GL{}", &stem[2..])
            } else {
                proxy_lower.to_ascii_uppercase()
            };
            for &ext in SIDECAR_EXTENSIONS {
                push(format!("{proxy}{ext}"));
                push(format!("{proxy}{}", ext.to_ascii_uppercase()));
            }
        }
    }

    out
}

/// Expand delete list with sidecar files (same stem, non-media extension).
/// Also pairs GoPro `GX…`/`GH…` masters with `GL….LRV` proxies in the same folder.
pub fn expand_files_for_sd_clear(backed_up_paths: &[String]) -> Vec<String> {
    let media: HashSet<String> = MEDIA_EXTENSIONS.iter().map(|e| e.to_string()).collect();
    let mut to_delete: HashMap<String, String> = HashMap::new();
    // Exact stems: any non-media companion (`.lrv`, `.thm`, `.wav`, …).
    let mut exact_stems_by_dir: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    // GoPro proxy stems: only sidecar extensions (never another master video).
    let mut proxy_stems_by_dir: HashMap<PathBuf, HashSet<String>> = HashMap::new();

    for path in backed_up_paths {
        if path.is_empty() {
            continue;
        }
        let pb = PathBuf::from(path);
        let key = normalize_key(path);
        to_delete.insert(key, path.clone());
        if let (Some(dir), Some(stem)) = (
            pb.parent().map(|p| p.to_path_buf()),
            pb.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase()),
        ) {
            exact_stems_by_dir
                .entry(dir.clone())
                .or_default()
                .insert(stem.clone());
            if let Some(proxy) = gopro_proxy_stem(&stem) {
                proxy_stems_by_dir
                    .entry(dir.clone())
                    .or_default()
                    .insert(proxy);
            }
            // macOS AppleDouble companion next to the media file (`._` + filename).
            if let Some(name) = pb.file_name().and_then(|n| n.to_str()) {
                if !name.starts_with("._") {
                    let apple = dir.join(format!("._{name}"));
                    if apple.is_file() {
                        let full_s = apple.to_string_lossy().into_owned();
                        to_delete.insert(normalize_key(&full_s), full_s);
                    }
                }
            }
        }
    }

    let dirs: HashSet<PathBuf> = exact_stems_by_dir
        .keys()
        .chain(proxy_stems_by_dir.keys())
        .cloned()
        .collect();

    for directory in dirs {
        let exact = exact_stems_by_dir.get(&directory);
        let proxy = proxy_stems_by_dir.get(&directory);
        let names = match fs::read_dir(&directory) {
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
            let ext = ext_of(&full);
            let via_exact = exact.is_some_and(|s| s.contains(&stem)) && !media.contains(&ext);
            let via_proxy = proxy.is_some_and(|s| s.contains(&stem)) && is_sidecar_ext(&ext);
            if via_exact || via_proxy {
                to_delete.insert(key, full_s);
            }
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

/// Chronological photo filename pattern (`Foto_yyyyMMddHHmmssSSS[_seq].ext`).
/// Used for DJI timelapse imports and for all photo imports in the working folder.
pub fn is_timelapse_photo_filename(filename: &str) -> bool {
    static RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        // Optional _NNN / _NNNN sequence and optional extra collision suffixes.
        Regex::new(r"(?i)^Foto_\d{17}(?:_\d+)*\.[a-z0-9]+$").unwrap()
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
    fn filter_skips_only_matching_timelapse_companion_videos() {
        let paths = vec![
            "/Volumes/SD_Card/DCIM/TIMELAPSE/001_0006/IMG_001.JPG".into(),
            "/Volumes/SD_Card/DCIM/TIMELAPSE/001_0008/IMG_001.JPG".into(),
            "/Volumes/SD_Card/DCIM/DJI_001/DJI_20260827_0006.MP4".into(),
            "/Volumes/SD_Card/DCIM/DJI_001/DJI_20260827_0007.MP4".into(),
            "/Volumes/SD_Card/DCIM/DJI_001/DJI_20260827_0008.MP4".into(),
        ];
        let result =
            filter_media_paths_for_backup(&paths, "/Volumes/SD_Card/DCIM", true);
        assert_eq!(result.skipped_count(), 2);
        assert_eq!(result.kept.len(), 3);
        assert!(result
            .skipped_timelapse_videos
            .iter()
            .any(|p| p.ends_with("_0006.MP4")));
        assert!(result
            .skipped_timelapse_videos
            .iter()
            .any(|p| p.ends_with("_0008.MP4")));
        assert!(result
            .kept
            .iter()
            .any(|p| p.ends_with("_0007.MP4")));
    }

    #[test]
    fn filter_skips_videos_when_legacy_timelapse_under_dji_folder() {
        let paths = vec![
            "E:\\DCIM\\DJI_001\\TIMELAPSE\\IMG_001.JPG".into(),
            "E:\\DCIM\\DJI_001\\movie.MP4".into(),
            "E:\\DCIM\\DJI_001\\photo.JPG".into(),
        ];
        let result = filter_media_paths_for_backup(&paths, "E:\\DCIM", true);
        assert_eq!(result.skipped_count(), 1);
        assert_eq!(result.kept.len(), 2);
        assert!(result
            .kept
            .iter()
            .all(|p| !p.to_ascii_lowercase().ends_with(".mp4")));
    }

    #[test]
    fn sd_clear_timelapse_companion_includes_lrf_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let mp4 = dir.path().join("DJI_20260827_0006.MP4");
        fs::write(&mp4, b"v").unwrap();
        fs::write(dir.path().join("DJI_20260827_0006.LRF"), b"proxy").unwrap();
        fs::write(dir.path().join("DJI_20260827_0007.LRF"), b"keep").unwrap();

        let expanded = expand_files_for_sd_clear(&[mp4.to_string_lossy().into_owned()]);
        assert!(expanded.iter().any(|p| p.ends_with("DJI_20260827_0006.MP4")));
        assert!(expanded.iter().any(|p| p.ends_with("DJI_20260827_0006.LRF")));
        assert!(!expanded.iter().any(|p| p.ends_with("DJI_20260827_0007.LRF")));
    }

    #[test]
    fn expand_basenames_for_camera_clear_include_dji_lrf() {
        let names = expand_basenames_for_camera_clear(&["/tmp/DJI_20260827_0006.MP4".into()]);
        let lower: Vec<_> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
        assert!(lower.iter().any(|n| n == "dji_20260827_0006.mp4"));
        assert!(lower.iter().any(|n| n == "dji_20260827_0006.lrf"));
    }

    #[test]
    fn timelapse_session_id_parsing() {
        assert_eq!(
            timelapse_session_id_from_folder("001_0006").as_deref(),
            Some("0006")
        );
        assert_eq!(
            dji_video_session_suffix("DJI_20260827_0006.MP4").as_deref(),
            Some("0006")
        );
        assert_eq!(
            dji_video_session_suffix("DJI_20260827143022123_0008.MP4").as_deref(),
            Some("0008")
        );
        assert_eq!(
            dji_video_session_suffix("DJI_20260827004523_0005_D.MP4").as_deref(),
            Some("0005")
        );
        assert_eq!(
            dji_video_session_suffix("DJI_20260827005028_0007_D.MP4").as_deref(),
            Some("0007")
        );
    }

    #[test]
    fn filter_skips_osmo_action_timelapse_d_suffix_companions() {
        let paths = vec![
            "/Volumes/SD_Card/DCIM/TIMELAPSE/001_0005/IMG_001.JPG".into(),
            "/Volumes/SD_Card/DCIM/TIMELAPSE/001_0006/IMG_001.JPG".into(),
            "/Volumes/SD_Card/DCIM/TIMELAPSE/001_0008/IMG_001.JPG".into(),
            "/Volumes/SD_Card/DCIM/DJI_001/DJI_20260827004523_0005_D.MP4".into(),
            "/Volumes/SD_Card/DCIM/DJI_001/DJI_20260827005007_0006_D.MP4".into(),
            "/Volumes/SD_Card/DCIM/DJI_001/DJI_20260827005028_0007_D.MP4".into(),
            "/Volumes/SD_Card/DCIM/DJI_001/DJI_20260827005045_0008_D.MP4".into(),
        ];
        let result =
            filter_media_paths_for_backup(&paths, "/Volumes/SD_Card/DCIM", true);
        assert_eq!(result.skipped_count(), 3);
        assert_eq!(result.kept.len(), 4);
        assert!(result
            .kept
            .iter()
            .any(|p| p.ends_with("_0007_D.MP4")));
        assert!(result
            .skipped_timelapse_videos
            .iter()
            .any(|p| p.ends_with("_0005_D.MP4")));
        assert!(result
            .skipped_timelapse_videos
            .iter()
            .any(|p| p.ends_with("_0006_D.MP4")));
        assert!(result
            .skipped_timelapse_videos
            .iter()
            .any(|p| p.ends_with("_0008_D.MP4")));
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
    fn ignores_macos_appledouble_and_dotfiles() {
        assert!(is_ignored_media_filename("._DJI_0123.JPG"));
        assert!(is_ignored_media_filename(".hidden.jpg"));
        assert!(is_ignored_media_filename(".DS_Store"));
        assert!(!is_ignored_media_filename("DJI_0123.JPG"));
        assert!(!is_ignored_media_filename("clip.mp4"));

        let dir = tempfile::tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("100");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("real.jpg"), b"photo").unwrap();
        fs::write(dcim.join("._real.jpg"), b"appledouble").unwrap();
        fs::write(dcim.join(".hidden.mp4"), b"hidden").unwrap();

        let paths = collect_media_paths_from_tree(&dir.path().join("DCIM"));
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("real.jpg"));
    }

    #[test]
    fn sd_clear_includes_appledouble_companion() {
        let dir = tempfile::tempdir().unwrap();
        let media = dir.path().join("clip.mp4");
        let apple = dir.path().join("._clip.mp4");
        fs::write(&media, b"v").unwrap();
        fs::write(&apple, b"meta").unwrap();

        let expanded = expand_files_for_sd_clear(&[media.to_string_lossy().into_owned()]);
        assert!(expanded.iter().any(|p| p.ends_with("clip.mp4")));
        assert!(expanded.iter().any(|p| p.ends_with("._clip.mp4")));
    }

    #[test]
    fn filter_listable_drops_sidecars() {
        let kept = filter_listable_media_paths(vec![
            "/tmp/GX010001.MP4".into(),
            "/tmp/GL010001.LRV".into(),
            "/tmp/GX010001.THM".into(),
            "/tmp/shot.JPG".into(),
        ]);
        assert_eq!(kept.len(), 2);
        assert!(kept.iter().any(|p| p.ends_with("GX010001.MP4")));
        assert!(kept.iter().any(|p| p.ends_with("shot.JPG")));
    }

    #[test]
    fn sidecars_not_collected_as_media() {
        assert!(is_sidecar_ext(".lrv"));
        assert!(is_sidecar_ext(".lrf"));
        assert!(is_sidecar_ext("THM"));
        assert!(!is_video_ext(".lrv"));
        assert!(!is_media_ext(".lrv"));

        let dir = tempfile::tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("100");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("GX010001.MP4"), b"v").unwrap();
        fs::write(dcim.join("GL010001.LRV"), b"proxy").unwrap();
        fs::write(dcim.join("GX010001.THM"), b"thumb").unwrap();

        let paths = collect_media_paths_from_tree(&dir.path().join("DCIM"));
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("GX010001.MP4"));
    }

    #[test]
    fn sd_clear_deletes_same_stem_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let mp4 = dir.path().join("clip.MP4");
        fs::write(&mp4, b"v").unwrap();
        fs::write(dir.path().join("clip.LRV"), b"proxy").unwrap();
        fs::write(dir.path().join("clip.THM"), b"thumb").unwrap();
        fs::write(dir.path().join("other.LRV"), b"keep").unwrap();

        let expanded = expand_files_for_sd_clear(&[mp4.to_string_lossy().into_owned()]);
        assert!(expanded.iter().any(|p| p.ends_with("clip.MP4")));
        assert!(expanded.iter().any(|p| p.ends_with("clip.LRV")));
        assert!(expanded.iter().any(|p| p.ends_with("clip.THM")));
        assert!(!expanded.iter().any(|p| p.ends_with("other.LRV")));
    }

    #[test]
    fn sd_clear_gopro_gx_pairs_gl_lrv() {
        let dir = tempfile::tempdir().unwrap();
        let mp4 = dir.path().join("GX010001.MP4");
        fs::write(&mp4, b"v").unwrap();
        fs::write(dir.path().join("GL010001.LRV"), b"proxy").unwrap();
        fs::write(dir.path().join("GX010001.THM"), b"thumb").unwrap();
        fs::write(dir.path().join("GL999999.LRV"), b"keep").unwrap();

        let expanded = expand_files_for_sd_clear(&[mp4.to_string_lossy().into_owned()]);
        assert!(expanded.iter().any(|p| p.ends_with("GX010001.MP4")));
        assert!(expanded.iter().any(|p| p.ends_with("GL010001.LRV")));
        assert!(expanded.iter().any(|p| p.ends_with("GX010001.THM")));
        assert!(!expanded.iter().any(|p| p.ends_with("GL999999.LRV")));
    }

    #[test]
    fn sd_clear_gopro_gh_pairs_gl_lrv() {
        let dir = tempfile::tempdir().unwrap();
        let mp4 = dir.path().join("GH010042.MP4");
        fs::write(&mp4, b"v").unwrap();
        fs::write(dir.path().join("GL010042.lrv"), b"proxy").unwrap();

        let expanded = expand_files_for_sd_clear(&[mp4.to_string_lossy().into_owned()]);
        assert!(expanded.iter().any(|p| p.ends_with("GH010042.MP4")));
        assert!(expanded.iter().any(|p| p.ends_with("GL010042.lrv")));
    }

    #[test]
    fn camera_clear_basenames_are_unique_masters() {
        let names = camera_clear_basenames(&[
            "/tmp/GX010001.MP4".into(),
            "/tmp/G0010001.JPG".into(),
            "/virtual/GX010001.MP4".into(),
        ]);
        assert_eq!(names.len(), 2);
        assert!(names.iter().any(|n| n == "GX010001.MP4"));
        assert!(names.iter().any(|n| n == "G0010001.JPG"));
    }

    #[test]
    fn expand_basenames_for_camera_clear_include_gopro_lrv() {
        let names = expand_basenames_for_camera_clear(&["/tmp/GX010001.MP4".into()]);
        let lower: Vec<_> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
        assert!(lower.iter().any(|n| n == "gx010001.mp4"));
        assert!(lower.iter().any(|n| n == "gx010001.thm"));
        assert!(lower.iter().any(|n| n == "gl010001.lrv"));
        assert!(!lower.iter().any(|n| n == "gl999999.lrv"));
    }

    #[test]
    fn gopro_proxy_stem_mapping() {
        assert_eq!(gopro_proxy_stem("GX010001").as_deref(), Some("gl010001"));
        assert_eq!(gopro_proxy_stem("gh010042").as_deref(), Some("gl010042"));
        assert_eq!(gopro_proxy_stem("GOPR1234"), None);
        assert_eq!(gopro_proxy_stem("GL010001"), None);
    }

    #[test]
    fn timelapse_filename_regex() {
        assert!(is_timelapse_photo_filename("Foto_20240101120000000.JPG"));
        assert!(is_timelapse_photo_filename(
            "Foto_20240101120000000_001.jpg"
        ));
        assert!(is_timelapse_photo_filename(
            "Foto_20240101120000000_0001.JPG"
        ));
        assert!(is_timelapse_photo_filename("Foto_20240101120000000.PNG"));
        assert!(!is_timelapse_photo_filename("DJI_0001.JPG"));
    }
}
