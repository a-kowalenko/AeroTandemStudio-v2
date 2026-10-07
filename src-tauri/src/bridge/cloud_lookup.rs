//! Phase 53 / T1 — Cloud booking-lookup HTTP client (JWT Bearer).
//! Spec: `docs/phases/open/53-cloud-lookup-fallback.md` · Master §5.2.
//!
//! Wired via `lookup_router` (T2). Reuses AMS `LookupRequest` / `LookupResponse`.
//! Probe: dummy id-lookup to verify JWT + Cloud reachability (connection check).

use std::fmt;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::Method;
use serde::{Deserialize, Serialize};

use super::client_token;
use super::http::{self, decode_body, Endpoint};
use super::{AtsBridgeIdentity, BridgeError, LookupRequest, LookupResponse};
use crate::storage::config::AppConfig;

/// Wire path under `cloud_base_url` (Master §5.2).
pub const LOOKUP_PATH: &str = "/api/ats/v1/customer/lookup";

/// Machine-readable code for JWT reject / revoke / instance mismatch (HTTP 401).
pub const ERROR_CODE_TOKEN_INVALID: &str = "token_invalid";

/// Identity headers sent with Cloud lookup (same names as AMS Bridge transport).
pub const HEADER_ATS_INSTANCE_ID: &str = "x-ats-instance-id";
pub const HEADER_ATS_HOSTNAME: &str = "x-ats-hostname";
pub const HEADER_ATS_VERSION: &str = "x-ats-version";
pub const HEADER_ATS_APP: &str = "x-ats-app";

/// Typed Cloud-Lookup failure. `TokenInvalid` → callers clear stored JWT (T2/T3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudLookupError {
    Config(String),
    Unreachable { detail: String },
    Timeout,
    /// Cloud rejected the JWT (HTTP 401). Clear local token.
    TokenInvalid,
    Http { status: u16, snippet: String },
    Protocol { status: u16, detail: String },
    Api { code: String, message: String },
}

impl CloudLookupError {
    pub fn is_token_invalid(&self) -> bool {
        matches!(self, CloudLookupError::TokenInvalid)
    }

    pub fn is_unreachable(&self) -> bool {
        matches!(
            self,
            CloudLookupError::Unreachable { .. } | CloudLookupError::Timeout
        )
    }

    pub fn api_code(&self) -> Option<&str> {
        match self {
            CloudLookupError::TokenInvalid => Some(ERROR_CODE_TOKEN_INVALID),
            CloudLookupError::Api { code, .. } => Some(code.as_str()),
            _ => None,
        }
    }
}

impl fmt::Display for CloudLookupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CloudLookupError::Config(msg) => f.write_str(msg),
            CloudLookupError::Unreachable { detail } => {
                write!(f, "Cloud-Lookup nicht erreichbar: {detail}")
            }
            CloudLookupError::Timeout => write!(
                f,
                "Cloud-Lookup nicht erreichbar: Zeitüberschreitung nach {}s",
                cloud_lookup_timeout().as_secs()
            ),
            CloudLookupError::TokenInvalid => {
                f.write_str("Cloud-Lookup: Token ungültig (401).")
            }
            CloudLookupError::Http { status, snippet } => {
                write!(f, "Cloud-Lookup fehlgeschlagen: HTTP {status}")?;
                if !snippet.is_empty() {
                    write!(f, " {snippet}")?;
                }
                Ok(())
            }
            CloudLookupError::Protocol { status, detail } => {
                write!(f, "Cloud-Lookup JSON (HTTP {status}): {detail}")
            }
            CloudLookupError::Api { code, message } => {
                if code.is_empty() {
                    f.write_str(message)
                } else {
                    write!(f, "{code}: {message}")
                }
            }
        }
    }
}

impl std::error::Error for CloudLookupError {}

impl From<CloudLookupError> for String {
    fn from(err: CloudLookupError) -> Self {
        err.to_string()
    }
}

/// Same request budget as AMS Bridge Lookup (`Endpoint::Lookup` / `CloudLookup`).
pub fn cloud_lookup_timeout() -> Duration {
    Endpoint::CloudLookup.timeout()
}

