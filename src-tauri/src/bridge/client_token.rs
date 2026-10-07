//! Phase 53 / T0 — Cloud-Lookup JWT store + proactive refresh via AMS.
//! Spec: `docs/phases/open/53-cloud-lookup-fallback.md` · Master §4–5 / HANDOFF §9.4.
//!
//! Token is never logged. Persist via `AppConfig` cloud_lookup_* fields.

use std::fmt;

use chrono::{DateTime, Duration, Utc};
use reqwest::Method;
use serde::{Deserialize, Serialize};

use super::http::{self, decode_body, Endpoint};
use super::{auth_header, normalize_base_url, AtsBridgeIdentity, BridgeError};
use crate::storage::config::AppConfig;
use crate::storage::logging;

/// AMS capability that advertises Cloud JWT issue is configured.
pub const CAPABILITY_CLOUD_LOOKUP_V1: &str = "cloud-lookup-v1";

/// Proactive refresh when remaining validity is below this (Master: 24h).
pub const REFRESH_REMAINING_THRESHOLD: Duration = Duration::hours(24);

/// Persisted ATS-Client-JWT for Cloud booking lookup (scoped `customer.lookup`).
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct StoredClientToken {
    pub access_token: String,
    /// RFC3339 expiry from AMS/Cloud.
    pub expires_at: String,
    pub cloud_base_url: String,
    /// AMS instance that issued / last bound this token.
    pub ams_server_instance_id: String,
}

impl fmt::Debug for StoredClientToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredClientToken")
            .field("access_token", &redact_secret(&self.access_token))
            .field("expires_at", &self.expires_at)
            .field("cloud_base_url", &self.cloud_base_url)
            .field("ams_server_instance_id", &self.ams_server_instance_id)
            .finish()
    }
}

/// Flat success body from AMS `POST /v1/client-token` (Cloud-mapped).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClientTokenResponse {
    pub access_token: String,
    #[serde(default = "default_token_type")]
    pub token_type: String,
    pub expires_at: String,
    #[serde(default)]
    pub expires_in: i64,
    pub cloud_base_url: String,
    #[serde(default)]
    pub scope: Vec<String>,
}

