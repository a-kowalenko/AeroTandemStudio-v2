//! Parallel video encoding pool (behaviour port of legacy `parallel_processor.py`).
//!
//! Worker limit:
//! - Hardware encoding: `min(cpu_count, 4)`
//! - Software encoding: `max(1, cpu_count / 2)`

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;

use thiserror::Error;

use super::ffmpeg::is_cancelled;

#[derive(Debug, Error)]
pub enum ParallelError {
    #[error("parallel processing cancelled")]
    Cancelled,
    #[error("{0}")]
    Message(String),
}

/// Parallel encode coordinator — mirrors legacy `ParallelVideoProcessor`.
#[derive(Debug, Clone)]
#[allow(dead_code)] // fields exposed for diagnostics / future config UI (Phase 5)
pub struct ParallelVideoProcessor {
    pub max_workers: usize,
    pub hw_accel_enabled: bool,
    pub cpu_count: usize,
}

impl ParallelVideoProcessor {
    pub fn new(hw_accel_enabled: bool) -> Self {
        let cpu_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        let max_workers = calculate_optimal_workers(hw_accel_enabled, cpu_count);
        Self {
            max_workers,
            hw_accel_enabled,
            cpu_count,
        }
    }

    #[allow(dead_code)] // used by future settings UI / diagnostics
    pub fn worker_info(&self) -> WorkerInfo {
        WorkerInfo {
            max_workers: self.max_workers,
            cpu_count: self.cpu_count,
            hw_accel_enabled: self.hw_accel_enabled,
        }
    }

    /// Run `count` indexed tasks with at most `max_workers` threads.
    ///
    /// `work(index, task_id)` — `task_id` is 1-based (legacy).
    /// Results are returned sorted by original index.
    ///
    /// If `cancelled` is set (or global FFmpeg cancel), remaining work stops
    /// and [`ParallelError::Cancelled`] is returned.
    pub fn process_indexed<T, E, F>(
        &self,
        count: usize,
        work: F,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Vec<Result<T, E>>, ParallelError>
    where
        T: Send,
        E: Send,
        F: Fn(usize, u32) -> Result<T, E> + Sync,
    {
        if count == 0 {
            return Ok(Vec::new());
        }

        let workers = self.max_workers.min(count).max(1);
        let (job_tx, job_rx) = mpsc::channel::<usize>();
        for i in 0..count {
            job_tx
                .send(i)
                .map_err(|_| ParallelError::Message("failed to enqueue task".into()))?;
        }
        drop(job_tx);

        let job_rx = Mutex::new(job_rx);
        let results: Mutex<Vec<(usize, Result<T, E>)>> = Mutex::new(Vec::with_capacity(count));
        let stop = AtomicBool::new(false);

        thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    loop {
                        if stop.load(Ordering::SeqCst)
                            || is_cancelled()
                            || cancelled.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false)
                        {
                            break;
                        }

                        let idx = {
                            let Ok(guard) = job_rx.lock() else {
                                break;
                            };
                            guard.recv().ok()
                        };
                        let Some(i) = idx else {
                            break;
                        };

                        if stop.load(Ordering::SeqCst)
                            || is_cancelled()
                            || cancelled.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false)
                        {
                            break;
                        }

                        let task_id = (i + 1) as u32;
                        let result = work(i, task_id);
                        if let Ok(mut out) = results.lock() {
                            out.push((i, result));
                        }
                    }
                });
            }
        });

        if is_cancelled() || cancelled.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            return Err(ParallelError::Cancelled);
        }

        let mut pairs = results
            .into_inner()
            .map_err(|_| ParallelError::Message("results lock poisoned".into()))?;
        pairs.sort_by_key(|(i, _)| *i);

        if pairs.len() != count {
            return Err(ParallelError::Cancelled);
        }

        Ok(pairs.into_iter().map(|(_, r)| r).collect())
    }
}

/// Worker configuration snapshot (legacy `get_worker_info`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[allow(dead_code)]
pub struct WorkerInfo {
    pub max_workers: usize,
    pub cpu_count: usize,
    pub hw_accel_enabled: bool,
}

/// Optimal worker count — pure, unit-tested.
///
/// - HW: `min(cpu_count, 4)`
/// - SW: `max(1, cpu_count / 2)`
pub fn calculate_optimal_workers(hw_accel_enabled: bool, cpu_count: usize) -> usize {
    let cpu = cpu_count.max(1);
    if hw_accel_enabled {
        cpu.min(4)
    } else {
        (cpu / 2).max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[test]
    fn workers_hw_capped_at_four() {
        assert_eq!(calculate_optimal_workers(true, 16), 4);
        assert_eq!(calculate_optimal_workers(true, 2), 2);
        assert_eq!(calculate_optimal_workers(true, 1), 1);
    }

    #[test]
    fn workers_software_half_cores() {
        assert_eq!(calculate_optimal_workers(false, 8), 4);
        assert_eq!(calculate_optimal_workers(false, 3), 1);
        assert_eq!(calculate_optimal_workers(false, 1), 1);
    }

    #[test]
    fn process_indexed_preserves_order() {
        let pool = ParallelVideoProcessor {
            max_workers: 3,
            hw_accel_enabled: false,
            cpu_count: 8,
        };
        let results = pool
            .process_indexed(5, |i, task_id| Ok::<_, ()>((i, task_id)), None)
            .unwrap();
        assert_eq!(results.len(), 5);
        for (i, r) in results.iter().enumerate() {
            let (idx, task_id) = r.as_ref().unwrap();
            assert_eq!(*idx, i);
            assert_eq!(*task_id, (i + 1) as u32);
        }
    }

    #[test]
    fn process_indexed_runs_in_parallel() {
        let pool = ParallelVideoProcessor {
            max_workers: 4,
            hw_accel_enabled: true,
            cpu_count: 8,
        };
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);

        let _ = pool
            .process_indexed(
                4,
                |_i, _tid| {
                    let cur = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(cur, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(40));
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok::<_, ()>(())
                },
                None,
            )
            .unwrap();

        assert!(
            peak.load(Ordering::SeqCst) >= 2,
            "expected concurrent workers, peak={}",
            peak.load(Ordering::SeqCst)
        );
    }

    #[test]
    fn process_indexed_respects_cancel() {
        let pool = ParallelVideoProcessor {
            max_workers: 2,
            hw_accel_enabled: false,
            cpu_count: 4,
        };
        let cancel = AtomicBool::new(false);
        let started = AtomicUsize::new(0);

        let result = pool.process_indexed(
            8,
            |_i, _tid| {
                started.fetch_add(1, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(30));
                if started.load(Ordering::SeqCst) >= 2 {
                    cancel.store(true, Ordering::SeqCst);
                }
                Ok::<_, ()>(())
            },
            Some(&cancel),
        );

        assert!(matches!(result, Err(ParallelError::Cancelled)));
    }

    #[test]
    fn worker_info_matches() {
        let p = ParallelVideoProcessor::new(false);
        let info = p.worker_info();
        assert_eq!(info.max_workers, p.max_workers);
        assert_eq!(info.hw_accel_enabled, false);
        assert!(info.cpu_count >= 1);
    }
}
