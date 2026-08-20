//! Windows Portable Devices (WPD/MTP) for allowlisted action cams (Phase 23.1).
//!
//! Detect → catalog → stage-to-backup. Never run FFmpeg against MTP paths.

#![cfg(target_os = "windows")]

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use windows::core::PCWSTR;
use windows::core::PWSTR;
use windows::Win32::Devices::PortableDevices::*;
use windows::Win32::Foundation::{PROPERTYKEY, GENERIC_READ};
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IStream, CLSCTX_INPROC_SERVER,
    COINIT_MULTITHREADED, STGM_READ,
};

use crate::media::dji_paths::is_listable_media_path;
use crate::sd_card::mtp::allowlist::{
    content_names_look_like_action_cam, match_usb_identity, mtp_source_id,
    object_name_matches_action_cam_signature, ActionCamVendor, UsbDeviceHint,
};
use crate::sd_card::mtp::catalog::{cache_dir_for, CameraCatalogFile};
use crate::sd_card::mtp::usb_enumerate::DetectedUsbCamera;

#[derive(Debug)]
pub enum WpdError {
    Message(String),
}

impl std::fmt::Display for WpdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(m) => write!(f, "{m}"),
        }
    }
}

impl From<windows::core::Error> for WpdError {
    fn from(e: windows::core::Error) -> Self {
        Self::Message(e.to_string())
    }
}

impl From<std::io::Error> for WpdError {
    fn from(e: std::io::Error) -> Self {
        Self::Message(e.to_string())
    }
}

struct ComGuard {
    should_uninit: bool,
}

