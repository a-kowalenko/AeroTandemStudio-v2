//! Creation / modification timestamps for display (port of legacy `file_times.py`).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Unix timestamp (seconds) for file creation when the OS provides it,
/// otherwise a sensible fallback (mtime on Linux without birth time).
pub fn get_creation_timestamp(path: &Path) -> Option<f64> {
    let meta = std::fs::metadata(path).ok()?;

    #[cfg(windows)]
    {
        return meta.created().ok().and_then(system_time_to_epoch);
    }

    #[cfg(not(windows))]
    {
        if let Ok(created) = meta.created() {
            return system_time_to_epoch(created);
        }
        meta.modified().ok().and_then(system_time_to_epoch)
    }
}

pub fn get_mtime_timestamp(path: &Path) -> Option<f64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(system_time_to_epoch)
}

fn system_time_to_epoch(t: SystemTime) -> Option<f64> {
    t.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn creation_timestamp_for_temp_file() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "hello").unwrap();
        let ts = get_creation_timestamp(f.path());
        assert!(ts.is_some());
        assert!(ts.unwrap() > 0.0);
    }
}
