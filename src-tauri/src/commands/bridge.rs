//! Tauri IPC for AMS LAN Bridge client (Phase 13 / P4).

use chrono::Utc;
use tauri::State;

use crate::bridge::{
    self, client_token, cloud_lookup, BridgeHealthResult, DiscoveredBridge, HandoffCancelResponse,
    HandoffReadyResponse, LookupRequest, LookupResponse,
};
use crate::bridge::cloud_lookup::CloudLookupProbeResult;
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

fn persist_server_identity(
    state: &ConfigState,
    display_name: &str,
    instance_id: &str,
) -> Result<(), String> {
    let name = display_name.trim();
    let id = instance_id.trim();
    if name.is_empty() && id.is_empty() {
        return Ok(());
    }
    let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
    let mut changed = false;
    if !name.is_empty() && cache.ams_bridge_display_name != name {
        cache.ams_bridge_display_name = name.to_string();
        changed = true;
    }
    if !id.is_empty() && cache.ams_bridge_server_instance_id != id {
        cache.ams_bridge_server_instance_id = id.to_string();
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    let cfg = cache.clone();
    drop(cache);
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store.save(&cfg).map_err(|e| e.to_string())?;
    Ok(())
}

fn persist_cloud_lookup_token(
    state: &ConfigState,
    stored: &client_token::StoredClientToken,
) -> Result<(), String> {
    let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
    client_token::apply_to_config(&mut cache, stored);
    let cfg = cache.clone();
    drop(cache);
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store.save(&cfg).map_err(|e| e.to_string())?;
    Ok(())
}

fn clear_cloud_lookup_token(state: &ConfigState) -> Result<(), String> {
    let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
    if cache.cloud_lookup_access_token.trim().is_empty() {
        return Ok(());
    }
    client_token::clear_in_config(&mut cache);
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
    if result.ok {
        if overrides.base_url.is_none() && overrides.token.is_none() && !result.base_url.is_empty()
        {
            let _ = persist_last_ok(&state, &result.base_url);
        }
        if let Some(health) = result.health.as_ref() {
            let _ = persist_server_identity(&state, &health.display_name, &health.instance_id);
            // Phase 53 / T0: proactive Cloud JWT refresh when AMS advertises cloud-lookup-v1.
            // Skip when health uses ephemeral overrides (settings draft probe).
            if overrides.base_url.is_none()
                && overrides.token.is_none()
                && health.supports_cloud_lookup()
            {
                let config_for_refresh = state
                    .cache
                    .lock()
                    .map(|c| c.clone())
                    .unwrap_or_else(|_| config.clone());
                let refreshed = client_token::maybe_refresh_after_health(
                    &config_for_refresh,
                    &result.base_url,
                    config_for_refresh.ams_bridge_token.as_str(),
                    health.instance_id.as_str(),
                    &health.capabilities,
                    Utc::now(),
                )
                .await;
                if let Some(stored) = refreshed.as_ref() {
                    let _ = persist_cloud_lookup_token(&state, stored);
                }
            }
        }
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
    let req = LookupRequest {
        customer_id,
        booking_id,
        marker_type,
        mode: mode.unwrap_or_else(|| "hash".into()),
    };
    // Phase 53 / T2: AMS-first router (Cloud fallback). All form/QR lookup consumers share this.
    match bridge::lookup_router::routed_customer_lookup(&config, &req, Utc::now()).await {
        Ok(ok) => {
            if ok.response.ok && ok.via == bridge::lookup_router::LookupBackend::Ams {
                if let Ok(base) = bridge::resolve_bridge_base_url(&config) {
                    let _ = persist_last_ok(&state, &base);
                }
            }
            Ok(ok.response)
        }
        Err(err) => {
            if err.should_clear_cloud_token() {
                let _ = clear_cloud_lookup_token(&state);
            }
            Err(err.into())
        }
    }
}

/// Preflight using form `Kunde` (hash/id auto-detected). Soft when bridge down.
/// Phase 53: Create-preflight stays AMS-only — never routed through Cloud.
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
    let job = bridge::fetch_job_status(&base, &config.ams_bridge_token, &correlation_id, &identity)
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

/// ATS aborted upload — notify AMS to drop pending handoff.
#[tauri::command]
pub async fn ams_bridge_handoff_cancel(
    state: State<'_, ConfigState>,
    correlation_id: String,
    folder_name: Option<String>,
    reason: Option<String>,
) -> Result<HandoffCancelResponse, String> {
    let config = ensure_ams_bridge_identity(&state)?;
    let base = bridge::resolve_bridge_base_url(&config)?;
    let identity = bridge::build_ats_bridge_identity(&config);
    let resp = bridge::notify_handoff_cancel(
        &base,
        &config.ams_bridge_token,
        &correlation_id,
        folder_name.as_deref(),
        reason.as_deref(),
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

/// Phase 53: probe Cloud Lookup with stored JWT (dummy ids). Soft `ok: false` when no token.
/// On 401 clears persisted Cloud JWT.
#[tauri::command]
pub async fn cloud_lookup_probe(
    state: State<'_, ConfigState>,
) -> Result<CloudLookupProbeResult, String> {
    let config = ensure_ams_bridge_identity(&state)?;
    let identity = bridge::build_ats_bridge_identity(&config);
    let result = cloud_lookup::probe_stored_token(&config, &identity, Utc::now()).await;
    if result.token_cleared {
        let _ = clear_cloud_lookup_token(&state);
    }
    if result.ok {
        crate::storage::logging::info(
            "bridge",
            format!(
                "Cloud-Lookup Probe OK (cloud_base_url={})",
                result.cloud_base_url
            ),
        );
    } else if result.status != cloud_lookup::CloudLookupProbeStatus::NoToken {
        crate::storage::logging::info(
            "bridge",
            format!(
                "Cloud-Lookup Probe: status={:?} — {}",
                result.status, result.message
            ),
        );
    }
    Ok(result)
}
