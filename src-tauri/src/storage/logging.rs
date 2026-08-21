//! File logging to `app.log` plus an in-memory ring buffer for the debug console.
//!
//! A process-wide **minimum level** drops lower-severity lines before file write,
//! ring buffer, and `log-line` IPC (Release default: INFO; Dev default: DEBUG).

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::storage::app_config_dir;

const LOG_FILE_NAME: &str = "app.log";
const RING_CAPACITY: usize = 3000;

const RANK_DEBUG: u8 = 10;
const RANK_INFO: u8 = 20;
const RANK_WARN: u8 = 30;
const RANK_ERROR: u8 = 40;

type LogEmitter = Box<dyn Fn(&LogEntry) + Send + Sync>;

static LOG_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static RING: Lazy<Mutex<VecDeque<LogEntry>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static EMITTER: Lazy<Mutex<Option<LogEmitter>>> = Lazy::new(|| Mutex::new(None));
static MIN_LEVEL_RANK: AtomicU8 = AtomicU8::new(if cfg!(debug_assertions) {
    RANK_DEBUG
} else {
    RANK_INFO
});

fn default_min_level_rank() -> u8 {
    if cfg!(debug_assertions) {
        RANK_DEBUG
    } else {
        RANK_INFO
    }
}

/// Default min level name for new configs (`"debug"` in Dev, `"info"` in Release).
pub fn default_min_level_name() -> String {
    rank_to_name(default_min_level_rank()).to_string()
}

fn level_rank(level: &str) -> u8 {
    match level.to_ascii_uppercase().as_str() {
        "DEBUG" => RANK_DEBUG,
        "WARN" | "WARNING" => RANK_WARN,
        "ERROR" => RANK_ERROR,
        _ => RANK_INFO,
    }
}

fn rank_to_name(rank: u8) -> &'static str {
    match rank {
        r if r <= RANK_DEBUG => "debug",
        r if r <= RANK_INFO => "info",
        r if r <= RANK_WARN => "warn",
        _ => "error",
    }
}

/// Normalize UI/config strings to `debug` | `info` | `warn` | `error`.
pub fn normalize_min_level_name(raw: &str) -> String {
    let t = raw.trim().to_ascii_lowercase();
    match t.as_str() {
        "all" | "debug" | "dbg" => "debug".into(),
        "warn" | "warning" => "warn".into(),
        "error" | "err" => "error".into(),
        _ => "info".into(),
    }
}

fn name_to_rank(name: &str) -> u8 {
    match normalize_min_level_name(name).as_str() {
        "debug" => RANK_DEBUG,
        "warn" => RANK_WARN,
        "error" => RANK_ERROR,
        _ => RANK_INFO,
    }
}

/// Current minimum level (`debug` | `info` | `warn` | `error`).
pub fn min_level_name() -> String {
    rank_to_name(MIN_LEVEL_RANK.load(Ordering::Relaxed)).to_string()
}

/// Set minimum level from a config/UI string. Returns the normalized name.
pub fn set_min_level_name(raw: &str) -> String {
    let name = normalize_min_level_name(raw);
    MIN_LEVEL_RANK.store(name_to_rank(&name), Ordering::Relaxed);
    name
}

/// Apply config value at startup / after save.
pub fn apply_min_level_from_config(raw: &str) {
    let _ = set_min_level_name(raw);
}

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
    if level_rank(level) < MIN_LEVEL_RANK.load(Ordering::Relaxed) {
        return Ok(());
    }

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
        let prev = min_level_name();
        set_min_level_name("debug");
        let path = init_logging().expect("init logging");
        assert!(path.ends_with(LOG_FILE_NAME));
        assert!(path.is_file());
        log_info("unit-test-info");
        log_error("unit-test-error");
        set_min_level_name(&prev);
    }

    #[test]
    fn min_level_drops_debug_from_ring() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_ring_buffer();
        let prev = min_level_name();
        set_min_level_name("info");
        let _ = init_logging();
        clear_ring_buffer();
        debug("import", "should-be-dropped");
        info("import", "should-remain");
        let lines = recent_logs(None);
        assert!(
            lines.iter().all(|e| e.message != "should-be-dropped"),
            "debug must not enter ring at INFO min: {lines:?}"
        );
        assert!(
            lines.iter().any(|e| e.message == "should-remain"),
            "info must remain: {lines:?}"
        );
        set_min_level_name(&prev);
    }

    #[test]
    fn normalize_accepts_all_as_debug() {
        assert_eq!(normalize_min_level_name("all"), "debug");
        assert_eq!(normalize_min_level_name("INFO"), "info");
        assert_eq!(normalize_min_level_name("Warning"), "warn");
    }
}
