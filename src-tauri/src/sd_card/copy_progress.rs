//! Chunked file copy with per-chunk progress callbacks.
//! Used by SD backup so the UI can show byte-level progress for large videos.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;

use crate::video::ffmpeg::{is_cancelled, workflow_cancelled_io};

/// Default read/write chunk size (256 KiB).
pub const DEFAULT_COPY_BUFFER: usize = 256 * 1024;

/// Copy `from` → `to`, invoking `on_chunk(bytes_just_written)` after each successful write.
///
/// On error, a partial destination file is removed when possible.
/// Returns the number of bytes written (same as file size on success).
pub fn copy_file_with_progress<F>(from: &Path, to: &Path, mut on_chunk: F) -> io::Result<u64>
where
    F: FnMut(u64),
{
    copy_file_with_progress_buf(from, to, DEFAULT_COPY_BUFFER, &mut on_chunk)
}

fn copy_file_with_progress_buf<F>(
    from: &Path,
    to: &Path,
    buffer_size: usize,
    on_chunk: &mut F,
) -> io::Result<u64>
where
    F: FnMut(u64),
{
    let result = (|| {
        let mut src = File::open(from)?;
        let meta = src.metadata()?;
        let mut dst = File::create(to)?;
        let buf_len = buffer_size.max(4 * 1024);
        let mut buf = vec![0u8; buf_len];
        let mut written = 0u64;

        loop {
            if is_cancelled() {
                return Err(workflow_cancelled_io());
            }
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            if is_cancelled() {
                return Err(workflow_cancelled_io());
            }
            dst.write_all(&buf[..n])?;
            let n_u = n as u64;
            written += n_u;
            on_chunk(n_u);
        }

        // Ensure data hits disk before we treat the copy as durable enough for clear-after.
        dst.flush()?;

        #[cfg(unix)]
        {
            let _ = fs::set_permissions(to, meta.permissions());
        }
        #[cfg(not(unix))]
        {
            let _ = meta;
        }

        Ok(written)
    })();

    if result.is_err() {
        let _ = fs::remove_file(to);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    #[test]
    fn copies_bytes_and_reports_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.bin");
        let dst = dir.path().join("dst.bin");
        // 3.5 buffers of 4 KiB → multiple chunk callbacks
        let payload = vec![0xABu8; 14 * 1024];
        fs::write(&src, &payload).unwrap();

        let chunks: Mutex<Vec<u64>> = Mutex::new(Vec::new());
        let total = AtomicU64::new(0);
        let n = copy_file_with_progress_buf(&src, &dst, 4 * 1024, &mut |delta| {
            total.fetch_add(delta, Ordering::SeqCst);
            chunks.lock().unwrap().push(delta);
        })
        .unwrap();

        assert_eq!(n, payload.len() as u64);
        assert_eq!(total.load(Ordering::SeqCst), payload.len() as u64);
        assert!(chunks.lock().unwrap().len() >= 3);
        assert_eq!(fs::read(&dst).unwrap(), payload);
    }

    #[test]
    fn removes_partial_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("missing.bin");
        let dst = dir.path().join("dst.bin");
        let err = copy_file_with_progress(&src, &dst, |_| {}).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert!(!dst.exists());
    }

    #[test]
    fn aborts_when_cancelled_before_copy() {
        crate::video::ffmpeg::reset_cancel_flag();
        crate::video::ffmpeg::cancel_encode();
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.bin");
        let dst = dir.path().join("dst.bin");
        fs::write(&src, b"data").unwrap();
        let err = copy_file_with_progress(&src, &dst, |_| {}).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::Interrupted);
        assert!(err.to_string().contains("Abgebrochen"));
        assert!(!dst.exists());
    }
}
