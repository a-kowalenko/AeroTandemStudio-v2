//! Physical link probe: Ethernet vs Wi-Fi, without SSID names.
//!
//! Virtual adapters (Hyper-V, Docker, VPN, tunnels, bridges) do not count.
//! A failed probe is "neither", so the wizard stays neutral.

use serde::Serialize;

/// `IF_TYPE_ETHERNET_CSMACD` (Windows) / treated as wired.
const IF_TYPE_ETHERNET: u32 = 6;
/// `IF_TYPE_IEEE80211`.
const IF_TYPE_WIFI: u32 = 71;
/// Linux `ARPHRD_ETHER`. Also used by Wi-Fi, so the name/wireless flag decides.
const ARPHRD_ETHER: u32 = 1;
/// Linux `ARPHRD_IEEE80211`.
const ARPHRD_IEEE80211: u32 = 801;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct LocalLinkStatus {
    pub ethernet: bool,
    pub wifi: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterSnapshot {
    pub name: String,
    pub description: String,
    pub if_type: Option<u32>,
    pub up: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AdapterKind {
    Ethernet,
    Wifi,
    Ignore,
}

pub fn probe_local_links() -> LocalLinkStatus {
    status_from(&collect_adapters())
}

pub fn status_from(adapters: &[AdapterSnapshot]) -> LocalLinkStatus {
    let mut ethernet = false;
    let mut wifi = false;
    for adapter in adapters {
        if !adapter.up {
            continue;
        }
        match classify(adapter) {
            AdapterKind::Ethernet => ethernet = true,
            AdapterKind::Wifi => wifi = true,
            AdapterKind::Ignore => {}
        }
    }
    LocalLinkStatus { ethernet, wifi }
}

fn classify(adapter: &AdapterSnapshot) -> AdapterKind {
    if is_virtual(&adapter.name, &adapter.description) {
        return AdapterKind::Ignore;
    }
    if looks_like_wifi(&adapter.name, &adapter.description, adapter.if_type) {
        return AdapterKind::Wifi;
    }
    if looks_like_ethernet(&adapter.name, &adapter.description, adapter.if_type) {
        return AdapterKind::Ethernet;
    }
    AdapterKind::Ignore
}

fn is_virtual(name: &str, description: &str) -> bool {
    let n = name.trim().to_lowercase();
    if n == "lo" || n == "lo0" {
        return true;
    }
    const NAME_PREFIXES: &[&str] = &[
        "docker", "veth", "br-", "virbr", "tun", "tap", "wg", "tailscale", "zt", "vmnet",
        "vbox", "cni", "flannel", "cali", "dummy", "gre", "sit", "ip6tnl", "ifb", "ppp",
        "wwan", "bridge", "awdl", "llw", "utun", "gif", "stf", "anpi", "ipsec", "vethernet",
    ];
    if NAME_PREFIXES.iter().any(|prefix| n.starts_with(prefix)) {
        return true;
    }
    let blob = format!("{n} {}", description.to_lowercase());
    const NEEDLES: &[&str] = &[
        "vethernet",
        "hyper-v",
        "hyperv",
        "virtualbox",
        "vmware",
        "vmnet",
        "docker",
        "wsl",
        "loopback",
        "npcap",
        "bluetooth",
        "wireguard",
        "tailscale",
        "zerotier",
        "hamachi",
        "radmin",
        "teredo",
        "isatap",
        "wan miniport",
        "wi-fi direct",
        "wifi direct",
        "hosted network",
        "pseudo-interface",
        "tunnel",
        "vpn",
        "6to4",
        "kernel debug",
        "virtual",
        "thunderbolt bridge",
        "filter driver",
    ];
    NEEDLES.iter().any(|needle| blob.contains(needle))
}

fn looks_like_wifi(name: &str, description: &str, if_type: Option<u32>) -> bool {
    if matches!(if_type, Some(IF_TYPE_WIFI) | Some(ARPHRD_IEEE80211)) {
        return true;
    }
    let n = name.trim().to_lowercase();
    if n.starts_with("wlan")
        || n.starts_with("wlp")
        || n.starts_with("wlx")
        || n.starts_with("wlo")
        || n == "wifi"
    {
        return true;
    }
    let blob = format!("{n} {}", description.to_lowercase());
    ["wi-fi", "wifi", "wlan", "wireless", "802.11", "airport"]
        .iter()
        .any(|needle| blob.contains(needle))
}

fn looks_like_ethernet(name: &str, description: &str, if_type: Option<u32>) -> bool {
    if looks_like_wifi(name, description, if_type) {
        return false;
    }
    if matches!(if_type, Some(IF_TYPE_ETHERNET) | Some(ARPHRD_ETHER)) {
        return true;
    }
    let n = name.trim().to_lowercase();
    if n.starts_with("eth")
        || n.starts_with("enp")
        || n.starts_with("eno")
        || n.starts_with("ens")
        || n.starts_with("enx")
        || n.starts_with("em")
    {
        return true;
    }
    let blob = format!("{n} {}", description.to_lowercase());
    blob.contains("ethernet") || blob.contains(" lan") || blob.contains("gbe") || blob.contains("ax88179")
}

/// `networksetup -listallhardwareports` pairs. Device name, then hardware-port label.
fn parse_hardware_ports(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut port: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Hardware Port:") {
            port = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Device:") {
            if let Some(label) = port.take() {
                let device = rest.trim();
                if !device.is_empty() {
                    out.push((device.to_string(), label));
                }
            }
        }
    }
    out
}

