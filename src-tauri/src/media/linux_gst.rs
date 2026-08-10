//! Linux HTML5 `<video>` depends on WebKitGTK → GStreamer codecs.
//!
//! Without `gstreamer1.0-plugins-*` / `gstreamer1.0-libav`, every clip fails with
//! `MEDIA_ERR_SRC_NOT_SUPPORTED` (SD hover preview and main VideoPlayer alike).
//! AppImage `bundleMediaFramework` only packs plugins present on the *build* host.

/// Result of probing whether WebKitGTK can likely decode H.264/MP4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinuxMediaStatus {
    Ok,
    /// Soft warning — playback may fail until packages are installed / AppImage rebuilt.
    #[allow(dead_code)] // constructed only on Linux
    Warning(String),
}

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
    use std::process::{Command, Stdio};

    /// H.264 decoder element names commonly provided by good/bad/libav/hardware plugins.
    const H264_DECODERS: &[&str] = &[
        "avdec_h264",
        "openh264dec",
        "vaapih264dec",
        "nvh264dec",
        "v4l2h264dec",
    ];

    pub(super) fn check_linux_media_playback_inner() -> LinuxMediaStatus {
        if !gst_inspect_available() {
            return LinuxMediaStatus::Warning(format!(
                "GStreamer nicht gefunden — Video-Wiedergabe in der App funktioniert nicht. Installieren: {APT_HINT}"
            ));
        }

        if !gst_element_exists("playbin") && !gst_element_exists("decodebin") {
            return LinuxMediaStatus::Warning(format!(
                "GStreamer-Basisplugins fehlen — Video-Wiedergabe nicht möglich. Installieren: {APT_HINT}"
            ));
        }

        if H264_DECODERS.iter().any(|name| gst_element_exists(name)) {
            return LinuxMediaStatus::Ok;
        }

        LinuxMediaStatus::Warning(format!(
            "Kein H.264-Decoder in GStreamer gefunden — MP4-Vorschau bleibt schwarz. Installieren: {APT_HINT}"
        ))
    }

    fn gst_inspect_available() -> bool {
        Command::new("gst-inspect-1.0")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
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
}
