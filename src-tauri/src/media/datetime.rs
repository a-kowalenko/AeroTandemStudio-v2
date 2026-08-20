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
    camera_from_exif(&exif)
}

fn camera_from_exif(exif: &exif::Exif) -> (String, String) {
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

fn exif_u32(field: &exif::Field) -> Option<u32> {
    match &field.value {
        Value::Long(v) => v.first().copied(),
        Value::Short(v) => v.first().map(|n| u32::from(*n)),
        _ => field
            .display_value()
            .to_string()
            .split_whitespace()
            .next()
            .and_then(|s| s.parse().ok()),
    }
}

fn get_exif_dimensions(path: &Path) -> Option<(u32, u32)> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = ExifReader::new().read_from_container(&mut reader).ok()?;
    pixel_size_from_exif(&exif)
}

fn pixel_size_from_exif(exif: &exif::Exif) -> Option<(u32, u32)> {
    let pair = |x: Tag, y: Tag| -> Option<(u32, u32)> {
        let w = exif.get_field(x, In::PRIMARY).and_then(exif_u32)?;
        let h = exif.get_field(y, In::PRIMARY).and_then(exif_u32)?;
        if w > 0 && h > 0 {
            Some((w, h))
        } else {
            None
        }
    };

    pair(Tag::PixelXDimension, Tag::PixelYDimension)
        .or_else(|| pair(Tag::ImageWidth, Tag::ImageLength))
}

/// Pixel size `(width, height)`; `(0, 0)` when unknown.
/// Prefers EXIF dimensions, then container headers via the `image` crate.
pub fn get_image_dimensions(path: &Path) -> (u32, u32) {
    if let Some(dims) = get_exif_dimensions(path) {
        return dims;
    }
    image::ImageReader::open(path)
        .ok()
        .and_then(|r| r.with_guessed_format().ok())
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((0, 0))
}

/// Camera Make/Model plus pixel size from a **single** EXIF open (batch import metadata).
///
/// Falls back to container headers for dimensions when EXIF has no size tags.
pub fn get_photo_import_metadata(path: &Path) -> ((String, String), (u32, u32)) {
    if let Ok(file) = File::open(path) {
        let mut reader = BufReader::new(file);
        if let Ok(exif) = ExifReader::new().read_from_container(&mut reader) {
            let camera = camera_from_exif(&exif);
            let dims = pixel_size_from_exif(&exif).unwrap_or_else(|| {
                image::ImageReader::open(path)
                    .ok()
                    .and_then(|r| r.with_guessed_format().ok())
                    .and_then(|r| r.into_dimensions().ok())
                    .unwrap_or((0, 0))
            });
            return (camera, dims);
        }
    }
    let dims = image::ImageReader::open(path)
        .ok()
        .and_then(|r| r.with_guessed_format().ok())
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((0, 0));
    ((String::new(), String::new()), dims)
}

/// EXIF DateTimeOriginal (+ SubSec) → (local datetime epoch, ms string).
///
/// Prefers `DateTimeOriginal` (capture). Falls back to `DateTime` for display
/// compatibility. Parsing uses ASCII/`DateTime::from_ascii`, not only `display_value`.
pub fn get_exif_capture_epoch(path: &Path) -> Option<(f64, String)> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = ExifReader::new().read_from_container(&mut reader).ok()?;
    read_exif_datetime_epoch(&exif, true)
}

/// Capture time for photo **naming/sort**: `DateTimeOriginal` only (not IFD0 `DateTime`,
/// which is often a modification stamp and can scramble series).
pub fn get_exif_datetime_original_epoch(path: &Path) -> Option<(f64, String)> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = ExifReader::new().read_from_container(&mut reader).ok()?;
    read_exif_datetime_epoch(&exif, false)
}

