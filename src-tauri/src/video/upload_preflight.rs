//! Manifest-based upload preflight before retrying SMB (Phase 31.2).
//!
//! Source of truth: `_ams_manifest.v1.json` → `integrity.files` (+ marker).
//! Does **not** use `vorgang_dateien` (SD sources are often gone).

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Serialize;

use super::export_paths::MARKER_FILENAME;
use super::handoff_manifest::{
    collect_integrity_files, HandoffManifestV1, MANIFEST_FILENAME,
};

/// Machine-readable preflight issue codes (i18n on the frontend).
pub mod codes {
    pub const LOCAL_VORGANG: &str = "local_vorgang";
    pub const ALREADY_DONE: &str = "already_done";
    pub const AMS_COMPLETED: &str = "ams_completed";
    pub const FOLDER_MISSING: &str = "folder_missing";
    pub const FOLDER_EMPTY: &str = "folder_empty";
    pub const MANIFEST_MISSING: &str = "manifest_missing";
    pub const MANIFEST_INVALID: &str = "manifest_invalid";
    pub const MARKER_MISSING: &str = "marker_missing";
    pub const FILE_MISSING: &str = "file_missing";
    pub const SIZE_MISMATCH: &str = "size_mismatch";
    pub const EXTRA_FILE: &str = "extra_file";
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UploadPreflightIssue {
    pub code: String,
    /// Relative path inside the job folder (forward slashes), if applicable.
    pub path: String,
    /// Optional detail (e.g. expected vs actual size).
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UploadPreflightResult {
    /// True when there are no hard errors (soft warnings may still be present).
    pub ok: bool,
    pub hard_errors: Vec<UploadPreflightIssue>,
    pub soft_warnings: Vec<UploadPreflightIssue>,
}

#[derive(Debug, Clone)]
pub struct UploadPreflightInput<'a> {
    pub base_output_dir: &'a str,
    pub correlation_id: &'a str,
    pub upload_state: &'a str,
    pub ams_state: &'a str,
}

fn issue(code: &str, path: &str, detail: impl Into<String>) -> UploadPreflightIssue {
    UploadPreflightIssue {
        code: code.into(),
        path: path.into(),
        detail: detail.into(),
    }
}

fn dir_has_any_file(dir: &Path) -> Result<bool, String> {
    if !dir.is_dir() {
        return Ok(false);
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let entries = fs::read_dir(&cur)
            .map_err(|e| format!("Ordner lesen '{}': {e}", cur.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Ordner lesen '{}': {e}", cur.display()))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Prefight a Vorgang folder against its on-disk AMS manifest before SMB retry.
pub fn preflight_vorgang_upload(input: &UploadPreflightInput<'_>) -> UploadPreflightResult {
    let mut hard = Vec::new();
    let soft = Vec::new();

    let cid = input.correlation_id.trim();
    if cid.is_empty() {
        hard.push(issue(
            codes::LOCAL_VORGANG,
            "",
            "Lokal-Vorgang: kein correlation_id",
        ));
        return UploadPreflightResult {
            ok: false,
            hard_errors: hard,
            soft_warnings: soft,
        };
    }

    let upload = input.upload_state.trim().to_ascii_lowercase();
    if upload == "done" {
        hard.push(issue(
            codes::ALREADY_DONE,
            "",
            "upload_state=done",
        ));
    }

    let ams = input.ams_state.trim().to_ascii_lowercase();
    if ams == "completed" {
        hard.push(issue(
            codes::AMS_COMPLETED,
            "",
            "AMS Erst-Handoff bereits completed",
        ));
    }

    if !hard.is_empty() {
        return UploadPreflightResult {
            ok: false,
            hard_errors: hard,
            soft_warnings: soft,
        };
    }

    let folder = Path::new(input.base_output_dir.trim());
    if input.base_output_dir.trim().is_empty() || !folder.is_dir() {
        hard.push(issue(
            codes::FOLDER_MISSING,
            "",
            format!("Ordner fehlt: {}", input.base_output_dir.trim()),
        ));
        return UploadPreflightResult {
            ok: false,
            hard_errors: hard,
            soft_warnings: soft,
        };
    }

    match dir_has_any_file(folder) {
        Ok(false) => {
            hard.push(issue(codes::FOLDER_EMPTY, "", "Ordner ist leer"));
            return UploadPreflightResult {
                ok: false,
                hard_errors: hard,
                soft_warnings: soft,
            };
        }
        Err(e) => {
            hard.push(issue(codes::FOLDER_MISSING, "", e));
            return UploadPreflightResult {
                ok: false,
                hard_errors: hard,
                soft_warnings: soft,
            };
        }
        Ok(true) => {}
    }

    let manifest_path = folder.join(MANIFEST_FILENAME);
    if !manifest_path.is_file() {
        hard.push(issue(
            codes::MANIFEST_MISSING,
            MANIFEST_FILENAME,
            format!("{MANIFEST_FILENAME} fehlt"),
        ));
        return UploadPreflightResult {
            ok: false,
            hard_errors: hard,
            soft_warnings: soft,
        };
    }

    let raw = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) => {
            hard.push(issue(
                codes::MANIFEST_INVALID,
                MANIFEST_FILENAME,
                format!("Manifest lesen: {e}"),
            ));
            return UploadPreflightResult {
                ok: false,
                hard_errors: hard,
                soft_warnings: soft,
            };
        }
    };
    let manifest: HandoffManifestV1 = match serde_json::from_str(raw.trim()) {
        Ok(m) => m,
        Err(e) => {
            hard.push(issue(
                codes::MANIFEST_INVALID,
                MANIFEST_FILENAME,
                format!("Manifest parse: {e}"),
            ));
            return UploadPreflightResult {
                ok: false,
                hard_errors: hard,
                soft_warnings: soft,
            };
        }
    };

    let marker = folder.join(MARKER_FILENAME);
    if !marker.is_file() {
        hard.push(issue(
            codes::MARKER_MISSING,
            MARKER_FILENAME,
            format!("{MARKER_FILENAME} fehlt"),
        ));
    }

    let mut expected: HashMap<String, u64> = HashMap::new();
    for entry in &manifest.integrity.files {
        let key = entry.path.replace('\\', "/");
        expected.insert(key, entry.size);
    }

    for (rel, expected_size) in &expected {
        let mut abs = folder.to_path_buf();
        for part in rel.split(['/', '\\']) {
            if !part.is_empty() {
                abs.push(part);
            }
        }
        if !abs.is_file() {
            hard.push(issue(
                codes::FILE_MISSING,
                rel,
                "Datei fehlt",
            ));
            continue;
        }
        match fs::metadata(&abs) {
            Ok(meta) => {
                let actual = meta.len();
                if actual != *expected_size {
                    hard.push(issue(
                        codes::SIZE_MISMATCH,
                        rel,
                        format!("erwartet {expected_size}, Ist {actual}"),
                    ));
                }
            }
            Err(e) => {
                hard.push(issue(
                    codes::FILE_MISSING,
                    rel,
                    format!("Datei lesen: {e}"),
                ));
            }
        }
    }

    let mut soft_warnings = soft;
    match collect_integrity_files(folder) {
        Ok(on_disk) => {
            for f in on_disk {
                let key = f.path.replace('\\', "/");
                if !expected.contains_key(&key) {
                    soft_warnings.push(issue(
                        codes::EXTRA_FILE,
                        &key,
                        format!("nicht im Manifest (Größe {})", f.size),
                    ));
                }
            }
        }
        Err(e) => {
            hard.push(issue(codes::FOLDER_MISSING, "", e));
        }
    }

    UploadPreflightResult {
        ok: hard.is_empty(),
        hard_errors: hard,
        soft_warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_manifest(dir: &Path, files: &[(&str, u64)]) {
        let entries: Vec<serde_json::Value> = files
            .iter()
            .map(|(path, size)| {
                serde_json::json!({
                    "path": path,
                    "size": size,
                })
            })
            .collect();
        let doc = serde_json::json!({
            "schema": 1,
            "protocol": "ams-handoff",
            "correlation_id": "cid-test",
            "producer": { "app": "AeroTandemStudio", "version": "0.0.0" },
            "created_at": "2026-08-26T12:00:00+02:00",
            "folder_name": "test_folder",
            "integrity": { "algo": "size", "files": entries },
            "marker_hint": { "format": "none", "type": "Handcam" },
            "extensions": {}
        });
        fs::write(
            dir.join(MANIFEST_FILENAME),
            serde_json::to_string_pretty(&doc).unwrap(),
        )
        .unwrap();
    }

    fn write_marker(dir: &Path) {
        fs::write(dir.join(MARKER_FILENAME), b"{\"ok\":true}").unwrap();
    }

    fn input<'a>(dir: &'a Path) -> UploadPreflightInput<'a> {
        UploadPreflightInput {
            base_output_dir: dir.to_str().unwrap(),
            correlation_id: "cid-test",
            upload_state: "pending",
            ams_state: "pending",
        }
    }

    #[test]
    fn hard_fail_local_vorgang() {
        let r = preflight_vorgang_upload(&UploadPreflightInput {
            base_output_dir: "/tmp/x",
            correlation_id: "",
            upload_state: "pending",
            ams_state: "pending",
        });
        assert!(!r.ok);
        assert_eq!(r.hard_errors[0].code, codes::LOCAL_VORGANG);
    }

    #[test]
    fn hard_fail_already_done_and_ams_completed() {
        let dir = tempdir().unwrap();
        let r = preflight_vorgang_upload(&UploadPreflightInput {
            base_output_dir: dir.path().to_str().unwrap(),
            correlation_id: "cid",
            upload_state: "done",
            ams_state: "pending",
        });
        assert!(!r.ok);
        assert!(r.hard_errors.iter().any(|e| e.code == codes::ALREADY_DONE));

        let r2 = preflight_vorgang_upload(&UploadPreflightInput {
            base_output_dir: dir.path().to_str().unwrap(),
            correlation_id: "cid",
            upload_state: "pending",
            ams_state: "completed",
        });
        assert!(!r2.ok);
        assert!(r2
            .hard_errors
            .iter()
            .any(|e| e.code == codes::AMS_COMPLETED));
    }

    #[test]
    fn hard_fail_folder_missing_or_empty() {
        let r = preflight_vorgang_upload(&UploadPreflightInput {
            base_output_dir: "",
            correlation_id: "cid",
            upload_state: "pending",
            ams_state: "pending",
        });
        assert!(!r.ok);
        assert_eq!(r.hard_errors[0].code, codes::FOLDER_MISSING);

        let dir = tempdir().unwrap();
        let r2 = preflight_vorgang_upload(&input(dir.path()));
        assert!(!r2.ok);
        assert_eq!(r2.hard_errors[0].code, codes::FOLDER_EMPTY);
    }

    #[test]
    fn hard_fail_manifest_and_marker_missing() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), b"x").unwrap();
        let r = preflight_vorgang_upload(&input(dir.path()));
        assert!(!r.ok);
        assert_eq!(r.hard_errors[0].code, codes::MANIFEST_MISSING);

