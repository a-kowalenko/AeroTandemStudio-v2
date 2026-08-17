//! Safely eject / unmount a removable SD volume after the SD workflow.
//!
//! Windows: Win32 lock → dismount → eject (+ Shell.Application fallback).
//! macOS: `diskutil eject`.
//! Linux: `udisksctl` unmount/power-off, with `umount` fallback.

use std::fs;
use std::io;
use std::process::Command;
use std::thread;
use std::time::Duration;

#[cfg(unix)]
use std::path::Path;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum EjectError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Message(String),
}

/// Eject / safely remove the volume identified by `drive`
/// (`E:` on Windows, `/Volumes/…` on macOS, `/run/media/…` on Linux).
pub fn eject_drive(drive: &str) -> Result<(), EjectError> {
    let drive = drive.trim();
    if drive.is_empty() {
        return Err(EjectError::Message("Kein Laufwerk angegeben".into()));
    }
    // USB/MTP cameras are not block volumes — use SdCardMonitor::eject_source instead.
    if drive.starts_with("mtp:") {
        return Err(EjectError::Message(
            "USB-Kameras bitte über den Monitor freigeben (eject_source)".into(),
        ));
    }

    #[cfg(windows)]
    {
        eject_windows(drive)
    }
    #[cfg(target_os = "macos")]
    {
        eject_macos(drive)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        eject_linux(drive)
    }
}

/// Normalize a Windows drive string to a single letter (`E`).
pub fn windows_drive_letter(drive: &str) -> Option<char> {
    let s = drive.trim().trim_end_matches(['\\', '/']);
    let s = s.strip_suffix(':').unwrap_or(s);
    let mut chars = s.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    if c.is_ascii_alphabetic() {
        Some(c.to_ascii_uppercase())
    } else {
        None
    }
}

#[cfg(windows)]
fn eject_windows(drive: &str) -> Result<(), EjectError> {
    let letter = windows_drive_letter(drive).ok_or_else(|| {
        EjectError::Message(format!("Ungültiges Windows-Laufwerk: {drive}"))
    })?;

    // Brief settle time so backup/clear handles can close.
    thread::sleep(Duration::from_millis(400));

    let mut last_err = String::new();
    for attempt in 0..4 {
        if attempt > 0 {
            thread::sleep(Duration::from_millis(350 * attempt as u64));
        }
        match eject_windows_ioctl(letter) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e.to_string(),
        }
    }

    // Explorer-style fallback (often succeeds when the volume is still "busy"
    // for DeviceIoControl but Shell can still eject).
    match eject_windows_shell(letter) {
        Ok(()) => Ok(()),
        Err(e) => Err(EjectError::Message(format!(
            "Auswerfen fehlgeschlagen ({letter}:): {last_err}; Shell: {e}"
        ))),
    }
}

#[cfg(windows)]
fn eject_windows_ioctl(letter: char) -> Result<(), EjectError> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    type Handle = *mut std::ffi::c_void;

    unsafe extern "system" {
        fn CreateFileW(
            lpFileName: *const u16,
            dwDesiredAccess: u32,
            dwShareMode: u32,
            lpSecurityAttributes: *mut std::ffi::c_void,
            dwCreationDisposition: u32,
            dwFlagsAndAttributes: u32,
            hTemplateFile: Handle,
        ) -> Handle;
        fn CloseHandle(hObject: Handle) -> i32;
        fn DeviceIoControl(
            hDevice: Handle,
            dwIoControlCode: u32,
            lpInBuffer: *mut std::ffi::c_void,
            nInBufferSize: u32,
            lpOutBuffer: *mut std::ffi::c_void,
            nOutBufferSize: u32,
            lpBytesReturned: *mut u32,
            lpOverlapped: *mut std::ffi::c_void,
        ) -> i32;
        fn GetLastError() -> u32;
    }

    const INVALID_HANDLE_VALUE: isize = -1;
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const OPEN_EXISTING: u32 = 3;
    const FSCTL_LOCK_VOLUME: u32 = 0x0009_0018;
    const FSCTL_DISMOUNT_VOLUME: u32 = 0x0009_0020;
    const IOCTL_STORAGE_MEDIA_REMOVAL: u32 = 0x002D_4804;
    const IOCTL_STORAGE_EJECT_MEDIA: u32 = 0x002D_4808;

    let device = format!(r"\\.\{letter}:");
    let wide: Vec<u16> = std::ffi::OsStr::new(&device)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::null_mut(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };

    if handle as isize == INVALID_HANDLE_VALUE {
        let err = unsafe { GetLastError() };
        return Err(EjectError::Message(format!(
            "CreateFile fehlgeschlagen (Win32 {err})"
        )));
    }

    struct HandleGuard(Handle);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let guard = HandleGuard(handle);

    let mut bytes = 0u32;
    let mut ioctl = |code: u32, in_buf: *mut std::ffi::c_void, in_len: u32| -> Result<(), EjectError> {
        let ok = unsafe {
            DeviceIoControl(
                guard.0,
                code,
                in_buf,
                in_len,
                ptr::null_mut(),
                0,
                &mut bytes,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            return Err(EjectError::Message(format!(
                "DeviceIoControl 0x{code:X} fehlgeschlagen (Win32 {err})"
            )));
        }
        Ok(())
    };

    ioctl(FSCTL_LOCK_VOLUME, ptr::null_mut(), 0)?;
    ioctl(FSCTL_DISMOUNT_VOLUME, ptr::null_mut(), 0)?;

    // Allow media removal
    let mut prevent: u8 = 0;
    ioctl(
        IOCTL_STORAGE_MEDIA_REMOVAL,
        &mut prevent as *mut u8 as *mut _,
        std::mem::size_of_val(&prevent) as u32,
    )?;

    ioctl(IOCTL_STORAGE_EJECT_MEDIA, ptr::null_mut(), 0)?;
    Ok(())
}

