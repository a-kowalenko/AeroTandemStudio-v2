//! Background mirror of a completed local SD backup to a server target via SMB2
//! (same transport as Erstellen-Upload). Local absolute paths remain a fallback
//! for tests / rare local dual-disk setups — not Finder mounts as the primary path.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(test)]
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::smb::{upload_path, UploadProgress, UploadResult};
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
    /// `smb://…`, UNC, or local path fallback (same as Erstellen-Upload).
    pub server_url: String,
    pub login: String,
    pub password: String,
    pub backup_dir_name: String,
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
                "Secondary backup queued: id={}, dest={}, folder={}",
                job.id, job.server_url, job.backup_dir_name
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
        let on_event = self.on_event.lock().unwrap().clone();
        self.emit(SecondaryBackupEvent {
            state: "started".into(),
            job_id: job.id.clone(),
            primary_path: primary.clone(),
            secondary_path: None,
            current: 0,
            total: 0,
            percent: 0.0,
            file_name: None,
            message: Some("Server-Backup im Hintergrund…".into()),
        });

        let job_id = job.id.clone();
        let primary_for_cb = primary.clone();
        match mirror_backup_to_smb(
            &job.primary_path,
            &job.server_url,
            &job.login,
            &job.password,
            move |p: UploadProgress| {
                let Some(cb) = on_event.as_ref() else {
                    return;
                };
                cb(SecondaryBackupEvent {
                    state: "progress".into(),
                    job_id: job_id.clone(),
                    primary_path: primary_for_cb.clone(),
                    secondary_path: None,
                    current: u64::from(p.current_file),
                    total: u64::from(p.total_files),
                    percent: p.percent,
                    file_name: if p.filename.is_empty() {
                        None
                    } else {
                        Some(p.filename.clone())
                    },
                    message: None,
                });
            },
        ) {
            Ok(secondary) => {
                logging::info(
                    "sd",
                    format!("Secondary backup done: id={}, path={secondary}", job.id),
                );
                self.emit(SecondaryBackupEvent {
                    state: "done".into(),
                    job_id: job.id.clone(),
                    primary_path: primary,
                    secondary_path: Some(secondary),
                    current: 0,
                    total: 0,
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
                    total: 0,
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

/// Upload the local backup session folder to `server_url` (SMB2 / UNC / local fallback).
///
/// Uses the same layout as Erstellen-Upload: remote folder name = leaf of `primary_path`
/// (i.e. `backup_dir_name`), including the backup manifest.
pub fn mirror_backup_to_smb<F>(
    primary_path: &Path,
    server_url: &str,
    login: &str,
    password: &str,
    on_progress: F,
) -> Result<String, String>
where
    F: FnMut(UploadProgress) + Send + 'static,
{
    if !primary_path.is_dir() {
        return Err(format!(
            "Lokaler Backup-Ordner fehlt: {}",
            primary_path.display()
        ));
    }
    let url = server_url.trim();
    if url.is_empty() {
        return Err("Server-Backup-URL fehlt".into());
    }

    let result: UploadResult =
        tauri::async_runtime::block_on(upload_path(primary_path, url, login, password, on_progress));

    if result.success {
        let leaf = primary_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let remote = if result.remote_path.is_empty() {
            format!("{}/{}", url.trim_end_matches('/'), leaf)
        } else if !leaf.is_empty() && !result.remote_path.contains(&leaf) {
            // Local upload returns dest root only; append session folder for display.
            std::path::Path::new(&result.remote_path)
                .join(&leaf)
                .to_string_lossy()
                .into_owned()
        } else {
            result.remote_path
        };
        Ok(remote)
    } else {
        Err(result.message)
    }
}

/// Expected remote relative folder under the configured backup root.
pub fn remote_backup_relpath(backup_dir_name: &str) -> String {
    backup_dir_name.trim().trim_matches('/').replace('\\', "/")
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
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn remote_backup_relpath_normalizes() {
        assert_eq!(remote_backup_relpath("SD_Backup_x"), "SD_Backup_x");
        assert_eq!(remote_backup_relpath("  a\\b  "), "a/b");
    }

    #[test]
    fn mirror_soft_fails_empty_url() {
        let primary = tempdir().unwrap();
        fs::write(primary.path().join("a.mp4"), b"v").unwrap();
        let err = mirror_backup_to_smb(primary.path(), "  ", "", "", |_| {}).unwrap_err();
        assert!(err.contains("URL"), "{err}");
    }

    #[test]
    fn mirror_soft_fails_bad_smb_url() {
        let primary = tempdir().unwrap();
        fs::write(primary.path().join("a.mp4"), b"v").unwrap();
        let err = mirror_backup_to_smb(primary.path(), "smb://", "", "", |_| {}).unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn mirror_uploads_folder_to_local_fallback() {
        let primary = tempdir().unwrap();
        let dest_root = tempdir().unwrap();
        fs::write(primary.path().join("a.mp4"), b"video").unwrap();
        fs::write(primary.path().join("manifest.json"), b"{}").unwrap();

        // Mimic build_backup_dir_name leaf under a parent.
        let session = primary.path().join("SD_Backup_test");
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("a.mp4"), b"video").unwrap();
        fs::write(
            session.join(crate::media::dji_paths::BACKUP_MANIFEST_NAME),
            b"{}",
        )
        .unwrap();

        let remote = mirror_backup_to_smb(
            &session,
            &dest_root.path().to_string_lossy(),
            "",
            "",
            |_| {},
        )
        .unwrap();

        assert!(dest_root.path().join("SD_Backup_test").join("a.mp4").is_file());
        assert!(dest_root
            .path()
            .join("SD_Backup_test")
            .join(crate::media::dji_paths::BACKUP_MANIFEST_NAME)
            .is_file());
        assert!(remote.contains("SD_Backup_test"), "{remote}");
    }

    #[test]
    fn queue_runs_async_job() {
        with_queue_lock(|| {
            let primary_root = tempdir().unwrap();
            let session = primary_root.path().join("SD_Backup_async");
            fs::create_dir_all(&session).unwrap();
            fs::write(session.join("clip.mp4"), b"ok").unwrap();

            let dest_root = tempdir().unwrap();
            let job = SecondaryBackupJob {
                id: "test-job".into(),
                primary_path: session,
                server_url: dest_root.path().to_string_lossy().into_owned(),
                login: String::new(),
                password: String::new(),
                backup_dir_name: "SD_Backup_async".into(),
            };

            SECONDARY_BACKUP.enqueue(job);
            assert!(SECONDARY_BACKUP.wait_idle(Duration::from_secs(5)));
            assert!(dest_root
                .path()
                .join("SD_Backup_async")
                .join("clip.mp4")
                .is_file());
        });
    }
}
