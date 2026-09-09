//! Process-local Compatible Dirty TS-Prep segment cache (Phase 43.4).
//!
//! Keyed like OPT-16 probe cache: source path + size + mtime, plus prep
//! parameters (vcodec, has_audio). TTL = app process lifetime; segments live
//! under a dedicated temp root so concat work-dirs can be deleted safely.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use sha1::{Digest, Sha1};

use super::probe_cache::file_identity;

#[derive(Debug, Clone)]
struct CacheEntry {
    size_bytes: u64,
    mtime_secs: u64,
    vcodec: String,
    has_audio: bool,
    segment_path: PathBuf,
}

static PREP_CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache_map() -> &'static Mutex<HashMap<String, CacheEntry>> {
    PREP_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_root() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!(
            "ats_compat_prep_cache_{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    })
    .clone()
}

/// Cache identity string (path|size|mtime|vcodec|audio). Exposed for unit tests.
pub fn prep_cache_key(
    path: &str,
    size: u64,
    mtime: u64,
    vcodec: &str,
    has_audio: bool,
) -> String {
    format!(
        "{path}|{size}|{mtime}|{vcodec}|{}",
        if has_audio { "a1" } else { "a0" }
    )
}

fn segment_filename(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    format!("{:x}.ts", hasher.finalize())
}

/// Lookup a reusable MPEG-TS prep segment. `None` on miss or stale file.
pub fn get(path: &str, vcodec: &str, has_audio: bool) -> Option<PathBuf> {
    let (size, mtime) = file_identity(Path::new(path))?;
    let key = prep_cache_key(path, size, mtime, vcodec, has_audio);
    let guard = cache_map().lock().ok()?;
    let entry = guard.get(&key)?;
    if entry.size_bytes != size
        || entry.mtime_secs != mtime
        || entry.vcodec != vcodec
        || entry.has_audio != has_audio
    {
        return None;
    }
    if !entry.segment_path.is_file() {
        return None;
    }
    Some(entry.segment_path.clone())
}

/// Store `segment_path` under current source identity (copies into cache root).
pub fn put(
    path: &str,
    vcodec: &str,
    has_audio: bool,
    segment_path: &Path,
) -> Option<PathBuf> {
    if !segment_path.is_file() {
        return None;
    }
    let (size, mtime) = file_identity(Path::new(path))?;
    let key = prep_cache_key(path, size, mtime, vcodec, has_audio);
    let dest = cache_root().join(segment_filename(&key));
    if dest != segment_path {
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::copy(segment_path, &dest).ok()?;
    }
    put_entry(
        key,
        CacheEntry {
            size_bytes: size,
            mtime_secs: mtime,
            vcodec: vcodec.to_string(),
            has_audio,
            segment_path: dest.clone(),
        },
    );
    Some(dest)
}

fn put_entry(key: String, entry: CacheEntry) {
    if let Ok(mut guard) = cache_map().lock() {
        if guard.len() >= 256 {
            // Drop map entries; leave orphan files (temp dir cleaned on reboot / process id).
            guard.clear();
        }
        guard.insert(key, entry);
    }
}

/// Drop every entry whose source path matches (any size/mtime).
pub fn invalidate_path(path: &str) {
    let prefix = format!("{path}|");
    if let Ok(mut guard) = cache_map().lock() {
        let stale: Vec<PathBuf> = guard
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(_, e)| e.segment_path.clone())
            .collect();
        guard.retain(|k, _| !k.starts_with(&prefix));
        for p in stale {
            let _ = fs::remove_file(p);
        }
    }
}

/// Clear the entire session cache (tests / session reset).
pub fn clear() {
    if let Ok(mut guard) = cache_map().lock() {
        for entry in guard.values() {
            let _ = fs::remove_file(&entry.segment_path);
        }
        guard.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prep_cache_key_includes_identity_and_params() {
        let a = prep_cache_key("c:/a.mp4", 10, 20, "h264", true);
        let b = prep_cache_key("c:/a.mp4", 10, 20, "h264", true);
        let c = prep_cache_key("c:/a.mp4", 11, 20, "h264", true);
        let d = prep_cache_key("c:/a.mp4", 10, 20, "hevc", true);
        let e = prep_cache_key("c:/a.mp4", 10, 20, "h264", false);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        assert_ne!(a, e);
        assert!(a.contains("|h264|a1"));
        assert!(d.contains("|hevc|"));
    }

    #[test]
    fn cache_hit_miss_size_change_and_invalidate() {
        clear();
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("clip.mp4");
        fs::write(&src, b"fake-source-aaaa").unwrap();
        let src_str = src.to_string_lossy().to_string();

        let seg = dir.path().join("seg.ts");
        fs::write(&seg, b"mpegts-bytes").unwrap();

        let stored = put(&src_str, "h264", true, &seg).expect("put");
        assert!(stored.is_file());
        let hit = get(&src_str, "h264", true).expect("hit");
        assert_eq!(hit, stored);
        assert!(get(&src_str, "hevc", true).is_none());
        assert!(get(&src_str, "h264", false).is_none());

        fs::write(&src, b"fake-source-aaaaaaaa").unwrap();
        assert!(get(&src_str, "h264", true).is_none());

        let seg2 = dir.path().join("seg2.ts");
        fs::write(&seg2, b"mpegts-bytes-2").unwrap();
        put(&src_str, "h264", true, &seg2).unwrap();
        assert!(get(&src_str, "h264", true).is_some());
        invalidate_path(&src_str);
        assert!(get(&src_str, "h264", true).is_none());
        clear();
    }
}
