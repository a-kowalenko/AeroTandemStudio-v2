//! Wire outbox flush hook → AMS-first, then Cloud diagnostics HTTP (Phase 57 R3/R4).

use std::sync::OnceLock;

use chrono::Utc;
use tauri::{AppHandle, Manager};

use crate::bridge::build_ats_bridge_identity;
use crate::bridge::client_token;
use crate::bridge::{self, resolve_bridge_base_url};
use crate::commands::config::ConfigState;
use crate::storage::logging;

use super::ams_report;
use super::cloud_report;
use super::event::DiagnosticWireEvent;
use super::flush::{set_flush_send_hook, FlushSendOutcome};
use super::outbox::OutboxRow;
use super::router::{
    select_transport_from_health, should_fallback_ams_to_cloud, DiagnosticsTransport,
};

static FLUSH_APP: OnceLock<AppHandle> = OnceLock::new();

/// Install AMS/Cloud batch sender for the R2 outbox flusher (call once at startup).
pub fn init_cloud_outbox_transport(app: AppHandle) {
    let _ = FLUSH_APP.set(app);
    let _ = set_flush_send_hook(outbox_send_hook);
}

fn outbox_send_hook(rows: &[OutboxRow]) -> FlushSendOutcome {
    let Some(app) = FLUSH_APP.get() else {
        return FlushSendOutcome::Deferred;
    };
    match try_flush_rows(app, rows) {
        FlushAttemptResult::Sent => FlushSendOutcome::Sent,
        FlushAttemptResult::Deferred => FlushSendOutcome::Deferred,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlushAttemptResult {
    Sent,
    Deferred,
}

fn try_flush_rows(app: &AppHandle, rows: &[OutboxRow]) -> FlushAttemptResult {
    if rows.is_empty() {
        return FlushAttemptResult::Deferred;
    }
    let state = match app.try_state::<ConfigState>() {
        Some(s) => s,
        None => return FlushAttemptResult::Deferred,
    };
    let config = match state.cache.lock() {
        Ok(c) => c.clone(),
        Err(_) => return FlushAttemptResult::Deferred,
    };
    let events = parse_wire_events(rows);
    if events.is_empty() {
        return FlushAttemptResult::Deferred;
    }
    let now = Utc::now();
    let identity = build_ats_bridge_identity(&config);

    let health_result = if bridge::bridge_configured(&config) {
        tauri::async_runtime::block_on(bridge::check_health(&config))
    } else {
        bridge::BridgeHealthResult {
            ok: false,
            message: String::new(),
            health: None,
            base_url: String::new(),
        }
    };

    let route = select_transport_from_health(
        &config,
        now,
        health_result.ok,
        health_result.health.as_ref(),
    );

    match route {
        DiagnosticsTransport::Ams => flush_via_ams(&config, &events, &identity, &state),
        DiagnosticsTransport::Cloud => flush_via_cloud(app, &config, &events, &identity, &state),
        DiagnosticsTransport::Deferred => FlushAttemptResult::Deferred,
    }
}

fn flush_via_ams(
    config: &crate::storage::config::AppConfig,
    events: &[DiagnosticWireEvent],
    identity: &bridge::AtsBridgeIdentity,
    state: &ConfigState,
) -> FlushAttemptResult {
    let base = match resolve_bridge_base_url(config) {
        Ok(u) => u,
        Err(_) => return FlushAttemptResult::Deferred,
    };
    let token = config.ams_bridge_token.as_str();
    let send = tauri::async_runtime::block_on(ams_report::post_events(
        &base, token, events, identity,
    ));
    match send {
        Ok(_) => FlushAttemptResult::Sent,
        Err(e) if should_fallback_ams_to_cloud(&e) => {
            logging::debug(
                "diagnostics",
                format!("AMS-Diagnostik unreachable — fallback Cloud: {e}"),
            );
            flush_via_cloud_from_config(config, events, identity, state)
        }
        Err(e) => {
            logging::debug("diagnostics", format!("AMS-Diagnostik Flush: {e}"));
            FlushAttemptResult::Deferred
        }
    }
}

fn flush_via_cloud(
    app: &AppHandle,
    config: &crate::storage::config::AppConfig,
    events: &[DiagnosticWireEvent],
    identity: &bridge::AtsBridgeIdentity,
    state: &ConfigState,
) -> FlushAttemptResult {
    let _ = app;
    flush_via_cloud_from_config(config, events, identity, state)
}

fn flush_via_cloud_from_config(
    config: &crate::storage::config::AppConfig,
    events: &[DiagnosticWireEvent],
    identity: &bridge::AtsBridgeIdentity,
    state: &ConfigState,
) -> FlushAttemptResult {
    let now = Utc::now();
    if !cloud_report::cloud_direct_path_ready(config, now) {
        return FlushAttemptResult::Deferred;
    }
    let stored = match client_token::load_from_config(config) {
        Some(t) => t,
        None => return FlushAttemptResult::Deferred,
    };
    let send = tauri::async_runtime::block_on(cloud_report::post_events(
        &stored.cloud_base_url,
        &stored.access_token,
        events,
        identity,
    ));
    match send {
        Ok(_) => FlushAttemptResult::Sent,
        Err(e) if e.is_token_invalid() => {
            if let Err(clear_err) = clear_persisted_cloud_token(state) {
                logging::warn(
                    "diagnostics",
                    format!("Cloud-JWT nach 401 löschen fehlgeschlagen: {clear_err}"),
                );
            } else {
                logging::info(
                    "diagnostics",
                    "Cloud-JWT nach Diagnostik-401 gelöscht (Refresh über AMS).",
                );
            }
            FlushAttemptResult::Deferred
        }
        Err(e) => {
            logging::debug("diagnostics", format!("Cloud-Diagnostik Flush: {e}"));
            FlushAttemptResult::Deferred
        }
    }
}

fn parse_wire_events(rows: &[OutboxRow]) -> Vec<DiagnosticWireEvent> {
    rows.iter()
        .filter_map(|row| serde_json::from_str(&row.payload_json).ok())
        .collect()
}

fn clear_persisted_cloud_token(state: &ConfigState) -> Result<(), String> {
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

/// Pure planning for unit tests (JWT + scope gate, event parse).
#[cfg(test)]
pub(crate) fn cloud_flush_plan(
    config: &crate::storage::config::AppConfig,
    rows: &[OutboxRow],
    now: chrono::DateTime<Utc>,
) -> Option<(String, String, Vec<DiagnosticWireEvent>)> {
    if !cloud_report::cloud_direct_path_ready(config, now) {
        return None;
    }
    let stored = client_token::load_from_config(config)?;
    let events = parse_wire_events(rows);
    if events.is_empty() {
        return None;
    }
    Some((
        stored.cloud_base_url.clone(),
        stored.access_token.clone(),
        events,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::client_token::{self, StoredClientToken};
    use crate::diagnostics::cloud_report::SCOPE_DIAGNOSTICS_REPORT;
    use crate::diagnostics::event::{build_wire_event, DiagnosticCaptureInput};
    use crate::diagnostics::outbox::{DiagnosticsOutboxStore, OUTBOX_STATUS_PENDING};
    use crate::diagnostics::router::{
        select_diagnostics_transport, SelectDiagnosticsTransport, DiagnosticsTransport,
    };
    use crate::storage::config::AppConfig;
    use chrono::{Duration, Utc};

    fn jwt_with_scope(scopes: &[&str]) -> String {
        let payload = serde_json::json!({ "scope": scopes }).to_string();
        let payload_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            payload.as_bytes(),
        );
        format!("eyJhbGciOiJIUzI1NiJ9.{payload_b64}.sig")
    }

    fn sample_row(payload: &str) -> OutboxRow {
        OutboxRow {
            event_id: "ev-1".into(),
            payload_json: payload.into(),
            fingerprint: "fp".into(),
            created_at: 0,
            next_retry_at: 0,
            attempts: 0,
            status: OUTBOX_STATUS_PENDING.into(),
        }
    }

    #[test]
    fn plan_skips_without_diagnostics_scope() {
        let mut cfg = AppConfig::default();
        let future = (Utc::now() + Duration::hours(30)).to_rfc3339();
        let mut stored = StoredClientToken {
            access_token: jwt_with_scope(&["customer.lookup"]),
            expires_at: future.clone(),
            cloud_base_url: "https://cloud.example".into(),
            ams_server_instance_id: "ams-1".into(),
        };
        client_token::sanitize_stored(&mut stored);
        client_token::apply_to_config(&mut cfg, &stored);

        let (wire, _) = build_wire_event(
            &cfg,
            &DiagnosticCaptureInput::new("error", "export", "C", "m"),
        );
        let payload = serde_json::to_string(&wire).unwrap();
        let rows = vec![sample_row(&payload)];

        assert!(cloud_flush_plan(&cfg, &rows, Utc::now()).is_none());
    }

    #[test]
    fn plan_ready_with_scope_and_parses_batch() {
        let mut cfg = AppConfig::default();
        let future = (Utc::now() + Duration::hours(30)).to_rfc3339();
        let mut stored = StoredClientToken {
            access_token: jwt_with_scope(&["customer.lookup", SCOPE_DIAGNOSTICS_REPORT]),
            expires_at: future,
            cloud_base_url: "https://cloud.example".into(),
            ams_server_instance_id: "ams-1".into(),
        };
        client_token::sanitize_stored(&mut stored);
        client_token::apply_to_config(&mut cfg, &stored);

        let (wire, _) = build_wire_event(
            &cfg,
            &DiagnosticCaptureInput::new("error", "export", "C", "m"),
        );
        let payload = serde_json::to_string(&wire).unwrap();
        let rows = vec![sample_row(&payload)];

        let plan = cloud_flush_plan(&cfg, &rows, Utc::now()).expect("plan");
        assert_eq!(plan.0, "https://cloud.example");
        assert_eq!(plan.2.len(), 1);
        assert_eq!(plan.2[0].code, "C");
    }

    #[test]
    fn parse_events_from_outbox_enqueue() {
        let dir = tempfile::tempdir().unwrap();
        let store = DiagnosticsOutboxStore::open_at(dir.path().join("d.db")).unwrap();
        let cfg = AppConfig::default();
        let id = store
            .enqueue_with_config(
                &cfg,
                &DiagnosticCaptureInput::new("error", "bridge", "X", "msg"),
            )
            .unwrap();
        let row = store.get_row(&id).unwrap().unwrap();
        let events = parse_wire_events(&[row]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].category, "bridge");
    }

    #[test]
    fn router_priority_ams_over_cloud() {
        assert_eq!(
            select_diagnostics_transport(SelectDiagnosticsTransport {
                ams_connected: true,
                ams_diagnostics_capable: true,
                cloud_direct_ready: true,
            }),
            DiagnosticsTransport::Ams
        );
    }
}