fn read_exif_datetime_epoch(exif: &exif::Exif, allow_datetime_fallback: bool) -> Option<(f64, String)> {
    let field = find_exif_field(exif, Tag::DateTimeOriginal).or_else(|| {
        if allow_datetime_fallback {
            find_exif_field(exif, Tag::DateTime)
        } else {
            None
        }
    })?;

    let mut edt = parse_exif_datetime_value(&field.value)?;
    if let Some(sub) = find_exif_field(exif, Tag::SubSecTimeOriginal)
        .or_else(|| find_exif_field(exif, Tag::SubSecTime))
    {
        if let Value::Ascii(parts) = &sub.value {
            if let Some(raw) = parts.first() {
                let _ = edt.parse_subsec(raw);
            }
        }
    }

    let naive = NaiveDateTime::new(
        chrono::NaiveDate::from_ymd_opt(edt.year as i32, edt.month as u32, edt.day as u32)?,
        chrono::NaiveTime::from_hms_opt(edt.hour as u32, edt.minute as u32, edt.second as u32)?,
    );
    // EXIF timestamps are naive camera-local; interpret as local wall time.
    let local = Local.from_local_datetime(&naive).single()
        .or_else(|| Local.from_local_datetime(&naive).earliest())?;
    let mut epoch = local.timestamp() as f64;
    let ms = match edt.nanosecond {
        Some(ns) => {
            let ms_val = ns / 1_000_000;
            epoch += f64::from(ms_val) / 1000.0;
            format!("{ms_val:03}")
        }
        None => "000".into(),
    };
    Some((epoch, ms))
}

fn find_exif_field(exif: &exif::Exif, tag: Tag) -> Option<&exif::Field> {
    exif.get_field(tag, In::PRIMARY)
        .or_else(|| exif.fields().find(|f| f.tag == tag))
}

fn parse_exif_datetime_value(value: &Value) -> Option<exif::DateTime> {
    let Value::Ascii(parts) = value else {
        return None;
    };
    let raw = parts.first()?;
    if let Ok(dt) = exif::DateTime::from_ascii(raw) {
        return Some(dt);
    }
    // Trim trailing NULs / spaces from padded ASCII fields.
    let trimmed: Vec<u8> = raw
        .iter()
        .copied()
        .rev()
        .skip_while(|&b| b == 0 || b == b' ')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if trimmed.len() >= 19 {
        if let Ok(dt) = exif::DateTime::from_ascii(&trimmed[..19]) {
            return Some(dt);
        }
    }
    let text = sanitize_exif_text(&String::from_utf8_lossy(raw));
    if text.len() >= 19 {
        return exif::DateTime::from_ascii(text[..19].as_bytes()).ok();
    }
    None
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
            if let Some(ts) = filesystem_capture_epoch(alt) {
                return ts;
            }
        }
    }
    // Prefer mtime over creation: after backup/copy, Windows `created` is the copy
    // instant (walk order), while mtime is preserved from the SD card (matches the
    // "Vorher bestätigen" date sort).
    filesystem_capture_epoch(copy_path).unwrap_or(0.0)
}

pub fn get_photo_display_epoch(photo_path: &Path, source_import_epoch: Option<f64>) -> f64 {
    resolve_video_display_epoch(photo_path, source_import_epoch, None)
}

/// mtime first, then creation — same priority as the SD confirm dialog fallback.
fn filesystem_capture_epoch(path: &Path) -> Option<f64> {
    get_mtime_timestamp(path).or_else(|| get_creation_timestamp(path))
}

fn ms_digits_from_epoch(epoch: f64) -> String {
    let frac = epoch - epoch.floor();
    format!("{:03}", ((frac * 1000.0).round() as u32).min(999))
}

/// Capture instant used for photo **sort + rename** (independent of SD dialog order).
///
/// 1. EXIF `DateTimeOriginal` (+ SubSec)
/// 2. else file mtime (preserved from SD on backup)
/// 3. else creation / now
#[derive(Debug, Clone)]
pub struct PhotoCaptureInstant {
    pub epoch: f64,
    pub wall: NaiveDateTime,
    pub ms: String,
}

