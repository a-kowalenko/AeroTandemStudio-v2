//! Persistent app settings (port of legacy `config.py`).
//!
//! Stored as SQLite (`config.db`) under the platform app-data directory.
//! If a legacy `config.json` is present, it is imported once on first open.

use std::fs;
use std::path::{Path, PathBuf};

use directories::BaseDirs;
use rusqlite::{params, Connection};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use thiserror::Error;

const APP_DIR_NAME: &str = "AeroTandemStudio";
const DB_FILE_NAME: &str = "config.db";
const LEGACY_JSON_NAME: &str = "config.json";

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

/// Accept legacy JSON numbers that may be int or float.
fn de_u32_flexible<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Value::deserialize(deserializer)?;
    match v {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                u32::try_from(u).map_err(serde::de::Error::custom)
            } else if let Some(f) = n.as_f64() {
                Ok(f.round().clamp(0.0, u32::MAX as f64) as u32)
            } else {
                Err(serde::de::Error::custom("invalid number for u32"))
            }
        }
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map(|f| f.round().clamp(0.0, u32::MAX as f64) as u32)
            .map_err(serde::de::Error::custom),
        Value::Null => Ok(0),
        other => Err(serde::de::Error::custom(format!(
            "expected number for u32, got {other}"
        ))),
    }
}

fn de_u8_flexible<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Value::deserialize(deserializer)?;
    match v {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                u8::try_from(u).map_err(serde::de::Error::custom)
            } else if let Some(f) = n.as_f64() {
                Ok(f.round().clamp(0.0, 255.0) as u8)
            } else {
                Err(serde::de::Error::custom("invalid number for u8"))
            }
        }
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map(|f| f.round().clamp(0.0, 255.0) as u8)
            .map_err(serde::de::Error::custom),
        Value::Null => Ok(0),
        other => Err(serde::de::Error::custom(format!(
            "expected number for u8, got {other}"
        ))),
    }
}

/// Crew member with optional roles for form comboboxes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CrewMember {
    pub name: String,
    #[serde(default)]
    pub tandemmaster: bool,
    #[serde(default)]
    pub videospringer: bool,
}

