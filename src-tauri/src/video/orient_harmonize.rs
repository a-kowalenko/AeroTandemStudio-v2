//! OPT-27: orientation harmonization planning, copy-harmonize remux, partial bake (Slice A–C).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;

use super::concat::{
    build_display_rotation_remux_args, build_orient_copy_harmonize_args,
    build_orient_partial_bake_args, compatible_remux_prep_worker_count,
    orient_copy_harmonize_segment_filename, orient_partial_bake_segment_filename,
    normalize_vcodec_name, resolve_hevc_output_tag, rotation_decode_input_params, VideoCodec,
};
use super::encode_profile::EncodeProfile;
use super::ffmpeg::{
    disk_full_error, is_cancelled, is_disk_full_error, run_ffmpeg, run_ffmpeg_checked, FfmpegError,
    ProgressCallback,
};
use super::progress::EncodeProgress;
use super::hw_accel::{detect_hardware, EncodingParams};
use super::parallel::{ParallelError, ParallelVideoProcessor};
use super::probe::{
    compatible_orientation_mismatch_reason, compatible_orientation_unreliable_reason,
    compatible_stream_keys_match, CompatibleStreamKey,
};
use super::reencode_confirm::{
    self, ReencodeAskFn, ReencodeIntent, ReencodeKind, ReencodeParams,
};
use crate::storage::logging;

