//! Hash-based media history store (port of legacy `media_history.py`).

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use thiserror::Error;

use crate::media::dji_paths::media_type_from_filename;
use crate::storage::app_config_dir;
use crate::storage::logging;

const DB_FILE_NAME: &str = "media_history.db";
const PARTIAL_HASH_READ_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum MediaHistoryError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessedFileEntry {
    pub id: i64,
    pub filename: String,
    pub size_bytes: i64,
    pub media_type: String,
    pub first_seen_at: String,
    pub backed_up_at: Option<String>,
    pub imported_at: Option<String>,
    pub created_at: Option<String>,
}

pub struct MediaHistoryStore {
    db_path: PathBuf,
}

impl MediaHistoryStore {
    pub fn open_default() -> Result<Self, MediaHistoryError> {
        let dir = app_config_dir().map_err(|e| MediaHistoryError::Message(e.to_string()))?;
        fs::create_dir_all(&dir)?;
        let store = Self {
            db_path: dir.join(DB_FILE_NAME),
        };
        store.ensure_schema()?;
        Ok(store)
    }

    #[allow(dead_code)]
    pub fn open_at(db_path: PathBuf) -> Result<Self, MediaHistoryError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let store = Self { db_path };
        store.ensure_schema()?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, MediaHistoryError> {
        let conn = Connection::open(&self.db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        Ok(conn)
    }

    fn ensure_schema(&self) -> Result<(), MediaHistoryError> {
        let conn = self.connect()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS processed_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identity_hash TEXT UNIQUE NOT NULL,
                filename TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                media_type TEXT NOT NULL CHECK(media_type IN ('video','photo')),
                first_seen_at TEXT NOT NULL,
                backed_up_at TEXT NULL,
                imported_at TEXT NULL,
                created_at TEXT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_processed_files_hash ON processed_files(identity_hash);
            CREATE INDEX IF NOT EXISTS idx_processed_files_media_type ON processed_files(media_type);",
        )?;
        Ok(())
    }

    /// identity_hash = SHA1(size_bytes_ascii + first 4MB).
    pub fn compute_identity(path: &Path) -> Result<(String, u64), MediaHistoryError> {
        let meta = fs::metadata(path)?;
        let size = meta.len();
        let mut hasher = Sha1::new();
        hasher.update(size.to_string().as_bytes());
        let mut file = File::open(path)?;
        let mut buf = vec![0u8; PARTIAL_HASH_READ_BYTES];
        let n = file.read(&mut buf)?;
        hasher.update(&buf[..n]);
        Ok((format!("{:x}", hasher.finalize()), size))
    }

    pub fn contains(&self, identity_hash: &str) -> Result<bool, MediaHistoryError> {
        let conn = self.connect()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM processed_files WHERE identity_hash = ?1",
            params![identity_hash],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Batch lookup of known identity hashes (single DB connection, chunked IN).
    pub fn known_hashes(&self, hashes: &[String]) -> Result<HashSet<String>, MediaHistoryError> {
        let mut known = HashSet::new();
        if hashes.is_empty() {
            return Ok(known);
        }
        let conn = self.connect()?;
        const CHUNK: usize = 400;
        for chunk in hashes.chunks(CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT identity_hash FROM processed_files WHERE identity_hash IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(chunk.iter()), |row| {
                row.get::<_, String>(0)
            })?;
            for row in rows {
                known.insert(row?);
            }
        }
        Ok(known)
    }

    pub fn was_imported(&self, identity_hash: &str) -> Result<bool, MediaHistoryError> {
        let conn = self.connect()?;
        let imported: Option<Option<String>> = conn
            .query_row(
                "SELECT imported_at FROM processed_files WHERE identity_hash = ?1",
                params![identity_hash],
                |row| row.get(0),
            )
            .optional()?;
        Ok(matches!(imported, Some(Some(_))))
    }