#[cfg(windows)]
fn eject_windows_shell(letter: char) -> Result<(), EjectError> {
    // Shell special folder 17 = "My Computer"
    let script = format!(
        "$n=(New-Object -ComObject Shell.Application).NameSpace(17).ParseName('{letter}:'); \
         if(-not $n){{ throw 'Laufwerk nicht gefunden' }}; \
         $n.InvokeVerb('Eject')"
    );
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &script,
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    crate::util::process::apply_no_window(&mut cmd);
    let output = cmd.output()?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(EjectError::Message(
            format!("{stderr} {stdout}").trim().to_string(),
        ))
    }
}

#[cfg(target_os = "macos")]
fn eject_macos(drive: &str) -> Result<(), EjectError> {
    let path = drive.trim_end_matches('/');
    if !path.starts_with("/Volumes/") {
        return Err(EjectError::Message(format!(
            "Erwarte /Volumes/… Pfad, bekommen: {drive}"
        )));
    }
    if !Path::new(path).exists() {
        // Already gone — treat as success (card may have been pulled).
        return Ok(());
    }

    thread::sleep(Duration::from_millis(300));

    let output = Command::new("diskutil")
        .args(["eject", path])
        .output()?;
    if output.status.success() {
        return Ok(());
    }

    // Soft fallback: unmount only (volume disappears from Finder).
    let output2 = Command::new("diskutil")
        .args(["unmount", "force", path])
        .output()?;
    if output2.status.success() {
        return Ok(());
    }

    let err = String::from_utf8_lossy(&output.stderr);
    let err2 = String::from_utf8_lossy(&output2.stderr);
    Err(EjectError::Message(format!(
        "diskutil eject fehlgeschlagen: {}; unmount: {}",
        err.trim(),
        err2.trim()
    )))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn host_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    // AppImage/bundle LD_LIBRARY_PATH must not leak into distro tools (udisksctl).
    crate::util::process::apply_host_library_path(&mut cmd);
    cmd
}

