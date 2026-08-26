//! Correlate allowlisted USB/MTP cameras with mounted DCIM volumes (Phase 23.2f/23.2g).
//!
//! Volume always wins when readable. MTP sources are gated by model whitelist (23.2g).

use std::collections::HashSet;
use std::path::Path;

use super::allowlist::{content_looks_like_action_cam, ActionCamVendor};
use super::mtp_whitelist::{may_use_mtp_path, UsbImportMode};
use super::usb_enumerate::DetectedUsbCamera;

/// Mounted volumes that are readable (no dependency on `monitor` — avoids cycles).
pub fn ready_volumes() -> HashSet<String> {
    #[cfg(windows)]
    {
        windows_ready_volumes()
    }
    #[cfg(target_os = "macos")]
    {
        macos_ready_volumes()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        HashSet::new()
    }
}

#[cfg(windows)]
fn windows_ready_volumes() -> HashSet<String> {
    use std::fs;
    let mut drives = HashSet::new();
    unsafe extern "system" {
        fn GetLogicalDrives() -> u32;
    }
    let mask = unsafe { GetLogicalDrives() };
    for (i, letter) in (b'A'..=b'Z').enumerate() {
        if mask & (1 << i) != 0 {
            let root = format!("{}:\\", letter as char);
            if fs::read_dir(&root).is_ok() {
                drives.insert(format!("{}:", letter as char));
            }
        }
    }
    drives
}

#[cfg(target_os = "macos")]
fn macos_ready_volumes() -> HashSet<String> {
    use std::fs;
    let mut drives = HashSet::new();
    if let Ok(entries) = fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let s = path.to_string_lossy().into_owned();
            if macos_volume_candidate(&s) && fs::read_dir(&path).is_ok() {
                drives.insert(s);
            }
        }
    }
    drives
}

#[cfg(target_os = "macos")]
fn macos_volume_candidate(path: &str) -> bool {
    let trimmed = path.trim_end_matches('/');
    let Some(name) = trimmed.strip_prefix("/Volumes/") else {
        return false;
    };
    if name.is_empty() || name.contains('/') {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        "macintosh hd"
            | "macintosh hd - data"
            | "mac hd"
    ) && !lower.starts_with("com.apple.timemachine.")
        && !lower.starts_with(".timemachine")
        && !lower.starts_with("backups of ")
}

/// Volumes whose DCIM tree matches the vendor signature.
pub fn volumes_matching_vendor(volumes: &HashSet<String>, vendor: ActionCamVendor) -> Vec<String> {
    let mut out: Vec<String> = volumes
        .iter()
        .filter(|v| volume_matches_vendor(v, vendor))
        .cloned()
        .collect();
    out.sort();
    out
}

fn volume_matches_vendor(volume: &str, vendor: ActionCamVendor) -> bool {
    let dcim = crate::media::dji_paths::resolve_drive_dcim_path(volume);
    let dcim = Path::new(&dcim);
    dcim.is_dir() && content_looks_like_action_cam(dcim, vendor)
}

/// When unambiguous (1 USB camera + 1 matching volume for that vendor), return the volume.
pub fn volume_for_usb_camera(
    volumes: &HashSet<String>,
    cam: &DetectedUsbCamera,
    attached: &[DetectedUsbCamera],
) -> Option<String> {
    let vols = volumes_matching_vendor(volumes, cam.matched.vendor);
    if vols.len() != 1 {
        return None;
    }
    let vendor_cams: Vec<_> = attached
        .iter()
        .filter(|c| c.matched.vendor == cam.matched.vendor)
        .collect();
    if vendor_cams.len() != 1 || vendor_cams[0].source_id != cam.source_id {
        return None;
    }
    Some(vols[0].clone())
}

/// True when this MTP source should be hidden because a volume covers it.
pub fn mtp_covered_by_volume(
    volumes: &HashSet<String>,
    source_id: &str,
    attached: &[DetectedUsbCamera],
) -> Option<String> {
    let cam = attached.iter().find(|c| c.source_id == source_id)?;
    volume_for_usb_camera(volumes, cam, attached)
}

/// USB cameras that should appear as MTP sources (whitelist + import mode + volume dedup).
pub fn filter_visible_usb_cameras(
    ready_volumes: &HashSet<String>,
    attached: Vec<DetectedUsbCamera>,
    import_mode: UsbImportMode,
) -> Vec<DetectedUsbCamera> {
    if import_mode == UsbImportMode::VolumeOnly {
        return Vec::new();
    }

    let mut out = Vec::new();
    for cam in &attached {
        if volume_for_usb_camera(ready_volumes, cam, &attached).is_some() {
            eprintln!(
                "usb_mtp_suppressed: {} covered by volume (vendor={})",
                cam.source_id,
                cam.matched.vendor.slug()
            );
            continue;
        }
        if !may_use_mtp_path(&cam.hint, import_mode) {
            eprintln!(
                "usb_action_cam_volume_only: {} product={:?} (not MTP-whitelisted)",
                cam.source_id, cam.hint.friendly_name
            );
            continue;
        }
        out.push(cam.clone());
    }
    out
}

