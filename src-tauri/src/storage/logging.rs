//! Simple file logging to `app.log` under the app data directory.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::storage::app_config_dir;

const LOG_FILE_NAME: &str = "app.log";

static LOG_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

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
        &format!("=== Aero Tandem Studio v{version} starting ==="),
    )?;
    Ok(path)
}

pub fn log_path() -> Option<PathBuf> {
    LOG_PATH.lock().ok().and_then(|g| g.clone())
}

pub fn log_info(message: &str) {
    let _ = append_line("INFO", message);
}

pub fn log_warn(message: &str) {
    let _ = append_line("WARN", message);
}

pub fn log_error(message: &str) {
    let _ = append_line("ERROR", message);
}

fn append_line(level: &str, message: &str) -> Result<(), String> {
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

    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_logging_creates_file_and_writes() {
        let path = init_logging().expect("init logging");
        assert!(path.ends_with(LOG_FILE_NAME));
        assert!(path.is_file());
        log_info("unit-test-info");
        log_error("unit-test-error");
        let content = fs::read_to_string(&path).expect("read log");
        assert!(content.contains("Aero Tandem Studio"));
        assert!(content.contains("unit-test-info"));
        assert!(content.contains("unit-test-error"));
    }
}
