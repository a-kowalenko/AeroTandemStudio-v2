//! Locate an mpv binary / libmpv for the optional player backend.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct MpvAvailability {
    /// True when a usable mpv binary was found (IPC backend can start).
    pub available: bool,
    /// `"ipc"` | `"none"`
    pub backend: String,
    /// Absolute path to the mpv executable when available.
    pub mpv_path: Option<String>,
    /// Absolute path to libmpv when discoverable (informational / future embed).
    pub libmpv_path: Option<String>,
    /// Short human-readable status for logs / settings.
    pub detail: String,
}

/// Probe for mpv binary + optional libmpv dylib/so/dll.
pub fn mpv_availability(resource_dir: Option<&Path>) -> MpvAvailability {
    let libmpv_path = find_libmpv(resource_dir).map(|p| p.display().to_string());
    match find_mpv_binary(resource_dir) {
        Some(path) => {
            let version = probe_mpv_version(&path).unwrap_or_else(|| "unknown".into());
            MpvAvailability {
                available: true,
                backend: "ipc".into(),
                mpv_path: Some(path.display().to_string()),
                libmpv_path,
                detail: format!("mpv IPC ready ({version})"),
            }
        }
        None => MpvAvailability {
            available: false,
            backend: "none".into(),
            mpv_path: None,
            libmpv_path,
            detail: "mpv not found — HTML5 fallback".into(),
        },
    }
}

/// Search order mirrors FFmpeg sidecar layout, then PATH / common installs.
pub fn find_mpv_binary(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    for relative in platform_relative_mpv_candidates() {
        if let Some(dir) = resource_dir {
            candidates.push(dir.join(&relative));
            candidates.push(dir.join("resources").join(&relative));
            candidates.push(dir.join("mpv").join(platform_subdir()).join(platform_binary_name()));
        }
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push(manifest.join("resources").join(&relative));
    }

    // Next to the running executable (dev / bundled).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(platform_binary_name()));
            candidates.push(
                parent
                    .join("resources")
                    .join("mpv")
                    .join(platform_subdir())
                    .join(platform_binary_name()),
            );
        }
    }

    // Common package-manager locations (dev machines).
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/mpv"));
        candidates.push(PathBuf::from("/usr/local/bin/mpv"));
    }
    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr/bin/mpv"));
        candidates.push(PathBuf::from("/usr/local/bin/mpv"));
    }
    #[cfg(windows)]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(pf).join("mpv").join("mpv.exe"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("mpv").join("mpv.exe"));
        }
    }

    // PATH lookup last.
    if let Some(path_os) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_os) {
            candidates.push(dir.join(platform_binary_name()));
        }
    }

    candidates.into_iter().find(|p| is_usable_binary(p))
}

pub fn find_libmpv(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let names = platform_libmpv_names();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(dir) = resource_dir {
        for name in &names {
            candidates.push(dir.join("lib").join(name));
            candidates.push(dir.join("mpv").join(platform_subdir()).join(name));
            candidates.push(dir.join("resources").join("mpv").join(platform_subdir()).join(name));
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for name in &names {
        candidates.push(manifest.join("lib").join(name));
        candidates.push(
            manifest
                .join("resources")
                .join("mpv")
                .join(platform_subdir())
                .join(name),
        );
    }

    #[cfg(target_os = "macos")]
    {
        for name in &names {
            candidates.push(PathBuf::from("/opt/homebrew/lib").join(name));
            candidates.push(PathBuf::from("/usr/local/lib").join(name));
        }
    }
    #[cfg(target_os = "linux")]
    {
        for name in &names {
            candidates.push(PathBuf::from("/usr/lib").join(name));
            candidates.push(PathBuf::from("/usr/lib/x86_64-linux-gnu").join(name));
            candidates.push(PathBuf::from("/usr/local/lib").join(name));
        }
    }

    candidates.into_iter().find(|p| p.is_file())
}

fn probe_mpv_version(path: &Path) -> Option<String> {
    let output = Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

fn is_usable_binary(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = path.metadata() {
            if meta.permissions().mode() & 0o111 == 0 {
                return false;
            }
        }
    }
    true
}

fn platform_binary_name() -> &'static str {
    #[cfg(windows)]
    {
        "mpv.exe"
    }
    #[cfg(not(windows))]
    {
        "mpv"
    }
}

fn platform_subdir() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "win"
    }
    #[cfg(target_os = "macos")]
    {
        "mac"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}

fn platform_relative_mpv_candidates() -> Vec<PathBuf> {
    let bin = platform_binary_name();
    let mut out = vec![
        PathBuf::from("mpv").join(platform_subdir()).join(bin),
        PathBuf::from("mpv").join(bin),
    ];
    #[cfg(target_os = "macos")]
    {
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        // Flattened sidecar: mac/<arch>/mpv + mac/<arch>/lib/ (@executable_path).
        // Also accept a vendored mpv.app if someone places one manually.
        out.insert(0, PathBuf::from("mpv").join("mac").join(arch).join(bin));
        out.insert(
            1,
            PathBuf::from("mpv")
                .join("mac")
                .join(arch)
                .join("mpv.app")
                .join("Contents")
                .join("MacOS")
                .join(bin),
        );
        out.insert(
            2,
            PathBuf::from("mpv")
                .join("mac")
                .join("mpv.app")
                .join("Contents")
                .join("MacOS")
                .join(bin),
        );
    }
    #[cfg(target_os = "linux")]
    {
        let arch = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x86_64"
        };
        out.insert(
            0,
            PathBuf::from("mpv").join("linux").join(arch).join(bin),
        );
    }
    out
}

fn platform_libmpv_names() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec!["libmpv-2.dll", "mpv-2.dll", "libmpv-1.dll"]
    }
    #[cfg(target_os = "macos")]
    {
        vec!["libmpv.dylib", "libmpv.2.dylib", "libmpv.1.dylib"]
    }
    #[cfg(target_os = "linux")]
    {
        vec![
            "libmpv.so.2",
            "libmpv.so.1",
            "libmpv.so",
        ]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn availability_never_panics() {
        let a = mpv_availability(None);
        assert!(a.backend == "ipc" || a.backend == "none");
        if a.available {
            assert!(a.mpv_path.is_some());
            assert_eq!(a.backend, "ipc");
        } else {
            assert!(a.detail.contains("HTML5"));
        }
    }

    #[test]
    fn relative_candidates_non_empty() {
        assert!(!platform_relative_mpv_candidates().is_empty());
    }
}
