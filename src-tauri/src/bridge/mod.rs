//! AMS LAN Bridge client (Phase 13 / P4).
//! Spec: AMS `docs/HANDOFF.md` §9 — health, lookup, jobs, ready + mDNS discovery.
//! File handoff works without this module.

pub mod client_token;
pub mod cloud_lookup;
pub mod lookup_router;
mod http;
mod lookup_map;
mod mdns;

pub use http::BridgeError;
pub use mdns::{discover_bridges, DiscoveredBridge};

use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use uuid::Uuid;

use crate::model::Kunde;
use crate::storage::config::AppConfig;
use crate::util::host::current_computer_name;
use crate::video::handoff_manifest::StatusOutboxV1;
use http::{decode_body, Endpoint};

const ATS_BRIDGE_APP: &str = "AeroTandemStudio";

/// Client-taugliche SMB-Hints für ATS (HANDOFF.md §9.3). Wire-Format bevorzugt `smb://`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct AtsPathsHint {
    pub primary_smb_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub backup_smb_url: String,
}

/// Optional Cloud-Lookup hint from AMS health (HANDOFF §9.4). Never includes tokens.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CloudLookupHint {
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BridgeHealth {
    pub online: bool,
    pub version: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub instance_id: String,
    pub monitor_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ats_paths: Option<AtsPathsHint>,
    /// Present when AMS can issue Cloud JWTs (`cloud-lookup-v1`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_lookup: Option<CloudLookupHint>,
    pub capabilities: Vec<String>,
}

impl BridgeHealth {
    pub fn display_label(&self) -> String {
        let name = self.display_name.trim();
        if name.is_empty() {
            "AMS".into()
        } else {
            name.to_string()
        }
    }

