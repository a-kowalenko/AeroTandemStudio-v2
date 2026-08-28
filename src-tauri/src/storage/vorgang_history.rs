//! Persist created Vorgänge (customers + output files) for the Historie UI.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json;
use thiserror::Error;

use crate::model::Kunde;
use crate::qr::analyser::{QrPreview, QrSpotlight};
use crate::storage::app_config_dir;
use crate::storage::logging;
use crate::video::export_job::CreateJobResult;

const DB_FILE_NAME: &str = "vorgang_history.db";
/// Durable QR hit-frames next to `vorgang_history.db` (not temp).
const QR_PREVIEW_DIR_NAME: &str = "vorgang_qr_previews";
/// Skip repeated CREATE/ALTER on the default DB after the first successful open.
static DEFAULT_SCHEMA_READY: AtomicBool = AtomicBool::new(false);

/// List/detail SELECT: aggregations computed once (not per-row correlated subqueries).
const VORGAENGE_SELECT: &str = "SELECT v.id, v.created_at, v.gast, v.vorname, v.nachname, v.kunden_id, v.booking_id,
                        v.kunden_id_hash, v.booking_id_hash,
                        v.datum, v.ort, v.tandemmaster, v.videospringer, v.video_mode, v.form_mode,
                        v.manual_entry_mode,
                        v.handcam_foto, v.handcam_video, v.outside_foto, v.outside_video,
                        v.ist_bezahlt_handcam_foto, v.ist_bezahlt_handcam_video,
                        v.ist_bezahlt_outside_foto, v.ist_bezahlt_outside_video,
                        v.base_output_dir, v.base_filename, v.encoder, v.intro_created,
                        v.body_clips, v.photos_copied, v.watermark_photos, v.marker_path,
                        v.reused_preview,
                        v.qr_preview_path, v.qr_preview_width, v.qr_preview_height,
                        v.qr_spotlight_x, v.qr_spotlight_y, v.qr_spotlight_size,
                        v.correlation_id,
                        IFNULL(v.ams_state,''), IFNULL(v.ams_updated_at,''),
                        IFNULL(v.ams_verified_at,''),
                        IFNULL(v.ams_error_code,''), IFNULL(v.ams_error_message,''),
                        IFNULL(v.ams_archive,''), IFNULL(v.ams_source,''),
                        IFNULL(v.upload_state,'none'),
                        IFNULL(fc.file_count, 0) AS file_count,
                        IFNULL(ac.append_count, 0) AS append_count,
                        IFNULL(la.correlation_id, ''),
                        IFNULL(la.ams_state, ''),
                        IFNULL(la.ams_error_code, ''),
                        IFNULL(la.ams_error_message, ''),
                        IFNULL(la.folder_path, '')
                 FROM vorgaenge v
                 LEFT JOIN (
                    SELECT vorgang_id, COUNT(*) AS file_count
                    FROM vorgang_dateien
                    GROUP BY vorgang_id
                 ) fc ON fc.vorgang_id = v.id
                 LEFT JOIN (
                    SELECT vorgang_id, COUNT(*) AS append_count
                    FROM vorgang_appends
                    GROUP BY vorgang_id
                 ) ac ON ac.vorgang_id = v.id
                 LEFT JOIN (
                    SELECT a.vorgang_id, a.correlation_id, a.ams_state, a.ams_error_code,
                           a.ams_error_message, a.folder_path
                    FROM vorgang_appends a
                    INNER JOIN (
                        SELECT vorgang_id, MAX(id) AS max_id
                        FROM vorgang_appends
                        GROUP BY vorgang_id
                    ) latest ON latest.max_id = a.id
                 ) la ON la.vorgang_id = v.id";

#[derive(Debug, Error)]
pub enum VorgangHistoryError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct VorgangEntry {
    pub id: i64,
    pub created_at: String,
    pub gast: String,
    pub vorname: Option<String>,
    pub nachname: Option<String>,
    pub kunden_id: Option<String>,
    pub booking_id: Option<String>,
    /// QR payload hashes (shown in Scan-Frame meta; may be empty for older rows).
    pub kunden_id_hash: Option<String>,
    pub booking_id_hash: Option<String>,
    pub datum: String,
    pub ort: String,
    pub tandemmaster: String,
    pub videospringer: String,
    pub video_mode: String,
    pub form_mode: String,
    /// Config manual entry when form is manual: `id` | `oldschool` | `lokal` (empty if QR / unknown).
    pub manual_entry_mode: String,
    pub handcam_foto: bool,
    pub handcam_video: bool,
    pub outside_foto: bool,
    pub outside_video: bool,
    pub ist_bezahlt_handcam_foto: bool,
    pub ist_bezahlt_handcam_video: bool,
    pub ist_bezahlt_outside_foto: bool,
    pub ist_bezahlt_outside_video: bool,
    pub base_output_dir: String,
    pub base_filename: String,
    pub encoder: String,
    pub intro_created: bool,
    pub body_clips: i64,
    pub photos_copied: i64,
    pub watermark_photos: i64,
    pub marker_path: String,
    pub reused_preview: bool,
    /// QR hit-frame persisted for QR-mode Vorgänge (app-owned; deleted with history entry).
    pub qr_preview: Option<QrPreview>,
    pub file_count: i64,
    /// AMS handoff correlation id (empty for Lokal / legacy rows).
    pub correlation_id: String,
    /// Last-known AMS outbox state (`pending` locally until AMS writes).
    pub ams_state: String,
    pub ams_updated_at: String,
    /// When ATS last successfully read Bridge/Outbox (not AMS event time).
    pub ams_verified_at: String,
    pub ams_error_code: String,
    pub ams_error_message: String,
    pub ams_archive: String,
    /// `bridge` | `outbox` | `local` | empty
    pub ams_source: String,
    /// SMB upload lifecycle, separate from AMS:
    /// `none` | `pending` | `uploading` | `done` | `failed` | `cancelled`.
    pub upload_state: String,
    pub append_count: i64,
    pub last_append_correlation_id: String,
    pub last_append_ams_state: String,
    pub last_append_ams_error_code: String,
    pub last_append_ams_error_message: String,
    pub last_append_folder_path: String,
}

