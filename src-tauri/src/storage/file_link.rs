//! Same-volume hardlink imports and materialization before in-place media edits (OPT-3).
//!
//! When source and working dir share a volume, imports use `hard_link` instead of a full
//! copy. Before trim/cut/split/rotate overwrite, hardlinks are broken into independent files
//! so originals outside the working folder stay untouched.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::sd_card::copy_progress::copy_file_with_progress;
use crate::storage::logging::{self, file_name};

static HARDLINK_REGISTRY: Lazy<Mutex<HashSet<String>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportLinkMethod {
    HardLink,
    Copy,
}

fn norm_path_key(path: &Path) -> String {
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

/// True when `a` and `b` reside on the same filesystem / volume.
pub fn paths_on_same_volume(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (a.metadata(), b.metadata()) {
            (Ok(ma), Ok(mb)) => ma.dev() == mb.dev(),
            _ => false,
        }
    }
    #[cfg(windows)]
    {
        windows_volume_prefix(a) == windows_volume_prefix(b)
    }
}

#[cfg(windows)]
fn windows_volume_prefix(path: &Path) -> String {
    let s = path.to_string_lossy();
    let bytes = s.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
        return s[..3].to_ascii_lowercase();
    }
    if s.starts_with(r"\\") {
        let parts: Vec<&str> = s.split('\\').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 2 {
            return format!(r"\\{}\{}", parts[0], parts[1]).to_lowercase();
        }
    }
    s.to_lowercase()
}

#[cfg(unix)]
pub fn hardlink_count(path: &Path) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(path.metadata()?.nlink())
}

pub fn mark_hardlinked(path: &Path) {
    if let Ok(mut guard) = HARDLINK_REGISTRY.lock() {
        guard.insert(norm_path_key(path));
    }
}

pub fn unmark_hardlinked(path: &Path) {
    if let Ok(mut guard) = HARDLINK_REGISTRY.lock() {
        guard.remove(&norm_path_key(path));
    }
}

pub fn clear_hardlink_registry() {
    if let Ok(mut guard) = HARDLINK_REGISTRY.lock() {
        guard.clear();
    }
}

/// Whether `path` is a session hardlink import (registry on all platforms; `nlink` on Unix).
pub fn is_hardlinked(path: &Path) -> bool {
    #[cfg(unix)]
    {
        if hardlink_count(path).map(|n| n > 1).unwrap_or(false) {
            return true;
        }
    }
    HARDLINK_REGISTRY
        .lock()
        .map(|guard| guard.contains(&norm_path_key(path)))
        .unwrap_or(false)
}

fn temp_materialize_path(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("media");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    path.with_file_name(format!("{stem}.__materialize__{ext}"))
}

/// Import `src` → `dest`: hardlink when same volume, else chunked copy.
pub fn import_copy_or_hardlink<F>(
    src: &Path,
    dest: &Path,
    on_chunk: &mut F,
) -> io::Result<ImportLinkMethod>
where
    F: FnMut(u64),
{
    if paths_on_same_volume(src, dest) {
        match fs::hard_link(src, dest) {
            Ok(()) => {
                mark_hardlinked(dest);
                let size = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
                if size > 0 {
                    on_chunk(size);
                }
                logging::info(
                    "import",
                    format!(
                        "Hardlink: {} → {}",
                        file_name(src),
                        file_name(dest)
                    ),
                );
                return Ok(ImportLinkMethod::HardLink);
            }
            Err(e) => {
                logging::info(
                    "import",
                    format!(
                        "Hardlink nicht möglich ({} → {}): {e}; Kopie…",
                        file_name(src),
                        file_name(dest)
                    ),
                );
            }
        }
    }
    copy_file_with_progress(src, dest, |delta| on_chunk(delta))?;
    Ok(ImportLinkMethod::Copy)
}

/// Break a hardlink into an independent file before in-place edit. Returns `true` when copied.
pub fn materialize_hardlink(path: &Path) -> io::Result<bool> {
    if !is_hardlinked(path) {
        return Ok(false);
    }
    let temp = temp_materialize_path(path);
    if temp.exists() {
        let _ = fs::remove_file(&temp);
    }
    copy_file_with_progress(path, &temp, |_| {})?;
    fs::remove_file(path)?;
    fs::rename(&temp, path)?;
    unmark_hardlinked(path);
    logging::info(
        "import",
        format!("Hardlink materialisiert: {}", file_name(path)),
    );
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_copy_buffer_is_two_mib() {
        assert_eq!(
            crate::sd_card::copy_progress::DEFAULT_COPY_BUFFER,
            2 * 1024 * 1024
        );
    }

    #[test]
    fn same_volume_detects_shared_tempdir() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.bin");
        let b = dir.path().join("sub").join("b.bin");
        fs::create_dir_all(b.parent().unwrap()).unwrap();
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        assert!(paths_on_same_volume(&a, &b));
    }

    #[cfg(unix)]
    #[test]
    fn hardlink_import_then_materialize_isolates_original() {
        clear_hardlink_registry();
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("orig.mp4");
        let dest = dir.path().join("work.mp4");
        fs::write(&src, b"original-bytes").unwrap();

        let mut reported = 0u64;
        let method = import_copy_or_hardlink(&src, &dest, &mut |delta| {
            reported += delta;
        })
        .unwrap();
        assert_eq!(method, ImportLinkMethod::HardLink);
        assert_eq!(reported, b"original-bytes".len() as u64);
        assert!(is_hardlinked(&dest));

        materialize_hardlink(&dest).unwrap();
        assert!(!is_hardlinked(&dest));

        fs::write(&dest, b"edited").unwrap();
        assert_eq!(fs::read(&src).unwrap(), b"original-bytes");
        assert_eq!(fs::read(&dest).unwrap(), b"edited");

        clear_hardlink_registry();
    }

    #[test]
    fn different_volume_heuristic_does_not_match_other_drive() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.bin");
        fs::write(&a, b"a").unwrap();

        #[cfg(windows)]
        let other = PathBuf::from("Z:\\other");
        #[cfg(not(windows))]
        let other = PathBuf::from("/other");

        assert!(!paths_on_same_volume(&a, &other));
    }

    #[test]
    fn registry_tracks_hardlinked_dest() {
        clear_hardlink_registry();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("linked.mp4");
        fs::write(&path, b"x").unwrap();
        assert!(!is_hardlinked(&path));
        mark_hardlinked(&path);
        assert!(is_hardlinked(&path));
        unmark_hardlinked(&path);
        assert!(!is_hardlinked(&path));
    }
}
