//! Phase 57 — client diagnostics (breadcrumbs, redaction, fingerprint, outbox).
//! Cloud/AMS transport and capture hooks: R3/R4.

pub mod actions;
pub mod ams_report;
pub mod breadcrumbs;
pub mod capture;
pub mod cloud_report;
pub mod cloud_transport;
pub mod event;
pub mod fingerprint;
pub mod flush;
pub mod outbox;
pub mod redaction;
pub mod router;

#[allow(unused_imports)] // R3/R4 capture + transport
pub use breadcrumbs::{push_breadcrumb, snapshot_breadcrumbs, Breadcrumb, BREADCRUMB_CAP};
#[allow(unused_imports)]
pub use event::{build_wire_event, DiagnosticCaptureInput, DiagnosticWireEvent};
#[allow(unused_imports)]
pub use fingerprint::event_fingerprint;
#[allow(unused_imports)]
pub use cloud_transport::init_cloud_outbox_transport;
pub use flush::{request_diagnostics_flush, spawn_diagnostics_outbox_flusher, FlushSendOutcome};
#[allow(unused_imports)]
pub use outbox::{DiagnosticsOutboxStore, OutboxError, OUTBOX_MAX_QUEUE};
#[allow(unused_imports)]
pub use redaction::{redact_details, redact_message};

/// Shared gate for capture, outbox enqueue, and background flush (Phase 57 R0/R2/R4).
#[inline]
pub(crate) fn send_error_reports_enabled(config: &crate::storage::config::AppConfig) -> bool {
    config.send_error_reports
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    use crate::storage::config::AppConfig;

    #[test]
    fn send_error_reports_enabled_defaults_on() {
        assert!(send_error_reports_enabled(&AppConfig::default()));
    }

    #[test]
    fn send_error_reports_disabled_when_config_off() {
        let mut cfg = AppConfig::default();
        cfg.send_error_reports = false;
        assert!(!send_error_reports_enabled(&cfg));
    }
}
