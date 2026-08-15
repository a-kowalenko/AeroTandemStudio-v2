//! mDNS browse for AMS LAN Bridge (Phase 13 / P4).
//! Soft: empty list when discovery fails / times out — manual URL still works.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::{Deserialize, Serialize};

/// Must match AMS `bridge::mdns::SERVICE_TYPE`.
pub const SERVICE_TYPE: &str = "_ams-bridge._tcp.local.";

const DEFAULT_BROWSE_SECS: u64 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredBridge {
    pub instance: String,
    pub host: String,
    pub port: u16,
    pub base_url: String,
    pub version: String,
    pub capabilities: Vec<String>,
    pub monitor_path: String,
}

pub fn prefer_http_host(addrs: impl IntoIterator<Item = IpAddr>) -> Option<String> {
    let mut v4: Vec<IpAddr> = Vec::new();
    let mut v6: Vec<IpAddr> = Vec::new();
    for a in addrs {
        match a {
            IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_loopback() => v4.push(a),
            IpAddr::V6(ip) if !ip.is_unspecified() && !ip.is_loopback() => v6.push(a),
            _ => {}
        }
    }
    v4.sort_by_key(|a| match a {
        IpAddr::V4(ip) if ip.is_link_local() => 0u8,
        IpAddr::V4(ip) if ip.is_private() => 1,
        _ => 2,
    });
    v4.into_iter()
        .next()
        .or_else(|| v6.into_iter().next())
        .map(|ip| match ip {
            IpAddr::V6(v) => format!("[{v}]"),
            IpAddr::V4(v) => v.to_string(),
        })
}

pub fn base_url_for(host: &str, port: u16) -> String {
    format!("http://{host}:{port}")
}

/// Browse LAN for `_ams-bridge._tcp` for up to `timeout_secs` (default 3).
pub async fn discover_bridges(timeout_secs: Option<u64>) -> Result<Vec<DiscoveredBridge>, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_BROWSE_SECS).max(1));
    tauri::async_runtime::spawn_blocking(move || discover_bridges_blocking(timeout))
        .await
        .map_err(|e| format!("mDNS Discovery Task: {e}"))?
}

fn discover_bridges_blocking(timeout: Duration) -> Result<Vec<DiscoveredBridge>, String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS Daemon: {e}"))?;
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("mDNS Browse: {e}"))?;

    let deadline = std::time::Instant::now() + timeout;
    let mut found: HashMap<String, DiscoveredBridge> = HashMap::new();

    while std::time::Instant::now() < deadline {
        let wait = deadline.saturating_duration_since(std::time::Instant::now());
        if wait.is_zero() {
            break;
        }
        match receiver.recv_timeout(wait) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let port = info.get_port();
                let Some(host) = prefer_http_host(
                    info.get_addresses().iter().map(|a| a.to_ip_addr()),
                ) else {
                    continue;
                };
                let fullname = info.get_fullname().to_string();
                let instance = fullname
                    .split('.')
                    .next()
                    .unwrap_or(info.get_hostname())
                    .to_string();
                let version = info
                    .get_property_val_str("ver")
                    .unwrap_or("")
                    .to_string();
                let caps = info
                    .get_property_val_str("caps")
                    .unwrap_or("")
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
                let monitor_path = info
                    .get_property_val_str("path")
                    .unwrap_or("")
                    .to_string();
                found.insert(
                    fullname,
                    DiscoveredBridge {
                        instance,
                        host: host.clone(),
                        port,
                        base_url: base_url_for(&host, port),
                        version,
                        capabilities: caps,
                        monitor_path,
                    },
                );
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }

    let _ = daemon.shutdown();
    let mut list: Vec<_> = found.into_values().collect();
    list.sort_by(|a, b| a.instance.cmp(&b.instance).then(a.base_url.cmp(&b.base_url)));
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn prefer_link_local() {
        let h = prefer_http_host([
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 10, 20)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ])
        .unwrap();
        assert_eq!(h, "169.254.10.20");
    }

    #[test]
    fn service_type_matches_ams() {
        assert_eq!(SERVICE_TYPE, "_ams-bridge._tcp.local.");
    }
}
