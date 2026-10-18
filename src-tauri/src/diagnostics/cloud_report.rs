//! Phase 57 R3 — Cloud diagnostics events HTTP client (JWT Bearer).
//! Master §3 · analog `bridge/cloud_lookup.rs`.

use std::fmt;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::bridge::client_token;
use crate::bridge::cloud_lookup::{self, bearer_auth};
use crate::bridge::http::{self, decode_body, Endpoint};
use crate::bridge::{AtsBridgeIdentity, BridgeError};
use crate::storage::config::AppConfig;

use super::event::DiagnosticWireEvent;

/// Wire path under `cloud_base_url` (Master §3).
pub const EVENTS_PATH: &str = "/api/ats/v1/diagnostics/events";

/// JWT scope required for direct Cloud ingest (Master §4).
pub const SCOPE_DIAGNOSTICS_REPORT: &str = "diagnostics.report";

pub use cloud_lookup::ERROR_CODE_TOKEN_INVALID;

/// Typed Cloud diagnostics failure. `TokenInvalid` → clear persisted JWT.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudDiagnosticsError {
    Config(String),
    Unreachable { detail: String },
    Timeout,
    TokenInvalid,
    Http { status: u16, snippet: String },
    Protocol { status: u16, detail: String },
    Api { code: String, message: String },
}

impl CloudDiagnosticsError {
    pub fn is_token_invalid(&self) -> bool {
        matches!(self, CloudDiagnosticsError::TokenInvalid)
    }

    pub fn is_unreachable(&self) -> bool {
        matches!(
            self,
            CloudDiagnosticsError::Unreachable { .. } | CloudDiagnosticsError::Timeout
        )
    }

    pub fn api_code(&self) -> Option<&str> {
        match self {
            CloudDiagnosticsError::TokenInvalid => Some(ERROR_CODE_TOKEN_INVALID),
            CloudDiagnosticsError::Api { code, .. } => Some(code.as_str()),
            _ => None,
        }
    }
}

impl fmt::Display for CloudDiagnosticsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CloudDiagnosticsError::Config(msg) => f.write_str(msg),
            CloudDiagnosticsError::Unreachable { detail } => {
                write!(f, "Cloud-Diagnostik nicht erreichbar: {detail}")
            }
            CloudDiagnosticsError::Timeout => write!(
                f,
                "Cloud-Diagnostik nicht erreichbar: Zeitüberschreitung nach {}s",
                cloud_diagnostics_timeout().as_secs()
            ),
            CloudDiagnosticsError::TokenInvalid => {
                f.write_str("Cloud-Diagnostik: Token ungültig (401).")
            }
            CloudDiagnosticsError::Http { status, snippet } => {
                write!(f, "Cloud-Diagnostik fehlgeschlagen: HTTP {status}")?;
                if !snippet.is_empty() {
                    write!(f, " {snippet}")?;
                }
                Ok(())
            }
            CloudDiagnosticsError::Protocol { status, detail } => {
                write!(f, "Cloud-Diagnostik JSON (HTTP {status}): {detail}")
            }
            CloudDiagnosticsError::Api { code, message } => {
                if code.is_empty() {
                    f.write_str(message)
                } else {
                    write!(f, "{code}: {message}")
                }
            }
        }
    }
}

impl std::error::Error for CloudDiagnosticsError {}

impl From<CloudDiagnosticsError> for String {
    fn from(err: CloudDiagnosticsError) -> Self {
        err.to_string()
    }
}

pub fn cloud_diagnostics_timeout() -> Duration {
    Endpoint::CloudDiagnostics.timeout()
}

fn map_lookup_config(err: cloud_lookup::CloudLookupError) -> CloudDiagnosticsError {
    match err {
        cloud_lookup::CloudLookupError::Config(m) => CloudDiagnosticsError::Config(m),
        other => CloudDiagnosticsError::Config(other.to_string()),
    }
}

/// `POST` target: `{cloud_base_url}/api/ats/v1/diagnostics/events`.
pub fn build_events_url(cloud_base_url: &str) -> Result<String, CloudDiagnosticsError> {
    let base = cloud_lookup::normalize_cloud_base_url(cloud_base_url).map_err(map_lookup_config)?;
    Ok(format!("{base}{EVENTS_PATH}"))
}

/// Map transport/`BridgeError` from shared HTTP layer. `401` → [`CloudDiagnosticsError::TokenInvalid`].
pub fn map_bridge_error(err: BridgeError) -> CloudDiagnosticsError {
    match err {
        BridgeError::Config(msg) => CloudDiagnosticsError::Config(msg),
        BridgeError::Unauthorized => CloudDiagnosticsError::TokenInvalid,
        BridgeError::Unreachable { detail, .. } => CloudDiagnosticsError::Unreachable { detail },
        BridgeError::Timeout { .. } => CloudDiagnosticsError::Timeout,
        BridgeError::Http {
            status, snippet, ..
        } => CloudDiagnosticsError::Http { status, snippet },
        BridgeError::Protocol {
            status, detail, ..
        } => CloudDiagnosticsError::Protocol { status, detail },
        BridgeError::Api { code, message } => CloudDiagnosticsError::Api { code, message },
    }
}

/// True when a stored JWT is usable and includes `diagnostics.report` (client-side gate).
pub fn cloud_direct_path_ready(config: &AppConfig, now: DateTime<Utc>) -> bool {
    let Some(stored) = client_token::load_from_config(config) else {
        return false;
    };
    if !client_token::is_usable(&stored, now) {
        return false;
    }
    client_token::token_has_scope(&stored.access_token, SCOPE_DIAGNOSTICS_REPORT)
}