/// App settings — keys from IMPLEMENTATION_PLAN §9 (+ a few UI helpers from legacy defaults).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppConfig {
    #[serde(default)]
    pub speicherort: String,
    #[serde(default = "default_ort")]
    pub ort: String,
    #[serde(default = "default_dauer", deserialize_with = "de_u32_flexible")]
    pub dauer: u32,
    /// Intro clip on create — off by default (enable in settings / create form).
    #[serde(default)]
    pub intro_enabled: bool,
    #[serde(default)]
    pub outside_video: bool,
    #[serde(default)]
    pub gast_name: String,
    #[serde(default)]
    pub tandemmaster: String,
    #[serde(default)]
    pub videospringer: String,
    /// Current operator ("Ich"); roles come from matching `crew_list` entry.
    /// Empty = no favorite pin in TM/VS form comboboxes.
    #[serde(default)]
    pub operator_name: String,
    /// Editable crew roster; roles control which form comboboxes suggest a name.
    #[serde(default = "default_crew_list")]
    pub crew_list: Vec<CrewMember>,
    #[serde(default)]
    pub upload_to_server: bool,
    #[serde(default = "default_server_url")]
    pub server_url: String,
    #[serde(default)]
    pub server_login: String,
    #[serde(default)]
    pub server_password: String,
    #[serde(default)]
    pub hardware_acceleration_enabled: bool,
    #[serde(default = "default_true")]
    pub parallel_processing_enabled: bool,
    #[serde(default = "default_codec")]
    pub video_codec: String,
    #[serde(default = "default_encoding_strategy")]
    pub encoding_strategy: String,
    #[serde(default)]
    pub reencode_matching_clips: bool,
    /// Intro+Body mux: `"reencode"` (default, compatible) | `"stream_copy"`.
    #[serde(default = "default_intro_mux_mode")]
    pub intro_mux_mode: String,
    /// Multi-clip body concat: `"legacy"` (MPEG-TS, robust) | `"fast"` (concat demuxer).
    #[serde(default = "default_body_concat_mode")]
    pub body_concat_mode: String,
    #[serde(default = "default_preview_crf", deserialize_with = "de_u8_flexible")]
    pub preview_encode_crf: u8,
    /// Auto-scan newly imported videos for QR codes.
    #[serde(default)]
    pub qr_check_enabled: bool,
    /// Auto-scan newly imported photos for QR codes.
    #[serde(default)]
    pub photo_qr_check_enabled: bool,
    #[serde(default = "default_qr_scan_seconds", deserialize_with = "de_u32_flexible")]
    pub qr_video_scan_seconds: u32,
    /// Remove the photo that carried a successful QR from the session list.
    #[serde(default = "default_true")]
    pub qr_remove_photo_after_scan: bool,
    /// Remove the video clip that carried a successful QR (if short enough).
    #[serde(default = "default_true")]
    pub qr_remove_video_after_scan: bool,
    /// Max clip duration (seconds) for auto-removal after QR hit. Default 10.
    #[serde(
        default = "default_qr_remove_video_max_duration",
        deserialize_with = "de_u32_flexible"
    )]
    pub qr_remove_video_max_duration_sec: u32,
    #[serde(default = "default_true")]
    pub sd_auto_backup: bool,
    #[serde(default)]
    pub sd_backup_folder: String,
    /// Optional second backup root (legacy: server/NAS dual write).
    #[serde(default)]
    pub sd_server_backup_enabled: bool,
    #[serde(default)]
    pub sd_server_backup_path: String,
    /// `"direct_dual_write"` | `"local_then_server"` | `"local_then_server_async"`.
    #[serde(default = "default_sd_server_backup_mode")]
    pub sd_server_backup_mode: String,
    #[serde(default = "default_sd_backup_mode")]
    pub sd_backup_mode: String,
    /// Label embedded in SD backup folder names (`SD_Backup_…[pc]_…`). Empty → no tag.
    #[serde(default)]
    pub sd_pc_name: String,
    #[serde(default)]
    pub sd_clear_after_backup: bool,
    /// Eject after successful backup (before import/QR), or after import when no backup ran.
    #[serde(default)]
    pub sd_eject_after_workflow: bool,
    #[serde(default = "default_true")]
    pub sd_auto_import: bool,
    #[serde(default)]
    pub sd_skip_processed: bool,
    #[serde(default = "default_true")]
    pub sd_size_limit_enabled: bool,
    #[serde(default = "default_sd_size_limit", deserialize_with = "de_u32_flexible")]
    pub sd_size_limit_mb: u32,
    /// Legacy flag — kept in sync with `manual_entry_mode == "oldschool"`.
    #[serde(default)]
    pub oldschool_mode: bool,
    /// Manual entry when not QR: `"id"` | `"oldschool"` | `"lokal"`.
    /// `lokal` = Vor-/Nachname like oldschool, without email/phone and without `_fertig.txt`.
    #[serde(default = "default_manual_entry_mode")]
    pub manual_entry_mode: String,
    #[serde(default)]
    pub keep_tandemmaster_on_session_reset: bool,
    #[serde(default)]
    pub keep_videospringer_on_session_reset: bool,
    /// Clear imported media (+ session form) after a successful create job.
    #[serde(default)]
    pub auto_clear_files_after_creation: bool,
    /// First-run setup wizard finished (or skipped). Reset clears this.
    #[serde(default)]
    pub setup_completed: bool,
    /// Optional AMS LAN Bridge base URL (`http://host:8787`).
    #[serde(default)]
    pub ams_bridge_url: String,
    /// Shared bearer token for AMS Bridge (Token-Auth Pflicht).
    #[serde(default)]
    pub ams_bridge_token: String,
    /// Last base URL that answered health successfully (fallback / Netzwechsel).
    #[serde(default)]
    pub ams_bridge_last_ok_url: String,
}

fn default_ort() -> String {
    "Calden".into()
}

