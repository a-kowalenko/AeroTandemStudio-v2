//! OS-dependent default folders for Vorgänge (`speicherort`) and SD backups.
//!
//! Layout under the user Videos/Movies directory:
//! `AeroTandemStudio/{Erstellt,SD-Backups}`

use std::fs;
use std::path::{Path, PathBuf};

use directories::UserDirs;
use serde::{Deserialize, Serialize};

const APP_MEDIA_ROOT_NAME: &str = "AeroTandemStudio";
const ERSTELLT_DIR: &str = "Erstellt";
const SD_BACKUPS_DIR: &str = "SD-Backups";

/// Warn when free space on the target volume is below this (50 GiB).
const LOW_SPACE_BYTES: u64 = 50 * 1024 * 1024 * 1024;

/// Prefer an alternate fixed volume when it has at least this much more free space.
const ALTERNATE_EXTRA_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultMediaDirKind {
    Speicherort,
    SdBackupFolder,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DefaultMediaDirsProposal {
    pub root: String,
    pub speicherort: String,
    pub sd_backup_folder: String,
    pub warnings: Vec<String>,
    pub alternate_root: Option<String>,
    pub alternate_speicherort: Option<String>,
    pub alternate_sd_backup_folder: Option<String>,
    pub free_bytes: Option<u64>,
    pub alternate_free_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EnsureDefaultMediaDirResult {
    pub kind: DefaultMediaDirKind,
    pub root: String,
    pub path: String,
    pub created: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum DefaultMediaDirsError {
    #[error("{0}")]
    Message(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Resolve `…/Videos|Movies/AeroTandemStudio` (or override root).
pub fn media_root_from_override(override_root: Option<&Path>) -> Result<PathBuf, DefaultMediaDirsError> {
    if let Some(root) = override_root {
        let trimmed = root.as_os_str();
        if trimmed.is_empty() {
            return Err(DefaultMediaDirsError::Message(
                "override root path is empty".into(),
            ));
        }
        return Ok(root.to_path_buf());
    }
    Ok(default_media_root()?)
}

pub fn default_media_root() -> Result<PathBuf, DefaultMediaDirsError> {
    let base = user_videos_or_movies_dir()?;
    Ok(base.join(APP_MEDIA_ROOT_NAME))
}

pub fn paths_under_root(root: &Path) -> (PathBuf, PathBuf) {
    (root.join(ERSTELLT_DIR), root.join(SD_BACKUPS_DIR))
}

pub fn path_for_kind(root: &Path, kind: DefaultMediaDirKind) -> PathBuf {
    match kind {
        DefaultMediaDirKind::Speicherort => root.join(ERSTELLT_DIR),
        DefaultMediaDirKind::SdBackupFolder => root.join(SD_BACKUPS_DIR),
    }
}

pub fn propose_default_media_dirs() -> Result<DefaultMediaDirsProposal, DefaultMediaDirsError> {
    let root = default_media_root()?;
    let (speicherort, backup) = paths_under_root(&root);
    let free_bytes = available_bytes_for_path(&root);
    let mut warnings = collect_path_warnings(&root, free_bytes);

    let mut alternate_root = None;
    let mut alternate_speicherort = None;
    let mut alternate_sd_backup_folder = None;
    let mut alternate_free_bytes = None;

    if let Some((alt, alt_free)) = find_preferred_alternate_root(free_bytes) {
        let (alt_s, alt_b) = paths_under_root(&alt);
        alternate_root = Some(path_to_string(&alt));
        alternate_speicherort = Some(path_to_string(&alt_s));
        alternate_sd_backup_folder = Some(path_to_string(&alt_b));
        alternate_free_bytes = Some(alt_free);
        warnings.push(format!(
            "Weiterer lokaler Datenträger mit mehr freiem Speicher: {}.",
            path_to_string(&alt)
        ));
    }

    Ok(DefaultMediaDirsProposal {
        root: path_to_string(&root),
        speicherort: path_to_string(&speicherort),
        sd_backup_folder: path_to_string(&backup),
        warnings,
        alternate_root,
        alternate_speicherort,
        alternate_sd_backup_folder,
        free_bytes,
        alternate_free_bytes,
    })
}

/// Create exactly one default folder (`Erstellt` or `SD-Backups`) under `root`.
pub fn ensure_default_media_dir(
    kind: DefaultMediaDirKind,
    override_root: Option<&Path>,
) -> Result<EnsureDefaultMediaDirResult, DefaultMediaDirsError> {
    let root = media_root_from_override(override_root)?;
    let path = path_for_kind(&root, kind);

    let created = ensure_dir(&path)?;
    probe_writable(&path)?;

    let free_bytes = available_bytes_for_path(&root);
    let warnings = collect_path_warnings(&root, free_bytes);

    Ok(EnsureDefaultMediaDirResult {
        kind,
        root: path_to_string(&root),
        path: path_to_string(&path),
        created,
        warnings,
    })
}

fn ensure_dir(path: &Path) -> Result<bool, DefaultMediaDirsError> {
    let existed = path.is_dir();
    fs::create_dir_all(path)?;
    if !path.is_dir() {
        return Err(DefaultMediaDirsError::Message(format!(
            "Konnte Ordner nicht anlegen: {}",
            path.display()
        )));
    }
    Ok(!existed)
}

fn probe_writable(dir: &Path) -> Result<(), DefaultMediaDirsError> {
    let probe = dir.join(".aero_write_probe");
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(DefaultMediaDirsError::Message(format!(
            "Ordner nicht beschreibbar ({}): {e}",
            dir.display()
        ))),
    }
}

fn user_videos_or_movies_dir() -> Result<PathBuf, DefaultMediaDirsError> {
    let user_dirs = UserDirs::new().ok_or_else(|| {
        DefaultMediaDirsError::Message("Benutzerordner konnte nicht ermittelt werden.".into())
    })?;
    if let Some(videos) = user_dirs.video_dir() {
        return Ok(videos.to_path_buf());
    }
    // Fallback: home/Videos or home/Movies
    let home = user_dirs.home_dir();
    #[cfg(target_os = "macos")]
    {
        Ok(home.join("Movies"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(home.join("Videos"))
    }
}

fn collect_path_warnings(root: &Path, free_bytes: Option<u64>) -> Vec<String> {
    let mut warnings = Vec::new();
    let path_str = path_to_string(root);
    if looks_like_cloud_path(&path_str) {
        warnings.push(
            "Der vorgeschlagene Pfad liegt unter einem Cloud-Sync-Ordner (OneDrive/iCloud/Dropbox). Große Video-Dateien können Probleme verursachen."
                .into(),
        );
    }
    if let Some(free) = free_bytes {
        if free < LOW_SPACE_BYTES {
            warnings.push(format!(
                "Weniger als 50 GB frei auf dem Zielvolume ({})",
                format_bytes(free)
            ));
        }
    }
    warnings
}

/// Path-segment heuristics for common sync roots (case-insensitive).
pub fn looks_like_cloud_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "onedrive",
        "icloud drive",
        "icloud~",
        "mobile documents",
        "com.apple.clouddocs",
        "dropbox",
        "google drive",
        "googledrive",
    ];
    NEEDLES.iter().any(|n| lower.contains(n))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn format_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.1} GB", b / GIB)
    } else if b >= MIB {
        format!("{:.0} MB", b / MIB)
    } else {
        format!("{bytes} B")
    }
}

fn available_bytes_for_path(path: &Path) -> Option<u64> {
    // Walk up until an existing ancestor is found (root may not exist yet).
    let mut cur = path.to_path_buf();
    loop {
        if cur.exists() {
            return disk_available_bytes(&cur);
        }
        if !cur.pop() {
            return disk_available_bytes(path);
        }
    }
}

#[cfg(windows)]
fn disk_available_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_for_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut free_total: u64 = 0;
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free_for_caller),
            Some(&mut total),
            Some(&mut free_total),
        )
        .ok()?;
    }
    Some(free_for_caller)
}

