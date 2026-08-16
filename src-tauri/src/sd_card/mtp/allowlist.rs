//! Strict USB/MTP allowlist for action cams (Phase 23).
//!
//! Match rule: `(known VID OR friendly-name hint) AND content signature`.
//! Never accept arbitrary MTP devices that merely have a DCIM folder.
//!
//! VIDs / known PIDs sourced primarily from libmtp `music-players.h` and
//! public USB ID databases. Unknown PIDs under an allowlisted VID still match
//! when the DCIM content signature succeeds (covers newer Hero / Osmo / X models).

use std::path::Path;

/// GoPro, Inc.
pub const GOPRO_VID: u16 = 0x2672;
/// DJI Technology Co., Ltd. (also remotes/goggles — content signature required).
pub const DJI_VID: u16 = 0x2CA3;
/// Arashi Vision Inc. (Insta360).
pub const INSTA360_VID: u16 = 0x2E1A;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionCamVendor {
    GoPro,
    Dji,
    Insta360,
}

impl ActionCamVendor {
    pub fn slug(self) -> &'static str {
        match self {
            Self::GoPro => "gopro",
            Self::Dji => "dji",
            Self::Insta360 => "insta360",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::GoPro => "GoPro",
            Self::Dji => "DJI",
            Self::Insta360 => "Insta360",
        }
    }

    pub fn vid(self) -> u16 {
        match self {
            Self::GoPro => GOPRO_VID,
            Self::Dji => DJI_VID,
            Self::Insta360 => INSTA360_VID,
        }
    }
}

