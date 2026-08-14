//! Ends-first parallel QR scanning.
//!
//! Typical QR placement: first clip (often), last clip (sometimes), middle (rare).
//! Strategy:
//! 1. Videos — hot path: scan index 0 and n−1 with at most 2 workers, then remainder
//!    outside-in with limited workers (2, or up to config when n ≥ 6).
//! 2. Photos — skip the hot-path barrier; scan at most 20 files from each
//!    list end (max 40). All workers start immediately on that queue.
//!
//! List order is preserved; only the scan order changes. Cleanup direction is
//! Forward near the start and Backward near the end.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use crate::video::ffmpeg;

use super::analyser::{
    scan_photo, scan_video_clip_with_progress, CleanupDirection, QrScanError, QrScanOptions,
    QrScanProgressCb, QrScanResult,
};

/// Max workers while probing the list ends (first + last).
pub const HOT_PATH_WORKERS: usize = 2;
/// From this list length, phase-B may use more than 2 workers (up to config / 4).
pub const PHASE_B_WIDE_MIN_N: usize = 6;
/// Photo batch: scan at most this many files from each list end (max 40).
pub const PHOTO_EDGE_SCAN_PER_SIDE: usize = 20;

/// One scan job: list index + cleanup hint when that clip hits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndsFirstJob {
    pub index: usize,
    pub cleanup: CleanupDirection,
}

/// Scan order: first, last, then outside-in. Does not reorder `paths` itself.
pub fn ends_first_jobs(n: usize) -> Vec<EndsFirstJob> {
    use CleanupDirection::{Backward, Forward};
    if n == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(n);
    out.push(EndsFirstJob {
        index: 0,
        cleanup: Forward,
    });
    if n == 1 {
        return out;
    }
    out.push(EndsFirstJob {
        index: n - 1,
        cleanup: Backward,
    });
    let mut lo = 1usize;
    let mut hi = n - 2;
    while lo <= hi {
        out.push(EndsFirstJob {
            index: lo,
            cleanup: Forward,
        });
        if lo != hi {
            out.push(EndsFirstJob {
                index: hi,
                cleanup: Backward,
            });
        }
        if lo == hi {
            break;
        }
        lo += 1;
        if hi == 0 {
            break;
        }
        hi -= 1;
    }
    out
}

/// Ends-first jobs limited to `per_side` from each list end (no middle).
pub fn ends_first_edge_jobs(n: usize, per_side: usize) -> Vec<EndsFirstJob> {
    if n == 0 || per_side == 0 {
        return Vec::new();
    }
    if n <= per_side.saturating_mul(2) {
        return ends_first_jobs(n);
    }
    let lo_end = per_side;
    let hi_start = n - per_side;
    ends_first_jobs(n)
        .into_iter()
        .filter(|j| j.index < lo_end || j.index >= hi_start)
        .collect()
}

/// List-order indices for UI stripes: head, then tail (middle omitted).
pub fn photo_edge_scan_indices(n: usize, per_side: usize) -> Vec<usize> {
    if n == 0 || per_side == 0 {
        return Vec::new();
    }
    if n <= per_side.saturating_mul(2) {
        return (0..n).collect();
    }
    let mut out: Vec<usize> = (0..per_side).collect();
    out.extend(n - per_side..n);
    out
}

/// Hot-path jobs: at most the first two entries of [`ends_first_jobs`] (index 0 and n−1).
pub fn ends_first_hot_jobs(n: usize) -> Vec<EndsFirstJob> {
    let jobs = ends_first_jobs(n);
    jobs.into_iter().take(HOT_PATH_WORKERS.min(n).max(1)).collect()
}

fn phase_b_worker_count(n: usize, configured: usize) -> usize {
    let configured = configured.max(1).min(4);
    if n >= PHASE_B_WIDE_MIN_N {
        configured
    } else {
        configured.min(HOT_PATH_WORKERS)
    }
}

fn cancelled(cancel: Option<&AtomicBool>) -> bool {
    ffmpeg::is_cancelled() || cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false)
}

/// Optional per-file progress: `(path, phase, frame, frames_total)`.
/// Phases: `start` | `done` | `hit` | `frame`.
pub type QrFileProgressCb<'a> = QrScanProgressCb<'a>;

