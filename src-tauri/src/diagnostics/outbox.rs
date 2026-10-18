//! Durable diagnostics outbox (SQLite) — Phase 57 R2.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json;
use thiserror::Error;

use crate::storage::app_config_dir;
use crate::storage::AppConfig;

use super::event::{
    build_wire_event, merge_wire_events, wire_event_to_json, DiagnosticCaptureInput,
    DiagnosticWireEvent,
};

pub const OUTBOX_MAX_QUEUE: usize = 200;
pub const OUTBOX_FLUSH_BATCH: usize = 20;
pub const OUTBOX_STATUS_PENDING: &str = "pending";
pub const OUTBOX_STATUS_SENT: &str = "sent";

const DB_FILE_NAME: &str = "diagnostics_outbox.db";

#[derive(Debug, Error)]
pub enum OutboxError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone)]
pub struct OutboxRow {
    pub event_id: String,
    pub payload_json: String,
    pub fingerprint: String,
    pub created_at: i64,
    pub next_retry_at: i64,
    pub attempts: u32,
    pub status: String,
}

pub struct DiagnosticsOutboxStore {
    db_path: PathBuf,
}

impl DiagnosticsOutboxStore {
    pub fn open_default() -> Result<Self, OutboxError> {
        let dir = app_config_dir().map_err(|e| OutboxError::Message(e.to_string()))?;
        fs::create_dir_all(&dir)?;
        let store = Self {
            db_path: dir.join(DB_FILE_NAME),
        };
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn open_at(db_path: PathBuf) -> Result<Self, OutboxError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let store = Self { db_path };
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    fn connect(&self) -> Result<Connection, OutboxError> {
        let conn = Connection::open(&self.db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        Ok(conn)
    }

    fn ensure_schema(&self) -> Result<(), OutboxError> {
        let conn = self.connect()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS diagnostics_outbox (
                event_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                next_retry_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL CHECK(status IN ('pending','sent'))
            );
            CREATE INDEX IF NOT EXISTS idx_diag_outbox_pending_retry
                ON diagnostics_outbox(status, next_retry_at);
            CREATE INDEX IF NOT EXISTS idx_diag_outbox_fingerprint_pending
                ON diagnostics_outbox(fingerprint, status);",
        )?;
        Ok(())
    }

    pub fn count_pending(&self) -> Result<usize, OutboxError> {
        let conn = self.connect()?;
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM diagnostics_outbox WHERE status = ?1",
            params![OUTBOX_STATUS_PENDING],
            |row| row.get(0),
        )?;
        Ok(n as usize)
    }

    /// Enqueue when `send_error_reports` is enabled; merges pending rows with same fingerprint.
    pub fn enqueue_if_enabled(
        &self,
        config: &AppConfig,
        input: &DiagnosticCaptureInput,
    ) -> Result<Option<String>, OutboxError> {
        if !super::send_error_reports_enabled(config) {
            return Ok(None);
        }
        self.enqueue_with_config(config, input).map(Some)
    }

    pub fn enqueue_with_config(
        &self,
        config: &AppConfig,
        input: &DiagnosticCaptureInput,
    ) -> Result<String, OutboxError> {
        let (wire, fingerprint) = build_wire_event(config, input);
        self.insert_or_merge(wire, fingerprint)
    }

    fn insert_or_merge(
        &self,
        wire: DiagnosticWireEvent,
        fingerprint: String,
    ) -> Result<String, OutboxError> {
        let conn = self.connect()?;
        let now = now_unix();
        let tx = conn.unchecked_transaction()?;

        if let Some(existing_id) = tx
            .query_row(
                "SELECT event_id FROM diagnostics_outbox
                 WHERE status = ?1 AND fingerprint = ?2
                 LIMIT 1",
                params![OUTBOX_STATUS_PENDING, fingerprint],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            let payload: String = tx.query_row(
                "SELECT payload_json FROM diagnostics_outbox WHERE event_id = ?1",
                params![existing_id],
                |row| row.get(0),
            )?;
            let existing: DiagnosticWireEvent = serde_json::from_str(&payload)?;
            let merged = merge_wire_events(&existing, &wire);
            let merged_json = wire_event_to_json(&merged)?;
            tx.execute(
                "UPDATE diagnostics_outbox
                 SET payload_json = ?1, next_retry_at = ?2
                 WHERE event_id = ?3",
                params![merged_json, now, existing_id],
            )?;
            tx.commit()?;
            return Ok(existing_id);
        }

        let pending_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM diagnostics_outbox WHERE status = ?1",
            params![OUTBOX_STATUS_PENDING],
            |row| row.get(0),
        )?;
        if pending_count as usize >= OUTBOX_MAX_QUEUE {
            tx.execute(
                "DELETE FROM diagnostics_outbox
                 WHERE event_id = (
                     SELECT event_id FROM diagnostics_outbox
                     WHERE status = ?1
                     ORDER BY created_at ASC
                     LIMIT 1
                 )",
                params![OUTBOX_STATUS_PENDING],
            )?;
        }