/// Optional USB identity from the OS (WPD / libusb / Image Capture).
#[derive(Debug, Clone, Default)]
pub struct UsbDeviceHint {
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    /// Friendly / product name from the OS (e.g. "GoPro MTP", "HERO11 Black").
    pub friendly_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbMatch {
    pub vendor: ActionCamVendor,
    /// Best-effort model label for UI (may be empty).
    pub model_label: String,
}

/// Known GoPro PIDs → model label (non-exhaustive; newer PIDs rely on VID + signature).
const GOPRO_PIDS: &[(u16, &str)] = &[
    (0x0004, "HERO3"),
    (0x0006, "HERO3+ Silver"),
    (0x0007, "HERO3+ Black"),
    (0x000C, "HERO"),
    (0x000D, "HERO4 Silver"),
    (0x000E, "HERO4 Black"),
    (0x000F, "HERO4 Session"),
    (0x0011, "HERO3+ Black"),
    (0x0021, "HERO+"),
    (0x0027, "HERO5 Black"),
    (0x0029, "HERO5 Session"),
    (0x002D, "HERO 2018"),
    (0x0032, "FUSION"),
    (0x0035, "FUSION"),
    (0x0037, "HERO6 Black"),
    (0x0042, "HERO7 White"),
    (0x0043, "HERO7 Silver"),
    (0x0047, "HERO7 Black"),
    (0x0049, "HERO8 Black"),
    (0x004B, "MAX"),
    (0x004D, "HERO9 Black"),
    (0x0056, "HERO10 Black"),
    // 0x0059 is reused by HERO11 Black *and* HERO13 Black — do not trust alone.
    (0x0059, "HERO11 Black"),
    (0x005A, "HERO11 Black Mini"),
    // HERO12+ : prefer USB product / profiler name; add confirmed unique PIDs when known.
];

/// PIDs GoPro has recycled across generations — prefer friendly name over this table.
fn is_ambiguous_gopro_pid(pid: u16) -> bool {
    matches!(pid, 0x0059)
}

/// Sparse DJI PIDs — most Osmo/Action devices are accepted via VID + DJI media signature.
const DJI_PIDS: &[(u16, &str)] = &[
    // Controllers / goggles (documented so we never treat PID alone as camera).
    (0x0008, "Remote Controller"),
    (0x0020, "Goggles"),
    (0x1021, "Controller 2"),
];

/// Sparse Insta360 PIDs (Arashi). U-Disk mode often uses mass storage instead of MTP.
const INSTA360_PIDS: &[(u16, &str)] = &[
    (0x4C01, "Link"), // webcam-class; not a media source — signature will reject
];

pub fn vendor_for_vid(vid: u16) -> Option<ActionCamVendor> {
    match vid {
        GOPRO_VID => Some(ActionCamVendor::GoPro),
        DJI_VID => Some(ActionCamVendor::Dji),
        INSTA360_VID => Some(ActionCamVendor::Insta360),
        _ => None,
    }
}

fn vendor_from_friendly_name(name: &str) -> Option<ActionCamVendor> {
    let n = name.to_ascii_lowercase();
    if n.contains("gopro") {
        return Some(ActionCamVendor::GoPro);
    }
    // "dji" as token / prefix — avoid matching unrelated strings.
    if n.contains("dji") || n.contains("osmo") {
        return Some(ActionCamVendor::Dji);
    }
    if n.contains("insta360") || n.contains("insta 360") || n.contains("arashi") {
        return Some(ActionCamVendor::Insta360);
    }
    None
}

fn model_label_for(vendor: ActionCamVendor, pid: Option<u16>, friendly: &str) -> String {
    let trimmed = friendly.trim();

    // Prefer a specific USB / system_profiler product name (e.g. "HERO13 Black").
    // GoPro reuses PIDs across generations (HERO11 and HERO13 both use 0x0059).
    if let Some(specific) = specific_model_from_friendly_name(vendor, trimmed) {
        return specific;
    }

    if let Some(pid) = pid {
        let table = match vendor {
            ActionCamVendor::GoPro => GOPRO_PIDS,
            ActionCamVendor::Dji => DJI_PIDS,
            ActionCamVendor::Insta360 => INSTA360_PIDS,
        };
        if let Some((_, label)) = table.iter().find(|(p, _)| *p == pid) {
            let trust_pid = match vendor {
                ActionCamVendor::GoPro => !is_ambiguous_gopro_pid(pid),
                _ => true,
            };
            if trust_pid {
                return (*label).to_string();
            }
            // Ambiguous PID + non-specific name → generic vendor label, not a wrong generation.
            if useful_friendly_name(trimmed) {
                return trimmed.to_string();
            }
            return vendor.display_name().to_string();
        }
    }

    if useful_friendly_name(trimmed) {
        return trimmed.to_string();
    }
    String::new()
}

fn useful_friendly_name(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    !n.is_empty()
        && !matches!(
            n.as_str(),
            "mtp" | "ptp" | "portable device" | "usb device"
        )
}

/// When the OS product string names a concrete model, use it over the PID table.
fn specific_model_from_friendly_name(vendor: ActionCamVendor, name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let n = trimmed.to_ascii_lowercase();
    match vendor {
        ActionCamVendor::GoPro => {
            // "HERO13 Black", "HERO 8", "GoPro HERO11 Black", "MAX", "FUSION", …
            let has_hero_gen = n.contains("hero")
                && n.chars().any(|c| c.is_ascii_digit());
            if has_hero_gen || n.contains("max") || n.contains("fusion") {
                Some(trimmed.to_string())
            } else {
                None
            }
        }
        ActionCamVendor::Dji => {
            if n.contains("osmo") || n.contains("action") || n.contains("pocket") {
                Some(trimmed.to_string())
            } else {
                None
            }
        }
        ActionCamVendor::Insta360 => {
            if n.contains("insta") || n.contains("x3") || n.contains("x4") || n.contains("x5") {
                Some(trimmed.to_string())
            } else {
                None
            }
        }
    }
}

/// True when `dcim_root` looks like GoPro / DJI Action / Insta360 media (not a phone dump).
///
/// `dcim_root` should be the `DCIM` directory (or a synthetic tree root used in tests).
pub fn content_looks_like_action_cam(dcim_root: &Path, vendor: ActionCamVendor) -> bool {
    match vendor {
        ActionCamVendor::GoPro => dcim_has_gopro_signature(dcim_root),
        ActionCamVendor::Dji => dcim_has_dji_signature(dcim_root),
        ActionCamVendor::Insta360 => dcim_has_insta360_signature(dcim_root),
    }
}

fn dcim_has_gopro_signature(dcim: &Path) -> bool {
    if !dcim.is_dir() {
        return false;
    }
    // Folder names: 100GOPRO, 101GOPRO, …
    if dir_children_match(dcim, |name| {
        let u = name.to_ascii_uppercase();
        u.contains("GOPRO")
    }) {
        return true;
    }
    // Files anywhere under DCIM (shallow walk).
    walk_media_names(dcim, 3, |name| {
        let u = name.to_ascii_uppercase();
        // GX010001.MP4, GH010001.MP4, GPFR*.MP4, GOPR*.JPG, …
        u.starts_with("GX")
            || u.starts_with("GH")
            || u.starts_with("GOPR")
            || u.starts_with("GPFR")
            || u.starts_with("GPBK")
            || (u.starts_with("GP") && u.len() > 2 && u.as_bytes()[2].is_ascii_digit())
    })
}

fn dcim_has_dji_signature(dcim: &Path) -> bool {
    if !dcim.is_dir() {
        return false;
    }
    walk_media_names(dcim, 3, |name| {
        let u = name.to_ascii_uppercase();
        u.starts_with("DJI_")
            || (u.starts_with("DJI") && u.contains('.'))
            || u.starts_with("OSMO")
    })
}

fn dcim_has_insta360_signature(dcim: &Path) -> bool {
    if !dcim.is_dir() {
        return false;
    }
    walk_media_names(dcim, 3, |name| {
        let lower = name.to_ascii_lowercase();
        lower.ends_with(".insv")
            || lower.ends_with(".lrv")
            || lower.ends_with(".insp")
            || lower.starts_with("vid_")
            || lower.starts_with("img_")
            || lower.starts_with("pro_")
    })
}

fn dir_children_match(dir: &Path, pred: impl Fn(&str) -> bool) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if pred(name) {
                return true;
            }
        }
    }
    false
}

