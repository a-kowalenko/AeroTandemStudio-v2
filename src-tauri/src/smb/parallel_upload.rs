//! OPT-15: Parallel SMB media upload with a strict marker barrier.
//!
//! Phases: media (parallel) → optional `_ams_manifest.v1.json` → `_fertig.txt` alone.
//! Commit files never share the media worker pool.

use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use smb2::{SmbClient, Tree};
use tokio::sync::Semaphore;

use crate::video::export_paths::MARKER_FILENAME;
use crate::video::ffmpeg::{is_cancelled, WORKFLOW_CANCELLED};
use crate::video::handoff_manifest::MANIFEST_FILENAME;

use super::client::{
    stream_upload_file, FileEntry, UploadProgressGate, UploadResult,
};

/// Concurrent photo / small-file streams (recommended 4–8).
pub const PHOTO_UPLOAD_PARALLELISM: usize = 6;
/// Concurrent large video streams (keep at 1 so photos can share link credits).
pub const LARGE_MEDIA_PARALLELISM: usize = 1;
/// Size floor for treating a media file as “large” (video slot), regardless of extension.
pub const LARGE_MEDIA_MIN_BYTES: u64 = 16 * 1024 * 1024;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "mkv", "m4v", "avi", "webm"];

/// Upload list split into barrier phases (media → manifest → marker).
#[derive(Debug, Clone, Default)]
pub struct UploadPhases {
    pub media: Vec<FileEntry>,
    pub manifest: Option<FileEntry>,
    pub marker: Option<FileEntry>,
}

impl UploadPhases {
    /// Media, then optional manifest, then optional marker (never interleave).
    pub fn ordered(&self) -> Vec<&FileEntry> {
        let mut out = Vec::with_capacity(
            self.media.len() + usize::from(self.manifest.is_some()) + usize::from(self.marker.is_some()),
        );
        out.extend(self.media.iter());
        if let Some(m) = &self.manifest {
            out.push(m);
        }
        if let Some(m) = &self.marker {
            out.push(m);
        }
        out
    }

    pub fn total_files(&self) -> u32 {
        (self.media.len()
            + usize::from(self.manifest.is_some())
            + usize::from(self.marker.is_some())) as u32
    }
}

/// Basename of a relative upload path (`Job/Handcam_Foto/a.jpg` → `a.jpg`).
fn entry_basename(relative: &str) -> &str {
    relative
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(relative)
}

pub fn is_marker_file(relative: &str) -> bool {
    entry_basename(relative).eq_ignore_ascii_case(MARKER_FILENAME)
}

pub fn is_manifest_file(relative: &str) -> bool {
    entry_basename(relative).eq_ignore_ascii_case(MANIFEST_FILENAME)
}

pub fn is_commit_file(relative: &str) -> bool {
    is_marker_file(relative) || is_manifest_file(relative)
}

pub fn is_large_media(entry: &FileEntry) -> bool {
    if entry.size >= LARGE_MEDIA_MIN_BYTES {
        return true;
    }
    entry
        .absolute
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            VIDEO_EXTENSIONS
                .iter()
                .any(|v| e.eq_ignore_ascii_case(v))
        })
        .unwrap_or(false)
}

/// Partition collected upload files into media / manifest / marker.
///
/// Marker and manifest are taken by basename anywhere under the job tree
/// (normally job root). Duplicate commit names: last wins (should not happen).
pub fn partition_upload_phases(files: &[FileEntry]) -> UploadPhases {
    let mut phases = UploadPhases::default();
    for file in files {
        if is_marker_file(&file.relative) {
            phases.marker = Some(file.clone());
        } else if is_manifest_file(&file.relative) {
            phases.manifest = Some(file.clone());
        } else {
            phases.media.push(file.clone());
        }
    }
    phases
}

