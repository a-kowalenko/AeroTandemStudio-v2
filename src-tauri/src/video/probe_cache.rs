//! Process-local Compatible/concat probe cache (OPT-16).
//!
//! Keyed by working path + size_bytes + mtime so in-place cuts/rotates miss
//! automatically. TTL = app process lifetime (no disk persist).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use super::ffmpeg::{ffmpeg_probe_stderr, is_cancelled, FfmpegError};
use super::parallel::{ParallelError, ParallelVideoProcessor};
use super::probe::{
    compatible_stream_key_from_probe, has_audio_stream_from_probe, parse_video_metadata_from_probe,
    CompatibleStreamKey,
};
use super::progress::parse_duration;

/// Cached concat probe fields (same content as [`super::concat::ClipConcatProbe`]).
#[derive(Debug, Clone, PartialEq)]
pub struct CachedClipProbe {
    /// Raw codec name from FFmpeg (`h264`, `hevc`, …).
    pub codec: String,
    pub has_audio: bool,
    pub duration_secs: f64,
    pub compatible_key: CompatibleStreamKey,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    size_bytes: u64,
    mtime_secs: u64,
    probe: CachedClipProbe,
}

static PROBE_CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache_map() -> &'static Mutex<HashMap<String, CacheEntry>> {
    PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// File identity for cache lookup. `mtime_secs == 0` when unavailable (size alone still used).
pub fn file_identity(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((size, mtime))
}

fn cache_key(path: &str, size: u64, mtime: u64) -> String {
    format!("{path}|{size}|{mtime}")
}

/// Build a cache entry from one `ffmpeg -i` stderr (no second probe).
pub fn cached_probe_from_stderr(stderr: &str) -> Option<CachedClipProbe> {
    let meta = parse_video_metadata_from_probe(stderr)?;
    let has_audio = has_audio_stream_from_probe(stderr);
    let duration_secs = parse_duration(stderr).unwrap_or(0.0);
    let compatible_key = compatible_stream_key_from_probe(stderr, has_audio)?;
    Some(CachedClipProbe {
        codec: meta.codec,
        has_audio,
        duration_secs,
        compatible_key,
    })
}

/// Store probe for `path` using current on-disk size/mtime.
pub fn put(path: &str, probe: CachedClipProbe) {
    let Some((size, mtime)) = file_identity(Path::new(path)) else {
        return;
    };
    put_with_identity(path, size, mtime, probe);
}

fn put_with_identity(path: &str, size: u64, mtime: u64, probe: CachedClipProbe) {
    let key = cache_key(path, size, mtime);
    if let Ok(mut guard) = cache_map().lock() {
        if guard.len() >= 256 {
            guard.clear();
        }
        guard.insert(
            key,
            CacheEntry {
                size_bytes: size,
                mtime_secs: mtime,
                probe,
            },
        );
    }
}

/// Parse stderr and store under current file identity. Returns the probe when parse succeeds.
pub fn put_from_stderr(path: &str, stderr: &str) -> Option<CachedClipProbe> {
    let probe = cached_probe_from_stderr(stderr)?;
    put(path, probe.clone());
    Some(probe)
}

/// Lookup by path + current size/mtime. `None` on miss or identity mismatch.
pub fn get(path: &str) -> Option<CachedClipProbe> {
    let (size, mtime) = file_identity(Path::new(path))?;
    let key = cache_key(path, size, mtime);
    let guard = cache_map().lock().ok()?;
    let entry = guard.get(&key)?;
    if entry.size_bytes != size || entry.mtime_secs != mtime {
        return None;
    }
    Some(entry.probe.clone())
}

/// Drop every entry whose path matches (any size/mtime). Used after edits before re-probe.
pub fn invalidate_path(path: &str) {
    let prefix = format!("{path}|");
    if let Ok(mut guard) = cache_map().lock() {
        guard.retain(|k, _| !k.starts_with(&prefix));
    }
}

/// Clear the entire session cache (tests / session reset).
pub fn clear() {
    if let Ok(mut guard) = cache_map().lock() {
        guard.clear();
    }
}

/// Run `ffmpeg -i`, cache, and return probe.
pub fn probe_and_store(ffmpeg: &Path, path: &str) -> Result<CachedClipProbe, FfmpegError> {
    if !Path::new(path).is_file() {
        return Err(FfmpegError::Message(format!("file not found: {path}")));
    }
    let stderr = ffmpeg_probe_stderr(ffmpeg, path)?;
    cached_probe_from_stderr(&stderr)
        .map(|probe| {
            put(path, probe.clone());
            probe
        })
        .ok_or_else(|| {
            FfmpegError::Message(format!("could not parse video stream from: {path}"))
        })
}

/// Cache hit → return probe; miss → probe + store. Second value is `true` on hit.
pub fn get_or_probe(ffmpeg: &Path, path: &str) -> Result<(CachedClipProbe, bool), FfmpegError> {
    if let Some(hit) = get(path) {
        return Ok((hit, true));
    }
    Ok((probe_and_store(ffmpeg, path)?, false))
}

