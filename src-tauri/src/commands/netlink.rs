//! Local link type for the setup wizard (cable vs Wi-Fi). No SSID lookup.

use crate::netlink::{probe_local_links, LocalLinkStatus};

/// Active physical links. Virtual adapters (Docker, VPN, Hyper-V, …) are ignored.
/// Failure yields both flags false — the wizard stays neutral.
#[tauri::command]
pub async fn local_link_status() -> LocalLinkStatus {
    tokio::task::spawn_blocking(probe_local_links)
        .await
        .unwrap_or_default()
}