impl PhotoCaptureInstant {
    fn from_epoch_and_ms(epoch: f64, ms: String) -> Self {
        let secs = epoch.floor() as i64;
        let wall = Local
            .timestamp_opt(secs, 0)
            .single()
            .or_else(|| Local.timestamp_opt(secs, 0).earliest())
            .map(|d| d.naive_local())
            .unwrap_or_else(|| Local::now().naive_local());
        Self { epoch, wall, ms }
    }
}

/// Resolve capture time for naming/sorting — same source for both so names match list order.
pub fn resolve_photo_capture_instant(photo_path: &Path) -> PhotoCaptureInstant {
    if let Some((epoch, ms)) = get_exif_datetime_original_epoch(photo_path) {
        return PhotoCaptureInstant::from_epoch_and_ms(epoch, ms);
    }
    let epoch = filesystem_capture_epoch(photo_path).unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0)
    });
    PhotoCaptureInstant::from_epoch_and_ms(epoch, ms_digits_from_epoch(epoch))
}

/// Sort key for photo import: EXIF DateTimeOriginal, else mtime. Dialog order is ignored.
pub fn photo_capture_sort_epoch(photo_path: &Path) -> f64 {
    resolve_photo_capture_instant(photo_path).epoch
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

/// Chronological photo name from capture time + import sequence.
///
/// `Foto_yyyyMMddHHmmssSSS_NNNN.ext` — the 4-digit sequence is the position after
/// sorting by EXIF capture time, so filename order matches capture order even when
/// several shots share the same second. Dialog sort order is irrelevant.
pub fn build_chrono_photo_filename_sequenced(
    photo_path: &Path,
    sequence: u32,
    used_names: &mut HashSet<String>,
) -> String {
    let instant = resolve_photo_capture_instant(photo_path);
    build_chrono_photo_filename_sequenced_with_instant(
        photo_path,
        &instant,
        sequence,
        used_names,
    )
}

/// Like [`build_chrono_photo_filename_sequenced`], reusing a precomputed capture instant
/// (avoids a second EXIF open after sort).
pub fn build_chrono_photo_filename_sequenced_with_instant(
    photo_path: &Path,
    instant: &PhotoCaptureInstant,
    sequence: u32,
    used_names: &mut HashSet<String>,
) -> String {
    let ext = normalize_photo_extension(photo_path);
    let seq = sequence.max(1);
    let base = format!(
        "Foto_{}{}_{:04}{ext}",
        instant.wall.format("%Y%m%d%H%M%S"),
        instant.ms,
        seq
    );
    claim_unique_photo_filename(&base, used_names)
}

/// Chronological photo name without sequence (export / single-file helpers).
pub fn build_chrono_photo_filename(photo_path: &Path, used_names: &mut HashSet<String>) -> String {
    let instant = resolve_photo_capture_instant(photo_path);
    let ext = normalize_photo_extension(photo_path);
    let base = format!(
        "Foto_{}{}{ext}",
        instant.wall.format("%Y%m%d%H%M%S"),
        instant.ms
    );
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

/// Sort paths by EXIF capture time (then path). Used by photo import.
///
/// Capture time is resolved **once per path** (not inside the comparator), so large
/// batches stay O(n) EXIF opens instead of O(n log n).
pub fn sort_paths_by_photo_capture_time(paths: &mut [String]) {
    let mut keyed: Vec<(f64, String)> = paths
        .iter()
        .map(|p| (photo_capture_sort_epoch(Path::new(p)), p.clone()))
        .collect();
    keyed.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.cmp(&b.1))
    });
    for (dst, (_, path)) in paths.iter_mut().zip(keyed) {
        *dst = path;
    }
}