/// Resolve probes for all concat inputs: cache hits reuse, misses probed in parallel (2–4).
///
/// Returns `(probes in path order, all_from_cache)`.
pub fn resolve_clips_parallel(
    ffmpeg: &Path,
    paths: &[String],
    on_progress: impl Fn(u64, u64, &str) + Sync + Send,
) -> Result<(Vec<CachedClipProbe>, bool), ParallelError> {
    let n = paths.len();
    if n == 0 {
        return Ok((Vec::new(), true));
    }

    let mut probes: Vec<Option<CachedClipProbe>> = vec![None; n];
    let mut miss_indices = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        if let Some(hit) = get(path) {
            probes[i] = Some(hit);
        } else {
            miss_indices.push(i);
        }
    }

    let all_from_cache = miss_indices.is_empty();
    if !miss_indices.is_empty() {
        let workers = super::probe::probe_worker_count(miss_indices.len());
        let cpu_count = std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(2);
        let pool = ParallelVideoProcessor {
            max_workers: workers,
            hw_accel_enabled: false,
            cpu_count,
        };

        let ffmpeg_buf = ffmpeg.to_path_buf();
        let paths_owned: Vec<String> = paths.to_vec();
        let miss_owned = miss_indices.clone();
        let completed = AtomicUsize::new(0);
        let total_miss = miss_indices.len() as u64;

        let miss_results = pool.process_indexed(
            miss_owned.len(),
            |job_i, _task_id| -> Result<(usize, CachedClipProbe), String> {
                if is_cancelled() {
                    return Err("cancelled".into());
                }
                let path_i = miss_owned[job_i];
                let path = paths_owned[path_i].as_str();
                let probe = probe_and_store(&ffmpeg_buf, path).map_err(|e| e.to_string())?;
                let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                let name = Path::new(path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path);
                on_progress(done as u64, total_miss, name);
                Ok((path_i, probe))
            },
            None,
        )?;

        for r in miss_results {
            match r {
                Ok((path_i, probe)) => {
                    probes[path_i] = Some(probe);
                }
                Err(e) => {
                    if e == "cancelled" || e.contains("cancelled") {
                        return Err(ParallelError::Cancelled);
                    }
                    return Err(ParallelError::Message(e));
                }
            }
        }
    }

    let mut out = Vec::with_capacity(n);
    for (i, slot) in probes.into_iter().enumerate() {
        match slot {
            Some(p) => out.push(p),
            None => {
                return Err(ParallelError::Message(format!(
                    "concat probe missing for {}",
                    paths[i]
                )));
            }
        }
    }
    Ok((out, all_from_cache))
}

/// Invalidate `path` then probe+store (after cut/rotate/split overwrite).
pub fn refresh_path(ffmpeg: &Path, path: &str) {
    invalidate_path(path);
    let _ = probe_and_store(ffmpeg, path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::probe::VideoRotationProbe;

    fn sample_stderr_h264_audio() -> &'static str {
        r#"
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 30 fps, 30 tbr
  Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp
"#
    }

    fn sample_stderr_hevc_no_audio() -> &'static str {
        r#"
Input #0, mov, from 'b.mp4':
  Duration: 00:00:05.00, start: 0.000000, bitrate: 4000 kb/s
  Stream #0:0: Video: hevc (Main) (hev1 / 0x31766568), yuv420p, 1280x720, 25 fps
"#
    }

    #[test]
    fn cached_probe_from_stderr_parses_key_fields() {
        let p = cached_probe_from_stderr(sample_stderr_h264_audio()).unwrap();
        assert_eq!(p.codec, "h264");
        assert!(p.has_audio);
        assert!((p.duration_secs - 10.0).abs() < 0.01);
        assert_eq!(p.compatible_key.width, 1920);
        assert_eq!(p.compatible_key.height, 1080);
        assert_eq!(p.compatible_key.pix_fmt, "yuv420p");
        assert_eq!(p.compatible_key.rotation, VideoRotationProbe::Known(0));
    }

    #[test]
    fn cache_hit_miss_and_invalidate() {
        clear();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        std::fs::write(&path, b"fake-mp4-bytes-aaaa").unwrap();
        let path_str = path.to_string_lossy().to_string();

        let probe = cached_probe_from_stderr(sample_stderr_h264_audio()).unwrap();
        put(&path_str, probe.clone());
        let hit = get(&path_str).expect("cache hit");
        assert_eq!(hit.codec, "h264");
        assert_eq!(hit, probe);

        // Size change → miss (identity key).
        std::fs::write(&path, b"fake-mp4-bytes-aaaaaaaa").unwrap();
        assert!(get(&path_str).is_none());

        put(&path_str, probe.clone());
        assert!(get(&path_str).is_some());
        invalidate_path(&path_str);
        assert!(get(&path_str).is_none());
        clear();
    }

    #[test]
    fn gate_keys_from_cache_match_fresh_parse() {
        let a = cached_probe_from_stderr(sample_stderr_h264_audio()).unwrap();
        let b = cached_probe_from_stderr(sample_stderr_h264_audio()).unwrap();
        assert!(crate::video::probe::compatible_stream_keys_match(
            &a.compatible_key,
            &b.compatible_key
        ));

        let c = cached_probe_from_stderr(sample_stderr_hevc_no_audio()).unwrap();
        assert!(!crate::video::probe::compatible_stream_keys_match(
            &a.compatible_key,
            &c.compatible_key
        ));
        assert!(!c.has_audio);
        assert_eq!(c.codec, "hevc");
    }

    #[test]
    fn put_from_stderr_roundtrip() {
        clear();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.mp4");
        std::fs::write(&path, b"x").unwrap();
        let path_str = path.to_string_lossy().to_string();
        let stored = put_from_stderr(&path_str, sample_stderr_h264_audio()).unwrap();
        let got = get(&path_str).unwrap();
        assert_eq!(stored, got);
        clear();
    }
}