        let payload_json = wire_event_to_json(&wire)?;
        let event_id = wire.event_id.clone();
        tx.execute(
            "INSERT INTO diagnostics_outbox
             (event_id, payload_json, fingerprint, created_at, next_retry_at, attempts, status)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
            params![
                event_id,
                payload_json,
                fingerprint,
                now,
                now,
                OUTBOX_STATUS_PENDING
            ],
        )?;
        tx.commit()?;
        Ok(event_id)
    }

    pub fn list_due_pending(&self, limit: usize) -> Result<Vec<OutboxRow>, OutboxError> {
        let conn = self.connect()?;
        let now = now_unix();
        let mut stmt = conn.prepare(
            "SELECT event_id, payload_json, fingerprint, created_at, next_retry_at, attempts, status
             FROM diagnostics_outbox
             WHERE status = ?1 AND next_retry_at <= ?2
             ORDER BY created_at ASC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![OUTBOX_STATUS_PENDING, now, limit as i64],
            map_outbox_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(OutboxError::from)
    }

    pub fn mark_sent(&self, event_ids: &[String]) -> Result<(), OutboxError> {
        if event_ids.is_empty() {
            return Ok(());
        }
        let conn = self.connect()?;
        for id in event_ids {
            conn.execute(
                "UPDATE diagnostics_outbox SET status = ?1 WHERE event_id = ?2",
                params![OUTBOX_STATUS_SENT, id],
            )?;
        }
        Ok(())
    }

    pub fn record_flush_failure(&self, event_id: &str) -> Result<(), OutboxError> {
        let conn = self.connect()?;
        let attempts: u32 = conn.query_row(
            "SELECT attempts FROM diagnostics_outbox WHERE event_id = ?1",
            params![event_id],
            |row| row.get::<_, i64>(0),
        )? as u32;
        let next_attempts = attempts.saturating_add(1);
        let delay = backoff_secs(next_attempts);
        let next_retry = now_unix() + delay;
        conn.execute(
            "UPDATE diagnostics_outbox SET attempts = ?1, next_retry_at = ?2 WHERE event_id = ?3",
            params![next_attempts as i64, next_retry, event_id],
        )?;
        Ok(())
    }

    pub fn get_row(&self, event_id: &str) -> Result<Option<OutboxRow>, OutboxError> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT event_id, payload_json, fingerprint, created_at, next_retry_at, attempts, status
             FROM diagnostics_outbox WHERE event_id = ?1",
            params![event_id],
            map_outbox_row,
        )
        .optional()
        .map_err(OutboxError::from)
    }
}

fn map_outbox_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboxRow> {
    Ok(OutboxRow {
        event_id: row.get(0)?,
        payload_json: row.get(1)?,
        fingerprint: row.get(2)?,
        created_at: row.get(3)?,
        next_retry_at: row.get(4)?,
        attempts: row.get::<_, i64>(5)? as u32,
        status: row.get(6)?,
    })
}

