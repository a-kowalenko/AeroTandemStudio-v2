//! Background mirror of a completed local SD backup to an optional second root
//! (NAS / network path) so the interactive workflow is not blocked.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(test)]
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::media::dji_paths::{write_backup_manifest, ManifestEntry};
use crate::storage::logging;

pub const EVENT_SECONDARY_BACKUP: &str = "sd-secondary-backup";

#[derive(Debug, Clone, Serialize)]
pub struct SecondaryBackupEvent {
    /// `started` | `progress` | `done` | `failed`
    pub state: String,
    pub job_id: String,
    pub primary_path: String,
    pub secondary_path: Option<String>,
    pub current: u64,
    pub total: u64,
    pub percent: f64,
    pub file_name: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SecondaryBackupJob {
    pub id: String,
    pub primary_path: PathBuf,
    pub secondary_root: PathBuf,
    pub backup_dir_name: String,
    /// Destination filenames relative to the primary backup folder.
    pub filenames: Vec<String>,
    pub dcim_source: String,
    pub manifest_entries: Vec<ManifestEntry>,
    pub timelapse_session_active: bool,
}

type EventCb = Arc<dyn Fn(SecondaryBackupEvent) + Send + Sync>;

pub struct SecondaryBackupQueue {
    jobs: Mutex<VecDeque<SecondaryBackupJob>>,
    running: AtomicBool,
    on_event: Mutex<Option<EventCb>>,
}

pub static SECONDARY_BACKUP: Lazy<SecondaryBackupQueue> =
    Lazy::new(|| SecondaryBackupQueue {
        jobs: Mutex::new(VecDeque::new()),
        running: AtomicBool::new(false),
        on_event: Mutex::new(None),
    });

impl SecondaryBackupQueue {
    pub fn set_callback(&self, cb: Option<EventCb>) {
        *self.on_event.lock().unwrap() = cb;
    }

    pub fn enqueue(&self, job: SecondaryBackupJob) {
        logging::info(
            "sd",
            format!(
                "Secondary backup queued: id={}, files={}, dest={}",
                job.id,
                job.filenames.len(),
                job.secondary_root.display()
            ),
        );
        self.jobs.lock().unwrap().push_back(job);
        self.kick();
    }

    fn kick(&self) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        thread::spawn(|| {
            SECONDARY_BACKUP.worker_loop();
        });
    }

    fn worker_loop(&self) {
        loop {
            let job = {
                let mut q = self.jobs.lock().unwrap();
                q.pop_front()
            };
            let Some(job) = job else {
                self.running.store(false, Ordering::SeqCst);
                // Race: job enqueued after empty check but before running=false.
                let again = {
                    let q = self.jobs.lock().unwrap();
                    !q.is_empty()
                };
                if again && !self.running.swap(true, Ordering::SeqCst) {
                    continue;
                }
                return;
            };
            self.run_job(job);
        }
    }

    fn emit(&self, event: SecondaryBackupEvent) {
        if let Some(cb) = self.on_event.lock().unwrap().as_ref() {
            cb(event);
        }
    }

    fn run_job(&self, job: SecondaryBackupJob) {
        let primary = job.primary_path.to_string_lossy().into_owned();
        let total = job.filenames.len() as u64;
        self.emit(SecondaryBackupEvent {
            state: "started".into(),
            job_id: job.id.clone(),
            primary_path: primary.clone(),
            secondary_path: None,
            current: 0,
            total,
            percent: 0.0,
            file_name: None,
            message: Some("Server-Backup im Hintergrund…".into()),
        });

        match mirror_primary_to_secondary(
            &job.primary_path,
            &job.secondary_root,
            &job.backup_dir_name,
            &job.filenames,
            &job.dcim_source,
            &job.manifest_entries,
            job.timelapse_session_active,
            |current, file_name| {
                let percent = if total > 0 {
                    (current as f64 / total as f64) * 100.0
                } else {
                    100.0
                };
                self.emit(SecondaryBackupEvent {
                    state: "progress".into(),
                    job_id: job.id.clone(),
                    primary_path: primary.clone(),
                    secondary_path: None,
                    current,
                    total,
                    percent,
                    file_name: Some(file_name.to_string()),
                    message: None,
                });
            },
        ) {
            Ok(secondary) => {
                let path = secondary.to_string_lossy().into_owned();
                logging::info(
                    "sd",
                    format!("Secondary backup done: id={}, path={path}", job.id),
                );
                self.emit(SecondaryBackupEvent {
                    state: "done".into(),
                    job_id: job.id.clone(),
                    primary_path: primary,
                    secondary_path: Some(path),
                    current: total,
                    total,
                    percent: 100.0,
                    file_name: None,
                    message: Some("Server-Backup fertig".into()),
                });
            }
            Err(e) => {
                logging::warn(
                    "sd",
                    format!("Secondary backup failed: id={}, err={e}", job.id),
                );
                self.emit(SecondaryBackupEvent {
                    state: "failed".into(),
                    job_id: job.id.clone(),
                    primary_path: primary,
                    secondary_path: None,
                    current: 0,
                    total,
                    percent: 0.0,
                    file_name: None,
                    message: Some(e),
                });
            }
        }
    }