/// Upload media files with bounded parallelism over one SMB session.
///
/// Returns bytes uploaded in this phase. Caller must upload manifest/marker
/// only after this future completes successfully (barrier).
pub async fn upload_smb_media_parallel<F>(
    client: Arc<SmbClient>,
    tree: Arc<Tree>,
    media: &[FileEntry],
    remote_paths: &[String],
    file_indices: &[u32],
    total_files: u32,
    total_bytes: u64,
    progress: Arc<Mutex<UploadProgressGate<F>>>,
    start_bytes: u64,
) -> Result<u64, UploadResult>
where
    F: FnMut(super::client::UploadProgress) + Send + 'static,
{
    debug_assert_eq!(media.len(), remote_paths.len());
    debug_assert_eq!(media.len(), file_indices.len());

    if media.is_empty() {
        return Ok(start_bytes);
    }

    let global_bytes = Arc::new(AtomicU64::new(start_bytes));
    let files_done = Arc::new(AtomicU32::new(0));
    let photo_slots = Arc::new(Semaphore::new(PHOTO_UPLOAD_PARALLELISM.max(1)));
    let large_slots = Arc::new(Semaphore::new(LARGE_MEDIA_PARALLELISM.max(1)));

    let mut set = tokio::task::JoinSet::new();

    for (i, file) in media.iter().enumerate() {
        let client = Arc::clone(&client);
        let tree = Arc::clone(&tree);
        let remote = remote_paths[i].clone();
        let file_index = file_indices[i];
        let absolute = file.absolute.clone();
        let relative = file.relative.clone();
        let large = is_large_media(file);
        let photo_slots = Arc::clone(&photo_slots);
        let large_slots = Arc::clone(&large_slots);
        let global_bytes = Arc::clone(&global_bytes);
        let files_done = Arc::clone(&files_done);
        let progress = Arc::clone(&progress);

        set.spawn(async move {
            if is_cancelled() {
                return Err(WORKFLOW_CANCELLED.to_string());
            }

            let _permit = if large {
                large_slots
                    .acquire_owned()
                    .await
                    .map_err(|_| "SMB large-media semaphore closed".to_string())?
            } else {
                photo_slots
                    .acquire_owned()
                    .await
                    .map_err(|_| "SMB photo semaphore closed".to_string())?
            };

            if is_cancelled() {
                return Err(WORKFLOW_CANCELLED.to_string());
            }

            let filename = absolute
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let mut last_reported = 0u64;

            let uploaded = stream_upload_file(
                client.as_ref(),
                tree.as_ref(),
                &absolute,
                &remote,
                |copied_in_file| {
                    let delta = copied_in_file.saturating_sub(last_reported);
                    last_reported = copied_in_file;
                    let current = if delta > 0 {
                        global_bytes.fetch_add(delta, Ordering::Relaxed) + delta
                    } else {
                        global_bytes.load(Ordering::Relaxed)
                    };
                    let percent = if total_bytes > 0 {
                        (current.min(total_bytes) as f64 / total_bytes as f64) * 100.0
                    } else {
                        let done = files_done.load(Ordering::Relaxed);
                        (done as f64 / total_files.max(1) as f64) * 100.0
                    };
                    if let Ok(mut gate) = progress.lock() {
                        gate.emit(
                            percent.min(99.9),
                            file_index,
                            total_files,
                            current.min(total_bytes),
                            total_bytes,
                            &filename,
                            false,
                        );
                    }
                },
            )
            .await
            .map_err(|e| {
                if e == WORKFLOW_CANCELLED {
                    WORKFLOW_CANCELLED.to_string()
                } else {
                    format!("Upload fehlgeschlagen ({relative}): {e}")
                }
            })?;

            // Catch any shortfall if on_chunk skipped the final byte tally.
            if uploaded > last_reported {
                let delta = uploaded - last_reported;
                global_bytes.fetch_add(delta, Ordering::Relaxed);
            }

            let now = global_bytes.load(Ordering::Relaxed);
            let done = files_done.fetch_add(1, Ordering::Relaxed) + 1;
            let percent = if total_bytes > 0 {
                (now.min(total_bytes) as f64 / total_bytes as f64) * 100.0
            } else {
                (done as f64 / total_files.max(1) as f64) * 100.0
            };
            if let Ok(mut gate) = progress.lock() {
                gate.emit(
                    percent.min(99.9),
                    file_index,
                    total_files,
                    now.min(total_bytes),
                    total_bytes,
                    &filename,
                    true,
                );
            }
            Ok::<(), String>(())
        });
    }

    while let Some(joined) = set.join_next().await {
        if is_cancelled() {
            set.abort_all();
            while set.join_next().await.is_some() {}
            return Err(UploadResult {
                success: false,
                message: WORKFLOW_CANCELLED.into(),
                remote_path: String::new(),
            });
        }
        match joined {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                set.abort_all();
                while set.join_next().await.is_some() {}
                let message = if e == WORKFLOW_CANCELLED || is_cancelled() {
                    WORKFLOW_CANCELLED.into()
                } else {
                    e
                };
                return Err(UploadResult {
                    success: false,
                    message,
                    remote_path: String::new(),
                });
            }
            Err(e) => {
                set.abort_all();
                while set.join_next().await.is_some() {}
                if is_cancelled() || e.is_cancelled() {
                    return Err(UploadResult {
                        success: false,
                        message: WORKFLOW_CANCELLED.into(),
                        remote_path: String::new(),
                    });
                }
                return Err(UploadResult {
                    success: false,
                    message: format!("Upload-Worker abgestürzt: {e}"),
                    remote_path: String::new(),
                });
            }
        }
    }

    Ok(global_bytes.load(Ordering::Relaxed))
}