fn walk_media_names(root: &Path, max_depth: u32, pred: impl Fn(&str) -> bool + Copy) -> bool {
    fn walk(dir: &Path, depth: u32, max_depth: u32, pred: impl Fn(&str) -> bool + Copy) -> bool {
        if depth > max_depth {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = entry.file_name().to_str() {
                if pred(name) {
                    return true;
                }
            }
            if path.is_dir() && walk(&path, depth + 1, max_depth, pred) {
                return true;
            }
        }
        false
    }
    walk(root, 0, max_depth, pred)
}

/// Decide whether USB identity alone looks like an allowlisted action cam.
///
/// Used for hotplug detection when DCIM is not yet readable (macOS Image Capture /
/// Windows WPD before browsing). DJI requires a camera-like friendly name because
/// the same VID is shared with remotes and goggles.
pub fn match_usb_identity(hint: &UsbDeviceHint) -> Option<UsbMatch> {
    let vendor = hint
        .vid
        .and_then(vendor_for_vid)
        .or_else(|| vendor_from_friendly_name(&hint.friendly_name))?;

    if vendor == ActionCamVendor::Dji {
        let n = hint.friendly_name.to_ascii_lowercase();
        let camera_like = n.contains("osmo")
            || n.contains("action")
            || n.contains("pocket")
            || n.contains("camera")
            || n.contains("ac103")
            || n.contains("ac202");
        if !camera_like {
            return None;
        }
    }

    Some(UsbMatch {
        vendor,
        model_label: model_label_for(vendor, hint.pid, &hint.friendly_name),
    })
}

/// Decide whether a USB/MTP device is an allowlisted action cam.
///
/// `dcim_root` is required: without a readable DCIM tree the device is rejected
/// (protects DJI remotes/goggles and phones that share marketing names).
pub fn match_usb_device(hint: &UsbDeviceHint, dcim_root: &Path) -> Option<UsbMatch> {
    let identity = match_usb_identity(hint)?;
    if !content_looks_like_action_cam(dcim_root, identity.vendor) {
        return None;
    }
    Some(identity)
}