/// Parallel ends-first scan over the full video list.
#[allow(dead_code)]
pub fn scan_videos_hybrid(
    ffmpeg_bin: &Path,
    paths: &[String],
    options: &QrScanOptions,
    parallel_workers: usize,
    cancel: Option<&AtomicBool>,
) -> Result<QrScanResult, QrScanError> {
    scan_videos_hybrid_with_progress(ffmpeg_bin, paths, options, parallel_workers, cancel, None)
}

pub fn scan_videos_hybrid_with_progress(
    ffmpeg_bin: &Path,
    paths: &[String],
    options: &QrScanOptions,
    parallel_workers: usize,
    cancel: Option<&AtomicBool>,
    on_file: Option<&QrFileProgressCb<'_>>,
) -> Result<QrScanResult, QrScanError> {
    if paths.is_empty() {
        return Ok(QrScanResult::miss("Keine Videos zum Scannen."));
    }

    if cancelled(cancel) {
        return Ok(QrScanResult::cancelled());
    }

    let result = run_ends_first(
        paths,
        |path, stop| {
            scan_video_clip_with_progress(ffmpeg_bin, path, options, Some(stop), on_file)
        },
        parallel_workers,
        cancel,
        on_file,
        false,
        None,
    )?;

    if result.found || result.cancelled {
        return Ok(result);
    }

    Ok(QrScanResult::miss(format!(
        "Kein gültiger QR-Code in {} Clip(s) gefunden.",
        paths.len()
    )))
}

/// Parallel ends-first scan over the full photo list.
#[allow(dead_code)]
pub fn scan_photos_hybrid(
    ffmpeg_bin: &Path,
    paths: &[String],
    options: &QrScanOptions,
    parallel_workers: usize,
    cancel: Option<&AtomicBool>,
) -> Result<QrScanResult, QrScanError> {
    scan_photos_hybrid_with_progress(ffmpeg_bin, paths, options, parallel_workers, cancel, None)
}

pub fn scan_photos_hybrid_with_progress(
    ffmpeg_bin: &Path,
    paths: &[String],
    options: &QrScanOptions,
    parallel_workers: usize,
    cancel: Option<&AtomicBool>,
    on_file: Option<&QrFileProgressCb<'_>>,
) -> Result<QrScanResult, QrScanError> {
    if paths.is_empty() {
        return Ok(QrScanResult::miss("Keine Fotos zum Scannen."));
    }

    if cancelled(cancel) {
        return Ok(QrScanResult::cancelled());
    }

    let n = paths.len();
    let result = run_ends_first(
        paths,
        |path, stop| scan_photo(ffmpeg_bin, path, options, Some(stop)),
        parallel_workers,
        cancel,
        on_file,
        true,
        Some(PHOTO_EDGE_SCAN_PER_SIDE),
    )?;

    if result.found || result.cancelled {
        return Ok(result);
    }

    let cap = PHOTO_EDGE_SCAN_PER_SIDE.saturating_mul(2);
    if n > cap {
        Ok(QrScanResult::miss(format!(
            "Kein gültiger QR-Code an den Listenenden gefunden (je {PHOTO_EDGE_SCAN_PER_SIDE} Fotos geprüft)."
        )))
    } else {
        Ok(QrScanResult::miss(format!(
            "Kein gültiger QR-Code in {} Foto(s) gefunden.",
            n
        )))
    }
}

