//! File logging to `app.log` plus an in-memory ring buffer for the debug console.
//!
//! A process-wide **minimum level** drops lower-severity lines before file write,
//! ring buffer, and batched `log-lines` IPC (Release default: INFO; Dev default: DEBUG).

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

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

/// Register a callback invoked for every new log line (see [`spawn_log_batch_emitter`]).
pub fn set_log_emitter<F>(f: F)
where
    F: Fn(&LogEntry) + Send + Sync + 'static,
{
    if let Ok(mut guard) = EMITTER.lock() {
        *guard = Some(Box::new(f));
    }
}

/// Flush interval for batched `log-lines` IPC (≤ 4 events/s; `ERROR` flushes early).
pub const LOG_BATCH_INTERVAL: Duration = Duration::from_millis(250);

/// Collects log entries between IPC flushes (order preserved).
pub struct LogBatcher {
    buf: Mutex<Vec<LogEntry>>,
    wake: Condvar,
}

impl LogBatcher {
    pub fn new() -> Self {
        Self {
            buf: Mutex::new(Vec::new()),
            wake: Condvar::new(),
        }
    }

    pub fn push(&self, entry: &LogEntry) {
        let Ok(mut buf) = self.buf.lock() else {
            return;
        };
        buf.push(entry.clone());
        if entry.level.eq_ignore_ascii_case("ERROR") {
            self.wake.notify_one();
        }
    }

    /// Wait up to `interval` (or until an `ERROR` arrives), then take everything buffered.
    pub fn next_batch(&self, interval: Duration) -> Vec<LogEntry> {
        let Ok(buf) = self.buf.lock() else {
            return Vec::new();
        };
        let has_error = |b: &Vec<LogEntry>| b.iter().any(|e| e.level.eq_ignore_ascii_case("ERROR"));
        let mut buf = if has_error(&buf) {
            buf
        } else {
            match self.wake.wait_timeout(buf, interval) {
                Ok((guard, _)) => guard,
                Err(_) => return Vec::new(),
            }
        };
        std::mem::take(&mut *buf)
    }
}

impl Default for LogBatcher {
    fn default() -> Self {
        Self::new()
    }
}

/// Route new log lines through a [`LogBatcher`]; a background thread hands each
/// non-empty batch to `sink` (e.g. one Tauri `log-lines` emit).
pub fn spawn_log_batch_emitter<F>(sink: F)
where
    F: Fn(Vec<LogEntry>) + Send + 'static,
{
    let batcher = Arc::new(LogBatcher::new());
    let for_emitter = Arc::clone(&batcher);
    set_log_emitter(move |entry| for_emitter.push(entry));
    let spawned = std::thread::Builder::new()
        .name("log-batch-emit".into())
        .spawn(move || loop {
            let batch = batcher.next_batch(LOG_BATCH_INTERVAL);
            if !batch.is_empty() {
                sink(batch);
            }
        });
    if let Err(e) = spawned {
        eprintln!("failed to spawn log batch emitter: {e}");
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
        file.write_all(&[0xEF, 0xBB, 0xBF])
            .map_err(|e| e.to_string())?;
    }
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;

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

    fn entry(id: u64, level: &str) -> LogEntry {
        LogEntry {
            id,
            ts: String::new(),
            level: level.into(),
            source: "test".into(),
            message: format!("m{id}"),
        }
    }

    #[test]
    fn log_batcher_collects_in_order_and_drains() {
        let b = LogBatcher::new();
        for id in 1..=5 {
            b.push(&entry(id, "INFO"));
        }
        let batch = b.next_batch(Duration::from_millis(10));
        assert_eq!(batch.iter().map(|e| e.id).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
        assert!(b.next_batch(Duration::from_millis(1)).is_empty());
    }

    #[test]
    fn log_batcher_error_flushes_without_waiting() {
        let b = LogBatcher::new();
        b.push(&entry(1, "INFO"));
        b.push(&entry(2, "ERROR"));
        let started = std::time::Instant::now();
        let batch = b.next_batch(Duration::from_secs(30));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(batch.len(), 2);
    }

    #[test]
    fn log_batcher_wakes_on_error_from_other_thread() {
        let b = Arc::new(LogBatcher::new());
        let pusher = Arc::clone(&b);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            pusher.push(&entry(7, "ERROR"));
        });
        let started = std::time::Instant::now();
        let mut got = Vec::new();
        while got.is_empty() && started.elapsed() < Duration::from_secs(5) {
            got = b.next_batch(Duration::from_secs(30));
        }
        t.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(got.first().map(|e| e.id), Some(7));
    }

    #[test]
    fn normalize_accepts_all_as_debug() {
        assert_eq!(normalize_min_level_name("all"), "debug");
        assert_eq!(normalize_min_level_name("INFO"), "info");
        assert_eq!(normalize_min_level_name("Warning"), "warn");
    }
}
