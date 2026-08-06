//! Locate the FFmpeg sidecar binary and run encode jobs with cancellation.
//!
//! Supports multiple concurrent FFmpeg children (Phase 4). Cancel kills all.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use once_cell::sync::Lazy;
use thiserror::Error;

use super::progress::{
    parse_duration, parse_progress_line, progress_from_times_with_task, EncodeProgress,
    ProgressLine,
};

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_CHILDREN: Lazy<Mutex<HashMap<u64, Child>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CANCEL_FLAG: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

#[derive(Debug, Error)]
pub enum FfmpegError {
    #[error("FFmpeg binary not found (expected under resources/ffmpeg/)")]
    NotFound,
    #[error("failed to spawn FFmpeg: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("encode cancelled")]
    Cancelled,
    #[error("FFmpeg exited with status {0}")]
    ExitStatus(i32),
    #[error("{0}")]
    Message(String),
}

/// Resolve path to the bundled FFmpeg binary.
///
/// Search order:
/// 1. `resource_dir` (Tauri bundled resources), if provided
/// 2. `CARGO_MANIFEST_DIR/resources/ffmpeg/...` (dev)
/// 3. Relative `resources/ffmpeg/...` next to the executable
pub fn find_ffmpeg() -> Result<PathBuf, FfmpegError> {
    find_ffmpeg_with_resource_dir(None)
}

pub fn find_ffmpeg_with_resource_dir(resource_dir: Option<&Path>) -> Result<PathBuf, FfmpegError> {
    let relatives = platform_relative_ffmpeg_candidates();

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(dir) = resource_dir {
        for relative in &relatives {
            candidates.push(dir.join(relative));
            candidates.push(dir.join("resources").join(relative));
        }
        // Flattened layout after Tauri resource copy: resources/ffmpeg/<os>/…
        candidates.push(
            dir.join("ffmpeg")
                .join(platform_subdir())
                .join(platform_binary_name()),
        );
        #[cfg(target_os = "macos")]
        {
            candidates.push(
                dir.join("ffmpeg")
                    .join("mac")
                    .join(macos_arch_subdir())
                    .join("ffmpeg"),
            );
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for relative in &relatives {
        candidates.push(manifest_dir.join("resources").join(relative));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for relative in &relatives {
                candidates.push(exe_dir.join("resources").join(relative));
                candidates.push(exe_dir.join(relative));
            }
        }
    }

    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(FfmpegError::NotFound)
}

fn platform_subdir() -> &'static str {
    if cfg!(target_os = "windows") {
        "win"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

fn platform_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

#[cfg(target_os = "macos")]
fn macos_arch_subdir() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x86_64"
    }
}

/// Relative paths under `resources/`, most specific first.
fn platform_relative_ffmpeg_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(target_os = "macos")]
    {
        paths.push(
            PathBuf::from("ffmpeg")
                .join("mac")
                .join(macos_arch_subdir())
                .join("ffmpeg"),
        );
    }
    paths.push(
        PathBuf::from("ffmpeg")
            .join(platform_subdir())
            .join(platform_binary_name()),
    );
    paths
}

/// Clear cancel flag before starting a new top-level job (command entry).
pub fn reset_cancel_flag() {
    CANCEL_FLAG.store(false, Ordering::SeqCst);
}

/// Whether cancellation was requested.
pub fn is_cancelled() -> bool {
    CANCEL_FLAG.load(Ordering::SeqCst)
}

/// Probe media duration in seconds by running `ffmpeg -i` (parses stderr).
pub fn probe_duration_secs(ffmpeg: &Path, input: &str) -> Result<f64, FfmpegError> {
    let stderr = ffmpeg_probe_stderr(ffmpeg, input)?;
    parse_duration(&stderr).ok_or_else(|| {
        FfmpegError::Message(format!("could not parse duration from: {input}"))
    })
}

/// Run `ffmpeg -hide_banner -i <input>` and return stderr (banner + stream info).
pub fn ffmpeg_probe_stderr(ffmpeg: &Path, input: &str) -> Result<String, FfmpegError> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-i", input])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output()?;
    Ok(String::from_utf8_lossy(&output.stderr).into_owned())
}