    /// True when AMS advertises Cloud client-token issue (capability or hint).
    pub fn supports_cloud_lookup(&self) -> bool {
        client_token::health_supports_cloud_lookup(&self.capabilities)
            || self
                .cloud_lookup
                .as_ref()
                .map(|h| !h.base_url.trim().is_empty())
                .unwrap_or(false)
    }
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
    #[serde(default)]
    pub ist_bezahlt_handcam_foto: bool,
    #[serde(default)]
    pub ist_bezahlt_handcam_video: bool,
    #[serde(default)]
    pub ist_bezahlt_outside_foto: bool,
    #[serde(default)]
    pub ist_bezahlt_outside_video: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct HandoffCancelRequest {
    pub correlation_id: String,
    #[serde(default)]
    pub folder_name: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HandoffCancelResponse {
    pub ok: bool,
    pub cancelled: bool,
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

fn auth_header(token: &str) -> Result<String, BridgeError> {
    let t = token.trim();
    if t.is_empty() {
        return Err(BridgeError::Config("AMS-Bridge-Token fehlt.".into()));
    }
    Ok(format!("Bearer {t}"))
}

/// Validated base URL + `Authorization` value for one Bridge call.
fn prepare(base_url: &str, token: &str) -> Result<(String, String), BridgeError> {
    let base = normalize_base_url(base_url).map_err(BridgeError::Config)?;
    Ok((base, auth_header(token)?))
}

#[derive(Debug, Clone)]
pub struct AtsBridgeIdentity {
    instance_id: String,
    hostname: String,
    ats_version: String,
    ats_app: String,
}

pub fn build_ats_bridge_identity(config: &AppConfig) -> AtsBridgeIdentity {
    let raw_pc = config.sd_pc_name.trim().to_string();
    let hostname = if raw_pc.is_empty() {
        current_computer_name()
    } else {
        raw_pc
    };
    let instance_id = if config.ams_bridge_instance_id.trim().is_empty() {
        stable_instance_id_from_hostname(&hostname)
    } else {
        config.ams_bridge_instance_id.trim().to_string()
    };

    AtsBridgeIdentity {
        instance_id,
        hostname,
        ats_version: env!("CARGO_PKG_VERSION").to_string(),
        ats_app: ATS_BRIDGE_APP.to_string(),
    }
}

/// Stable but derived "UUID-like" identifier to group ATS hosts in AMS.
/// We generate deterministic bytes from SHA-1(hostname) and then set version/variant bits.
fn stable_instance_id_from_hostname(hostname: &str) -> String {
    let h = hostname.trim();
    let mut hasher = Sha1::new();
    hasher.update(h.as_bytes());
    let digest = hasher.finalize();

    let mut bytes16 = [0u8; 16];
    bytes16.copy_from_slice(&digest[..16]);

    // UUID version 4 (random) layout bits, but deterministic bytes.
    bytes16[6] = (bytes16[6] & 0x0f) | 0x40;
    bytes16[8] = (bytes16[8] & 0x3f) | 0x80;

    Uuid::from_bytes(bytes16).to_string()
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
    !config.ams_bridge_url.trim().is_empty() || !config.ams_bridge_last_ok_url.trim().is_empty()
}

/// Machine-readable create-preflight gate: customer/booking not found in AMS.
/// Frontend may soft-confirm and retry with `ams_preflight_ack`.
pub const AMS_PREFLIGHT_NOT_FOUND_PREFIX: &str = "AMS_PREFLIGHT_NOT_FOUND:";

/// Options for create-time customer preflight.
#[derive(Debug, Clone, Copy, Default)]
pub struct PreflightLookupOpts {
    /// Skip lookup: prior successful form lookup, or user confirmed not-found.
    pub skip: bool,
}

/// True when AMS reports the customer/booking is missing (hard confirm case).
/// Other `ok: false` responses (upstream/API down, generic failures) are soft.
pub fn is_lookup_not_found(code: &str, message: &str) -> bool {
    let c = code.trim().to_lowercase();
    if c == "not_found" || c.contains("not_found") {
        return true;
    }
    let m = message.to_lowercase();
    m.contains("nicht gefunden") || m.contains("not found")
}

pub async fn fetch_health(
    base_url: &str,
    token: &str,
    identity: &AtsBridgeIdentity,
) -> Result<BridgeHealth, BridgeError> {
    let (base, auth) = prepare(base_url, token)?;
    let resp = http::send::<()>(
        Endpoint::Health,
        Method::GET,
        format!("{base}/v1/health"),
        &auth,
        identity,
        None,
    )
    .await?;
    if !resp.status.is_success() {
        return Err(BridgeError::Http {
            endpoint: Endpoint::Health,
            status: resp.status.as_u16(),
            snippet: http::body_snippet(&resp.body),
        });
    }
    decode_body(Endpoint::Health, resp.status, &resp.body)
}

pub async fn check_health(config: &AppConfig) -> BridgeHealthResult {
    check_health_with(config, None, None).await
}

pub async fn check_health_with(
    config: &AppConfig,
    base_url_override: Option<&str>,
    token_override: Option<&str>,
) -> BridgeHealthResult {
    let identity = build_ats_bridge_identity(config);
    let base = match base_url_override {
        Some(raw) => match normalize_base_url(raw) {
            Ok(u) => u,
            Err(message) => {
                return BridgeHealthResult {
                    ok: false,
                    message,
                    health: None,
                    base_url: String::new(),
                };
            }
        },
        None => match resolve_bridge_base_url(config) {
            Ok(u) => u,
            Err(message) => {
                return BridgeHealthResult {
                    ok: false,
                    message,
                    health: None,
                    base_url: String::new(),
                };
            }
        },
    };
    let token = token_override.unwrap_or(&config.ams_bridge_token);
    match fetch_health(&base, token, &identity).await {
        Ok(health) => BridgeHealthResult {
            ok: health.online,
            message: if health.online {
                format!(
                    "AMS „{}“ online (v{}, capabilities: {})",
                    health.display_label(),
                    health.version,
                    health.capabilities.join(", ")
                )
            } else {
                "AMS meldet online=false".into()
            },
            health: Some(health),
            base_url: base,
        },
        Err(err) => BridgeHealthResult {
            ok: false,
            message: err.to_string(),
            health: None,
            base_url: base,
        },
    }
}

pub async fn customer_lookup(
    base_url: &str,
    token: &str,
    request: &LookupRequest,
    identity: &AtsBridgeIdentity,
) -> Result<LookupResponse, BridgeError> {
    let (base, auth) = prepare(base_url, token)?;
    let resp = http::send(
        Endpoint::Lookup,
        Method::POST,
        format!("{base}/v1/customer/lookup"),
        &auth,
        identity,
        Some(request),
    )
    .await?;
    decode_body(Endpoint::Lookup, resp.status, &resp.body)
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
/// - `opts.skip` → Ok(None) (already verified at form time, or user ack).
/// - Bridge unreachable / non-not-found lookup failure → Ok(None) (file handoff).
/// - Customer not found → Err(`AMS_PREFLIGHT_NOT_FOUND:…`) for soft confirm.
/// - Auth / hard transport errors (non-unreachable) → Err.
pub async fn preflight_customer_lookup(
    config: &AppConfig,
    kunde: &Kunde,
) -> Result<Option<LookupResponse>, String> {
    preflight_customer_lookup_with_opts(config, kunde, PreflightLookupOpts::default()).await
}

pub async fn preflight_customer_lookup_with_opts(
    config: &AppConfig,
    kunde: &Kunde,
    opts: PreflightLookupOpts,
) -> Result<Option<LookupResponse>, String> {
    if opts.skip {
        return Ok(None);
    }
    if config.skip_marker_file(&kunde.form_mode) {
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
    let identity = build_ats_bridge_identity(config);
    match customer_lookup(&base, &config.ams_bridge_token, &req, &identity).await {
        Ok(resp) if resp.ok => Ok(Some(resp)),
        Ok(resp) => {
            let (code, message) = resp
                .error
                .as_ref()
                .map(|e| (e.code.as_str(), e.message.as_str()))
                .unwrap_or(("", "Customer-Lookup fehlgeschlagen"));
            if is_lookup_not_found(code, message) {
                let detail = if code.is_empty() {
                    message.to_string()
                } else {
                    format!("{code}: {message}")
                };
                return Err(format!("{AMS_PREFLIGHT_NOT_FOUND_PREFIX} {detail}"));
            }
            // Soft: AMS up but upstream/API unavailable or other non-not-found failure.
            crate::storage::logging::warn(
                "bridge",
                format!(
                    "AMS Preflight soft (nicht blockierend): {}: {}",
                    if code.is_empty() { "error" } else { code },
                    message
                ),
            );
            Ok(None)
        }
        Err(e) if e.is_unreachable() => {
            // Soft: bridge down must not block file handoff.
            Ok(None)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// `GET /v1/jobs/{correlation_id}` — Ok(None) on 404; Err on transport/auth/other.
pub async fn fetch_job_status(
    base_url: &str,
    token: &str,
    correlation_id: &str,
    identity: &AtsBridgeIdentity,
) -> Result<Option<StatusOutboxV1>, BridgeError> {
    let cid = correlation_id.trim();
    if cid.is_empty() {
        return Ok(None);
    }
    let (base, auth) = prepare(base_url, token)?;
    let resp = http::send::<()>(
        Endpoint::JobStatus,
        Method::GET,
        format!("{base}/v1/jobs/{cid}"),
        &auth,
        identity,
        None,
    )
    .await?;
    interpret_job_status(resp.status, &resp.body)
}

fn interpret_job_status(
    status: StatusCode,
    body: &[u8],
) -> Result<Option<StatusOutboxV1>, BridgeError> {
    if status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let body: JobStatusResponse = decode_body(Endpoint::JobStatus, status, body)?;
    if let Some(job) = body.job {
        return Ok(Some(job));
    }
    if body.ok {
        return Ok(None);
    }
    if body
        .error
        .as_ref()
        .map(|e| e.code == "job_not_found")
        .unwrap_or(false)
    {
        return Ok(None);
    }
    Err(api_error(body.error, "Job-Status", status))
}

fn api_error(error: Option<LookupErrorBody>, what: &str, status: StatusCode) -> BridgeError {
    match error {
        Some(e) => BridgeError::Api {
            code: e.code,
            message: e.message,
        },
        None => BridgeError::Api {
            code: String::new(),
            message: format!("{what} fehlgeschlagen (HTTP {})", status.as_u16()),
        },
    }
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
    let identity = build_ats_bridge_identity(config);

    if bridge_configured(config) {
        if let Ok(base) = resolve_bridge_base_url(config) {
            match fetch_job_status(&base, &config.ams_bridge_token, cid, &identity).await {
                Ok(Some(job)) => return Ok(Some((job, "bridge"))),
                Ok(None) => {}
                Err(e) if e.is_unreachable() => {}
                Err(e) => {
                    crate::storage::logging::warn(
                        "bridge",
                        format!("Job-Status Bridge fehlgeschlagen, Outbox-Fallback: {e}"),
                    );
                }
            }
        }
    }

    Ok(crate::video::handoff_manifest::read_status_outbox(share_root, cid)?.map(|j| (j, "outbox")))
}

/// `POST /v1/handoff/ready` — optional wake after Manifest + `_fertig.txt`.
pub async fn notify_handoff_ready(
    base_url: &str,
    token: &str,
    correlation_id: &str,
    folder_name: Option<&str>,
    identity: &AtsBridgeIdentity,
) -> Result<HandoffReadyResponse, BridgeError> {
    let (base, auth) = prepare(base_url, token)?;
    let req = HandoffReadyRequest {
        correlation_id: correlation_id.trim().to_string(),
        folder_name: folder_name.unwrap_or("").trim().to_string(),
    };
    let resp = http::send(
        Endpoint::HandoffReady,
        Method::POST,
        format!("{base}/v1/handoff/ready"),
        &auth,
        identity,
        Some(&req),
    )
    .await?;
    let body: HandoffReadyResponse = decode_body(Endpoint::HandoffReady, resp.status, &resp.body)?;
    if !body.ok {
        return Err(api_error(body.error, "handoff/ready", resp.status));
    }
    Ok(body)
}

/// `POST /v1/handoff/cancel` — ATS aborted upload; drop pending handoff in AMS.
pub async fn notify_handoff_cancel(
    base_url: &str,
    token: &str,
    correlation_id: &str,
    folder_name: Option<&str>,
    reason: Option<&str>,
    identity: &AtsBridgeIdentity,
) -> Result<HandoffCancelResponse, BridgeError> {
    let (base, auth) = prepare(base_url, token)?;
    let req = HandoffCancelRequest {
        correlation_id: correlation_id.trim().to_string(),
        folder_name: folder_name.unwrap_or("").trim().to_string(),
        reason: reason.unwrap_or("Upload abgebrochen").trim().to_string(),
    };
    let resp = http::send(
        Endpoint::HandoffCancel,
        Method::POST,
        format!("{base}/v1/handoff/cancel"),
        &auth,
        identity,
        Some(&req),
    )
    .await?;
    let body: HandoffCancelResponse =
        decode_body(Endpoint::HandoffCancel, resp.status, &resp.body)?;
    if !body.ok {
        return Err(api_error(body.error, "handoff/cancel", resp.status));
    }
    Ok(body)
}

/// Soft: only when bridge configured; unreachable → Ok(None).
pub async fn maybe_notify_handoff_cancel(
    config: &AppConfig,
    correlation_id: &str,
    folder_name: Option<&str>,
    reason: Option<&str>,
) -> Result<Option<HandoffCancelResponse>, String> {
    let cid = correlation_id.trim();
    if cid.is_empty() || !bridge_configured(config) {
        return Ok(None);
    }
    let identity = build_ats_bridge_identity(config);
    let base = match resolve_bridge_base_url(config) {
        Ok(u) => u,
        Err(_) => return Ok(None),
    };
    match notify_handoff_cancel(
        &base,
        &config.ams_bridge_token,
        cid,
        folder_name,
        reason,
        &identity,
    )
    .await
    {
        Ok(resp) => Ok(Some(resp)),
        Err(e) if e.is_unreachable() => Ok(None),
        Err(e) => {
            crate::storage::logging::warn("bridge", format!("handoff/cancel ignoriert: {e}"));
            Ok(None)
        }
    }
}

/// Soft: only when bridge configured; unreachable → Ok(None).
/// Empty `correlation_id` already covers manual Lokal (no marker/manifest).
pub async fn maybe_notify_handoff_ready(
    config: &AppConfig,
    correlation_id: &str,
    folder_name: Option<&str>,
) -> Result<Option<HandoffReadyResponse>, String> {
    let cid = correlation_id.trim();
    if cid.is_empty() || !bridge_configured(config) {
        return Ok(None);
    }
    let identity = build_ats_bridge_identity(config);
    let base = match resolve_bridge_base_url(config) {
        Ok(u) => u,
        Err(_) => return Ok(None),
    };
    match notify_handoff_ready(&base, &config.ams_bridge_token, cid, folder_name, &identity).await {
        Ok(resp) => Ok(Some(resp)),
        Err(e) if e.is_unreachable() => Ok(None),
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
    fn missing_token_is_config_error_not_unreachable() {
        let err = prepare("http://10.0.0.5:8787", "  ").unwrap_err();
        assert!(matches!(err, BridgeError::Config(_)));
        assert!(!err.is_unreachable());
        let err = prepare("10.0.0.5:8787", "t").unwrap_err();
        assert!(matches!(err, BridgeError::Config(_)));
        let (base, auth) = prepare("http://10.0.0.5:8787/", " t ").unwrap();
        assert_eq!(base, "http://10.0.0.5:8787");
        assert_eq!(auth, "Bearer t");
    }

    #[test]
    fn job_status_404_and_job_not_found_are_none() {
        assert_eq!(
            interpret_job_status(StatusCode::NOT_FOUND, b"<html>nope</html>").unwrap(),
            None
        );
        let body = br#"{"ok":false,"error":{"code":"job_not_found","message":"x"}}"#;
        assert_eq!(
            interpret_job_status(StatusCode::OK, body).unwrap(),
            None
        );
        assert_eq!(
            interpret_job_status(StatusCode::OK, br#"{"ok":true}"#).unwrap(),
            None
        );
    }

    #[test]
    fn job_status_api_error_keeps_code() {
        let body = br#"{"ok":false,"error":{"code":"internal","message":"boom"}}"#;
        let err = interpret_job_status(StatusCode::INTERNAL_SERVER_ERROR, body).unwrap_err();
        assert_eq!(err.api_code(), Some("internal"));
        assert_eq!(err.to_string(), "internal: boom");
        assert!(!err.is_unreachable());
    }

    #[test]
    fn job_status_without_error_body_reports_http_status() {
        let err = interpret_job_status(StatusCode::BAD_GATEWAY, br#"{"ok":false}"#).unwrap_err();
        assert_eq!(err.to_string(), "Job-Status fehlgeschlagen (HTTP 502)");
    }

    #[test]
    fn job_status_html_on_error_is_http() {
        let err =
            interpret_job_status(StatusCode::SERVICE_UNAVAILABLE, b"<h1>down</h1>").unwrap_err();
        assert!(matches!(err, BridgeError::Http { status: 503, .. }));
    }

    #[test]
    fn lookup_not_found_detection() {
        assert!(is_lookup_not_found("not_found", "missing"));
        assert!(is_lookup_not_found("customer_not_found", "x"));
        assert!(is_lookup_not_found("", "Kunde nicht gefunden"));
        assert!(is_lookup_not_found("", "Customer not found"));
        // Generic lookup failure (e.g. upstream API down) must stay soft.
        assert!(!is_lookup_not_found("customer_lookup_failed", "upstream error"));
        assert!(!is_lookup_not_found("upstream_unavailable", "API down"));
        assert!(!is_lookup_not_found("internal_error", "boom"));
    }

    #[test]
    fn health_deserializes_optional_ats_paths() {
        let json = r#"{
            "online": true,
            "version": "0.4.0",
            "display_name": "AMS",
            "instance_id": "inst-1",
            "monitor_path": "D:\\Shares\\aktuell",
            "ats_paths": {
                "primary_smb_url": "smb://169.254.169.254/aktuell",
                "backup_smb_url": "smb://169.254.169.254/aktuell-backup"
            },
            "capabilities": ["lookup", "paths-v1"]
        }"#;
        let health: BridgeHealth = serde_json::from_str(json).expect("parse health");
        assert!(health.ats_paths.is_some());
        let paths = health.ats_paths.as_ref().unwrap();
        assert_eq!(paths.primary_smb_url, "smb://169.254.169.254/aktuell");
        assert_eq!(paths.backup_smb_url, "smb://169.254.169.254/aktuell-backup");
        assert!(health.capabilities.contains(&"paths-v1".to_string()));
        assert!(health.cloud_lookup.is_none());
        assert!(!health.supports_cloud_lookup());
    }

    #[test]
    fn health_deserializes_without_ats_paths() {
        let json = r#"{
            "online": true,
            "version": "0.3.0",
            "monitor_path": "D:\\x",
            "capabilities": ["lookup"]
        }"#;
        let health: BridgeHealth = serde_json::from_str(json).expect("parse health");
        assert!(health.ats_paths.is_none());
    }

    #[test]
    fn health_deserializes_cloud_lookup_hint() {
        let json = r#"{
            "online": true,
            "version": "0.5.0",
            "display_name": "AMS",
            "instance_id": "inst-2",
            "monitor_path": "D:\\Shares\\aktuell",
            "cloud_lookup": { "base_url": "https://cloud.example" },
            "capabilities": ["lookup", "cloud-lookup-v1"]
        }"#;
        let health: BridgeHealth = serde_json::from_str(json).expect("parse health");
        assert!(health.supports_cloud_lookup());
        assert_eq!(
            health.cloud_lookup.as_ref().unwrap().base_url,
            "https://cloud.example"
        );
    }
}