#[derive(Debug, Error)]
pub enum OrientHarmonizeError {
    #[error("orient harmonize: path/key count mismatch")]
    LengthMismatch,
    #[error("orient harmonize: unexpected plan (need CopyHarmonizeCandidate)")]
    WrongPlan,
    #[error(transparent)]
    Ffmpeg(#[from] FfmpegError),
    #[error(transparent)]
    Parallel(#[from] ParallelError),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
}

/// Result of classifying a clip set for auto-orient harmonization (OPT-27 Slice A).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrientPlan {
    /// All probe keys already match Clip 1 — no harmonization.
    Aligned,
    /// Same coded geometry/codec; only soft-rotation differs (Muster A → Slice B).
    CopyHarmonizeCandidate,
    /// Coded WxH must be transposed on outlier clip(s); display geometry already matches ref.
    PartialBake {
        indices: Vec<usize>,
    },
    /// Full re-encode path unchanged (gate reason preserved when available).
    Unrecoverable {
        reason: String,
    },
}

/// Deterministic orientation plan from Compatible probe keys (Clip 1 = reference).
pub fn plan_orientation_harmonization(keys: &[CompatibleStreamKey]) -> OrientPlan {
    if keys.is_empty() {
        return OrientPlan::Aligned;
    }

    for (clip_index, key) in keys.iter().enumerate() {
        if let Some(reason) =
            compatible_orientation_unreliable_reason(key.rotation, clip_index + 1)
        {
            return OrientPlan::Unrecoverable { reason };
        }
    }

    let reference = &keys[0];

    if let Some(reason) = unrecoverable_codec_or_audio(keys, reference) {
        return OrientPlan::Unrecoverable { reason };
    }

    if keys
        .iter()
        .all(|key| compatible_stream_keys_match(reference, key))
    {
        return OrientPlan::Aligned;
    }

    let indices = orient_harmonize_outlier_indices(keys);
    if indices.is_empty() {
        return OrientPlan::Unrecoverable {
            reason: unrecoverable_mismatch_reason(keys, reference),
        };
    }

    let outliers_harmonizable = indices.iter().all(|&i| {
        let key = &keys[i];
        key.codec == reference.codec && key.has_audio == reference.has_audio
    });
    if !outliers_harmonizable {
        return OrientPlan::Unrecoverable {
            reason: unrecoverable_mismatch_reason(keys, reference),
        };
    }

    // Muster A (Avidemux-nah): same coded WxH/pix_fmt — remux display matrix only (`-c copy`).
    // Muster B: coded geometry differs (e.g. native 1080×1920 vs 1920×1080) → partial bake.
    if outliers_need_coded_geometry_bake(keys, &indices) {
        OrientPlan::PartialBake { indices }
    } else {
        OrientPlan::CopyHarmonizeCandidate
    }
}

/// True when an outlier must be pixel-transcoded to match Clip 1 coded frame (not metadata-only).
fn outliers_need_coded_geometry_bake(keys: &[CompatibleStreamKey], indices: &[usize]) -> bool {
    let reference = &keys[0];
    indices.iter().any(|&i| {
        let key = &keys[i];
        key.width != reference.width
            || key.height != reference.height
            || key.pix_fmt != reference.pix_fmt
    })
}

/// Clip indices (excluding Clip 1) that differ from the reference probe key.
pub fn orient_harmonize_outlier_indices(keys: &[CompatibleStreamKey]) -> Vec<usize> {
    if keys.len() < 2 {
        return Vec::new();
    }
    let reference = &keys[0];
    keys.iter()
        .enumerate()
        .skip(1)
        .filter(|(_, key)| !compatible_stream_keys_match(reference, key))
        .map(|(i, _)| i)
        .collect()
}

/// Clip indices that need copy-harmonize remux (legacy / tests).
pub fn orient_copy_harmonize_outlier_indices(keys: &[CompatibleStreamKey]) -> Vec<usize> {
    orient_harmonize_outlier_indices(keys)
}

/// Stream-copy temp remux for rotation outliers (Muster A); reference clip keeps its path.
///
/// Does not persist probe-cache entries for temps (OPT-27 P9). Caller re-probes returned paths.
pub fn harmonize_clip_orientations_copy<P: AsRef<Path>>(
    ffmpeg: &Path,
    work_dir: &Path,
    paths: &[P],
    keys: &[CompatibleStreamKey],
) -> Result<Vec<PathBuf>, OrientHarmonizeError> {
    if paths.len() != keys.len() {
        return Err(OrientHarmonizeError::LengthMismatch);
    }
    if !matches!(
        plan_orientation_harmonization(keys),
        OrientPlan::CopyHarmonizeCandidate
    ) {
        return Err(OrientHarmonizeError::WrongPlan);
    }

    let ref_rot = keys[0].rotation.known_degrees().unwrap_or(0);

    let outlier_indices = orient_copy_harmonize_outlier_indices(keys);
    let mut result: Vec<PathBuf> = paths.iter().map(|p| p.as_ref().to_path_buf()).collect();
    if outlier_indices.is_empty() {
        return Ok(result);
    }

    fs::create_dir_all(work_dir)?;

    let n = outlier_indices.len();
    let cpu_count = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(2);
    let pool = ParallelVideoProcessor {
        max_workers: compatible_remux_prep_worker_count(n),
        hw_accel_enabled: false,
        cpu_count,
    };

    let ffmpeg_path = ffmpeg.to_path_buf();
    let work = work_dir.to_path_buf();
    let keys_owned: Vec<CompatibleStreamKey> = keys.to_vec();
    let paths_owned: Vec<PathBuf> = result.clone();
    let outliers = outlier_indices.clone();

    let remux_results = pool.process_indexed(
        n,
        move |task_i, _task_id| -> Result<(usize, PathBuf), OrientHarmonizeError> {
            if is_cancelled() {
                return Err(OrientHarmonizeError::Ffmpeg(FfmpegError::Cancelled));
            }
            let clip_index = outliers[task_i];
            let key = &keys_owned[clip_index];
            let input = path_display(&paths_owned[clip_index]);
            let out = work.join(orient_copy_harmonize_segment_filename(clip_index));
            let output = path_display(&out);
            let args =
                build_orient_copy_harmonize_args(&input, &output, key.has_audio, ref_rot);
            run_ffmpeg_checked(&ffmpeg_path, &args)?;
            Ok((clip_index, out))
        },
        None,
    )?;

    for entry in remux_results {
        let (clip_index, out_path) = entry?;
        result[clip_index] = out_path;
    }

    Ok(result)
}

/// Options for OPT-27 partial orientation bake (Slice C).
#[derive(Debug, Clone)]
pub struct OrientPartialBakeOptions {
    /// Body concat mode (`auto` → HEVC tag from probe keys).
    pub body_concat_mode: String,
    pub crf: u8,
    pub hw_accel_enabled: bool,
}

/// Transcode outlier clip(s) to Clip 1 geometry (Muster B); non-outliers keep their paths.
///
/// Asks once via [`ReencodeKind::OrientPartial`]. Does not persist probe-cache for temps (P9).
#[allow(clippy::too_many_arguments)]
pub fn harmonize_clip_orientations_partial_bake<P: AsRef<Path>>(
    ffmpeg: &Path,
    work_dir: &Path,
    paths: &[P],
    keys: &[CompatibleStreamKey],
    opts: &OrientPartialBakeOptions,
    on_reencode: Option<&ReencodeAskFn>,
    durations_secs: Option<&[f64]>,
    on_progress: Option<ProgressCallback>,
) -> Result<Vec<PathBuf>, OrientHarmonizeError> {
    if paths.len() != keys.len() {
        return Err(OrientHarmonizeError::LengthMismatch);
    }
    let OrientPlan::PartialBake { indices } = plan_orientation_harmonization(keys) else {
        return Err(OrientHarmonizeError::WrongPlan);
    };
    if indices.is_empty() {
        return Ok(paths.iter().map(|p| p.as_ref().to_path_buf()).collect());
    }

    let reference = &keys[0];
    let ref_rot = reference.rotation.known_degrees().unwrap_or(0);
    let vcodec = normalize_vcodec_name(&reference.codec);
    if matches!(vcodec, VideoCodec::Other) {
        return Err(OrientHarmonizeError::WrongPlan);
    }
    let hevc_tag = resolve_hevc_output_tag(&opts.body_concat_mode, keys);
    let total = paths.len();
    let bake_n = indices.len();

    let clip_labels: Vec<String> = indices.iter().map(|i| format!("{}", i + 1)).collect();
    let reason = if bake_n == 1 {
        format!(
            "Clip {}: Orientierung angeglichen (1 von {total} neu kodiert)",
            clip_labels[0]
        )
    } else {
        format!(
            "Clips {}: Orientierung angeglichen ({bake_n} von {total} neu kodiert)",
            clip_labels.join(", ")
        )
    };

    let body_codec = vcodec.as_str();
    let recommended = EncodeProfile::recommend(
        ReencodeKind::OrientPartial,
        opts.crf,
        opts.hw_accel_enabled,
        Some(body_codec),
    );
    let intent = ReencodeIntent::new(ReencodeKind::OrientPartial, reason.clone())
        .with_params(ReencodeParams {
            clip_count: Some(bake_n),
            strategy: Some("orient_partial_bake".into()),
            details: vec![reason],
            ..Default::default()
        })
        .with_recommended(recommended);
    let profile = reencode_confirm::require_confirm(on_reencode, &intent)
        .map_err(|_| OrientHarmonizeError::Ffmpeg(FfmpegError::Cancelled))?;

    let hw = detect_hardware();
    let (encoder, output_params) = profile.to_encode_output_params(&hw, vcodec);
    let used_hw = !encoder.to_ascii_lowercase().starts_with("lib");
    let decode_accel = if used_hw {
        hw.hwaccel_for_cpu_filters()
    } else {
        None
    };

    fs::create_dir_all(work_dir)?;

    let mut result: Vec<PathBuf> = paths.iter().map(|p| p.as_ref().to_path_buf()).collect();
    let n = indices.len();
    let cpu_count = std::thread::available_parallelism()
        .map(|p| p.get())
        .unwrap_or(2);
    let pool = ParallelVideoProcessor {
        max_workers: compatible_remux_prep_worker_count(n),
        hw_accel_enabled: opts.hw_accel_enabled,
        cpu_count,
    };

    let ffmpeg_path = ffmpeg.to_path_buf();
    let work = work_dir.to_path_buf();
    let keys_owned: Vec<CompatibleStreamKey> = keys.to_vec();
    let paths_owned: Vec<PathBuf> = result.clone();
    let outliers = indices.clone();
    let reference_owned = reference.clone();
    let hevc_tag_owned = hevc_tag.to_string();
    let encode_params_base = EncodingParams {
        input_params: rotation_decode_input_params(decode_accel),
        output_params: output_params.clone(),
        encoder: encoder.clone(),
    };

    logging::info(
        "concat",
        format!("auto: orient partial-bake encoder={encoder} clips={bake_n}"),
    );

    let durations_owned: Vec<f64> = durations_secs.map(|d| d.to_vec()).unwrap_or_default();
    let progress_outer = on_progress;

    let bake_results = pool.process_indexed(
        n,
        move |task_i, _task_id| -> Result<(usize, PathBuf), OrientHarmonizeError> {
            if is_cancelled() {
                return Err(OrientHarmonizeError::Ffmpeg(FfmpegError::Cancelled));
            }
            let clip_index = outliers[task_i];
            logging::info(
                "concat",
                format!("auto: orient partial-bake clip={}", clip_index + 1),
            );
            let outlier = &keys_owned[clip_index];
            let input = path_display(&paths_owned[clip_index]);
            let out = work.join(orient_partial_bake_segment_filename(clip_index));
            let output = path_display(&out);
            let args = build_orient_partial_bake_args(
                &input,
                &output,
                outlier,
                &reference_owned,
                vcodec,
                &hevc_tag_owned,
                &encode_params_base,
                outlier.has_audio,
            )
            .map_err(|e| OrientHarmonizeError::Message(e))?;
            let run_result = if let Some(ref outer) = progress_outer {
                let dur = durations_owned
                    .get(clip_index)
                    .copied()
                    .unwrap_or(60.0)
                    .max(0.1);
                let status_label = format!("Clip {}: Orientierung angeglichen…", clip_index + 1);
                let cb: ProgressCallback = {
                    let outer = Arc::clone(outer);
                    let status_label = status_label.clone();
                    Arc::new(move |p: EncodeProgress| {
                        let mut q = p;
                        if q.status == "continue" || q.status == "end" || q.status.is_empty() {
                            q.status = status_label.clone();
                        }
                        outer(q);
                    })
                };
                run_ffmpeg(&ffmpeg_path, &args, dur, cb).map_err(|e| {
                    if is_disk_full_error(&e) {
                        disk_full_error()
                    } else {
                        e
                    }
                })
            } else {
                run_ffmpeg_checked(&ffmpeg_path, &args)
            };
            match run_result {
                Ok(()) => Ok((clip_index, out)),
                Err(e) if is_disk_full_error(&e) => {
                    let _ = fs::remove_file(&out);
                    Err(OrientHarmonizeError::Ffmpeg(disk_full_error()))
                }
                Err(e) => {
                    let _ = fs::remove_file(&out);
                    Err(OrientHarmonizeError::Ffmpeg(e))
                }
            }
        },
        None,
    )?;

    for entry in bake_results {
        let (clip_index, out_path) = entry?;
        let final_path = if ref_rot == 0 {
            out_path
        } else {
            let key = &keys[clip_index];
            let tagged = work_dir.join(format!("orient_bake_{clip_index}_tag.mp4"));
            let video_tag = match vcodec {
                VideoCodec::Hevc => Some(hevc_tag),
                VideoCodec::H264 => Some("avc1"),
                VideoCodec::Other => None,
            };
            let remux_args = build_display_rotation_remux_args(
                &path_display(&out_path),
                &path_display(&tagged),
                ref_rot,
                key.has_audio,
                video_tag,
            );
            run_ffmpeg_checked(ffmpeg, &remux_args)?;
            let _ = fs::remove_file(&out_path);
            tagged
        };
        result[clip_index] = final_path;
    }

    Ok(result)
}

fn path_display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn unrecoverable_codec_or_audio(
    keys: &[CompatibleStreamKey],
    reference: &CompatibleStreamKey,
) -> Option<String> {
    let ref_kind = normalize_vcodec_name(&reference.codec);
    if matches!(ref_kind, VideoCodec::Other) {
        return Some(format!(
            "compatible.orient_unsupported_codec:codec={}:clip=1",
            reference.codec
        ));
    }

    for (i, key) in keys.iter().enumerate().skip(1) {
        let kind = normalize_vcodec_name(&key.codec);
        if matches!(kind, VideoCodec::Other) {
            return Some(format!(
                "compatible.orient_unsupported_codec:codec={}:clip={}",
                key.codec,
                i + 1
            ));
        }
        if kind != ref_kind {
            return Some(format!(
                "Compatible Path: unterschiedliche Codecs ({} vs {})",
                reference.codec, key.codec
            ));
        }
        if key.has_audio != reference.has_audio {
            return Some("Compatible Path: gemischte Audio-Präsenz".into());
        }
    }
    None
}

fn unrecoverable_mismatch_reason(keys: &[CompatibleStreamKey], reference: &CompatibleStreamKey) -> String {
    let ref_rot = reference.rotation.known_degrees().unwrap_or(0);
    for (i, key) in keys.iter().enumerate().skip(1) {
        let key_rot = key.rotation.known_degrees().unwrap_or(0);
        if ref_rot != key_rot {
            return compatible_orientation_mismatch_reason(ref_rot, i + 1, key_rot);
        }
        if reference.width != key.width || reference.height != key.height {
            return format!(
                "Compatible Path: unterschiedliche Auflösung ({}x{} vs {}x{})",
                reference.width, reference.height, key.width, key.height
            );
        }
        if reference.pix_fmt != key.pix_fmt {
            return format!(
                "Compatible Path: unterschiedliches Pixelformat ({} vs {})",
                reference.pix_fmt, key.pix_fmt
            );
        }
    }
    format!(
        "Compatible Path: Clips nicht kompatibel (Clip1 vs Clip{})",
        keys.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::probe::VideoRotationProbe;

    fn key(
        width: u32,
        height: u32,
        rotation: VideoRotationProbe,
        codec: &str,
    ) -> CompatibleStreamKey {
        CompatibleStreamKey {
            codec: codec.into(),
            width,
            height,
            pix_fmt: "yuv420p".into(),
            tag: "avc1".into(),
            profile: "High".into(),
            has_audio: true,
            rotation,
            needs_editlist_hygiene: false,
            encoder: "gopro".into(),
        }
    }

    #[test]
    fn orient_plan_aligned_when_all_match_reference() {
        let k = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        assert_eq!(
            plan_orientation_harmonization(&[k.clone(), k]),
            OrientPlan::Aligned
        );
    }

    #[test]
    fn orient_plan_copy_harmonize_rotation_only_mismatch() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let outlier = key(1920, 1080, VideoRotationProbe::Known(270), "h264");
        assert_eq!(
            plan_orientation_harmonization(&[ref_clip, outlier]),
            OrientPlan::CopyHarmonizeCandidate
        );
    }

    #[test]
    fn orient_plan_copy_harmonize_gopro_180_vs_90() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(180), "hevc");
        let aligned = key(1920, 1080, VideoRotationProbe::Known(180), "hevc");
        let outlier = key(1920, 1080, VideoRotationProbe::Known(90), "hevc");
        assert_eq!(
            plan_orientation_harmonization(&[ref_clip, aligned, outlier]),
            OrientPlan::CopyHarmonizeCandidate
        );
    }

    #[test]
    fn orient_plan_partial_bake_native_portrait_with_soft_rotation() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let outlier = key(1080, 1920, VideoRotationProbe::Known(90), "h264");
        assert_eq!(
            plan_orientation_harmonization(&[ref_clip, outlier]),
            OrientPlan::PartialBake { indices: vec![1] }
        );
    }

    #[test]
    fn orient_plan_partial_bake_multiple_coded_geometry_outliers() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let aligned = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let outlier_a = key(1080, 1920, VideoRotationProbe::Known(90), "h264");
        let outlier_b = key(1080, 1920, VideoRotationProbe::Known(270), "h264");
        assert_eq!(
            plan_orientation_harmonization(&[ref_clip, aligned, outlier_a, outlier_b]),
            OrientPlan::PartialBake {
                indices: vec![2, 3]
            }
        );
    }

    #[test]
    fn orient_plan_partial_bake_both_upright_different_coded_dims() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let outlier = key(1080, 1920, VideoRotationProbe::Known(0), "h264");
        assert_eq!(
            plan_orientation_harmonization(&[ref_clip, outlier]),
            OrientPlan::PartialBake { indices: vec![1] }
        );
    }

    #[test]
    fn orient_plan_unrecoverable_unknown_rotation() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let bad = key(
            1920,
            1080,
            VideoRotationProbe::Unknown { raw_deg: 45 },
            "h264",
        );
        let plan = plan_orientation_harmonization(&[ref_clip, bad]);
        assert!(matches!(plan, OrientPlan::Unrecoverable { .. }));
        if let OrientPlan::Unrecoverable { reason } = plan {
            assert!(reason.contains("orientation_unknown"));
        }
    }

    #[test]
    fn orient_plan_unrecoverable_rotation_conflict() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let bad = key(
            1920,
            1080,
            VideoRotationProbe::Conflict {
                displaymatrix_deg: 90,
                tag_deg: 270,
            },
            "h264",
        );
        let plan = plan_orientation_harmonization(&[ref_clip, bad]);
        assert!(matches!(plan, OrientPlan::Unrecoverable { .. }));
        if let OrientPlan::Unrecoverable { reason } = plan {
            assert!(reason.contains("orientation_conflict"));
        }
    }

    #[test]
    fn orient_plan_unrecoverable_mixed_codec() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let hevc = key(1920, 1080, VideoRotationProbe::Known(0), "hevc");
        let plan = plan_orientation_harmonization(&[ref_clip, hevc]);
        assert!(matches!(plan, OrientPlan::Unrecoverable { .. }));
    }

    #[test]
    fn orient_plan_unrecoverable_mixed_audio_presence() {
        let mut ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let mut silent = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        ref_clip.has_audio = true;
        silent.has_audio = false;
        let plan = plan_orientation_harmonization(&[ref_clip, silent]);
        assert!(matches!(plan, OrientPlan::Unrecoverable { .. }));
    }

    #[test]
    fn orient_plan_unrecoverable_exotic_codec() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "vp9");
        assert!(matches!(
            plan_orientation_harmonization(&[ref_clip.clone(), ref_clip]),
            OrientPlan::Unrecoverable { .. }
        ));
    }

    #[test]
    fn orient_plan_empty_is_aligned() {
        assert_eq!(plan_orientation_harmonization(&[]), OrientPlan::Aligned);
    }

    #[test]
    fn orient_copy_harmonize_outlier_indices_skips_reference() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let outlier = key(1920, 1080, VideoRotationProbe::Known(270), "h264");
        assert_eq!(
            orient_copy_harmonize_outlier_indices(&[ref_clip, outlier]),
            vec![1]
        );
    }

    #[test]
    fn orient_copy_harmonize_outlier_indices_empty_when_rotation_aligned() {
        let k = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        assert!(orient_copy_harmonize_outlier_indices(&[k.clone(), k]).is_empty());
    }

    #[test]
    fn orient_copy_harmonize_keys_match_reference_after_simulated_harmonize() {
        let ref_clip = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let mut outlier = key(1920, 1080, VideoRotationProbe::Known(270), "h264");
        outlier.rotation = VideoRotationProbe::Known(0);
        assert!(compatible_stream_keys_match(&ref_clip, &outlier));
    }

    #[test]
    fn harmonize_partial_bake_rejects_wrong_plan() {
        let k = key(1920, 1080, VideoRotationProbe::Known(0), "h264");
        let keys = [k.clone(), k];
        let paths = ["a.mp4", "b.mp4"];
        let opts = OrientPartialBakeOptions {
            body_concat_mode: "auto".into(),
            crf: 18,
            hw_accel_enabled: false,
        };
        let err = harmonize_clip_orientations_partial_bake(
            Path::new("ffmpeg"),
            Path::new("/tmp/orient"),
            &paths,
            &keys,
            &opts,
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(matches!(err, OrientHarmonizeError::WrongPlan));
    }
}
