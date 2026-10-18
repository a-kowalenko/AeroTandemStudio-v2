//! Phase 57 R4 — enqueue diagnostic events from user-visible failures.

use tauri::{AppHandle, Manager};

use crate::bridge::http::BridgeError;
use crate::bridge::lookup_router::RoutedLookupError;
use crate::commands::config::ConfigState;
use crate::storage::logging;

use super::event::DiagnosticCaptureInput;
use super::flush::request_diagnostics_flush;
use super::outbox::DiagnosticsOutboxStore;

/// Enqueue a redacted event when `send_error_reports` is enabled; wake flusher.
pub fn capture_diagnostic(app: &AppHandle, input: DiagnosticCaptureInput) {
    let Some(state) = app.try_state::<ConfigState>() else {
        return;
    };
    let config = match state.cache.lock() {
        Ok(c) => c.clone(),
        Err(_) => return,
    };
    if !super::send_error_reports_enabled(&config) {
        return;
    }
    let store = match DiagnosticsOutboxStore::open_default() {
        Ok(s) => s,
        Err(e) => {
            logging::debug("diagnostics", format!("Capture: Outbox öffnen: {e}"));
            return;
        }
    };
    match store.enqueue_if_enabled(&config, &input) {
        Ok(Some(_)) => request_diagnostics_flush(),
        Ok(None) => {}
        Err(e) => {
            logging::debug("diagnostics", format!("Capture: enqueue: {e}"));
        }
    }
}

pub fn capture_routed_lookup_error(app: &AppHandle, err: &RoutedLookupError) {
    let (code, message) = match err {
        RoutedLookupError::Unreachable(_) => return,
        RoutedLookupError::Ams(e) => (
            e.api_code()
                .unwrap_or("bridge.ams")
                .to_string(),
            e.to_string(),
        ),
        RoutedLookupError::Cloud(e) => (
            e.api_code()
                .unwrap_or("bridge.cloud")
                .to_string(),
            e.to_string(),
        ),
    };
    capture_diagnostic(
        app,
        DiagnosticCaptureInput::new("error", "bridge", code, message),
    );
}

pub fn capture_bridge_error(app: &AppHandle, code: &str, err: &BridgeError) {
    if err.is_unreachable() {
        return;
    }
    capture_diagnostic(
        app,
        DiagnosticCaptureInput::new("error", "bridge", code, err.to_string()),
    );
}

pub fn capture_export_fatal(app: &AppHandle, message: impl Into<String>) {
    capture_diagnostic(
        app,
        DiagnosticCaptureInput::new("error", "export", "export.failed", message),
    );
}

pub fn capture_smb_fatal(app: &AppHandle, message: impl Into<String>) {
    capture_diagnostic(
        app,
        DiagnosticCaptureInput::new("error", "smb", "smb.upload.failed", message),
    );
}