/// Relative path under share for progress / remote display helpers.
#[allow(dead_code)]
pub fn remote_leaf_name(relative: &str) -> &str {
    Path::new(relative)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(relative)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn entry(relative: &str, size: u64) -> FileEntry {
        FileEntry {
            relative: relative.into(),
            absolute: PathBuf::from(relative),
            size,
        }
    }

    #[test]
    fn partition_puts_marker_last_and_out_of_media_pool() {
        let files = vec![
            entry("Job/_fertig.txt", 10),
            entry("Job/Handcam_Foto/a.jpg", 100),
            entry("Job/_ams_manifest.v1.json", 20),
            entry("Job/Handcam_Video/clip.mp4", 50_000_000),
            entry("Job/zzz_after.txt", 5),
        ];
        let phases = partition_upload_phases(&files);
        assert_eq!(phases.media.len(), 3);
        assert!(phases
            .media
            .iter()
            .all(|f| !is_commit_file(&f.relative)));
        assert!(phases
            .manifest
            .as_ref()
            .is_some_and(|m| m.relative.ends_with(MANIFEST_FILENAME)));
        assert!(phases
            .marker
            .as_ref()
            .is_some_and(|m| m.relative.ends_with(MARKER_FILENAME)));

        let ordered: Vec<&str> = phases.ordered().iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(ordered.last().copied(), Some("Job/_fertig.txt"));
        assert_eq!(
            ordered.get(ordered.len() - 2).copied(),
            Some("Job/_ams_manifest.v1.json")
        );
        assert!(!ordered[..ordered.len() - 2]
            .iter()
            .any(|r| is_commit_file(r)));
    }

    #[test]
    fn partition_without_commit_files_is_all_media() {
        let files = vec![
            entry("Job/a.jpg", 1),
            entry("Job/b.mp4", 2),
        ];
        let phases = partition_upload_phases(&files);
        assert_eq!(phases.media.len(), 2);
        assert!(phases.manifest.is_none());
        assert!(phases.marker.is_none());
        assert_eq!(phases.total_files(), 2);
    }

    #[test]
    fn large_media_by_extension_and_size() {
        assert!(is_large_media(&entry("clip.MP4", 1024)));
        assert!(is_large_media(&entry("big.bin", LARGE_MEDIA_MIN_BYTES)));
        assert!(!is_large_media(&entry("pic.jpg", 500_000)));
    }

    #[test]
    fn marker_never_classified_as_media_even_if_large() {
        // Commit detection is by name; partition must not put marker in media.
        let files = vec![entry("Job/_fertig.txt", LARGE_MEDIA_MIN_BYTES * 2)];
        let phases = partition_upload_phases(&files);
        assert!(phases.media.is_empty());
        assert!(phases.marker.is_some());
    }
}
