//! Temp-/Preview-/Arbeitsordner aufräumen (Port von Legacy `cache_cleanup.py`).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::storage::app_config_dir;
use crate::storage::working_session;
use crate::video::hw_accel::clear_hw_cache;

pub const PREVIEW_DIR_PREFIX: &str = "aero_studio_preview_";
/// QR hit-frame previews from Phase 17 (`qr/analyser.rs`).
pub const QR_PREVIEW_DIR_PREFIX: &str = "aero_studio_qr_preview_";
/// Concat work dirs from `video/concat.rs` (`make_work_dir("concat"|"concat_re")`).
pub const ATS_CONCAT_DIR_PREFIX: &str = "ats_concat_";
pub const AEROTANDEM_WORK_DIRNAME: &str = ".aerotandem_work";
pub const ATS_WORK_DIR_PREFIX: &str = ".ats_work_";
pub const HW_CACHE_FILE_NAME: &str = "hw_cache.json";

/// Cutter leftovers next to clip files (overwrite cut/split).
pub const TEMP_CUT_MARKER: &str = ".__temp_cut__.";
pub const TEMP_PART1_MARKER: &str = ".__temp_part1__.";

pub const KNOWN_TEMP_FILES: &[&str] = &[
    "preview_combined_fast.mp4",
    "preview_combined_encoded.mp4",
    "preview_combined.mp4",
    "preview_concat_list.txt",
];

#[derive(Debug, Clone, Default, Serialize)]
pub struct CacheCleanupResult {
    pub deleted_dirs: Vec<String>,
    pub deleted_files: Vec<String>,
    pub errors: Vec<String>,
    pub bytes_freed: u64,
    pub summary: String,
}

impl CacheCleanupResult {
    pub fn finish(mut self) -> Self {
        self.summary = self.summary_message();
        self
    }

    pub fn summary_message(&self) -> String {
        let size = format_bytes(self.bytes_freed);
        let mut lines = vec![format!(
            "{} Ordner und {} Dateien gelöscht ({}).",
            self.deleted_dirs.len(),
            self.deleted_files.len(),
            size
        )];
        if !self.errors.is_empty() {
            lines.push(format!(
                "{} Element(e) konnten nicht gelöscht werden.",
                self.errors.len()
            ));
        }
        lines.join("\n")
    }
}

/// Human-readable byte size (same thresholds as legacy).
pub fn format_bytes(num_bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let n = num_bytes as f64;
    if n < KB {
        format!("{num_bytes} B")
    } else if n < MB {
        format!("{:.1} KB", n / KB)
    } else if n < GB {
        format!("{:.1} MB", n / MB)
    } else {
        format!("{:.2} GB", n / GB)
    }
}

/// Collect unique base directories from speicherort + import paths (files → parent).
pub fn collect_work_base_paths(
    speicherort: Option<&str>,
    import_paths: Option<&[String]>,
) -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut add_base = |path: Option<&str>| {
        let Some(raw) = path.filter(|p| !p.trim().is_empty()) else {
            return;
        };
        let mut path = PathBuf::from(raw);
        if let Ok(canon) = fs::canonicalize(&path) {
            path = canon;
        }
        if path.is_file() {
            if let Some(parent) = path.parent() {
                path = parent.to_path_buf();
            }
        }
        if !path.is_dir() {
            return;
        }
        let key = normalize_key(&path);
        if seen.insert(key) {
            bases.push(path);
        }
    };

    add_base(speicherort);
    if let Some(paths) = import_paths {
        for item in paths {
            add_base(Some(item.as_str()));
        }
    }
    bases
}

fn normalize_key(path: &Path) -> String {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let s = resolved.to_string_lossy();
    #[cfg(windows)]
    {
        // `canonicalize` may prefix `\\?\`; strip for stable compare with short/long paths.
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
        s.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s.into_owned()
    }
}

/// Delete orphaned preview / concat / temp work dirs and known temp files (startup-safe).
pub fn cleanup_orphans_only(exclude_temp_dir: Option<&Path>) -> CacheCleanupResult {
    let mut result = CacheCleanupResult::default();
    delete_orphan_temp_dirs(&mut result, exclude_temp_dir);
    delete_known_temp_files(&mut result);
    result.finish()
}

