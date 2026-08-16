//! Persist created Vorgänge (customers + output files) for the Historie UI.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use thiserror::Error;

use crate::model::Kunde;
use crate::qr::analyser::{QrPreview, QrSpotlight};
use crate::storage::app_config_dir;
use crate::storage::logging;
use crate::video::export_job::CreateJobResult;

const DB_FILE_NAME: &str = "vorgang_history.db";
/// Durable QR hit-frames next to `vorgang_history.db` (not temp).
const QR_PREVIEW_DIR_NAME: &str = "vorgang_qr_previews";

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
    pub ams_error_code: String,
    pub ams_error_message: String,
    pub ams_archive: String,
    /// `bridge` | `outbox` | `local` | empty
    pub ams_source: String,
}

/// Snapshot written when Bridge/Outbox status is resolved.
#[derive(Debug, Clone)]
pub struct AmsHandoffStatusUpdate {
    pub state: String,
    pub updated_at: String,
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
}

#[derive(Debug, Clone)]
pub struct VorgangFileInput {
    pub filename: String,
    pub media_type: String,
    pub role: String,
    pub size_bytes: Option<i64>,
    pub path: Option<String>,
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
        store.ensure_schema()?;
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
        self.insert_vorgang(kunde, result, manual_entry_mode, &files, qr_preview)
    }

    pub fn insert_vorgang(
        &self,
        kunde: &Kunde,
        result: &CreateJobResult,
        manual_entry_mode: &str,
        files: &[VorgangFileInput],
        qr_preview: Option<&QrPreview>,
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
        } else {
            (
                "pending".to_string(),
                created_at.clone(),
                "local".to_string(),
            )
        };

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
                correlation_id, ams_state, ams_updated_at, ams_source
            ) VALUES (
                ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,
                ?16,?17,?18,?19,?20,?21,?22,?23,
                ?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36
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
            conn.execute(
                "UPDATE vorgaenge SET
                    ams_state = ?1,
                    ams_updated_at = ?2,
                    ams_error_code = ?3,
                    ams_error_message = ?4,
                    ams_archive = ?5,
                    ams_source = ?6
                 WHERE id = ?7",
                params![
                    update.state.trim(),
                    update.updated_at.trim(),
                    update.error_code.trim(),
                    update.error_message.trim(),
                    update.archive.trim(),
                    update.source.trim(),
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
                    ams_source = ?6
                 WHERE correlation_id = ?7",
                params![
                    update.state.trim(),
                    update.updated_at.trim(),
                    update.error_code.trim(),
                    update.error_message.trim(),
                    update.archive.trim(),
                    update.source.trim(),
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
        Ok(())
    }

    /// Load cached AMS status fields for a Vorgang.
    pub fn get_cached_ams_status(
        &self,
        vorgang_id: Option<i64>,
        correlation_id: &str,
    ) -> Result<Option<AmsHandoffStatusUpdate>, VorgangHistoryError> {
        let cid = correlation_id.trim();
        let conn = self.connect()?;
        let row = if let Some(id) = vorgang_id {
            conn.query_row(
                "SELECT ams_state, ams_updated_at, ams_error_code, ams_error_message,
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
                    ))
                },
            )
        } else if !cid.is_empty() {
            conn.query_row(
                "SELECT ams_state, ams_updated_at, ams_error_code, ams_error_message,
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
                    ))
                },
            )
        } else {
            return Ok(None);
        };
        match row {
            Ok((state, updated_at, error_code, error_message, archive, source, _)) => {
                if state.trim().is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(AmsHandoffStatusUpdate {
                        state,
                        updated_at,
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

    pub fn list_vorgaenge(
        &self,
        limit: usize,
        search: Option<&str>,
    ) -> Result<Vec<VorgangEntry>, VorgangHistoryError> {
        let conn = self.connect()?;
        let limit = limit.max(1) as i64;
        let select = "SELECT v.id, v.created_at, v.gast, v.vorname, v.nachname, v.kunden_id, v.booking_id,
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
                        IFNULL(v.ams_error_code,''), IFNULL(v.ams_error_message,''),
                        IFNULL(v.ams_archive,''), IFNULL(v.ams_source,''),
                        (SELECT COUNT(*) FROM vorgang_dateien d WHERE d.vorgang_id = v.id) AS file_count
                 FROM vorgaenge v";
        let rows = if let Some(q) = search.filter(|s| !s.is_empty()) {
            let pattern = format!("%{q}%");
            let sql = format!(
                "{select}
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
                "{select}
                 ORDER BY v.created_at DESC, v.id DESC
                 LIMIT ?1"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mapped = stmt.query_map(params![limit], map_vorgang_row)?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    pub fn list_files(&self, vorgang_id: i64) -> Result<Vec<VorgangFileEntry>, VorgangHistoryError> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare(
            "SELECT id, vorgang_id, filename, media_type, role, size_bytes, path
             FROM vorgang_dateien
             WHERE vorgang_id = ?1
             ORDER BY id ASC",
        )?;
        let mapped = stmt.query_map(params![vorgang_id], map_file_row)?;
        Ok(mapped.collect::<Result<Vec<_>, _>>()?)
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
        ams_error_code: row.get::<_, String>(42).unwrap_or_default(),
        ams_error_message: row.get::<_, String>(43).unwrap_or_default(),
        ams_archive: row.get::<_, String>(44).unwrap_or_default(),
        ams_source: row.get::<_, String>(45).unwrap_or_default(),
        file_count: row.get(46)?,
    })
}

fn map_file_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<VorgangFileEntry> {
    Ok(VorgangFileEntry {
        id: row.get(0)?,
        vorgang_id: row.get(1)?,
        filename: row.get(2)?,
        media_type: row.get(3)?,
        role: row.get(4)?,
        size_bytes: row.get(5)?,
        path: row.get(6)?,
    })
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
            .insert_vorgang(&kunde, &result, "oldschool", &files, None)
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
        assert!(list[0].qr_preview.is_none());

        store
            .update_ams_handoff_status(
                Some(id),
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                &AmsHandoffStatusUpdate {
                    state: "uploading".into(),
                    updated_at: "2026-08-16T10:00:00Z".into(),
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

        let found = store.list_vorgaenge(10, Some("Mustermann")).unwrap();
        assert_eq!(found.len(), 1);
        let by_file = store.list_vorgaenge(10, Some("clip.mp4")).unwrap();
        assert_eq!(by_file.len(), 1);

        let files_out = store.list_files(id).unwrap();
        assert_eq!(files_out.len(), 2);
        assert_eq!(files_out[0].role, "source_video");

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
            .insert_vorgang(&kunde, &sample_result(), "", &[], Some(&preview))
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
            )
            .unwrap();
        let entry = &store.list_vorgaenge(10, None).unwrap()[0];
        assert_eq!(entry.form_mode, "kunde");
        assert_eq!(entry.manual_entry_mode, "");
        let files = store.list_files(id).unwrap();
        let roles: Vec<_> = files.iter().map(|f| f.role.as_str()).collect();
        assert!(roles.contains(&"source_video"));
        assert!(roles.contains(&"source_photo"));
        assert!(roles.contains(&"output_video"));
        assert!(roles.contains(&"marker"));
        assert!(files.iter().all(|f| f.size_bytes.is_some()));
    }
}
