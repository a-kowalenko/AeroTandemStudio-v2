//! Transport layer for the AMS Bridge client: shared HTTP client, typed errors,
//! request builder with ATS identity headers, status-aware JSON decoding.

use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;
use uuid::Uuid;

use super::AtsBridgeIdentity;
use crate::storage::logging;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const TCP_KEEPALIVE: Duration = Duration::from_secs(30);
const SNIPPET_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    Health,
    Lookup,
    JobStatus,
    HandoffReady,
    HandoffCancel,
}

impl Endpoint {
    pub fn label(self) -> &'static str {
        match self {
            Endpoint::Health => "health",
            Endpoint::Lookup => "Lookup",
            Endpoint::JobStatus => "Job-Status",
            Endpoint::HandoffReady => "handoff/ready",
            Endpoint::HandoffCancel => "handoff/cancel",
        }
    }

    /// Total request budget (connect is capped separately by `CONNECT_TIMEOUT`).
    /// Lookup may wait on the AMS upstream booking API, so it gets the longest budget.
    pub fn timeout(self) -> Duration {
        Duration::from_secs(match self {
            Endpoint::Health | Endpoint::JobStatus => 5,
            Endpoint::HandoffReady | Endpoint::HandoffCancel => 8,
            Endpoint::Lookup => 12,
        })
    }
}

/// Typed Bridge failure. `Display` keeps the German wording the frontend matches on
/// (`nicht erreichbar`, `Token ungültig (401)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    Config(String),
    Unreachable { endpoint: Endpoint, detail: String },
    Timeout { endpoint: Endpoint },
    Unauthorized,
    Http { endpoint: Endpoint, status: u16, snippet: String },
    Protocol { endpoint: Endpoint, status: u16, detail: String },
    Api { code: String, message: String },
}

impl BridgeError {
    /// Transport-level failure: AMS down, wrong IP, network gone, timeout.
    pub fn is_unreachable(&self) -> bool {
        matches!(
            self,
            BridgeError::Unreachable { .. } | BridgeError::Timeout { .. }
        )
    }

    pub fn api_code(&self) -> Option<&str> {
        match self {
            BridgeError::Api { code, .. } => Some(code.as_str()),
            _ => None,
        }
    }

    fn from_transport(endpoint: Endpoint, err: &reqwest::Error) -> Self {
        if err.is_timeout() {
            return BridgeError::Timeout { endpoint };
        }
        BridgeError::Unreachable {
            endpoint,
            detail: error_chain(err),
        }
    }
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BridgeError::Config(msg) => f.write_str(msg),
            BridgeError::Unreachable { endpoint, detail } => {
                write!(f, "AMS-Bridge {} nicht erreichbar: {detail}", endpoint.label())
            }
            BridgeError::Timeout { endpoint } => write!(
                f,
                "AMS-Bridge {} nicht erreichbar: Zeitüberschreitung nach {}s",
                endpoint.label(),
                endpoint.timeout().as_secs()
            ),
            BridgeError::Unauthorized => f.write_str("AMS-Bridge: Token ungültig (401)."),
            BridgeError::Http {
                endpoint,
                status,
                snippet,
            } => {
                write!(f, "AMS-Bridge {} fehlgeschlagen: HTTP {status}", endpoint.label())?;
                if !snippet.is_empty() {
                    write!(f, " {snippet}")?;
                }
                Ok(())
            }
            BridgeError::Protocol {
                endpoint,
                status,
                detail,
            } => write!(
                f,
                "AMS-Bridge {} JSON (HTTP {status}): {detail}",
                endpoint.label()
            ),
            BridgeError::Api { code, message } => {
                if code.is_empty() {
                    f.write_str(message)
                } else {
                    write!(f, "{code}: {message}")
                }
            }
        }
    }
}

impl std::error::Error for BridgeError {}

impl From<BridgeError> for String {
    fn from(err: BridgeError) -> Self {
        err.to_string()
    }
}

