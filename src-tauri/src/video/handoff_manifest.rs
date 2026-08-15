//! AMS handoff manifest (`_ams_manifest.v1.json`) written before `_fertig.txt`.
//! Spec: AeroMediaService-v2 `docs/HANDOFF.md` (Phase 13 / P1).

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::model::Kunde;
use crate::storage::config::AppConfig;

use super::export_paths::{marker_path, OutputLayout};

pub const MANIFEST_FILENAME: &str = "_ams_manifest.v1.json";
pub const HANDOFF_DIRNAME: &str = ".ams-handoff";
pub const PROTOCOL_NAME: &str = "ams-handoff";
pub const SCHEMA_V1: u32 = 1;
pub const INTEGRITY_ALGO_SIZE: &str = "size";
pub const PRODUCER_APP: &str = "AeroTandemStudio";

const MARKER_FERTIG: &str = "_fertig.txt";
const MARKER_PROCESSING: &str = "_in_verarbeitung.txt";
const CHECKPOINT_FILENAME: &str = "_aero_upload_checkpoint.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HandoffManifestV1 {
    pub schema: u32,
    pub protocol: String,
    pub correlation_id: String,
    pub producer: ProducerInfo,
    #[serde(default)]
    pub producer_ref: ProducerRef,
    pub created_at: String,
    pub folder_name: String,
    pub integrity: IntegrityBlock,
    #[serde(default)]
    pub marker_hint: MarkerHint,
    #[serde(default)]
    pub extensions: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProducerInfo {
    pub app: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProducerRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vorgang_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IntegrityBlock {
    pub algo: String,
    pub files: Vec<ManifestFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestFileEntry {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct MarkerHint {
    #[serde(default)]
    pub format: String,
    #[serde(default, rename = "type")]
    pub marker_type: String,
}

pub fn manifest_path(layout: &OutputLayout) -> PathBuf {
    layout.base_dir.join(MANIFEST_FILENAME)
}

pub fn is_ignored_handoff_name(name: &str) -> bool {
    name == MARKER_FERTIG
        || name == MARKER_PROCESSING
        || name == MANIFEST_FILENAME
        || name == CHECKPOINT_FILENAME
        || name == HANDOFF_DIRNAME
        || name == "Thumbs.db"
        || name == ".DS_Store"
        || name.starts_with(".aero_ck_")
}

/// Collect payload files relative to the job root (forward-slash paths, sorted).
pub fn collect_integrity_files(job_root: &Path) -> Result<Vec<ManifestFileEntry>, String> {
    let mut files = Vec::new();
    walk_collect(job_root, job_root, &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn walk_collect(root: &Path, dir: &Path, out: &mut Vec<ManifestFileEntry>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Ordner lesen '{}': {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Ordner lesen '{}': {e}", dir.display()))?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_ignored_handoff_name(&name) {
            continue;
        }
        if path.is_dir() {
            walk_collect(root, &path, out)?;
        } else if path.is_file() {
            let meta = fs::metadata(&path)
                .map_err(|e| format!("Datei lesen '{}': {e}", path.display()))?;
            let rel = path
                .strip_prefix(root)
                .map_err(|_| format!("Pfad nicht unter Job-Root: {}", path.display()))?;
            let rel_str = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            out.push(ManifestFileEntry {
                path: rel_str,
                size: meta.len(),
            });
        }
    }
    Ok(())
}

pub fn marker_hint_for(kunde: &Kunde, config: &AppConfig) -> MarkerHint {
    let outside_mode = kunde.is_outside_video() || kunde.video_mode == "outside";
    let marker_type = if outside_mode { "Outside" } else { "Handcam" };
    let format = if config.oldschool_mode && kunde.form_mode != "kunde" {
        "pure_contact"
    } else if kunde.form_mode == "kunde" {
        "api_hash"
    } else if kunde.kunden_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_some()
        || kunde
            .booking_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some()
    {
        "api_id"
    } else {
        "none"
    };
    MarkerHint {
        format: format.into(),
        marker_type: marker_type.into(),
    }
}

pub fn build_manifest(
    layout: &OutputLayout,
    kunde: &Kunde,
    config: &AppConfig,
    correlation_id: &str,
    vorgang_id: Option<i64>,
) -> Result<HandoffManifestV1, String> {
    let files = collect_integrity_files(&layout.base_dir)?;
    Ok(HandoffManifestV1 {
        schema: SCHEMA_V1,
        protocol: PROTOCOL_NAME.into(),
        correlation_id: correlation_id.to_string(),
        producer: ProducerInfo {
            app: PRODUCER_APP.into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
        producer_ref: ProducerRef { vorgang_id },
        created_at: Local::now().to_rfc3339(),
        folder_name: layout.base_filename.clone(),
        integrity: IntegrityBlock {
            algo: INTEGRITY_ALGO_SIZE.into(),
            files,
        },
        marker_hint: marker_hint_for(kunde, config),
        extensions: json!({}),
    })
}

/// Atomically write `_ams_manifest.v1.json` (temp → rename). Returns correlation_id + path.
pub fn write_handoff_manifest(
    layout: &OutputLayout,
    kunde: &Kunde,
    config: &AppConfig,
) -> Result<(String, PathBuf), String> {
    let correlation_id = Uuid::new_v4().to_string();
    // vorgang_id is assigned after history insert; patched via `patch_manifest_producer_ref`.
    let manifest = build_manifest(layout, kunde, config, &correlation_id, None)?;
    let path = manifest_path(layout);
    let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    atomic_write(&path, text.as_bytes())
        .map_err(|e| format!("{MANIFEST_FILENAME} schreiben: {e}"))?;
    Ok((correlation_id, path))
}

/// After Vorgang history insert: set `producer_ref.vorgang_id` in the on-disk manifest (best-effort).
pub fn patch_manifest_producer_ref(job_dir: &Path, vorgang_id: i64) -> Result<(), String> {
    let path = job_dir.join(MANIFEST_FILENAME);
    if !path.is_file() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut value: Value =
        serde_json::from_str(raw.trim()).map_err(|e| format!("Manifest patch parse: {e}"))?;
    let obj = value
        .as_object_mut()
        .ok_or_else(|| "Manifest root is not an object".to_string())?;
    let producer_ref = obj
        .entry("producer_ref")
        .or_insert_with(|| json!({}));
    if let Some(pref) = producer_ref.as_object_mut() {
        pref.insert("vorgang_id".into(), json!(vorgang_id));
    } else {
        *producer_ref = json!({ "vorgang_id": vorgang_id });
    }
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    atomic_write(&path, text.as_bytes()).map_err(|e| format!("Manifest patch schreiben: {e}"))?;
    Ok(())
}

/// AMS status outbox (`aktuell/.ams-handoff/<correlation_id>.json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusOutboxV1 {
    pub schema: u32,
    pub correlation_id: String,
    pub updated_at: String,
    pub state: String,
    #[serde(default)]
    pub error: Option<OutboxError>,
    #[serde(default)]
    pub ams: OutboxAmsMeta,
    #[serde(default)]
    pub extensions: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct OutboxError {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct OutboxAmsMeta {
    #[serde(default)]
    pub history_id: Option<String>,
    #[serde(default)]
    pub archive: Option<String>,
}

pub fn outbox_path(share_root: &Path, correlation_id: &str) -> PathBuf {
    share_root
        .join(HANDOFF_DIRNAME)
        .join(format!("{}.json", correlation_id.trim()))
}

/// Read AMS outbox status for a correlation id. `None` if the file is not present yet.
pub fn read_status_outbox(
    share_root: &Path,
    correlation_id: &str,
) -> Result<Option<StatusOutboxV1>, String> {
    let cid = correlation_id.trim();
    if cid.is_empty() {
        return Ok(None);
    }
    let path = outbox_path(share_root, cid);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("Outbox lesen: {e}"))?;
    let doc: StatusOutboxV1 =
        serde_json::from_str(raw.trim()).map_err(|e| format!("Outbox parse: {e}"))?;
    Ok(Some(doc))
}

/// Resolve share root (`aktuell`) from a job output directory.
pub fn share_root_from_job_dir(job_dir: &Path) -> Option<PathBuf> {
    job_dir.parent().map(|p| p.to_path_buf())
}

/// Atomically write `_fertig.txt` (temp → rename).
pub fn write_marker_file_atomic(
    layout: &OutputLayout,
    payload: &str,
) -> Result<PathBuf, String> {
    let path = marker_path(layout);
    atomic_write(&path, payload.as_bytes()).map_err(|e| format!("_fertig.txt schreiben: {e}"))?;
    Ok(path)
}

fn atomic_write(dest: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_name = format!(
        ".ams_tmp_{}_{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp = dest
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(tmp_name);
    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        if dest.exists() {
            fs::remove_file(dest)?;
        }
        fs::rename(&tmp, dest)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn collect_files_ignores_markers_and_sorts() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Handcam_Video")).unwrap();
        fs::write(dir.path().join("Handcam_Video/b.mp4"), b"bbbb").unwrap();
        fs::write(dir.path().join("Handcam_Video/a.mp4"), b"aaa").unwrap();
        fs::write(dir.path().join(MARKER_FERTIG), b"{}").unwrap();
        fs::write(dir.path().join(MANIFEST_FILENAME), b"{}").unwrap();
        fs::write(dir.path().join("Thumbs.db"), b"x").unwrap();

        let files = collect_integrity_files(dir.path()).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "Handcam_Video/a.mp4");
        assert_eq!(files[0].size, 3);
        assert_eq!(files[1].path, "Handcam_Video/b.mp4");
        assert_eq!(files[1].size, 4);
    }

    #[test]
    fn write_manifest_then_parse_roundtrip() {
        let dir = tempdir().unwrap();
        let layout = OutputLayout {
            base_dir: dir.path().to_path_buf(),
            base_filename: "20260815_Test_TA_TM".into(),
        };
        fs::create_dir_all(dir.path().join("Outside_Foto")).unwrap();
        fs::write(dir.path().join("Outside_Foto/p.jpg"), b"jpeg").unwrap();

        let mut kunde = Kunde::default();
        kunde.form_mode = "manual".into();
        kunde.vorname = Some("Max".into());
        kunde.nachname = Some("M".into());
        kunde.email = Some("a@b.c".into());
        kunde.handcam_video = true;

        let config = AppConfig {
            oldschool_mode: true,
            ..AppConfig::default()
        };

        let (cid, path) = write_handoff_manifest(&layout, &kunde, &config).unwrap();
        assert!(path.is_file());
        assert!(!cid.is_empty());

        let raw = fs::read_to_string(&path).unwrap();
        let parsed: HandoffManifestV1 = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.schema, 1);
        assert_eq!(parsed.protocol, PROTOCOL_NAME);
        assert_eq!(parsed.correlation_id, cid);
        assert_eq!(parsed.folder_name, "20260815_Test_TA_TM");
        assert_eq!(parsed.integrity.algo, INTEGRITY_ALGO_SIZE);
        assert_eq!(parsed.integrity.files.len(), 1);
        assert_eq!(parsed.integrity.files[0].path, "Outside_Foto/p.jpg");
        assert_eq!(parsed.integrity.files[0].size, 4);
        assert_eq!(parsed.marker_hint.format, "pure_contact");
        assert_eq!(parsed.marker_hint.marker_type, "Handcam");
        assert_eq!(parsed.producer.app, PRODUCER_APP);

        patch_manifest_producer_ref(dir.path(), 99).unwrap();
        let patched: HandoffManifestV1 =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(patched.producer_ref.vorgang_id, Some(99));
        assert_eq!(patched.correlation_id, cid);
    }

    #[test]
    fn outbox_read_missing_and_present() {
        let root = tempdir().unwrap();
        assert!(read_status_outbox(root.path(), "nope").unwrap().is_none());

        let cid = "11111111-2222-3333-4444-555555555555";
        let dir = root.path().join(HANDOFF_DIRNAME);
        fs::create_dir_all(&dir).unwrap();
        let doc = StatusOutboxV1 {
            schema: 1,
            correlation_id: cid.into(),
            updated_at: "2026-08-15T01:00:00+02:00".into(),
            state: "queued".into(),
            error: None,
            ams: OutboxAmsMeta::default(),
            extensions: json!({}),
        };
        fs::write(
            outbox_path(root.path(), cid),
            serde_json::to_string_pretty(&doc).unwrap(),
        )
        .unwrap();
        let read = read_status_outbox(root.path(), cid).unwrap().unwrap();
        assert_eq!(read.state, "queued");
        assert_eq!(read.correlation_id, cid);
    }

    #[test]
    fn marker_hint_api_hash() {
        let mut k = Kunde::default();
        k.form_mode = "kunde".into();
        k.kunden_id_hash = Some("abc".into());
        let cfg = AppConfig::default();
        let hint = marker_hint_for(&k, &cfg);
        assert_eq!(hint.format, "api_hash");
    }
}
