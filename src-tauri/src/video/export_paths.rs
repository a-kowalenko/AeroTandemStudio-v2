//! Legacy-compatible output folder / filename generation.
//!
//! Port of `VideoProcessor._generate_base_output_dir` / `_generate_video_output_path`
//! and `file_utils.sanitize_filename` / `normalize_whitespace_to_underscore`.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDate};

use crate::model::Kunde;

pub const SUBDIR_HANDCAM_VIDEO: &str = "Handcam_Video";
pub const SUBDIR_OUTSIDE_VIDEO: &str = "Outside_Video";
pub const SUBDIR_HANDCAM_FOTO: &str = "Handcam_Foto";
pub const SUBDIR_OUTSIDE_FOTO: &str = "Outside_Foto";
pub const SUBDIR_PREVIEW_VIDEO: &str = "Preview_Video";
pub const SUBDIR_PREVIEW_FOTO: &str = "Preview_Foto";
pub const MARKER_FILENAME: &str = "_fertig.txt";

/// Replace each whitespace run with a single underscore.
pub fn normalize_whitespace_to_underscore(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_ws = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push('_');
                prev_ws = true;
            }
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out
}

/// Strip characters invalid in Windows filenames.
pub fn sanitize_filename(filename: &str) -> String {
    const INVALID: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    filename
        .chars()
        .filter(|c| !INVALID.contains(c))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Format `DD.MM.YYYY` (or fall back to today) as `YYYYMMDD`.
pub fn format_datum_yyyyymmdd(datum: &str) -> String {
    let parts: Vec<&str> = datum.trim().split('.').collect();
    if parts.len() == 3 {
        if let (Ok(d), Ok(m), Ok(y)) = (
            parts[0].parse::<u32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<i32>(),
        ) {
            if let Some(date) = NaiveDate::from_ymd_opt(y, m, d) {
                return date.format("%Y%m%d").to_string();
            }
        }
    }
    // ISO fallback YYYY-MM-DD
    if let Ok(date) = NaiveDate::parse_from_str(datum.trim(), "%Y-%m-%d") {
        return date.format("%Y%m%d").to_string();
    }
    Local::now().format("%Y%m%d").to_string()
}

/// Unsanitized base name: `{date}_{gast}_TA_{tm}[_V_{vs}]`.
pub fn build_base_filename(
    gast: &str,
    tandemmaster: &str,
    videospringer: &str,
    datum: &str,
    outside_video: bool,
) -> String {
    let datum_fmt = format_datum_yyyyymmdd(datum);
    let mut base = format!("{datum_fmt}_{gast}_TA_{tandemmaster}");
    if outside_video {
        base.push_str(&format!("_V_{videospringer}"));
    }
    sanitize_filename(&normalize_whitespace_to_underscore(&base))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputLayout {
    pub base_dir: PathBuf,
    pub base_filename: String,
}

/// Create `{speicherort}/{base_filename}/` and return layout.
pub fn create_base_output_dir(
    speicherort: &Path,
    gast: &str,
    tandemmaster: &str,
    videospringer: &str,
    datum: &str,
    outside_video: bool,
) -> Result<OutputLayout, String> {
    if speicherort.as_os_str().is_empty() {
        return Err("Speicherort ist leer".into());
    }
    if !speicherort.is_dir() {
        return Err(format!(
            "Speicherort existiert nicht oder ist kein Ordner: {}",
            speicherort.display()
        ));
    }

    let base_filename = build_base_filename(gast, tandemmaster, videospringer, datum, outside_video);
    let base_dir = speicherort.join(&base_filename);
    fs::create_dir_all(&base_dir).map_err(|e| {
        format!(
            "Verzeichnis konnte nicht erstellt werden '{}': {e}",
            base_dir.display()
        )
    })?;

    Ok(OutputLayout {
        base_dir,
        base_filename,
    })
}

/// Subfolder for the paid/final video (Outside preferred over Handcam).
pub fn video_subdir_name(kunde: &Kunde) -> &'static str {
    if kunde.outside_video {
        SUBDIR_OUTSIDE_VIDEO
    } else if kunde.handcam_video {
        SUBDIR_HANDCAM_VIDEO
    } else {
        SUBDIR_HANDCAM_VIDEO
    }
}

pub fn video_output_path(layout: &OutputLayout, kunde: &Kunde) -> Result<PathBuf, String> {
    let sub = video_subdir_name(kunde);
    let dir = layout.base_dir.join(sub);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Unterordner '{sub}' konnte nicht erstellt werden: {e}"))?;
    Ok(dir.join(format!("{}.mp4", layout.base_filename)))
}

pub fn watermark_video_path(layout: &OutputLayout) -> Result<PathBuf, String> {
    let dir = layout.base_dir.join(SUBDIR_PREVIEW_VIDEO);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Unterordner '{SUBDIR_PREVIEW_VIDEO}' konnte nicht erstellt werden: {e}"))?;
    Ok(dir.join(format!("{}_preview.mp4", layout.base_filename)))
}

pub fn watermark_photo_dir(layout: &OutputLayout) -> Result<PathBuf, String> {
    let dir = layout.base_dir.join(SUBDIR_PREVIEW_FOTO);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Unterordner '{SUBDIR_PREVIEW_FOTO}' konnte nicht erstellt werden: {e}"))?;
    Ok(dir)
}

pub fn foto_subdir_for_handcam(layout: &OutputLayout) -> Result<PathBuf, String> {
    let dir = layout.base_dir.join(SUBDIR_HANDCAM_FOTO);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Unterordner '{SUBDIR_HANDCAM_FOTO}' konnte nicht erstellt werden: {e}"))?;
    Ok(dir)
}

pub fn foto_subdir_for_outside(layout: &OutputLayout) -> Result<PathBuf, String> {
    let dir = layout.base_dir.join(SUBDIR_OUTSIDE_FOTO);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Unterordner '{SUBDIR_OUTSIDE_FOTO}' konnte nicht erstellt werden: {e}"))?;
    Ok(dir)
}

pub fn marker_path(layout: &OutputLayout) -> PathBuf {
    layout.base_dir.join(MARKER_FILENAME)
}

pub fn needs_video_product(kunde: &Kunde) -> bool {
    kunde.handcam_video || kunde.outside_video
}

pub fn needs_foto_product(kunde: &Kunde) -> bool {
    kunde.handcam_foto || kunde.outside_foto
}

pub fn video_unpaid(kunde: &Kunde) -> bool {
    (kunde.handcam_video && !kunde.ist_bezahlt_handcam_video)
        || (kunde.outside_video && !kunde.ist_bezahlt_outside_video)
}

pub fn foto_unpaid(kunde: &Kunde) -> bool {
    (kunde.handcam_foto && !kunde.ist_bezahlt_handcam_foto)
        || (kunde.outside_foto && !kunde.ist_bezahlt_outside_foto)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sanitize_strips_invalid() {
        assert_eq!(sanitize_filename(r#"a<b>c:d"e/f\g|h?i*j"#), "abcdefghij");
    }

    #[test]
    fn whitespace_to_underscore() {
        assert_eq!(
            normalize_whitespace_to_underscore("Max  Mustermann"),
            "Max_Mustermann"
        );
    }

    #[test]
    fn datum_formats() {
        assert_eq!(format_datum_yyyyymmdd("06.08.2026"), "20260806");
        assert_eq!(format_datum_yyyyymmdd("2026-08-06"), "20260806");
    }

    #[test]
    fn base_filename_handcam() {
        let name = build_base_filename("Max", "Anna", "Bob", "06.08.2026", false);
        assert_eq!(name, "20260806_Max_TA_Anna");
    }

    #[test]
    fn base_filename_outside_includes_videospringer() {
        let name = build_base_filename("Max", "Anna", "Bob", "06.08.2026", true);
        assert_eq!(name, "20260806_Max_TA_Anna_V_Bob");
    }

    #[test]
    fn create_layout_and_video_path() {
        let tmp = tempdir().unwrap();
        let layout = create_base_output_dir(
            tmp.path(),
            "Max",
            "Anna",
            "Bob",
            "06.08.2026",
            false,
        )
        .unwrap();
        assert!(layout.base_dir.is_dir());

        let mut k = Kunde::default();
        k.handcam_video = true;
        let vp = video_output_path(&layout, &k).unwrap();
        assert!(vp
            .to_string_lossy()
            .contains(SUBDIR_HANDCAM_VIDEO));
        assert!(vp.file_name().unwrap().to_string_lossy().ends_with(".mp4"));

        k.outside_video = true;
        let vp2 = video_output_path(&layout, &k).unwrap();
        assert!(vp2
            .to_string_lossy()
            .contains(SUBDIR_OUTSIDE_VIDEO));
    }
}