/// Pairs of `(mtp_source_id, volume_path)` where a newly ready volume supersedes MTP state.
pub fn mtp_superseded_by_volumes(
    ready_volumes: &HashSet<String>,
    attached: &[DetectedUsbCamera],
    tracked_mtp: &HashSet<String>,
) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for mtp_id in tracked_mtp {
        if let Some(vol) = mtp_covered_by_volume(ready_volumes, mtp_id, attached) {
            pairs.push((mtp_id.clone(), vol));
        }
    }
    pairs
}

/// Convenience when only the MTP source id is known (list/ICA guard).
pub fn mtp_covered_by_volume_for_source(source_id: &str) -> Option<String> {
    let ready = ready_volumes();
    let attached = super::usb_enumerate::list_allowlisted_usb_cameras();
    mtp_covered_by_volume(&ready, source_id, &attached)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::allowlist::{match_usb_identity, mtp_source_id, UsbDeviceHint};
    use super::super::mtp_whitelist::UsbImportMode;
    use std::fs;
    use tempfile::tempdir;

    fn dji_cam(id: &str) -> DetectedUsbCamera {
        let hint = UsbDeviceHint {
            vid: Some(super::super::allowlist::DJI_VID),
            pid: None,
            friendly_name: "OsmoAction4".into(),
        };
        let matched = match_usb_identity(&hint).unwrap();
        DetectedUsbCamera {
            source_id: mtp_source_id(ActionCamVendor::Dji, id),
            vendor_slug: "dji".into(),
            label: "OsmoAction4 (USB)".into(),
            hint,
            matched,
            device_class: None,
        }
    }

    fn gopro_cam(id: &str) -> DetectedUsbCamera {
        let hint = UsbDeviceHint {
            vid: Some(super::super::allowlist::GOPRO_VID),
            pid: None,
            friendly_name: "HERO13 Black".into(),
        };
        let matched = match_usb_identity(&hint).unwrap();
        DetectedUsbCamera {
            source_id: mtp_source_id(ActionCamVendor::GoPro, id),
            vendor_slug: "gopro".into(),
            label: "HERO13 Black (USB)".into(),
            hint,
            matched,
            device_class: None,
        }
    }

    fn write_dji_dcim(root: &Path) {
        let dcim = root.join("DCIM").join("100MEDIA");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("DJI_0001.MP4"), b"x").unwrap();
    }

    #[test]
    fn one_to_one_dedup() {
        let dir = tempdir().unwrap();
        write_dji_dcim(dir.path());
        let vol = dir.path().to_string_lossy().into_owned();
        let mut volumes = HashSet::new();
        volumes.insert(vol.clone());
        let cam = dji_cam("SERIAL1");
        let attached = vec![cam.clone()];
        assert_eq!(
            volume_for_usb_camera(&volumes, &cam, &attached).as_deref(),
            Some(vol.as_str())
        );
        let visible = filter_visible_usb_cameras(&volumes, attached, UsbImportMode::Auto);
        assert!(visible.is_empty());
    }

    #[test]
    fn gopro_whitelisted_without_volume_visible() {
        let volumes = HashSet::new();
        let cam = gopro_cam("GP1");
        let visible = filter_visible_usb_cameras(&volumes, vec![cam], UsbImportMode::Auto);
        assert_eq!(visible.len(), 1);
    }

    #[test]
    fn dji_auto_mode_never_visible_without_volume() {
        let volumes = HashSet::new();
        let cam = dji_cam("SERIAL1");
        let visible = filter_visible_usb_cameras(&volumes, vec![cam], UsbImportMode::Auto);
        assert!(visible.is_empty());
    }

    #[test]
    fn dji_mtp_preferred_visible() {
        let volumes = HashSet::new();
        let cam = dji_cam("SERIAL1");
        let visible = filter_visible_usb_cameras(&volumes, vec![cam], UsbImportMode::MtpPreferred);
        assert_eq!(visible.len(), 1);
    }

    #[test]
    fn volume_only_hides_gopro() {
        let volumes = HashSet::new();
        let cam = gopro_cam("GP1");
        let visible = filter_visible_usb_cameras(&volumes, vec![cam], UsbImportMode::VolumeOnly);
        assert!(visible.is_empty());
    }

    #[test]
    fn ambiguous_two_volumes_no_dedup() {
        let d1 = tempdir().unwrap();
        let d2 = tempdir().unwrap();
        write_dji_dcim(d1.path());
        write_dji_dcim(d2.path());
        let mut volumes = HashSet::new();
        volumes.insert(d1.path().to_string_lossy().into_owned());
        volumes.insert(d2.path().to_string_lossy().into_owned());
        let cam = dji_cam("SERIAL1");
        let attached = vec![cam.clone()];
        assert!(volume_for_usb_camera(&volumes, &cam, &attached).is_none());
        let visible =
            filter_visible_usb_cameras(&volumes, vec![cam], UsbImportMode::MtpPreferred);
        assert_eq!(visible.len(), 1);
    }

    #[test]
    fn mtp_superseded_pair() {
        let dir = tempdir().unwrap();
        write_dji_dcim(dir.path());
        let vol = dir.path().to_string_lossy().into_owned();
        let mut volumes = HashSet::new();
        volumes.insert(vol.clone());
        let cam = dji_cam("SERIAL1");
        let attached = vec![cam.clone()];
        let mut tracked = HashSet::new();
        tracked.insert(cam.source_id.clone());
        let pairs = mtp_superseded_by_volumes(&volumes, &attached, &tracked);
        assert_eq!(pairs, vec![(cam.source_id, vol)]);
    }
}