#[derive(Debug, Serialize)]
pub struct DiagnosticsEventsRequest<'a> {
    pub events: &'a [DiagnosticWireEvent],
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticsEventsResponse {
    pub accepted: u32,
    pub duplicates: u32,
}

/// `POST {cloud_base_url}/api/ats/v1/diagnostics/events` with Bearer JWT + identity headers.
pub async fn post_events(
    cloud_base_url: &str,
    access_token: &str,
    events: &[DiagnosticWireEvent],
    identity: &AtsBridgeIdentity,
) -> Result<DiagnosticsEventsResponse, CloudDiagnosticsError> {
    if events.is_empty() {
        return Err(CloudDiagnosticsError::Config(
            "Diagnostik-Batch ist leer.".into(),
        ));
    }
    let url = build_events_url(cloud_base_url)?;
    let auth = bearer_auth(access_token).map_err(map_lookup_config)?;
    let request = DiagnosticsEventsRequest { events };
    let resp = http::send(
        Endpoint::CloudDiagnostics,
        Method::POST,
        url,
        &auth,
        identity,
        Some(&request),
    )
    .await
    .map_err(map_bridge_error)?;
    let envelope: DiagnosticsEventsEnvelope =
        decode_body(Endpoint::CloudDiagnostics, resp.status, &resp.body)
            .map_err(map_bridge_error)?;
    if !envelope.ok {
        if let Some(err) = envelope.error {
            return Err(CloudDiagnosticsError::Api {
                code: err.code,
                message: err.message,
            });
        }
        return Err(CloudDiagnosticsError::Api {
            code: "request_failed".into(),
            message: "Cloud-Diagnostik: ok=false ohne Fehlerdetail.".into(),
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
    use crate::bridge::build_ats_bridge_identity;
    use crate::bridge::cloud_lookup::{
        identity_headers, HEADER_ATS_APP, HEADER_ATS_HOSTNAME, HEADER_ATS_INSTANCE_ID,
        HEADER_ATS_VERSION,
    };
    use crate::storage::config::AppConfig;
    use reqwest::StatusCode;

    fn test_identity() -> AtsBridgeIdentity {
        let cfg = AppConfig {
            ams_bridge_instance_id: "inst-test-uuid".into(),
            sd_pc_name: "host-test".into(),
            ..AppConfig::default()
        };
        build_ats_bridge_identity(&cfg)
    }

    #[test]
    fn build_events_url_strips_slash_and_appends_path() {
        assert_eq!(
            build_events_url("https://cloud.example/").unwrap(),
            "https://cloud.example/api/ats/v1/diagnostics/events"
        );
        assert_eq!(
            build_events_url("  http://127.0.0.1:3000  ").unwrap(),
            "http://127.0.0.1:3000/api/ats/v1/diagnostics/events"
        );
        assert_eq!(EVENTS_PATH, "/api/ats/v1/diagnostics/events");
    }

    #[test]
    fn build_events_url_rejects_empty_and_scheme_less() {
        assert!(matches!(
            build_events_url(""),
            Err(CloudDiagnosticsError::Config(_))
        ));
        assert!(matches!(
            build_events_url("cloud.example"),
            Err(CloudDiagnosticsError::Config(_))
        ));
    }

    #[test]
    fn identity_headers_match_lookup_transport() {
        let id = test_identity();
        let headers = identity_headers(&id);
        let get = |name: &str| {
            headers
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.as_str())
                .expect(name)
        };
        assert_eq!(get(HEADER_ATS_INSTANCE_ID), "inst-test-uuid");
        assert_eq!(get(HEADER_ATS_HOSTNAME), "host-test");
        assert_eq!(get(HEADER_ATS_APP), "AeroTandemStudio");
        assert!(!get(HEADER_ATS_VERSION).is_empty());
        assert_eq!(headers.len(), 4);
    }

    #[test]
    fn map_unauthorized_is_token_invalid() {
        let err = map_bridge_error(BridgeError::Unauthorized);
        assert!(err.is_token_invalid());
        assert_eq!(err.api_code(), Some(ERROR_CODE_TOKEN_INVALID));
        assert_eq!(err.to_string(), "Cloud-Diagnostik: Token ungültig (401).");
    }

    #[test]
    fn map_timeout_and_unreachable() {
        let timeout = map_bridge_error(BridgeError::Timeout {
            endpoint: Endpoint::CloudDiagnostics,
        });
        assert!(matches!(timeout, CloudDiagnosticsError::Timeout));
        assert!(timeout.is_unreachable());

        let unreachable = map_bridge_error(BridgeError::Unreachable {
            endpoint: Endpoint::CloudDiagnostics,
            detail: "connection refused".into(),
        });
        assert!(unreachable.is_unreachable());
        assert!(!unreachable.is_token_invalid());
    }

    #[test]
    fn decode_success_envelope() {
        let body = br#"{"ok":true,"accepted":2,"duplicates":1}"#;
        let env: DiagnosticsEventsEnvelope =
            decode_body(Endpoint::CloudDiagnostics, StatusCode::OK, body).unwrap();
        assert!(env.ok);
        assert_eq!(env.accepted, 2);
        assert_eq!(env.duplicates, 1);
    }

    #[test]
    fn cloud_diagnostics_timeout_matches_cloud_lookup() {
        assert_eq!(
            cloud_diagnostics_timeout(),
            Endpoint::CloudLookup.timeout()
        );
        assert_eq!(cloud_diagnostics_timeout(), Duration::from_secs(12));
    }
}
