//! AMS LAN Bridge client (Phase 13 / P4).
//! Spec: AMS `docs/HANDOFF.md` §9 — health, lookup, jobs, ready + mDNS discovery.
//! File handoff works without this module.

mod mdns;

pub use mdns::{discover_bridges, DiscoveredBridge};

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::model::Kunde;
use crate::storage::config::AppConfig;
use crate::video::handoff_manifest::StatusOutboxV1;

const REQUEST_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BridgeHealth {
    pub online: bool,
    pub version: String,
    pub monitor_path: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LookupRequest {
    pub customer_id: String,
    pub booking_id: String,
    #[serde(rename = "type")]
    pub marker_type: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LookupErrorBody {
    pub code: String,
    pub message: String,
}

/// Slim customer payload from AMS (domain fields only).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct BridgeCustomer {
    pub customer_number: Option<String>,
    pub booking_number: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    #[serde(rename = "type")]
    pub customer_type: Option<String>,
    #[serde(default)]
    pub handcam_foto: bool,
    #[serde(default)]
    pub handcam_video: bool,
    #[serde(default)]
    pub outside_foto: bool,
    #[serde(default)]
    pub outside_video: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LookupResponse {
    pub ok: bool,
    #[serde(default)]
    pub customer: Option<BridgeCustomer>,
    #[serde(default)]
    pub error: Option<LookupErrorBody>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BridgeHealthResult {
    pub ok: bool,
    pub message: String,
    pub health: Option<BridgeHealth>,
    /// Base URL that succeeded (for `ams_bridge_last_ok_url`).
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JobStatusResponse {
    pub ok: bool,
    #[serde(default)]
    pub job: Option<StatusOutboxV1>,
    #[serde(default)]
    pub error: Option<LookupErrorBody>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct HandoffReadyRequest {
    pub correlation_id: String,
    #[serde(default)]
    pub folder_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HandoffReadyResponse {
    pub ok: bool,
    pub woken: bool,
    #[serde(default)]
    pub error: Option<LookupErrorBody>,
}

fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("AMS-Bridge-URL ist leer.".into());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("AMS-Bridge-URL muss mit http:// oder https:// beginnen.".into());
    }
    Ok(trimmed.to_string())
}

fn auth_header(token: &str) -> Result<String, String> {
    let t = token.trim();
    if t.is_empty() {
        return Err("AMS-Bridge-Token fehlt.".into());
    }
    Ok(format!("Bearer {t}"))
}

/// Prefer configured URL; fall back to last successful URL when configured is empty.
pub fn resolve_bridge_base_url(config: &AppConfig) -> Result<String, String> {
    let primary = config.ams_bridge_url.trim();
    if !primary.is_empty() {
        return normalize_base_url(primary);
    }
    let last = config.ams_bridge_last_ok_url.trim();
    if !last.is_empty() {
        return normalize_base_url(last);
    }
    Err("Keine AMS-Bridge-URL konfiguriert.".into())
}

pub fn bridge_configured(config: &AppConfig) -> bool {
    !config.ams_bridge_url.trim().is_empty()
        || !config.ams_bridge_last_ok_url.trim().is_empty()
}

async fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

fn is_unreachable(err: &str) -> bool {
    err.contains("nicht erreichbar")
}

pub async fn fetch_health(base_url: &str, token: &str) -> Result<BridgeHealth, String> {
    let base = normalize_base_url(base_url)?;
    let auth = auth_header(token)?;
    let client = http_client().await?;
    let resp = client
        .get(format!("{base}/v1/health"))
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| format!("AMS-Bridge nicht erreichbar: {e}"))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("AMS-Bridge: Token ungültig (401).".into());
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        return Err(format!("AMS-Bridge health fehlgeschlagen: HTTP {status} {snippet}"));
    }
    resp.json::<BridgeHealth>()
        .await
        .map_err(|e| format!("AMS-Bridge health JSON: {e}"))
}

pub async fn check_health(config: &AppConfig) -> BridgeHealthResult {
    let base = match resolve_bridge_base_url(config) {
        Ok(u) => u,
        Err(message) => {
            return BridgeHealthResult {
                ok: false,
                message,
                health: None,
                base_url: String::new(),
            };
        }
    };
    match fetch_health(&base, &config.ams_bridge_token).await {
        Ok(health) => BridgeHealthResult {
            ok: health.online,
            message: if health.online {
                format!(
                    "AMS online (v{}, capabilities: {})",
                    health.version,
                    health.capabilities.join(", ")
                )
            } else {
                "AMS meldet online=false".into()
            },
            health: Some(health),
            base_url: base,
        },
        Err(message) => BridgeHealthResult {
            ok: false,
            message,
            health: None,
            base_url: base,
        },
    }
}

pub async fn customer_lookup(
    base_url: &str,
    token: &str,
    request: &LookupRequest,
) -> Result<LookupResponse, String> {
    let base = normalize_base_url(base_url)?;
    let auth = auth_header(token)?;
    let client = http_client().await?;
    let resp = client
        .post(format!("{base}/v1/customer/lookup"))
        .header("Authorization", auth)
        .json(request)
        .send()
        .await
        .map_err(|e| format!("AMS-Bridge Lookup nicht erreichbar: {e}"))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("AMS-Bridge: Token ungültig (401).".into());
    }
    // 4xx/502 may still carry LookupResponse JSON
    let status = resp.status();
    let body = resp
        .json::<LookupResponse>()
        .await
        .map_err(|e| format!("AMS-Bridge Lookup JSON (HTTP {status}): {e}"))?;
    Ok(body)
}

/// Build lookup request from ATS `Kunde` when API ids/hashes are present.
pub fn lookup_request_from_kunde(kunde: &Kunde) -> Option<LookupRequest> {
    let marker_type = if kunde.is_outside_video() || kunde.video_mode == "outside" {
        "Outside"
    } else {
        "Handcam"
    };

    if kunde.form_mode == "kunde" {
        let customer_id = kunde
            .kunden_id_hash
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        let booking_id = kunde
            .booking_id_hash
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        return Some(LookupRequest {
            customer_id: customer_id.to_string(),
            booking_id: booking_id.to_string(),
            marker_type: marker_type.into(),
            mode: "hash".into(),
        });
    }

    let customer_id = kunde
        .kunden_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let booking_id = kunde
        .booking_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(LookupRequest {
        customer_id: customer_id.to_string(),
        booking_id: booking_id.to_string(),
        marker_type: marker_type.into(),
        mode: "id".into(),
    })
}

/// Soft preflight: only when bridge URL is configured and kunde has API ids.
/// Bridge unreachable → Ok(None) (file handoff must still work).
/// Lookup failed (customer not found / API error) → Err.
pub async fn preflight_customer_lookup(
    config: &AppConfig,
    kunde: &Kunde,
) -> Result<Option<LookupResponse>, String> {
    if config.skip_marker_file() {
        return Ok(None);
    }
    if !bridge_configured(config) {
        return Ok(None);
    }
    let Some(req) = lookup_request_from_kunde(kunde) else {
        return Ok(None);
    };
    let base = match resolve_bridge_base_url(config) {
        Ok(u) => u,
        Err(_) => return Ok(None),
    };
    match customer_lookup(&base, &config.ams_bridge_token, &req).await {
        Ok(resp) if resp.ok => Ok(Some(resp)),
        Ok(resp) => {
            let msg = resp
                .error
                .as_ref()
                .map(|e| format!("{}: {}", e.code, e.message))
                .unwrap_or_else(|| "Customer-Lookup fehlgeschlagen".into());
            Err(format!("AMS Preflight: {msg}"))
        }
        Err(e) if is_unreachable(&e) => {
            // Soft: bridge down must not block file handoff.
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// `GET /v1/jobs/{correlation_id}` — Ok(None) on 404; Err on transport/auth/other.
pub async fn fetch_job_status(
    base_url: &str,
    token: &str,
    correlation_id: &str,
) -> Result<Option<StatusOutboxV1>, String> {
    let cid = correlation_id.trim();
    if cid.is_empty() {
        return Ok(None);
    }
    let base = normalize_base_url(base_url)?;
    let auth = auth_header(token)?;
    let client = http_client().await?;
    let resp = client
        .get(format!("{base}/v1/jobs/{cid}"))
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| format!("AMS-Bridge Job-Status nicht erreichbar: {e}"))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("AMS-Bridge: Token ungültig (401).".into());
    }
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let status = resp.status();
    let body = resp
        .json::<JobStatusResponse>()
        .await
        .map_err(|e| format!("AMS-Bridge Job-Status JSON (HTTP {status}): {e}"))?;
    if body.ok {
        return Ok(body.job);
    }
    if body
        .error
        .as_ref()
        .map(|e| e.code == "job_not_found")
        .unwrap_or(false)
    {
        return Ok(None);
    }
    let msg = body
        .error
        .as_ref()
        .map(|e| format!("{}: {}", e.code, e.message))
        .unwrap_or_else(|| format!("Job-Status fehlgeschlagen (HTTP {status})"));
    Err(msg)
}

/// Prefer Bridge job status; fall back to outbox file (P1b). Soft when bridge down.
/// Returns `(status, source)` where source is `"bridge"` or `"outbox"`.
pub async fn resolve_handoff_status(
    config: &AppConfig,
    correlation_id: &str,
    share_root: &std::path::Path,
) -> Result<Option<(StatusOutboxV1, &'static str)>, String> {
    let cid = correlation_id.trim();
    if cid.is_empty() {
        return Ok(None);
    }

    if bridge_configured(config) {
        if let Ok(base) = resolve_bridge_base_url(config) {
            match fetch_job_status(&base, &config.ams_bridge_token, cid).await {
                Ok(Some(job)) => return Ok(Some((job, "bridge"))),
                Ok(None) => {}
                Err(e) if is_unreachable(&e) => {}
                Err(e) => {
                    crate::storage::logging::warn(
                        "bridge",
                        format!("Job-Status Bridge fehlgeschlagen, Outbox-Fallback: {e}"),
                    );
                }
            }
        }
    }

    Ok(
        crate::video::handoff_manifest::read_status_outbox(share_root, cid)?
            .map(|j| (j, "outbox")),
    )
}

/// `POST /v1/handoff/ready` — optional wake after Manifest + `_fertig.txt`.
pub async fn notify_handoff_ready(
    base_url: &str,
    token: &str,
    correlation_id: &str,
    folder_name: Option<&str>,
) -> Result<HandoffReadyResponse, String> {
    let base = normalize_base_url(base_url)?;
    let auth = auth_header(token)?;
    let client = http_client().await?;
    let req = HandoffReadyRequest {
        correlation_id: correlation_id.trim().to_string(),
        folder_name: folder_name.unwrap_or("").trim().to_string(),
    };
    let resp = client
        .post(format!("{base}/v1/handoff/ready"))
        .header("Authorization", auth)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("AMS-Bridge handoff/ready nicht erreichbar: {e}"))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("AMS-Bridge: Token ungültig (401).".into());
    }
    let status = resp.status();
    let body = resp
        .json::<HandoffReadyResponse>()
        .await
        .map_err(|e| format!("AMS-Bridge handoff/ready JSON (HTTP {status}): {e}"))?;
    if !body.ok {
        let msg = body
            .error
            .as_ref()
            .map(|e| format!("{}: {}", e.code, e.message))
            .unwrap_or_else(|| format!("handoff/ready fehlgeschlagen (HTTP {status})"));
        return Err(msg);
    }
    Ok(body)
}

