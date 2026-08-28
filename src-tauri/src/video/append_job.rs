//! ATS Nachreichen: copy extra media into a new `aktuell` staging folder with append manifest.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::media::datetime::{
    build_chrono_photo_filename, claim_unique_photo_filename, is_chrono_photo_filename,
};
use crate::media::dji_paths::{is_photo_ext, is_video_ext};
use crate::model::Kunde;
use crate::storage::config::AppConfig;
use crate::storage::logging::{self, file_name};
use crate::storage::vorgang_history::VorgangEntry;
use crate::video::export_paths::{
    OutputLayout, SUBDIR_HANDCAM_FOTO, SUBDIR_HANDCAM_VIDEO, SUBDIR_OUTSIDE_FOTO,
    SUBDIR_OUTSIDE_VIDEO, SUBDIR_PREVIEW_FOTO, SUBDIR_PREVIEW_VIDEO,
};
use crate::video::ffmpeg::{is_cancelled, FfmpegError, ProgressCallback};
use crate::video::handoff_manifest::write_append_handoff_manifest;
use crate::video::marker::write_marker_file;
use crate::video::processor::ProcessorError;
use crate::video::progress::EncodeProgress;
use crate::video::watermark::{create_photo_with_watermark, create_video_with_watermark, resolve_stamp};

pub const APPEND_FOLDER_SUFFIX: &str = "_nachreichung_";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppendCategory {
    HandcamVideo,
    HandcamFoto,
    OutsideVideo,
    OutsideFoto,
}