fn register_child(child: Child) -> Result<u64, FfmpegError> {
    let id = NEXT_JOB_ID.fetch_add(1, Ordering::SeqCst);
    let mut guard = ACTIVE_CHILDREN
        .lock()
        .map_err(|_| FfmpegError::Message("lock poisoned".into()))?;
    guard.insert(id, child);
    Ok(id)
}

fn unregister_child(job_id: u64) {
    if let Ok(mut guard) = ACTIVE_CHILDREN.lock() {
        guard.remove(&job_id);
    }
}

fn try_wait_child(job_id: u64) -> Result<Option<i32>, FfmpegError> {
    let mut guard = ACTIVE_CHILDREN
        .lock()
        .map_err(|_| FfmpegError::Message("lock poisoned".into()))?;

    if let Some(child) = guard.get_mut(&job_id) {
        match child.try_wait() {
            Ok(Some(status)) => Ok(Some(status.code().unwrap_or(-1))),
            Ok(None) => Ok(None),
            Err(e) => Err(FfmpegError::Spawn(e)),
        }
    } else {
        Ok(Some(-1))
    }
}

fn kill_all_children() -> bool {
    let mut guard = match ACTIVE_CHILDREN.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let mut any = false;
    for (_, mut child) in guard.drain() {
        let _ = child.kill();
        let _ = child.wait();
        any = true;
    }
    any
}

fn apply_no_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

/// Run FFmpeg without progress parsing (stream-copy remux, probes, validation).
pub fn run_ffmpeg_checked(ffmpeg: &Path, args: &[String]) -> Result<(), FfmpegError> {
    if is_cancelled() {
        return Err(FfmpegError::Cancelled);
    }

    let mut cmd = Command::new(ffmpeg);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let mut child = cmd.spawn()?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| FfmpegError::Message("missing stderr pipe".into()))?;

    let job_id = register_child(child)?;

    let stderr_thread = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut buf = String::new();
        for line in reader.lines().flatten() {
            if is_cancelled() {
                break;
            }
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    });

    let exit_code = loop {
        if is_cancelled() {
            kill_all_children();
            let _ = stderr_thread.join();
            unregister_child(job_id);
            return Err(FfmpegError::Cancelled);
        }

        match try_wait_child(job_id)? {
            None => thread::sleep(Duration::from_millis(50)),
            Some(code) => break code,
        }
    };

    let stderr_text = stderr_thread.join().unwrap_or_default();
    unregister_child(job_id);

    if is_cancelled() {
        return Err(FfmpegError::Cancelled);
    }

    if exit_code == 0 {
        Ok(())
    } else {
        let hint = stderr_text
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        if hint.is_empty() {
            Err(FfmpegError::ExitStatus(exit_code))
        } else {
            Err(FfmpegError::Message(format!(
                "FFmpeg exited with status {exit_code}: {hint}"
            )))
        }
    }
}

/// Like [`run_ffmpeg_checked`], but returns stderr text (e.g. for splice validation).
pub fn run_ffmpeg_capture_stderr(ffmpeg: &Path, args: &[String]) -> Result<(i32, String), FfmpegError> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let output = cmd.output()?;
    let code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Ok((code, stderr))
}

pub type ProgressCallback = Arc<dyn Fn(EncodeProgress) + Send + Sync>;

/// Run FFmpeg with progress. Supports cancellation of all active children.
pub fn run_ffmpeg(
    ffmpeg: &Path,
    args: &[String],
    total_secs: f64,
    on_progress: ProgressCallback,
) -> Result<(), FfmpegError> {
    run_ffmpeg_tagged(ffmpeg, args, total_secs, None, on_progress)
}

