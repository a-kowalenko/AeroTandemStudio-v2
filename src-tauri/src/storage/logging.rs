//! File logging to `app.log` plus an in-memory ring buffer for the debug console.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::storage::app_config_dir;

const LOG_FILE_NAME: &str = "app.log";
const RING_CAPACITY: usize = 3000;

type LogEmitter = Box<dyn Fn(&LogEntry) + Send + Sync>;

static LOG_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static RING: Lazy<Mutex<VecDeque<LogEntry>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static EMITTER: Lazy<Mutex<Option<LogEmitter>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub id: u64,
    pub ts: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

/// Initialize logging: ensure AppData dir exists and write a startup banner.
pub fn init_logging() -> Result<PathBuf, String> {
    let dir = app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(LOG_FILE_NAME);

    {
        let mut guard = LOG_PATH.lock().map_err(|e| e.to_string())?;
        *guard = Some(path.clone());
    }

    let version = env!("CARGO_PKG_VERSION");
    append_line(
        "INFO",
        "app",
        &format!("=== Aero Tandem Studio v{version} starting ==="),
    )?;
    Ok(path)
}

/// Register a callback invoked for every new log line (e.g. Tauri `log-line` emit).
pub fn set_log_emitter<F>(f: F)
where
    F: Fn(&LogEntry) + Send + Sync + 'static,
{
    if let Ok(mut guard) = EMITTER.lock() {
        *guard = Some(Box::new(f));
    }
}

pub fn log_path() -> Option<PathBuf> {
    LOG_PATH.lock().ok().and_then(|g| g.clone())
}

#[allow(dead_code)]
pub fn log_debug(message: &str) {
    let _ = append_line("DEBUG", "app", message);
}

pub fn log_info(message: &str) {
    let _ = append_line("INFO", "app", message);
}

pub fn log_warn(message: &str) {
    let _ = append_line("WARN", "app", message);
}

pub fn log_error(message: &str) {
    let _ = append_line("ERROR", "app", message);
}

/// Log with an explicit source tag (e.g. `import`, `qr`, `encode`, `create`, `sd`).
#[allow(dead_code)]
pub fn log_with_source(level: &str, source: &str, message: &str) {
    let _ = append_line(level, source, message);
}

pub fn info(source: &str, message: impl AsRef<str>) {
    let _ = append_line("INFO", source, message.as_ref());
}

pub fn warn(source: &str, message: impl AsRef<str>) {
    let _ = append_line("WARN", source, message.as_ref());
}

pub fn error(source: &str, message: impl AsRef<str>) {
    let _ = append_line("ERROR", source, message.as_ref());
}

pub fn debug(source: &str, message: impl AsRef<str>) {
    let _ = append_line("DEBUG", source, message.as_ref());
}

/// Basename for concise log lines (falls back to the full path).
pub fn file_name(path: impl AsRef<Path>) -> String {
    path.as_ref()
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.as_ref().to_string_lossy().into_owned())
}

/// Snapshot of the in-memory ring buffer (oldest → newest).
pub fn recent_logs(limit: Option<usize>) -> Vec<LogEntry> {
    let Ok(guard) = RING.lock() else {
        return Vec::new();
    };
    let cap = limit.unwrap_or(RING_CAPACITY).min(guard.len());
    guard
        .iter()
        .rev()
        .take(cap)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// Clear only the in-memory console buffer (file is unchanged).
pub fn clear_ring_buffer() {
    if let Ok(mut guard) = RING.lock() {
        guard.clear();
    }
}

fn append_line(level: &str, source: &str, message: &str) -> Result<(), String> {
    let path = {
        let guard = LOG_PATH.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(p) => p.clone(),
            None => {
                // Lazy init if setup skipped (e.g. unit tests calling log_*).
                let dir = app_config_dir().map_err(|e| e.to_string())?;
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                dir.join(LOG_FILE_NAME)
            }
        }
    };

    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let line = format!("[{ts}] [{level}] {message}\n");

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    // UTF-8 with BOM on first create helps Windows editors display umlauts.
    if file.metadata().map(|m| m.len()).unwrap_or(1) == 0 {
        file.write_all(&[0xEF, 0xBB, 0xBF]).map_err(|e| e.to_string())?;
    }
    file.write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;

    let entry = LogEntry {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        ts,
        level: level.to_string(),
        source: source.to_string(),
        message: message.to_string(),
    };

    push_ring(entry.clone());
    emit_log_line(&entry);

    Ok(())
}

fn push_ring(entry: LogEntry) {
    if let Ok(mut guard) = RING.lock() {
        if guard.len() >= RING_CAPACITY {
            guard.pop_front();
        }
        guard.push_back(entry);
    }
}

fn emit_log_line(entry: &LogEntry) {
    if let Ok(guard) = EMITTER.lock() {
        if let Some(emit) = guard.as_ref() {
            emit(entry);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn init_logging_creates_file_and_writes() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_ring_buffer();
        let path = init_logging().expect("init logging");
        assert!(path.ends_with(LOG_FILE_NAME));
        assert!(path.is_file());
        log_info("unit-test-info");
        log_error("unit-test-error");
        let content = fs::read_to_string(&path).expect("read log");
        assert!(content.contains("Aero Tandem Studio"));
        assert!(content.contains("unit-test-info"));
        assert!(content.contains("unit-test-error"));

        let recent = recent_logs(Some(50));
        assert!(recent.iter().any(|e| e.message.contains("unit-test-info")));
        assert!(recent.iter().any(|e| e.level == "ERROR"));
    }

    #[test]
    fn ring_buffer_respects_clear() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_ring_buffer();
        log_info("before-clear");
        assert!(!recent_logs(None).is_empty());
        clear_ring_buffer();
        assert!(recent_logs(None).is_empty());
    }
}
