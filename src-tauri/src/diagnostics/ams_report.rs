//! Phase 57 R4 — AMS Bridge diagnostics events HTTP client.
//! Master §3 · same JSON batch as Cloud direct path.

use std::fmt;

use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::bridge::http::{self, decode_body, Endpoint};
use crate::bridge::{bridge_prepare, AtsBridgeIdentity, BridgeError};

use super::cloud_report::DiagnosticsEventsResponse;
use super::event::DiagnosticWireEvent;

/// Wire path on AMS Bridge (Master §3).
pub const EVENTS_PATH: &str = "/v1/diagnostics/events";

/// Typed AMS diagnostics failure (no JWT clear — Bridge token is separate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AmsDiagnosticsError {
    Config(String),
    Unreachable { detail: String },
    Timeout,
    Unauthorized,
    Http { status: u16, snippet: String },
    Protocol { status: u16, detail: String },
    Api { code: String, message: String },
}

impl AmsDiagnosticsError {
    pub fn is_unreachable(&self) -> bool {
        matches!(
            self,
            AmsDiagnosticsError::Unreachable { .. } | AmsDiagnosticsError::Timeout
        )
    }
}

impl fmt::Display for AmsDiagnosticsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AmsDiagnosticsError::Config(msg) => f.write_str(msg),
            AmsDiagnosticsError::Unreachable { detail } => {
                write!(f, "AMS-Diagnostik nicht erreichbar: {detail}")
            }
            AmsDiagnosticsError::Timeout => write!(
                f,
                "AMS-Diagnostik nicht erreichbar: Zeitüberschreitung nach {}s",
                Endpoint::AmsDiagnostics.timeout().as_secs()
            ),
            AmsDiagnosticsError::Unauthorized => {
                f.write_str("AMS-Diagnostik: Bridge-Token ungültig (401).")
            }
            AmsDiagnosticsError::Http { status, snippet } => {
                write!(f, "AMS-Diagnostik fehlgeschlagen: HTTP {status}")?;
                if !snippet.is_empty() {
                    write!(f, " {snippet}")?;
                }
                Ok(())
            }
            AmsDiagnosticsError::Protocol { status, detail } => {
                write!(f, "AMS-Diagnostik JSON (HTTP {status}): {detail}")
            }
            AmsDiagnosticsError::Api { code, message } => {
                if code.is_empty() {
                    f.write_str(message)
                } else {
                    write!(f, "{code}: {message}")
                }
            }
        }
    }
}

impl std::error::Error for AmsDiagnosticsError {}

pub fn map_bridge_error(err: BridgeError) -> AmsDiagnosticsError {
    match err {
        BridgeError::Config(msg) => AmsDiagnosticsError::Config(msg),
        BridgeError::Unauthorized => AmsDiagnosticsError::Unauthorized,
        BridgeError::Unreachable { detail, .. } => AmsDiagnosticsError::Unreachable { detail },
        BridgeError::Timeout { .. } => AmsDiagnosticsError::Timeout,
        BridgeError::Http {
            status, snippet, ..
        } => AmsDiagnosticsError::Http { status, snippet },
        BridgeError::Protocol {
            status, detail, ..
        } => AmsDiagnosticsError::Protocol { status, detail },
        BridgeError::Api { code, message } => AmsDiagnosticsError::Api { code, message },
    }
}

#[derive(Debug, Serialize)]
struct DiagnosticsEventsRequest<'a> {
    events: &'a [DiagnosticWireEvent],
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct DiagnosticsEventsErrorBody {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct DiagnosticsEventsEnvelope {
    ok: bool,
    #[serde(default)]
    accepted: u32,
    #[serde(default)]
    duplicates: u32,
    #[serde(default)]
    error: Option<DiagnosticsEventsErrorBody>,
}

/// `POST {ams}/v1/diagnostics/events` with Bridge token + ATS identity headers.
pub async fn post_events(
    base_url: &str,
    bridge_token: &str,
    events: &[DiagnosticWireEvent],
    identity: &AtsBridgeIdentity,
) -> Result<DiagnosticsEventsResponse, AmsDiagnosticsError> {
    if events.is_empty() {
        return Err(AmsDiagnosticsError::Config(
            "Diagnostik-Batch ist leer.".into(),
        ));
    }
    let (base, auth) = bridge_prepare(base_url, bridge_token).map_err(map_bridge_error)?;
    let url = format!("{base}{EVENTS_PATH}");
    let request = DiagnosticsEventsRequest { events };
    let resp = http::send(
        Endpoint::AmsDiagnostics,
        Method::POST,
        url,
        &auth,
        identity,
        Some(&request),
    )
    .await
    .map_err(map_bridge_error)?;
    let envelope: DiagnosticsEventsEnvelope =
        decode_body(Endpoint::AmsDiagnostics, resp.status, &resp.body)
            .map_err(map_bridge_error)?;
    if !envelope.ok {
        if let Some(err) = envelope.error {
            return Err(AmsDiagnosticsError::Api {
                code: err.code,
                message: err.message,
            });
        }
        return Err(AmsDiagnosticsError::Api {
            code: "request_failed".into(),
            message: "AMS-Diagnostik: ok=false ohne Fehlerdetail.".into(),
        });
    }
    Ok(DiagnosticsEventsResponse {
        accepted: envelope.accepted,
        duplicates: envelope.duplicates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_path_is_v1_diagnostics() {
        assert_eq!(EVENTS_PATH, "/v1/diagnostics/events");
    }

    #[test]
    fn map_unreachable_from_bridge() {
        let err = map_bridge_error(BridgeError::Unreachable {
            endpoint: Endpoint::AmsDiagnostics,
            detail: "refused".into(),
        });
        assert!(err.is_unreachable());
    }
}