fn default_token_type() -> String {
    "Bearer".into()
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct ClientTokenErrorResponse {
    #[serde(default)]
    ok: bool,
    error: ClientTokenErrorBody,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct ClientTokenErrorBody {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

/// Read stored token from config (sanitized). Empty token → `None`.
pub fn load_from_config(config: &AppConfig) -> Option<StoredClientToken> {
    let mut stored = StoredClientToken {
        access_token: config.cloud_lookup_access_token.clone(),
        expires_at: config.cloud_lookup_expires_at.clone(),
        cloud_base_url: config.cloud_lookup_cloud_base_url.clone(),
        ams_server_instance_id: config.cloud_lookup_ams_server_instance_id.clone(),
    };
    sanitize_stored(&mut stored);
    if stored.access_token.is_empty() {
        None
    } else {
        Some(stored)
    }
}

/// Write sanitized token into config fields (does not persist to disk).
pub fn apply_to_config(config: &mut AppConfig, stored: &StoredClientToken) {
    let mut clean = stored.clone();
    sanitize_stored(&mut clean);
    config.cloud_lookup_access_token = clean.access_token;
    config.cloud_lookup_expires_at = clean.expires_at;
    config.cloud_lookup_cloud_base_url = clean.cloud_base_url;
    config.cloud_lookup_ams_server_instance_id = clean.ams_server_instance_id;
}

/// Clear Cloud-Lookup JWT fields on config.
pub fn clear_in_config(config: &mut AppConfig) {
    config.cloud_lookup_access_token.clear();
    config.cloud_lookup_expires_at.clear();
    config.cloud_lookup_cloud_base_url.clear();
    config.cloud_lookup_ams_server_instance_id.clear();
}

/// Trim fields; drop incomplete/invalid rows so empty token is not treated as present.
pub fn sanitize_stored(stored: &mut StoredClientToken) {
    stored.access_token = stored.access_token.trim().to_string();
    stored.expires_at = stored.expires_at.trim().to_string();
    stored.cloud_base_url = stored.cloud_base_url.trim().trim_end_matches('/').to_string();
    stored.ams_server_instance_id = stored.ams_server_instance_id.trim().to_string();

    if stored.access_token.is_empty() {
        stored.expires_at.clear();
        stored.cloud_base_url.clear();
        stored.ams_server_instance_id.clear();
        return;
    }
    if parse_expires_at(&stored.expires_at).is_none() {
        // Unparseable expiry → not usable; clear so callers refresh.
        stored.access_token.clear();
        stored.expires_at.clear();
        stored.cloud_base_url.clear();
        stored.ams_server_instance_id.clear();
    }
}

pub fn parse_expires_at(raw: &str) -> Option<DateTime<Utc>> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    // Cloud may emit millis without offset; treat as UTC.
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(DateTime::from_naive_utc_and_offset(dt, Utc));
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Some(DateTime::from_naive_utc_and_offset(dt, Utc));
    }
    None
}

/// Remaining validity; `None` if missing/unparseable.
pub fn remaining_validity(stored: &StoredClientToken, now: DateTime<Utc>) -> Option<Duration> {
    let exp = parse_expires_at(&stored.expires_at)?;
    Some(exp.signed_duration_since(now))
}

/// Token can be used for Cloud lookup (present, not expired).
pub fn is_usable(stored: &StoredClientToken, now: DateTime<Utc>) -> bool {
    if stored.access_token.trim().is_empty() || stored.cloud_base_url.trim().is_empty() {
        return false;
    }
    match remaining_validity(stored, now) {
        Some(remaining) => remaining > Duration::zero(),
        None => false,
    }
}

/// Refresh when missing or remaining validity is strictly below 24h (includes expired).
pub fn needs_refresh(stored: Option<&StoredClientToken>, now: DateTime<Utc>) -> bool {
    let Some(stored) = stored else {
        return true;
    };
    if stored.access_token.trim().is_empty() {
        return true;
    }
    match remaining_validity(stored, now) {
        None => true,
        Some(remaining) => remaining < REFRESH_REMAINING_THRESHOLD,
    }
}

/// Like [`needs_refresh`], plus re-issue when bound AMS instance differs.
pub fn needs_refresh_for_ams(
    stored: Option<&StoredClientToken>,
    ams_server_instance_id: &str,
    now: DateTime<Utc>,
) -> bool {
    if needs_refresh(stored, now) {
        return true;
    }
    let Some(stored) = stored else {
        return true;
    };
    let bound = stored.ams_server_instance_id.trim();
    let ams = ams_server_instance_id.trim();
    !ams.is_empty() && !bound.is_empty() && bound != ams
}

pub fn health_supports_cloud_lookup(capabilities: &[String]) -> bool {
    capabilities
        .iter()
        .any(|c| c.trim() == CAPABILITY_CLOUD_LOOKUP_V1)
}

pub fn stored_from_response(
    resp: &ClientTokenResponse,
    ams_server_instance_id: &str,
) -> StoredClientToken {
    let mut stored = StoredClientToken {
        access_token: resp.access_token.clone(),
        expires_at: resp.expires_at.clone(),
        cloud_base_url: resp.cloud_base_url.clone(),
        ams_server_instance_id: ams_server_instance_id.trim().to_string(),
    };
    sanitize_stored(&mut stored);
    stored
}

/// `POST {ams}/v1/client-token` — empty body; identity via headers.
pub async fn fetch_client_token(
    base_url: &str,
    bridge_token: &str,
    identity: &AtsBridgeIdentity,
) -> Result<ClientTokenResponse, BridgeError> {
    let base = normalize_base_url(base_url).map_err(BridgeError::Config)?;
    let auth = auth_header(bridge_token)?;
    let resp = http::send::<()>(
        Endpoint::ClientToken,
        Method::POST,
        format!("{base}/v1/client-token"),
        &auth,
        identity,
        None,
    )
    .await?;
    if !resp.status.is_success() {
        if let Ok(err) = serde_json::from_slice::<ClientTokenErrorResponse>(&resp.body) {
            return Err(BridgeError::Api {
                code: err.error.code,
                message: err.error.message,
            });
        }
        return Err(BridgeError::Http {
            endpoint: Endpoint::ClientToken,
            status: resp.status.as_u16(),
            snippet: http::body_snippet(&resp.body),
        });
    }
    let body: ClientTokenResponse = decode_body(Endpoint::ClientToken, resp.status, &resp.body)?;
    if body.access_token.trim().is_empty() {
        return Err(BridgeError::Protocol {
            endpoint: Endpoint::ClientToken,
            status: resp.status.as_u16(),
            detail: "leeres access_token".into(),
        });
    }
    if body.cloud_base_url.trim().is_empty() {
        return Err(BridgeError::Protocol {
            endpoint: Endpoint::ClientToken,
            status: resp.status.as_u16(),
            detail: "leere cloud_base_url".into(),
        });
    }
    if parse_expires_at(&body.expires_at).is_none() {
        return Err(BridgeError::Protocol {
            endpoint: Endpoint::ClientToken,
            status: resp.status.as_u16(),
            detail: "ungültiges expires_at".into(),
        });
    }
    Ok(body)
}

/// Soft refresh after successful AMS health: issue when missing / &lt;24h left.
/// Returns `Some(stored)` when a new token was fetched; `None` when skipped or soft-failed.
pub async fn maybe_refresh_after_health(
    config: &AppConfig,
    base_url: &str,
    bridge_token: &str,
    ams_server_instance_id: &str,
    capabilities: &[String],
    now: DateTime<Utc>,
) -> Option<StoredClientToken> {
    if !health_supports_cloud_lookup(capabilities) {
        return None;
    }
    let current = load_from_config(config);
    if !needs_refresh_for_ams(current.as_ref(), ams_server_instance_id, now) {
        return None;
    }
    let identity = super::build_ats_bridge_identity(config);
    match fetch_client_token(base_url, bridge_token, &identity).await {
        Ok(resp) => {
            let stored = stored_from_response(&resp, ams_server_instance_id);
            if stored.access_token.is_empty() {
                logging::warn(
                    "bridge",
                    "Cloud-Lookup client-token Antwort nach Sanitize leer — nicht gespeichert",
                );
                return None;
            }
            logging::info(
                "bridge",
                format!(
                    "Cloud-Lookup client-token erneuert (expires_at={}, cloud_base_url={}, ams={})",
                    stored.expires_at, stored.cloud_base_url, stored.ams_server_instance_id
                ),
            );
            Some(stored)
        }
        Err(e) => {
            // Soft: health remains ok; Cloud fallback may stay offline until next poll.
            logging::warn(
                "bridge",
                format!("Cloud-Lookup client-token Refresh fehlgeschlagen (nicht blockierend): {e}"),
            );
            None
        }
    }
}

fn redact_secret(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return "(empty)".into();
    }
    if t.len() <= 8 {
        return "***".into();
    }
    format!("{}…***", &t[..4])
}