impl AppendCategory {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "handcam_video" | "hv" => Ok(Self::HandcamVideo),
            "handcam_foto" | "hf" => Ok(Self::HandcamFoto),
            "outside_video" | "ov" => Ok(Self::OutsideVideo),
            "outside_foto" | "of" => Ok(Self::OutsideFoto),
            other => Err(format!("Unbekannte Kategorie '{other}'.")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::HandcamVideo => "handcam_video",
            Self::HandcamFoto => "handcam_foto",
            Self::OutsideVideo => "outside_video",
            Self::OutsideFoto => "outside_foto",
        }
    }

    pub fn is_video(self) -> bool {
        matches!(self, Self::HandcamVideo | Self::OutsideVideo)
    }

    pub fn is_booked(self, v: &VorgangEntry) -> bool {
        match self {
            Self::HandcamVideo => v.handcam_video,
            Self::HandcamFoto => v.handcam_foto,
            Self::OutsideVideo => v.outside_video,
            Self::OutsideFoto => v.outside_foto,
        }
    }

    pub fn is_paid(self, v: &VorgangEntry) -> bool {
        self.is_booked(v)
            && match self {
                Self::HandcamVideo => v.ist_bezahlt_handcam_video,
                Self::HandcamFoto => v.ist_bezahlt_handcam_foto,
                Self::OutsideVideo => v.ist_bezahlt_outside_video,
                Self::OutsideFoto => v.ist_bezahlt_outside_foto,
            }
    }

    /// Ungebucht oder gebucht aber nicht bezahlt — gleiche Nachreich-Logik wie beim Erstellen.
    pub fn is_not_paid(self, v: &VorgangEntry) -> bool {
        !self.is_paid(v)
    }

    pub fn dest_subdir(self, preview: bool) -> &'static str {
        match (self, preview) {
            (Self::HandcamVideo, false) => SUBDIR_HANDCAM_VIDEO,
            (Self::HandcamFoto, false) => SUBDIR_HANDCAM_FOTO,
            (Self::OutsideVideo, false) => SUBDIR_OUTSIDE_VIDEO,
            (Self::OutsideFoto, false) => SUBDIR_OUTSIDE_FOTO,
            (_, true) if self.is_video() => SUBDIR_PREVIEW_VIDEO,
            (_, true) => SUBDIR_PREVIEW_FOTO,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppendMediaItem {
    pub path: String,
    pub category: String,
    #[serde(default)]
    pub preview: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppendJobResult {
    pub correlation_id: String,
    pub folder_name: String,
    pub folder_path: String,
    pub file_count: usize,
    pub preview_count: usize,
    pub categories: Vec<String>,
}

pub fn kunde_from_vorgang(entry: &VorgangEntry) -> Kunde {
    Kunde {
        kunden_id: entry.kunden_id.clone(),
        kunden_id_hash: entry.kunden_id_hash.clone(),
        booking_id: entry.booking_id.clone(),
        booking_id_hash: entry.booking_id_hash.clone(),
        vorname: entry.vorname.clone(),
        nachname: entry.nachname.clone(),
        email: None,
        telefon: None,
        gast: entry.gast.clone(),
        tandemmaster: entry.tandemmaster.clone(),
        videospringer: entry.videospringer.clone(),
        datum: entry.datum.clone(),
        ort: entry.ort.clone(),
        video_mode: entry.video_mode.clone(),
        form_mode: entry.form_mode.clone(),
        handcam_foto: entry.handcam_foto,
        handcam_video: entry.handcam_video,
        outside_foto: entry.outside_foto,
        outside_video: entry.outside_video,
        ist_bezahlt_handcam_foto: entry.ist_bezahlt_handcam_foto,
        ist_bezahlt_handcam_video: entry.ist_bezahlt_handcam_video,
        ist_bezahlt_outside_foto: entry.ist_bezahlt_outside_foto,
        ist_bezahlt_outside_video: entry.ist_bezahlt_outside_video,
    }
}

pub fn next_append_folder(speicherort: &Path, base_filename: &str) -> Result<(String, PathBuf), String> {
    if speicherort.as_os_str().is_empty() || !speicherort.is_dir() {
        return Err(format!(
            "Speicherort existiert nicht: {}",
            speicherort.display()
        ));
    }
    let base = base_filename.trim();
    if base.is_empty() {
        return Err("Vorgang ohne Ordnernamen.".into());
    }
    for n in 1..=99 {
        let name = format!("{base}{APPEND_FOLDER_SUFFIX}{n:02}");
        let path = speicherort.join(&name);
        if !path.exists() {
            return Ok((name, path));
        }
    }
    Err("Zu viele Nachreichungen für diesen Vorgang (99).".into())
}

fn emit(on_progress: &ProgressCallback, percent: f64, status: &str) {
    on_progress(EncodeProgress {
        percent: percent.clamp(0.0, 100.0),
        current_secs: percent.clamp(0.0, 100.0),
        total_secs: 100.0,
        status: status.into(),
        task_id: None,
    });
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_default()
}

fn copy_media_to_subdir(
    cat: AppendCategory,
    preview: bool,
    src: &Path,
    layout: &OutputLayout,
    used_names: &mut HashSet<String>,
) -> Result<(), ProcessorError> {
    let sub = cat.dest_subdir(preview);
    let dest_dir = layout.base_dir.join(sub);
    fs::create_dir_all(&dest_dir).map_err(|e| {
        ProcessorError::Message(format!("Unterordner '{sub}' anlegen: {e}"))
    })?;

    let basename = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "media.bin".into());
    let dest_name = if !cat.is_video() && !is_chrono_photo_filename(&basename) {
        build_chrono_photo_filename(src, used_names)
    } else {
        claim_unique_photo_filename(&basename, used_names)
    };
    let dest = dest_dir.join(&dest_name);
    fs::copy(src, &dest).map_err(|e| {
        ProcessorError::Message(format!(
            "Kopieren '{}' → '{}': {e}",
            src.display(),
            dest.display()
        ))
    })?;
    Ok(())
}

fn write_watermark_preview(
    cat: AppendCategory,
    src: &Path,
    layout: &OutputLayout,
    used_names: &mut HashSet<String>,
    ffmpeg: &Path,
    resource_dir: Option<&Path>,
    on_progress: &ProgressCallback,
) -> Result<(), ProcessorError> {
    let sub = cat.dest_subdir(true);
    let dest_dir = layout.base_dir.join(sub);
    fs::create_dir_all(&dest_dir).map_err(|e| {
        ProcessorError::Message(format!("Unterordner '{sub}' anlegen: {e}"))
    })?;

    if cat.is_video() {
        let stamp_ok = resolve_stamp(resource_dir);
        if stamp_ok.is_err() {
            return Err(ProcessorError::Message(
                "Preview-Stempel nicht gefunden.".into(),
            ));
        }
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "video".into());
        let out_name =
            claim_unique_photo_filename(&format!("{stem}_preview.mp4"), used_names);
        let dest = dest_dir.join(&out_name);
        let dest_str = dest.to_string_lossy().to_string();
        let src_str = src.to_string_lossy().to_string();
        let cb = Arc::clone(on_progress);
        create_video_with_watermark(ffmpeg, &src_str, &dest_str, resource_dir, cb)?;
        return Ok(());
    }

    let stamp = resolve_stamp(resource_dir)
        .map_err(|e| ProcessorError::Message(format!("Preview-Stempel: {e}")))?;
    let basename = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "photo.jpg".into());
    let candidate = if is_chrono_photo_filename(&basename) {
        basename
    } else {
        build_chrono_photo_filename(src, &mut HashSet::new())
    };
    let stem = Path::new(&candidate)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "photo".into());
    let out_name = claim_unique_photo_filename(&format!("{stem}.jpg"), used_names);
    let dest = dest_dir.join(&out_name);
    create_photo_with_watermark(src, &dest, &stamp)?;
    Ok(())
}

