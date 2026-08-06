//! Display / sort timestamps for media (port of legacy `media_datetime.py`).

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use chrono::{Local, NaiveDateTime, TimeZone};
use exif::{In, Reader as ExifReader, Tag};

use crate::util::file_times::{get_creation_timestamp, get_mtime_timestamp};

/// EXIF DateTimeOriginal (+ SubSec) → (local datetime epoch, ms string).
pub fn get_exif_capture_epoch(path: &Path) -> Option<(f64, String)> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = ExifReader::new().read_from_container(&mut reader).ok()?;

    let raw = exif
        .get_field(Tag::DateTimeOriginal, In::PRIMARY)
        .or_else(|| exif.get_field(Tag::DateTime, In::PRIMARY))?;
    let text = raw.display_value().to_string();
    let text = text.trim().trim_matches('"');
    if text.len() < 19 {
        return None;
    }
    let dt = NaiveDateTime::parse_from_str(&text[..19], "%Y:%m:%d %H:%M:%S").ok()?;
    let local = Local.from_local_datetime(&dt).single()?;
    let mut epoch = local.timestamp() as f64;

    let subsec = exif
        .get_field(Tag::SubSecTimeOriginal, In::PRIMARY)
        .or_else(|| exif.get_field(Tag::SubSecTime, In::PRIMARY))
        .map(|f| f.display_value().to_string())
        .unwrap_or_default();
    let digits: String = subsec.chars().filter(|c| c.is_ascii_digit()).take(3).collect();
    let ms = if digits.is_empty() {
        "000".into()
    } else {
        format!("{:0<3}", digits)
    };
    if let Ok(ms_val) = ms.parse::<u32>() {
        epoch += f64::from(ms_val) / 1000.0;
    }
    Some((epoch, ms))
}

pub fn resolve_video_display_epoch(
    copy_path: &Path,
    source_import_epoch: Option<f64>,
    alternate_original_path: Option<&Path>,
) -> f64 {
    if let Some((epoch, _)) = get_exif_capture_epoch(copy_path) {
        return epoch;
    }
    if let Some(epoch) = source_import_epoch {
        return epoch;
    }
    if let Some(alt) = alternate_original_path {
        if alt != copy_path {
            if let Some(ts) = get_creation_timestamp(alt) {
                return ts;
            }
        }
    }
    get_creation_timestamp(copy_path)
        .or_else(|| get_mtime_timestamp(copy_path))
        .unwrap_or(0.0)
}

#[allow(dead_code)]
pub fn get_photo_display_epoch(photo_path: &Path, source_import_epoch: Option<f64>) -> f64 {
    resolve_video_display_epoch(photo_path, source_import_epoch, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn falls_back_to_filesystem_time() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "x").unwrap();
        let epoch = resolve_video_display_epoch(f.path(), None, None);
        assert!(epoch > 0.0);
    }

    #[test]
    fn prefers_source_import_epoch() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "x").unwrap();
        let epoch = resolve_video_display_epoch(f.path(), Some(12345.0), None);
        assert!((epoch - 12345.0).abs() < f64::EPSILON);
    }
}
