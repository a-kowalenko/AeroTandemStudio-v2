//! CPU budget for background work (OPT-24 C3): no pool may claim every core on its own.

use std::sync::OnceLock;

/// Logical CPUs (`available_parallelism`, cached; 1 when unknown).
pub fn cpu_count() -> usize {
    static CPUS: OnceLock<usize> = OnceLock::new();
    *CPUS.get_or_init(|| {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
    })
}

/// Worker count for a background pool: half the cores, at least 1, at most `max`.
pub fn background_workers(max: usize) -> usize {
    background_workers_for(cpu_count(), max)
}

/// FFmpeg `-threads` per worker so `workers` parallel encoders share the cores.
pub fn ffmpeg_threads_per_worker(workers: usize) -> usize {
    ffmpeg_threads_per_worker_for(cpu_count(), workers)
}

fn background_workers_for(cpus: usize, max: usize) -> usize {
    (cpus / 2).clamp(1, max.max(1))
}

fn ffmpeg_threads_per_worker_for(cpus: usize, workers: usize) -> usize {
    (cpus / workers.max(1)).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_workers_scale_with_cores() {
        assert_eq!(background_workers_for(1, 4), 1);
        assert_eq!(background_workers_for(2, 4), 1);
        assert_eq!(background_workers_for(4, 4), 2);
        assert_eq!(background_workers_for(8, 4), 4);
        assert_eq!(background_workers_for(16, 4), 4);
        assert_eq!(background_workers_for(16, 0), 1);
    }

    #[test]
    fn ffmpeg_threads_split_cores_between_workers() {
        assert_eq!(ffmpeg_threads_per_worker_for(2, 2), 1);
        assert_eq!(ffmpeg_threads_per_worker_for(4, 2), 2);
        assert_eq!(ffmpeg_threads_per_worker_for(8, 4), 2);
        assert_eq!(ffmpeg_threads_per_worker_for(16, 3), 5);
        assert_eq!(ffmpeg_threads_per_worker_for(4, 8), 1);
        assert_eq!(ffmpeg_threads_per_worker_for(4, 0), 4);
    }

    #[test]
    fn cpu_count_is_positive() {
        assert!(cpu_count() >= 1);
        assert!(background_workers(4) >= 1);
    }
}