/// Test helper: threshold as std Duration (24h).
#[cfg(test)]
pub fn refresh_threshold_std() -> std::time::Duration {
    std::time::Duration::from_secs(24 * 60 * 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_stored(expires_at: &str) -> StoredClientToken {
        StoredClientToken {
            access_token: "eyJhbGciOi.test.token".into(),
            expires_at: expires_at.into(),
            cloud_base_url: "https://cloud.example".into(),
            ams_server_instance_id: "ams-1".into(),
        }
    }

    #[test]
    fn refresh_threshold_is_24_hours() {
        assert_eq!(REFRESH_REMAINING_THRESHOLD, Duration::hours(24));
        assert_eq!(
            refresh_threshold_std(),
            std::time::Duration::from_secs(86_400)
        );
    }

    #[test]
    fn needs_refresh_when_missing_or_empty() {
        let now = Utc::now();
        assert!(needs_refresh(None, now));
        let empty = StoredClientToken::default();
        assert!(needs_refresh(Some(&empty), now));
    }

    #[test]
    fn needs_refresh_when_remaining_below_24h() {
        let now = Utc::now();
        // 23h59 remaining → refresh
        let soon = (now + Duration::hours(23) + Duration::minutes(59)).to_rfc3339();
        assert!(needs_refresh(Some(&sample_stored(&soon)), now));
        // exactly 24h is NOT < 24h → no refresh
        let exact = (now + Duration::hours(24)).to_rfc3339();
        assert!(!needs_refresh(Some(&sample_stored(&exact)), now));
        // 25h → no refresh
        let plenty = (now + Duration::hours(25)).to_rfc3339();
        assert!(!needs_refresh(Some(&sample_stored(&plenty)), now));
    }

    #[test]
    fn expired_token_is_not_usable_and_needs_refresh() {
        let now = Utc::now();
        let expired = (now - Duration::hours(1)).to_rfc3339();
        let stored = sample_stored(&expired);
        assert!(!is_usable(&stored, now));
        assert!(needs_refresh(Some(&stored), now));
        // Remaining is negative → still < 24h
        let rem = remaining_validity(&stored, now).expect("parse");
        assert!(rem < Duration::zero());
        assert!(rem < REFRESH_REMAINING_THRESHOLD);
    }

    #[test]
    fn usable_requires_cloud_base_and_future_expiry() {
        let now = Utc::now();
        let future = (now + Duration::hours(30)).to_rfc3339();
        let mut stored = sample_stored(&future);
        assert!(is_usable(&stored, now));
        stored.cloud_base_url.clear();
        assert!(!is_usable(&stored, now));
    }

    #[test]
    fn sanitize_clears_unparseable_expiry() {
        let mut stored = sample_stored("not-a-date");
        sanitize_stored(&mut stored);
        assert!(stored.access_token.is_empty());
        assert!(stored.expires_at.is_empty());
    }

    #[test]
    fn sanitize_trims_and_strips_trailing_slash() {
        let mut stored = StoredClientToken {
            access_token: "  tok  ".into(),
            expires_at: format!("  {}  ", (Utc::now() + Duration::hours(30)).to_rfc3339()),
            cloud_base_url: " https://cloud.example/ ".into(),
            ams_server_instance_id: " ams-1 ".into(),
        };
        sanitize_stored(&mut stored);
        assert_eq!(stored.access_token, "tok");
        assert_eq!(stored.cloud_base_url, "https://cloud.example");
        assert_eq!(stored.ams_server_instance_id, "ams-1");
        assert!(!stored.expires_at.contains(' '));
    }

    #[test]
    fn ams_instance_mismatch_forces_refresh() {
        let now = Utc::now();
        let future = (now + Duration::hours(40)).to_rfc3339();
        let stored = sample_stored(&future);
        assert!(!needs_refresh(Some(&stored), now));
        assert!(needs_refresh_for_ams(Some(&stored), "ams-other", now));
        assert!(!needs_refresh_for_ams(Some(&stored), "ams-1", now));
    }

    #[test]
    fn debug_redacts_access_token() {
        let stored = sample_stored(&(Utc::now() + Duration::hours(30)).to_rfc3339());
        let dbg = format!("{stored:?}");
        assert!(!dbg.contains("eyJhbGciOi.test.token"));
        assert!(dbg.contains("***"));
    }

    #[test]
    fn parse_expires_at_accepts_rfc3339_variants() {
        assert!(parse_expires_at("2026-10-09T12:00:00.000Z").is_some());
        assert!(parse_expires_at("2026-10-09T12:00:00Z").is_some());
        assert!(parse_expires_at("2026-10-09T12:00:00.000+00:00").is_some());
        assert!(parse_expires_at("").is_none());
        assert!(parse_expires_at("garbage").is_none());
    }

    #[test]
    fn health_capability_detection() {
        assert!(health_supports_cloud_lookup(&[
            "lookup".into(),
            "cloud-lookup-v1".into()
        ]));
        assert!(!health_supports_cloud_lookup(&["lookup".into()]));
    }

    #[test]
    fn stored_from_response_binds_ams_instance() {
        let resp = ClientTokenResponse {
            access_token: "jwt".into(),
            token_type: "Bearer".into(),
            expires_at: (Utc::now() + Duration::hours(48)).to_rfc3339(),
            expires_in: 172800,
            cloud_base_url: "https://cloud.example/".into(),
            scope: vec!["customer.lookup".into()],
        };
        let stored = stored_from_response(&resp, "  ams-xyz  ");
        assert_eq!(stored.ams_server_instance_id, "ams-xyz");
        assert_eq!(stored.cloud_base_url, "https://cloud.example");
        assert_eq!(stored.access_token, "jwt");
    }
}
