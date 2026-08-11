//! Video filmstrip frames for Apple-style trim UI.
//!
//! Strategy: parallel keyframe seeks (`-ss` before `-i`) → cached JPEGs under
//! `{app_config}/filmstrips/`. Returns absolute file paths (caller maps to media URLs).

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::thread;

use thiserror::Error;

use crate::storage::app_config_dir;
use crate::util::process::apply_no_window;
use crate::video::ffmpeg::{find_ffmpeg, probe_duration_secs};

pub const DEFAULT_FRAME_COUNT: usize = 14;
pub const DEFAULT_FRAME_HEIGHT: u32 = 56;
const MIN_FRAMES: usize = 4;
const MAX_FRAMES: usize = 24;
const SEEK_PARALLELISM: usize = 4;

static FILMSTRIP_MEM: LazyLock<Mutex<HashMap<String, Vec<PathBuf>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Error)]
pub enum FilmstripError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
}

fn filmstrips_dir() -> Result<PathBuf, FilmstripError> {
    let dir = app_config_dir()
        .map_err(|e| FilmstripError::Message(e.to_string()))?
        .join("filmstrips");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn file_identity(path: &Path) -> Result<(u64, u64), FilmstripError> {
    let meta = fs::metadata(path)?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok((mtime, size))
}

fn cache_key(path: &Path, mtime: u64, size: u64, count: usize, height: u32) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    format!(
        "{:016x}_{mtime}_{size}_{count}x{height}",
        hasher.finish()
    )
}

fn clamp_count(count: usize) -> usize {
    count.clamp(MIN_FRAMES, MAX_FRAMES)
}

fn sample_times(count: usize, duration: f64) -> Vec<f64> {
    let duration = duration.max(0.05);
    let end_pad = (duration - 0.04).max(0.0);
    (0..count)
        .map(|i| {
            let t = ((i as f64 + 0.5) / count as f64) * duration;
            t.clamp(0.0, end_pad)
        })
        .collect()
}

/// Generate (or load from memory/disk cache) `count` evenly spaced filmstrip JPEG paths.
pub fn generate_filmstrip(
    path: &Path,
    count: usize,
    height: u32,
    duration_hint: Option<f64>,
    ffmpeg: Option<&Path>,
) -> Result<Vec<PathBuf>, FilmstripError> {
    let count = clamp_count(count);
    let height = height.clamp(32, 96);
    let (mtime, size) = file_identity(path)?;
    let key = cache_key(path, mtime, size, count, height);

    if let Ok(guard) = FILMSTRIP_MEM.lock() {
        if let Some(paths) = guard.get(&key) {
            if paths.len() == count && paths.iter().all(|p| p.is_file()) {
                return Ok(paths.clone());
            }
        }
    }

    let dir = filmstrips_dir()?;
    let mut cached = Vec::with_capacity(count);
    let mut all_cached = true;
    for i in 0..count {
        let cache_path = dir.join(format!("{key}_{i:02}.jpg"));
        if cache_path.is_file() {
            if let Ok(meta) = fs::metadata(&cache_path) {
                if meta.len() > 32 {
                    cached.push(cache_path);
                    continue;
                }
            }
            let _ = fs::remove_file(&cache_path);
        }
        all_cached = false;
        break;
    }
    if all_cached && cached.len() == count {
        remember(&key, &cached);
        return Ok(cached);
    }

    let ff = match ffmpeg {
        Some(p) => p.to_path_buf(),
        None => find_ffmpeg().map_err(|e| FilmstripError::Message(e.to_string()))?,
    };

    let duration = duration_hint
        .filter(|d| d.is_finite() && *d > 0.0)
        .or_else(|| {
            probe_duration_secs(&ff, &path.to_string_lossy())
                .ok()
                .filter(|d| d.is_finite() && *d > 0.0)
        })
        .unwrap_or(1.0);

    let out_paths: Vec<PathBuf> = (0..count)
        .map(|i| dir.join(format!("{key}_{i:02}.jpg")))
        .collect();

    extract_seek_frames(path, &ff, count, height, duration, &out_paths)?;

    for p in &out_paths {
        if !p.is_file() {
            return Err(FilmstripError::Message(format!(
                "missing filmstrip frame: {}",
                p.display()
            )));
        }
    }

    remember(&key, &out_paths);
    Ok(out_paths)
}

fn remember(key: &str, paths: &[PathBuf]) {
    if let Ok(mut guard) = FILMSTRIP_MEM.lock() {
        // Bound memory: drop oldest-ish entries when large (simple cap).
        if guard.len() >= 32 {
            guard.clear();
        }
        guard.insert(key.to_string(), paths.to_vec());
    }
}