/// Snapshot written when Bridge/Outbox status is resolved.
#[derive(Debug, Clone)]
pub struct AmsHandoffStatusUpdate {
    pub state: String,
    pub updated_at: String,
    pub verified_at: String,
    pub error_code: String,
    pub error_message: String,
    pub archive: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VorgangFileEntry {
    pub id: i64,
    pub vorgang_id: i64,
    pub filename: String,
    pub media_type: String,
    pub role: String,
    pub size_bytes: Option<i64>,
    pub path: Option<String>,
    /// Set when the file belongs to an AMS append batch (`vorgang_appends`).
    pub append_id: Option<i64>,
    pub append_folder_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VorgangFileInput {
    pub filename: String,
    pub media_type: String,
    pub role: String,
    pub size_bytes: Option<i64>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VorgangAppendEntry {
    pub id: i64,
    pub vorgang_id: i64,
    pub correlation_id: String,
    pub folder_name: String,
    pub folder_path: String,
    pub created_at: String,
    pub file_count: i64,
    pub preview_count: i64,
    pub categories: Vec<String>,
    pub ams_state: String,
    pub ams_updated_at: String,
    pub ams_error_code: String,
    pub ams_error_message: String,
}

/// Lightweight path ref for disk-only clear (Phase 39).
#[derive(Debug, Clone)]
pub struct DiskFolderRef {
    pub vorgang_id: i64,
    pub path: String,
    pub upload_state: String,
    /// True for `base_output_dir` rows (used for retryable-upload counting).
    pub is_base: bool,
}

pub struct VorgangHistoryStore {
    db_path: PathBuf,
}

impl VorgangHistoryStore {
    pub fn open_default() -> Result<Self, VorgangHistoryError> {
        let dir = app_config_dir().map_err(|e| VorgangHistoryError::Message(e.to_string()))?;
        fs::create_dir_all(&dir)?;
        let store = Self {
            db_path: dir.join(DB_FILE_NAME),
        };
        if !DEFAULT_SCHEMA_READY.load(Ordering::Acquire) {
            store.ensure_schema()?;
            DEFAULT_SCHEMA_READY.store(true, Ordering::Release);
        }
        Ok(store)
    }

    #[allow(dead_code)]
    pub fn open_at(db_path: PathBuf) -> Result<Self, VorgangHistoryError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let store = Self { db_path };
        store.ensure_schema()?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, VorgangHistoryError> {
        let conn = Connection::open(&self.db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")?;
        Ok(conn)
    }

    fn qr_preview_dir(&self) -> PathBuf {
        self.db_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
            .join(QR_PREVIEW_DIR_NAME)
    }

    fn qr_preview_path_for_id(&self, vorgang_id: i64) -> PathBuf {
        self.qr_preview_dir().join(format!("{vorgang_id}.png"))
    }

    fn ensure_schema(&self) -> Result<(), VorgangHistoryError> {
        let conn = self.connect()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vorgaenge (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                gast TEXT NOT NULL,
                vorname TEXT,
                nachname TEXT,
                kunden_id TEXT,
                booking_id TEXT,
                kunden_id_hash TEXT,
                booking_id_hash TEXT,
                datum TEXT NOT NULL DEFAULT '',
                ort TEXT NOT NULL DEFAULT '',
                tandemmaster TEXT NOT NULL DEFAULT '',
                videospringer TEXT NOT NULL DEFAULT '',
                video_mode TEXT NOT NULL DEFAULT '',
                form_mode TEXT NOT NULL DEFAULT '',
                manual_entry_mode TEXT NOT NULL DEFAULT '',
                handcam_foto INTEGER NOT NULL DEFAULT 0,
                handcam_video INTEGER NOT NULL DEFAULT 0,
                outside_foto INTEGER NOT NULL DEFAULT 0,
                outside_video INTEGER NOT NULL DEFAULT 0,
                ist_bezahlt_handcam_foto INTEGER NOT NULL DEFAULT 0,
                ist_bezahlt_handcam_video INTEGER NOT NULL DEFAULT 0,
                ist_bezahlt_outside_foto INTEGER NOT NULL DEFAULT 0,
                ist_bezahlt_outside_video INTEGER NOT NULL DEFAULT 0,
                base_output_dir TEXT NOT NULL,
                base_filename TEXT NOT NULL,
                encoder TEXT NOT NULL DEFAULT '',
                intro_created INTEGER NOT NULL DEFAULT 0,
                body_clips INTEGER NOT NULL DEFAULT 0,
                photos_copied INTEGER NOT NULL DEFAULT 0,
                watermark_photos INTEGER NOT NULL DEFAULT 0,
                marker_path TEXT NOT NULL DEFAULT '',
                reused_preview INTEGER NOT NULL DEFAULT 0,
                qr_preview_path TEXT NOT NULL DEFAULT '',
                qr_preview_width INTEGER NOT NULL DEFAULT 0,
                qr_preview_height INTEGER NOT NULL DEFAULT 0,
                qr_spotlight_x REAL,
                qr_spotlight_y REAL,
                qr_spotlight_size REAL
            );
            CREATE TABLE IF NOT EXISTS vorgang_dateien (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vorgang_id INTEGER NOT NULL REFERENCES vorgaenge(id) ON DELETE CASCADE,
                filename TEXT NOT NULL,
                media_type TEXT NOT NULL,
                role TEXT NOT NULL,
                size_bytes INTEGER,
                path TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_vorgaenge_created_at ON vorgaenge(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_vorgang_dateien_vorgang ON vorgang_dateien(vorgang_id);",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "manual_entry_mode",
            "ALTER TABLE vorgaenge ADD COLUMN manual_entry_mode TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "qr_preview_path",
            "ALTER TABLE vorgaenge ADD COLUMN qr_preview_path TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "qr_preview_width",
            "ALTER TABLE vorgaenge ADD COLUMN qr_preview_width INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "qr_preview_height",
            "ALTER TABLE vorgaenge ADD COLUMN qr_preview_height INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "qr_spotlight_x",
            "ALTER TABLE vorgaenge ADD COLUMN qr_spotlight_x REAL",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "qr_spotlight_y",
            "ALTER TABLE vorgaenge ADD COLUMN qr_spotlight_y REAL",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "qr_spotlight_size",
            "ALTER TABLE vorgaenge ADD COLUMN qr_spotlight_size REAL",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "kunden_id_hash",
            "ALTER TABLE vorgaenge ADD COLUMN kunden_id_hash TEXT",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "booking_id_hash",
            "ALTER TABLE vorgaenge ADD COLUMN booking_id_hash TEXT",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "correlation_id",
            "ALTER TABLE vorgaenge ADD COLUMN correlation_id TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "ams_state",
            "ALTER TABLE vorgaenge ADD COLUMN ams_state TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "ams_updated_at",
            "ALTER TABLE vorgaenge ADD COLUMN ams_updated_at TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "ams_verified_at",
            "ALTER TABLE vorgaenge ADD COLUMN ams_verified_at TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "ams_error_code",
            "ALTER TABLE vorgaenge ADD COLUMN ams_error_code TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "ams_error_message",
            "ALTER TABLE vorgaenge ADD COLUMN ams_error_message TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "ams_archive",
            "ALTER TABLE vorgaenge ADD COLUMN ams_archive TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &conn,
            "vorgaenge",
            "ams_source",
            "ALTER TABLE vorgaenge ADD COLUMN ams_source TEXT NOT NULL DEFAULT ''",
        )?;
        // Phase 31.1: SMB upload state (separate from ams_state). Legacy rows keep `none`
        // — we do not backfill from ams_state/marker (ambiguous for mid-fail / never-uploaded).
        ensure_column(
            &conn,
            "vorgaenge",
            "upload_state",
            "ALTER TABLE vorgaenge ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'none'",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vorgang_appends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vorgang_id INTEGER NOT NULL REFERENCES vorgaenge(id) ON DELETE CASCADE,
                correlation_id TEXT NOT NULL DEFAULT '',
                folder_name TEXT NOT NULL DEFAULT '',
                folder_path TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                file_count INTEGER NOT NULL DEFAULT 0,
                preview_count INTEGER NOT NULL DEFAULT 0,
                categories TEXT NOT NULL DEFAULT '[]',
                ams_state TEXT NOT NULL DEFAULT 'pending',
                ams_updated_at TEXT NOT NULL DEFAULT '',
                ams_error_code TEXT NOT NULL DEFAULT '',
                ams_error_message TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_vorgang_appends_vorgang ON vorgang_appends(vorgang_id);
            CREATE INDEX IF NOT EXISTS idx_vorgang_appends_cid ON vorgang_appends(correlation_id);",
        )?;
        ensure_column(
            &conn,
            "vorgang_dateien",
            "append_id",
            "ALTER TABLE vorgang_dateien ADD COLUMN append_id INTEGER",
        )?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_vorgang_dateien_append ON vorgang_dateien(append_id);",
        )?;
        Ok(())
    }

    /// Copy session hit-frame into durable history storage (keeps session temp intact).
    fn promote_qr_preview(
        &self,
        vorgang_id: i64,
        source: &QrPreview,
    ) -> Result<QrPreview, VorgangHistoryError> {
        let src = Path::new(source.path.trim());
        if !src.is_file() {
            return Err(VorgangHistoryError::Message(format!(
                "QR-Preview fehlt: {}",
                source.path
            )));
        }
        let dir = self.qr_preview_dir();
        fs::create_dir_all(&dir)?;
        let dest = self.qr_preview_path_for_id(vorgang_id);
        fs::copy(src, &dest)?;
        Ok(QrPreview {
            path: dest.to_string_lossy().to_string(),
            width: source.width,
            height: source.height,
            spotlight: source.spotlight.clone(),
        })
    }

    fn update_qr_preview(
        &self,
        conn: &Connection,
        vorgang_id: i64,
        preview: &QrPreview,
    ) -> Result<(), VorgangHistoryError> {
        let (sx, sy, ss) = match &preview.spotlight {
            Some(s) => (Some(s.x as f64), Some(s.y as f64), Some(s.size as f64)),
            None => (None, None, None),
        };
        conn.execute(
            "UPDATE vorgaenge SET
                qr_preview_path = ?1,
                qr_preview_width = ?2,
                qr_preview_height = ?3,
                qr_spotlight_x = ?4,
                qr_spotlight_y = ?5,
                qr_spotlight_size = ?6
             WHERE id = ?7",
            params![
                preview.path,
                preview.width as i64,
                preview.height as i64,
                sx,
                sy,
                ss,
                vorgang_id
            ],
        )?;
        Ok(())
    }

    /// Record a successful create job (best-effort caller should swallow errors).
    pub fn record_create_job(
        &self,
        kunde: &Kunde,
        video_paths: &[String],
        photo_paths: &[String],
        result: &CreateJobResult,
        manual_entry_mode: &str,
        qr_preview: Option<&QrPreview>,
        upload_to_server: bool,
    ) -> Result<i64, VorgangHistoryError> {
        let mut files = Vec::new();
        for p in video_paths {
            files.push(file_input_from_path(p, "video", "source_video"));
        }
        for p in photo_paths {
            files.push(file_input_from_path(p, "photo", "source_photo"));
        }
        if let Some(ref out) = result.video_output {
            files.push(file_input_from_path(out, "video", "output_video"));
        }
        if let Some(ref wm) = result.watermark_video {
            files.push(file_input_from_path(wm, "video", "wm_video"));
        }
        if !result.marker_path.trim().is_empty() {
            files.push(file_input_from_path(
                &result.marker_path,
                "other",
                "marker",
            ));
        }
        self.insert_vorgang(
            kunde,
            result,
            manual_entry_mode,
            &files,
            qr_preview,
            upload_to_server,
        )
    }

    pub fn insert_vorgang(
        &self,
        kunde: &Kunde,
        result: &CreateJobResult,
        manual_entry_mode: &str,
        files: &[VorgangFileInput],
        qr_preview: Option<&QrPreview>,
        upload_to_server: bool,
    ) -> Result<i64, VorgangHistoryError> {
        let conn = self.connect()?;
        let created_at = utc_now_iso();
        let tx = conn.unchecked_transaction()?;
        let entry_mode = if kunde.form_mode.trim() == "kunde" {
            String::new()
        } else {
            manual_entry_mode.trim().to_ascii_lowercase()
        };
        let correlation_id = result.correlation_id.trim().to_string();
        let (ams_state, ams_updated_at, ams_source) = if correlation_id.is_empty() {
            (String::new(), String::new(), String::new())
        } else if upload_to_server {
            (
                "pending".to_string(),
                created_at.clone(),
                "local".to_string(),
            )
        } else {
            (String::new(), String::new(), "local".to_string())
        };
        let upload_state = initial_upload_state(upload_to_server, &correlation_id);

        tx.execute(
            "INSERT INTO vorgaenge (
                created_at, gast, vorname, nachname, kunden_id, booking_id,
                kunden_id_hash, booking_id_hash,
                datum, ort, tandemmaster, videospringer, video_mode, form_mode, manual_entry_mode,
                handcam_foto, handcam_video, outside_foto, outside_video,
                ist_bezahlt_handcam_foto, ist_bezahlt_handcam_video,
                ist_bezahlt_outside_foto, ist_bezahlt_outside_video,
                base_output_dir, base_filename, encoder, intro_created,
                body_clips, photos_copied, watermark_photos, marker_path, reused_preview,
                correlation_id, ams_state, ams_updated_at, ams_source, upload_state
            ) VALUES (
                ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,
                ?16,?17,?18,?19,?20,?21,?22,?23,
                ?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37
            )",
            params![
                created_at,
                kunde.resolve_gast(),
                opt_str(kunde.vorname.as_deref()),
                opt_str(kunde.nachname.as_deref()),
                opt_str(kunde.kunden_id.as_deref()),
                opt_str(kunde.booking_id.as_deref()),
                opt_str(kunde.kunden_id_hash.as_deref()),
                opt_str(kunde.booking_id_hash.as_deref()),
                kunde.datum.trim(),
                kunde.ort.trim(),
                kunde.tandemmaster.trim(),
                kunde.videospringer.trim(),
                kunde.video_mode.trim(),
                kunde.form_mode.trim(),
                entry_mode,
                kunde.handcam_foto as i64,
                kunde.handcam_video as i64,
                kunde.outside_foto as i64,
                kunde.outside_video as i64,
                kunde.ist_bezahlt_handcam_foto as i64,
                kunde.ist_bezahlt_handcam_video as i64,
                kunde.ist_bezahlt_outside_foto as i64,
                kunde.ist_bezahlt_outside_video as i64,
                result.base_output_dir,
                result.base_filename,
                result.encoder,
                result.intro_created as i64,
                result.body_clips as i64,
                result.photos_copied as i64,
                result.watermark_photos as i64,
                result.marker_path,
                result.reused_preview as i64,
                correlation_id,
                ams_state,
                ams_updated_at,
                ams_source,
                upload_state,
            ],
        )?;
        let vorgang_id = tx.last_insert_rowid();

        for f in files {
            tx.execute(
                "INSERT INTO vorgang_dateien
                 (vorgang_id, filename, media_type, role, size_bytes, path)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    vorgang_id,
                    f.filename,
                    f.media_type,
                    f.role,
                    f.size_bytes,
                    f.path,
                ],
            )?;
        }

        if let Some(src) = qr_preview.filter(|p| !p.path.trim().is_empty()) {
            match self.promote_qr_preview(vorgang_id, src) {
                Ok(persisted) => {
                    self.update_qr_preview(&tx, vorgang_id, &persisted)?;
                }
                Err(e) => {
                    logging::error(
                        "vorgang_history",
                        format!(
                            "QR-Scan-Frame konnte nicht gespeichert werden (id={vorgang_id}): {e}"
                        ),
                    );
                }
            }
        }

        tx.commit()?;

        if !result.correlation_id.trim().is_empty() {
            let job_dir = Path::new(result.base_output_dir.trim());
            if let Err(e) =
                crate::video::handoff_manifest::patch_manifest_producer_ref(job_dir, vorgang_id)
            {
                logging::error(
                    "vorgang_history",
                    format!(
                        "Manifest producer_ref konnte nicht gesetzt werden (id={vorgang_id}): {e}"
                    ),
                );
            }
        }

        logging::info(
            "vorgang_history",
            format!(
                "Vorgang gespeichert: id={vorgang_id}, gast={}, files={}, correlation_id={}",
                kunde.resolve_gast(),
                files.len(),
                result.correlation_id.trim()
            ),
        );
        Ok(vorgang_id)
    }

    /// Set SMB `upload_state`
    /// (`none` / `pending` / `uploading` / `done` / `failed` / `cancelled`).
    /// Prefer `vorgang_id`; fall back to `correlation_id` when id is unknown.
    pub fn update_upload_state(
        &self,
        vorgang_id: Option<i64>,
        correlation_id: &str,
        upload_state: &str,
    ) -> Result<(), VorgangHistoryError> {
        let state = normalize_upload_state(upload_state)?;
        let cid = correlation_id.trim();
        if vorgang_id.is_none() && cid.is_empty() {
            return Ok(());
        }
        let conn = self.connect()?;
        let n = if let Some(id) = vorgang_id {
            conn.execute(
                "UPDATE vorgaenge SET upload_state = ?1 WHERE id = ?2",
                params![state, id],
            )?
        } else {
            conn.execute(
                "UPDATE vorgaenge SET upload_state = ?1 WHERE correlation_id = ?2",
                params![state, cid],
            )?
        };
        if n == 0 {
            logging::warn(
                "vorgang_history",
                format!(
                    "upload_state update matched 0 rows (id={:?}, cid={})",
                    vorgang_id, cid
                ),
            );
        }
        Ok(())
    }

    /// Reset stale `uploading` rows to `pending` when no upload-slot job is active.
    /// Preserves rows whose ids are in `active_vorgang_ids` (in-flight slot job).
    pub fn reconcile_stale_uploads(
        &self,
        active_vorgang_ids: &[i64],
    ) -> Result<u32, VorgangHistoryError> {
        let conn = self.connect()?;
        let n = if active_vorgang_ids.is_empty() {
            conn.execute(
                "UPDATE vorgaenge SET upload_state = 'pending' WHERE upload_state = 'uploading'",
                [],
            )?
        } else {
            let placeholders = active_vorgang_ids
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "UPDATE vorgaenge SET upload_state = 'pending' \
                 WHERE upload_state = 'uploading' AND id NOT IN ({placeholders})"
            );
            let params: Vec<&dyn rusqlite::ToSql> = active_vorgang_ids
                .iter()
                .map(|id| id as &dyn rusqlite::ToSql)
                .collect();
            conn.execute(&sql, params.as_slice())?
        };
        if n > 0 {
            logging::info(
                "vorgang_history",
                format!("upload_state reconcile: {n} uploading → pending"),
            );
        }
        Ok(n as u32)
    }

    /// Mark a handoff as cancelled locally (upload abort / ATS cancel).
    ///
    /// Updates the Vorgang and any append row with the same `correlation_id`.
    pub fn mark_ams_handoff_cancelled(
        &self,
        correlation_id: &str,
        message: &str,
    ) -> Result<(), VorgangHistoryError> {
        let cid = correlation_id.trim();
        if cid.is_empty() {
            return Ok(());
        }
        self.update_ams_handoff_status(
            None,
            cid,
            &AmsHandoffStatusUpdate {
                state: "cancelled".into(),
                updated_at: utc_now_iso(),
                verified_at: utc_now_iso(),
                error_code: "cancelled".into(),
                error_message: message.trim().to_string(),
                archive: String::new(),
                source: "local".into(),
            },
        )
    }

    /// Persist last-known AMS handoff status for a Vorgang (by id, or correlation_id fallback).
    pub fn update_ams_handoff_status(
        &self,
        vorgang_id: Option<i64>,
        correlation_id: &str,
        update: &AmsHandoffStatusUpdate,
    ) -> Result<(), VorgangHistoryError> {
        let cid = correlation_id.trim();
        if cid.is_empty() && vorgang_id.is_none() {
            return Ok(());
        }
        let conn = self.connect()?;
        let n = if let Some(id) = vorgang_id {
            if cid.is_empty() {
                conn.execute(
                    "UPDATE vorgaenge SET
                        ams_state = ?1,
                        ams_updated_at = ?2,
                        ams_error_code = ?3,
                        ams_error_message = ?4,
                        ams_archive = ?5,
                        ams_source = ?6,
                        ams_verified_at = COALESCE(NULLIF(?7, ''), ams_verified_at)
                     WHERE id = ?8",
                    params![
                        update.state.trim(),
                        update.updated_at.trim(),
                        update.error_code.trim(),
                        update.error_message.trim(),
                        update.archive.trim(),
                        update.source.trim(),
                        update.verified_at.trim(),
                        id
                    ],
                )?
            } else {
                conn.execute(
                    "UPDATE vorgaenge SET
                        ams_state = ?1,
                        ams_updated_at = ?2,
                        ams_error_code = ?3,
                        ams_error_message = ?4,
                        ams_archive = ?5,
                        ams_source = ?6,
                        ams_verified_at = COALESCE(NULLIF(?7, ''), ams_verified_at)
                     WHERE id = ?8 AND correlation_id = ?9",
                    params![
                        update.state.trim(),
                        update.updated_at.trim(),
                        update.error_code.trim(),
                        update.error_message.trim(),
                        update.archive.trim(),
                        update.source.trim(),
                        update.verified_at.trim(),
                        id,
                        cid
                    ],
                )?
            }
        } else {
            conn.execute(
                "UPDATE vorgaenge SET
                    ams_state = ?1,
                    ams_updated_at = ?2,
                    ams_error_code = ?3,
                    ams_error_message = ?4,
                    ams_archive = ?5,
                    ams_source = ?6,
                    ams_verified_at = COALESCE(NULLIF(?7, ''), ams_verified_at)
                 WHERE correlation_id = ?8",
                params![
                    update.state.trim(),
                    update.updated_at.trim(),
                    update.error_code.trim(),
                    update.error_message.trim(),
                    update.archive.trim(),
                    update.source.trim(),
                    update.verified_at.trim(),
                    cid
                ],
            )?
        };
        if n == 0 {
            logging::debug(
                "vorgang_history",
                format!("AMS-Status Update: kein Vorgang für correlation_id={cid}"),
            );
        }
        if !cid.is_empty() {
            let _ = conn.execute(
                "UPDATE vorgang_appends SET
                    ams_state = ?1,
                    ams_updated_at = ?2,
                    ams_error_code = ?3,
                    ams_error_message = ?4
                 WHERE correlation_id = ?5",
                params![
                    update.state.trim(),
                    update.updated_at.trim(),
                    update.error_code.trim(),
                    update.error_message.trim(),
                    cid
                ],
            );
        }
        Ok(())
    }

    /// Load cached AMS status fields for a Vorgang or Nachreichung (by correlation_id).
    pub fn get_cached_ams_status(
        &self,
        vorgang_id: Option<i64>,
        correlation_id: &str,
    ) -> Result<Option<AmsHandoffStatusUpdate>, VorgangHistoryError> {
        let cid = correlation_id.trim();
        let conn = self.connect()?;

        let parent_cid: Option<String> = if let Some(id) = vorgang_id {
            conn.query_row(
                "SELECT correlation_id FROM vorgaenge WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?
        } else {
            None
        };
        let is_append_lookup = !cid.is_empty()
            && parent_cid
                .as_deref()
                .map(|p| p.trim() != cid)
                .unwrap_or(true);

        if !cid.is_empty() {
            let append_row = conn.query_row(
                "SELECT ams_state, ams_updated_at, ams_error_code, ams_error_message
                 FROM vorgang_appends WHERE correlation_id = ?1
                 ORDER BY id DESC LIMIT 1",
                params![cid],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                },
            );
            match append_row {
                Ok((state, updated_at, error_code, error_message)) => {
                    if !state.trim().is_empty() {
                        return Ok(Some(AmsHandoffStatusUpdate {
                            state,
                            updated_at,
                            verified_at: String::new(),
                            error_code,
                            error_message,
                            archive: String::new(),
                            source: "cached".into(),
                        }));
                    }
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => {}
                Err(e) => return Err(e.into()),
            }
            if is_append_lookup {
                return Ok(None);
            }
        }
        let row = if let Some(id) = vorgang_id {
            conn.query_row(
                "SELECT ams_state, ams_updated_at, ams_verified_at, ams_error_code, ams_error_message,
                        ams_archive, ams_source, correlation_id
                 FROM vorgaenge WHERE id = ?1",
                params![id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                    ))
                },
            )
        } else if !cid.is_empty() {
            conn.query_row(
                "SELECT ams_state, ams_updated_at, ams_verified_at, ams_error_code, ams_error_message,
                        ams_archive, ams_source, correlation_id
                 FROM vorgaenge WHERE correlation_id = ?1
                 ORDER BY id DESC LIMIT 1",
                params![cid],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                    ))
                },
            )
        } else {
            return Ok(None);
        };
        match row {
            Ok((state, updated_at, verified_at, error_code, error_message, archive, source, _)) => {
                if state.trim().is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(AmsHandoffStatusUpdate {
                        state,
                        updated_at,
                        verified_at,
                        error_code,
                        error_message,
                        archive,
                        source: if source.trim().is_empty() {
                            "cached".into()
                        } else {
                            source
                        },
                    }))
                }
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn get_by_id(&self, id: i64) -> Result<Option<VorgangEntry>, VorgangHistoryError> {
        let conn = self.connect()?;
        let sql = format!("{VORGAENGE_SELECT} WHERE v.id = ?1 LIMIT 1");
        let mut stmt = conn.prepare(&sql)?;
        let mut mapped = stmt.query_map(params![id], map_vorgang_row)?;
        match mapped.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Disk paths for Phase 39 clear (base + append folders). DB rows are not modified.
    pub fn list_disk_folder_refs(&self) -> Result<Vec<DiskFolderRef>, VorgangHistoryError> {
        let conn = self.connect()?;
        let mut out = Vec::new();

        {
            let mut stmt = conn.prepare(
                "SELECT id, base_output_dir, IFNULL(upload_state, 'none') FROM vorgaenge",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(DiskFolderRef {
                    vorgang_id: row.get(0)?,
                    path: row.get(1)?,
                    upload_state: row.get(2)?,
                    is_base: true,
                })
            })?;
            for row in rows {
                out.push(row?);
            }
        }

        {
            let mut stmt = conn.prepare(
                "SELECT vorgang_id, folder_path FROM vorgang_appends WHERE IFNULL(folder_path, '') != ''",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(DiskFolderRef {
                    vorgang_id: row.get(0)?,
                    path: row.get(1)?,
                    upload_state: String::new(),
                    is_base: false,
                })
            })?;
            for row in rows {
                out.push(row?);
            }
        }

        Ok(out)
    }

    pub fn record_append(
        &self,
        vorgang_id: i64,
        correlation_id: &str,
        folder_name: &str,
        folder_path: &str,
        file_count: i64,
        preview_count: i64,
        categories: &[String],
    ) -> Result<i64, VorgangHistoryError> {
        let conn = self.connect()?;
        let created_at = utc_now_iso();
        let cats = serde_json::to_string(categories).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "INSERT INTO vorgang_appends (
                vorgang_id, correlation_id, folder_name, folder_path, created_at,
                file_count, preview_count, categories, ams_state, ams_updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?5)",
            params![
                vorgang_id,
                correlation_id.trim(),
                folder_name,
                folder_path,
                created_at,
                file_count,
                preview_count,
                cats,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_appends(&self, vorgang_id: i64) -> Result<Vec<VorgangAppendEntry>, VorgangHistoryError> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT id, vorgang_id, correlation_id, folder_name, folder_path, created_at,
                    file_count, preview_count, categories, ams_state, ams_updated_at,
                    ams_error_code, ams_error_message
             FROM vorgang_appends WHERE vorgang_id = ?1 ORDER BY id DESC",
        )?;
        let rows = stmt.query_map(params![vorgang_id], |row| {
            let cats_raw: String = row.get(8)?;
            let categories: Vec<String> =
                serde_json::from_str(&cats_raw).unwrap_or_default();
            Ok(VorgangAppendEntry {
                id: row.get(0)?,
                vorgang_id: row.get(1)?,
                correlation_id: row.get(2)?,
                folder_name: row.get(3)?,
                folder_path: row.get(4)?,
                created_at: row.get(5)?,
                file_count: row.get(6)?,
                preview_count: row.get(7)?,
                categories,
                ams_state: row.get(9)?,
                ams_updated_at: row.get(10)?,
                ams_error_code: row.get(11)?,
                ams_error_message: row.get(12)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_vorgaenge(
        &self,
        limit: usize,
        search: Option<&str>,
    ) -> Result<Vec<VorgangEntry>, VorgangHistoryError> {
        let conn = self.connect()?;
        let limit = limit.max(1) as i64;
        let rows = if let Some(q) = search.filter(|s| !s.is_empty()) {
            let pattern = format!("%{q}%");
            let sql = format!(
                "{VORGAENGE_SELECT}
                 WHERE v.gast LIKE ?1
                    OR IFNULL(v.vorname,'') LIKE ?1
                    OR IFNULL(v.nachname,'') LIKE ?1
                    OR IFNULL(v.kunden_id,'') LIKE ?1
                    OR IFNULL(v.booking_id,'') LIKE ?1
                    OR IFNULL(v.kunden_id_hash,'') LIKE ?1
                    OR IFNULL(v.booking_id_hash,'') LIKE ?1
                    OR v.base_filename LIKE ?1
                    OR v.datum LIKE ?1
                    OR EXISTS (
                         SELECT 1 FROM vorgang_dateien d
                         WHERE d.vorgang_id = v.id AND d.filename LIKE ?1
                    )
                 ORDER BY v.created_at DESC, v.id DESC
                 LIMIT ?2"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mapped = stmt.query_map(params![pattern, limit], map_vorgang_row)?;
            mapped.collect::<Result<Vec<_>, _>>()?
        } else {
            let sql = format!(
                "{VORGAENGE_SELECT}
                 ORDER BY v.created_at DESC, v.id DESC
                 LIMIT ?1"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mapped = stmt.query_map(params![limit], map_vorgang_row)?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    /// List files from SQLite only — no SMB/`read_dir` scan on dialog open.
    /// Append rows are written by `record_append_files` when the job finishes.
    pub fn list_files(&self, vorgang_id: i64) -> Result<Vec<VorgangFileEntry>, VorgangHistoryError> {
        self.list_files_from_db(vorgang_id)
    }

    fn list_files_from_db(&self, vorgang_id: i64) -> Result<Vec<VorgangFileEntry>, VorgangHistoryError> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT d.id, d.vorgang_id, d.filename, d.media_type, d.role, d.size_bytes, d.path,
                    d.append_id, a.folder_name
             FROM vorgang_dateien d
             LEFT JOIN vorgang_appends a ON a.id = d.append_id
             WHERE d.vorgang_id = ?1
             ORDER BY (d.append_id IS NULL) ASC, d.append_id ASC, d.id ASC",
        )?;
        let mapped = stmt.query_map(params![vorgang_id], map_file_row)?;
        Ok(mapped.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn record_append_files(
        &self,
        append_id: i64,
        vorgang_id: i64,
        folder_path: &Path,
    ) -> Result<usize, VorgangHistoryError> {
        let files = scan_append_folder(folder_path)?;
        if files.is_empty() {
            return Ok(0);
        }
        let conn = self.connect()?;
        for f in &files {
            conn.execute(
                "INSERT INTO vorgang_dateien
                 (vorgang_id, filename, media_type, role, size_bytes, path, append_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    vorgang_id,
                    f.filename,
                    f.media_type,
                    f.role,
                    f.size_bytes,
                    f.path,
                    append_id,
                ],
            )?;
        }
        Ok(files.len())
    }

    pub fn delete_by_ids(&self, ids: &[i64]) -> Result<(), VorgangHistoryError> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.connect()?;
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let select_sql = format!(
            "SELECT qr_preview_path FROM vorgaenge WHERE id IN ({placeholders}) AND qr_preview_path != ''"
        );
        let mut select_stmt = conn.prepare(&select_sql)?;
        let params_dyn: Vec<&dyn rusqlite::types::ToSql> =
            ids.iter().map(|i| i as &dyn rusqlite::types::ToSql).collect();
        let preview_paths: Vec<String> = select_stmt
            .query_map(params_dyn.as_slice(), |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let delete_sql = format!("DELETE FROM vorgaenge WHERE id IN ({placeholders})");
        let mut delete_stmt = conn.prepare(&delete_sql)?;
        delete_stmt.execute(params_dyn.as_slice())?;

        for path in preview_paths {
            let p = Path::new(path.trim());
            if p.is_file() {
                let _ = fs::remove_file(p);
            }
        }
        // Best-effort: remove empty preview dir.
        let dir = self.qr_preview_dir();
        if dir.is_dir() && fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = fs::remove_dir(&dir);
        }
        Ok(())
    }
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> Result<(), VorgangHistoryError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut found = false;
    for name in names {
        if name? == column {
            found = true;
            break;
        }
    }
    if !found {
        conn.execute(alter_sql, [])?;
    }
    Ok(())
}

fn file_input_from_path(path: &str, media_type: &str, role: &str) -> VorgangFileInput {
    let p = Path::new(path);
    let filename = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    let size_bytes = fs::metadata(p).ok().map(|m| m.len() as i64);
    VorgangFileInput {
        filename,
        media_type: media_type.to_string(),
        role: role.to_string(),
        size_bytes,
        path: Some(path.to_string()),
    }
}

fn opt_str(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|x| !x.is_empty()).map(str::to_string)
}

/// Initial SMB upload state when recording a create job.
/// - Lokal / no correlation / upload off → `none`
/// - Upload intended → `pending` (done/failed set after SMB attempt)
fn initial_upload_state(upload_to_server: bool, correlation_id: &str) -> &'static str {
    if upload_to_server && !correlation_id.trim().is_empty() {
        "pending"
    } else {
        "none"
    }
}

fn normalize_upload_state(raw: &str) -> Result<&'static str, VorgangHistoryError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "none" => Ok("none"),
        "pending" => Ok("pending"),
        "uploading" => Ok("uploading"),
        "done" => Ok("done"),
        "failed" => Ok("failed"),
        "cancelled" | "canceled" => Ok("cancelled"),
        other => Err(VorgangHistoryError::Message(format!(
            "Ungültiger upload_state: {other}"
        ))),
    }
}

fn normalize_upload_state_loose(raw: &str) -> String {
    normalize_upload_state(raw)
        .map(|s| s.to_string())
        .unwrap_or_else(|_| "none".into())
}

fn map_qr_preview(
    path: String,
    width: i64,
    height: i64,
    sx: Option<f64>,
    sy: Option<f64>,
    ss: Option<f64>,
) -> Option<QrPreview> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return None;
    }
    let spotlight = match (sx, sy, ss) {
        (Some(x), Some(y), Some(size)) => Some(QrSpotlight {
            x: x as f32,
            y: y as f32,
            size: size as f32,
        }),
        _ => None,
    };
    Some(QrPreview {
        path,
        width: width.max(0) as u32,
        height: height.max(0) as u32,
        spotlight,
    })
}