        write_manifest(dir.path(), &[("Handcam_Video/a.mp4", 3)]);
        let r2 = preflight_vorgang_upload(&input(dir.path()));
        assert!(!r2.ok);
        assert!(r2
            .hard_errors
            .iter()
            .any(|e| e.code == codes::MARKER_MISSING));
    }

    #[test]
    fn hard_fail_file_missing_and_size_mismatch() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Handcam_Video")).unwrap();
        fs::write(dir.path().join("Handcam_Video/a.mp4"), b"aa").unwrap(); // size 2, expect 3
        write_manifest(
            dir.path(),
            &[("Handcam_Video/a.mp4", 3), ("Handcam_Video/b.mp4", 4)],
        );
        write_marker(dir.path());

        let r = preflight_vorgang_upload(&input(dir.path()));
        assert!(!r.ok);
        assert!(r
            .hard_errors
            .iter()
            .any(|e| e.code == codes::SIZE_MISMATCH && e.path == "Handcam_Video/a.mp4"));
        assert!(r
            .hard_errors
            .iter()
            .any(|e| e.code == codes::FILE_MISSING && e.path == "Handcam_Video/b.mp4"));
    }

    #[test]
    fn soft_warn_extra_file_ok_when_manifest_matches() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Handcam_Video")).unwrap();
        fs::write(dir.path().join("Handcam_Video/a.mp4"), b"aaa").unwrap();
        fs::write(dir.path().join("Handcam_Video/extra.mp4"), b"xx").unwrap();
        write_manifest(dir.path(), &[("Handcam_Video/a.mp4", 3)]);
        write_marker(dir.path());

        let r = preflight_vorgang_upload(&input(dir.path()));
        assert!(r.ok);
        assert!(r.hard_errors.is_empty());
        assert_eq!(r.soft_warnings.len(), 1);
        assert_eq!(r.soft_warnings[0].code, codes::EXTRA_FILE);
        assert_eq!(r.soft_warnings[0].path, "Handcam_Video/extra.mp4");
    }

    #[test]
    fn ok_clean_folder() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Outside_Foto")).unwrap();
        fs::write(dir.path().join("Outside_Foto/p.jpg"), b"jpeg").unwrap();
        write_manifest(dir.path(), &[("Outside_Foto/p.jpg", 4)]);
        write_marker(dir.path());

        let r = preflight_vorgang_upload(&input(dir.path()));
        assert!(r.ok);
        assert!(r.hard_errors.is_empty());
        assert!(r.soft_warnings.is_empty());
    }

    #[test]
    fn preflight_ok_after_resync_drops_missing_file() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Outside_Foto")).unwrap();
        fs::create_dir_all(dir.path().join("Handcam_Video")).unwrap();
        fs::write(dir.path().join("Outside_Foto/keep.jpg"), b"jpeg").unwrap();
        fs::write(dir.path().join("Outside_Foto/gone.jpg"), b"jpeg").unwrap();
        fs::write(dir.path().join("Handcam_Video/a.mp4"), b"aaa").unwrap();
        write_manifest(
            dir.path(),
            &[
                ("Outside_Foto/keep.jpg", 4),
                ("Outside_Foto/gone.jpg", 4),
                ("Handcam_Video/a.mp4", 3),
            ],
        );
        write_marker(dir.path());

        fs::remove_file(dir.path().join("Outside_Foto/gone.jpg")).unwrap();
        let before = preflight_vorgang_upload(&input(dir.path()));
        assert!(!before.ok);
        assert!(before
            .hard_errors
            .iter()
            .any(|e| e.code == codes::FILE_MISSING && e.path == "Outside_Foto/gone.jpg"));

        let report = crate::video::handoff_manifest::resync_integrity_from_disk(dir.path()).unwrap();
        assert_eq!(report.removed_paths, vec!["Outside_Foto/gone.jpg"]);

        let after = preflight_vorgang_upload(&input(dir.path()));
        assert!(after.ok);
        assert!(after.hard_errors.is_empty());
    }

    #[test]
    fn ignores_marker_and_manifest_as_extras() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Outside_Foto")).unwrap();
        fs::write(dir.path().join("Outside_Foto/p.jpg"), b"jpeg").unwrap();
        write_manifest(dir.path(), &[("Outside_Foto/p.jpg", 4)]);
        write_marker(dir.path());
        // Thumbs.db is ignored by collect_integrity_files — not an extra.
        fs::write(dir.path().join("Thumbs.db"), b"x").unwrap();

        let r = preflight_vorgang_upload(&input(dir.path()));
        assert!(r.ok);
        assert!(r.soft_warnings.is_empty());
    }
}
