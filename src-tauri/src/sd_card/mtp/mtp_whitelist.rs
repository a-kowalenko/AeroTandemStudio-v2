//! MTP model whitelist (Phase 23.2g) — opt-in per camera model and platform.
//!
//! Default: volume/SD only. MTP is enabled only for models explicitly allowed here
//! (typically GoPro HERO 5+ without mass-storage volume).

use super::allowlist::{UsbDeviceHint, GOPRO_VID};

/// Global USB import strategy (Settings → SD).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UsbImportMode {
    /// Whitelist gate + volume dedup (recommended).
    #[default]
    Auto,
    /// Never surface MTP sources (DJI Osmo / card-reader workflow).
    VolumeOnly,
    /// Any detected action cam may use MTP (legacy / escape hatch).
    MtpPreferred,
}

impl UsbImportMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "volume_only" | "volume" => Self::VolumeOnly,
            "mtp_preferred" | "mtp" => Self::MtpPreferred,
            _ => Self::Auto,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::VolumeOnly => "volume_only",
            Self::MtpPreferred => "mtp_preferred",
        }
    }
}

fn mtp_platform_enabled() -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// GoPro HERO generation ≥ 5 (MTP). HERO3/4 use MSC / volume.
fn gopro_hero5_plus_mtp_product(upper_name: &str) -> bool {
    let Some(idx) = upper_name.find("HERO") else {
        return false;
    };
    let rest = &upper_name[idx + 4..];
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits
        .parse::<u32>()
        .ok()
        .is_some_and(|n| (5..=99).contains(&n))
}

/// True when this USB identity is explicitly whitelisted for MTP on the current OS.
///
/// Maintained list (add entries after hardware acceptance):
/// - GoPro HERO 5–13 (`verified: 2026-03`, macOS ICA + Windows WPD)
/// - GoPro MAX / FUSION
/// - DJI Osmo Action: **not** listed — MSC / volume after „File Transfer“
pub fn is_mtp_whitelisted(hint: &UsbDeviceHint) -> bool {
    if !mtp_platform_enabled() {
        return false;
    }
    if hint.vid != Some(GOPRO_VID) {
        return false;
    }
    let name = hint.friendly_name.trim();
    if name.is_empty() {
        return false;
    }
    let upper = name.to_ascii_uppercase();
    if upper.contains("MAX") || upper.contains("FUSION") {
        return true;
    }
    gopro_hero5_plus_mtp_product(&upper)
}

/// Whether this detected camera may use the MTP import path.
pub fn may_use_mtp_path(hint: &UsbDeviceHint, mode: UsbImportMode) -> bool {
    match mode {
        UsbImportMode::VolumeOnly => false,
        UsbImportMode::MtpPreferred => true,
        UsbImportMode::Auto => is_mtp_whitelisted(hint),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::allowlist::DJI_VID;

    fn hint(vid: Option<u16>, name: &str) -> UsbDeviceHint {
        UsbDeviceHint {
            vid,
            pid: None,
            friendly_name: name.into(),
        }
    }

    #[test]
    fn gopro_hero13_whitelisted() {
        assert!(is_mtp_whitelisted(&hint(Some(GOPRO_VID), "HERO13 Black")));
    }

    #[test]
    fn gopro_hero8_whitelisted() {
        assert!(is_mtp_whitelisted(&hint(Some(GOPRO_VID), "HERO8 BLACK")));
    }

    #[test]
    fn gopro_hero3_not_whitelisted() {
        assert!(!is_mtp_whitelisted(&hint(Some(GOPRO_VID), "HERO3+")));
    }

    #[test]
    fn dji_osmo_not_whitelisted() {
        assert!(!is_mtp_whitelisted(&hint(Some(DJI_VID), "OsmoAction4")));
    }

    #[test]
    fn gopro_max_whitelisted() {
        assert!(is_mtp_whitelisted(&hint(Some(GOPRO_VID), "GoPro MAX")));
    }

    #[test]
    fn import_mode_volume_only_blocks() {
        assert!(!may_use_mtp_path(
            &hint(Some(GOPRO_VID), "HERO13 Black"),
            UsbImportMode::VolumeOnly
        ));
    }

    #[test]
    fn import_mode_mtp_preferred_allows_dji() {
        assert!(may_use_mtp_path(
            &hint(Some(DJI_VID), "OsmoAction4"),
            UsbImportMode::MtpPreferred
        ));
    }

    #[test]
    fn parse_import_mode() {
        assert_eq!(UsbImportMode::parse("volume_only"), UsbImportMode::VolumeOnly);
        assert_eq!(UsbImportMode::parse("auto"), UsbImportMode::Auto);
        assert_eq!(UsbImportMode::parse(""), UsbImportMode::Auto);
    }
}
