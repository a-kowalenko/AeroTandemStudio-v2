//! Disk + memory cache for keyframe timestamp lists (trim snap).

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use crate::storage::app_config_dir;
use crate::video::concat::{self, ConcatError};

static KEYFRAME_MEM: LazyLock<Mutex<HashMap<String, Vec<f64>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn keyframes_dir() -> Result<PathBuf, ConcatError> {
    let dir = app_config_dir()
        .map_err(|e| ConcatError::Message(e.to_string()))?
        .join("keyframes");
    fs::create_dir_all(&dir).map_err(ConcatError::Io)?;
    Ok(dir)
}

fn file_identity(path: &Path) -> Result<(u64, u64), ConcatError> {
    let meta = fs::metadata(path).map_err(ConcatError::Io)?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok((mtime, size))
}

fn cache_key(path: &Path, mtime: u64, size: u64) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    format!("{:016x}_{mtime}_{size}", hasher.finish())
}

fn remember(key: &str, times: &[f64]) {
    if let Ok(mut guard) = KEYFRAME_MEM.lock() {
        if guard.len() >= 64 {
            guard.clear();
        }
        guard.insert(key.to_string(), times.to_vec());
    }
}

/// List keyframes with memory + disk cache. Optional duration skips an FFmpeg probe.
pub fn list_keyframes_cached(
    ffmpeg: &Path,
    video_path: &str,
    duration_hint: Option<f64>,
) -> Result<Vec<f64>, ConcatError> {
    let path = Path::new(video_path);
    if !path.is_file() {
        return Err(ConcatError::Message(format!(
            "input file not found: {video_path}"
        )));
    }

    let (mtime, size) = file_identity(path)?;
    let key = cache_key(path, mtime, size);

    if let Ok(guard) = KEYFRAME_MEM.lock() {
        if let Some(times) = guard.get(&key) {
            return Ok(times.clone());
        }
    }

    if let Ok(dir) = keyframes_dir() {
        let cache_path = dir.join(format!("{key}.json"));
        if cache_path.is_file() {
            if let Ok(text) = fs::read_to_string(&cache_path) {
                if let Ok(times) = serde_json::from_str::<Vec<f64>>(&text) {
                    if !times.is_empty() {
                        remember(&key, &times);
                        return Ok(times);
                    }
                }
            }
        }
    }

    let times = concat::list_keyframes(ffmpeg, video_path, duration_hint)?;
    remember(&key, &times);

    if let Ok(dir) = keyframes_dir() {
        let cache_path = dir.join(format!("{key}.json"));
        if let Ok(text) = serde_json::to_string(&times) {
            let _ = fs::write(cache_path, text);
        }
    }

    Ok(times)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_stable_for_same_identity() {
        let p = Path::new("C:/videos/clip.mp4");
        assert_eq!(cache_key(p, 10, 100), cache_key(p, 10, 100));
        assert_ne!(cache_key(p, 10, 100), cache_key(p, 11, 100));
    }
}