#[cfg(unix)]
fn disk_available_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut stat) != 0 {
            return None;
        }
        Some(stat.f_bavail as u64 * stat.f_frsize as u64)
    }
}

#[cfg(not(any(windows, unix)))]
fn disk_available_bytes(_path: &Path) -> Option<u64> {
    None
}

/// Prefer a fixed non-system volume with substantially more free space (Windows).
fn find_preferred_alternate_root(primary_free: Option<u64>) -> Option<(PathBuf, u64)> {
    let candidates = list_alternate_fixed_roots();
    let primary = primary_free.unwrap_or(0);
    candidates
        .into_iter()
        .filter_map(|root| {
            let free = available_bytes_for_path(&root)?;
            if free >= primary.saturating_add(ALTERNATE_EXTRA_BYTES) {
                Some((root, free))
            } else {
                None
            }
        })
        .max_by_key(|(_, free)| *free)
}

#[cfg(windows)]
fn list_alternate_fixed_roots() -> Vec<PathBuf> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    use windows::Win32::System::WindowsProgramming::DRIVE_FIXED;

    let system_drive = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".into())
        .trim()
        .to_ascii_uppercase();
    // Normalize to drive letter only ("C").
    let system_letter = system_drive.chars().next().unwrap_or('C');

    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        if letter.eq_ignore_ascii_case(&system_letter) {
            continue;
        }
        let root = format!(r"{letter}:\");
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let dtype = unsafe { GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) };
        if dtype != DRIVE_FIXED {
            continue;
        }
        out.push(PathBuf::from(root).join(APP_MEDIA_ROOT_NAME));
    }
    out
}

