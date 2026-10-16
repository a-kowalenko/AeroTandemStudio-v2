//! Phase 56C: SMB backup folder rename after guest rename + secondary mirror race.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::smb::client::{parse_server_target, ServerTarget};
use crate::smb::rename_remote_backup_folder;
use crate::sd_card::secondary_backup::SECONDARY_BACKUP;
use crate::storage::config::ConfigStore;
use crate::storage::logging;
use crate::storage::vorgang_history::{VorgangBackup, VorgangHistoryStore};

pub const EVENT_BACKUP_REMOTE_RENAME: &str = "sd-backup-remote-rename";

#[derive(Debug, Clone)]
pub struct RemoteBackupRenameConfig {
    pub enabled: bool,
    pub server_url: String,
    pub login: String,
    pub password: String,
    pub auto_mount_enabled: bool,
}

#[derive(Debug, Clone)]
struct PendingRemoteBackupRename {
    backup_id: i64,
    old_leaf: String,
    new_leaf: String,
    config: RemoteBackupRenameConfig,
}

static PENDING: OnceLock<Mutex<Vec<PendingRemoteBackupRename>>> = OnceLock::new();
static TOAST: OnceLock<Mutex<Option<Arc<dyn Fn(String) + Send + Sync>>>> = OnceLock::new();

fn pending() -> &'static Mutex<Vec<PendingRemoteBackupRename>> {
    PENDING.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn set_remote_rename_toast(cb: Option<Arc<dyn Fn(String) + Send + Sync>>) {
    *TOAST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = cb;
}

fn notify_soft_fail(message: String) {
    logging::warn("sd", format!("Server-Backup-Umbenennung: {message}"));
    if let Some(cb) = TOAST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        cb(message);
    }
}

fn register_pending(entry: PendingRemoteBackupRename) {
    let mut q = pending().lock().unwrap_or_else(|e| e.into_inner());
    q.retain(|p| p.backup_id != entry.backup_id);
    q.push(entry);
}

fn take_pending_for_backup(backup_id: i64) -> Option<PendingRemoteBackupRename> {
    let mut q = pending().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(idx) = q.iter().position(|p| p.backup_id == backup_id) {
        Some(q.remove(idx))
    } else {
        None
    }
}

fn backup_leaf(row: &VorgangBackup) -> Option<String> {
    Path::new(row.local_path.trim())
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
}

fn remote_old_leaf(row: &VorgangBackup) -> String {
    let orig = row.remote_original_leaf.trim();
    if !orig.is_empty() {
        return orig.to_string();
    }
    row.local_original_name.trim().to_string()
}

pub fn remote_backup_leaf_exists(config: &RemoteBackupRenameConfig, leaf: &str) -> bool {
    let leaf = leaf.trim();
    if leaf.is_empty() || !config.enabled {
        return false;
    }
    let Ok(target) = parse_server_target(config.server_url.trim()) else {
        return false;
    };
    match target {
        ServerTarget::Local { path } => path.join(leaf).is_dir(),
        ServerTarget::Smb { .. } => false,
    }
}

fn execute_remote_rename(
    store: &VorgangHistoryStore,
    row: &VorgangBackup,
    old_leaf: &str,
    new_leaf: &str,
    config: &RemoteBackupRenameConfig,
) {
    if old_leaf == new_leaf {
        return;
    }
    match rename_remote_backup_folder(
        &config.server_url,
        &config.login,
        &config.password,
        config.auto_mount_enabled,
        old_leaf,
        new_leaf,
    ) {
        Ok(remote_path) => {
            logging::info(
                "sd",
                format!(
                    "Server-Backup-Ordner umbenannt (backup_id={}, {old_leaf} → {new_leaf})",
                    row.id
                ),
            );
            if let Err(e) = store.mark_vorgang_backup_remote_renamed(row.id, &remote_path, old_leaf)
            {
                logging::error(
                    "vorgang_history",
                    format!(
                        "Server-Backup-Umbenennung DB-Update fehlgeschlagen (backup_id={}): {e}",
                        row.id
                    ),
                );
            }
        }
        Err(e) => {
            let _ = store.set_vorgang_backup_remote_rename_error(row.id, &e);
            notify_soft_fail(e);
        }
    }
}

/// After Create + local guest rename: queue or run SMB leaf rename (Phase 56C).
pub fn plan_vorgang_backups_remote_rename_after_create(
    vorgang_id: i64,
    config: &RemoteBackupRenameConfig,
) {
    if !config.enabled || config.server_url.trim().is_empty() {
        return;
    }
    let Ok(store) = VorgangHistoryStore::open_default() else {
        return;
    };
    let Ok(rows) = store.list_vorgang_backups(vorgang_id) else {
        return;
    };
    for row in rows {
        if !row.local_renamed_at.trim().is_empty() {
            plan_row_remote_rename(&store, &row, config);
        }
    }
}

fn plan_row_remote_rename(
    store: &VorgangHistoryStore,
    row: &VorgangBackup,
    config: &RemoteBackupRenameConfig,
) {
    if !row.remote_renamed_at.trim().is_empty() {
        return;
    }
    let Some(new_leaf) = backup_leaf(row) else {
        return;
    };
    let old_leaf = remote_old_leaf(row);
    if old_leaf.is_empty() || old_leaf == new_leaf {
        return;
    }

    let local_path = PathBuf::from(row.local_path.trim());
    if SECONDARY_BACKUP.is_mirror_busy_for(&local_path, &old_leaf) {
        register_pending(PendingRemoteBackupRename {
            backup_id: row.id,
            old_leaf: old_leaf.clone(),
            new_leaf: new_leaf.clone(),
            config: config.clone(),
        });
        logging::info(
            "sd",
            format!(
                "Server-Backup-Umbenennung wartet auf Mirror (backup_id={}, {old_leaf} → {new_leaf})",
                row.id
            ),
        );
        return;
    }

    logging::info(
        "sd",
        format!(
            "Server-Backup-Umbenennung starten (backup_id={}, {old_leaf} → {new_leaf})",
            row.id
        ),
    );
    execute_remote_rename(store, row, &old_leaf, &new_leaf, config);
}

