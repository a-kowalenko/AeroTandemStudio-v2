//! Long-lived mpv IPC sessions for Cutter / clip playback.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::json;
use thiserror::Error;

use super::detect::find_mpv_binary;
use super::ipc::{IpcError, MpvIpc};

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static GLOBAL: Lazy<Mutex<MpvSessionManager>> =
    Lazy::new(|| Mutex::new(MpvSessionManager::new()));

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("mpv not available")]
    NotAvailable,
    #[error("session {0} not found")]
    NotFound(u64),
    #[error(transparent)]
    Ipc(#[from] IpcError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct MpvSessionInfo {
    pub session_id: u64,
    pub frame_path: String,
    pub duration_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub session_id: u64,
    pub current_ms: f64,
    pub duration_ms: f64,
    pub paused: bool,
    pub eof_reached: bool,
    /// Cache-bust token for the JPEG frame URL (changes after seek / tick).
    pub frame_rev: u64,
}

struct LiveSession {
    id: u64,
    child: Child,
    ipc: MpvIpc,
    #[allow(dead_code)]
    ipc_path: PathBuf,
    frame_path: PathBuf,
    work_dir: PathBuf,
    duration_ms: f64,
    frame_rev: u64,
}

pub struct MpvSessionManager {
    sessions: HashMap<u64, LiveSession>,
    resource_dir: Option<PathBuf>,
}