fn map_vorgang_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<VorgangEntry> {
    Ok(VorgangEntry {
        id: row.get(0)?,
        created_at: row.get(1)?,
        gast: row.get(2)?,
        vorname: row.get(3)?,
        nachname: row.get(4)?,
        kunden_id: row.get(5)?,
        booking_id: row.get(6)?,
        kunden_id_hash: row.get(7)?,
        booking_id_hash: row.get(8)?,
        datum: row.get(9)?,
        ort: row.get(10)?,
        tandemmaster: row.get(11)?,
        videospringer: row.get(12)?,
        video_mode: row.get(13)?,
        form_mode: row.get(14)?,
        manual_entry_mode: row.get(15)?,
        handcam_foto: row.get::<_, i64>(16)? != 0,
        handcam_video: row.get::<_, i64>(17)? != 0,
        outside_foto: row.get::<_, i64>(18)? != 0,
        outside_video: row.get::<_, i64>(19)? != 0,
        ist_bezahlt_handcam_foto: row.get::<_, i64>(20)? != 0,
        ist_bezahlt_handcam_video: row.get::<_, i64>(21)? != 0,
        ist_bezahlt_outside_foto: row.get::<_, i64>(22)? != 0,
        ist_bezahlt_outside_video: row.get::<_, i64>(23)? != 0,
        base_output_dir: row.get(24)?,
        base_filename: row.get(25)?,
        encoder: row.get(26)?,
        intro_created: row.get::<_, i64>(27)? != 0,
        body_clips: row.get(28)?,
        photos_copied: row.get(29)?,
        watermark_photos: row.get(30)?,
        marker_path: row.get(31)?,
        reused_preview: row.get::<_, i64>(32)? != 0,
        qr_preview: map_qr_preview(
            row.get(33)?,
            row.get(34)?,
            row.get(35)?,
            row.get(36)?,
            row.get(37)?,
            row.get(38)?,
        ),
        correlation_id: row.get::<_, String>(39).unwrap_or_default(),
        ams_state: row.get::<_, String>(40).unwrap_or_default(),
        ams_updated_at: row.get::<_, String>(41).unwrap_or_default(),
        ams_verified_at: row.get::<_, String>(42).unwrap_or_default(),
        ams_error_code: row.get::<_, String>(43).unwrap_or_default(),
        ams_error_message: row.get::<_, String>(44).unwrap_or_default(),
        ams_archive: row.get::<_, String>(45).unwrap_or_default(),
        ams_source: row.get::<_, String>(46).unwrap_or_default(),
        upload_state: normalize_upload_state_loose(
            &row.get::<_, String>(47).unwrap_or_else(|_| "none".into()),
        ),
        file_count: row.get(48)?,
        append_count: row.get::<_, i64>(49).unwrap_or(0),
        last_append_correlation_id: row.get::<_, String>(50).unwrap_or_default(),
        last_append_ams_state: row.get::<_, String>(51).unwrap_or_default(),
        last_append_ams_error_code: row.get::<_, String>(52).unwrap_or_default(),
        last_append_ams_error_message: row.get::<_, String>(53).unwrap_or_default(),
        last_append_folder_path: row.get::<_, String>(54).unwrap_or_default(),
    })
}

