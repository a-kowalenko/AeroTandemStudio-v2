//! Enumerate USB devices for action-cam hotplug (Phase 23).
//!
//! macOS: parse `ioreg` (fast) — never call `system_profiler` in the SD poll loop.
//! Other platforms: empty until WPD/libmtp adapters land.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use super::allowlist::{match_usb_identity, mtp_source_id, UsbDeviceHint, UsbMatch};

#[derive(Debug, Clone)]
pub struct DetectedUsbCamera {
    pub source_id: String,
    pub vendor_slug: String,
    pub label: String,
    pub hint: UsbDeviceHint,
    pub matched: UsbMatch,
    /// USB `bDeviceClass` when known (2 = Communications/ECM webcam mode on GoPro).
    pub device_class: Option<u8>,
}

/// Why Image Capture / MTP file access will fail for an attached allowlisted cam.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsbMediaAccessBlock {
    /// GoPro (and similar) in CDC-ECM / webcam / "GoPro Connect" USB mode.
    WebcamOrConnectMode,
}

impl UsbMediaAccessBlock {
    pub fn user_message(&self, label: &str) -> String {
        match self {
            Self::WebcamOrConnectMode => format!(
                "{label} ist im Webcam-/USB-Connect-Modus — darüber gibt es keinen Dateizugriff. \
                 An der Kamera: Einstellungen → Verbindungen → USB → „MTP“ wählen, danach \
                 Kabel kurz ab/an stecken (oder MicroSD im Kartenleser nutzen)."
            ),
        }
    }
}

/// If this USB camera cannot expose media to Image Capture / MTP, return why.
pub fn media_access_block_for(source_id: &str) -> Option<UsbMediaAccessBlock> {
    // Fresh ioreg — user may have switched USB mode without unplugging.
    list_allowlisted_usb_cameras_uncached()
        .into_iter()
        .find(|c| c.source_id == source_id)
        .and_then(|c| classify_device_class(c.device_class))
}

fn classify_device_class(device_class: Option<u8>) -> Option<UsbMediaAccessBlock> {
    // USB class 2 = Communications (GoPro ECM / webcam / GoPro Connect).
    // Image Capture only sees PTP/Still-Image (or MTP via Apple helpers) — not ECM.
    match device_class {
        Some(2) => Some(UsbMediaAccessBlock::WebcamOrConnectMode),
        _ => None,
    }
}

struct UsbCache {
    at: Instant,
    cams: Vec<DetectedUsbCamera>,
}

static USB_CACHE: Lazy<Mutex<Option<UsbCache>>> = Lazy::new(|| Mutex::new(None));
/// Longer TTL: poll is every 2s; ioreg is cheap but still avoid hammering.
const USB_CACHE_TTL: Duration = Duration::from_secs(8);

/// Currently attached allowlisted USB cameras (identity only, no DCIM yet).
pub fn list_allowlisted_usb_cameras() -> Vec<DetectedUsbCamera> {
    if let Ok(guard) = USB_CACHE.lock() {
        if let Some(c) = guard.as_ref() {
            if c.at.elapsed() < USB_CACHE_TTL {
                return c.cams.clone();
            }
        }
    }
    let cams = list_allowlisted_usb_cameras_uncached();
    if let Ok(mut guard) = USB_CACHE.lock() {
        *guard = Some(UsbCache {
            at: Instant::now(),
            cams: cams.clone(),
        });
    }
    cams
}