impl MpvSessionManager {
    fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            resource_dir: None,
        }
    }

    pub fn global() -> &'static Mutex<MpvSessionManager> {
        &GLOBAL
    }

    pub fn set_resource_dir(&mut self, dir: Option<PathBuf>) {
        self.resource_dir = dir;
    }

    pub fn open(&mut self, path: &Path) -> Result<MpvSessionInfo, SessionError> {
        if !path.is_file() {
            return Err(SessionError::Message(format!(
                "video not found: {}",
                path.display()
            )));
        }

        let mpv = find_mpv_binary(self.resource_dir.as_deref())
            .ok_or(SessionError::NotAvailable)?;

        let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let work_dir = std::env::temp_dir().join(format!("ats_mpv_{id}"));
        fs::create_dir_all(&work_dir)?;
        let frame_path = work_dir.join("frame.jpg");
        // Touch empty frame so HTTP 404 is avoided before first capture.
        if !frame_path.exists() {
            fs::write(&frame_path, [])?;
        }

        let ipc_path = ipc_endpoint_path(id);
        // Clean stale socket.
        let _ = fs::remove_file(&ipc_path);

        let mut cmd = Command::new(&mpv);
        cmd.arg("--idle=yes")
            .arg("--keep-open=yes")
            .arg("--force-window=no")
            .arg("--no-terminal")
            .arg("--really-quiet")
            .arg("--hr-seek=yes")
            .arg("--hr-seek-framedrop=no")
            .arg("--osc=no")
            .arg("--osd-level=0")
            .arg("--vo=null")
            .arg("--framedrop=no")
            .arg("--screenshot-format=jpg")
            .arg("--screenshot-jpeg-quality=80")
            // Decode enough for accurate seeks + video screenshots with vo=null.
            .arg("--vd-lavc-threads=0")
            .arg(format!("--input-ipc-server={}", ipc_path.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        // Platform audio; keep silent until volume set from UI.
        #[cfg(target_os = "macos")]
        {
            cmd.arg("--ao=coreaudio");
        }
        #[cfg(target_os = "linux")]
        {
            cmd.arg("--ao=pulse");
        }
        #[cfg(windows)]
        {
            cmd.arg("--ao=wasapi");
        }

        let mut child = cmd.spawn().map_err(|e| {
            SessionError::Message(format!("failed to spawn mpv ({}): {e}", mpv.display()))
        })?;

        let mut ipc = match MpvIpc::connect(&ipc_path, Duration::from_secs(5)) {
            Ok(ipc) => ipc,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.into());
            }
        };

        // Start paused so the first frame is stable for scrubbing.
        if let Err(e) = ipc.set_pause(true) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.into());
        }
        if let Err(e) = ipc.loadfile(path) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.into());
        }

        // Wait briefly for duration to become available.
        let duration_ms = wait_duration_ms(&mut ipc).unwrap_or(0.0);
        let mut live = LiveSession {
            id,
            child,
            ipc,
            ipc_path,
            frame_path: frame_path.clone(),
            work_dir,
            duration_ms,
            frame_rev: 0,
        };
        if let Err(e) = live.capture_frame() {
            let _ = live.child.kill();
            let _ = live.child.wait();
            let _ = fs::remove_file(&live.ipc_path);
            let _ = fs::remove_dir_all(&live.work_dir);
            return Err(SessionError::Message(format!(
                "mpv frame capture failed (HTML5 fallback): {e}"
            )));
        }

        let info = MpvSessionInfo {
            session_id: id,
            frame_path: frame_path.display().to_string(),
            duration_ms,
        };
        self.sessions.insert(id, live);
        Ok(info)
    }

    pub fn close(&mut self, session_id: u64) -> Result<(), SessionError> {
        if let Some(mut live) = self.sessions.remove(&session_id) {
            let _ = live.ipc.command(&[json!("quit")]);
            let _ = live.child.kill();
            let _ = live.child.wait();
            let _ = fs::remove_file(&live.ipc_path);
            let _ = fs::remove_dir_all(&live.work_dir);
        }
        Ok(())
    }

    pub fn close_all(&mut self) {
        let ids: Vec<u64> = self.sessions.keys().copied().collect();
        for id in ids {
            let _ = self.close(id);
        }
    }

    pub fn seek_ms(&mut self, session_id: u64, ms: f64) -> Result<SessionSnapshot, SessionError> {
        let live = self
            .sessions
            .get_mut(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        let secs = (ms.max(0.0) / 1000.0).max(0.0);
        live.ipc.seek_absolute_secs(secs)?;
        // Keep paused while scrubbing; play() resumes.
        let _ = live.ipc.set_pause(true);
        let _ = live.capture_frame();
        Ok(live.snapshot())
    }

    pub fn play(&mut self, session_id: u64) -> Result<SessionSnapshot, SessionError> {
        let live = self
            .sessions
            .get_mut(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        live.ipc.set_pause(false)?;
        Ok(live.snapshot())
    }

    pub fn pause(&mut self, session_id: u64) -> Result<SessionSnapshot, SessionError> {
        let live = self
            .sessions
            .get_mut(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        live.ipc.set_pause(true)?;
        let _ = live.capture_frame();
        Ok(live.snapshot())
    }

    pub fn set_volume(
        &mut self,
        session_id: u64,
        volume: f64,
        muted: bool,
    ) -> Result<(), SessionError> {
        let live = self
            .sessions
            .get_mut(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        // mpv volume is 0–100 (+).
        let vol = if muted {
            0.0
        } else {
            (volume.clamp(0.0, 1.0) * 100.0).clamp(0.0, 100.0)
        };
        live.ipc.set_property("volume", json!(vol))?;
        live.ipc.set_property("mute", json!(muted))?;
        Ok(())
    }

    pub fn tick(&mut self, session_id: u64) -> Result<SessionSnapshot, SessionError> {
        let live = self
            .sessions
            .get_mut(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        let paused = live
            .ipc
            .get_property("pause")
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if !paused {
            let _ = live.capture_frame();
        }
        // Refresh duration if it was unknown at open.
        if live.duration_ms <= 0.0 {
            if let Ok(d) = live.ipc.get_property("duration") {
                if let Some(secs) = d.as_f64() {
                    if secs.is_finite() && secs > 0.0 {
                        live.duration_ms = secs * 1000.0;
                    }
                }
            }
        }
        Ok(live.snapshot())
    }

    pub fn snapshot(&mut self, session_id: u64) -> Result<SessionSnapshot, SessionError> {
        let live = self
            .sessions
            .get_mut(&session_id)
            .ok_or(SessionError::NotFound(session_id))?;
        Ok(live.snapshot())
    }

    pub fn frame_path(&self, session_id: u64) -> Result<PathBuf, SessionError> {
        self.sessions
            .get(&session_id)
            .map(|s| s.frame_path.clone())
            .ok_or(SessionError::NotFound(session_id))
    }
}

impl LiveSession {
    fn capture_frame(&mut self) -> Result<(), SessionError> {
        self.ipc.screenshot_to_file(&self.frame_path)?;
        self.frame_rev = self.frame_rev.wrapping_add(1);
        Ok(())
    }

    fn snapshot(&mut self) -> SessionSnapshot {
        let current_ms = self
            .ipc
            .get_property("time-pos")
            .ok()
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite())
            .map(|s| s * 1000.0)
            .unwrap_or(0.0);
        let paused = self
            .ipc
            .get_property("pause")
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let eof_reached = self
            .ipc
            .get_property("eof-reached")
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if self.duration_ms <= 0.0 {
            if let Ok(d) = self.ipc.get_property("duration") {
                if let Some(secs) = d.as_f64() {
                    if secs.is_finite() && secs > 0.0 {
                        self.duration_ms = secs * 1000.0;
                    }
                }
            }
        }
        SessionSnapshot {
            session_id: self.id,
            current_ms,
            duration_ms: self.duration_ms,
            paused,
            eof_reached,
            frame_rev: self.frame_rev,
        }
    }
}

fn wait_duration_ms(ipc: &mut MpvIpc) -> Option<f64> {
    for _ in 0..40 {
        if let Ok(d) = ipc.get_property("duration") {
            if let Some(secs) = d.as_f64() {
                if secs.is_finite() && secs > 0.0 {
                    return Some(secs * 1000.0);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn ipc_endpoint_path(id: u64) -> PathBuf {
    #[cfg(unix)]
    {
        std::env::temp_dir().join(format!("ats-mpv-{id}.sock"))
    }
    #[cfg(windows)]
    {
        // mpv on Windows: --input-ipc-server=\\.\pipe\name
        PathBuf::from(format!(r"\\.\pipe\ats-mpv-{id}"))
    }
}

pub fn with_manager<T>(f: impl FnOnce(&mut MpvSessionManager) -> T) -> Result<T, String> {
    let mut guard = GLOBAL
        .lock()
        .map_err(|_| "mpv session lock poisoned".to_string())?;
    Ok(f(&mut guard))
}

pub fn set_global_resource_dir(dir: Option<PathBuf>) {
    if let Ok(mut g) = GLOBAL.lock() {
        g.set_resource_dir(dir);
    }
}

pub fn shutdown_all_sessions() {
    if let Ok(mut g) = GLOBAL.lock() {
        g.close_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_without_mpv_returns_not_available_or_succeeds() {
        let mut mgr = MpvSessionManager::new();
        // Nonexistent file → Message; missing mpv → NotAvailable.
        let err = mgr
            .open(Path::new("/definitely/missing/ats-opt13.mp4"))
            .unwrap_err();
        match err {
            SessionError::NotAvailable | SessionError::Message(_) => {}
            other => panic!("unexpected: {other}"),
        }
    }
}