    fn upsert_on(
        conn: &Connection,
        identity_hash: &str,
        filename: &str,
        size_bytes: u64,
        media_type: &str,
        backed_up_at: Option<&str>,
        imported_at: Option<&str>,
        created_at: Option<&str>,
    ) -> Result<(), MediaHistoryError> {
        let now = utc_now_iso();
        let existing: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT backed_up_at, imported_at FROM processed_files WHERE identity_hash = ?1",
                params![identity_hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if let Some((ex_backed, ex_imported)) = existing {
            let new_backed = backed_up_at.map(str::to_string).or(ex_backed);
            let new_imported = imported_at.map(str::to_string).or(ex_imported);
            conn.execute(
                "UPDATE processed_files SET filename=?1, size_bytes=?2, media_type=?3,
                 backed_up_at=?4, imported_at=?5, created_at=?6 WHERE identity_hash=?7",
                params![
                    filename,
                    size_bytes as i64,
                    media_type,
                    new_backed,
                    new_imported,
                    created_at,
                    identity_hash
                ],
            )?;
        } else {
            conn.execute(
                "INSERT INTO processed_files
                 (identity_hash, filename, size_bytes, media_type, first_seen_at, backed_up_at, imported_at, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    identity_hash,
                    filename,
                    size_bytes as i64,
                    media_type,
                    now,
                    backed_up_at,
                    imported_at,
                    created_at
                ],
            )?;
        }
        Ok(())
    }

    pub fn upsert(
        &self,
        identity_hash: &str,
        filename: &str,
        size_bytes: u64,
        media_type: &str,
        backed_up_at: Option<&str>,
        imported_at: Option<&str>,
        created_at: Option<&str>,
    ) -> Result<(), MediaHistoryError> {
        let conn = self.connect()?;
        Self::upsert_on(
            &conn,
            identity_hash,
            filename,
            size_bytes,
            media_type,
            backed_up_at,
            imported_at,
            created_at,
        )
    }

    /// One SQLite connection + transaction. `entries` is `(filename, identity_hash, size)`.
    pub fn mark_backed_up_identities(
        &self,
        entries: &[(String, String, u64)],
    ) -> Result<usize, MediaHistoryError> {
        if entries.is_empty() {
            return Ok(0);
        }
        let conn = self.connect()?;
        let now = utc_now_iso();
        let tx = conn.unchecked_transaction()?;
        for (filename, hash, size) in entries {
            let media_type = media_type_from_filename(filename);
            Self::upsert_on(
                &tx,
                hash,
                filename,
                *size,
                media_type,
                Some(&now),
                None,
                None,
            )?;
        }
        tx.commit()?;
        logging::info(
            "history",
            format!("Verlauf: Backup vermerkt für {} Datei(en)", entries.len()),
        );
        Ok(entries.len())
    }

    pub fn list_entries(
        &self,
        limit: usize,
        search: Option<&str>,
    ) -> Result<Vec<ProcessedFileEntry>, MediaHistoryError> {
        let conn = self.connect()?;
        let limit = limit.max(1) as i64;
        let rows = if let Some(q) = search.filter(|s| !s.is_empty()) {
            let pattern = format!("%{q}%");
            let mut stmt = conn.prepare(
                "SELECT id, filename, size_bytes, media_type, first_seen_at, backed_up_at, imported_at, created_at
                 FROM processed_files
                 WHERE filename LIKE ?1
                 ORDER BY
                   CASE WHEN imported_at IS NULL THEN 1 ELSE 0 END,
                   imported_at DESC,
                   backed_up_at DESC,
                   first_seen_at DESC
                 LIMIT ?2",
            )?;
            let mapped = stmt.query_map(params![pattern, limit], map_row)?;
            mapped.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, filename, size_bytes, media_type, first_seen_at, backed_up_at, imported_at, created_at
                 FROM processed_files
                 ORDER BY
                   CASE WHEN imported_at IS NULL THEN 1 ELSE 0 END,
                   imported_at DESC,
                   backed_up_at DESC,
                   first_seen_at DESC
                 LIMIT ?1",
            )?;
            let mapped = stmt.query_map(params![limit], map_row)?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    pub fn delete_by_ids(&self, ids: &[i64]) -> Result<(), MediaHistoryError> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = self.connect()?;
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM processed_files WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        let params_dyn: Vec<&dyn rusqlite::types::ToSql> = ids
            .iter()
            .map(|i| i as &dyn rusqlite::types::ToSql)
            .collect();
        stmt.execute(params_dyn.as_slice())?;
        Ok(())
    }

    pub fn purge_all(&self) -> Result<(), MediaHistoryError> {
        let conn = self.connect()?;
        conn.execute("DELETE FROM processed_files", [])?;
        Ok(())
    }

    pub fn mark_imported_batch(&self, file_paths: &[PathBuf]) -> Result<(), MediaHistoryError> {
        let now = utc_now_iso();
        logging::info(
            "history",
            format!(
                "Verlauf: markiere {} Datei(en) als importiert",
                file_paths.len()
            ),
        );
        for path in file_paths {
            let Ok((hash, size)) = Self::compute_identity(path) else {
                continue;
            };
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            let media_type = media_type_from_filename(&filename);
            self.upsert(&hash, &filename, size, media_type, None, Some(&now), None)?;
        }
        Ok(())
    }

    pub fn mark_backed_up(&self, path: &Path) -> Result<(), MediaHistoryError> {
        let (hash, size) = Self::compute_identity(path)?;
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        self.mark_backed_up_identities(&[(filename, hash, size)])?;
        Ok(())
    }
}

/// Hash files on a background thread while the next copy/download continues (cache-hot).
/// Drop the sender, then `join` the handle to collect `(filename → (hash, size))`.
pub fn spawn_identity_hasher() -> (
    mpsc::Sender<PathBuf>,
    thread::JoinHandle<HashMap<String, (String, u64)>>,
) {
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let handle = thread::Builder::new()
        .name("media-hist-hash".into())
        .spawn(move || {
            let mut map = HashMap::new();
            while let Ok(path) = rx.recv() {
                let Some(name) = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(str::to_string)
                else {
                    continue;
                };
                if map.contains_key(&name) {
                    continue;
                }
                if let Ok((hash, size)) = MediaHistoryStore::compute_identity(&path) {
                    map.insert(name, (hash, size));
                }
            }
            map
        })
        .expect("spawn media-hist-hash");
    (tx, handle)
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProcessedFileEntry> {
    Ok(ProcessedFileEntry {
        id: row.get(0)?,
        filename: row.get(1)?,
        size_bytes: row.get(2)?,
        media_type: row.get(3)?,
        first_seen_at: row.get(4)?,
        backed_up_at: row.get(5)?,
        imported_at: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn utc_now_iso() -> String {
    // Trailing Z so JS Date.parse treats the stamp as UTC (not local wall time).
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::{tempdir, NamedTempFile};

    #[test]
    fn identity_stable_for_same_content() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "hello-media-history").unwrap();
        let (h1, s1) = MediaHistoryStore::compute_identity(f.path()).unwrap();
        let (h2, s2) = MediaHistoryStore::compute_identity(f.path()).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(s1, s2);
        assert_eq!(h1.len(), 40);
    }

    #[test]
    fn utc_now_iso_ends_with_z() {
        let s = utc_now_iso();
        assert!(s.ends_with('Z'), "{s}");
        assert!(s.contains('T'), "{s}");
    }

    #[test]
    fn upsert_contains_and_list() {
        let dir = tempdir().unwrap();
        let store = MediaHistoryStore::open_at(dir.path().join("h.db")).unwrap();
        let mut f = NamedTempFile::new_in(dir.path()).unwrap();
        write!(f, "abc123").unwrap();
        let (hash, size) = MediaHistoryStore::compute_identity(f.path()).unwrap();
        store
            .upsert(
                &hash,
                "abc.mp4",
                size,
                "video",
                Some("2024-01-01T00:00:00"),
                None,
                None,
            )
            .unwrap();
        assert!(store.contains(&hash).unwrap());
        assert!(!store.was_imported(&hash).unwrap());
        store
            .upsert(
                &hash,
                "abc.mp4",
                size,
                "video",
                None,
                Some("2024-01-02T00:00:00"),
                None,
            )
            .unwrap();
        assert!(store.was_imported(&hash).unwrap());
        let entries = store.list_entries(10, Some("abc")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].filename, "abc.mp4");
    }

    #[test]
    fn mark_backed_up_identities_one_transaction() {
        let dir = tempdir().unwrap();
        let store = MediaHistoryStore::open_at(dir.path().join("h.db")).unwrap();
        store
            .mark_backed_up_identities(&[
                ("a.jpg".into(), "aa".repeat(20), 10),
                ("b.jpg".into(), "bb".repeat(20), 20),
            ])
            .unwrap();
        assert!(store.contains(&"aa".repeat(20)).unwrap());
        assert!(store.contains(&"bb".repeat(20)).unwrap());
        let list = store.list_entries(10, None).unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn mark_backed_up_single_and_hasher() {
        let dir = tempdir().unwrap();
        let store = MediaHistoryStore::open_at(dir.path().join("h.db")).unwrap();
        let mut f = NamedTempFile::new_in(dir.path()).unwrap();
        write!(f, "xyz-backup").unwrap();
        store.mark_backed_up(f.path()).unwrap();
        let expected = MediaHistoryStore::compute_identity(f.path()).unwrap();
        assert!(store.contains(&expected.0).unwrap());

        let p = dir.path().join("hashed.bin");
        std::fs::write(&p, b"hello-hash").unwrap();
        let (tx, join) = spawn_identity_hasher();
        tx.send(p.clone()).unwrap();
        drop(tx);
        let map = join.join().unwrap();
        assert_eq!(
            map.get("hashed.bin"),
            Some(&MediaHistoryStore::compute_identity(&p).unwrap())
        );
    }
}
