//! Unified create/export job: folders, video, photos, watermarks, `_fertig.txt`.
//!
//! Behaviour port of legacy `_execute_video_creation_with_intro_only`.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::media::datetime::{
    build_chrono_photo_filename, claim_unique_photo_filename, is_chrono_photo_filename,
};
use crate::model::Kunde;
use crate::storage::config::AppConfig;
use crate::storage::logging::{self, file_name};
use crate::video::export_paths::{
    create_base_output_dir, foto_subdir_for_handcam, foto_subdir_for_outside, needs_foto_product,
    needs_video_product, foto_unpaid, video_output_path, video_unpaid, watermark_photo_dir,
    watermark_video_path, OutputLayout,
};
use crate::video::ffmpeg::{is_cancelled, probe_duration_secs, FfmpegError, ProgressCallback};
use crate::video::handoff_manifest::write_handoff_manifest;
use crate::video::marker::write_marker_file;
use crate::video::processor::{
    create_video, CreateVideoOptions, CreateVideoResult, IntroMuxAskFn, ProcessorError,
};
use crate::video::progress::EncodeProgress;
use crate::video::preview_reuse;
use crate::video::watermark::{
    create_photo_with_watermark, create_video_with_watermark, resolve_stamp,
};

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CreateJobOptions {
    #[serde(default)]
    pub watermark_clip_index: Option<usize>,
    #[serde(default)]
    pub watermark_photo_indices: Vec<usize>,
    /// Absolute path of a previously generated preview MP4 to reuse as the final video.
    #[serde(default)]
    pub reuse_preview_path: Option<String>,
    /// Fingerprint returned by `generate_preview` for the same form + clips.
    #[serde(default)]
    pub reuse_preview_fingerprint: Option<String>,
    #[serde(default, flatten)]
    pub video: CreateVideoOptions,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateJobResult {
    pub base_output_dir: String,
    pub base_filename: String,
    pub video_output: Option<String>,
    pub watermark_video: Option<String>,
    pub photos_copied: usize,
    pub watermark_photos: usize,
    pub marker_path: String,
    pub encoder: String,
    pub intro_created: bool,
    pub body_clips: usize,
    /// True when the final product video was copied from a matching preview.
    pub reused_preview: bool,
    /// AMS handoff correlation id (empty when Lokal / skip_marker_file).
    pub correlation_id: String,
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

fn ensure_not_cancelled() -> Result<(), ProcessorError> {
    if is_cancelled() {
        Err(ProcessorError::Ffmpeg(FfmpegError::Cancelled))
    } else {
        Ok(())
    }
}

/// Remap nested overall progress into `[lo, hi]`. Per-task (`task_id`) percents stay 0–100
/// for clip bars; an additional overall event is emitted from the mean of active tasks.
fn map_stage_progress(
    outer: ProgressCallback,
    lo: f64,
    hi: f64,
    stage_label: &'static str,
) -> ProgressCallback {
    let span = (hi - lo).max(0.0);
    let task_pcts = Arc::new(std::sync::Mutex::new(std::collections::HashMap::<u32, f64>::new()));
    Arc::new(move |p: EncodeProgress| {
        if let Some(tid) = p.task_id {
            // Clip-level bar (0–100)
            outer(p.clone());

            let avg = {
                let mut map = task_pcts.lock().unwrap_or_else(|e| e.into_inner());
                map.insert(tid, p.percent.clamp(0.0, 100.0));
                let n = map.len().max(1) as f64;
                map.values().sum::<f64>() / n
            };
            outer(EncodeProgress {
                percent: lo + (avg / 100.0) * span,
                current_secs: p.current_secs,
                total_secs: p.total_secs.max(100.0),
                status: stage_label.into(),
                task_id: None,
            });
        } else {
            let mut q = p;
            q.percent = lo + (q.percent.clamp(0.0, 100.0) / 100.0) * span;
            if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                q.status = stage_label.into();
            }
            // New overall stage — reset clip averages
            if let Ok(mut map) = task_pcts.lock() {
                map.clear();
            }
            outer(q);
        }
    })
}

/// Validate products + media before starting the job (UI can call via command).
pub fn validate_create_job(
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    watermark_photo_indices: &[usize],
    oldschool_mode: bool,
) -> Vec<String> {
    let mut errors = crate::model::validate_kunde(kunde, &[], oldschool_mode).errors;

    let video_prod = needs_video_product(kunde);
    let foto_prod = needs_foto_product(kunde);

    if !video_prod && !foto_prod {
        errors.push(
            "Bitte wählen Sie mindestens ein Produkt aus (Handcam/Outside Foto oder Video)."
                .into(),
        );
    }

    if video_prod && video_paths.is_empty() {
        errors.push(
            "Sie haben ein Video-Produkt ausgewählt, aber keine Videos hinzugefügt.".into(),
        );
    }

    if foto_prod && photo_paths.is_empty() {
        errors.push("Sie haben ein Foto-Produkt ausgewählt, aber keine Fotos hinzugefügt.".into());
    }

    // Existing .mp4 checks only when we will encode video
    if video_prod {
        for path in video_paths {
            let lower = path.to_lowercase();
            if !lower.ends_with(".mp4") {
                errors.push(format!("'{path}' ist keine .mp4 Datei"));
            } else if !Path::new(path).exists() {
                errors.push(format!("Datei '{path}' existiert nicht"));
            }
        }
    }

    if foto_unpaid(kunde) && watermark_photo_indices.is_empty() && !photo_paths.is_empty() {
        errors.push(
            "Foto-Produkt ist nicht bezahlt — bitte mindestens ein Foto für das Wasserzeichen auswählen."
                .into(),
        );
    }

    errors
}

fn build_photo_rename_map(photo_paths: &[String]) -> HashMap<String, String> {
    let mut used = std::collections::HashSet::new();
    let mut mapping = HashMap::new();

    for src in photo_paths {
        let path = Path::new(src);
        if !path.is_file() {
            continue;
        }
        let basename = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "photo.jpg".into());

        // Already chrono-named on import → keep (with `_001` on collision).
        // Otherwise rebuild from EXIF/mtime so export order matches capture time.
        let candidate = if is_chrono_photo_filename(&basename) {
            claim_unique_photo_filename(&basename, &mut used)
        } else {
            build_chrono_photo_filename(path, &mut used)
        };
        mapping.insert(src.clone(), candidate);
    }
    mapping
}