fn map_file_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<VorgangFileEntry> {
    let append_id: Option<i64> = row.get(7)?;
    let append_folder_name: Option<String> = row.get(8)?;
    Ok(VorgangFileEntry {
        id: row.get(0)?,
        vorgang_id: row.get(1)?,
        filename: row.get(2)?,
        media_type: row.get(3)?,
        role: row.get(4)?,
        size_bytes: row.get(5)?,
        path: row.get(6)?,
        append_id,
        append_folder_name,
    })
}

fn scan_append_folder(folder_path: &Path) -> Result<Vec<VorgangFileInput>, VorgangHistoryError> {
    use crate::video::export_paths::{
        SUBDIR_HANDCAM_FOTO, SUBDIR_HANDCAM_VIDEO, SUBDIR_OUTSIDE_FOTO, SUBDIR_OUTSIDE_VIDEO,
        SUBDIR_PREVIEW_FOTO, SUBDIR_PREVIEW_VIDEO,
    };

    if !folder_path.is_dir() {
        return Ok(Vec::new());
    }

    const SUBDIRS: &[(&str, &str, &str)] = &[
        (SUBDIR_HANDCAM_VIDEO, "video", "append_handcam_video"),
        (SUBDIR_OUTSIDE_VIDEO, "video", "append_outside_video"),
        (SUBDIR_HANDCAM_FOTO, "photo", "append_handcam_foto"),
        (SUBDIR_OUTSIDE_FOTO, "photo", "append_outside_foto"),
        (SUBDIR_PREVIEW_VIDEO, "video", "append_preview_video"),
        (SUBDIR_PREVIEW_FOTO, "photo", "append_preview_foto"),
    ];

    let mut out = Vec::new();
    for (subdir, media_type, role) in SUBDIRS {
        let dir = folder_path.join(subdir);
        if !dir.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let fname = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if fname.starts_with('.') {
                continue;
            }
            out.push(file_input_from_path(
                &path.to_string_lossy(),
                media_type,
                role,
            ));
        }
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

fn utc_now_iso() -> String {
    // Trailing Z so JS Date.parse treats the stamp as UTC (not local wall time).
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, RgbImage};
    use tempfile::tempdir;

    fn sample_kunde() -> Kunde {
        let mut k = Kunde::default();
        k.gast = "Max Mustermann".into();
        k.vorname = Some("Max".into());
        k.nachname = Some("Mustermann".into());
        k.kunden_id = Some("K-1".into());
        k.datum = "11.08.2026".into();
        k.ort = "Calden".into();
        k.tandemmaster = "TM".into();
        k.videospringer = "VS".into();
        k.handcam_video = true;
        k.ist_bezahlt_handcam_video = true;
        k.form_mode = "manual".into();
        k
    }

    fn sample_result() -> CreateJobResult {
        CreateJobResult {
            base_output_dir: "/tmp/out".into(),
            base_filename: "Max_Mustermann".into(),
            video_output: Some("/tmp/out/video.mp4".into()),
            watermark_video: None,
            photos_copied: 2,
            watermark_photos: 0,
            marker_path: "/tmp/out/_fertig.txt".into(),
            encoder: "libx264".into(),
            intro_created: true,
            body_clips: 1,
            reused_preview: false,
            correlation_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
            vorgang_id: None,
        }
    }

    fn write_tiny_png(path: &Path) {
        let img: RgbImage = ImageBuffer::from_pixel(4, 4, image::Rgb([10, 20, 30]));
        img.save(path).unwrap();
    }

    #[test]
    fn utc_now_iso_ends_with_z() {
        let s = utc_now_iso();
        assert!(s.ends_with('Z'), "{s}");
        assert!(s.contains('T'), "{s}");
    }

    #[test]
    fn insert_list_files_delete() {
        let dir = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();
        let kunde = sample_kunde();
        let result = sample_result();
        let files = vec![
            VorgangFileInput {
                filename: "clip.mp4".into(),
                media_type: "video".into(),
                role: "source_video".into(),
                size_bytes: Some(1000),
                path: Some("/src/clip.mp4".into()),
            },
            VorgangFileInput {
                filename: "video.mp4".into(),
                media_type: "video".into(),
                role: "output_video".into(),
                size_bytes: Some(2000),
                path: Some("/tmp/out/video.mp4".into()),
            },
        ];
        let id = store
            .insert_vorgang(&kunde, &result, "oldschool", &files, None, true)
            .unwrap();
        assert!(id > 0);

        let list = store.list_vorgaenge(10, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].gast, "Max Mustermann");
        assert_eq!(list[0].file_count, 2);
        assert_eq!(list[0].form_mode, "manual");
        assert_eq!(list[0].manual_entry_mode, "oldschool");
        assert!(list[0].handcam_video);
        assert!(list[0].ist_bezahlt_handcam_video);
        assert_eq!(list[0].correlation_id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        assert_eq!(list[0].ams_state, "pending");
        assert_eq!(list[0].ams_source, "local");
        assert_eq!(list[0].upload_state, "pending");
        assert!(list[0].qr_preview.is_none());

        store
            .update_ams_handoff_status(
                Some(id),
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                &AmsHandoffStatusUpdate {
                    state: "uploading".into(),
                    updated_at: "2026-08-16T10:00:00Z".into(),
                    verified_at: "2026-08-16T10:00:01Z".into(),
                    error_code: String::new(),
                    error_message: String::new(),
                    archive: String::new(),
                    source: "bridge".into(),
                },
            )
            .unwrap();
        let after = &store.list_vorgaenge(10, None).unwrap()[0];
        assert_eq!(after.ams_state, "uploading");
        assert_eq!(after.ams_source, "bridge");
        let cached = store
            .get_cached_ams_status(Some(id), "")
            .unwrap()
            .expect("cached");
        assert_eq!(cached.state, "uploading");

        store
            .mark_ams_handoff_cancelled(
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "Abgebrochen",
            )
            .unwrap();
        let cancelled = &store.list_vorgaenge(10, None).unwrap()[0];
        assert_eq!(cancelled.ams_state, "cancelled");
        assert_eq!(cancelled.ams_error_code, "cancelled");
        assert_eq!(cancelled.ams_error_message, "Abgebrochen");
        assert_eq!(cancelled.ams_source, "local");

        let found = store.list_vorgaenge(10, Some("Mustermann")).unwrap();
        assert_eq!(found.len(), 1);
        let by_file = store.list_vorgaenge(10, Some("clip.mp4")).unwrap();
        assert_eq!(by_file.len(), 1);

        let files_out = store.list_files(id).unwrap();
        assert_eq!(files_out.len(), 2);
        assert_eq!(files_out[0].role, "source_video");

        let by_id = store.get_by_id(id).unwrap().expect("get_by_id");
        assert_eq!(by_id.gast, "Max Mustermann");
        assert_eq!(by_id.file_count, 2);
        assert!(store.get_by_id(id + 99).unwrap().is_none());

        store.delete_by_ids(&[id]).unwrap();
        assert!(store.list_vorgaenge(10, None).unwrap().is_empty());
        assert!(store.list_files(id).unwrap().is_empty());
    }

    #[test]
    fn qr_preview_persisted_and_deleted_with_vorgang() {
        let dir = tempdir().unwrap();
        let hit = dir.path().join("hit.png");
        write_tiny_png(&hit);
        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();
        let mut kunde = sample_kunde();
        kunde.form_mode = "kunde".into();
        kunde.kunden_id_hash = Some("cust_hash_abc".into());
        kunde.booking_id_hash = Some("book_hash_xyz".into());
        let preview = QrPreview {
            path: hit.to_string_lossy().to_string(),
            width: 4,
            height: 4,
            spotlight: Some(QrSpotlight {
                x: 0.1,
                y: 0.2,
                size: 0.3,
            }),
        };
        let id = store
            .insert_vorgang(&kunde, &sample_result(), "", &[], Some(&preview), true)
            .unwrap();

        let entry = &store.list_vorgaenge(10, None).unwrap()[0];
        assert_eq!(entry.kunden_id_hash.as_deref(), Some("cust_hash_abc"));
        assert_eq!(entry.booking_id_hash.as_deref(), Some("book_hash_xyz"));
        let by_hash = store.list_vorgaenge(10, Some("cust_hash_abc")).unwrap();
        assert_eq!(by_hash.len(), 1);
        let stored = entry.qr_preview.as_ref().expect("qr_preview");
        assert!(Path::new(&stored.path).is_file());
        assert_ne!(stored.path, preview.path);
        assert_eq!(stored.width, 4);
        assert_eq!(stored.height, 4);
        let spot = stored.spotlight.as_ref().unwrap();
        assert!((spot.x - 0.1).abs() < 1e-5);
        assert!((spot.y - 0.2).abs() < 1e-5);
        assert!((spot.size - 0.3).abs() < 1e-5);
        // Session temp must remain (copy, not move).
        assert!(hit.is_file());

        let durable = stored.path.clone();
        store.delete_by_ids(&[id]).unwrap();
        assert!(!Path::new(&durable).is_file());
        assert!(store.list_vorgaenge(10, None).unwrap().is_empty());
    }

    #[test]
    fn record_create_job_builds_file_rows() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.mp4");
        fs::write(&src, b"abc").unwrap();
        let photo = dir.path().join("p.jpg");
        fs::write(&photo, b"img").unwrap();
        let out = dir.path().join("out.mp4");
        fs::write(&out, b"out").unwrap();
        let marker = dir.path().join("_fertig.txt");
        fs::write(&marker, b"{}").unwrap();

        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();
        let mut result = sample_result();
        result.video_output = Some(out.to_string_lossy().to_string());
        result.marker_path = marker.to_string_lossy().to_string();
        result.base_output_dir = dir.path().to_string_lossy().to_string();

        let mut kunde = sample_kunde();
        kunde.form_mode = "kunde".into();
        let id = store
            .record_create_job(
                &kunde,
                &[src.to_string_lossy().to_string()],
                &[photo.to_string_lossy().to_string()],
                &result,
                "id",
                None,
                true,
            )
            .unwrap();
        let entry = &store.list_vorgaenge(10, None).unwrap()[0];
        assert_eq!(entry.form_mode, "kunde");
        assert_eq!(entry.manual_entry_mode, "");
        assert_eq!(entry.upload_state, "pending");
        let files = store.list_files(id).unwrap();
        let roles: Vec<_> = files.iter().map(|f| f.role.as_str()).collect();
        assert!(roles.contains(&"source_video"));
        assert!(roles.contains(&"source_photo"));
        assert!(roles.contains(&"output_video"));
        assert!(roles.contains(&"marker"));
        assert!(files.iter().all(|f| f.size_bytes.is_some()));
    }

    #[test]
    fn record_append_does_not_overwrite_parent_ams_state() {
        let dir = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();
        let id = store
            .insert_vorgang(&sample_kunde(), &sample_result(), "oldschool", &[], None, true)
            .unwrap();
        store
            .update_ams_handoff_status(
                Some(id),
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                &AmsHandoffStatusUpdate {
                    state: "completed".into(),
                    updated_at: "2026-08-17T10:00:00Z".into(),
                    verified_at: "2026-08-17T10:00:01Z".into(),
                    error_code: String::new(),
                    error_message: String::new(),
                    archive: "erfolg".into(),
                    source: "outbox".into(),
                },
            )
            .unwrap();

        let append_cid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
        store
            .record_append(
                id,
                append_cid,
                "Max_nachreichung_01",
                "/tmp/Max_nachreichung_01",
                2,
                1,
                &["Preview_Foto".into()],
            )
            .unwrap();

        store
            .update_ams_handoff_status(
                Some(id),
                append_cid,
                &AmsHandoffStatusUpdate {
                    state: "uploading".into(),
                    updated_at: "2026-08-17T11:00:00Z".into(),
                    verified_at: "2026-08-17T11:00:01Z".into(),
                    error_code: String::new(),
                    error_message: String::new(),
                    archive: String::new(),
                    source: "bridge".into(),
                },
            )
            .unwrap();

        let entry = &store.list_vorgaenge(10, None).unwrap()[0];
        assert_eq!(entry.ams_state, "completed");
        assert_eq!(entry.append_count, 1);
        assert_eq!(entry.last_append_correlation_id, append_cid);
        assert_eq!(entry.last_append_ams_state, "uploading");

        store
            .update_ams_handoff_status(
                Some(id),
                append_cid,
                &AmsHandoffStatusUpdate {
                    state: "failed".into(),
                    updated_at: "2026-08-17T12:00:00Z".into(),
                    verified_at: "2026-08-17T12:00:01Z".into(),
                    error_code: "upload_error".into(),
                    error_message: "Dropbox timeout".into(),
                    archive: String::new(),
                    source: "outbox".into(),
                },
            )
            .unwrap();

        let cached = store
            .get_cached_ams_status(Some(id), append_cid)
            .unwrap()
            .expect("append cache");
        assert_eq!(cached.state, "failed");
        assert_eq!(cached.error_code, "upload_error");

        let parent_cid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let parent_cached = store
            .get_cached_ams_status(Some(id), parent_cid)
            .unwrap()
            .expect("parent cache");
        assert_eq!(parent_cached.state, "completed");

        let entry = &store.list_vorgaenge(10, None).unwrap()[0];
        assert_eq!(entry.last_append_ams_state, "failed");
        assert_eq!(entry.last_append_ams_error_code, "upload_error");
        assert_eq!(entry.ams_state, "completed");

        let parent = store
            .get_cached_ams_status(Some(id), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
            .unwrap()
            .expect("parent cache");
        assert_eq!(parent.state, "completed");
    }

    #[test]
    fn record_append_files_lists_as_nachgereicht() {
        use crate::video::export_paths::SUBDIR_PREVIEW_FOTO;

        let dir = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();
        let id = store
            .insert_vorgang(&sample_kunde(), &sample_result(), "oldschool", &[], None, true)
            .unwrap();

        let append_dir = dir.path().join("Max_nachreichung_01");
        let foto_dir = append_dir.join(SUBDIR_PREVIEW_FOTO);
        fs::create_dir_all(&foto_dir).unwrap();
        let foto = foto_dir.join("20260818_120000.jpg");
        fs::write(&foto, b"jpeg").unwrap();

        let append_id = store
            .record_append(
                id,
                "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
                "Max_nachreichung_01",
                &append_dir.to_string_lossy(),
                1,
                1,
                &["Preview_Foto".into()],
            )
            .unwrap();
        let n = store
            .record_append_files(append_id, id, &append_dir)
            .unwrap();
        assert_eq!(n, 1);

        let files = store.list_files(id).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].append_id, Some(append_id));
        assert_eq!(files[0].role, "append_preview_foto");
        assert_eq!(files[0].append_folder_name.as_deref(), Some("Max_nachreichung_01"));
    }

    #[test]
    fn list_files_ignores_unrecorded_append_folder() {
        use crate::video::export_paths::SUBDIR_PREVIEW_FOTO;

        let dir = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();
        let id = store
            .insert_vorgang(&sample_kunde(), &sample_result(), "oldschool", &[], None, true)
            .unwrap();

        let append_dir = dir.path().join("Max_nachreichung_01");
        let foto_dir = append_dir.join(SUBDIR_PREVIEW_FOTO);
        fs::create_dir_all(&foto_dir).unwrap();
        fs::write(foto_dir.join("loose.jpg"), b"jpeg").unwrap();
        store
            .record_append(
                id,
                "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
                "Max_nachreichung_01",
                &append_dir.to_string_lossy(),
                1,
                1,
                &["Preview_Foto".into()],
            )
            .unwrap();

        assert!(
            store.list_files(id).unwrap().is_empty(),
            "list_files must not scan the append folder"
        );
    }

    #[test]
    fn list_vorgaenge_uses_latest_append_row() {
        let dir = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();
        let id = store
            .insert_vorgang(&sample_kunde(), &sample_result(), "oldschool", &[], None, true)
            .unwrap();
        store
            .record_append(
                id,
                "append-one",
                "Max_nachreichung_01",
                "/tmp/one",
                1,
                0,
                &["Handcam_Video".into()],
            )
            .unwrap();
        store
            .record_append(
                id,
                "append-two",
                "Max_nachreichung_02",
                "/tmp/two",
                2,
                1,
                &["Preview_Foto".into()],
            )
            .unwrap();
        store
            .update_ams_handoff_status(
                Some(id),
                "append-two",
                &AmsHandoffStatusUpdate {
                    state: "uploading".into(),
                    updated_at: "2026-08-18T12:00:00Z".into(),
                    verified_at: "2026-08-18T12:00:01Z".into(),
                    error_code: String::new(),
                    error_message: String::new(),
                    archive: String::new(),
                    source: "bridge".into(),
                },
            )
            .unwrap();

        let entry = &store.list_vorgaenge(10, None).unwrap()[0];
        assert_eq!(entry.append_count, 2);
        assert_eq!(entry.last_append_correlation_id, "append-two");
        assert_eq!(entry.last_append_ams_state, "uploading");
        assert_eq!(entry.last_append_folder_path, "/tmp/two");

        let fetched = store.get_by_id(id).unwrap().expect("row");
        assert_eq!(fetched.last_append_correlation_id, "append-two");
        assert_eq!(fetched.append_count, 2);
    }

    #[test]
    fn upload_state_none_when_upload_off_or_local() {
        let dir = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();

        let id_off = store
            .insert_vorgang(&sample_kunde(), &sample_result(), "oldschool", &[], None, false)
            .unwrap();
        let off_row = store.list_vorgaenge(10, None).unwrap()[0].clone();
        assert_eq!(off_row.upload_state, "none");
        assert!(off_row.ams_state.is_empty());

        let mut local = sample_result();
        local.correlation_id.clear();
        let _id_local = store
            .insert_vorgang(&sample_kunde(), &local, "lokal", &[], None, true)
            .unwrap();
        let local_row = store
            .list_vorgaenge(10, None)
            .unwrap()
            .into_iter()
            .find(|e| e.id != id_off)
            .expect("local row");
        assert_eq!(local_row.upload_state, "none");
        assert!(local_row.correlation_id.is_empty());
    }

    #[test]
    fn upload_state_transitions_pending_uploading_done_failed() {
        let dir = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();
        let id = store
            .insert_vorgang(&sample_kunde(), &sample_result(), "oldschool", &[], None, true)
            .unwrap();
        assert_eq!(
            store.list_vorgaenge(10, None).unwrap()[0].upload_state,
            "pending"
        );

        store
            .update_upload_state(Some(id), "", "uploading")
            .unwrap();
        assert_eq!(
            store.list_vorgaenge(10, None).unwrap()[0].upload_state,
            "uploading"
        );

        store
            .update_upload_state(Some(id), "", "done")
            .unwrap();
        assert_eq!(
            store.list_vorgaenge(10, None).unwrap()[0].upload_state,
            "done"
        );

        store
            .update_upload_state(
                None,
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "failed",
            )
            .unwrap();
        assert_eq!(
            store.list_vorgaenge(10, None).unwrap()[0].upload_state,
            "failed"
        );

        store
            .update_upload_state(Some(id), "", "cancelled")
            .unwrap();
        assert_eq!(
            store.list_vorgaenge(10, None).unwrap()[0].upload_state,
            "cancelled"
        );

        store
            .update_upload_state(Some(id), "", "canceled")
            .unwrap();
        assert_eq!(
            store.list_vorgaenge(10, None).unwrap()[0].upload_state,
            "cancelled"
        );

        assert!(store.update_upload_state(Some(id), "", "bogus").is_err());
    }

    #[test]
    fn reconcile_stale_uploads_resets_uploading_to_pending() {
        let dir = tempdir().unwrap();
        let store = VorgangHistoryStore::open_at(dir.path().join("v.db")).unwrap();
        let id = store
            .insert_vorgang(&sample_kunde(), &sample_result(), "oldschool", &[], None, true)
            .unwrap();
        store
            .update_upload_state(Some(id), "", "uploading")
            .unwrap();
        assert_eq!(
            store.reconcile_stale_uploads(&[]).unwrap(),
            1,
            "all uploading → pending when no active slot"
        );
        assert_eq!(
            store.list_vorgaenge(10, None).unwrap()[0].upload_state,
            "pending"
        );

        store
            .update_upload_state(Some(id), "", "uploading")
            .unwrap();
        assert_eq!(
            store.reconcile_stale_uploads(&[id]).unwrap(),
            0,
            "preserve active slot vorgang"
        );
        assert_eq!(
            store.list_vorgaenge(10, None).unwrap()[0].upload_state,
            "uploading"
        );
    }

    #[test]
    fn upload_state_column_defaults_none_for_legacy_compatible_schema() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("legacy.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE vorgaenge (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    gast TEXT NOT NULL,
                    vorname TEXT,
                    nachname TEXT,
                    kunden_id TEXT,
                    booking_id TEXT,
                    datum TEXT NOT NULL DEFAULT '',
                    ort TEXT NOT NULL DEFAULT '',
                    tandemmaster TEXT NOT NULL DEFAULT '',
                    videospringer TEXT NOT NULL DEFAULT '',
                    video_mode TEXT NOT NULL DEFAULT '',
                    form_mode TEXT NOT NULL DEFAULT '',
                    handcam_foto INTEGER NOT NULL DEFAULT 0,
                    handcam_video INTEGER NOT NULL DEFAULT 0,
                    outside_foto INTEGER NOT NULL DEFAULT 0,
                    outside_video INTEGER NOT NULL DEFAULT 0,
                    ist_bezahlt_handcam_foto INTEGER NOT NULL DEFAULT 0,
                    ist_bezahlt_handcam_video INTEGER NOT NULL DEFAULT 0,
                    ist_bezahlt_outside_foto INTEGER NOT NULL DEFAULT 0,
                    ist_bezahlt_outside_video INTEGER NOT NULL DEFAULT 0,
                    base_output_dir TEXT NOT NULL,
                    base_filename TEXT NOT NULL,
                    encoder TEXT NOT NULL DEFAULT '',
                    intro_created INTEGER NOT NULL DEFAULT 0,
                    body_clips INTEGER NOT NULL DEFAULT 0,
                    photos_copied INTEGER NOT NULL DEFAULT 0,
                    watermark_photos INTEGER NOT NULL DEFAULT 0,
                    marker_path TEXT NOT NULL DEFAULT '',
                    reused_preview INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE vorgang_dateien (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    vorgang_id INTEGER NOT NULL REFERENCES vorgaenge(id) ON DELETE CASCADE,
                    filename TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    role TEXT NOT NULL,
                    size_bytes INTEGER,
                    path TEXT
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO vorgaenge (
                    created_at, gast, base_output_dir, base_filename
                 ) VALUES ('2020-01-01T00:00:00Z', 'Alt', '/tmp', 'Alt')",
                [],
            )
            .unwrap();
        }
        let store = VorgangHistoryStore::open_at(db).unwrap();
        let entry = &store.list_vorgaenge(10, None).unwrap()[0];
        assert_eq!(entry.upload_state, "none");
    }
}