/// Full cleanup: orphans + optional work dirs + cut leftovers + optional hw cache.
pub fn cleanup_all(
    exclude_temp_dir: Option<&Path>,
    base_paths_for_work: Option<&[PathBuf]>,
    include_hw_cache: bool,
) -> CacheCleanupResult {
    let mut result = CacheCleanupResult::default();
    delete_orphan_temp_dirs(&mut result, exclude_temp_dir);
    delete_known_temp_files(&mut result);
    if let Some(bases) = base_paths_for_work {
        delete_work_dirs(&mut result, bases);
        delete_cut_temp_siblings(&mut result, bases);
    }
    // Always sweep cut leftovers inside the active working folder (if kept via exclude).
    if let Some(work) = exclude_temp_dir {
        delete_cut_temp_siblings(&mut result, &[work.to_path_buf()]);
    } else if let Some(work) = working_session::get_working_dir() {
        delete_cut_temp_siblings(&mut result, &[work]);
    }
    if include_hw_cache {
        delete_hw_cache(&mut result);
        clear_hw_cache();
    }
    result.finish()
}

/// App exit / window close: drop session working folder, then orphan sweep (no excludes).
pub fn cleanup_on_app_exit() -> CacheCleanupResult {
    working_session::clear_working_session();
    cleanup_orphans_only(None)
}

/// True when a `%TEMP%` directory name is an ATS orphan candidate.
pub fn is_orphan_temp_dir_name(name: &str) -> bool {
    name.starts_with(PREVIEW_DIR_PREFIX)
        || name.starts_with(QR_PREVIEW_DIR_PREFIX)
        || name.starts_with(ATS_CONCAT_DIR_PREFIX)
        || name.starts_with(ATS_WORK_DIR_PREFIX)
}

/// True when a file name is a cutter temp sibling.
pub fn is_cut_temp_sibling_name(name: &str) -> bool {
    name.contains(TEMP_CUT_MARKER) || name.contains(TEMP_PART1_MARKER)
}

fn delete_orphan_temp_dirs(result: &mut CacheCleanupResult, exclude: Option<&Path>) {
    let temp_root = std::env::temp_dir();
    let exclude_norm = exclude.map(|p| normalize_key(p));

    let Ok(entries) = fs::read_dir(&temp_root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_orphan_temp_dir_name(name) {
            continue;
        }
        if exclude_norm
            .as_ref()
            .is_some_and(|ex| normalize_key(&path) == *ex)
        {
            continue;
        }
        rmtree(&path, result);
    }
}

fn delete_known_temp_files(result: &mut CacheCleanupResult) {
    let temp_root = std::env::temp_dir();
    for name in KNOWN_TEMP_FILES {
        remove_file(&temp_root.join(name), result);
    }
}

fn delete_work_dirs(result: &mut CacheCleanupResult, base_paths: &[PathBuf]) {
    let mut work_dirs: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for base in base_paths {
        let base = if base.is_file() {
            base.parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| base.clone())
        } else {
            base.clone()
        };

        let legacy = base.join(AEROTANDEM_WORK_DIRNAME);
        let key = normalize_key(&legacy);
        if seen.insert(key) {
            work_dirs.push(legacy);
        }

        // v2 processor work dirs: `.ats_work_<stamp>` next to output
        if let Ok(entries) = fs::read_dir(&base) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if name.starts_with(ATS_WORK_DIR_PREFIX) {
                    let key = normalize_key(&path);
                    if seen.insert(key) {
                        work_dirs.push(path);
                    }
                }
            }
        }
    }

    for work_dir in work_dirs {
        if work_dir.is_dir() {
            rmtree(&work_dir, result);
        }
    }
}

/// Remove aborted cut/split temp files (`name.__temp_cut__.ext`) under base dirs
/// (non-recursive for flat working folders; recursive one level into `photos/`).
fn delete_cut_temp_siblings(result: &mut CacheCleanupResult, base_paths: &[PathBuf]) {
    let mut seen = std::collections::HashSet::new();
    for base in base_paths {
        let base = if base.is_file() {
            base.parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| base.clone())
        } else {
            base.clone()
        };
        if !base.is_dir() {
            continue;
        }
        let key = normalize_key(&base);
        if !seen.insert(key) {
            continue;
        }
        delete_cut_temps_in_dir(result, &base);
        // Working-session photos live in `{temp}/photos/`
        let photos = base.join("photos");
        if photos.is_dir() {
            delete_cut_temps_in_dir(result, &photos);
        }
    }
}

fn delete_cut_temps_in_dir(result: &mut CacheCleanupResult, dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if is_cut_temp_sibling_name(name) {
            remove_file(&path, result);
        }
    }
}

fn delete_hw_cache(result: &mut CacheCleanupResult) {
    if let Ok(dir) = app_config_dir() {
        remove_file(&dir.join(HW_CACHE_FILE_NAME), result);
    }
}

