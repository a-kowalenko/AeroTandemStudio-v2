//! Display / sort timestamps for media (port of legacy `media_datetime.py`).

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Local, NaiveDateTime, TimeZone};
use exif::{In, Reader as ExifReader, Tag, Value};

use crate::util::file_times::{get_creation_timestamp, get_mtime_timestamp};

fn sanitize_exif_text(raw: &str) -> String {
    raw.trim().trim_matches('"').trim_matches('\'').trim().to_string()
}

/// Clean camera make/model text from EXIF display strings or FFmpeg metadata.
///
/// kamadak-exif formats multi-component ASCII as `"a", "b", "c"`; empty padding
/// becomes `"", "", ""` which must not surface in the UI.
pub(crate) fn sanitize_camera_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Quoted display / probe forms: `"GoPro"`, `"", "", ""`, `"DJI", ""`
    if trimmed.contains('"') || trimmed.contains('\'') {
        for segment in trimmed.split(',') {
            let seg = segment
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim();
            if !seg.is_empty() {
                return seg.to_string();
            }
        }
        return String::new();
    }
    sanitize_exif_text(trimmed)
}

fn ascii_camera_field(field: &exif::Field) -> String {
    match &field.value {
        Value::Ascii(parts) => {
            for part in parts {
                let text = String::from_utf8_lossy(part);
                let cleaned = sanitize_camera_text(&text);
                if !cleaned.is_empty() {
                    return cleaned;
                }
            }
            String::new()
        }
        _ => sanitize_camera_text(&field.display_value().to_string()),
    }
}

/// EXIF Make / Model → `(make, model)`; empty strings when missing.
pub fn get_exif_camera(path: &Path) -> (String, String) {
    let Ok(file) = File::open(path) else {
        return (String::new(), String::new());
    };
    let mut reader = BufReader::new(file);
    let Ok(exif) = ExifReader::new().read_from_container(&mut reader) else {
        return (String::new(), String::new());
    };

    let make = exif
        .get_field(Tag::Make, In::PRIMARY)
        .map(ascii_camera_field)
        .unwrap_or_default();
    let model = exif
        .get_field(Tag::Model, In::PRIMARY)
        .map(ascii_camera_field)
        .unwrap_or_default();
    (make, model)
}

/// EXIF DateTimeOriginal (+ SubSec) → (local datetime epoch, ms string).
pub fn get_exif_capture_epoch(path: &Path) -> Option<(f64, String)> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = ExifReader::new().read_from_container(&mut reader).ok()?;

    let raw = exif
        .get_field(Tag::DateTimeOriginal, In::PRIMARY)
        .or_else(|| exif.get_field(Tag::DateTime, In::PRIMARY))?;
    let text = sanitize_exif_text(&raw.display_value().to_string());
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

pub fn get_photo_display_epoch(photo_path: &Path, source_import_epoch: Option<f64>) -> f64 {
    resolve_video_display_epoch(photo_path, source_import_epoch, None)
}

/// Capture instant for naming: EXIF (+ SubSec), else filesystem creation/mtime, else now.
fn photo_capture_parts(photo_path: &Path) -> (NaiveDateTime, String) {
    if let Some((epoch, ms)) = get_exif_capture_epoch(photo_path) {
        let secs = epoch.floor() as i64;
        if let Some(dt) = Local.timestamp_opt(secs, 0).single() {
            return (dt.naive_local(), ms);
        }
    }
    let epoch = get_creation_timestamp(photo_path)
        .or_else(|| get_mtime_timestamp(photo_path))
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0)
        });
    let secs = epoch.floor() as i64;
    let frac = epoch - secs as f64;
    let ms = format!("{:03}", ((frac * 1000.0).round() as u32).min(999));
    let dt = Local
        .timestamp_opt(secs, 0)
        .single()
        .map(|d| d.naive_local())
        .unwrap_or_else(|| Local::now().naive_local());
    (dt, ms)
}

fn normalize_photo_extension(photo_path: &Path) -> String {
    let ext = photo_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("JPG");
    if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
        ".JPG".into()
    } else {
        format!(".{}", ext.to_ascii_uppercase())
    }
}

/// Claim `name` in `used` (case-insensitive). Returns false if already taken.
fn try_claim_name(name: &str, used: &mut HashSet<String>) -> bool {
    let key = name.to_ascii_lowercase();
    if used.contains(&key) {
        return false;
    }
    used.insert(key);
    true
}

