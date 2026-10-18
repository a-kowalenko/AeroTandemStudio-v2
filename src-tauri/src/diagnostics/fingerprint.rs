//! Stable event fingerprint for deduplication server-side.

use sha2::{Digest, Sha256};

use super::redaction::normalize_message_for_fingerprint_pub;

/// `sha256:` hex digest of `code`, normalized redacted `message`, and `category`.
pub fn event_fingerprint(code: &str, message: &str, category: &str) -> String {
    let normalized = normalize_message_for_fingerprint_pub(message);
    let payload = format!(
        "{}\n{}\n{}",
        code.trim(),
        category.trim(),
        normalized
    );
    let hash = Sha256::digest(payload.as_bytes());
    format!("sha256:{:x}", hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_for_same_inputs() {
        let a = event_fingerprint("FFMPEG_EXIT", "exit 1", "export");
        let b = event_fingerprint("FFMPEG_EXIT", "exit 1", "export");
        assert_eq!(a, b);
        assert!(a.starts_with("sha256:"));
        assert_eq!(a.len(), "sha256:".len() + 64);
    }

    #[test]
    fn same_after_path_redaction() {
        let a = event_fingerprint(
            "IO_ERR",
            "read failed /Users/alice/out.mp4",
            "export",
        );
        let b = event_fingerprint(
            "IO_ERR",
            "read failed /Users/bob/out.mp4",
            "export",
        );
        assert_eq!(a, b);
    }

    #[test]
    fn differs_when_code_or_category_changes() {
        let base = event_fingerprint("X", "msg", "export");
        assert_ne!(base, event_fingerprint("Y", "msg", "export"));
        assert_ne!(base, event_fingerprint("X", "msg", "bridge"));
    }
}