pub fn backoff_secs(attempts: u32) -> i64 {
    let exp = attempts.max(1).min(9);
    let secs = 2i64.saturating_pow(exp);
    secs.min(300)
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::AppConfig;

    struct TempOutbox {
        _dir: tempfile::TempDir,
        store: DiagnosticsOutboxStore,
    }

    fn temp_store() -> TempOutbox {
        let dir = tempfile::tempdir().unwrap();
        let store = DiagnosticsOutboxStore::open_at(dir.path().join("diag.db")).unwrap();
        TempOutbox { _dir: dir, store }
    }

    fn sample_input(code: &str) -> DiagnosticCaptureInput {
        DiagnosticCaptureInput::new("error", "export", code, "boom")
    }

    #[test]
    fn survives_reopen_until_sent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diag.db");
        let id = {
            let store = DiagnosticsOutboxStore::open_at(path.clone()).unwrap();
            store
                .enqueue_with_config(&AppConfig::default(), &sample_input("A"))
                .unwrap()
        };
        {
            let store = DiagnosticsOutboxStore::open_at(path).unwrap();
            let row = store.get_row(&id).unwrap().expect("row");
            assert_eq!(row.status, OUTBOX_STATUS_PENDING);
            store.mark_sent(&[id.clone()]).unwrap();
            let row = store.get_row(&id).unwrap().expect("row");
            assert_eq!(row.status, OUTBOX_STATUS_SENT);
        }
    }

    #[test]
    fn merge_same_fingerprint_increments_occurrence() {
        let temp = temp_store();
        let store = &temp.store;
        let cfg = AppConfig::default();
        let input = sample_input("MERGE");
        let id1 = store.enqueue_with_config(&cfg, &input).unwrap();
        let id2 = store.enqueue_with_config(&cfg, &input).unwrap();
        assert_eq!(id1, id2);
        assert_eq!(store.count_pending().unwrap(), 1);
        let row = store.get_row(&id1).unwrap().unwrap();
        let payload: DiagnosticWireEvent = serde_json::from_str(&row.payload_json).unwrap();
        assert_eq!(payload.occurrence_count, 2);
    }

    #[test]
    fn cap_drops_oldest_when_full() {
        let temp = temp_store();
        let store = &temp.store;
        let cfg = AppConfig::default();
        let mut first_id = String::new();
        for i in 0..OUTBOX_MAX_QUEUE {
            let id = store
                .enqueue_with_config(
                    &cfg,
                    &DiagnosticCaptureInput::new("error", "export", format!("C{i}"), "m"),
                )
                .unwrap();
            if i == 0 {
                first_id = id;
            }
        }
        assert_eq!(store.count_pending().unwrap(), OUTBOX_MAX_QUEUE);
        store
            .enqueue_with_config(
                &cfg,
                &DiagnosticCaptureInput::new("error", "export", "NEW", "m"),
            )
            .unwrap();
        assert_eq!(store.count_pending().unwrap(), OUTBOX_MAX_QUEUE);
        assert!(store.get_row(&first_id).unwrap().is_none());
    }

    #[test]
    fn cap_prefers_merge_over_drop_when_fingerprint_matches() {
        let temp = temp_store();
        let store = &temp.store;
        let cfg = AppConfig::default();
        for i in 0..OUTBOX_MAX_QUEUE {
            store
                .enqueue_with_config(
                    &cfg,
                    &DiagnosticCaptureInput::new("error", "export", format!("U{i}"), "m"),
                )
                .unwrap();
        }
        let keep = store
            .enqueue_with_config(
                &cfg,
                &DiagnosticCaptureInput::new("error", "export", "U0", "m"),
            )
            .unwrap();
        assert_eq!(store.count_pending().unwrap(), OUTBOX_MAX_QUEUE);
        let row = store.get_row(&keep).unwrap().unwrap();
        let payload: DiagnosticWireEvent = serde_json::from_str(&row.payload_json).unwrap();
        assert_eq!(payload.occurrence_count, 2);
    }

    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(backoff_secs(1), 2);
        assert_eq!(backoff_secs(2), 4);
        assert_eq!(backoff_secs(8), 256);
        assert_eq!(backoff_secs(9), 300);
    }

    #[test]
    fn enqueue_if_enabled_respects_gate() {
        let temp = temp_store();
        let store = &temp.store;
        let mut cfg = AppConfig::default();
        cfg.send_error_reports = false;
        let id = store
            .enqueue_if_enabled(&cfg, &sample_input("GATE"))
            .unwrap();
        assert!(id.is_none());
        assert_eq!(store.count_pending().unwrap(), 0);
    }

    #[test]
    fn flush_failure_sets_backoff() {
        let temp = temp_store();
        let store = &temp.store;
        let cfg = AppConfig::default();
        let id = store.enqueue_with_config(&cfg, &sample_input("B")).unwrap();
        store.record_flush_failure(&id).unwrap();
        let row = store.get_row(&id).unwrap().unwrap();
        assert_eq!(row.attempts, 1);
        assert!(row.next_retry_at > now_unix());
        let due = store.list_due_pending(10).unwrap();
        assert!(!due.iter().any(|r| r.event_id == id));
    }
}