/// Resolve capture instant once per existing file, sort by epoch (then path).
/// Prefer this for batch import so rename can reuse the same instant.
pub fn photos_sorted_by_capture_time(sources: &[String]) -> Vec<(String, PhotoCaptureInstant)> {
    let mut keyed: Vec<(String, PhotoCaptureInstant)> = sources
        .iter()
        .filter(|p| Path::new(p).is_file())
        .map(|p| {
            (
                p.clone(),
                resolve_photo_capture_instant(Path::new(p)),
            )
        })
        .collect();
    keyed.sort_by(|a, b| {
        a.1.epoch
            .partial_cmp(&b.1.epoch)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    keyed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::file_times::get_mtime_timestamp;
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
    fn filesystem_fallback_matches_mtime_when_no_exif() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "x").unwrap();
        let epoch = resolve_video_display_epoch(f.path(), None, None);
        let mtime = get_mtime_timestamp(f.path()).unwrap();
        // No EXIF on a text temp file → must use mtime (not a divergent creation stamp).
        assert!(
            (epoch - mtime).abs() < 1.0,
            "epoch={epoch} mtime={mtime}"
        );
    }

    #[test]
    fn ms_digits_from_epoch_uses_fraction() {
        assert_eq!(ms_digits_from_epoch(1_700_000_000.123), "123");
        assert_eq!(ms_digits_from_epoch(1_700_000_000.0), "000");
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
        let a = build_chrono_photo_filename_sequenced(f.path(), 1, &mut used);
        assert!(a.starts_with("Foto_"), "{a}");
        assert!(a.contains("_0001"), "{a}");
        assert!(a.ends_with(".JPG"), "{a}");
        assert!(is_chrono_photo_filename(&a));

        let b = build_chrono_photo_filename_sequenced(f.path(), 2, &mut used);
        assert_ne!(a, b);
        assert!(b.contains("_0002"), "{b}");
        assert!(is_chrono_photo_filename(&b));
    }

    #[test]
    fn sort_paths_orders_by_mtime_without_exif() {
        let dir = tempfile::tempdir().unwrap();
        let early = dir.path().join("a.jpg");
        let late = dir.path().join("b.jpg");
        fs::write(&early, b"a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&late, b"b").unwrap();
        // Ensure distinct mtimes even on coarse FS.
        let t_early = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let t_late = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_100);
        let _ = fs::File::options().write(true).open(&early).and_then(|f| f.set_modified(t_early));
        let _ = fs::File::options().write(true).open(&late).and_then(|f| f.set_modified(t_late));

        let mut paths = vec![
            late.to_string_lossy().into_owned(),
            early.to_string_lossy().into_owned(),
        ];
        sort_paths_by_photo_capture_time(&mut paths);
        assert_eq!(Path::new(&paths[0]), early.as_path());
        assert_eq!(Path::new(&paths[1]), late.as_path());
    }

    #[test]
    fn photos_sorted_reuses_instant_for_naming() {
        let dir = tempfile::tempdir().unwrap();
        let early = dir.path().join("a.jpg");
        let late = dir.path().join("b.jpg");
        fs::write(&early, b"a").unwrap();
        fs::write(&late, b"b").unwrap();
        let t_early = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let t_late = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_100);
        let _ = fs::File::options().write(true).open(&early).and_then(|f| f.set_modified(t_early));
        let _ = fs::File::options().write(true).open(&late).and_then(|f| f.set_modified(t_late));

        let sources = vec![
            late.to_string_lossy().into_owned(),
            early.to_string_lossy().into_owned(),
        ];
        let sorted = photos_sorted_by_capture_time(&sources);
        assert_eq!(sorted.len(), 2);
        assert_eq!(Path::new(&sorted[0].0), early.as_path());
        assert_eq!(Path::new(&sorted[1].0), late.as_path());

        let mut used = HashSet::new();
        let name = build_chrono_photo_filename_sequenced_with_instant(
            Path::new(&sorted[0].0),
            &sorted[0].1,
            1,
            &mut used,
        );
        assert!(name.starts_with("Foto_"), "{name}");
        assert!(name.contains("_0001"), "{name}");
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
