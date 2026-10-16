//! Phase 56: resolve SD backup session folders from import source paths + local rename (56B).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::media::dji_paths::read_backup_manifest;
use crate::sd_card::monitor::{
    build_backup_dir_name_with_guest, parse_sd_backup_dir_name, sanitize_guest_for_backup,
};
use crate::storage::cache::normalize_key;
use crate::storage::local_folders::is_strict_child_of;

fn resolve_existing_root(root: &str) -> Option<PathBuf> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return None;
    }
    Some(fs::canonicalize(&path).unwrap_or(path))
}

fn is_direct_child_of_root(root: &Path, candidate: &Path) -> bool {
    if !is_strict_child_of(root, candidate) {
        return false;
    }
    candidate.parent().is_some_and(|p| normalize_key(p) == normalize_key(root))
}

pub(crate) fn is_sd_backup_session_folder(path: &Path) -> bool {
    is_valid_backup_folder(path)
}

fn is_valid_backup_folder(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.starts_with("SD_Backup_") {
        return true;
    }
    read_backup_manifest(path).is_some()
}

fn backup_folder_for_source(source: &Path, root: &Path) -> Option<PathBuf> {
    let mut current = if source.is_file() {
        source.parent()?.to_path_buf()
    } else {
        fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf())
    };

    loop {
        if normalize_key(&current) == normalize_key(root) {
            return None;
        }
        if is_direct_child_of_root(root, &current) {
            return is_valid_backup_folder(&current).then_some(current);
        }
        if !is_strict_child_of(root, &current) {
            return None;
        }
        current = current.parent()?.to_path_buf();
    }
}

/// Collect distinct backup session folders under `sd_backup_folder` for source media paths.
pub fn resolve_backup_folders_from_source_paths(
    paths: &[String],
    sd_backup_folder: &str,
) -> Vec<PathBuf> {
    let Some(root) = resolve_existing_root(sd_backup_folder) else {
        return Vec::new();
    };

    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = Path::new(trimmed);
        let Some(folder) = backup_folder_for_source(path, &root) else {
            continue;
        };
        let key = normalize_key(&folder);
        if seen.insert(key) {
            out.push(folder);
        }
    }
    out
}

/// Validate explicit backup session roots from the UI (Phase 56 — preview temps bypass path walk).
pub fn explicit_backup_session_folders(
    session_paths: &[String],
    sd_backup_folder: &str,
) -> Vec<PathBuf> {
    let root = resolve_existing_root(sd_backup_folder);
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for raw in session_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let folder = PathBuf::from(trimmed);
        if !folder.is_dir() || !is_valid_backup_folder(&folder) {
            continue;
        }
        if let Some(ref root) = root {
            if !is_strict_child_of(root, &folder) {
                continue;
            }
        }
        let key = normalize_key(&folder);
        if seen.insert(key) {
            out.push(folder);
        }
    }
    out
}

/// Path walk from create sources plus explicit session folders from the SD workflow.
pub fn collect_backup_folders_for_vorgang_link(
    source_paths: &[String],
    sd_backup_folder: &str,
    explicit_sessions: &[String],
) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let mut push = |folder: PathBuf| {
        if !is_valid_backup_folder(&folder) {
            return;
        }
        let key = normalize_key(&folder);
        if seen.insert(key) {
            out.push(folder);
        }
    };
    for folder in resolve_backup_folders_from_source_paths(source_paths, sd_backup_folder) {
        push(folder);
    }
    for folder in explicit_backup_session_folders(explicit_sessions, sd_backup_folder) {
        push(folder);
    }
    out
}

fn pick_unique_backup_leaf(
    backup_root: &Path,
    timestamp: &str,
    pc_name: &str,
    short_hash: &str,
    guest_segment: &str,
    exclude: &Path,
) -> String {
    let base = build_backup_dir_name_with_guest(timestamp, pc_name, short_hash, guest_segment);
    let candidate = backup_root.join(&base);
    if !candidate.exists() || normalize_key(&candidate) == normalize_key(exclude) {
        return base;
    }
    for n in 2..1000 {
        let guest = format!("{guest_segment}_{n}");
        let leaf = build_backup_dir_name_with_guest(timestamp, pc_name, short_hash, &guest);
        let path = backup_root.join(&leaf);
        if !path.exists() || normalize_key(&path) == normalize_key(exclude) {
            return leaf;
        }
    }
    base
}

