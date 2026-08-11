//! Bidirectional follow-up QR scans within a capture series after a photo hit.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;

use crate::video::ffmpeg;

use super::analyser::{
    photo_has_customer_qr, QrScanError, QrScanOptions, MAX_QR_FOLLOWUP_DECODE_WIDTH,
};
use super::series::{
    hit_index_in_list, path_key, same_series_step, QR_PHOTO_FOLLOWUP_SCAN_CAP,
    QR_PHOTO_MISS_STREAK_STOP, QR_PHOTO_SERIES_GAP_SECS,
};

/// `(path, phase, scanned, extra_hits)` — phase is `start` | `hit` | `miss`.
pub type FollowupProgressCb<'a> = dyn Fn(&str, &str, usize, usize) + Sync + 'a;

/// Walk one direction from `hit_idx` (sequential within the side for miss-streak).
fn walk_direction(
    ordered_paths: &[String],
    hit_idx: usize,
    step: i32,
    gap_secs: f64,
    miss_streak_stop: usize,
    scan_cap: usize,
    visited: &Mutex<HashSet<String>>,
    scans_used: &AtomicUsize,
    extra_hits: &AtomicUsize,
    on_progress: Option<&FollowupProgressCb<'_>>,
    detect: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let mut out = Vec::new();
    if step == 0 || miss_streak_stop == 0 || ordered_paths.is_empty() {
        return out;
    }
    if hit_idx >= ordered_paths.len() {
        return out;
    }

    let mut miss_streak = 0usize;
    let mut i = hit_idx as i32 + step;

    while i >= 0 && (i as usize) < ordered_paths.len() {
        if ffmpeg::is_cancelled() {
            break;
        }
        if scans_used.load(Ordering::SeqCst) >= scan_cap {
            break;
        }
        let idx = i as usize;
        let prev_idx = (i - step) as usize;

        let (earlier, later) = if step > 0 {
            (&ordered_paths[prev_idx], &ordered_paths[idx])
        } else {
            (&ordered_paths[idx], &ordered_paths[prev_idx])
        };
        if !same_series_step(earlier, later, gap_secs) {
            break;
        }

        let path = &ordered_paths[idx];
        let key = path_key(path);
        {
            let mut g = visited.lock().unwrap();
            if !g.insert(key) {
                i += step;
                continue;
            }
        }

        let scanned_before = scans_used.load(Ordering::SeqCst);
        let hits_before = extra_hits.load(Ordering::SeqCst);
        if let Some(cb) = on_progress {
            cb(path, "start", scanned_before, hits_before);
        }

        let found = detect(path);
        let scanned_after = scans_used.fetch_add(1, Ordering::SeqCst) + 1;

        if found {
            out.push(path.clone());
            let hits_after = extra_hits.fetch_add(1, Ordering::SeqCst) + 1;
            miss_streak = 0;
            if let Some(cb) = on_progress {
                cb(path, "hit", scanned_after, hits_after);
            }
        } else {
            miss_streak += 1;
            if let Some(cb) = on_progress {
                cb(
                    path,
                    "miss",
                    scanned_after,
                    extra_hits.load(Ordering::SeqCst),
                );
            }
            if miss_streak >= miss_streak_stop {
                break;
            }
        }
        i += step;
    }
    out
}

/// Additional QR-carrier paths in the same series (both directions from the hit).
///
/// Left and right walk in parallel; each side stays sequential for the miss streak.
/// Detect-only (no preview files). Never scans the same path twice; total scans
/// capped by [`QR_PHOTO_FOLLOWUP_SCAN_CAP`].
pub fn scan_series_followup_hits(
    _ffmpeg_bin: &Path,
    ordered_paths: &[String],
    hit_path: &str,
    _options: &QrScanOptions,
    on_progress: Option<&FollowupProgressCb<'_>>,
) -> Result<Vec<String>, QrScanError> {
    let Some(hit_idx) = hit_index_in_list(ordered_paths, hit_path) else {
        return Ok(Vec::new());
    };

    let visited = Mutex::new({
        let mut s = HashSet::new();
        s.insert(path_key(hit_path));
        s
    });
    let scans_used = AtomicUsize::new(0);
    let extra_hits = AtomicUsize::new(0);
    let max_width = MAX_QR_FOLLOWUP_DECODE_WIDTH;

    let detect = |path: &str| -> bool {
        match photo_has_customer_qr(Path::new(path), max_width) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("QR follow-up scan error ({path}): {e}");
                false
            }
        }
    };

    let left_hits = Mutex::new(Vec::<String>::new());
    let right_hits = Mutex::new(Vec::<String>::new());

    thread::scope(|scope| {
        scope.spawn(|| {
            let found = walk_direction(
                ordered_paths,
                hit_idx,
                -1,
                QR_PHOTO_SERIES_GAP_SECS,
                QR_PHOTO_MISS_STREAK_STOP,
                QR_PHOTO_FOLLOWUP_SCAN_CAP,
                &visited,
                &scans_used,
                &extra_hits,
                on_progress,
                &detect,
            );
            *left_hits.lock().unwrap() = found;
        });
        scope.spawn(|| {
            let found = walk_direction(
                ordered_paths,
                hit_idx,
                1,
                QR_PHOTO_SERIES_GAP_SECS,
                QR_PHOTO_MISS_STREAK_STOP,
                QR_PHOTO_FOLLOWUP_SCAN_CAP,
                &visited,
                &scans_used,
                &extra_hits,
                on_progress,
                &detect,
            );
            *right_hits.lock().unwrap() = found;
        });
    });

    let mut hits = left_hits.into_inner().unwrap_or_default();
    hits.extend(right_hits.into_inner().unwrap_or_default());
    hits.sort_by_key(|p| {
        ordered_paths
            .iter()
            .position(|c| path_key(c) == path_key(p))
            .unwrap_or(usize::MAX)
    });
    hits.dedup_by(|a, b| path_key(a) == path_key(b));
    Ok(hits)
}