    /// Test helper: wait until the queue is idle (no jobs, not running).
    #[cfg(test)]
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            let empty = self.jobs.lock().unwrap().is_empty();
            let running = self.running.load(Ordering::SeqCst);
            if empty && !running {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[cfg(test)]
    pub fn clear_for_test(&self) {
        self.jobs.lock().unwrap().clear();
        // Do not force-clear `running` — wait_idle handles in-flight work.
    }
}

/// Serialize tests that touch the global secondary-backup queue.
#[cfg(test)]
pub fn with_queue_lock<R>(f: impl FnOnce() -> R) -> R {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Wait for any leftover work from a previous test, then drain.
    let _ = SECONDARY_BACKUP.wait_idle(Duration::from_secs(5));
    SECONDARY_BACKUP.clear_for_test();
    f()
}

/// Copy `filenames` from `primary_path` into `secondary_root/backup_dir_name` and write manifest.
pub fn mirror_primary_to_secondary(
    primary_path: &Path,
    secondary_root: &Path,
    backup_dir_name: &str,
    filenames: &[String],
    dcim_source: &str,
    manifest_entries: &[ManifestEntry],
    timelapse_session_active: bool,
    mut on_file: impl FnMut(u64, &str),
) -> Result<PathBuf, String> {
    if !primary_path.is_dir() {
        return Err(format!(
            "Lokaler Backup-Ordner fehlt: {}",
            primary_path.display()
        ));
    }
    if !secondary_root.is_dir() {
        return Err(format!(
            "Zweiter Backup-Pfad ungültig: {}",
            secondary_root.display()
        ));
    }

    let secondary = secondary_root.join(backup_dir_name);
    fs::create_dir_all(&secondary).map_err(|e| {
        format!(
            "Zweiter Backup-Pfad nicht erstellbar ({}): {e}",
            secondary.display()
        )
    })?;

    for (i, name) in filenames.iter().enumerate() {
        let src = primary_path.join(name);
        let dst = secondary.join(name);
        if !src.is_file() {
            let _ = fs::remove_dir_all(&secondary);
            return Err(format!("Quelldatei fehlt im lokalen Backup: {name}"));
        }
        if let Err(e) = fs::copy(&src, &dst) {
            let _ = fs::remove_dir_all(&secondary);
            return Err(format!("Zweiter Backup teilweise fehlgeschlagen: {e}"));
        }
        on_file((i as u64) + 1, name);
    }

    write_backup_manifest(
        &secondary,
        dcim_source,
        manifest_entries,
        timelapse_session_active,
    )
    .map_err(|e| format!("Manifest auf zweitem Pfad fehlgeschlagen: {e}"))?;

    Ok(secondary)
}

pub fn new_job_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("sec-{nanos}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn mirror_copies_files_and_manifest() {
        let primary = tempdir().unwrap();
        let secondary_root = tempdir().unwrap();
        fs::write(primary.path().join("a.mp4"), b"video").unwrap();
        fs::write(primary.path().join("b.jpg"), b"photo").unwrap();

        let entries = vec![
            ManifestEntry {
                dest: "a.mp4".into(),
                src: Some("X:/a.mp4".into()),
                media_type: "video".into(),
            },
            ManifestEntry {
                dest: "b.jpg".into(),
                src: Some("X:/b.jpg".into()),
                media_type: "photo".into(),
            },
        ];
        let filenames = vec!["a.mp4".into(), "b.jpg".into()];
        let mut seen = 0u64;
        let out = mirror_primary_to_secondary(
            primary.path(),
            secondary_root.path(),
            "SD_Backup_test",
            &filenames,
            "X:/DCIM",
            &entries,
            false,
            |n, _| seen = n,
        )
        .unwrap();

        assert_eq!(seen, 2);
        assert!(out.join("a.mp4").is_file());
        assert!(out.join("b.jpg").is_file());
        assert!(out
            .join(crate::media::dji_paths::BACKUP_MANIFEST_NAME)
            .is_file());
    }

    #[test]
    fn queue_runs_async_job() {
        with_queue_lock(|| {
            let primary = tempdir().unwrap();
            let secondary_root = tempdir().unwrap();
            fs::write(primary.path().join("clip.mp4"), b"ok").unwrap();

            let job = SecondaryBackupJob {
                id: "test-job".into(),
                primary_path: primary.path().to_path_buf(),
                secondary_root: secondary_root.path().to_path_buf(),
                backup_dir_name: "SD_Backup_async".into(),
                filenames: vec!["clip.mp4".into()],
                dcim_source: "X:/DCIM".into(),
                manifest_entries: vec![ManifestEntry {
                    dest: "clip.mp4".into(),
                    src: None,
                    media_type: "video".into(),
                }],
                timelapse_session_active: false,
            };

            SECONDARY_BACKUP.enqueue(job);
            assert!(SECONDARY_BACKUP.wait_idle(Duration::from_secs(5)));
            assert!(secondary_root
                .path()
                .join("SD_Backup_async")
                .join("clip.mp4")
                .is_file());
        });
    }
}
