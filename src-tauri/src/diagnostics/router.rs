//! Phase 57 R4 — diagnostics outbox transport route (AMS → Cloud → deferred).

use chrono::{DateTime, Utc};

use crate::bridge::client_token;
use crate::bridge::{bridge_configured, BridgeHealth};
use crate::storage::config::AppConfig;

use super::cloud_report;

/// Which path should send the next outbox batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticsTransport {
    /// AMS Bridge ingest (`ingress=ams_bridge` server-side).
    Ams,
    /// Direct Cloud JWT (`ingress=cloud_direct`).
    Cloud,
    /// No live transport — keep outbox pending (R2 backoff).
    Deferred,
}

/// Inputs for pure route selection (unit-tested, no I/O).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectDiagnosticsTransport {
    /// AMS health succeeded (Bridge reachable and `online`).
    pub ams_connected: bool,
    /// Last health advertised `diagnostics-v1`.
    pub ams_diagnostics_capable: bool,
    /// Usable Cloud JWT including `diagnostics.report`.
    pub cloud_direct_ready: bool,
}

/// AMS-first, then Cloud direct, else outbox-only retry (Master §4 / Phase 57 R4).
pub fn select_diagnostics_transport(sel: SelectDiagnosticsTransport) -> DiagnosticsTransport {
    if sel.ams_connected && sel.ams_diagnostics_capable {
        DiagnosticsTransport::Ams
    } else if sel.cloud_direct_ready {
        DiagnosticsTransport::Cloud
    } else {
        DiagnosticsTransport::Deferred
    }
}

pub fn cloud_direct_ready(config: &AppConfig, now: DateTime<Utc>) -> bool {
    cloud_report::cloud_direct_path_ready(config, now)
}

/// Build selection from config + optional AMS health snapshot (flush hook).
pub fn plan_transport_from_health(
    config: &AppConfig,
    now: DateTime<Utc>,
    health_ok: bool,
    health: Option<&BridgeHealth>,
) -> SelectDiagnosticsTransport {
    let ams_diagnostics_capable = health
        .map(|h| h.supports_diagnostics())
        .unwrap_or(false);
    let ams_connected = bridge_configured(config) && health_ok && ams_diagnostics_capable;
    SelectDiagnosticsTransport {
        ams_connected,
        ams_diagnostics_capable,
        cloud_direct_ready: cloud_direct_ready(config, now),
    }
}

pub fn select_transport_from_health(
    config: &AppConfig,
    now: DateTime<Utc>,
    health_ok: bool,
    health: Option<&BridgeHealth>,
) -> DiagnosticsTransport {
    let sel = plan_transport_from_health(config, now, health_ok, health);
    select_diagnostics_transport(sel)
}

/// After AMS POST failure: try Cloud only on transport-level unreachable (like lookup router).
pub fn should_fallback_ams_to_cloud(ams_err: &super::ams_report::AmsDiagnosticsError) -> bool {
    ams_err.is_unreachable()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_ams_when_connected_and_capable() {
        assert_eq!(
            select_diagnostics_transport(SelectDiagnosticsTransport {
                ams_connected: true,
                ams_diagnostics_capable: true,
                cloud_direct_ready: true,
            }),
            DiagnosticsTransport::Ams
        );
        assert_eq!(
            select_diagnostics_transport(SelectDiagnosticsTransport {
                ams_connected: true,
                ams_diagnostics_capable: true,
                cloud_direct_ready: false,
            }),
            DiagnosticsTransport::Ams
        );
    }

    #[test]
    fn cloud_when_ams_not_connected_or_missing_capability() {
        assert_eq!(
            select_diagnostics_transport(SelectDiagnosticsTransport {
                ams_connected: false,
                ams_diagnostics_capable: true,
                cloud_direct_ready: true,
            }),
            DiagnosticsTransport::Cloud
        );
        assert_eq!(
            select_diagnostics_transport(SelectDiagnosticsTransport {
                ams_connected: true,
                ams_diagnostics_capable: false,
                cloud_direct_ready: true,
            }),
            DiagnosticsTransport::Cloud
        );
        assert_eq!(
            select_diagnostics_transport(SelectDiagnosticsTransport {
                ams_connected: false,
                ams_diagnostics_capable: false,
                cloud_direct_ready: true,
            }),
            DiagnosticsTransport::Cloud
        );
    }

    #[test]
    fn deferred_when_no_path() {
        assert_eq!(
            select_diagnostics_transport(SelectDiagnosticsTransport {
                ams_connected: false,
                ams_diagnostics_capable: false,
                cloud_direct_ready: false,
            }),
            DiagnosticsTransport::Deferred
        );
    }

    #[test]
    fn capability_constant_matches_health() {
        assert!(client_token::health_supports_diagnostics(&[
            "lookup".into(),
            "diagnostics-v1".into()
        ]));
        assert!(!client_token::health_supports_diagnostics(&["lookup".into()]));
        assert_eq!(client_token::CAPABILITY_DIAGNOSTICS_V1, "diagnostics-v1");
    }

    #[test]
    fn ams_unreachable_falls_back_to_cloud() {
        use super::super::ams_report::AmsDiagnosticsError;
        let unreachable = AmsDiagnosticsError::Unreachable {
            detail: "down".into(),
        };
        let auth = AmsDiagnosticsError::Unauthorized;
        assert!(should_fallback_ams_to_cloud(&unreachable));
        assert!(!should_fallback_ams_to_cloud(&auth));
    }
}