impl ComGuard {
    fn enter() -> Self {
        // S_OK (0) or S_FALSE (1) = success; other = already initialized differently.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let code = hr.0 as i32;
        let should_uninit = code == 0; // S_OK — we own this init
        Self { should_uninit }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.should_uninit {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

/// PnP id for an `mtp:` source (refreshed on each successful enumerate).
static SOURCE_PNP: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn remember_pnp(source_id: &str, pnp: &str) {
    if let Ok(mut g) = SOURCE_PNP.lock() {
        g.insert(source_id.to_string(), pnp.to_string());
    }
}

fn pnp_for_source(source_id: &str) -> Option<String> {
    SOURCE_PNP
        .lock()
        .ok()
        .and_then(|g| g.get(source_id).cloned())
}

/// Drop local catalog cache (soft-eject / unplug).
pub fn invalidate_stage_cache(source_id: &str) {
    let dest = cache_dir_for(source_id);
    if dest.is_dir() {
        let _ = fs::remove_dir_all(&dest);
    }
    if let Ok(mut g) = SOURCE_PNP.lock() {
        g.remove(source_id);
    }
}

/// Enumerate allowlisted WPD cameras that also pass the content signature.
pub fn list_allowlisted_wpd_cameras() -> Vec<DetectedUsbCamera> {
    let _com = ComGuard::enter();
    match list_allowlisted_wpd_cameras_inner() {
        Ok(v) => v,
        Err(_) => Vec::new(),
    }
}

fn list_allowlisted_wpd_cameras_inner() -> Result<Vec<DetectedUsbCamera>, WpdError> {
    let manager: IPortableDeviceManager =
        unsafe { CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER)? };
    unsafe {
        let _ = manager.RefreshDeviceList();
    }

    let pnp_ids = unsafe { get_device_ids(&manager)? };
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for pnp in &pnp_ids {
        let friendly = unsafe { manager_string(&manager, pnp, ManagerStringKind::Friendly) };
        let manufacturer =
            unsafe { manager_string(&manager, pnp, ManagerStringKind::Manufacturer) };
        let description = unsafe { manager_string(&manager, pnp, ManagerStringKind::Description) };
        let (vid, pid) = parse_vid_pid_from_pnp(pnp);

        let mut friendly_name = friendly.clone();
        if friendly_name.is_empty() {
            friendly_name = description.clone();
        }
        if !manufacturer.is_empty()
            && !friendly_name
                .to_ascii_lowercase()
                .contains(&manufacturer.to_ascii_lowercase())
        {
            friendly_name = format!("{manufacturer} {friendly_name}").trim().to_string();
        }

        let hint = UsbDeviceHint {
            vid,
            pid,
            friendly_name: friendly_name.clone(),
        };
        let Some(matched) = match_usb_identity(&hint) else {
            continue;
        };

        let Ok(device) = open_device(pnp) else {
            continue;
        };
        let serial = device_serial(&device).unwrap_or_default();
        let names = match collect_object_names_for_signature(&device, matched.vendor) {
            Ok(n) => n,
            Err(_) => continue,
        };
        if !content_names_look_like_action_cam(names.iter().map(|s| s.as_str()), matched.vendor) {
            continue;
        }

        let key = if !serial.is_empty() {
            serial
        } else {
            format!(
                "{:04x}_{:04x}_{}",
                vid.unwrap_or(0),
                pid.unwrap_or(0),
                friendly_name.replace(' ', "_")
            )
        };
        let source_id = mtp_source_id(matched.vendor, &key);
        if !seen.insert(source_id.clone()) {
            continue;
        }
        remember_pnp(&source_id, pnp);

        let label = if matched.model_label.is_empty() {
            if friendly_name.is_empty() {
                format!("{} (USB)", matched.vendor.display_name())
            } else {
                format!("{friendly_name} (USB)")
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
            device_class: None,
        });
    }

    Ok(out)
}

/// Catalog listable media on the camera (no download).
pub fn list_camera_catalog(
    source_id: &str,
    _label: &str,
    mut on_tick: Option<Box<dyn FnMut(Vec<CameraCatalogFile>) + Send>>,
) -> Result<Vec<CameraCatalogFile>, WpdError> {
    let _com = ComGuard::enter();
    let pnp = resolve_pnp(source_id)?;
    let device = open_device(&pnp)?;
    let files = collect_media_catalog(&device, on_tick.as_mut())?;
    let dest = cache_dir_for(source_id);
    fs::create_dir_all(&dest)?;
    let raw =
        serde_json::to_string_pretty(&files).map_err(|e| WpdError::Message(e.to_string()))?;
    let _ = fs::write(dest.join(".ats_wpd_catalog.json"), raw);
    Ok(files)
}

pub type ProgressCb = Box<dyn FnMut(u32, u32, String, u64, u64) + Send>;

/// Download named files into `dest_dir` (flat).
pub fn download_camera_files(
    source_id: &str,
    _label: &str,
    dest_dir: &Path,
    names: &[String],
    mut on_progress: Option<ProgressCb>,
) -> Result<Vec<PathBuf>, WpdError> {
    let _com = ComGuard::enter();
    if names.is_empty() {
        return Err(WpdError::Message(
            "Keine Dateien zum Download ausgewählt.".into(),
        ));
    }
    let pnp = resolve_pnp(source_id)?;
    fs::create_dir_all(dest_dir)?;
    let device = open_device(&pnp)?;
    let wanted: HashSet<String> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
    let objects = find_objects_by_filename(&device, &wanted)?;
    let total = objects.len() as u32;
    if total == 0 {
        return Err(WpdError::Message(
            "Ausgewählte Dateien wurden auf der Kamera nicht gefunden.".into(),
        ));
    }

    let content = unsafe { device.Content()? };
    let resources = unsafe { content.Transfer()? };
    let mut out = Vec::new();
    let mut bytes_done_total = 0u64;
    let bytes_total: u64 = objects.iter().map(|o| o.size).sum();

    for (idx, obj) in objects.iter().enumerate() {
        let file_index = (idx + 1) as u32;
        let dest = unique_path(dest_dir, &obj.name);
        let written = copy_object_to_file(
            &resources,
            &obj.object_id,
            &dest,
            obj.size,
            |done_in_file| {
                if let Some(cb) = on_progress.as_mut() {
                    cb(
                        file_index,
                        total,
                        obj.name.clone(),
                        bytes_done_total + done_in_file,
                        bytes_total,
                    );
                }
            },
        )?;
        bytes_done_total += written;
        if let Some(cb) = on_progress.as_mut() {
            cb(
                file_index,
                total,
                obj.name.clone(),
                bytes_done_total,
                bytes_total,
            );
        }
        out.push(dest);
    }
    Ok(out)
}

pub type ClearProgressCb = Box<dyn FnMut(u32, u32) + Send>;

/// Delete objects by original filename (best-effort).
pub fn delete_camera_files_named(
    source_id: &str,
    _label: &str,
    names: &[String],
    mut on_progress: Option<ClearProgressCb>,
) -> Result<usize, WpdError> {
    let _com = ComGuard::enter();
    if names.is_empty() {
        return Ok(0);
    }
    let pnp = resolve_pnp(source_id)?;
    let device = open_device(&pnp)?;
    let wanted: HashSet<String> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
    let objects = find_objects_by_filename(&device, &wanted)?;
    let total = objects.len().max(1) as u32;
    if let Some(cb) = on_progress.as_mut() {
        cb(0, total);
    }
    if objects.is_empty() {
        return Ok(0);
    }

    let content = unsafe { device.Content()? };
    let collection: IPortableDevicePropVariantCollection = unsafe {
        CoCreateInstance(
            &PortableDevicePropVariantCollection,
            None,
            CLSCTX_INPROC_SERVER,
        )?
    };

    let mut deleted = 0usize;
    for (i, obj) in objects.iter().enumerate() {
        let mut pv = string_propvariant(&obj.object_id)?;
        unsafe {
            let _ = collection.Clear();
            collection.Add(&pv)?;
            content.Delete(
                PORTABLE_DEVICE_DELETE_NO_RECURSION.0 as u32,
                &collection,
                std::ptr::null_mut(),
            )?;
        }
        clear_propvariant(&mut pv);
        deleted += 1;
        if let Some(cb) = on_progress.as_mut() {
            cb((i + 1) as u32, total);
        }
    }
    Ok(deleted)
}

fn resolve_pnp(source_id: &str) -> Result<String, WpdError> {
    if let Some(pnp) = pnp_for_source(source_id) {
        return Ok(pnp);
    }
    // Refresh map via enumerate.
    let _ = list_allowlisted_wpd_cameras();
    pnp_for_source(source_id).ok_or_else(|| {
        WpdError::Message(format!(
            "{source_id}: USB-Kamera nicht gefunden. Bitte Kabel prüfen / erneut anstecken."
        ))
    })
}

// ——— internals ———

enum ManagerStringKind {
    Friendly,
    Manufacturer,
    Description,
}

unsafe fn get_device_ids(manager: &IPortableDeviceManager) -> Result<Vec<String>, WpdError> {
    let mut count = 0u32;
    manager.GetDevices(std::ptr::null_mut(), &mut count)?;
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut ptrs: Vec<PWSTR> = vec![PWSTR::null(); count as usize];
    manager.GetDevices(ptrs.as_mut_ptr(), &mut count)?;
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..(count as usize) {
        let p = ptrs[i];
        if !p.is_null() {
            out.push(unsafe { p.to_string().unwrap_or_default() });
            unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
        }
    }
    Ok(out)
}

unsafe fn manager_string(
    manager: &IPortableDeviceManager,
    pnp: &str,
    kind: ManagerStringKind,
) -> String {
    let wide = to_wide(pnp);
    let mut len = 0u32;
    let probe = match kind {
        ManagerStringKind::Friendly => {
            manager.GetDeviceFriendlyName(PCWSTR(wide.as_ptr()), PWSTR::null(), &mut len)
        }
        ManagerStringKind::Manufacturer => {
            manager.GetDeviceManufacturer(PCWSTR(wide.as_ptr()), PWSTR::null(), &mut len)
        }
        ManagerStringKind::Description => {
            manager.GetDeviceDescription(PCWSTR(wide.as_ptr()), PWSTR::null(), &mut len)
        }
    };
    if probe.is_err() || len == 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize];
    let fill = match kind {
        ManagerStringKind::Friendly => {
            manager.GetDeviceFriendlyName(PCWSTR(wide.as_ptr()), PWSTR(buf.as_mut_ptr()), &mut len)
        }
        ManagerStringKind::Manufacturer => {
            manager.GetDeviceManufacturer(PCWSTR(wide.as_ptr()), PWSTR(buf.as_mut_ptr()), &mut len)
        }
        ManagerStringKind::Description => {
            manager.GetDeviceDescription(PCWSTR(wide.as_ptr()), PWSTR(buf.as_mut_ptr()), &mut len)
        }
    };
    if fill.is_err() {
        return String::new();
    }
    String::from_utf16_lossy(&buf)
        .trim_end_matches('\0')
        .trim()
        .to_string()
}

fn parse_vid_pid_from_pnp(pnp: &str) -> (Option<u16>, Option<u16>) {
    let lower = pnp.to_ascii_lowercase();
    let vid = extract_hex_after(&lower, "vid_");
    let pid = extract_hex_after(&lower, "pid_");
    (vid, pid)
}

fn extract_hex_after(text: &str, marker: &str) -> Option<u16> {
    let idx = text.find(marker)?;
    let rest = &text[idx + marker.len()..];
    let hex: String = rest
        .chars()
        .take_while(|c| c.is_ascii_hexdigit())
        .take(4)
        .collect();
    if hex.len() == 4 {
        u16::from_str_radix(&hex, 16).ok()
    } else {
        None
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn open_device(pnp: &str) -> Result<IPortableDevice, WpdError> {
    let client: IPortableDeviceValues =
        unsafe { CoCreateInstance(&PortableDeviceValues, None, CLSCTX_INPROC_SERVER)? };
    unsafe {
        client.SetStringValue(&WPD_CLIENT_NAME, windows::core::w!("AeroTandemStudio"))?;
        client.SetUnsignedIntegerValue(&WPD_CLIENT_MAJOR_VERSION, 1)?;
        client.SetUnsignedIntegerValue(&WPD_CLIENT_MINOR_VERSION, 0)?;
        client.SetUnsignedIntegerValue(&WPD_CLIENT_REVISION, 0)?;
        // SECURITY_IMPERSONATION
        client.SetUnsignedIntegerValue(&WPD_CLIENT_SECURITY_QUALITY_OF_SERVICE, 0x00000002)?;
        client.SetUnsignedIntegerValue(&WPD_CLIENT_DESIRED_ACCESS, GENERIC_READ.0)?;
    }
    let device: IPortableDevice =
        unsafe { CoCreateInstance(&PortableDeviceFTM, None, CLSCTX_INPROC_SERVER)? };
    let wide = to_wide(pnp);
    unsafe {
        device.Open(PCWSTR(wide.as_ptr()), &client)?;
    }
    Ok(device)
}

fn device_serial(device: &IPortableDevice) -> Option<String> {
    let content = unsafe { device.Content().ok()? };
    let props = unsafe { content.Properties().ok()? };
    let keys: IPortableDeviceKeyCollection =
        unsafe { CoCreateInstance(&PortableDeviceKeyCollection, None, CLSCTX_INPROC_SERVER).ok()? };
    unsafe {
        keys.Add(&WPD_DEVICE_SERIAL_NUMBER).ok()?;
    }
    let values = unsafe { props.GetValues(WPD_DEVICE_OBJECT_ID, &keys).ok()? };
    let pw = unsafe { values.GetStringValue(&WPD_DEVICE_SERIAL_NUMBER).ok()? };
    let s = unsafe { pw.to_string().ok()? };
    unsafe {
        CoTaskMemFree(Some(pw.0 as *const _));
    }
    let t = s.trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn collect_object_names_for_signature(
    device: &IPortableDevice,
    vendor: ActionCamVendor,
) -> Result<Vec<String>, WpdError> {
    let content = unsafe { device.Content()? };
    let props = unsafe { content.Properties()? };
    let mut names = Vec::new();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();
    queue.push_back(("DEVICE".into(), 0));
    let mut visited = 0usize;
    const MAX_VISIT: usize = 400;
    const MAX_DEPTH: u32 = 5;

    while let Some((parent, depth)) = queue.pop_front() {
        if visited >= MAX_VISIT {
            break;
        }
        let parent_w = to_wide(&parent);
        let enum_ids = unsafe { content.EnumObjects(0, PCWSTR(parent_w.as_ptr()), None)? };
        loop {
            let mut batch = [PWSTR::null(); 32];
            let mut fetched = 0u32;
            let hr = unsafe { enum_ids.Next(&mut batch, &mut fetched) };
            if fetched == 0 {
                let _ = hr;
                break;
            }
            for i in 0..(fetched as usize) {
                visited += 1;
                let oid = batch[i];
                if oid.is_null() {
                    continue;
                }
                let id_str = unsafe { oid.to_string().unwrap_or_default() };
                unsafe { CoTaskMemFree(Some(oid.0 as *const _)) };

                let name = object_name(&props, &id_str).unwrap_or_default();
                if !name.is_empty() {
                    names.push(name.clone());
                    if object_name_matches_action_cam_signature(&name, vendor) {
                        return Ok(names);
                    }
                }
                if depth < MAX_DEPTH && is_folder_object(&props, &id_str) {
                    queue.push_back((id_str, depth + 1));
                }
                if visited >= MAX_VISIT {
                    break;
                }
            }
            if visited >= MAX_VISIT {
                break;
            }
        }
    }
    Ok(names)
}

struct CatalogObject {
    object_id: String,
    name: String,
    size: u64,
}

fn collect_media_catalog(
    device: &IPortableDevice,
    mut on_tick: Option<&mut Box<dyn FnMut(Vec<CameraCatalogFile>) + Send>>,
) -> Result<Vec<CameraCatalogFile>, WpdError> {
    let content = unsafe { device.Content()? };
    let props = unsafe { content.Properties()? };
    let mut files = Vec::new();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();
    queue.push_back(("DEVICE".into(), 0));
    let mut visited = 0usize;
    const MAX_VISIT: usize = 5000;
    const MAX_DEPTH: u32 = 8;
    let mut last_tick = 0usize;

    while let Some((parent, depth)) = queue.pop_front() {
        if visited >= MAX_VISIT {
            break;
        }
        let parent_w = to_wide(&parent);
        let enum_ids = unsafe { content.EnumObjects(0, PCWSTR(parent_w.as_ptr()), None)? };
        loop {
            let mut batch = [PWSTR::null(); 64];
            let mut fetched = 0u32;
            let hr = unsafe { enum_ids.Next(&mut batch, &mut fetched) };
            if fetched == 0 {
                let _ = hr;
                break;
            }
            for i in 0..(fetched as usize) {
                visited += 1;
                let oid = batch[i];
                if oid.is_null() {
                    continue;
                }
                let id_str = unsafe { oid.to_string().unwrap_or_default() };
                unsafe { CoTaskMemFree(Some(oid.0 as *const _)) };

                if is_folder_object(&props, &id_str) {
                    if depth < MAX_DEPTH {
                        queue.push_back((id_str, depth + 1));
                    }
                    continue;
                }

                let name = object_original_name(&props, &id_str)
                    .or_else(|| object_name(&props, &id_str))
                    .unwrap_or_default();
                if name.is_empty() || !is_listable_media_path(Path::new(&name)) {
                    continue;
                }
                let size = object_size(&props, &id_str).unwrap_or(0);
                files.push(CameraCatalogFile {
                    name,
                    size,
                    mtime: 0.0,
                });
                if let Some(ref mut cb) = on_tick {
                    if files.len() >= last_tick + 8 {
                        last_tick = files.len();
                        cb(files.clone());
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

fn find_objects_by_filename(
    device: &IPortableDevice,
    wanted: &HashSet<String>,
) -> Result<Vec<CatalogObject>, WpdError> {
    let content = unsafe { device.Content()? };
    let props = unsafe { content.Properties()? };
    let mut found = Vec::new();
    let mut remaining = wanted.clone();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();
    queue.push_back(("DEVICE".into(), 0));
    const MAX_DEPTH: u32 = 8;

    while let Some((parent, depth)) = queue.pop_front() {
        if remaining.is_empty() {
            break;
        }
        let parent_w = to_wide(&parent);
        let enum_ids = unsafe { content.EnumObjects(0, PCWSTR(parent_w.as_ptr()), None)? };
        loop {
            let mut batch = [PWSTR::null(); 64];
            let mut fetched = 0u32;
            let hr = unsafe { enum_ids.Next(&mut batch, &mut fetched) };
            if fetched == 0 {
                let _ = hr;
                break;
            }
            for i in 0..(fetched as usize) {
                let oid = batch[i];
                if oid.is_null() {
                    continue;
                }
                let id_str = unsafe { oid.to_string().unwrap_or_default() };
                unsafe { CoTaskMemFree(Some(oid.0 as *const _)) };

                if is_folder_object(&props, &id_str) {
                    if depth < MAX_DEPTH {
                        queue.push_back((id_str, depth + 1));
                    }
                    continue;
                }
                let name = object_original_name(&props, &id_str)
                    .or_else(|| object_name(&props, &id_str))
                    .unwrap_or_default();
                let key = name.to_ascii_lowercase();
                if remaining.remove(&key) {
                    let size = object_size(&props, &id_str).unwrap_or(0);
                    found.push(CatalogObject {
                        object_id: id_str,
                        name,
                        size,
                    });
                }
            }
        }
    }
    Ok(found)
}

fn object_name(props: &IPortableDeviceProperties, object_id: &str) -> Option<String> {
    read_string_prop(props, object_id, &WPD_OBJECT_NAME)
}

fn object_original_name(props: &IPortableDeviceProperties, object_id: &str) -> Option<String> {
    read_string_prop(props, object_id, &WPD_OBJECT_ORIGINAL_FILE_NAME)
}

fn object_size(props: &IPortableDeviceProperties, object_id: &str) -> Option<u64> {
    let keys: IPortableDeviceKeyCollection =
        unsafe { CoCreateInstance(&PortableDeviceKeyCollection, None, CLSCTX_INPROC_SERVER).ok()? };
    unsafe {
        keys.Add(&WPD_OBJECT_SIZE).ok()?;
    }
    let id_w = to_wide(object_id);
    let values = unsafe { props.GetValues(PCWSTR(id_w.as_ptr()), &keys).ok()? };
    unsafe { values.GetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE).ok() }
}

fn is_folder_object(props: &IPortableDeviceProperties, object_id: &str) -> bool {
    let keys: IPortableDeviceKeyCollection = match unsafe {
        CoCreateInstance(&PortableDeviceKeyCollection, None, CLSCTX_INPROC_SERVER)
    } {
        Ok(k) => k,
        Err(_) => return false,
    };
    if unsafe { keys.Add(&WPD_OBJECT_CONTENT_TYPE) }.is_err() {
        return false;
    }
    let id_w = to_wide(object_id);
    let values = match unsafe { props.GetValues(PCWSTR(id_w.as_ptr()), &keys) } {
        Ok(v) => v,
        Err(_) => return false,
    };
    match unsafe { values.GetGuidValue(&WPD_OBJECT_CONTENT_TYPE) } {
        Ok(g) => g == WPD_CONTENT_TYPE_FOLDER,
        Err(_) => false,
    }
}

fn read_string_prop(
    props: &IPortableDeviceProperties,
    object_id: &str,
    key: &PROPERTYKEY,
) -> Option<String> {
    let keys: IPortableDeviceKeyCollection =
        unsafe { CoCreateInstance(&PortableDeviceKeyCollection, None, CLSCTX_INPROC_SERVER).ok()? };
    unsafe {
        keys.Add(key).ok()?;
    }
    let id_w = to_wide(object_id);
    let values = unsafe { props.GetValues(PCWSTR(id_w.as_ptr()), &keys).ok()? };
    let pw = unsafe { values.GetStringValue(key).ok()? };
    let s = unsafe { pw.to_string().ok() };
    unsafe {
        CoTaskMemFree(Some(pw.0 as *const _));
    }
    s.map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn copy_object_to_file(
    resources: &IPortableDeviceResources,
    object_id: &str,
    dest: &Path,
    expected_size: u64,
    mut on_bytes: impl FnMut(u64),
) -> Result<u64, WpdError> {
    let mut optimal = 0u32;
    let mut stream: Option<IStream> = None;
    let id_w = to_wide(object_id);
    unsafe {
        resources.GetStream(
            PCWSTR(id_w.as_ptr()),
            &WPD_RESOURCE_DEFAULT,
            STGM_READ.0,
            &mut optimal,
            &mut stream,
        )?;
    }
    let stream =
        stream.ok_or_else(|| WpdError::Message("Kein Datenstrom von der Kamera.".into()))?;
    let mut file = File::create(dest)?;
    let buf_size = if optimal > 0 {
        optimal as usize
    } else {
        64 * 1024
    };
    let mut buf = vec![0u8; buf_size];
    let mut written = 0u64;
    loop {
        let mut read = 0u32;
        let hr =
            unsafe { stream.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read)) };
        if read == 0 {
            let _ = hr;
            break;
        }
        if hr.is_err() {
            return Err(WpdError::Message(format!(
                "Lesen von Kamera fehlgeschlagen: {hr:?}"
            )));
        }
        file.write_all(&buf[..read as usize])?;
        written += u64::from(read);
        on_bytes(written);
        if expected_size > 0 && written >= expected_size {
            break;
        }
    }
    Ok(written)
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 2..10_000 {
        let p = dir.join(format!("{stem}_{i}{ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!(
        "{stem}_{}{ext}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(1)
    ))
}

fn string_propvariant(value: &str) -> Result<PROPVARIANT, WpdError> {
    use windows::Win32::System::Com::CoTaskMemAlloc;
    use windows::Win32::System::Variant::VT_LPWSTR;

    let wide = to_wide(value);
    let bytes = wide.len() * std::mem::size_of::<u16>();
    let ptr = unsafe { CoTaskMemAlloc(bytes) };
    if ptr.is_null() {
        return Err(WpdError::Message("CoTaskMemAlloc failed".into()));
    }
    unsafe {
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr as *mut u16, wide.len());
        let mut out = PROPVARIANT::default();
        let inner = &mut *out.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = PWSTR(ptr as *mut u16);
        Ok(out)
    }
}

fn clear_propvariant(pv: &mut PROPVARIANT) {
    unsafe {
        let _ = PropVariantClear(pv);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sd_card::mtp::allowlist::match_usb_identity;

    #[test]
    fn parse_vid_pid_from_typical_pnp() {
        let pnp = r"\\?\usb#vid_2672&pid_0049#c3331352219254#{6ac27878-a6bc-11d0-96b8-00a0c91fadcf}";
        let (vid, pid) = parse_vid_pid_from_pnp(pnp);
        assert_eq!(vid, Some(0x2672));
        assert_eq!(pid, Some(0x0049));
    }

    #[test]
    fn phone_pnp_not_allowlisted_by_vid_alone() {
        let pnp = r"\\?\usb#vid_18d1&pid_4ee2#001#{6ac27878-a6bc-11d0-96b8-00a0c91fadcf}";
        let (vid, pid) = parse_vid_pid_from_pnp(pnp);
        let hint = UsbDeviceHint {
            vid,
            pid,
            friendly_name: "Pixel".into(),
        };
        assert!(match_usb_identity(&hint).is_none());
    }
}