/// Rename a linked local SD backup folder to include the guest segment (Phase 56B).
pub fn rename_local_backup_folder(
    sd_backup_folder: &str,
    local_path: &str,
    guest: &str,
) -> Result<String, String> {
    let guest_seg = sanitize_guest_for_backup(guest);
    if guest_seg.is_empty() {
        return Ok(local_path.to_string());
    }
    let Some(root) = resolve_existing_root(sd_backup_folder) else {
        return Err("SD backup root missing".into());
    };
    let folder = PathBuf::from(local_path.trim());
    if !folder.is_dir() {
        return Err(format!("backup folder not found: {}", folder.display()));
    }
    if !is_strict_child_of(&root, &folder) {
        return Err("backup path outside configured root".into());
    }
    let leaf = folder
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid backup folder name".to_string())?;
    let parsed = parse_sd_backup_dir_name(leaf)
        .ok_or_else(|| format!("not a standard SD_Backup folder: {leaf}"))?;
    if parsed.guest_segment == guest_seg {
        return Ok(folder.to_string_lossy().into_owned());
    }
    let new_leaf = pick_unique_backup_leaf(
        &root,
        &parsed.timestamp,
        &parsed.pc_name,
        &parsed.short_hash,
        &guest_seg,
        &folder,
    );
    if new_leaf == leaf {
        return Ok(folder.to_string_lossy().into_owned());
    }
    let dest = root.join(&new_leaf);
    if dest.exists() && normalize_key(&dest) != normalize_key(&folder) {
        return Err(format!("rename target already exists: {}", dest.display()));
    }
    fs::rename(&folder, &dest).map_err(|e| format!("rename failed: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::dji_paths::write_backup_manifest;
    use tempfile::tempdir;

    fn touch_backup(root: &Path, name: &str) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn explicit_session_links_without_source_under_backup() {
        let tmp = tempdir().unwrap();
        let backup_root = tmp.path().join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        let session = touch_backup(&backup_root, "SD_Backup_20240101_120000_ab12");
        let temp_clip = tmp.path().join("preview").join("clip.mp4");
        fs::create_dir_all(temp_clip.parent().unwrap()).unwrap();
        fs::write(&temp_clip, b"v").unwrap();

        let linked = collect_backup_folders_for_vorgang_link(
            &[temp_clip.to_string_lossy().into_owned()],
            backup_root.to_string_lossy().as_ref(),
            &[session.to_string_lossy().into_owned()],
        );
        assert_eq!(linked.len(), 1);
        assert_eq!(normalize_key(&linked[0]), normalize_key(&session));
    }

    #[test]
    fn nested_file_resolves_to_backup_folder() {
        let tmp = tempdir().unwrap();
        let backup_root = tmp.path().join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        let session = touch_backup(&backup_root, "SD_Backup_20240101_120000_ab12");
        let nested = session.join("DCIM").join("100MEDIA");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("clip.mp4");
        fs::write(&file, b"v").unwrap();

        let resolved = resolve_backup_folders_from_source_paths(
            &[file.to_string_lossy().into_owned()],
            backup_root.to_string_lossy().as_ref(),
        );
        assert_eq!(resolved.len(), 1);
        assert_eq!(normalize_key(&resolved[0]), normalize_key(&session));
    }

    #[test]
    fn path_outside_backup_root_is_ignored() {
        let tmp = tempdir().unwrap();
        let backup_root = tmp.path().join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        let elsewhere = tmp.path().join("other").join("clip.mp4");
        fs::create_dir_all(elsewhere.parent().unwrap()).unwrap();
        fs::write(&elsewhere, b"v").unwrap();

        let resolved = resolve_backup_folders_from_source_paths(
            &[elsewhere.to_string_lossy().into_owned()],
            backup_root.to_string_lossy().as_ref(),
        );
        assert!(resolved.is_empty());
    }

    #[test]
    fn two_sources_same_backup_deduped() {
        let tmp = tempdir().unwrap();
        let backup_root = tmp.path().join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        let session = touch_backup(&backup_root, "SD_Backup_20240101_120000_ab12");
        let a = session.join("a.mp4");
        let b = session.join("b.mp4");
        fs::write(&a, b"1").unwrap();
        fs::write(&b, b"2").unwrap();

        let resolved = resolve_backup_folders_from_source_paths(
            &[
                a.to_string_lossy().into_owned(),
                b.to_string_lossy().into_owned(),
            ],
            backup_root.to_string_lossy().as_ref(),
        );
        assert_eq!(resolved.len(), 1);
    }

    #[test]
    fn two_backups_from_two_paths() {
        let tmp = tempdir().unwrap();
        let backup_root = tmp.path().join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        let s1 = touch_backup(&backup_root, "SD_Backup_20240101_120000_aa");
        let s2 = touch_backup(&backup_root, "SD_Backup_20240101_130000_bb");
        let f1 = s1.join("v.mp4");
        let f2 = s2.join("p.jpg");
        fs::write(&f1, b"v").unwrap();
        fs::write(&f2, b"p").unwrap();

        let resolved = resolve_backup_folders_from_source_paths(
            &[
                f1.to_string_lossy().into_owned(),
                f2.to_string_lossy().into_owned(),
            ],
            backup_root.to_string_lossy().as_ref(),
        );
        assert_eq!(resolved.len(), 2);
    }

    #[test]
    fn manifest_only_backup_name_accepted() {
        let tmp = tempdir().unwrap();
        let backup_root = tmp.path().join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        let session = touch_backup(&backup_root, "CustomSession_xyz");
        write_backup_manifest(&session, "/dcim", &[], false).unwrap();
        let file = session.join("x.mp4");
        fs::write(&file, b"x").unwrap();

        let resolved = resolve_backup_folders_from_source_paths(
            &[file.to_string_lossy().into_owned()],
            backup_root.to_string_lossy().as_ref(),
        );
        assert_eq!(resolved.len(), 1);
    }

    #[test]
    fn rename_local_backup_adds_guest_and_keeps_timestamp_parseable() {
        let tmp = tempdir().unwrap();
        let backup_root = tmp.path().join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        let session = touch_backup(&backup_root, "SD_Backup_20240101_120000[Desk]_ab12");
        fs::write(session.join("clip.mp4"), b"v").unwrap();

        let new_path = rename_local_backup_folder(
            backup_root.to_string_lossy().as_ref(),
            &session.to_string_lossy(),
            "Max Mustermann",
        )
        .unwrap();
        assert!(Path::new(&new_path).is_dir());
        assert_eq!(
            Path::new(&new_path).file_name().unwrap().to_str().unwrap(),
            "SD_Backup_20240101_120000_Max_Mustermann[Desk]_ab12"
        );
        assert!(
            crate::storage::local_folders::parse_sd_backup_folder_timestamp(
                Path::new(&new_path).file_name().unwrap().to_str().unwrap()
            )
            .is_some()
        );
    }

    #[test]
    fn rename_local_backup_collision_gets_numeric_suffix() {
        let tmp = tempdir().unwrap();
        let backup_root = tmp.path().join("backups");
        fs::create_dir_all(&backup_root).unwrap();
        touch_backup(
            &backup_root,
            "SD_Backup_20240101_120000_Max[Desk]_cd34",
        );
        let session = touch_backup(&backup_root, "SD_Backup_20240101_120000[Desk]_cd34");

        let new_path = rename_local_backup_folder(
            backup_root.to_string_lossy().as_ref(),
            &session.to_string_lossy(),
            "Max",
        )
        .unwrap();
        assert_eq!(
            Path::new(&new_path).file_name().unwrap().to_str().unwrap(),
            "SD_Backup_20240101_120000_Max_2[Desk]_cd34"
        );
    }
}
