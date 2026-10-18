//! Wire-shaped diagnostic event payloads (Phase 57).

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::bridge::build_ats_bridge_identity;
use crate::storage::AppConfig;

use super::breadcrumbs::snapshot_breadcrumbs;
use super::fingerprint::event_fingerprint;
use super::redaction::{redact_details, redact_message};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticWireEvent {
    pub event_id: String,
    pub occurred_at: String,
    pub severity: String,
    pub category: String,
    pub code: String,
    pub fingerprint: String,
    pub occurrence_count: u32,
    pub message: String,
    pub app_version: String,
    pub ats_app: String,
    pub platform: String,
    pub arch: String,
    pub ats_hostname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub breadcrumbs: Vec<super::breadcrumbs::Breadcrumb>,
}

/// Input for a single capture (R4) or test enqueue.
#[derive(Debug, Clone)]
pub struct DiagnosticCaptureInput {
    pub severity: &'static str,
    pub category: &'static str,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl DiagnosticCaptureInput {
    pub fn new(
        severity: &'static str,
        category: &'static str,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            severity,
            category,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

/// Build redacted wire JSON + stable fingerprint for outbox storage.
pub fn build_wire_event(
    config: &AppConfig,
    input: &DiagnosticCaptureInput,
) -> (DiagnosticWireEvent, String) {
    let redacted_message = redact_message(&input.message);
    let fingerprint = event_fingerprint(&input.code, &redacted_message, input.category);
    let identity = build_ats_bridge_identity(config);
    let details = input
        .details
        .clone()
        .map(redact_details);

    let event = DiagnosticWireEvent {
        event_id: Uuid::new_v4().to_string(),
        occurred_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        severity: input.severity.to_string(),
        category: input.category.to_string(),
        code: input.code.clone(),
        fingerprint: fingerprint.clone(),
        occurrence_count: 1,
        message: redacted_message,
        app_version: identity.ats_version().to_string(),
        ats_app: identity.ats_app().to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        ats_hostname: identity.hostname().to_string(),
        details,
        breadcrumbs: snapshot_breadcrumbs(),
    };
    (event, fingerprint)
}

pub fn wire_event_to_json(event: &DiagnosticWireEvent) -> Result<String, serde_json::Error> {
    serde_json::to_string(event)
}

pub fn merge_wire_events(existing: &DiagnosticWireEvent, incoming: &DiagnosticWireEvent) -> DiagnosticWireEvent {
    let mut merged = existing.clone();
    merged.occurrence_count = existing
        .occurrence_count
        .saturating_add(incoming.occurrence_count.max(1));
    merged.occurred_at = incoming.occurred_at.clone();
    merged.message = incoming.message.clone();
    if incoming.details.is_some() {
        merged.details = incoming.details.clone();
    }
    merged.breadcrumbs = incoming.breadcrumbs.clone();
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::breadcrumbs::{
        clear_breadcrumbs_for_test, push_breadcrumb, BREADCRUMB_TEST_LOCK,
    };

    #[test]
    fn payload_includes_redacted_message_and_breadcrumbs() {
        let _g = BREADCRUMB_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        clear_breadcrumbs_for_test();
        push_breadcrumb("export.start", None);
        let cfg = AppConfig::default();
        let input = DiagnosticCaptureInput {
            severity: "error",
            category: "export",
            code: "TEST".into(),
            message: "failed /Users/alice/out.mp4".into(),
            details: Some(serde_json::json!({ "path": "C:\\secret\\x.mp4" })),
        };
        let (ev, fp) = build_wire_event(&cfg, &input);
        assert!(ev.message.contains("[REDACTED]"));
        assert!(!ev.message.contains("/Users/alice"));
        assert_eq!(ev.fingerprint, fp);
        assert_eq!(ev.breadcrumbs.len(), 1);
        assert_eq!(ev.breadcrumbs[0].action, "export.start");
        clear_breadcrumbs_for_test();
    }
}