fn run_ends_first<F>(
    items: &[String],
    scan_one: F,
    parallel_workers: usize,
    cancel: Option<&AtomicBool>,
    on_file: Option<&QrFileProgressCb<'_>>,
    skip_hot_path: bool,
    edge_per_side: Option<usize>,
) -> Result<QrScanResult, QrScanError>
where
    F: Fn(&str, &AtomicBool) -> Result<QrScanResult, QrScanError> + Sync,
{
    if items.is_empty() {
        return Ok(QrScanResult::miss("empty"));
    }

    let n = items.len();
    let jobs = match edge_per_side {
        Some(per_side) => ends_first_edge_jobs(n, per_side),
        None => ends_first_jobs(n),
    };
    if jobs.is_empty() {
        return Ok(QrScanResult::miss("empty"));
    }

    // Photos: skip the 2-worker end probe so all workers start immediately.
    if skip_hot_path {
        let workers = phase_b_worker_count(n, parallel_workers)
            .min(jobs.len())
            .max(1);
        return run_job_pool(items, &jobs, &scan_one, workers, cancel, on_file);
    }

    let hot_len = HOT_PATH_WORKERS.min(n).max(1).min(jobs.len());
    let (hot, rest) = jobs.split_at(hot_len);

    let hot_workers = HOT_PATH_WORKERS.min(hot.len()).min(parallel_workers.max(1));
    let hot_result = run_job_pool(items, hot, &scan_one, hot_workers, cancel, on_file)?;
    if hot_result.found || hot_result.cancelled {
        return Ok(hot_result);
    }

    if rest.is_empty() {
        return Ok(hot_result);
    }

    let b_workers = phase_b_worker_count(n, parallel_workers).min(rest.len()).max(1);
    run_job_pool(items, rest, &scan_one, b_workers, cancel, on_file)
}

fn run_job_pool<F>(
    items: &[String],
    jobs: &[EndsFirstJob],
    scan_one: &F,
    workers: usize,
    cancel: Option<&AtomicBool>,
    on_file: Option<&QrFileProgressCb<'_>>,
) -> Result<QrScanResult, QrScanError>
where
    F: Fn(&str, &AtomicBool) -> Result<QrScanResult, QrScanError> + Sync,
{
    if jobs.is_empty() {
        return Ok(QrScanResult::miss("empty"));
    }

    let workers = workers.max(1).min(jobs.len()).min(4);
    let stop = Arc::new(AtomicBool::new(false));
    let next = Arc::new(AtomicUsize::new(0));
    let items = items.to_vec();
    let jobs = jobs.to_vec();
    let (tx, rx) = mpsc::channel::<Result<QrScanResult, QrScanError>>();

    let notify = |path: &str, phase: &str| {
        if let Some(cb) = on_file {
            cb(path, phase, 0, 0);
        }
    };

    thread::scope(|scope| {
        for _ in 0..workers {
            let stop = Arc::clone(&stop);
            let next = Arc::clone(&next);
            let items = &items;
            let jobs = &jobs;
            let tx = tx.clone();

            scope.spawn(move || {
                loop {
                    if cancelled(cancel) {
                        let _ = tx.send(Ok(QrScanResult::cancelled()));
                        break;
                    }
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }

                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= jobs.len() {
                        break;
                    }
                    let job = jobs[i];
                    let path = &items[job.index];
                    notify(path, "start");
                    match scan_one(path, &stop) {
                        Ok(res) if res.found => {
                            stop.store(true, Ordering::SeqCst);
                            notify(path, "hit");
                            let _ = tx.send(Ok(res.with_cleanup_direction(job.cleanup)));
                            break;
                        }
                        Ok(res) if res.cancelled => {
                            stop.store(true, Ordering::SeqCst);
                            notify(path, "done");
                            let _ = tx.send(Ok(res));
                            break;
                        }
                        Ok(_) => {
                            notify(path, "done");
                        }
                        Err(e) => {
                            notify(path, "done");
                            eprintln!("QR parallel scan error ({path}): {e}");
                        }
                    }
                }
            });
        }
        drop(tx);

        let mut last = QrScanResult::miss("Kein gültiger QR-Code gefunden.");
        for msg in rx.iter() {
            match msg {
                Ok(res) if res.found || res.cancelled => {
                    stop.store(true, Ordering::SeqCst);
                    return Ok(res);
                }
                Ok(res) => last = res,
                Err(e) => return Err(e),
            }
            if cancelled(cancel) {
                stop.store(true, Ordering::SeqCst);
                return Ok(QrScanResult::cancelled());
            }
        }
        Ok(last)
    })
}

/// Legacy quarter split kept for reference / potential photo fallbacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuarterRange {
    pub start: usize,
    pub end: usize,
    pub reverse: bool,
}

