//! Linux HTML5 `<video>` depends on WebKitGTK → GStreamer codecs.
//!
//! Without `gstreamer1.0-plugins-*` / `gstreamer1.0-libav`, every clip fails with
//! `MEDIA_ERR_SRC_NOT_SUPPORTED` (SD hover preview and main VideoPlayer alike).
//! AppImage `bundleMediaFramework` only packs plugins present on the *build* host
//! and sets `GST_PLUGIN_SYSTEM_PATH_1_0` / `APPDIR` — `gst-inspect-1.0` is often
//! *not* on PATH even when playback works.

/// Result of probing whether WebKitGTK can likely decode H.264/MP4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinuxMediaStatus {
    Ok,
    /// Soft warning — playback may fail until packages are installed / AppImage rebuilt.
    #[allow(dead_code)] // constructed only on Linux
    Warning(String),
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const APT_HINT: &str = "sudo apt install -y gstreamer1.0-plugins-base \
gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav gstreamer1.0-tools";

/// Probe GStreamer for a usable H.264 decoder (Linux only; always Ok elsewhere).
pub fn check_linux_media_playback() -> LinuxMediaStatus {
    #[cfg(not(target_os = "linux"))]
    {
        LinuxMediaStatus::Ok
    }

    #[cfg(target_os = "linux")]
    {
        check_linux_media_playback_inner()
    }
}

#[cfg(target_os = "linux")]
mod linux_impl {
    use super::{LinuxMediaStatus, APT_HINT};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    /// H.264 decoder element names commonly provided by good/bad/libav/hardware plugins.
    const H264_DECODERS: &[&str] = &[
        "avdec_h264",
        "openh264dec",
        "vaapih264dec",
        "nvh264dec",
        "v4l2h264dec",
    ];

    /// Plugin `.so` basenames that typically ship an H.264 decoder (AppImage / distro).
    const H264_PLUGIN_FILES: &[&str] = &[
        "libgstlibav.so",
        "libgstopenh264.so",
        "libgstvaapi.so",
        "libgstva.so",
        "libgstnvcodec.so",
        "libgstv4l2.so",
        "libgstmsdk.so",
    ];

    pub(super) fn check_linux_media_playback_inner() -> LinuxMediaStatus {
        // AppImage / bundled media: plugins are on disk + env, but gst-inspect may be absent.
        if plugin_dirs_have_h264() {
            return LinuxMediaStatus::Ok;
        }

        if gst_inspect_available() {
            if !gst_element_exists("playbin") && !gst_element_exists("decodebin") {
                return LinuxMediaStatus::Warning(format!(
                    "GStreamer-Basisplugins fehlen — Video-Wiedergabe nicht möglich. Installieren: {APT_HINT}"
                ));
            }

            if H264_DECODERS.iter().any(|name| gst_element_exists(name)) {
                return LinuxMediaStatus::Ok;
            }

            return LinuxMediaStatus::Warning(format!(
                "Kein H.264-Decoder in GStreamer gefunden — MP4-Vorschau bleibt schwarz. Installieren: {APT_HINT}"
            ));
        }

        // No gst-inspect and no recognizable plugin files — still warn (dev install / incomplete host).
        LinuxMediaStatus::Warning(format!(
            "GStreamer-Codecs nicht gefunden — Video-Wiedergabe kann fehlschlagen. Installieren: {APT_HINT}"
        ))
    }

    fn plugin_dirs_have_h264() -> bool {
        for dir in gstreamer_plugin_dirs() {
            if dir_has_h264_plugin(&dir) {
                return true;
            }
        }
        false
    }

    fn dir_has_h264_plugin(dir: &Path) -> bool {
        if !dir.is_dir() {
            return false;
        }
        H264_PLUGIN_FILES.iter().any(|name| dir.join(name).is_file())
    }

    fn gstreamer_plugin_dirs() -> Vec<PathBuf> {
        let mut dirs = Vec::new();

        for key in [
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "GST_PLUGIN_PATH_1_0",
            "GST_PLUGIN_PATH",
            "GST_PLUGIN_SYSTEM_PATH",
        ] {
            if let Ok(raw) = std::env::var(key) {
                for part in raw.split(':').filter(|s| !s.is_empty()) {
                    dirs.push(PathBuf::from(part));
                }
            }
        }

        if let Ok(appdir) = std::env::var("APPDIR") {
            let app = PathBuf::from(appdir);
            dirs.push(app.join("usr/lib/gstreamer-1.0"));
            dirs.push(app.join("usr/lib/x86_64-linux-gnu/gstreamer-1.0"));
            dirs.push(app.join("usr/lib/aarch64-linux-gnu/gstreamer-1.0"));
        }

        // Common distro locations (multiarch).
        for candidate in [
            "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
            "/usr/lib/aarch64-linux-gnu/gstreamer-1.0",
            "/usr/lib/gstreamer-1.0",
            "/usr/lib64/gstreamer-1.0",
            "/usr/local/lib/gstreamer-1.0",
        ] {
            dirs.push(PathBuf::from(candidate));
        }

        dirs.sort();
        dirs.dedup();
        dirs
    }

    fn gst_inspect_available() -> bool {
        // Prefer PATH; AppImage may ship a scanner but not gst-inspect.
        if Command::new("gst-inspect-1.0")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return true;
        }

        // Bundled helper next to plugin scanner (rare).
        for dir in gstreamer_plugin_dirs() {
            let parent = dir.parent().unwrap_or(Path::new("/"));
            for rel in [
                "gstreamer1.0/gstreamer-1.0/gst-inspect-1.0",
                "../bin/gst-inspect-1.0",
                "gst-inspect-1.0",
            ] {
                let cand = parent.join(rel);
                if cand.is_file()
                    && Command::new(&cand)
                        .arg("--version")
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false)
                {
                    return true;
                }
            }
        }

        false
    }

    fn gst_element_exists(name: &str) -> bool {
        // Prefer --exists when available (quiet); fall back to inspecting the element.
        let exists_flag = Command::new("gst-inspect-1.0")
            .args(["--exists", name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if let Ok(status) = exists_flag {
            // Older gst-inspect may not support --exists (non-zero for unknown flag).
            // Only trust success; on failure try a normal inspect.
            if status.success() {
                return true;
            }
        }
        Command::new("gst-inspect-1.0")
            .arg(name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

#[cfg(target_os = "linux")]
use linux_impl::check_linux_media_playback_inner;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_linux_always_ok() {
        #[cfg(not(target_os = "linux"))]
        assert_eq!(check_linux_media_playback(), LinuxMediaStatus::Ok);
    }

    #[test]
    fn apt_hint_mentions_libav() {
        assert!(APT_HINT.contains("gstreamer1.0-libav"));
        assert!(APT_HINT.contains("gstreamer1.0-plugins-good"));
    }

    #[test]
    fn h264_plugin_file_names_look_plausible() {
        // Keep names aligned with distro / AppImage packaging.
        for n in [
            "libgstlibav.so",
            "libgstopenh264.so",
            "libgstvaapi.so",
            "libgstva.so",
            "libgstnvcodec.so",
            "libgstv4l2.so",
            "libgstmsdk.so",
        ] {
            assert!(n.starts_with("libgst"));
            assert!(n.ends_with(".so"));
        }
    }
}