fn error_chain(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(inner) = source {
        let s = inner.to_string();
        if !s.is_empty() && !out.contains(&s) {
            out.push_str(": ");
            out.push_str(&s);
        }
        source = inner.source();
    }
    out
}

fn shared_client() -> Result<&'static reqwest::Client, BridgeError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .pool_idle_timeout(POOL_IDLE_TIMEOUT)
                .tcp_keepalive(TCP_KEEPALIVE)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| BridgeError::Config(format!("AMS-Bridge HTTP-Client: {e}")))
}

pub fn body_snippet(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut snippet: String = collapsed.chars().take(SNIPPET_CHARS).collect();
    if collapsed.chars().count() > SNIPPET_CHARS {
        snippet.push('…');
    }
    snippet
}

pub struct RawResponse {
    pub status: StatusCode,
    pub body: Vec<u8>,
}

/// One authenticated Bridge round-trip. 401 is mapped to `Unauthorized`;
/// other statuses are returned for the endpoint to interpret.
pub async fn send<B: Serialize + ?Sized>(
    endpoint: Endpoint,
    method: Method,
    url: String,
    auth: &str,
    identity: &AtsBridgeIdentity,
    json: Option<&B>,
) -> Result<RawResponse, BridgeError> {
    let request_id = Uuid::new_v4().to_string();
    let result = send_inner(endpoint, method, url, auth, identity, json, &request_id).await;
    if let Err(e) = &result {
        logging::debug(
            "bridge",
            format!("{} request_id={request_id}: {e}", endpoint.label()),
        );
    }
    result
}

async fn send_inner<B: Serialize + ?Sized>(
    endpoint: Endpoint,
    method: Method,
    url: String,
    auth: &str,
    identity: &AtsBridgeIdentity,
    json: Option<&B>,
    request_id: &str,
) -> Result<RawResponse, BridgeError> {
    let mut builder = shared_client()?
        .request(method, url)
        .timeout(endpoint.timeout())
        .header(reqwest::header::AUTHORIZATION, auth)
        .header("x-request-id", request_id)
        .header("x-ats-instance-id", identity.instance_id.as_str())
        .header("x-ats-hostname", identity.hostname.as_str())
        .header("x-ats-version", identity.ats_version.as_str())
        .header("x-ats-app", identity.ats_app.as_str());
    if let Some(body) = json {
        builder = builder.json(body);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| BridgeError::from_transport(endpoint, &e))?;
    let status = resp.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(BridgeError::Unauthorized);
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| BridgeError::from_transport(endpoint, &e))?
        .to_vec();
    Ok(RawResponse { status, body })
}

