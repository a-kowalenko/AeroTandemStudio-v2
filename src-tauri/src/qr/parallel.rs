//! Parallel QR scanning with up to 4 quarter-based workers.
//!
//! Worker layout for a list of length `n` (max 4 threads):
//! 1. starts at 0/4 → scans forward through the first quarter
//! 2. starts at 1/4 → scans forward through the second quarter
//! 3. starts at 2/4 → scans forward through the third quarter
//! 4. starts at 4/4 (end) → scans backward until 3/4

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use crate::video::ffmpeg;

use super::analyser::{
    scan_photo, scan_video_clip, CleanupDirection, QrScanError, QrScanOptions, QrScanResult,
};

/// One worker segment: inclusive start index, exclusive end, and scan direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuarterRange {
    pub start: usize,
    pub end: usize,
    /// If true, scan from `end - 1` down to `start` (last quarter).
    pub reverse: bool,
}

/// Split `n` items into up to `max_workers` contiguous quarters (max 4).
/// The last range always scans backward when there are 2+ workers.
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

fn cancelled(cancel: Option<&AtomicBool>) -> bool {
    ffmpeg::is_cancelled() || cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false)
}

/// Optional per-file progress: `(path, phase)` where phase is `start` | `done` | `hit`.
pub type QrFileProgressCb<'a> = dyn Fn(&str, &str) + Sync + 'a;

/// Parallel quarter scan over the full video list (up to 4 workers).
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

    let result = run_parallel_quarters(
        paths,
        |path, stop| scan_video_clip(ffmpeg_bin, path, options, Some(stop)),
        parallel_workers,
        cancel,
        on_file,
    )?;

    if result.found || result.cancelled {
        return Ok(result);
    }

    Ok(QrScanResult::miss(format!(
        "Kein gültiger QR-Code in {} Clip(s) gefunden.",
        paths.len()
    )))
}

/// Parallel quarter scan over the full photo list (up to 4 workers).
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

    let result = run_parallel_quarters(
        paths,
        |path, stop| scan_photo(ffmpeg_bin, path, options, Some(stop)),
        parallel_workers,
        cancel,
        on_file,
    )?;

    if result.found || result.cancelled {
        return Ok(result);
    }

    Ok(QrScanResult::miss(format!(
        "Kein gültiger QR-Code in {} Foto(s) gefunden.",
        paths.len()
    )))
}

fn run_parallel_quarters<F>(
    items: &[String],
    scan_one: F,
    parallel_workers: usize,
    cancel: Option<&AtomicBool>,
    on_file: Option<&QrFileProgressCb<'_>>,
) -> Result<QrScanResult, QrScanError>
where
    F: Fn(&str, &AtomicBool) -> Result<QrScanResult, QrScanError> + Sync,
{
    if items.is_empty() {
        return Ok(QrScanResult::miss("empty"));
    }

    let ranges = quarter_ranges(items.len(), parallel_workers);
    if ranges.is_empty() {
        return Ok(QrScanResult::miss("empty"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let items = items.to_vec();
    let scan_one = &scan_one;
    let (tx, rx) = mpsc::channel::<Result<QrScanResult, QrScanError>>();

    let notify = |path: &str, phase: &str| {
        if let Some(cb) = on_file {
            cb(path, phase);
        }
    };

    thread::scope(|scope| {
        for range in ranges {
            let stop = Arc::clone(&stop);
            let items = &items;
            let tx = tx.clone();

            scope.spawn(move || {
                let indices: Vec<usize> = if range.reverse {
                    (range.start..range.end).rev().collect()
                } else {
                    (range.start..range.end).collect()
                };

                for list_index in indices {
                    if cancelled(cancel) {
                        let _ = tx.send(Ok(QrScanResult::cancelled()));
                        break;
                    }
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }

                    let path = &items[list_index];
                    notify(path, "start");
                    match scan_one(path, &stop) {
                        Ok(res) if res.found => {
                            stop.store(true, Ordering::SeqCst);
                            notify(path, "hit");
                            let direction = if range.reverse {
                                CleanupDirection::Backward
                            } else {
                                CleanupDirection::Forward
                            };
                            let _ = tx.send(Ok(res.with_cleanup_direction(direction)));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quarters_four_workers_cover_all_once() {
        let n = 16;
        let ranges = quarter_ranges(n, 4);
        assert_eq!(ranges.len(), 4);
        assert_eq!(
            ranges,
            vec![
                QuarterRange {
                    start: 0,
                    end: 4,
                    reverse: false
                },
                QuarterRange {
                    start: 4,
                    end: 8,
                    reverse: false
                },
                QuarterRange {
                    start: 8,
                    end: 12,
                    reverse: false
                },
                QuarterRange {
                    start: 12,
                    end: 16,
                    reverse: true
                },
            ]
        );

        let mut seen = Vec::new();
        for r in &ranges {
            if r.reverse {
                seen.extend((r.start..r.end).rev());
            } else {
                seen.extend(r.start..r.end);
            }
        }
        let mut sorted = seen.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..n).collect::<Vec<_>>());
        // last quarter walks backward: 15,14,13,12
        assert_eq!(
            (ranges[3].start..ranges[3].end).rev().collect::<Vec<_>>(),
            vec![15, 14, 13, 12]
        );
    }

    #[test]
    fn quarters_uneven_length() {
        let ranges = quarter_ranges(10, 4);
        assert_eq!(ranges.len(), 4);
        let mut covered: Vec<usize> = ranges
            .iter()
            .flat_map(|r| r.start..r.end)
            .collect();
        covered.sort_unstable();
        assert_eq!(covered, (0..10).collect::<Vec<_>>());
        assert!(ranges[3].reverse);
        assert!(!ranges[0].reverse);
        assert!(!ranges[1].reverse);
        assert!(!ranges[2].reverse);
    }

    #[test]
    fn quarters_single_item() {
        let ranges = quarter_ranges(1, 4);
        assert_eq!(
            ranges,
            vec![QuarterRange {
                start: 0,
                end: 1,
                reverse: false
            }]
        );
    }

    #[test]
    fn quarters_two_workers_last_reverse() {
        let ranges = quarter_ranges(8, 2);
        assert_eq!(ranges.len(), 2);
        assert!(!ranges[0].reverse);
        assert!(ranges[1].reverse);
        assert_eq!(ranges[0], QuarterRange {
            start: 0,
            end: 4,
            reverse: false
        });
        assert_eq!(ranges[1], QuarterRange {
            start: 4,
            end: 8,
            reverse: true
        });
    }

    #[test]
    fn quarters_empty() {
        assert!(quarter_ranges(0, 4).is_empty());
    }

    #[test]
    fn quarters_caps_at_four() {
        let ranges = quarter_ranges(100, 8);
        assert_eq!(ranges.len(), 4);
    }
}