#[cfg(not(windows))]
fn list_alternate_fixed_roots() -> Vec<PathBuf> {
    // Best-effort: ignore network-ish mounts; only suggest obvious data mounts.
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    {
        if let Ok(entries) = fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.eq_ignore_ascii_case("Macintosh HD")
                    || name_str.starts_with('.')
                {
                    continue;
                }
                let p = entry.path();
                if p.is_dir() {
                    out.push(p.join(APP_MEDIA_ROOT_NAME));
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for base in ["/mnt", "/media"] {
            let Ok(entries) = fs::read_dir(base) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    // /media/<user>/<vol> or /mnt/<vol>
                    if let Ok(inner) = fs::read_dir(&p) {
                        let children: Vec<_> = inner.flatten().map(|e| e.path()).collect();
                        if children.iter().any(|c| c.is_dir())
                            && p.components().count() <= 4
                        {
                            for child in children {
                                if child.is_dir() {
                                    out.push(child.join(APP_MEDIA_ROOT_NAME));
                                }
                            }
                        } else {
                            out.push(p.join(APP_MEDIA_ROOT_NAME));
                        }
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn paths_under_root_layout() {
        let root = PathBuf::from("/tmp/AeroTandemStudio");
        let (s, b) = paths_under_root(&root);
        assert!(s.ends_with("Erstellt"));
        assert!(b.ends_with("SD-Backups"));
        assert_eq!(s.parent(), b.parent());
    }

    #[test]
    fn cloud_path_detection() {
        assert!(looks_like_cloud_path(r"C:\Users\x\OneDrive\Videos\AeroTandemStudio"));
        assert!(looks_like_cloud_path("/Users/x/Library/Mobile Documents/com~apple~CloudDocs"));
        assert!(looks_like_cloud_path("/home/x/Dropbox/Videos/AeroTandemStudio"));
        assert!(looks_like_cloud_path("/home/x/Google Drive/foo"));
        assert!(!looks_like_cloud_path(r"D:\AeroTandemStudio"));
        assert!(!looks_like_cloud_path("/home/x/Videos/AeroTandemStudio"));
    }

    #[test]
    fn ensure_creates_one_dir_per_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(APP_MEDIA_ROOT_NAME);
        let speicher = ensure_default_media_dir(DefaultMediaDirKind::Speicherort, Some(&root))
            .unwrap();
        assert!(PathBuf::from(&speicher.path).is_dir());
        assert!(speicher.created);
        assert!(speicher.path.ends_with("Erstellt") || speicher.path.contains("Erstellt"));
        assert!(!root.join(SD_BACKUPS_DIR).exists());

        let backup =
            ensure_default_media_dir(DefaultMediaDirKind::SdBackupFolder, Some(&root)).unwrap();
        assert!(PathBuf::from(&backup.path).is_dir());
        assert!(backup.created);
        assert!(backup.path.contains("SD-Backups"));

        let again =
            ensure_default_media_dir(DefaultMediaDirKind::Speicherort, Some(&root)).unwrap();
        assert!(!again.created);
        assert_eq!(again.path, speicher.path);
    }

    #[test]
    fn media_root_override_rejects_empty() {
        let err = media_root_from_override(Some(Path::new(""))).unwrap_err();
        assert!(matches!(err, DefaultMediaDirsError::Message(_)));
    }

    #[test]
    fn propose_returns_consistent_siblings() {
        let p = propose_default_media_dirs().unwrap();
        assert!(p.root.ends_with(APP_MEDIA_ROOT_NAME) || p.root.contains(APP_MEDIA_ROOT_NAME));
        assert!(p.speicherort.ends_with(ERSTELLT_DIR) || p.speicherort.contains(ERSTELLT_DIR));
        assert!(
            p.sd_backup_folder.ends_with(SD_BACKUPS_DIR)
                || p.sd_backup_folder.contains(SD_BACKUPS_DIR)
        );
        let speicher_parent = PathBuf::from(&p.speicherort).parent().map(PathBuf::from);
        let backup_parent = PathBuf::from(&p.sd_backup_folder).parent().map(PathBuf::from);
        assert_eq!(speicher_parent, backup_parent);
        assert_eq!(speicher_parent.map(|x| path_to_string(&x)), Some(p.root.clone()));
    }

    #[test]
    fn format_bytes_smoke() {
        assert!(format_bytes(5 * 1024 * 1024 * 1024).contains("GB"));
        assert!(format_bytes(20 * 1024 * 1024).contains("MB"));
    }
}
