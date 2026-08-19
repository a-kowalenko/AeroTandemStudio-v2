//! Tauri IPC for AMS LAN Bridge client (Phase 13 / P4).

use tauri::State;

use crate::bridge::{
    self, BridgeHealthResult, DiscoveredBridge, HandoffReadyResponse, LookupRequest, LookupResponse,
};
use crate::commands::config::{ensure_ams_bridge_identity, ConfigState};
use crate::model::Kunde;
use crate::video::handoff_manifest::StatusOutboxV1;

fn persist_last_ok(state: &ConfigState, base_url: &str) -> Result<(), String> {
    let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
    if cache.ams_bridge_last_ok_url == base_url {
        return Ok(());
    }
    cache.ams_bridge_last_ok_url = base_url.to_string();
    let cfg = cache.clone();
    drop(cache);
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store.save(&cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct BridgeHealthOverrides {
    #[serde(alias = "baseUrl")]
    pub base_url: Option<String>,
    pub token: Option<String>,
}

#[tauri::command]
pub async fn ams_bridge_health(
    state: State<'_, ConfigState>,
    overrides: Option<BridgeHealthOverrides>,
) -> Result<BridgeHealthResult, String> {
    let config = ensure_ams_bridge_identity(&state)?;
    let overrides = overrides.unwrap_or_default();
    let result = bridge::check_health_with(
        &config,
        overrides.base_url.as_deref(),
        overrides.token.as_deref(),
    )
    .await;
    if overrides.base_url.is_none() && overrides.token.is_none() && result.ok && !result.base_url.is_empty() {
        let _ = persist_last_ok(&state, &result.base_url);
    }
    Ok(result)
}

#[tauri::command]
pub async fn ams_bridge_customer_lookup(
    state: State<'_, ConfigState>,
    customer_id: String,
    booking_id: String,
    marker_type: String,
    mode: Option<String>,
) -> Result<LookupResponse, String> {
    let config = ensure_ams_bridge_identity(&state)?;
    let base = bridge::resolve_bridge_base_url(&config)?;
    let identity = bridge::build_ats_bridge_identity(&config);
    let req = LookupRequest {
        customer_id,
        booking_id,
        marker_type,
        mode: mode.unwrap_or_else(|| "hash".into()),
    };
    let resp = bridge::customer_lookup(
        &base,
        &config.ams_bridge_token,
        &req,
        &identity,
    )
    .await?;
    if resp.ok {
        let _ = persist_last_ok(&state, &base);
    }
    Ok(resp)
}

/// Preflight using form `Kunde` (hash/id auto-detected). Soft when bridge down.
#[tauri::command]
pub async fn ams_bridge_preflight(
    state: State<'_, ConfigState>,
    kunde: Kunde,
) -> Result<Option<LookupResponse>, String> {
    let config = ensure_ams_bridge_identity(&state)?;
    bridge::preflight_customer_lookup(&config, &kunde).await
}

/// Job status via Bridge (`GET /v1/jobs/{correlation_id}`).
#[tauri::command]
pub async fn ams_bridge_job_status(
    state: State<'_, ConfigState>,
    correlation_id: String,
) -> Result<Option<StatusOutboxV1>, String> {
    let config = ensure_ams_bridge_identity(&state)?;
    let base = bridge::resolve_bridge_base_url(&config)?;
    let identity = bridge::build_ats_bridge_identity(&config);
    let job = bridge::fetch_job_status(
        &base,
        &config.ams_bridge_token,
        &correlation_id,
        &identity,
    )
    .await?;
    if job.is_some() {
        let _ = persist_last_ok(&state, &base);
    }
    Ok(job)
}

/// Optional monitor wake after Manifest + `_fertig.txt`.
#[tauri::command]
pub async fn ams_bridge_handoff_ready(
    state: State<'_, ConfigState>,
    correlation_id: String,
    folder_name: Option<String>,
) -> Result<HandoffReadyResponse, String> {
    let config = ensure_ams_bridge_identity(&state)?;
    let base = bridge::resolve_bridge_base_url(&config)?;
    let identity = bridge::build_ats_bridge_identity(&config);
    let resp = bridge::notify_handoff_ready(
        &base,
        &config.ams_bridge_token,
        &correlation_id,
        folder_name.as_deref(),
        &identity,
    )
    .await?;
    if resp.ok {
        let _ = persist_last_ok(&state, &base);
    }
    Ok(resp)
}

/// LAN mDNS browse for `_ams-bridge._tcp` (P4). Soft empty list on failure.
#[tauri::command]
pub async fn ams_bridge_discover(
    timeout_secs: Option<u64>,
) -> Result<Vec<DiscoveredBridge>, String> {
    match bridge::discover_bridges(timeout_secs).await {
        Ok(list) => Ok(list),
        Err(e) => {
            crate::storage::logging::warn("bridge", format!("mDNS Discovery: {e}"));
            Ok(Vec::new())
        }
    }
}