fn copy_photos(
    photo_paths: &[String],
    layout: &OutputLayout,
    kunde: &Kunde,
    rename_map: &HashMap<String, String>,
    on_progress: &ProgressCallback,
) -> Result<usize, ProcessorError> {
    if photo_paths.is_empty() || !needs_foto_product(kunde) {
        return Ok(0);
    }

    let handcam_dir = if kunde.handcam_foto {
        Some(foto_subdir_for_handcam(layout).map_err(ProcessorError::Message)?)
    } else {
        None
    };
    let outside_dir = if kunde.outside_foto {
        Some(foto_subdir_for_outside(layout).map_err(ProcessorError::Message)?)
    } else {
        None
    };

    let total = photo_paths.len();
    let mut copied = 0usize;

    for (idx, src) in photo_paths.iter().enumerate() {
        ensure_not_cancelled()?;
        let src_path = Path::new(src);
        if !src_path.is_file() {
            continue;
        }
        emit(
            on_progress,
            70.0 + 15.0 * ((idx + 1) as f64 / total as f64),
            &format!(
                "Kopiere Foto ({}/{}): {}",
                idx + 1,
                total,
                src_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            ),
        );

        let filename = rename_map
            .get(src)
            .cloned()
            .unwrap_or_else(|| {
                src_path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "photo.jpg".into())
            });

        let mut did = false;
        if let Some(dir) = &handcam_dir {
            fs::copy(src_path, dir.join(&filename))?;
            did = true;
        }
        if let Some(dir) = &outside_dir {
            fs::copy(src_path, dir.join(&filename))?;
            did = true;
        }
        if did {
            copied += 1;
        }
    }
    Ok(copied)
}