/// Soft: only when bridge configured; unreachable → Ok(None).
pub async fn maybe_notify_handoff_ready(
    config: &AppConfig,
    correlation_id: &str,
    folder_name: Option<&str>,
) -> Result<Option<HandoffReadyResponse>, String> {
    let cid = correlation_id.trim();
    if cid.is_empty() || config.skip_marker_file() || !bridge_configured(config) {
        return Ok(None);
    }
    let base = match resolve_bridge_base_url(config) {
        Ok(u) => u,
        Err(_) => return Ok(None),
    };
    match notify_handoff_ready(&base, &config.ams_bridge_token, cid, folder_name).await {
        Ok(resp) => Ok(Some(resp)),
        Err(e) if is_unreachable(&e) => Ok(None),
        Err(e) => {
            // Soft: do not fail the export if wake fails (file handoff already done).
            crate::storage::logging::warn(
                "bridge",
                format!("handoff/ready ignoriert (Export bleibt gültig): {e}"),
            );
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_requires_http_scheme() {
        assert!(normalize_base_url("169.254.1.1:8787").is_err());
        assert_eq!(
            normalize_base_url("http://169.254.1.1:8787/").unwrap(),
            "http://169.254.1.1:8787"
        );
    }

    #[test]
    fn lookup_request_prefers_hash_in_kunde_mode() {
        let mut k = Kunde::default();
        k.form_mode = "kunde".into();
        k.kunden_id_hash = Some("h1".into());
        k.booking_id_hash = Some("h2".into());
        let req = lookup_request_from_kunde(&k).unwrap();
        assert_eq!(req.mode, "hash");
        assert_eq!(req.customer_id, "h1");
    }

    #[test]
    fn lookup_request_uses_id_in_manual_mode() {
        let mut k = Kunde::default();
        k.form_mode = "manual".into();
        k.kunden_id = Some("42".into());
        k.booking_id = Some("99".into());
        let req = lookup_request_from_kunde(&k).unwrap();
        assert_eq!(req.mode, "id");
    }

    #[test]
    fn resolve_falls_back_to_last_ok() {
        let cfg = AppConfig {
            ams_bridge_url: String::new(),
            ams_bridge_last_ok_url: "http://10.0.0.5:8787".into(),
            ..AppConfig::default()
        };
        assert_eq!(
            resolve_bridge_base_url(&cfg).unwrap(),
            "http://10.0.0.5:8787"
        );
    }

    #[test]
    fn unreachable_detection() {
        assert!(is_unreachable(
            "AMS-Bridge Job-Status nicht erreichbar: timeout"
        ));
        assert!(!is_unreachable("AMS-Bridge: Token ungültig (401)."));
    }
}