fn list_allowlisted_usb_cameras_uncached() -> Vec<DetectedUsbCamera> {
    #[cfg(target_os = "macos")]
    {
        macos_list_allowlisted_usb_cameras()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn macos_list_allowlisted_usb_cameras() -> Vec<DetectedUsbCamera> {
    // `ioreg` is typically <100ms; `system_profiler SPUSBDataType` can take several seconds
    // and was freezing / slowing the app when polled from the SD monitor.
    let Ok(output) = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-p", "IOUSB", "-l", "-w", "0"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_ioreg_usb_cameras(&text)
}

/// Parse `ioreg -p IOUSB -l -w 0` text into allowlisted cameras.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_ioreg_usb_cameras(text: &str) -> Vec<DetectedUsbCamera> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut block_name = String::new();
    let mut vid: Option<u16> = None;
    let mut pid: Option<u16> = None;
    let mut product = String::new();
    let mut serial = String::new();
    let mut device_class: Option<u8> = None;

    let flush = |block_name: &mut String,
                 vid: &mut Option<u16>,
                 pid: &mut Option<u16>,
                 product: &mut String,
                 serial: &mut String,
                 device_class: &mut Option<u8>,
                 out: &mut Vec<DetectedUsbCamera>,
                 seen: &mut std::collections::HashSet<String>| {
        let friendly = if !product.is_empty() {
            product.clone()
        } else {
            block_name.clone()
        };
        let hint = UsbDeviceHint {
            vid: *vid,
            pid: *pid,
            friendly_name: friendly.clone(),
        };
        if let Some(matched) = match_usb_identity(&hint) {
            let key = if !serial.is_empty() {
                serial.clone()
            } else {
                format!(
                    "{:04x}_{:04x}_{}",
                    vid.unwrap_or(0),
                    pid.unwrap_or(0),
                    friendly.replace(' ', "_")
                )
            };
            let source_id = mtp_source_id(matched.vendor, &key);
            if seen.insert(source_id.clone()) {
                let label = if matched.model_label.is_empty() {
                    if friendly.is_empty() {
                        format!("{} (USB)", matched.vendor.display_name())
                    } else {
                        format!("{friendly} (USB)")
                    }
                } else {
                    format!("{} (USB)", matched.model_label)
                };
                out.push(DetectedUsbCamera {
                    source_id,
                    vendor_slug: matched.vendor.slug().to_string(),
                    label,
                    hint,
                    matched,
                    device_class: *device_class,
                });
            }
        }
        block_name.clear();
        *vid = None;
        *pid = None;
        product.clear();
        serial.clear();
        *device_class = None;
    };

    for line in text.lines() {
        let trimmed = line.trim();
        // New device node, e.g. `+-o HERO8 BLACK@14100000  <class IOUSBHostDevice…`
        if let Some(rest) = trimmed.strip_prefix("+-o ").or_else(|| trimmed.strip_prefix("o ")) {
            if vid.is_some() || pid.is_some() || !product.is_empty() || !block_name.is_empty() {
                flush(
                    &mut block_name,
                    &mut vid,
                    &mut pid,
                    &mut product,
                    &mut serial,
                    &mut device_class,
                    &mut out,
                    &mut seen,
                );
            }
            let name = rest.split('@').next().unwrap_or(rest).trim();
            // Skip hub-ish class names without a real product later.
            if !name.is_empty() && !name.eq_ignore_ascii_case("Root") {
                block_name = name.to_string();
            }
            continue;
        }

        if let Some(v) = parse_ioreg_u16_prop(trimmed, "\"idVendor\"") {
            vid = Some(v);
        } else if let Some(v) = parse_ioreg_u16_prop(trimmed, "\"idProduct\"") {
            pid = Some(v);
        } else if let Some(v) = parse_ioreg_u16_prop(trimmed, "\"bDeviceClass\"") {
            device_class = u8::try_from(v).ok();
        } else if let Some(s) = parse_ioreg_string_prop(trimmed, "\"USB Product Name\"") {
            product = s;
        } else if let Some(s) = parse_ioreg_string_prop(trimmed, "\"USB Serial Number\"") {
            serial = s;
        } else if let Some(s) = parse_ioreg_string_prop(trimmed, "\"kUSBProductString\"") {
            if product.is_empty() {
                product = s;
            }
        } else if let Some(s) = parse_ioreg_string_prop(trimmed, "\"kUSBSerialNumberString\"") {
            if serial.is_empty() {
                serial = s;
            }
        }
    }
    flush(
        &mut block_name,
        &mut vid,
        &mut pid,
        &mut product,
        &mut serial,
        &mut device_class,
        &mut out,
        &mut seen,
    );
    out
}

fn parse_ioreg_u16_prop(line: &str, key: &str) -> Option<u16> {
    let idx = line.find(key)?;
    let after = &line[idx + key.len()..];
    let eq = after.find('=')?;
    let val = after[eq + 1..].trim();
    // decimal (9842) or hex
    if let Some(hex) = val.strip_prefix("0x").or_else(|| val.strip_prefix("0X")) {
        return u16::from_str_radix(hex.trim(), 16).ok();
    }
    val.parse::<u32>().ok().and_then(|n| u16::try_from(n).ok())
}

fn parse_ioreg_string_prop(line: &str, key: &str) -> Option<String> {
    let idx = line.find(key)?;
    let after = &line[idx + key.len()..];
    let eq = after.find('=')?;
    let val = after[eq + 1..].trim();
    let val = val.strip_prefix('"').unwrap_or(val);
    let val = val.strip_suffix('"').unwrap_or(val);
    let s = val.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Parse `vendor_id` / `product_id` fields from system_profiler JSON (tests / fallback).
pub fn parse_usb_id_field(value: Option<&serde_json::Value>) -> Option<u16> {
    let value = value?;
    if let Some(n) = value.as_u64() {
        return u16::try_from(n).ok();
    }
    if let Some(n) = value.as_i64() {
        return u16::try_from(n).ok();
    }
    parse_hex_from_text(value.as_str()?)
}

pub fn parse_hex_from_text(text: &str) -> Option<u16> {
    let lower = text.to_ascii_lowercase();
    if let Some(idx) = lower.rfind("0x") {
        let rest = &lower[idx + 2..];
        let hex: String = rest
            .chars()
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        if (3..=4).contains(&hex.len()) {
            return u16::from_str_radix(&hex, 16).ok();
        }
    }
    let trimmed = text.trim();
    if trimmed.len() == 4 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return u16::from_str_radix(trimmed, 16).ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sd_card::mtp::allowlist::GOPRO_VID;

    #[test]
    fn parse_vendor_id_variants() {
        assert_eq!(
            parse_usb_id_field(Some(&serde_json::json!("0x2672"))),
            Some(GOPRO_VID)
        );
        assert_eq!(
            parse_usb_id_field(Some(&serde_json::json!(0x2672))),
            Some(GOPRO_VID)
        );
        assert_eq!(parse_hex_from_text("product 0x0049 mtp"), Some(0x0049));
    }

    #[test]
    fn parse_ioreg_gopro_hero8() {
        let sample = r#"
+-o Root  <class IORegistryEntry>
  +-o HERO8 BLACK@14100000  <class IOUSBHostDevice, id 0x1000, registered, matched>
    | {
    |   "sessionID" = 123
    |   "idVendor" = 9842
    |   "idProduct" = 73
    |   "USB Vendor Name" = "GoPro"
    |   "USB Product Name" = "HERO8 BLACK"
    |   "USB Serial Number" = "C3331352219254"
    | }
"#;
        let cams = parse_ioreg_usb_cameras(sample);
        assert_eq!(cams.len(), 1);
        assert_eq!(cams[0].source_id, "mtp:gopro:C3331352219254");
        assert!(cams[0].label.contains("HERO8"));
        assert_eq!(cams[0].hint.vid, Some(GOPRO_VID));
        assert_eq!(cams[0].hint.pid, Some(0x0049)); // 73 decimal
        assert_eq!(cams[0].device_class, None);
    }

    #[test]
    fn parse_ioreg_gopro_webcam_ecm_mode_blocked() {
        let sample = r#"
+-o HERO9@14100000  <class AppleUSBDevice>
    {
      "idVendor" = 9842
      "idProduct" = 82
      "bDeviceClass" = 2
      "USB Product Name" = "HERO9"
      "USB Serial Number" = "C3441327799705"
    }
"#;
        let cams = parse_ioreg_usb_cameras(sample);
        assert_eq!(cams.len(), 1);
        assert_eq!(cams[0].device_class, Some(2));
        assert_eq!(
            classify_device_class(cams[0].device_class),
            Some(UsbMediaAccessBlock::WebcamOrConnectMode)
        );
        let msg = UsbMediaAccessBlock::WebcamOrConnectMode.user_message(&cams[0].label);
        assert!(msg.contains("MTP"));
        assert!(msg.contains("Webcam"));
    }
}