/// Decode a JSON envelope. Error statuses may still carry the envelope (AMS sends
/// `{ ok: false, error }` on 4xx/502); a non-JSON body (proxy page, other service)
/// becomes `Http` on error statuses and `Protocol` on 2xx.
pub fn decode_body<T: DeserializeOwned>(
    endpoint: Endpoint,
    status: StatusCode,
    body: &[u8],
) -> Result<T, BridgeError> {
    match serde_json::from_slice::<T>(body) {
        Ok(v) => Ok(v),
        Err(_) if !status.is_success() => Err(BridgeError::Http {
            endpoint,
            status: status.as_u16(),
            snippet: body_snippet(body),
        }),
        Err(e) => {
            let snippet = body_snippet(body);
            let detail = if snippet.is_empty() {
                format!("{e} (leere Antwort)")
            } else {
                format!("{e} — Antwort: {snippet}")
            };
            Err(BridgeError::Protocol {
                endpoint,
                status: status.as_u16(),
                detail,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Envelope {
        ok: bool,
    }

    #[test]
    fn unreachable_and_timeout_keep_frontend_wording() {
        let unreachable = BridgeError::Unreachable {
            endpoint: Endpoint::Lookup,
            detail: "connection refused".into(),
        };
        let timeout = BridgeError::Timeout {
            endpoint: Endpoint::JobStatus,
        };
        assert!(unreachable.is_unreachable());
        assert!(timeout.is_unreachable());
        assert!(unreachable.to_string().contains("nicht erreichbar"));
        assert!(timeout.to_string().contains("nicht erreichbar"));
        assert!(timeout.to_string().contains("5s"));
    }

    #[test]
    fn unauthorized_message_matches_token_hint_regex() {
        let msg = BridgeError::Unauthorized.to_string();
        assert_eq!(msg, "AMS-Bridge: Token ungültig (401).");
        assert!(!BridgeError::Unauthorized.is_unreachable());
    }

    #[test]
    fn hard_errors_are_not_unreachable() {
        for err in [
            BridgeError::Config("x".into()),
            BridgeError::Http {
                endpoint: Endpoint::Health,
                status: 500,
                snippet: String::new(),
            },
            BridgeError::Protocol {
                endpoint: Endpoint::Health,
                status: 200,
                detail: "bad".into(),
            },
            BridgeError::Api {
                code: "c".into(),
                message: "m".into(),
            },
        ] {
            assert!(!err.is_unreachable(), "{err:?}");
        }
    }

    #[test]
    fn api_error_display() {
        let with_code = BridgeError::Api {
            code: "job_not_found".into(),
            message: "missing".into(),
        };
        assert_eq!(with_code.to_string(), "job_not_found: missing");
        assert_eq!(with_code.api_code(), Some("job_not_found"));
        let without = BridgeError::Api {
            code: String::new(),
            message: "handoff/ready fehlgeschlagen (HTTP 500)".into(),
        };
        assert_eq!(without.to_string(), "handoff/ready fehlgeschlagen (HTTP 500)");
    }

    #[test]
    fn decode_accepts_json_envelope_on_error_status() {
        let v: Envelope =
            decode_body(Endpoint::Lookup, StatusCode::BAD_GATEWAY, br#"{"ok":false}"#).unwrap();
        assert_eq!(v, Envelope { ok: false });
    }

    #[test]
    fn decode_html_on_error_status_is_http_with_snippet() {
        let err = decode_body::<Envelope>(
            Endpoint::HandoffReady,
            StatusCode::INTERNAL_SERVER_ERROR,
            b"<html>\n  <body>Bad   Gateway</body></html>",
        )
        .unwrap_err();
        match &err {
            BridgeError::Http {
                status, snippet, ..
            } => {
                assert_eq!(*status, 500);
                assert_eq!(snippet, "<html> <body>Bad Gateway</body></html>");
            }
            other => panic!("expected Http, got {other:?}"),
        }
        assert!(err
            .to_string()
            .starts_with("AMS-Bridge handoff/ready fehlgeschlagen: HTTP 500"));
    }

    #[test]
    fn decode_html_on_success_is_protocol_with_snippet() {
        let err =
            decode_body::<Envelope>(Endpoint::Health, StatusCode::OK, b"<html>proxy</html>")
                .unwrap_err();
        match &err {
            BridgeError::Protocol { status, detail, .. } => {
                assert_eq!(*status, 200);
                assert!(detail.contains("<html>proxy</html>"));
            }
            other => panic!("expected Protocol, got {other:?}"),
        }
    }

    #[test]
    fn decode_empty_success_body_is_protocol() {
        let err = decode_body::<Envelope>(Endpoint::JobStatus, StatusCode::OK, b"").unwrap_err();
        assert!(matches!(err, BridgeError::Protocol { .. }));
        assert!(err.to_string().contains("leere Antwort"));
    }

    #[test]
    fn snippet_is_truncated() {
        let long = "x".repeat(SNIPPET_CHARS + 50);
        let s = body_snippet(long.as_bytes());
        assert_eq!(s.chars().count(), SNIPPET_CHARS + 1);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn endpoint_budgets_stay_below_old_global_timeout() {
        for ep in [
            Endpoint::Health,
            Endpoint::Lookup,
            Endpoint::JobStatus,
            Endpoint::HandoffReady,
            Endpoint::HandoffCancel,
        ] {
            assert!(ep.timeout() < Duration::from_secs(15));
            assert!(ep.timeout() > CONNECT_TIMEOUT);
        }
    }
}