#[cfg(all(unix, not(target_os = "macos")))]
fn eject_linux(drive: &str) -> Result<(), EjectError> {
    let mount = drive.trim_end_matches('/');
    if !Path::new(mount).exists() {
        return Ok(());
    }

    thread::sleep(Duration::from_millis(300));

    let device = resolve_mount_device(mount).ok_or_else(|| {
        EjectError::Message(format!("Blockgerät für Mount nicht gefunden: {mount}"))
    })?;

    let mut last_err = String::new();

    // Prefer udisks2 (desktop-friendly; no root required for user mounts).
    if command_exists("udisksctl") {
        let _ = host_command("udisksctl")
            .args(["unmount", "-b", &device])
            .output();

        let whole = whole_disk_device(&device);
        let power = host_command("udisksctl")
            .args(["power-off", "-b", &whole])
            .output()?;
        if power.status.success() {
            return Ok(());
        }

        // Unmount alone is still a useful "safe to remove" state.
        if !Path::new(mount).exists() {
            return Ok(());
        }

        last_err = format!(
            "udisksctl power-off fehlgeschlagen: {}",
            String::from_utf8_lossy(&power.stderr).trim()
        );
    }

    // Fallback: plain umount (+ optional eject) — also used if udisksctl failed.
    let umount = host_command("umount").arg(mount).output()?;
    if umount.status.success() {
        if command_exists("eject") {
            let _ = host_command("eject").arg(&device).output();
        }
        return Ok(());
    }

    if !Path::new(mount).exists() {
        return Ok(());
    }

    let umount_err = String::from_utf8_lossy(&umount.stderr);
    if last_err.is_empty() {
        Err(EjectError::Message(format!(
            "umount fehlgeschlagen: {}",
            umount_err.trim()
        )))
    } else {
        Err(EjectError::Message(format!(
            "{last_err}; umount: {}",
            umount_err.trim()
        )))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn command_exists(name: &str) -> bool {
    host_command("sh")
        .args(["-c", &format!("command -v {name} >/dev/null 2>&1")])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Read `/proc/mounts` and return the device for `mount_point`.
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
pub fn resolve_mount_device(mount_point: &str) -> Option<String> {
    let mounts = fs::read_to_string("/proc/mounts").ok()?;
    let want = mount_point.trim_end_matches('/');
    for line in mounts.lines() {
        let mut parts = line.split_whitespace();
        let device = parts.next()?;
        let mnt_raw = parts.next()?;
        let mnt = unescape_mount_path(mnt_raw);
        let mnt_trim = mnt.trim_end_matches('/');
        if mnt_trim == want {
            return Some(device.to_string());
        }
    }
    None
}

/// `/proc/mounts` escapes spaces etc. as octal (`\040`).
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
pub fn unescape_mount_path(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            let o1 = bytes[i + 1];
            let o2 = bytes[i + 2];
            let o3 = bytes[i + 3];
            if (b'0'..=b'7').contains(&o1)
                && (b'0'..=b'7').contains(&o2)
                && (b'0'..=b'7').contains(&o3)
            {
                let val = ((o1 - b'0') << 6) | ((o2 - b'0') << 3) | (o3 - b'0');
                out.push(val as char);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Strip partition suffix: `/dev/sdb1` → `/dev/sdb`, `/dev/mmcblk0p1` → `/dev/mmcblk0`.
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
pub fn whole_disk_device(partition: &str) -> String {
    let p = partition.trim();
    if let Some(rest) = p.strip_prefix("/dev/mmcblk") {
        if let Some(idx) = rest.find('p') {
            let disk_num: String = rest[..idx].chars().take_while(|c| c.is_ascii_digit()).collect();
            if !disk_num.is_empty() {
                return format!("/dev/mmcblk{disk_num}");
            }
        }
        return p.to_string();
    }
    if let Some(rest) = p.strip_prefix("/dev/nvme") {
        if let Some(idx) = rest.find('p') {
            return format!("/dev/nvme{}", &rest[..idx]);
        }
        return p.to_string();
    }
    // /dev/sdX1 → /dev/sdX
    let bytes = p.as_bytes();
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1].is_ascii_digit() {
        end -= 1;
    }
    if end < bytes.len() && end > "/dev/sd".len() {
        return p[..end].to_string();
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_letter_parses() {
        assert_eq!(windows_drive_letter("E:"), Some('E'));
        assert_eq!(windows_drive_letter("e:\\"), Some('E'));
        assert_eq!(windows_drive_letter("E"), Some('E'));
        assert_eq!(windows_drive_letter("/Volumes/SD"), None);
        assert_eq!(windows_drive_letter(""), None);
        assert_eq!(windows_drive_letter("EF:"), None);
    }

    #[test]
    fn unescape_space_in_mount() {
        assert_eq!(unescape_mount_path(r"/run/media/user/NO\040NAME"), "/run/media/user/NO NAME");
        assert_eq!(unescape_mount_path("/media/foo"), "/media/foo");
    }

    #[test]
    fn whole_disk_strips_partition() {
        assert_eq!(whole_disk_device("/dev/sdb1"), "/dev/sdb");
        assert_eq!(whole_disk_device("/dev/sdc12"), "/dev/sdc");
        assert_eq!(whole_disk_device("/dev/mmcblk0p1"), "/dev/mmcblk0");
        assert_eq!(whole_disk_device("/dev/mmcblk1p2"), "/dev/mmcblk1");
        assert_eq!(whole_disk_device("/dev/nvme0n1p1"), "/dev/nvme0n1");
        assert_eq!(whole_disk_device("/dev/sdb"), "/dev/sdb");
    }
}
