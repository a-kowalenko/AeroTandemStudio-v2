//! Persist created Vorgänge (customers + output files) for the Historie UI.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use thiserror::Error;

use crate::model::Kunde;
use crate::storage::app_config_dir;
use crate::storage::logging;
use crate::video::export_job::CreateJobResult;

const DB_FILE_NAME: &str = "vorgang_history.db";

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
    pub file_count: i64,
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
                reused_preview INTEGER NOT NULL DEFAULT 0
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
        // Migrate DBs created before manual_entry_mode existed.
        let has_col: bool = {
            let mut stmt = conn.prepare("PRAGMA table_info(vorgaenge)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let mut found = false;
            for name in names {
                if name? == "manual_entry_mode" {
                    found = true;
                    break;
                }
            }
            found
        };
        if !has_col {
            conn.execute(
                "ALTER TABLE vorgaenge ADD COLUMN manual_entry_mode TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
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
        self.insert_vorgang(kunde, result, manual_entry_mode, &files)
    }

    pub fn insert_vorgang(
        &self,
        kunde: &Kunde,
        result: &CreateJobResult,
        manual_entry_mode: &str,
        files: &[VorgangFileInput],
    ) -> Result<i64, VorgangHistoryError> {
        let conn = self.connect()?;
        let created_at = utc_now_iso();
        let tx = conn.unchecked_transaction()?;
        let entry_mode = if kunde.form_mode.trim() == "kunde" {
            String::new()
        } else {
            manual_entry_mode.trim().to_ascii_lowercase()
        };

        tx.execute(
            "INSERT INTO vorgaenge (
                created_at, gast, vorname, nachname, kunden_id, booking_id,
                datum, ort, tandemmaster, videospringer, video_mode, form_mode, manual_entry_mode,
                handcam_foto, handcam_video, outside_foto, outside_video,
                ist_bezahlt_handcam_foto, ist_bezahlt_handcam_video,
                ist_bezahlt_outside_foto, ist_bezahlt_outside_video,
                base_output_dir, base_filename, encoder, intro_created,
                body_clips, photos_copied, watermark_photos, marker_path, reused_preview
            ) VALUES (
                ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,
                ?14,?15,?16,?17,?18,?19,?20,?21,
                ?22,?23,?24,?25,?26,?27,?28,?29,?30
            )",
            params![
                created_at,
                kunde.resolve_gast(),
                opt_str(kunde.vorname.as_deref()),
                opt_str(kunde.nachname.as_deref()),
                opt_str(kunde.kunden_id.as_deref()),
                opt_str(kunde.booking_id.as_deref()),
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

        tx.commit()?;
        logging::info(
            "vorgang_history",
            format!(
                "Vorgang gespeichert: id={vorgang_id}, gast={}, files={}",
                kunde.resolve_gast(),
                files.len()
            ),
        );
        Ok(vorgang_id)
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
            let mut stmt = conn.prepare(
                "SELECT v.id, v.created_at, v.gast, v.vorname, v.nachname, v.kunden_id, v.booking_id,
                        v.datum, v.ort, v.tandemmaster, v.videospringer, v.video_mode, v.form_mode,
                        v.manual_entry_mode,
                        v.handcam_foto, v.handcam_video, v.outside_foto, v.outside_video,
                        v.ist_bezahlt_handcam_foto, v.ist_bezahlt_handcam_video,
                        v.ist_bezahlt_outside_foto, v.ist_bezahlt_outside_video,
                        v.base_output_dir, v.base_filename, v.encoder, v.intro_created,
                        v.body_clips, v.photos_copied, v.watermark_photos, v.marker_path,
                        v.reused_preview,
                        (SELECT COUNT(*) FROM vorgang_dateien d WHERE d.vorgang_id = v.id) AS file_count
                 FROM vorgaenge v
                 WHERE v.gast LIKE ?1
                    OR IFNULL(v.vorname,'') LIKE ?1
                    OR IFNULL(v.nachname,'') LIKE ?1
                    OR IFNULL(v.kunden_id,'') LIKE ?1
                    OR IFNULL(v.booking_id,'') LIKE ?1
                    OR v.base_filename LIKE ?1
                    OR v.datum LIKE ?1
                    OR EXISTS (
                         SELECT 1 FROM vorgang_dateien d
                         WHERE d.vorgang_id = v.id AND d.filename LIKE ?1
                    )
                 ORDER BY v.created_at DESC, v.id DESC
                 LIMIT ?2",
            )?;
            let mapped = stmt.query_map(params![pattern, limit], map_vorgang_row)?;
            mapped.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = conn.prepare(
                "SELECT v.id, v.created_at, v.gast, v.vorname, v.nachname, v.kunden_id, v.booking_id,
                        v.datum, v.ort, v.tandemmaster, v.videospringer, v.video_mode, v.form_mode,
                        v.manual_entry_mode,
                        v.handcam_foto, v.handcam_video, v.outside_foto, v.outside_video,
                        v.ist_bezahlt_handcam_foto, v.ist_bezahlt_handcam_video,
                        v.ist_bezahlt_outside_foto, v.ist_bezahlt_outside_video,
                        v.base_output_dir, v.base_filename, v.encoder, v.intro_created,
                        v.body_clips, v.photos_copied, v.watermark_photos, v.marker_path,
                        v.reused_preview,
                        (SELECT COUNT(*) FROM vorgang_dateien d WHERE d.vorgang_id = v.id) AS file_count
                 FROM vorgaenge v
                 ORDER BY v.created_at DESC, v.id DESC
                 LIMIT ?1",
            )?;
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
        let sql = format!("DELETE FROM vorgaenge WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        let params_dyn: Vec<&dyn rusqlite::types::ToSql> =
            ids.iter().map(|i| i as &dyn rusqlite::types::ToSql).collect();
        stmt.execute(params_dyn.as_slice())?;
        Ok(())
    }
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

fn map_vorgang_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<VorgangEntry> {
    Ok(VorgangEntry {
        id: row.get(0)?,
        created_at: row.get(1)?,
        gast: row.get(2)?,
        vorname: row.get(3)?,
        nachname: row.get(4)?,
        kunden_id: row.get(5)?,
        booking_id: row.get(6)?,
        datum: row.get(7)?,
        ort: row.get(8)?,
        tandemmaster: row.get(9)?,
        videospringer: row.get(10)?,
        video_mode: row.get(11)?,
        form_mode: row.get(12)?,
        manual_entry_mode: row.get(13)?,
        handcam_foto: row.get::<_, i64>(14)? != 0,
        handcam_video: row.get::<_, i64>(15)? != 0,
        outside_foto: row.get::<_, i64>(16)? != 0,
        outside_video: row.get::<_, i64>(17)? != 0,
        ist_bezahlt_handcam_foto: row.get::<_, i64>(18)? != 0,
        ist_bezahlt_handcam_video: row.get::<_, i64>(19)? != 0,
        ist_bezahlt_outside_foto: row.get::<_, i64>(20)? != 0,
        ist_bezahlt_outside_video: row.get::<_, i64>(21)? != 0,
        base_output_dir: row.get(22)?,
        base_filename: row.get(23)?,
        encoder: row.get(24)?,
        intro_created: row.get::<_, i64>(25)? != 0,
        body_clips: row.get(26)?,
        photos_copied: row.get(27)?,
        watermark_photos: row.get(28)?,
        marker_path: row.get(29)?,
        reused_preview: row.get::<_, i64>(30)? != 0,
        file_count: row.get(31)?,
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
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
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
        }
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
            .insert_vorgang(&kunde, &result, "oldschool", &files)
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