fn extract_seek_frames(
    path: &Path,
    ffmpeg: &Path,
    count: usize,
    height: u32,
    duration: f64,
    out_paths: &[PathBuf],
) -> Result<(), FilmstripError> {
    let in_str = path.to_string_lossy().into_owned();
    let times = sample_times(count, duration);
    let next = AtomicUsize::new(0);
    let error: Mutex<Option<String>> = Mutex::new(None);
    let workers = SEEK_PARALLELISM.min(count).max(1);

    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    if error.lock().ok().and_then(|g| g.clone()).is_some() {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= count {
                        break;
                    }
                    if let Err(e) =
                        extract_one_frame(ffmpeg, &in_str, times[i], height, &out_paths[i])
                    {
                        if let Ok(mut g) = error.lock() {
                            if g.is_none() {
                                *g = Some(e.to_string());
                            }
                        }
                        break;
                    }
                }
            });
        }
    });

    if let Ok(g) = error.lock() {
        if let Some(msg) = g.as_ref() {
            return Err(FilmstripError::Message(msg.clone()));
        }
    }
    Ok(())
}

fn extract_one_frame(
    ffmpeg: &Path,
    input: &str,
    seek_secs: f64,
    height: u32,
    out_path: &Path,
) -> Result<(), FilmstripError> {
    let scale = format!("scale=-2:{height}");
    let seek = format!("{seek_secs:.3}");
    let out_str = out_path.to_string_lossy().into_owned();

    let run = |seek_before_input: bool| -> Result<(bool, String), FilmstripError> {
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-nostdin", "-y", "-hide_banner", "-loglevel", "error"]);
        if seek_before_input {
            cmd.args(["-ss", &seek]);
        }
        cmd.arg("-i").arg(input);
        if !seek_before_input {
            cmd.args(["-ss", &seek]);
        }
        cmd.args([
            "-an",
            "-frames:v",
            "1",
            "-vf",
            &scale,
            "-q:v",
            "5",
            "-threads",
            "1",
            "-update",
            "1",
            &out_str,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
        apply_no_window(&mut cmd);
        let output = cmd.output().map_err(FilmstripError::Io)?;
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok((output.status.success(), err))
    };

    let (ok, err1) = run(true)?;
    if !ok {
        let (ok2, err2) = run(false)?;
        if !ok2 {
            let _ = fs::remove_file(out_path);
            let detail = [err1, err2]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or_else(|| "unknown ffmpeg error".into());
            return Err(FilmstripError::Message(format!(
                "FFmpeg filmstrip frame failed ({input} @ {seek}): {detail}"
            )));
        }
    }

    let meta = fs::metadata(out_path).map_err(|_| {
        FilmstripError::Message("FFmpeg finished but filmstrip frame is missing".into())
    })?;
    if meta.len() == 0 {
        let _ = fs::remove_file(out_path);
        return Err(FilmstripError::Message(
            "FFmpeg wrote an empty filmstrip frame".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::ffmpeg::find_ffmpeg;
    use tempfile::tempdir;

    #[test]
    fn clamp_count_bounds() {
        assert_eq!(clamp_count(1), MIN_FRAMES);
        assert_eq!(clamp_count(100), MAX_FRAMES);
        assert_eq!(clamp_count(14), 14);
    }

    #[test]
    fn sample_times_spread_across_duration() {
        let times = sample_times(4, 4.0);
        assert_eq!(times.len(), 4);
        assert!(times[0] > 0.0 && times[0] < 1.0);
        assert!(times[3] > 3.0 && times[3] < 4.0);
        for w in times.windows(2) {
            assert!(w[1] > w[0]);
        }
    }

    #[test]
    fn filmstrip_from_generated_mp4() {
        let ffmpeg = match find_ffmpeg() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("skip: ffmpeg not found");
                return;
            }
        };
        let dir = tempdir().unwrap();
        let vid = dir.path().join("clip.mp4");
        let status = Command::new(&ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=320x240:d=2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                &vid.to_string_lossy(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("spawn ffmpeg");
        assert!(status.success(), "failed to generate test mp4");

        let paths =
            generate_filmstrip(&vid, 8, 48, Some(2.0), Some(&ffmpeg)).expect("filmstrip");
        assert_eq!(paths.len(), 8);
        for p in &paths {
            assert!(p.is_file(), "missing {}", p.display());
            assert!(fs::metadata(p).unwrap().len() > 32);
        }

        // Second call should hit memory/disk cache (same paths).
        let paths2 =
            generate_filmstrip(&vid, 8, 48, Some(2.0), Some(&ffmpeg)).expect("cached");
        assert_eq!(paths, paths2);
    }
}