/// Apply cached mirror paths when the SMB upload finished before the Vorgang row existed.
pub fn hydrate_vorgang_backup_remote_mirrors(vorgang_id: i64) {
    let Ok(store) = VorgangHistoryStore::open_default() else {
        return;
    };
    let Ok(rows) = store.list_vorgang_backups(vorgang_id) else {
        return;
    };
    for row in rows {
        if !row.remote_path.trim().is_empty() {
            continue;
        }
        let mut leaves: Vec<String> = Vec::new();
        let orig = row.local_original_name.trim();
        if !orig.is_empty() {
            leaves.push(orig.to_string());
        }
        if let Some(current) = backup_leaf(&row) {
            if !leaves.iter().any(|l| l == &current) {
                leaves.push(current);
            }
        }
        for leaf in leaves {
            let Some(remote) = SECONDARY_BACKUP.completed_mirror_remote_for_leaf(&leaf) else {
                continue;
            };
            if let Ok(ids) = store.note_vorgang_backup_remote_mirror(
                &row.local_path,
                &leaf,
                &remote,
            ) {
                if !ids.is_empty() {
                    logging::info(
                        "sd",
                        format!(
                            "Server-Backup-Pfad aus Mirror-Cache übernommen (backup_id={}, leaf={leaf})",
                            row.id
                        ),
                    );
                }
            }
            break;
        }
    }
}

/// Secondary mirror finished: persist remote path + flush pending SMB rename.
fn remote_rename_config_from_job(
    server_url: &str,
    login: &str,
    password: &str,
    auto_mount_enabled: bool,
) -> RemoteBackupRenameConfig {
    let enabled = ConfigStore::open_default()
        .ok()
        .is_some_and(|(_, cfg)| {
            cfg.sd_server_backup_enabled && cfg.sd_server_backup_rename_with_guest
        });
    RemoteBackupRenameConfig {
        enabled,
        server_url: server_url.to_string(),
        login: login.to_string(),
        password: password.to_string(),
        auto_mount_enabled,
    }
}

pub fn on_secondary_mirror_done(
    primary_path: &Path,
    remote_path: &str,
    server_url: &str,
    login: &str,
    password: &str,
    auto_mount_enabled: bool,
) {
    let config = remote_rename_config_from_job(
        server_url,
        login,
        password,
        auto_mount_enabled,
    );
    if !config.enabled {
        let Ok(store) = VorgangHistoryStore::open_default() else {
            return;
        };
        let leaf = primary_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let _ = store.note_vorgang_backup_remote_mirror(
            &primary_path.to_string_lossy(),
            &leaf,
            remote_path,
        );
        return;
    }
    let Ok(store) = VorgangHistoryStore::open_default() else {
        return;
    };
    let leaf = primary_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Ok(updated_ids) = store.note_vorgang_backup_remote_mirror(
        &primary_path.to_string_lossy(),
        &leaf,
        remote_path,
    ) else {
        return;
    };

    let mut backup_ids: Vec<i64> = updated_ids;
    backup_ids.extend(
        pending()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|p| p.backup_id),
    );
    backup_ids.sort_unstable();
    backup_ids.dedup();

    for backup_id in backup_ids {
        let Some(row) = store.get_vorgang_backup_by_id(backup_id) else {
            let _ = take_pending_for_backup(backup_id);
            continue;
        };
        if !row.remote_renamed_at.trim().is_empty() {
            let _ = take_pending_for_backup(backup_id);
            continue;
        }
        let (old_leaf, new_leaf, cfg) = if let Some(pending) = take_pending_for_backup(backup_id) {
            (
                pending.old_leaf,
                pending.new_leaf,
                pending.config,
            )
        } else if !row.local_renamed_at.trim().is_empty() {
            let old = remote_old_leaf(&row);
            let Some(new) = backup_leaf(&row) else {
                continue;
            };
            (old, new, config.clone())
        } else {
            continue;
        };
        if old_leaf.is_empty() || old_leaf == new_leaf {
            continue;
        }
        execute_remote_rename(&store, &row, &old_leaf, &new_leaf, &cfg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn sample_config(url: &str) -> RemoteBackupRenameConfig {
        RemoteBackupRenameConfig {
            enabled: true,
            server_url: url.to_string(),
            login: String::new(),
            password: String::new(),
            auto_mount_enabled: false,
        }
    }

    #[test]
    fn remote_leaf_exists_on_local_server_root() {
        let dest = tempdir().unwrap();
        fs::create_dir_all(dest.path().join("SD_Backup_old")).unwrap();
        let cfg = sample_config(dest.path().to_str().unwrap());
        assert!(remote_backup_leaf_exists(&cfg, "SD_Backup_old"));
        assert!(!remote_backup_leaf_exists(&cfg, "SD_Backup_missing"));
    }

    #[test]
    fn rename_remote_backup_folder_local_dest() {
        let server = tempdir().unwrap();
        fs::create_dir_all(server.path().join("SD_Backup_old")).unwrap();
        let remote = rename_remote_backup_folder(
            server.path().to_str().unwrap(),
            "",
            "",
            false,
            "SD_Backup_old",
            "SD_Backup_guest",
        )
        .unwrap();
        assert!(remote.contains("SD_Backup_guest"));
        assert!(server.path().join("SD_Backup_guest").is_dir());
    }
}