#[cfg(windows)]
fn collect_adapters() -> Vec<AdapterSnapshot> {
    probe_windows()
}

#[cfg(target_os = "macos")]
fn collect_adapters() -> Vec<AdapterSnapshot> {
    probe_macos()
}

#[cfg(target_os = "linux")]
fn collect_adapters() -> Vec<AdapterSnapshot> {
    probe_linux()
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn collect_adapters() -> Vec<AdapterSnapshot> {
    Vec::new()
}

#[cfg(windows)]
fn probe_windows() -> Vec<AdapterSnapshot> {
    use windows::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::Networking::WinSock::AF_UNSPEC;

    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size = 16 * 1024u32;
    let mut buf = vec![0u8; size as usize];
    let mut attempts = 0u8;
    loop {
        attempts += 1;
        let ret = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC.0 as u32,
                flags,
                None,
                Some(buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH),
                &mut size,
            )
        };
        if ret == 0 {
            break;
        }
        if ret == ERROR_BUFFER_OVERFLOW.0 && attempts < 3 {
            buf.resize(size as usize, 0);
            continue;
        }
        return Vec::new();
    }

    let mut out = Vec::new();
    unsafe {
        let mut current = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !current.is_null() {
            let adapter = &*current;
            out.push(AdapterSnapshot {
                name: wide_string(adapter.FriendlyName),
                description: wide_string(adapter.Description),
                if_type: Some(u32::from(adapter.IfType)),
                up: adapter.OperStatus == IfOperStatusUp,
            });
            current = adapter.Next;
        }
    }
    out
}

#[cfg(windows)]
fn wide_string(ptr: windows::core::PWSTR) -> String {
    if ptr.0.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0usize;
        while *ptr.0.add(len) != 0 {
            len += 1;
            if len > 512 {
                break;
            }
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr.0, len))
    }
}