fn pick_watermark_clip(
    ffmpeg: &Path,
    video_paths: &[String],
    index: Option<usize>,
) -> Option<String> {
    if let Some(i) = index {
        if i < video_paths.len() {
            return Some(video_paths[i].clone());
        }
    }
    let mut best: Option<(f64, String)> = None;
    for p in video_paths {
        let d = probe_duration_secs(ffmpeg, p).unwrap_or(0.0);
        match &best {
            None => best = Some((d, p.clone())),
            Some((bd, _)) if d > *bd => best = Some((d, p.clone())),
            _ => {}
        }
    }
    best.map(|(_, p)| p)
}

/// Run the full export job into `config.speicherort`.
pub fn create_job(
    ffmpeg: &Path,
    kunde: &Kunde,
    video_paths: &[String],
    photo_paths: &[String],
    config: &AppConfig,
    options: &CreateJobOptions,
    resource_dir: Option<&Path>,
    on_progress: ProgressCallback,
    on_intro_mux_fallback: Option<IntroMuxAskFn>,
) -> Result<CreateJobResult, ProcessorError> {
    let validation = validate_create_job(
        kunde,
        video_paths,
        photo_paths,
        &options.watermark_photo_indices,
        config.oldschool_mode,
    );
    if !validation.is_empty() {
        return Err(ProcessorError::Message(validation.join("\n")));
    }

    let speicherort = config.speicherort.trim();
    if speicherort.is_empty() {
        return Err(ProcessorError::Message(
            "Speicherort ist nicht gesetzt. Bitte Ordner wählen.".into(),
        ));
    }

    let outside_mode = kunde.is_outside_video() || kunde.video_mode == "outside";
    let gast = kunde.resolve_gast();

    emit(&on_progress, 2.0, "Generiere Ausgabe-Verzeichnis…");
    logging::info(
        "create",
        format!(
            "Erstelle Ausgabeordner unter {} (Gast={})",
            speicherort, gast
        ),
    );
    let layout = create_base_output_dir(
        Path::new(speicherort),
        &gast,
        kunde.tandemmaster.trim(),
        kunde.videospringer.trim(),
        kunde.datum.trim(),
        outside_mode,
    )
    .map_err(ProcessorError::Message)?;
    logging::info(
        "create",
        format!("Ausgabeordner: {}", layout.base_dir.display()),
    );

    let mut video_out: Option<String> = None;
    let mut wm_video: Option<String> = None;
    let mut encoder = String::new();
    let mut intro_created = false;
    let mut body_clips = 0usize;
    let mut reused_preview = false;

    let do_video = needs_video_product(kunde) && !video_paths.is_empty();
    let do_wm_video = video_unpaid(kunde) && !video_paths.is_empty();

    if do_video {
        ensure_not_cancelled()?;
        let out_path = video_output_path(&layout, kunde).map_err(ProcessorError::Message)?;
        let out_str = out_path.to_string_lossy().to_string();

        let reuse_path = options
            .reuse_preview_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let reuse_fp = options
            .reuse_preview_fingerprint
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        if let (Some(path), Some(fp)) = (reuse_path, reuse_fp) {
            emit(&on_progress, 8.0, "Übernehme Vorschau als Finalvideo…");
            logging::info(
                "create",
                format!("Versuche Preview-Reuse: {}", file_name(path)),
            );
            match preview_reuse::try_reuse_preview_with_tag(
                path,
                fp,
                kunde,
                video_paths,
                &out_path,
                &preview_reuse::preview_encoding_tag(
                    options.video.intro_enabled,
                    options.video.dauer,
                    &options.video.intro_mux_mode,
                ),
            ) {
                Ok(true) => {
                    reused_preview = true;
                    encoder = "preview-reuse".into();
                    intro_created = options.video.intro_enabled;
                    body_clips = video_paths.len();
                    video_out = Some(out_str.clone());
                    logging::info("create", "Preview als Finalvideo übernommen");
                    emit(&on_progress, 55.0, "Vorschau übernommen");
                }
                Ok(false) => {
                    logging::info(
                        "create",
                        "Preview-Reuse nicht möglich — volle Kodierung",
                    );
                    // Fall through to full encode
                }
                Err(e) => {
                    logging::error("create", format!("Preview-Reuse Fehler: {e}"));
                    return Err(ProcessorError::Message(e));
                }
            }
        }

        if !reused_preview {
            emit(&on_progress, 8.0, "Erstelle Video…");
            logging::info(
                "create",
                format!("Video-Encoding: {} Clip(s)", video_paths.len()),
            );
            let stage_cb =
                map_stage_progress(Arc::clone(&on_progress), 8.0, 55.0, "Erstelle Video…");

            let res: CreateVideoResult = create_video(
                ffmpeg,
                kunde,
                video_paths,
                &out_str,
                &options.video,
                resource_dir,
                stage_cb,
                on_intro_mux_fallback.clone(),
            )?;
            encoder = res.encoder;
            intro_created = res.intro_created;
            body_clips = res.body_clips;
            video_out = Some(res.output);
            logging::info(
                "create",
                format!(
                    "Video fertig: encoder={encoder}, intro={intro_created}, clips={body_clips}"
                ),
            );
        }
    }

    if do_wm_video {
        ensure_not_cancelled()?;
        emit(&on_progress, 56.0, "Erstelle Wasserzeichen-Video…");
        logging::info("create", "Wasserzeichen-Video wird erstellt…");
        if let Some(clip) = pick_watermark_clip(ffmpeg, video_paths, options.watermark_clip_index) {
            let clip_name = Path::new(&clip)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| clip.clone());
            logging::info(
                "create",
                format!("WM-Video aus Clip: {clip_name}"),
            );
            emit(
                &on_progress,
                56.0,
                &format!("Erstelle Wasserzeichen-Video aus {clip_name}…"),
            );
            let wm_path = watermark_video_path(&layout).map_err(ProcessorError::Message)?;
            let wm_str = wm_path.to_string_lossy().to_string();
            let stage_label = format!("Wasserzeichen-Video: {clip_name}");
            let stage_cb = {
                let outer = Arc::clone(&on_progress);
                let stage_label = stage_label.clone();
                Arc::new(move |p: EncodeProgress| {
                    let mapped = 56.0 + (p.percent.clamp(0.0, 100.0) / 100.0) * 12.0;
                    let mut q = p;
                    q.percent = mapped;
                    if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                        q.status = stage_label.clone();
                    }
                    outer(q);
                })
            };
            let enc = create_video_with_watermark(
                ffmpeg,
                &clip,
                &wm_str,
                resource_dir,
                stage_cb,
            )?;
            if encoder.is_empty() {
                encoder = enc;
            }
            wm_video = Some(wm_str);
        }
    }

    let rename_map = build_photo_rename_map(photo_paths);
    ensure_not_cancelled()?;
    emit(&on_progress, 70.0, "Kopiere Fotos…");
    logging::info(
        "create",
        format!("Kopiere {} Foto(s)…", photo_paths.len()),
    );
    let photos_copied = copy_photos(
        photo_paths,
        &layout,
        kunde,
        &rename_map,
        &on_progress,
    )?;
    logging::info("create", format!("Fotos kopiert: {photos_copied}"));

    let mut watermark_photos = 0usize;
    if foto_unpaid(kunde) && !options.watermark_photo_indices.is_empty() {
        ensure_not_cancelled()?;
        emit(&on_progress, 88.0, "Erstelle Foto-Wasserzeichen…");
        logging::info(
            "create",
            format!(
                "Foto-Wasserzeichen: {} Index/Indizes",
                options.watermark_photo_indices.len()
            ),
        );
        let preview_dir = watermark_photo_dir(&layout).map_err(ProcessorError::Message)?;
        let stamp = resolve_stamp(resource_dir)?;
        let wm_total = options.watermark_photo_indices.len().max(1);
        for (wi, &i) in options.watermark_photo_indices.iter().enumerate() {
            ensure_not_cancelled()?;
            if i >= photo_paths.len() {
                continue;
            }
            let src = Path::new(&photo_paths[i]);
            if !src.is_file() {
                continue;
            }
            let out_name = rename_map
                .get(&photo_paths[i])
                .cloned()
                .unwrap_or_else(|| {
                    src.file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "photo.jpg".into())
                });
            let src_label = src
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| out_name.clone());
            emit(
                &on_progress,
                88.0 + 7.0 * ((wi + 1) as f64 / wm_total as f64),
                &format!(
                    "Foto-Wasserzeichen ({}/{}): {src_label}",
                    wi + 1,
                    wm_total
                ),
            );
            // Always write JPEG for preview
            let out_stem = Path::new(&out_name)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "photo".into());
            let out_path = preview_dir.join(format!("{out_stem}.jpg"));
            create_photo_with_watermark(src, &out_path, &stamp)?;
            watermark_photos += 1;
        }
    }

    ensure_not_cancelled()?;
    let (marker_path, correlation_id) = if config.skip_marker_file() {
        emit(&on_progress, 96.0, "Überspringe _fertig.txt (Lokal)…");
        logging::info("create", "Lokal-Modus: keine Marker-Datei _fertig.txt");
        (String::new(), String::new())
    } else {
        emit(&on_progress, 94.0, "Schreibe AMS-Manifest…");
        logging::info("create", "Schreibe _ams_manifest.v1.json…");
        let (correlation_id, _) =
            write_handoff_manifest(&layout, kunde, config).map_err(ProcessorError::Message)?;
        logging::info(
            "create",
            format!("AMS-Manifest geschrieben (correlation_id={correlation_id})"),
        );

        emit(&on_progress, 96.0, "Schreibe _fertig.txt…");
        logging::info("create", "Schreibe Marker _fertig.txt…");
        let marker = write_marker_file(&layout, kunde, config).map_err(ProcessorError::Message)?;
        (marker.to_string_lossy().to_string(), correlation_id)
    };

    emit(&on_progress, 100.0, "Vorgang fertig");
    let marker_label = if marker_path.is_empty() {
        "(keine)".into()
    } else {
        file_name(&marker_path)
    };
    logging::info(
        "create",
        format!(
            "Vorgang abgeschlossen: {}, marker={}",
            layout.base_filename, marker_label
        ),
    );

    Ok(CreateJobResult {
        base_output_dir: layout.base_dir.to_string_lossy().to_string(),
        base_filename: layout.base_filename,
        video_output: video_out,
        watermark_video: wm_video,
        photos_copied,
        watermark_photos,
        marker_path,
        encoder,
        intro_created,
        body_clips,
        reused_preview,
        correlation_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_requires_product() {
        let k = Kunde::default();
        let errs = validate_create_job(&k, &[], &[], &[], false);
        assert!(errs.iter().any(|e| e.contains("Produkt")));
    }

    #[test]
    fn validate_video_product_needs_files() {
        let mut k = Kunde::default();
        k.tandemmaster = "A".into();
        k.datum = "06.08.2026".into();
        k.vorname = Some("Max".into());
        k.nachname = Some("M".into());
        k.handcam_video = true;
        let errs = validate_create_job(&k, &[], &[], &[], false);
        assert!(errs.iter().any(|e| e.contains("keine Videos")));
    }

    #[test]
    fn validate_unpaid_foto_needs_wm_selection() {
        let mut k = Kunde::default();
        k.tandemmaster = "A".into();
        k.datum = "06.08.2026".into();
        k.vorname = Some("Max".into());
        k.nachname = Some("M".into());
        k.handcam_foto = true;
        k.ist_bezahlt_handcam_foto = false;
        let errs = validate_create_job(&k, &[], &["a.jpg".into()], &[], false);
        assert!(errs.iter().any(|e| e.contains("Wasserzeichen")));
    }
}