pub fn create_append_job(
    ffmpeg: &Path,
    vorgang: &VorgangEntry,
    items: &[AppendMediaItem],
    config: &AppConfig,
    resource_dir: Option<&Path>,
    on_progress: ProgressCallback,
) -> Result<AppendJobResult, ProcessorError> {
    if vorgang.correlation_id.trim().is_empty() {
        return Err(ProcessorError::Message(
            "Dieser Vorgang hat keinen AMS-Handoff (Lokal).".into(),
        ));
    }
    if items.is_empty() {
        return Err(ProcessorError::Message(
            "Bitte mindestens eine Datei zum Nachreichen wählen.".into(),
        ));
    }

    let speicherort = config.speicherort.trim();
    if speicherort.is_empty() {
        return Err(ProcessorError::Message(
            "Speicherort ist nicht gesetzt. Bitte Ordner wählen.".into(),
        ));
    }

    let parsed: Vec<(AppendCategory, bool, PathBuf)> = items
        .iter()
        .map(|item| {
            let cat = AppendCategory::parse(&item.category).map_err(ProcessorError::Message)?;
            let path = PathBuf::from(item.path.trim());
            if !path.is_file() {
                return Err(ProcessorError::Message(format!(
                    "Datei fehlt: {}",
                    path.display()
                )));
            }
            let ext = ext_of(&path);
            if cat.is_video() && !is_video_ext(&ext) {
                return Err(ProcessorError::Message(format!(
                    "'{}' ist kein Video.",
                    file_name(&path)
                )));
            }
            if !cat.is_video() && !is_photo_ext(&ext) {
                return Err(ProcessorError::Message(format!(
                    "'{}' ist kein Foto.",
                    file_name(&path)
                )));
            }
            let preview = item.preview;
            Ok((cat, preview, path))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let has_not_paid_photos = parsed
        .iter()
        .any(|(cat, _, _)| cat.is_not_paid(vorgang) && !cat.is_video());
    let has_not_paid_photo_preview = parsed.iter().any(|(cat, preview, _)| {
        cat.is_not_paid(vorgang) && !cat.is_video() && *preview
    });
    if has_not_paid_photos && !has_not_paid_photo_preview {
        return Err(ProcessorError::Message(
            "Foto-Produkt ist nicht bezahlt — bitte mindestens ein Foto für das Wasserzeichen auswählen.".into(),
        ));
    }

    let has_not_paid_videos = parsed
        .iter()
        .any(|(cat, _, _)| cat.is_not_paid(vorgang) && cat.is_video());
    let has_not_paid_video_preview = parsed.iter().any(|(cat, preview, _)| {
        cat.is_not_paid(vorgang) && cat.is_video() && *preview
    });
    if has_not_paid_videos && !has_not_paid_video_preview {
        return Err(ProcessorError::Message(
            "Video-Produkt ist nicht bezahlt — bitte mindestens ein Video für die Preview auswählen.".into(),
        ));
    }

    emit(&on_progress, 4.0, "Lege Nachreich-Ordner an…");
    let (folder_name, folder_path) = next_append_folder(Path::new(speicherort), &vorgang.base_filename)
        .map_err(ProcessorError::Message)?;
    fs::create_dir_all(&folder_path).map_err(|e| {
        ProcessorError::Message(format!(
            "Ordner '{}' anlegen: {e}",
            folder_path.display()
        ))
    })?;
    let layout = OutputLayout {
        base_dir: folder_path.clone(),
        base_filename: folder_name.clone(),
    };

    let kunde = kunde_from_vorgang(vorgang);
    let mut used_names: HashSet<String> = HashSet::new();
    let mut file_count = 0usize;
    let mut preview_count = 0usize;
    let mut categories: HashSet<String> = HashSet::new();
    let total = parsed.len().max(1);

    for (idx, (cat, preview, src)) in parsed.iter().enumerate() {
        if is_cancelled() {
            return Err(ProcessorError::Ffmpeg(FfmpegError::Cancelled));
        }
        let label = file_name(src);
        emit(
            &on_progress,
            8.0 + 80.0 * ((idx as f64) / total as f64),
            &format!("Verarbeite ({}/{}): {label}", idx + 1, total),
        );

        let not_paid = cat.is_not_paid(vorgang);

        // Original immer ins Produkt-Verzeichnis (wie beim Erstellen).
        let full_sub = cat.dest_subdir(false);
        categories.insert(full_sub.to_string());
        copy_media_to_subdir(*cat, false, src, &layout, &mut used_names)?;
        file_count += 1;

        if not_paid && *preview {
            let preview_sub = cat.dest_subdir(true);
            categories.insert(preview_sub.to_string());
            write_watermark_preview(
                *cat,
                src,
                &layout,
                &mut used_names,
                ffmpeg,
                resource_dir,
                &on_progress,
            )?;
            preview_count += 1;
            file_count += 1;
        }
    }

    emit(&on_progress, 92.0, "Schreibe AMS-Manifest…");
    let (correlation_id, _) = write_append_handoff_manifest(
        &layout,
        &kunde,
        config,
        &vorgang.correlation_id,
        Some(vorgang.id),
    )
    .map_err(ProcessorError::Message)?;

    emit(&on_progress, 96.0, "Schreibe _fertig.txt…");
    write_marker_file(&layout, &kunde, config).map_err(ProcessorError::Message)?;

    emit(&on_progress, 100.0, "Nachreichung bereit für AMS");
    logging::info(
        "append",
        format!(
            "Nachreichung fertig: {} ({} Datei(en), preview={preview_count}, cid={correlation_id})",
            layout.base_dir.display(),
            file_count
        ),
    );

    let mut cats: Vec<String> = categories.into_iter().collect();
    cats.sort();
    Ok(AppendJobResult {
        correlation_id,
        folder_name,
        folder_path: folder_path.to_string_lossy().to_string(),
        file_count,
        preview_count,
        categories: cats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_vorgang(base: &str) -> VorgangEntry {
        VorgangEntry {
            id: 1,
            created_at: String::new(),
            gast: "Max".into(),
            vorname: Some("Max".into()),
            nachname: Some("M".into()),
            kunden_id: None,
            booking_id: None,
            kunden_id_hash: None,
            booking_id_hash: None,
            datum: "15.08.2026".into(),
            ort: String::new(),
            tandemmaster: "TM".into(),
            videospringer: String::new(),
            video_mode: "handcam".into(),
            form_mode: "manual".into(),
            manual_entry_mode: String::new(),
            handcam_foto: false,
            handcam_video: true,
            outside_foto: false,
            outside_video: false,
            ist_bezahlt_handcam_foto: false,
            ist_bezahlt_handcam_video: true,
            ist_bezahlt_outside_foto: false,
            ist_bezahlt_outside_video: false,
            base_output_dir: String::new(),
            base_filename: base.into(),
            encoder: String::new(),
            intro_created: false,
            body_clips: 0,
            photos_copied: 0,
            watermark_photos: 0,
            marker_path: String::new(),
            reused_preview: false,
            qr_preview: None,
            file_count: 0,
            correlation_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            ams_state: "completed".into(),
            ams_updated_at: String::new(),
            ams_verified_at: String::new(),
            ams_error_code: String::new(),
            ams_error_message: String::new(),
            ams_archive: "erfolg".into(),
            ams_source: "outbox".into(),
            upload_state: "done".into(),
            append_count: 0,
            last_append_correlation_id: String::new(),
            last_append_ams_state: String::new(),
            last_append_ams_error_code: String::new(),
            last_append_ams_error_message: String::new(),
            last_append_folder_path: String::new(),
        }
    }

    #[test]
    fn next_folder_increments() {
        let dir = tempdir().unwrap();
        let (n1, p1) = next_append_folder(dir.path(), "JobA").unwrap();
        assert_eq!(n1, "JobA_nachreichung_01");
        fs::create_dir_all(&p1).unwrap();
        let (n2, _) = next_append_folder(dir.path(), "JobA").unwrap();
        assert_eq!(n2, "JobA_nachreichung_02");
    }

    #[test]
    fn unbooked_category_is_not_paid() {
        let v = sample_vorgang("JobA");
        let cat = AppendCategory::OutsideFoto;
        assert!(!cat.is_booked(&v));
        assert!(cat.is_not_paid(&v));
        assert_eq!(cat.dest_subdir(false), SUBDIR_OUTSIDE_FOTO);
        assert_eq!(cat.dest_subdir(true), SUBDIR_PREVIEW_FOTO);
        assert_eq!(
            AppendCategory::HandcamVideo.dest_subdir(false),
            SUBDIR_HANDCAM_VIDEO
        );
    }

    #[test]
    fn unpaid_booked_category_is_not_paid() {
        let mut v = sample_vorgang("JobA");
        v.handcam_foto = true;
        v.ist_bezahlt_handcam_foto = false;
        assert!(AppendCategory::HandcamFoto.is_booked(&v));
        assert!(AppendCategory::HandcamFoto.is_not_paid(&v));
        assert!(!AppendCategory::HandcamVideo.is_not_paid(&v));
    }

    #[test]
    fn paid_booked_category_is_paid() {
        let mut v = sample_vorgang("JobA");
        v.handcam_foto = true;
        v.ist_bezahlt_handcam_foto = true;
        assert!(AppendCategory::HandcamFoto.is_paid(&v));
        assert!(!AppendCategory::HandcamFoto.is_not_paid(&v));
    }

    #[test]
    fn category_parse() {
        assert_eq!(
            AppendCategory::parse("HV").unwrap(),
            AppendCategory::HandcamVideo
        );
        assert_eq!(AppendCategory::HandcamFoto.as_str(), "handcam_foto");
        assert!(AppendCategory::parse("nope").is_err());
    }
}
