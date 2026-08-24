//! Minimal mpv JSON IPC client (newline-delimited JSON over Unix socket / named pipe).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("mpv IPC connect failed: {0}")]
    Connect(String),
    #[error("mpv IPC I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("mpv IPC timeout")]
    Timeout,
    #[error("mpv IPC: {0}")]
    Protocol(String),
}

pub struct MpvIpc {
    #[cfg(unix)]
    stream: std::os::unix::net::UnixStream,
    #[cfg(windows)]
    stream: std::fs::File,
    next_id: u64,
}

impl MpvIpc {
    pub fn connect(path: &Path, timeout: Duration) -> Result<Self, IpcError> {
        let deadline = Instant::now() + timeout;
        loop {
            match try_connect(path) {
                Ok(stream) => {
                    set_read_timeout(&stream, Some(Duration::from_secs(5)))?;
                    set_write_timeout(&stream, Some(Duration::from_secs(5)))?;
                    return Ok(Self {
                        stream,
                        next_id: 1,
                    });
                }
                Err(e) => {
                    if Instant::now() >= deadline {
                        return Err(IpcError::Connect(e));
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
        }
    }

    pub fn command(&mut self, args: &[Value]) -> Result<Value, IpcError> {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let payload = json!({
            "command": args,
            "request_id": id,
        });
        let mut line = payload.to_string();
        line.push('\n');
        self.stream.write_all(line.as_bytes())?;
        self.stream.flush()?;

        let deadline = Instant::now() + Duration::from_secs(8);
        let mut reader = BufReader::new(self.stream.try_clone()?);
        loop {
            if Instant::now() > deadline {
                return Err(IpcError::Timeout);
            }
            let mut buf = String::new();
            let n = reader.read_line(&mut buf)?;
            if n == 0 {
                return Err(IpcError::Protocol("IPC closed".into()));
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(trimmed)
                .map_err(|e| IpcError::Protocol(format!("invalid JSON: {e}")))?;
            // Events have no request_id / have event field — skip until our reply.
            if value.get("event").is_some() && value.get("request_id").is_none() {
                continue;
            }
            let rid = value.get("request_id").and_then(|v| v.as_u64());
            if rid != Some(id) {
                continue;
            }
            let err = value
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("success");
            if err != "success" {
                return Err(IpcError::Protocol(err.to_string()));
            }
            return Ok(value.get("data").cloned().unwrap_or(Value::Null));
        }
    }

    pub fn set_property(&mut self, name: &str, value: Value) -> Result<(), IpcError> {
        self.command(&[json!("set_property"), json!(name), value])?;
        Ok(())
    }

    pub fn get_property(&mut self, name: &str) -> Result<Value, IpcError> {
        self.command(&[json!("get_property"), json!(name)])
    }

    pub fn loadfile(&mut self, path: &Path) -> Result<(), IpcError> {
        let path_str = path.to_string_lossy();
        self.command(&[json!("loadfile"), json!(path_str.as_ref()), json!("replace")])?;
        Ok(())
    }

    pub fn seek_absolute_secs(&mut self, secs: f64) -> Result<(), IpcError> {
        self.command(&[json!("seek"), json!(secs), json!("absolute")])?;
        Ok(())
    }

    pub fn set_pause(&mut self, paused: bool) -> Result<(), IpcError> {
        self.set_property("pause", json!(paused))
    }

    pub fn screenshot_to_file(&mut self, path: &Path) -> Result<(), IpcError> {
        let path_str = path.to_string_lossy();
        // "video" = without subtitles; works with vo=null after a decoded frame.
        self.command(&[
            json!("screenshot-to-file"),
            json!(path_str.as_ref()),
            json!("video"),
        ])?;
        Ok(())
    }
}

#[cfg(unix)]
fn try_connect(path: &Path) -> Result<std::os::unix::net::UnixStream, String> {
    std::os::unix::net::UnixStream::connect(path).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn try_connect(path: &Path) -> Result<std::fs::File, String> {
    // mpv expects `\\.\pipe\<name>`; we store the full pipe path as a Path.
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())
}

#[cfg(unix)]
fn set_read_timeout(
    stream: &std::os::unix::net::UnixStream,
    timeout: Option<Duration>,
) -> Result<(), IpcError> {
    stream.set_read_timeout(timeout)?;
    Ok(())
}

#[cfg(unix)]
fn set_write_timeout(
    stream: &std::os::unix::net::UnixStream,
    timeout: Option<Duration>,
) -> Result<(), IpcError> {
    stream.set_write_timeout(timeout)?;
    Ok(())
}

#[cfg(windows)]
fn set_read_timeout(_stream: &std::fs::File, _timeout: Option<Duration>) -> Result<(), IpcError> {
    Ok(())
}

#[cfg(windows)]
fn set_write_timeout(_stream: &std::fs::File, _timeout: Option<Duration>) -> Result<(), IpcError> {
    Ok(())
}

/// Drain leftover event lines (best-effort) — unused but handy for tests.
#[allow(dead_code)]
pub fn read_available_line(reader: &mut impl Read) -> Option<String> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1];
    loop {
        match reader.read(&mut tmp) {
            Ok(0) => break,
            Ok(_) => {
                if tmp[0] == b'\n' {
                    break;
                }
                buf.push(tmp[0]);
            }
            Err(_) => break,
        }
    }
    if buf.is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(&buf).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn command_payload_shape() {
        let args = vec![json!("seek"), json!(1.5), json!("absolute")];
        let payload = json!({ "command": args, "request_id": 7u64 });
        assert_eq!(payload["command"][0], "seek");
        assert_eq!(payload["request_id"], 7);
    }
}