#[allow(dead_code)]
pub fn quarter_ranges(n: usize, max_workers: usize) -> Vec<QuarterRange> {
    if n == 0 {
        return Vec::new();
    }
    let workers = max_workers.max(1).min(4).min(n);
    let mut ranges = Vec::with_capacity(workers);
    for i in 0..workers {
        let start = i * n / workers;
        let end = (i + 1) * n / workers;
        if start >= end {
            continue;
        }
        let reverse = workers >= 2 && i == workers - 1;
        ranges.push(QuarterRange {
            start,
            end,
            reverse,
        });
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;
    use CleanupDirection::{Backward, Forward};

    #[test]
    fn ends_first_order_typical() {
        let jobs = ends_first_jobs(5);
        assert_eq!(
            jobs.iter().map(|j| j.index).collect::<Vec<_>>(),
            vec![0, 4, 1, 3, 2]
        );
        assert_eq!(jobs[0].cleanup, Forward);
        assert_eq!(jobs[1].cleanup, Backward);
        assert_eq!(jobs[2].cleanup, Forward);
        assert_eq!(jobs[3].cleanup, Backward);
        assert_eq!(jobs[4].cleanup, Forward);
    }

    #[test]
    fn ends_first_order_covers_all_once() {
        for n in 0..20 {
            let jobs = ends_first_jobs(n);
            assert_eq!(jobs.len(), n);
            let mut idxs: Vec<_> = jobs.iter().map(|j| j.index).collect();
            idxs.sort_unstable();
            assert_eq!(idxs, (0..n).collect::<Vec<_>>());
        }
    }

    #[test]
    fn ends_first_hot_is_first_and_last() {
        assert_eq!(
            ends_first_hot_jobs(1)
                .iter()
                .map(|j| j.index)
                .collect::<Vec<_>>(),
            vec![0]
        );
        assert_eq!(
            ends_first_hot_jobs(8)
                .iter()
                .map(|j| j.index)
                .collect::<Vec<_>>(),
            vec![0, 7]
        );
        assert_eq!(ends_first_hot_jobs(8)[0].cleanup, Forward);
        assert_eq!(ends_first_hot_jobs(8)[1].cleanup, Backward);
    }

    #[test]
    fn ends_first_two_items() {
        let jobs = ends_first_jobs(2);
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].index, 0);
        assert_eq!(jobs[1].index, 1);
        assert_eq!(jobs[0].cleanup, Forward);
        assert_eq!(jobs[1].cleanup, Backward);
    }

    #[test]
    fn photo_edge_jobs_caps_at_forty() {
        let jobs = ends_first_edge_jobs(220, PHOTO_EDGE_SCAN_PER_SIDE);
        assert_eq!(jobs.len(), 40);
        assert_eq!(jobs[0].index, 0);
        assert_eq!(jobs[1].index, 219);
        let mut idxs: Vec<_> = jobs.iter().map(|j| j.index).collect();
        idxs.sort_unstable();
        let mut expected: Vec<usize> = (0..20).collect();
        expected.extend(200..220);
        assert_eq!(idxs, expected);
    }

    #[test]
    fn photo_edge_jobs_small_list_unchanged() {
        assert_eq!(ends_first_edge_jobs(12, 20).len(), 12);
        assert_eq!(ends_first_edge_jobs(40, 20).len(), 40);
        assert_eq!(ends_first_edge_jobs(41, 20).len(), 40);
    }

    #[test]
    fn photo_edge_scan_indices_list_order() {
        assert_eq!(photo_edge_scan_indices(12, 20), (0..12).collect::<Vec<_>>());
        assert_eq!(
            photo_edge_scan_indices(46, 20),
            {
                let mut v: Vec<usize> = (0..20).collect();
                v.extend(26..46);
                v
            }
        );
    }

    #[test]
    fn phase_b_workers_cap() {
        assert_eq!(phase_b_worker_count(5, 4), 2);
        assert_eq!(phase_b_worker_count(6, 4), 4);
        assert_eq!(phase_b_worker_count(10, 1), 1);
        assert_eq!(phase_b_worker_count(220, 4), 4);
    }

    #[test]
    fn quarters_four_workers_cover_all_once() {
        let n = 16;
        let ranges = quarter_ranges(n, 4);
        assert_eq!(ranges.len(), 4);
        let mut covered: Vec<usize> = ranges.iter().flat_map(|r| r.start..r.end).collect();
        covered.sort_unstable();
        assert_eq!(covered, (0..n).collect::<Vec<_>>());
    }
}