fn rmtree(path: &Path, result: &mut CacheCleanupResult) {
    if !path.exists() {
        return;
    }
    let size = path_size(path);
    match fs::remove_dir_all(path) {
        Ok(()) => {
            result.deleted_dirs.push(path.to_string_lossy().into_owned());
            result.bytes_freed = result.bytes_freed.saturating_add(size);
        }
        Err(e) => {
            result
                .errors
                .push(format!("{}: {e}", path.to_string_lossy()));
        }
    }
}

fn remove_file(path: &Path, result: &mut CacheCleanupResult) {
    if !path.is_file() {
        return;
    }
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    match fs::remove_file(path) {
        Ok(()) => {
            result.deleted_files.push(path.to_string_lossy().into_owned());
            result.bytes_freed = result.bytes_freed.saturating_add(size);
        }
        Err(e) => {
            result
                .errors
                .push(format!("{}: {e}", path.to_string_lossy()));
        }
    }
}

fn path_size(path: &Path) -> u64 {
    if path.is_file() {
        return fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    let mut total = 0u64;
    let walker = walkdir_files(path);
    for file in walker {
        if let Ok(meta) = fs::metadata(&file) {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

fn walkdir_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
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

/// Pure helpers for tests — which relative names count as cleanup targets.
#[cfg(test)]
pub fn is_preview_dir_name(name: &str) -> bool {
    name.starts_with(PREVIEW_DIR_PREFIX)
}

#[cfg(test)]
pub fn is_ats_work_dir_name(name: &str) -> bool {
    name.starts_with(ATS_WORK_DIR_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialize tests that sweep global `%TEMP%` orphan dirs (incl. via `cleanup_all`).
    static TEMP_SWEEP_LOCK: Mutex<()> = Mutex::new(());

    fn temp_sweep_lock() -> std::sync::MutexGuard<'static, ()> {
        TEMP_SWEEP_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn format_bytes_thresholds() {
        assert_eq!(format_bytes(500), "500 B");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_bytes(3 * 1024 * 1024), "3.0 MB");
        assert_eq!(format_bytes(2 * 1024 * 1024 * 1024), "2.00 GB");
    }

    #[test]
    fn preview_dir_prefix_detection() {
        assert!(is_preview_dir_name("aero_studio_preview_123"));
        assert!(!is_preview_dir_name("other_preview_123"));
        assert!(is_ats_work_dir_name(".ats_work_99"));
        assert!(!is_ats_work_dir_name(".ats_other"));
        assert!(is_orphan_temp_dir_name("aero_studio_preview_1"));
        assert!(is_orphan_temp_dir_name("aero_studio_qr_preview_9_1"));
        assert!(!is_orphan_temp_dir_name("other_temp"));
        assert!(is_orphan_temp_dir_name("ats_concat_1234_99"));
        assert!(is_orphan_temp_dir_name("ats_concat_re_1234_99"));
        assert!(is_orphan_temp_dir_name(".ats_work_123"));
        assert!(!is_orphan_temp_dir_name("ats_cache_test_bases_1"));
        assert!(!is_orphan_temp_dir_name("unrelated"));
        assert!(is_cut_temp_sibling_name("DJI.__temp_cut__.mp4"));
        assert!(is_cut_temp_sibling_name("clip.__temp_part1__.mov"));
        assert!(!is_cut_temp_sibling_name("clip.mp4"));
    }

    #[test]
    fn collect_work_base_paths_dedupes_and_skips_missing() {
        let tmp = std::env::temp_dir().join(format!(
            "ats_cache_test_bases_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let nested = tmp.join("clip.mp4");
        fs::write(&nested, b"x").unwrap();

        let paths = collect_work_base_paths(
            Some(tmp.to_str().unwrap()),
            Some(&[nested.to_string_lossy().into_owned(), tmp.to_string_lossy().into_owned()]),
        );
        assert_eq!(paths.len(), 1);
        assert!(
            paths[0].is_dir(),
            "expected existing base dir, got {:?}",
            paths[0]
        );
        let expected = fs::canonicalize(&tmp).unwrap();
        let got = fs::canonicalize(&paths[0]).unwrap();
        assert_eq!(got, expected);

        let empty = collect_work_base_paths(Some(""), Some(&["C:/does/not/exist/at/all".into()]));
        assert!(empty.is_empty());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn summary_message_counts() {
        let result = CacheCleanupResult {
            deleted_dirs: vec!["a".into()],
            deleted_files: vec!["b".into(), "c".into()],
            errors: vec!["e".into()],
            bytes_freed: 1024,
            summary: String::new(),
        };
        let msg = result.summary_message();
        assert!(msg.contains("1 Ordner"));
        assert!(msg.contains("2 Dateien"));
        assert!(msg.contains("1.0 KB"));
        assert!(msg.contains("1 Element"));
    }

    #[test]
    fn orphan_cleanup_respects_exclude_without_touching_unrelated() {
        let _guard = temp_sweep_lock();
        let temp = std::env::temp_dir();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let keep = temp.join(format!(
            "{PREVIEW_DIR_PREFIX}keep_{}_{}",
            std::process::id(),
            stamp
        ));
        let drop_dir = temp.join(format!(
            "{PREVIEW_DIR_PREFIX}drop_{}_{}",
            std::process::id(),
            stamp
        ));
        let _ = fs::remove_dir_all(&keep);
        let _ = fs::remove_dir_all(&drop_dir);
        fs::create_dir_all(&keep).unwrap();
        fs::create_dir_all(&drop_dir).unwrap();
        fs::write(keep.join("marker.txt"), b"keep").unwrap();
        fs::write(drop_dir.join("marker.txt"), b"drop").unwrap();

        let result = cleanup_orphans_only(Some(&keep));
        assert!(keep.is_dir(), "excluded preview dir must remain");
        assert!(!drop_dir.exists(), "non-excluded orphan should be removed");
        assert!(
            result
                .deleted_dirs
                .iter()
                .any(|p| p.contains("drop_")),
            "drop dir should be listed: {:?}",
            result.deleted_dirs
        );

        let _ = fs::remove_dir_all(&keep);
        let _ = fs::remove_dir_all(&drop_dir);
    }

    #[test]
    fn orphan_cleanup_removes_ats_concat_and_work_dirs() {
        let _guard = temp_sweep_lock();
        let temp = std::env::temp_dir();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let concat = temp.join(format!(
            "{ATS_CONCAT_DIR_PREFIX}{}_{}",
            std::process::id(),
            stamp
        ));
        let work = temp.join(format!(
            "{ATS_WORK_DIR_PREFIX}{}_{}",
            std::process::id(),
            stamp
        ));
        let _ = fs::remove_dir_all(&concat);
        let _ = fs::remove_dir_all(&work);
        fs::create_dir_all(&concat).unwrap();
        fs::create_dir_all(&work).unwrap();
        fs::write(concat.join("x.ts"), b"x").unwrap();
        fs::write(work.join("y.mp4"), b"y").unwrap();

        let result = cleanup_orphans_only(None);
        assert!(!concat.exists(), "ats_concat_* should be removed");
        assert!(!work.exists(), ".ats_work_* under TEMP should be removed");
        assert!(
            result
                .deleted_dirs
                .iter()
                .any(|p| p.contains("ats_concat_") || p.contains(".ats_work_")),
            "concat/work dirs should be listed: {:?}",
            result.deleted_dirs
        );

        let _ = fs::remove_dir_all(&concat);
        let _ = fs::remove_dir_all(&work);
    }

    #[test]
    fn cleanup_all_removes_cut_temp_siblings() {
        let _guard = temp_sweep_lock();
        let tmp = std::env::temp_dir().join(format!(
            "ats_cache_cut_siblings_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let keep = tmp.join("keep.mp4");
        let cut = tmp.join("clip.__temp_cut__.mp4");
        let part = tmp.join("clip.__temp_part1__.mp4");
        fs::write(&keep, b"keep").unwrap();
        fs::write(&cut, b"cut").unwrap();
        fs::write(&part, b"part").unwrap();

        let bases = [tmp.clone()];
        let result = cleanup_all(None, Some(&bases), false);
        assert!(keep.is_file());
        assert!(!cut.exists());
        assert!(!part.exists());
        assert!(
            result.deleted_files.iter().any(|p| p.contains("__temp_cut__")),
            "{:?}",
            result.deleted_files
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cleanup_on_app_exit_clears_working_session() {
        let _guard = temp_sweep_lock();
        let src = tempfile::NamedTempFile::new().unwrap();
        let dest = working_session::import_video_to_session(src.path().to_str().unwrap()).unwrap();
        assert!(dest.is_file());
        assert!(working_session::get_working_dir().is_some());

        let _ = cleanup_on_app_exit();
        assert!(working_session::get_working_dir().is_none());
        assert!(!dest.is_file());
    }
}