fn default_crew_list() -> Vec<CrewMember> {
    // Roles mirror the production crew roster (videospringer flags from live config).
    let mut list = vec![
        CrewMember {
            name: "Alberto".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Ana".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Andy".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Chris".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Cornelius".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Futti".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Harry".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Henrik".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Jan".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Jojo".into(),
            tandemmaster: false,
            videospringer: true,
        },
        CrewMember {
            name: "Kai".into(),
            tandemmaster: false,
            videospringer: true,
        },
        CrewMember {
            name: "Käthe".into(),
            tandemmaster: false,
            videospringer: true,
        },
        CrewMember {
            name: "Max".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Mayo".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Pascal".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Ralph".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Rene".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Robert".into(),
            tandemmaster: false,
            videospringer: true,
        },
        CrewMember {
            name: "Robin".into(),
            tandemmaster: false,
            videospringer: true,
        },
        CrewMember {
            name: "Sabrina".into(),
            tandemmaster: false,
            videospringer: true,
        },
        CrewMember {
            name: "Sahira".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Samuel".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Stefan".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Steve".into(),
            tandemmaster: true,
            videospringer: false,
        },
        CrewMember {
            name: "Tim".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Tom".into(),
            tandemmaster: true,
            videospringer: true,
        },
        CrewMember {
            name: "Torsten".into(),
            tandemmaster: true,
            videospringer: true,
        },
    ];
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
}

fn default_dauer() -> u32 {
    5
}
fn default_true() -> bool {
    true
}
fn default_server_url() -> String {
    "smb://169.254.169.254/aktuell".into()
}
fn default_codec() -> String {
    "auto".into()
}
fn default_encoding_strategy() -> String {
    "per_clip".into()
}
fn default_intro_mux_mode() -> String {
    "reencode".into()
}
fn default_body_concat_mode() -> String {
    "legacy".into()
}
fn default_preview_crf() -> u8 {
    18
}

/// Normalize intro mux mode to `stream_copy` | `reencode`.
///
/// Legacy `soft_splice` maps to `reencode` (customer-compatible continuous encode).
pub fn normalize_intro_mux_mode(mode: &str) -> String {
    match mode.trim().to_ascii_lowercase().as_str() {
        "stream_copy" | "stream-copy" | "streamcopy" => "stream_copy".into(),
        _ => "reencode".into(),
    }
}

/// Normalize body concat mode to `fast` | `legacy`.
pub fn normalize_body_concat_mode(mode: &str) -> String {
    match mode.trim().to_ascii_lowercase().as_str() {
        "fast" | "fast_path" | "fast-path" | "avidemux" => "fast".into(),
        _ => "legacy".into(),
    }
}
fn default_qr_scan_seconds() -> u32 {
    5
}
fn default_qr_remove_video_max_duration() -> u32 {
    10
}
fn default_sd_backup_mode() -> String {
    "confirm".into()
}
fn default_sd_server_backup_mode() -> String {
    "local_then_server_async".into()
}
fn default_sd_size_limit() -> u32 {
    3000
}
fn default_manual_entry_mode() -> String {
    "id".into()
}

impl AppConfig {
    /// Canonicalize `manual_entry_mode` and keep `oldschool_mode` in sync.
    pub fn sync_manual_entry_mode(&mut self) {
        let mode = self.manual_entry_mode.trim().to_ascii_lowercase();
        self.manual_entry_mode = match mode.as_str() {
            "oldschool" => "oldschool".into(),
            "lokal" => "lokal".into(),
            _ => "id".into(),
        };
        self.oldschool_mode = self.manual_entry_mode == "oldschool";
    }

    /// Canonicalize `intro_mux_mode` to `stream_copy` | `reencode`.
    pub fn sync_intro_mux_mode(&mut self) {
        self.intro_mux_mode = normalize_intro_mux_mode(&self.intro_mux_mode);
    }

    /// Canonicalize `body_concat_mode` to `fast` | `legacy`.
    pub fn sync_body_concat_mode(&mut self) {
        self.body_concat_mode = normalize_body_concat_mode(&self.body_concat_mode);
    }