/// Normalize Cloud base URL (trim, strip trailing `/`, require http(s)).
pub fn normalize_cloud_base_url(raw: &str) -> Result<String, CloudLookupError> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(CloudLookupError::Config(
            "Cloud-Lookup-URL ist leer.".into(),
        ));
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(CloudLookupError::Config(
            "Cloud-Lookup-URL muss mit http:// oder https:// beginnen.".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// `POST` target: `{cloud_base_url}/api/ats/v1/customer/lookup`.
pub fn build_lookup_url(cloud_base_url: &str) -> Result<String, CloudLookupError> {
    let base = normalize_cloud_base_url(cloud_base_url)?;
    Ok(format!("{base}{LOOKUP_PATH}"))
}

/// `Authorization: Bearer <jwt>` — empty token is a config error (not 401).
pub fn bearer_auth(access_token: &str) -> Result<String, CloudLookupError> {
    let t = access_token.trim();
    if t.is_empty() {
        return Err(CloudLookupError::Config(
            "Cloud-Lookup JWT fehlt.".into(),
        ));
    }
    Ok(format!("Bearer {t}"))
}

/// Identity headers that accompany Cloud lookup (Bearer is separate).
/// Names match the AMS Bridge transport (`http::send`).
pub fn identity_headers(identity: &AtsBridgeIdentity) -> Vec<(&'static str, String)> {
    vec![
        (HEADER_ATS_INSTANCE_ID, identity.instance_id.clone()),
        (HEADER_ATS_HOSTNAME, identity.hostname.clone()),
        (HEADER_ATS_VERSION, identity.ats_version.clone()),
        (HEADER_ATS_APP, identity.ats_app.clone()),
    ]
}

/// Map transport/`BridgeError` from shared HTTP layer onto Cloud error kinds.
/// `401` → [`CloudLookupError::TokenInvalid`].
pub fn map_bridge_error(err: BridgeError) -> CloudLookupError {
    match err {
        BridgeError::Config(msg) => CloudLookupError::Config(msg),
        BridgeError::Unauthorized => CloudLookupError::TokenInvalid,
        BridgeError::Unreachable { detail, .. } => CloudLookupError::Unreachable { detail },
        BridgeError::Timeout { .. } => CloudLookupError::Timeout,
        BridgeError::Http {
            status, snippet, ..
        } => CloudLookupError::Http { status, snippet },
        BridgeError::Protocol {
            status, detail, ..
        } => CloudLookupError::Protocol { status, detail },
        BridgeError::Api { code, message } => CloudLookupError::Api { code, message },
    }
}

/// `POST {cloud_base_url}/api/ats/v1/customer/lookup` with Bearer JWT + identity headers.
/// Response shape matches AMS Bridge `LookupResponse`.
pub async fn customer_lookup(
    cloud_base_url: &str,
    access_token: &str,
    request: &LookupRequest,
    identity: &AtsBridgeIdentity,
) -> Result<LookupResponse, CloudLookupError> {
    let url = build_lookup_url(cloud_base_url)?;
    let auth = bearer_auth(access_token)?;
    let resp = http::send(
        Endpoint::CloudLookup,
        Method::POST,
        url,
        &auth,
        identity,
        Some(request),
    )
    .await
    .map_err(map_bridge_error)?;
    decode_body(Endpoint::CloudLookup, resp.status, &resp.body).map_err(map_bridge_error)
}

/// Known booking used for Cloud Lookup connectivity probe (Andreas Kowalenko).
pub const PROBE_CUSTOMER_ID: &str = "3971";
pub const PROBE_BOOKING_ID: &str = "2405";

/// Wire status for connection-check UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudLookupProbeStatus {
    Ok,
    NoToken,
    TokenInvalid,
    Unreachable,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudLookupProbeResult {
    pub ok: bool,
    pub status: CloudLookupProbeStatus,
    pub message: String,
    pub cloud_base_url: String,
    /// True when JWT was rejected (401) — caller should clear persisted token.
    pub token_cleared: bool,
}

/// Dummy id-mode lookup used only for connectivity probes.
pub fn probe_lookup_request() -> LookupRequest {
    LookupRequest {
        customer_id: PROBE_CUSTOMER_ID.into(),
        booking_id: PROBE_BOOKING_ID.into(),
        marker_type: "Handcam".into(),
        mode: "id".into(),
    }
}

/// Pure classification of a probe HTTP outcome (unit-tested, no network).
///
/// Any decoded lookup body (including `ok: false` / `not_found`) means Cloud + JWT work.
/// Business [`CloudLookupError::Api`] also counts as reachable + authenticated.
pub fn classify_probe_outcome(
    result: Result<&LookupResponse, &CloudLookupError>,
) -> CloudLookupProbeStatus {
    match result {
        Ok(_) => CloudLookupProbeStatus::Ok,
        Err(CloudLookupError::Config(_)) => CloudLookupProbeStatus::NoToken,
        Err(e) if e.is_token_invalid() => CloudLookupProbeStatus::TokenInvalid,
        Err(e) if e.is_unreachable() => CloudLookupProbeStatus::Unreachable,
        Err(CloudLookupError::Api { .. }) => CloudLookupProbeStatus::Ok,
        Err(_) => CloudLookupProbeStatus::Error,
    }
}

fn probe_message(status: CloudLookupProbeStatus, err: Option<&CloudLookupError>) -> String {
    match status {
        CloudLookupProbeStatus::Ok => "Cloud-Lookup erreichbar.".into(),
        CloudLookupProbeStatus::NoToken => "Kein nutzbares Cloud-Lookup-Token.".into(),
        CloudLookupProbeStatus::TokenInvalid => {
            err.map(|e| e.to_string())
                .unwrap_or_else(|| "Cloud-Lookup: Token ungültig (401).".into())
        }
        CloudLookupProbeStatus::Unreachable => err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "Cloud-Lookup nicht erreichbar.".into()),
        CloudLookupProbeStatus::Error => err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "Cloud-Lookup fehlgeschlagen.".into()),
    }
}