#[cfg(target_os = "macos")]
fn probe_macos() -> Vec<AdapterSnapshot> {
    use std::collections::HashSet;
    use std::process::{Command, Stdio};

    let text = Command::new("networksetup")
        .arg("-listallhardwareports")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .unwrap_or_default();
    let running = macos_running_interfaces();
    parse_hardware_ports(&text)
        .into_iter()
        .map(|(device, label)| AdapterSnapshot {
            up: running.contains(&device),
            name: device,
            description: label,
            if_type: None,
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_running_interfaces() -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    use std::ffi::CStr;

    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 || head.is_null() {
        return HashSet::new();
    }
    let mut running = HashSet::new();
    let mut current = head;
    while !current.is_null() {
        let ifa = unsafe { &*current };
        let flags = ifa.ifa_flags;
        let up = flags & (libc::IFF_UP as u32) != 0;
        let live = flags & (libc::IFF_RUNNING as u32) != 0;
        let loopback = flags & (libc::IFF_LOOPBACK as u32) != 0;
        if up && live && !loopback && !ifa.ifa_name.is_null() {
            let name = unsafe { CStr::from_ptr(ifa.ifa_name) }
                .to_string_lossy()
                .into_owned();
            running.insert(name);
        }
        current = ifa.ifa_next;
    }
    unsafe { libc::freeifaddrs(head) };
    running
}

#[cfg(target_os = "linux")]
fn probe_linux() -> Vec<AdapterSnapshot> {
    use std::fs;

    let mut out = Vec::new();
    let entries = match fs::read_dir("/sys/class/net") {
        Ok(entries) => entries,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let oper = read_sys(&path.join("operstate"));
        let carrier = read_sys(&path.join("carrier"));
        let up = oper == "up" && carrier != "0";
        let wireless = path.join("wireless").exists() || path.join("phy80211").exists();
        let if_type = read_sys(&path.join("type")).parse::<u32>().ok();
        out.push(AdapterSnapshot {
            name,
            description: if wireless {
                "wireless".into()
            } else {
                String::new()
            },
            if_type,
            up,
        });
    }
    out
}

#[cfg(target_os = "linux")]
fn read_sys(path: &std::path::Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(name: &str, description: &str, if_type: Option<u32>, up: bool) -> AdapterSnapshot {
        AdapterSnapshot {
            name: name.into(),
            description: description.into(),
            if_type,
            up,
        }
    }

    #[test]
    fn marks_cable_and_wifi_when_both_are_up() {
        let status = status_from(&[
            snap("Ethernet", "Intel(R) Ethernet Connection", Some(IF_TYPE_ETHERNET), true),
            snap("Wi-Fi", "Intel(R) Wi-Fi 6", Some(IF_TYPE_WIFI), true),
        ]);
        assert!(status.ethernet);
        assert!(status.wifi);
    }

    #[test]
    fn ignores_virtual_adapters_and_links_that_are_down() {
        let status = status_from(&[
            snap(
                "vEthernet (Default Switch)",
                "Hyper-V Virtual Ethernet Adapter",
                Some(IF_TYPE_ETHERNET),
                true,
            ),
            snap("Ethernet", "Realtek PCIe GbE", Some(IF_TYPE_ETHERNET), false),
            snap("docker0", "", Some(ARPHRD_ETHER), true),
            snap("tailscale0", "Tailscale Tunnel", Some(ARPHRD_ETHER), true),
            snap("Ethernet 2", "WAN Miniport (IKEv2)", Some(IF_TYPE_ETHERNET), true),
        ]);
        assert!(!status.ethernet);
        assert!(!status.wifi);
    }

    #[test]
    fn linux_names_split_wifi_and_ethernet() {
        let wifi = status_from(&[snap("wlp2s0", "wireless", Some(ARPHRD_ETHER), true)]);
        assert!(!wifi.ethernet && wifi.wifi);
        let cable = status_from(&[snap("enp3s0", "", Some(ARPHRD_ETHER), true)]);
        assert!(cable.ethernet && !cable.wifi);
    }

    #[test]
    fn macos_hardware_ports_skip_the_thunderbolt_bridge() {
        let status = status_from(&[
            snap("en0", "Wi-Fi", None, true),
            snap("bridge0", "Thunderbolt Bridge", None, true),
            snap("en7", "USB 10/100/1000 LAN", None, true),
        ]);
        assert!(status.ethernet);
        assert!(status.wifi);
    }

    #[test]
    fn ssid_is_not_required() {
        let status = status_from(&[snap("Wi-Fi 2", "Some Other Radio", Some(IF_TYPE_WIFI), true)]);
        assert!(status.wifi);
        assert!(!status.ethernet);
    }

    #[test]
    fn probe_on_this_host_does_not_panic() {
        let _ = probe_local_links();
    }

    #[test]
    fn parses_hardware_port_listing() {
        let text = "\
Hardware Port: Wi-Fi
Device: en0
Ethernet Address: aa:bb

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: cc:dd

Hardware Port: USB 10/100/1000 LAN
Device: en7
Ethernet Address: ee:ff
";
        assert_eq!(
            parse_hardware_ports(text),
            vec![
                ("en0".into(), "Wi-Fi".into()),
                ("bridge0".into(), "Thunderbolt Bridge".into()),
                ("en7".into(), "USB 10/100/1000 LAN".into()),
            ]
        );
    }
}
