//! Reuse a generated preview MP4 as the final product video when form + clips
//! are unchanged (path order, file size, mtime).

use std::fs;
use std::path::Path;

use sha1::{Digest, Sha1};

use crate::model::Kunde;

/// Stable content fingerprint of customer form + ordered clip files.
///
/// Clip identity uses path, byte size, and mtime so in-place cuts/trims invalidate
/// even when the path string stays the same.
pub fn create_content_fingerprint(
    kunde: &Kunde,
    video_paths: &[String],
) -> Result<String, String> {
    let kunde_json = serde_json::to_string(kunde).map_err(|e| e.to_string())?;
    let mut payload = String::with_capacity(256 + video_paths.len() * 128);
    payload.push_str("kunde:");
    payload.push_str(&kunde_json);
    payload.push('\n');

    for path in video_paths {
        let meta = fs::metadata(path).map_err(|e| format!("cannot stat {path}: {e}"))?;
        let len = meta.len();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        payload.push_str(&format!("clip:{path}|{len}|{mtime}\n"));
    }

    let mut hasher = Sha1::new();
    hasher.update(payload.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

/// Copy `reuse_path` → `dest` when fingerprint still matches and the file exists.
/// Returns `true` when the copy was performed.
pub fn try_reuse_preview(
    reuse_path: &str,
    reuse_fingerprint: &str,
    kunde: &Kunde,
    video_paths: &[String],
    dest: &Path,
) -> Result<bool, String> {
    if reuse_path.trim().is_empty() || reuse_fingerprint.trim().is_empty() {
        return Ok(false);
    }
    let current = create_content_fingerprint(kunde, video_paths)?;
    if current != reuse_fingerprint {
        return Ok(false);
    }
    let src = Path::new(reuse_path);
    if !src.is_file() {
        return Ok(false);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(src, dest).map_err(|e| format!("preview copy failed: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(bytes: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().expect("temp");
        f.write_all(bytes).expect("write");
        f.flush().expect("flush");
        f
    }

    #[test]
    fn fingerprint_stable_for_same_inputs() {
        let f = write_temp(b"abc");
        let path = f.path().to_string_lossy().to_string();
        let mut k = Kunde::default();
        k.gast = "Max".into();
        k.datum = "06.08.2026".into();
        let a = create_content_fingerprint(&k, &[path.clone()]).unwrap();
        let b = create_content_fingerprint(&k, &[path]).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 40);
    }

    #[test]
    fn fingerprint_changes_with_form() {
        let f = write_temp(b"abc");
        let path = f.path().to_string_lossy().to_string();
        let mut k1 = Kunde::default();
        k1.gast = "Max".into();
        let mut k2 = k1.clone();
        k2.gast = "Moritz".into();
        let a = create_content_fingerprint(&k1, &[path.clone()]).unwrap();
        let b = create_content_fingerprint(&k2, &[path]).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn fingerprint_changes_with_clip_order() {
        let f1 = write_temp(b"aaa");
        let f2 = write_temp(b"bbb");
        let p1 = f1.path().to_string_lossy().to_string();
        let p2 = f2.path().to_string_lossy().to_string();
        let k = Kunde::default();
        let a = create_content_fingerprint(&k, &[p1.clone(), p2.clone()]).unwrap();
        let b = create_content_fingerprint(&k, &[p2, p1]).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn fingerprint_changes_when_file_content_changes() {
        let mut f = write_temp(b"abc");
        let path = f.path().to_string_lossy().to_string();
        let k = Kunde::default();
        let before = create_content_fingerprint(&k, &[path.clone()]).unwrap();
        f.write_all(b"def").unwrap();
        f.flush().unwrap();
        // Ensure mtime/size can differ on all platforms
        let after = create_content_fingerprint(&k, &[path]).unwrap();
        assert_ne!(before, after);
    }

    #[test]
    fn try_reuse_copies_when_fingerprint_matches() {
        let src = write_temp(b"preview-bytes");
        let src_path = src.path().to_string_lossy().to_string();
        let k = Kunde::default();
        let fp = create_content_fingerprint(&k, &[src_path.clone()]).unwrap();
        let dest_dir = tempfile::tempdir().unwrap();
        let dest = dest_dir.path().join("final.mp4");
        let reused =
            try_reuse_preview(&src_path, &fp, &k, &[src_path.clone()], &dest).unwrap();
        assert!(reused);
        assert_eq!(fs::read(&dest).unwrap(), b"preview-bytes");
    }

    #[test]
    fn try_reuse_skips_on_fingerprint_mismatch() {
        let src = write_temp(b"preview-bytes");
        let src_path = src.path().to_string_lossy().to_string();
        let mut k = Kunde::default();
        k.gast = "A".into();
        let fp = create_content_fingerprint(&k, &[src_path.clone()]).unwrap();
        k.gast = "B".into();
        let dest_dir = tempfile::tempdir().unwrap();
        let dest = dest_dir.path().join("final.mp4");
        let reused =
            try_reuse_preview(&src_path, &fp, &k, &[src_path.clone()], &dest).unwrap();
        assert!(!reused);
        assert!(!dest.exists());
    }
}