/// Probe Cloud Lookup with the stored JWT (dummy ids). No-op when token unusable.
pub async fn probe_stored_token(
    config: &AppConfig,
    identity: &AtsBridgeIdentity,
    now: DateTime<Utc>,
) -> CloudLookupProbeResult {
    let Some(token) = client_token::load_from_config(config) else {
        return CloudLookupProbeResult {
            ok: false,
            status: CloudLookupProbeStatus::NoToken,
            message: probe_message(CloudLookupProbeStatus::NoToken, None),
            cloud_base_url: String::new(),
            token_cleared: false,
        };
    };
    if !client_token::is_usable(&token, now) {
        return CloudLookupProbeResult {
            ok: false,
            status: CloudLookupProbeStatus::NoToken,
            message: probe_message(CloudLookupProbeStatus::NoToken, None),
            cloud_base_url: token.cloud_base_url,
            token_cleared: false,
        };
    }

    let req = probe_lookup_request();
    let outcome = customer_lookup(
        &token.cloud_base_url,
        &token.access_token,
        &req,
        identity,
    )
    .await;
    let status = classify_probe_outcome(match &outcome {
        Ok(r) => Ok(r),
        Err(e) => Err(e),
    });
    let token_cleared = status == CloudLookupProbeStatus::TokenInvalid;
    CloudLookupProbeResult {
        ok: status == CloudLookupProbeStatus::Ok,
        status,
        message: probe_message(status, outcome.as_ref().err()),
        cloud_base_url: token.cloud_base_url,
        token_cleared,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::build_ats_bridge_identity;
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
    fn build_lookup_url_strips_slash_and_appends_path() {
        assert_eq!(
            build_lookup_url("https://cloud.example/").unwrap(),
            "https://cloud.example/api/ats/v1/customer/lookup"
        );
        assert_eq!(
            build_lookup_url("  http://127.0.0.1:3000  ").unwrap(),
            "http://127.0.0.1:3000/api/ats/v1/customer/lookup"
        );
        assert_eq!(LOOKUP_PATH, "/api/ats/v1/customer/lookup");
    }

    #[test]
    fn build_lookup_url_rejects_empty_and_scheme_less() {
        assert!(matches!(
            build_lookup_url(""),
            Err(CloudLookupError::Config(_))
        ));
        assert!(matches!(
            build_lookup_url("cloud.example"),
            Err(CloudLookupError::Config(_))
        ));
        let err = build_lookup_url("ftp://cloud.example").unwrap_err();
        assert!(err.to_string().contains("http://"));
    }

    #[test]
    fn bearer_auth_formats_jwt_and_rejects_empty() {
        assert_eq!(
            bearer_auth("  eyJhbGciOi.test  ").unwrap(),
            "Bearer eyJhbGciOi.test"
        );
        assert!(matches!(
            bearer_auth("   "),
            Err(CloudLookupError::Config(_))
        ));
    }

    #[test]
    fn identity_headers_include_instance_hostname_version_app() {
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
        assert_eq!(err.to_string(), "Cloud-Lookup: Token ungültig (401).");
        assert!(!err.is_unreachable());
    }

    #[test]
    fn map_timeout_and_unreachable() {
        let timeout = map_bridge_error(BridgeError::Timeout {
            endpoint: Endpoint::CloudLookup,
        });
        assert!(matches!(timeout, CloudLookupError::Timeout));
        assert!(timeout.is_unreachable());
        assert!(timeout.to_string().contains("Zeitüberschreitung"));
        assert!(timeout.to_string().contains("12s"));

        let unreachable = map_bridge_error(BridgeError::Unreachable {
            endpoint: Endpoint::CloudLookup,
            detail: "connection refused".into(),
        });
        assert!(unreachable.is_unreachable());
        assert!(!unreachable.is_token_invalid());
    }

    #[test]
    fn map_http_and_protocol_preserve_status() {
        let http_err = map_bridge_error(BridgeError::Http {
            endpoint: Endpoint::CloudLookup,
            status: 502,
            snippet: "bad gateway".into(),
        });
        match http_err {
            CloudLookupError::Http { status, snippet } => {
                assert_eq!(status, 502);
                assert_eq!(snippet, "bad gateway");
            }
            other => panic!("expected Http, got {other:?}"),
        }

        let proto = map_bridge_error(BridgeError::Protocol {
            endpoint: Endpoint::CloudLookup,
            status: 200,
            detail: "not json".into(),
        });
        assert!(matches!(
            proto,
            CloudLookupError::Protocol {
                status: 200,
                ..
            }
        ));
    }

    #[test]
    fn decode_lookup_response_ok_and_not_found() {
        let ok_body = br#"{"ok":true,"customer":{"customer_number":"1","first_name":"Ada"}}"#;
        let ok: LookupResponse =
            decode_body(Endpoint::CloudLookup, StatusCode::OK, ok_body).unwrap();
        assert!(ok.ok);
        assert_eq!(
            ok.customer.as_ref().unwrap().first_name.as_deref(),
            Some("Ada")
        );

        let nf = br#"{"ok":false,"error":{"code":"not_found","message":"missing"}}"#;
        let resp: LookupResponse =
            decode_body(Endpoint::CloudLookup, StatusCode::OK, nf).unwrap();
        assert!(!resp.ok);
        assert_eq!(resp.error.as_ref().unwrap().code, "not_found");
    }

    #[test]
    fn cloud_lookup_timeout_matches_bridge_lookup() {
        assert_eq!(cloud_lookup_timeout(), Endpoint::Lookup.timeout());
        assert_eq!(cloud_lookup_timeout(), Duration::from_secs(12));
    }

    #[test]
    fn probe_request_uses_dedicated_ids() {
        let req = probe_lookup_request();
        assert_eq!(req.customer_id, PROBE_CUSTOMER_ID);
        assert_eq!(req.booking_id, PROBE_BOOKING_ID);
        assert_eq!(req.mode, "id");
        assert_eq!(req.marker_type, "Handcam");
    }

    #[test]
    fn classify_probe_treats_not_found_and_api_as_ok() {
        let nf = LookupResponse {
            ok: false,
            customer: None,
            error: Some(super::super::LookupErrorBody {
                code: "not_found".into(),
                message: "missing".into(),
            }),
        };
        assert_eq!(
            classify_probe_outcome(Ok(&nf)),
            CloudLookupProbeStatus::Ok
        );
        let api = CloudLookupError::Api {
            code: "not_found".into(),
            message: "missing".into(),
        };
        assert_eq!(
            classify_probe_outcome(Err(&api)),
            CloudLookupProbeStatus::Ok
        );
        assert_eq!(
            classify_probe_outcome(Err(&CloudLookupError::TokenInvalid)),
            CloudLookupProbeStatus::TokenInvalid
        );
        assert_eq!(
            classify_probe_outcome(Err(&CloudLookupError::Timeout)),
            CloudLookupProbeStatus::Unreachable
        );
        assert_eq!(
            classify_probe_outcome(Err(&CloudLookupError::Config("x".into()))),
            CloudLookupProbeStatus::NoToken
        );
    }
}