/// Like [`run_ffmpeg`], tagging every progress event with `task_id` (1-based).
pub fn run_ffmpeg_tagged(
    ffmpeg: &Path,
    args: &[String],
    total_secs: f64,
    task_id: Option<u32>,
    on_progress: ProgressCallback,
) -> Result<(), FfmpegError> {
    if is_cancelled() {
        return Err(FfmpegError::Cancelled);
    }

    let mut cmd = Command::new(ffmpeg);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let mut child = cmd.spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| FfmpegError::Message("missing stdout pipe".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| FfmpegError::Message("missing stderr pipe".into()))?;

    let job_id = register_child(child)?;

    let current_secs = Arc::new(Mutex::new(0.0_f64));
    let current_clone = Arc::clone(&current_secs);
    let on_progress_thread = Arc::clone(&on_progress);
    let total_for_thread = total_secs;

    let progress_thread = thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut status = String::from("continue");
        for line in reader.lines().flatten() {
            if is_cancelled() {
                break;
            }
            match parse_progress_line(&line) {
                ProgressLine::OutTimeSecs(secs) => {
                    if let Ok(mut c) = current_clone.lock() {
                        *c = secs;
                    }
                    on_progress_thread(progress_from_times_with_task(
                        secs,
                        total_for_thread,
                        &status,
                        task_id,
                    ));
                }
                ProgressLine::Status(s) => {
                    status = s.clone();
                    let secs = current_clone.lock().map(|c| *c).unwrap_or(0.0);
                    let pct_total = if status == "end" && total_for_thread > 0.0 {
                        total_for_thread
                    } else {
                        secs
                    };
                    on_progress_thread(progress_from_times_with_task(
                        pct_total,
                        total_for_thread,
                        &status,
                        task_id,
                    ));
                }
                ProgressLine::Other => {}
            }
        }
    });

    let stderr_thread = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if is_cancelled() {
                break;
            }
            let _ = parse_duration(&line);
        }
    });

    let exit_code = loop {
        if is_cancelled() {
            kill_all_children();
            let _ = progress_thread.join();
            let _ = stderr_thread.join();
            unregister_child(job_id);
            return Err(FfmpegError::Cancelled);
        }

        match try_wait_child(job_id) {
            Ok(None) => {
                thread::sleep(Duration::from_millis(50));
            }
            Ok(Some(code)) => break code,
            Err(e) => {
                let _ = progress_thread.join();
                let _ = stderr_thread.join();
                unregister_child(job_id);
                return Err(e);
            }
        }
    };

    let _ = progress_thread.join();
    let _ = stderr_thread.join();
    unregister_child(job_id);

    if is_cancelled() {
        return Err(FfmpegError::Cancelled);
    }

    if exit_code == 0 {
        on_progress(progress_from_times_with_task(
            total_secs.max(0.0),
            total_secs,
            "end",
            task_id,
        ));
        Ok(())
    } else {
        Err(FfmpegError::ExitStatus(exit_code))
    }
}

/// Request cancellation of **all** active FFmpeg processes.
pub fn cancel_encode() -> bool {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    kill_all_children()
}

/// Number of currently registered FFmpeg children (for tests / diagnostics).
#[allow(dead_code)]
pub fn active_child_count() -> usize {
    ACTIVE_CHILDREN.lock().map(|g| g.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_relative_path_is_sane() {
        let rels = platform_relative_ffmpeg_candidates();
        assert!(!rels.is_empty());
        let s = rels[0].to_string_lossy().replace('\\', "/");
        assert!(s.contains("ffmpeg"));
        #[cfg(target_os = "windows")]
        assert!(s.ends_with("win/ffmpeg.exe"));
        #[cfg(target_os = "macos")]
        {
            assert!(
                s.contains("mac/arm64/") || s.contains("mac/x86_64/"),
                "macOS preferred path should be arch-specific: {s}"
            );
            let fallback = rels.last().unwrap().to_string_lossy().replace('\\', "/");
            assert!(fallback.ends_with("mac/ffmpeg"));
        }
    }

    #[test]
    fn find_ffmpeg_in_dev_resources() {
        let result = find_ffmpeg();
        assert!(
            result.is_ok(),
            "expected ffmpeg sidecar under resources/ffmpeg/ (run npm run download-ffmpeg): {result:?}"
        );
        assert!(result.unwrap().exists());
    }

    #[test]
    fn reset_and_cancel_flag() {
        reset_cancel_flag();
        assert!(!is_cancelled());
        CANCEL_FLAG.store(true, Ordering::SeqCst);
        assert!(is_cancelled());
        reset_cancel_flag();
        assert!(!is_cancelled());
    }
}