/// Build opaque source id: `mtp:<slug>:<serial_or_hash>`.
pub fn mtp_source_id(vendor: ActionCamVendor, serial_or_hash: &str) -> String {
    let serial = serial_or_hash.trim();
    let safe: String = serial
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let safe = if safe.is_empty() {
        "unknown".to_string()
    } else {
        safe
    };
    format!("mtp:{}:{}", vendor.slug(), safe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn vids_map_to_vendors() {
        assert_eq!(vendor_for_vid(GOPRO_VID), Some(ActionCamVendor::GoPro));
        assert_eq!(vendor_for_vid(DJI_VID), Some(ActionCamVendor::Dji));
        assert_eq!(vendor_for_vid(INSTA360_VID), Some(ActionCamVendor::Insta360));
        assert_eq!(vendor_for_vid(0x18D1), None); // Google
        assert_eq!(vendor_for_vid(0x05AC), None); // Apple
    }

    #[test]
    fn friendly_name_hints() {
        assert_eq!(
            vendor_from_friendly_name("GoPro MTP Device"),
            Some(ActionCamVendor::GoPro)
        );
        assert_eq!(
            vendor_from_friendly_name("DJI Osmo Action"),
            Some(ActionCamVendor::Dji)
        );
        assert_eq!(
            vendor_from_friendly_name("Insta360 X4"),
            Some(ActionCamVendor::Insta360)
        );
        assert_eq!(vendor_from_friendly_name("Samsung Galaxy"), None);
        assert_eq!(vendor_from_friendly_name("iPhone"), None);
    }

    #[test]
    fn gopro_pid_labels() {
        // Unique PID still maps from the table when the name is empty.
        let label = model_label_for(ActionCamVendor::GoPro, Some(0x0049), "");
        assert_eq!(label, "HERO8 Black");
    }

    #[test]
    fn gopro_hero13_name_beats_shared_pid_0059() {
        // HERO13 Black reuses USB PID 0x0059 (same as HERO11).
        let label = model_label_for(
            ActionCamVendor::GoPro,
            Some(0x0059),
            "HERO13 Black",
        );
        assert_eq!(label, "HERO13 Black");

        let hint = UsbDeviceHint {
            vid: Some(GOPRO_VID),
            pid: Some(0x0059),
            friendly_name: "HERO13 Black".into(),
        };
        let m = match_usb_identity(&hint).unwrap();
        assert_eq!(m.model_label, "HERO13 Black");
    }

    #[test]
    fn gopro_ambiguous_pid_without_model_name_is_generic() {
        let label = model_label_for(ActionCamVendor::GoPro, Some(0x0059), "GoPro");
        assert_eq!(label, "GoPro");
        let empty = model_label_for(ActionCamVendor::GoPro, Some(0x0059), "");
        assert_eq!(empty, "GoPro");
    }

    #[test]
    fn gopro_signature_and_match() {
        let dir = tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("100GOPRO");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("GX010001.MP4"), b"x").unwrap();

        let hint = UsbDeviceHint {
            vid: Some(GOPRO_VID),
            pid: Some(0x0049),
            friendly_name: "GoPro".into(),
        };
        let m = match_usb_device(&hint, dir.path().join("DCIM").as_path()).unwrap();
        assert_eq!(m.vendor, ActionCamVendor::GoPro);
        assert_eq!(m.model_label, "HERO8 Black");
    }

    #[test]
    fn gopro_unknown_pid_still_matches_with_signature() {
        let dir = tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("101GOPRO");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("GH010099.MP4"), b"x").unwrap();

        let hint = UsbDeviceHint {
            vid: Some(GOPRO_VID),
            pid: Some(0x00FF), // unknown future PID
            friendly_name: String::new(),
        };
        assert!(match_usb_device(&hint, &dir.path().join("DCIM")).is_some());
    }

    #[test]
    fn dji_remote_without_media_rejected() {
        let dir = tempdir().unwrap();
        let dcim = dir.path().join("DCIM");
        fs::create_dir_all(&dcim).unwrap();

        let hint = UsbDeviceHint {
            vid: Some(DJI_VID),
            pid: Some(0x1021),
            friendly_name: "Controller 2".into(),
        };
        assert!(match_usb_device(&hint, &dcim).is_none());
    }

    #[test]
    fn dji_action_media_matches() {
        let dir = tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("100MEDIA");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("DJI_0001.MP4"), b"x").unwrap();

        let hint = UsbDeviceHint {
            vid: Some(DJI_VID),
            pid: None,
            friendly_name: "Osmo Action".into(),
        };
        let m = match_usb_device(&hint, &dir.path().join("DCIM")).unwrap();
        assert_eq!(m.vendor, ActionCamVendor::Dji);
    }

    #[test]
    fn insta360_insv_matches() {
        let dir = tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("Camera01");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("VID_20250101_120000_00_001.insv"), b"x").unwrap();

        let hint = UsbDeviceHint {
            vid: Some(INSTA360_VID),
            pid: None,
            friendly_name: "Insta360 X4".into(),
        };
        let m = match_usb_device(&hint, &dir.path().join("DCIM")).unwrap();
        assert_eq!(m.vendor, ActionCamVendor::Insta360);
    }

    #[test]
    fn phone_vid_rejected_even_with_dcim_photos() {
        let dir = tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("Camera");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("IMG_0001.JPG"), b"x").unwrap();

        let hint = UsbDeviceHint {
            vid: Some(0x18D1), // Google
            pid: Some(0x4EE2),
            friendly_name: "Pixel".into(),
        };
        assert!(match_usb_device(&hint, &dir.path().join("DCIM")).is_none());
    }

    #[test]
    fn gopro_vid_without_signature_rejected() {
        let dir = tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("Camera");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("IMG_0001.JPG"), b"x").unwrap();

        let hint = UsbDeviceHint {
            vid: Some(GOPRO_VID),
            pid: Some(0x0059),
            friendly_name: "GoPro".into(),
        };
        assert!(match_usb_device(&hint, &dir.path().join("DCIM")).is_none());
    }

    #[test]
    fn mtp_source_id_format() {
        assert_eq!(
            mtp_source_id(ActionCamVendor::GoPro, "ABC-123"),
            "mtp:gopro:ABC-123"
        );
        assert_eq!(
            mtp_source_id(ActionCamVendor::Dji, "x y/z"),
            "mtp:dji:x_y_z"
        );
        assert_eq!(
            mtp_source_id(ActionCamVendor::Insta360, "  "),
            "mtp:insta360:unknown"
        );
    }

    #[test]
    fn gopro_vid_alone_matches_identity() {
        let hint = UsbDeviceHint {
            vid: Some(GOPRO_VID),
            pid: Some(0x0049),
            friendly_name: String::new(),
        };
        let m = match_usb_identity(&hint).unwrap();
        assert_eq!(m.vendor, ActionCamVendor::GoPro);
        assert_eq!(m.model_label, "HERO8 Black");
    }

    #[test]
    fn dji_vid_alone_without_camera_name_rejected() {
        let hint = UsbDeviceHint {
            vid: Some(DJI_VID),
            pid: Some(0x1021),
            friendly_name: "Controller 2".into(),
        };
        assert!(match_usb_identity(&hint).is_none());
    }

    #[test]
    fn name_only_gopro_with_signature() {
        let dir = tempdir().unwrap();
        let dcim = dir.path().join("DCIM").join("100GOPRO");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("GX010001.MP4"), b"x").unwrap();

        let hint = UsbDeviceHint {
            vid: None,
            pid: None,
            friendly_name: "GoPro HERO10 Black".into(),
        };
        let m = match_usb_device(&hint, &dir.path().join("DCIM")).unwrap();
        assert_eq!(m.vendor, ActionCamVendor::GoPro);
    }
}