/// Append `_001`, `_002`, … before the extension until unique in `used`.
pub fn claim_unique_photo_filename(base_name: &str, used: &mut HashSet<String>) -> String {
    if try_claim_name(base_name, used) {
        return base_name.to_string();
    }
    let (stem, ext) = match base_name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (base_name.to_string(), String::new()),
    };
    let mut counter = 1u32;
    loop {
        let candidate = format!("{stem}_{counter:03}{ext}");
        if try_claim_name(&candidate, used) {
            return candidate;
        }
        counter += 1;
        if counter > 10_000 {
            let fallback = format!("{stem}_{counter}{ext}");
            used.insert(fallback.to_ascii_lowercase());
            return fallback;
        }
    }
}

/// Chronological photo name: `Foto_yyyyMMddHHmmssSSS[_nnn].JPG` (legacy timelapse scheme).
///
/// Used on import so DJI series with identical camera names stay sortable by filename.
/// `used_names` holds lowercase basenames already reserved (updated in place).
pub fn build_chrono_photo_filename(photo_path: &Path, used_names: &mut HashSet<String>) -> String {
    let (dt, ms) = photo_capture_parts(photo_path);
    let ext = normalize_photo_extension(photo_path);
    let base = format!("Foto_{}{}{ext}", dt.format("%Y%m%d%H%M%S"), ms);
    claim_unique_photo_filename(&base, used_names)
}

/// Lowercase basenames of existing files in `dir` (for collision tracking across imports).
pub fn collect_used_filenames_in(dir: &Path) -> HashSet<String> {
    let mut used = HashSet::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return used;
    };
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                used.insert(name.to_ascii_lowercase());
            }
        }
    }
    used
}

/// Whether `filename` already follows the chrono import pattern (`Foto_…`).
pub fn is_chrono_photo_filename(filename: &str) -> bool {
    crate::media::dji_paths::is_timelapse_photo_filename(filename)
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

    #[test]
    fn sanitize_camera_drops_empty_quote_padding() {
        assert_eq!(sanitize_camera_text("\"\", \"\", \"\""), "");
        assert_eq!(sanitize_camera_text("\"\""), "");
        assert_eq!(sanitize_camera_text("'','',''"), "");
        assert_eq!(sanitize_camera_text(""), "");
        assert_eq!(sanitize_camera_text("   "), "");
    }

    #[test]
    fn sanitize_camera_keeps_real_make_model() {
        assert_eq!(sanitize_camera_text("\"GoPro\""), "GoPro");
        assert_eq!(sanitize_camera_text("\"HERO11 Black\""), "HERO11 Black");
        assert_eq!(sanitize_camera_text("\"DJI\", \"\""), "DJI");
        assert_eq!(sanitize_camera_text("OsmoAction4"), "OsmoAction4");
        assert_eq!(sanitize_camera_text("  GoPro  "), "GoPro");
    }

    #[test]
    fn chrono_photo_filename_claims_and_collides() {
        let mut f = NamedTempFile::with_suffix(".JPG").unwrap();
        writeln!(f, "x").unwrap();
        let mut used = HashSet::new();
        let a = build_chrono_photo_filename(f.path(), &mut used);
        assert!(a.starts_with("Foto_"), "{a}");
        assert!(a.ends_with(".JPG"), "{a}");
        assert!(is_chrono_photo_filename(&a));

        let b = build_chrono_photo_filename(f.path(), &mut used);
        assert_ne!(a, b);
        assert!(b.contains("_001") || b.contains("_002"), "{b}");
        assert!(is_chrono_photo_filename(&b));
    }

    #[test]
    fn claim_unique_keeps_first_and_suffixes() {
        let mut used = HashSet::new();
        assert_eq!(
            claim_unique_photo_filename("Foto_20240101120000000.JPG", &mut used),
            "Foto_20240101120000000.JPG"
        );
        assert_eq!(
            claim_unique_photo_filename("Foto_20240101120000000.JPG", &mut used),
            "Foto_20240101120000000_001.JPG"
        );
        assert_eq!(
            claim_unique_photo_filename("foto_20240101120000000.jpg", &mut used),
            "foto_20240101120000000_002.jpg"
        );
    }

    #[test]
    fn collect_used_filenames_reads_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("Foto_20240101120000000.JPG"), b"a").unwrap();
        fs::write(dir.path().join("other.PNG"), b"b").unwrap();
        let used = collect_used_filenames_in(dir.path());
        assert!(used.contains("foto_20240101120000000.jpg"));
        assert!(used.contains("other.png"));
    }
}