    /// Lokal mode skips `_fertig.txt` on create.
    pub fn skip_marker_file(&self) -> bool {
        self.manual_entry_mode == "lokal"
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            speicherort: String::new(),
            ort: default_ort(),
            dauer: default_dauer(),
            intro_enabled: false,
            outside_video: false,
            gast_name: String::new(),
            tandemmaster: String::new(),
            videospringer: String::new(),
            operator_name: String::new(),
            crew_list: default_crew_list(),
            upload_to_server: false,
            server_url: default_server_url(),
            server_login: String::new(),
            server_password: String::new(),
            hardware_acceleration_enabled: false,
            parallel_processing_enabled: true,
            video_codec: default_codec(),
            encoding_strategy: default_encoding_strategy(),
            reencode_matching_clips: false,
            intro_mux_mode: default_intro_mux_mode(),
            body_concat_mode: default_body_concat_mode(),
            preview_encode_crf: default_preview_crf(),
            qr_check_enabled: true,
            photo_qr_check_enabled: true,
            qr_video_scan_seconds: default_qr_scan_seconds(),
            qr_remove_photo_after_scan: true,
            qr_remove_video_after_scan: true,
            qr_remove_video_max_duration_sec: default_qr_remove_video_max_duration(),
            sd_auto_backup: true,
            sd_backup_folder: String::new(),
            sd_server_backup_enabled: false,
            sd_server_backup_path: String::new(),
            sd_server_backup_mode: default_sd_server_backup_mode(),
            sd_backup_mode: default_sd_backup_mode(),
            sd_pc_name: String::new(),
            sd_clear_after_backup: false,
            sd_eject_after_workflow: false,
            sd_auto_import: true,
            sd_skip_processed: false,
            sd_size_limit_enabled: true,
            sd_size_limit_mb: default_sd_size_limit(),
            oldschool_mode: false,
            manual_entry_mode: default_manual_entry_mode(),
            keep_tandemmaster_on_session_reset: false,
            keep_videospringer_on_session_reset: false,
            auto_clear_files_after_creation: false,
            setup_completed: false,
            ams_bridge_url: String::new(),
            ams_bridge_token: String::new(),
            ams_bridge_last_ok_url: String::new(),
        }
    }
}

/// Resolve `%LOCALAPPDATA%\AeroTandemStudio` (Windows) or
/// `~/Library/Application Support/AeroTandemStudio` (macOS).
pub fn app_config_dir() -> Result<PathBuf, ConfigError> {
    let base = BaseDirs::new().ok_or_else(|| {
        ConfigError::Message("could not resolve user application data directory".into())
    })?;
    Ok(base.data_local_dir().join(APP_DIR_NAME))
}

pub fn config_db_path() -> Result<PathBuf, ConfigError> {
    Ok(app_config_dir()?.join(DB_FILE_NAME))
}

fn legacy_json_path(dir: &Path) -> PathBuf {
    dir.join(LEGACY_JSON_NAME)
}

/// Merge unknown/missing keys from defaults (legacy load_settings behaviour).
pub fn merge_with_defaults(partial: Value) -> Result<AppConfig, ConfigError> {
    let obj = partial.as_object();
    let had_entry_mode = obj
        .map(|o| o.contains_key("manual_entry_mode"))
        .unwrap_or(false);
    let had_setup_completed = obj
        .map(|o| o.contains_key("setup_completed"))
        .unwrap_or(false);
    let mut defaults = serde_json::to_value(AppConfig::default())?;
    if let (Value::Object(base), Value::Object(overlay)) = (&mut defaults, partial) {
        for (k, v) in overlay {
            base.insert(k, v);
        }
    }
    let mut cfg: AppConfig = serde_json::from_value(defaults)?;
    if !had_entry_mode {
        // Migrate legacy configs that only had the boolean flag.
        cfg.manual_entry_mode = if cfg.oldschool_mode {
            "oldschool".into()
        } else {
            "id".into()
        };
    }
    if !had_setup_completed {
        // Pre-wizard installs: skip wizard when core paths/credentials exist.
        cfg.setup_completed = !cfg.speicherort.trim().is_empty()
            || !cfg.sd_backup_folder.trim().is_empty()
            || !cfg.server_login.trim().is_empty();
    }
    cfg.sync_manual_entry_mode();
    cfg.sync_intro_mux_mode();
    cfg.sync_body_concat_mode();
    Ok(cfg)
}

pub struct ConfigStore {
    db_path: PathBuf,
}

impl ConfigStore {
    pub fn open_default() -> Result<(Self, AppConfig), ConfigError> {
        let dir = app_config_dir()?;
        fs::create_dir_all(&dir)?;
        let store = Self {
            db_path: dir.join(DB_FILE_NAME),
        };
        let cfg = store.load_or_migrate(&dir)?;
        Ok((store, cfg))
    }

