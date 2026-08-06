//! Parse FFmpeg progress output (`-progress pipe:1`) and Duration lines from stderr.

use regex::Regex;
use serde::{Deserialize, Serialize};
use once_cell::sync::Lazy;

static DURATION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})").unwrap());

#[cfg(test)]
static TIME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})").unwrap());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodeProgress {
    /// 0.0 – 100.0 (per-task when `task_id` is set, otherwise overall / single job)
    pub percent: f64,
    /// Current position in seconds
    pub current_secs: f64,
    /// Total duration in seconds (0 if unknown)
    pub total_secs: f64,
    /// Raw FFmpeg progress status (`continue` / `end`) or stage label
    pub status: String,
    /// 1-based parallel task id (legacy `task_id`). `None` = overall / single job.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<u32>,
}

/// Parse `Duration: HH:MM:SS.cc` from FFmpeg stderr / probe output.
pub fn parse_duration(text: &str) -> Option<f64> {
    let caps = DURATION_RE.captures(text)?;
    hms_to_secs(&caps)
}

/// Parse a single key=value line from `-progress` output.
/// Returns updated current time in seconds when `out_time_ms` or `out_time_us` is seen,
/// or status string when `progress=` is seen.
#[derive(Debug, Clone, PartialEq)]
pub enum ProgressLine {
    OutTimeSecs(f64),
    Status(String),
    Other,
}

pub fn parse_progress_line(line: &str) -> ProgressLine {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("out_time_ms=") {
        if let Ok(ms) = rest.parse::<f64>() {
            return ProgressLine::OutTimeSecs(ms / 1_000.0);
        }
    }
    if let Some(rest) = line.strip_prefix("out_time_us=") {
        if let Ok(us) = rest.parse::<f64>() {
            return ProgressLine::OutTimeSecs(us / 1_000_000.0);
        }
    }
    // Fallback: out_time=HH:MM:SS.microseconds
    if let Some(rest) = line.strip_prefix("out_time=") {
        if let Some(secs) = parse_hms_flexible(rest) {
            return ProgressLine::OutTimeSecs(secs);
        }
    }
    if let Some(rest) = line.strip_prefix("progress=") {
        return ProgressLine::Status(rest.to_string());
    }
    ProgressLine::Other
}

/// Build an [`EncodeProgress`] from current/total seconds (no task id).
pub fn progress_from_times(current_secs: f64, total_secs: f64, status: &str) -> EncodeProgress {
    progress_from_times_with_task(current_secs, total_secs, status, None)
}

/// Build progress optionally tagged with a parallel `task_id` (1-based).
pub fn progress_from_times_with_task(
    current_secs: f64,
    total_secs: f64,
    status: &str,
    task_id: Option<u32>,
) -> EncodeProgress {
    let percent = if total_secs > 0.0 {
        ((current_secs / total_secs) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    EncodeProgress {
        percent,
        current_secs,
        total_secs,
        status: status.to_string(),
        task_id,
    }
}

/// Average of per-task percents → overall 0–100 (empty → 0).
#[allow(dead_code)] // available for backend overall aggregation
pub fn overall_percent(task_percents: &[f64]) -> f64 {
    if task_percents.is_empty() {
        return 0.0;
    }
    let sum: f64 = task_percents.iter().sum();
    (sum / task_percents.len() as f64).clamp(0.0, 100.0)
}

/// Parse `time=HH:MM:SS.cc` from classic stderr stats (optional fallback).
#[cfg(test)]
pub fn parse_time_stat(text: &str) -> Option<f64> {
    let caps = TIME_RE.captures(text)?;
    hms_to_secs(&caps)
}

fn hms_to_secs(caps: &regex::Captures<'_>) -> Option<f64> {
    let h: f64 = caps.get(1)?.as_str().parse().ok()?;
    let m: f64 = caps.get(2)?.as_str().parse().ok()?;
    let s: f64 = caps.get(3)?.as_str().parse().ok()?;
    let cs: f64 = caps.get(4)?.as_str().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s + cs / 100.0)
}

fn parse_hms_flexible(value: &str) -> Option<f64> {
    // HH:MM:SS.microseconds or N/A
    if value == "N/A" {
        return None;
    }
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_duration_from_ffmpeg_banner() {
        let text = "  Duration: 00:01:23.45, start: 0.000000, bitrate: 8000 kb/s";
        let secs = parse_duration(text).unwrap();
        assert!((secs - 83.45).abs() < 0.001);
    }

    #[test]
    fn parse_duration_hours() {
        let text = "Duration: 01:30:00.00";
        assert!((parse_duration(text).unwrap() - 5400.0).abs() < 0.001);
    }

    #[test]
    fn parse_progress_out_time_ms() {
        match parse_progress_line("out_time_ms=45000") {
            ProgressLine::OutTimeSecs(s) => assert!((s - 45.0).abs() < 0.001),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parse_progress_out_time_us() {
        match parse_progress_line("out_time_us=1500000") {
            ProgressLine::OutTimeSecs(s) => assert!((s - 1.5).abs() < 0.001),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parse_progress_status() {
        assert_eq!(
            parse_progress_line("progress=continue"),
            ProgressLine::Status("continue".into())
        );
        assert_eq!(
            parse_progress_line("progress=end"),
            ProgressLine::Status("end".into())
        );
    }

    #[test]
    fn progress_percent_clamped() {
        let p = progress_from_times(50.0, 100.0, "continue");
        assert!((p.percent - 50.0).abs() < 0.001);
        assert!(p.task_id.is_none());

        let p2 = progress_from_times(200.0, 100.0, "continue");
        assert!((p2.percent - 100.0).abs() < 0.001);

        let p3 = progress_from_times(10.0, 0.0, "continue");
        assert!((p3.percent - 0.0).abs() < 0.001);
    }

    #[test]
    fn progress_with_task_id() {
        let p = progress_from_times_with_task(25.0, 100.0, "continue", Some(2));
        assert!((p.percent - 25.0).abs() < 0.001);
        assert_eq!(p.task_id, Some(2));
    }

    #[test]
    fn overall_percent_average() {
        assert!((overall_percent(&[]) - 0.0).abs() < 0.001);
        assert!((overall_percent(&[50.0, 100.0]) - 75.0).abs() < 0.001);
    }

    #[test]
    fn parse_time_stat_fallback() {
        let line = "frame=  100 fps=25 q=28.0 size=    1024kB time=00:00:04.00 bitrate=2048.0kbits/s";
        assert!((parse_time_stat(line).unwrap() - 4.0).abs() < 0.001);
    }
}