    #[allow(dead_code)]
    pub fn open_at(db_path: PathBuf) -> Result<Self, ConfigError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(Self { db_path })
    }

    fn connect(&self) -> Result<Connection, ConfigError> {
        let conn = Connection::open(&self.db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data TEXT NOT NULL
            );",
        )?;
        Ok(conn)
    }

    fn load_or_migrate(&self, dir: &Path) -> Result<AppConfig, ConfigError> {
        let conn = self.connect()?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT data FROM app_config WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .ok();

        if let Some(json) = existing {
            let value: Value = serde_json::from_str(&json)?;
            return merge_with_defaults(value);
        }

        // First run: import legacy config.json if present.
        let legacy = legacy_json_path(dir);
        let cfg = if legacy.is_file() {
            let raw = fs::read_to_string(&legacy)?;
            let value: Value = serde_json::from_str(&raw)?;
            merge_with_defaults(value)?
        } else {
            AppConfig::default()
        };
        self.save_with_conn(&conn, &cfg)?;
        Ok(cfg)
    }

    pub fn load(&self) -> Result<AppConfig, ConfigError> {
        let conn = self.connect()?;
        let json: String = conn
            .query_row(
                "SELECT data FROM app_config WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| {
                serde_json::to_string(&AppConfig::default()).unwrap_or_else(|_| "{}".into())
            });
        let value: Value = serde_json::from_str(&json)?;
        merge_with_defaults(value)
    }

    pub fn save(&self, cfg: &AppConfig) -> Result<(), ConfigError> {
        let mut normalized = cfg.clone();
        normalized.sync_manual_entry_mode();
        normalized.sync_intro_mux_mode();
        normalized.sync_body_concat_mode();
        let conn = self.connect()?;
        self.save_with_conn(&conn, &normalized)
    }

    fn save_with_conn(&self, conn: &Connection, cfg: &AppConfig) -> Result<(), ConfigError> {
        let json = serde_json::to_string_pretty(cfg)?;
        conn.execute(
            "INSERT INTO app_config (id, data) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![json],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reset_overwrites_custom_config() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("config.db");
        let store = ConfigStore::open_at(db).unwrap();
        let mut custom = AppConfig::default();
        custom.ort = "Gera".into();
        custom.server_login = "user".into();
        custom.dauer = 9;
        store.save(&custom).unwrap();

        let defaults = AppConfig::default();
        store.save(&defaults).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.ort, defaults.ort);
        assert_eq!(loaded.server_login, "");
        assert_eq!(loaded.dauer, defaults.dauer);
        assert!(!loaded.setup_completed);
        assert!(!loaded.intro_enabled);
        assert_eq!(loaded.crew_list, defaults.crew_list);
    }

    #[test]
    fn defaults_roundtrip_sqlite() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("config.db");
        let store = ConfigStore::open_at(db).unwrap();
        let cfg = AppConfig::default();
        store.save(&cfg).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded, cfg);
    }

    #[test]
    fn merge_fills_missing_keys() {
        let partial = serde_json::json!({ "ort": "Kassel", "dauer": 7 });
        let cfg = merge_with_defaults(partial).unwrap();
        assert_eq!(cfg.ort, "Kassel");
        assert_eq!(cfg.dauer, 7);
        assert!(!cfg.intro_enabled);
        assert!(!cfg.setup_completed);
        assert_eq!(cfg.video_codec, "auto");
        assert_eq!(cfg.intro_mux_mode, "reencode");
        assert_eq!(cfg.body_concat_mode, "legacy");
        assert_eq!(cfg.server_url, "smb://169.254.169.254/aktuell");
        assert!(!cfg.hardware_acceleration_enabled);
        assert!(!cfg.oldschool_mode);
        assert_eq!(cfg.manual_entry_mode, "id");
        assert!(cfg.sd_auto_backup);
        assert!(cfg.sd_auto_import);
        assert_eq!(cfg.sd_backup_mode, "confirm");
        assert!(!cfg.sd_clear_after_backup);
        assert!(!cfg.sd_eject_after_workflow);
        assert!(!cfg.sd_server_backup_enabled);
        assert!(cfg.sd_server_backup_path.is_empty());
        assert_eq!(cfg.sd_server_backup_mode, "local_then_server_async");
        assert_eq!(cfg.sd_size_limit_mb, 3000);
        assert!(cfg.sd_size_limit_enabled);
        assert!(cfg.qr_check_enabled);
        assert!(cfg.photo_qr_check_enabled);
        assert!(cfg.qr_remove_photo_after_scan);
        assert!(cfg.qr_remove_video_after_scan);
        assert_eq!(cfg.qr_remove_video_max_duration_sec, 10);
        assert_eq!(cfg.qr_video_scan_seconds, 5);
    }

    #[test]
    fn normalize_intro_mux_mode_maps_legacy_soft_splice() {
        assert_eq!(normalize_intro_mux_mode("stream_copy"), "stream_copy");
        assert_eq!(normalize_intro_mux_mode("stream-copy"), "stream_copy");
        assert_eq!(normalize_intro_mux_mode("reencode"), "reencode");
        assert_eq!(normalize_intro_mux_mode("soft_splice"), "reencode");
        assert_eq!(normalize_intro_mux_mode(""), "reencode");
    }

    #[test]
    fn normalize_body_concat_mode_aliases() {
        assert_eq!(normalize_body_concat_mode("fast"), "fast");
        assert_eq!(normalize_body_concat_mode("fast_path"), "fast");
        assert_eq!(normalize_body_concat_mode("fast-path"), "fast");
        assert_eq!(normalize_body_concat_mode("legacy"), "legacy");
        assert_eq!(normalize_body_concat_mode(""), "legacy");
        assert_eq!(normalize_body_concat_mode("bogus"), "legacy");
    }

    #[test]
    fn imports_legacy_json_once() {
        let dir = tempdir().unwrap();
        let legacy = dir.path().join(LEGACY_JSON_NAME);
        fs::write(
            &legacy,
            r#"{ "ort": "LegacyOrt", "tandemmaster": "Tom", "dauer": 3 }"#,
        )
        .unwrap();

        let store = ConfigStore {
            db_path: dir.path().join(DB_FILE_NAME),
        };
        let cfg = store.load_or_migrate(dir.path()).unwrap();
        assert_eq!(cfg.ort, "LegacyOrt");
        assert_eq!(cfg.tandemmaster, "Tom");
        assert_eq!(cfg.dauer, 3);

        // Second open uses SQLite, not re-reading JSON changes.
        fs::write(&legacy, r#"{ "ort": "Changed" }"#).unwrap();
        let again = store.load().unwrap();
        assert_eq!(again.ort, "LegacyOrt");
    }

    #[test]
    fn accepts_float_numbers_from_legacy() {
        let json = r#"{ "dauer": 5.0, "qr_video_scan_seconds": 5.5, "preview_encode_crf": 18.0, "sd_size_limit_mb": 2000.0 }"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.dauer, 5);
        assert_eq!(cfg.qr_video_scan_seconds, 6);
        assert_eq!(cfg.preview_encode_crf, 18);
        assert_eq!(cfg.sd_size_limit_mb, 2000);
    }

    #[test]
    fn serde_accepts_section9_keys() {
        let json = r#"{
          "speicherort": "",
          "ort": "Calden",
          "dauer": 5,
          "intro_enabled": true,
          "outside_video": false,
          "gast_name": "",
          "tandemmaster": "",
          "videospringer": "",
          "upload_to_server": false,
          "server_url": "smb://169.254.169.254/aktuell",
          "hardware_acceleration_enabled": true,
          "parallel_processing_enabled": true,
          "video_codec": "auto",
          "encoding_strategy": "per_clip",
          "qr_check_enabled": false,
          "photo_qr_check_enabled": false,
          "qr_video_scan_seconds": 5,
          "sd_auto_backup": false,
          "sd_backup_folder": "",
          "sd_backup_mode": "confirm",
          "sd_clear_after_backup": false,
          "sd_auto_import": false,
          "sd_skip_processed": false,
          "sd_size_limit_enabled": false,
          "sd_size_limit_mb": 2000,
          "setup_completed": false
        }"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.ort, "Calden");
        assert_eq!(cfg.sd_size_limit_mb, 2000);
        assert!(!cfg.setup_completed);
        assert_eq!(cfg.crew_list, default_crew_list());
        assert!(cfg.crew_list.iter().any(|c| c.name == "Andy" && c.tandemmaster));
    }

    #[test]
    fn setup_completed_inferred_for_legacy_configs() {
        let empty = merge_with_defaults(serde_json::json!({ "ort": "Calden" })).unwrap();
        assert!(!empty.setup_completed);

        let with_path = merge_with_defaults(serde_json::json!({
            "speicherort": "D:/Jobs"
        }))
        .unwrap();
        assert!(with_path.setup_completed);

        let explicit = merge_with_defaults(serde_json::json!({
            "setup_completed": false,
            "speicherort": "D:/Jobs"
        }))
        .unwrap();
        assert!(!explicit.setup_completed);
    }

    #[test]
    fn migrate_oldschool_bool_to_entry_mode() {
        let cfg = merge_with_defaults(serde_json::json!({ "oldschool_mode": true })).unwrap();
        assert_eq!(cfg.manual_entry_mode, "oldschool");
        assert!(cfg.oldschool_mode);
    }

    #[test]
    fn lokal_entry_mode_skips_marker() {
        let cfg = merge_with_defaults(serde_json::json!({ "manual_entry_mode": "lokal" })).unwrap();
        assert_eq!(cfg.manual_entry_mode, "lokal");
        assert!(!cfg.oldschool_mode);
        assert!(cfg.skip_marker_file());
    }

    #[test]
    fn crew_list_defaults_when_missing() {
        let cfg = merge_with_defaults(serde_json::json!({ "ort": "Gera" })).unwrap();
        assert_eq!(cfg.ort, "Gera");
        assert_eq!(cfg.crew_list, default_crew_list());
    }

    #[test]
    fn operator_name_defaults_empty_when_missing() {
        let cfg = merge_with_defaults(serde_json::json!({ "ort": "Gera" })).unwrap();
        assert_eq!(cfg.operator_name, "");
    }

    #[test]
    fn operator_name_roundtrips() {
        let mut cfg = AppConfig::default();
        cfg.operator_name = "Andy".into();
        let dir = tempdir().unwrap();
        let store = ConfigStore::open_at(dir.path().join("config.db")).unwrap();
        store.save(&cfg).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.operator_name, "Andy");
    }

    #[test]
    fn crew_list_roundtrips_with_roles() {
        let mut cfg = AppConfig::default();
        cfg.crew_list = vec![
            CrewMember {
                name: "Ada".into(),
                tandemmaster: true,
                videospringer: true,
            },
            CrewMember {
                name: "Ben".into(),
                tandemmaster: false,
                videospringer: true,
            },
        ];
        let dir = tempdir().unwrap();
        let store = ConfigStore::open_at(dir.path().join("config.db")).unwrap();
        store.save(&cfg).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.crew_list, cfg.crew_list);
    }

    #[test]
    fn default_crew_list_has_expected_tandemmasters() {
        let list = default_crew_list();
        assert_eq!(list.len(), 27);
        assert_eq!(list.first().unwrap().name, "Alberto");
        assert_eq!(list.last().unwrap().name, "Torsten");
        let names: Vec<_> = list.iter().map(|c| c.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort_by_key(|n| n.to_lowercase());
        assert_eq!(names, sorted);
        for name in ["Jan", "Pascal", "Rene"] {
            assert!(list.iter().any(|c| c.name == name && c.tandemmaster && !c.videospringer));
        }
        for name in ["Jojo", "Kai", "Käthe", "Robert", "Robin", "Sabrina"] {
            assert!(list.iter().any(|c| c.name == name && !c.tandemmaster && c.videospringer));
        }
        let vs: Vec<_> = list
            .iter()
            .filter(|c| c.videospringer)
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(
            vs,
            [
                "Ana", "Andy", "Futti", "Harry", "Henrik", "Jojo", "Kai", "Käthe", "Ralph",
                "Robert", "Robin", "Sabrina", "Sahira", "Samuel", "Tim", "Tom", "Torsten"
            ]
        );
    }
}
