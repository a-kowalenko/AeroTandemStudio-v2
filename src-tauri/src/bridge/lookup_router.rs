//! Phase 53 / T2 — Booking-lookup router (AMS-first, Cloud fallback).
//! Spec: `docs/phases/open/53-cloud-lookup-fallback.md` · Master §4 Routing.
//!
//! Create-preflight stays AMS-only (`preflight_customer_lookup`) — never call this for create.

use std::fmt;

use chrono::{DateTime, Utc};

use super::cloud_lookup::{self, CloudLookupError};
use super::http::BridgeError;
use super::{
    build_ats_bridge_identity, bridge_configured, client_token, customer_lookup,
    resolve_bridge_base_url, LookupRequest, LookupResponse,
};
use crate::storage::config::AppConfig;
use crate::storage::logging;

/// Which backend answered a routed lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LookupBackend {
    Ams,
    Cloud,
}

/// Successful routed lookup (response shape is AMS-compatible either way).
#[derive(Debug, Clone, PartialEq)]
pub struct RoutedLookupOk {
    pub response: LookupResponse,
    pub via: LookupBackend,
}

/// Failure from the AMS-first router.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutedLookupError {
    /// Neither AMS nor a usable Cloud JWT path.
    Unreachable(String),
    Ams(BridgeError),
    Cloud(CloudLookupError),
}

impl RoutedLookupError {
    /// Cloud rejected JWT — caller must clear persisted token.
    pub fn should_clear_cloud_token(&self) -> bool {
        matches!(self, RoutedLookupError::Cloud(e) if e.is_token_invalid())
    }

    pub fn is_unreachable(&self) -> bool {
        match self {
            RoutedLookupError::Unreachable(_) => true,
            RoutedLookupError::Ams(e) => e.is_unreachable(),
            RoutedLookupError::Cloud(e) => e.is_unreachable(),
        }
    }
}

impl fmt::Display for RoutedLookupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RoutedLookupError::Unreachable(msg) => f.write_str(msg),
            RoutedLookupError::Ams(e) => e.fmt(f),
            RoutedLookupError::Cloud(e) => e.fmt(f),
        }
    }
}

impl From<RoutedLookupError> for String {
    fn from(err: RoutedLookupError) -> Self {
        err.to_string()
    }
}

/// Pure route selection for tests / gate helpers (T3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectLookupBackend {
    pub ams_configured: bool,
    pub cloud_usable: bool,
}

/// Primary backend to attempt first. `None` → offline.
pub fn select_primary_backend(sel: SelectLookupBackend) -> Option<LookupBackend> {
    if sel.ams_configured {
        Some(LookupBackend::Ams)
    } else if sel.cloud_usable {
        Some(LookupBackend::Cloud)
    } else {
        None
    }
}

/// After AMS transport failure: fall back to Cloud only when AMS was unreachable
/// and a usable Cloud JWT exists. Auth/API errors stay AMS (no silent Cloud hop).
pub fn should_fallback_to_cloud(ams_err: &BridgeError, cloud_usable: bool) -> bool {
    cloud_usable && ams_err.is_unreachable()
}

fn cloud_usable_now(config: &AppConfig, now: DateTime<Utc>) -> bool {
    client_token::load_from_config(config)
        .map(|t| client_token::is_usable(&t, now))
        .unwrap_or(false)
}

fn both_unreachable_message() -> String {
    "Buchungssuche nicht erreichbar (AMS und Cloud).".into()
}

fn offline_message() -> String {
    "Buchungssuche nicht erreichbar.".into()
}

/// AMS-first booking lookup. Cloud only when AMS is not configured or AMS is unreachable.
/// Does **not** replace create-preflight.
pub async fn routed_customer_lookup(
    config: &AppConfig,
    request: &LookupRequest,
    now: DateTime<Utc>,
) -> Result<RoutedLookupOk, RoutedLookupError> {
    let cloud_ok = cloud_usable_now(config, now);
    let ams_ok = bridge_configured(config);
    let identity = build_ats_bridge_identity(config);

    match select_primary_backend(SelectLookupBackend {
        ams_configured: ams_ok,
        cloud_usable: cloud_ok,
    }) {
        None => Err(RoutedLookupError::Unreachable(offline_message())),
        Some(LookupBackend::Cloud) => lookup_via_cloud(config, request, &identity).await,
        Some(LookupBackend::Ams) => {
            let base = match resolve_bridge_base_url(config) {
                Ok(u) => u,
                Err(msg) => {
                    // Configured flag true but URL unusable — try Cloud if possible.
                    if cloud_ok {
                        return lookup_via_cloud(config, request, &identity).await;
                    }
                    return Err(RoutedLookupError::Unreachable(msg));
                }
            };
            match customer_lookup(&base, &config.ams_bridge_token, request, &identity).await {
                Ok(response) => Ok(RoutedLookupOk {
                    response,
                    via: LookupBackend::Ams,
                }),
                Err(ams_err) if should_fallback_to_cloud(&ams_err, cloud_ok) => {
                    logging::info(
                        "bridge",
                        "AMS-Lookup unreachable — fallback to Cloud-Lookup",
                    );
                    match lookup_via_cloud(config, request, &identity).await {
                        Ok(ok) => Ok(ok),
                        Err(RoutedLookupError::Cloud(cloud_err)) if cloud_err.is_unreachable() => {
                            Err(RoutedLookupError::Unreachable(both_unreachable_message()))
                        }
                        Err(other) => Err(other),
                    }
                }
                Err(ams_err) => Err(RoutedLookupError::Ams(ams_err)),
            }
        }
    }
}

async fn lookup_via_cloud(
    config: &AppConfig,
    request: &LookupRequest,
    identity: &super::AtsBridgeIdentity,
) -> Result<RoutedLookupOk, RoutedLookupError> {
    let Some(token) = client_token::load_from_config(config) else {
        return Err(RoutedLookupError::Unreachable(offline_message()));
    };
    match cloud_lookup::customer_lookup(
        &token.cloud_base_url,
        &token.access_token,
        request,
        identity,
    )
    .await
    {
        Ok(response) => Ok(RoutedLookupOk {
            response,
            via: LookupBackend::Cloud,
        }),
        Err(e) => Err(RoutedLookupError::Cloud(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::http::Endpoint;

    #[test]
    fn select_primary_prefers_ams_when_configured() {
        assert_eq!(
            select_primary_backend(SelectLookupBackend {
                ams_configured: true,
                cloud_usable: true,
            }),
            Some(LookupBackend::Ams)
        );
        assert_eq!(
            select_primary_backend(SelectLookupBackend {
                ams_configured: true,
                cloud_usable: false,
            }),
            Some(LookupBackend::Ams)
        );
    }

    #[test]
    fn select_primary_cloud_when_ams_absent() {
        assert_eq!(
            select_primary_backend(SelectLookupBackend {
                ams_configured: false,
                cloud_usable: true,
            }),
            Some(LookupBackend::Cloud)
        );
    }

    #[test]
    fn select_primary_none_when_offline() {
        assert_eq!(
            select_primary_backend(SelectLookupBackend {
                ams_configured: false,
                cloud_usable: false,
            }),
            None
        );
    }

    #[test]
    fn fallback_only_on_ams_unreachable() {
        let unreachable = BridgeError::Unreachable {
            endpoint: Endpoint::Lookup,
            detail: "connection refused".into(),
        };
        let timeout = BridgeError::Timeout {
            endpoint: Endpoint::Lookup,
        };
        let unauthorized = BridgeError::Unauthorized;
        let api = BridgeError::Api {
            code: "not_found".into(),
            message: "missing".into(),
        };

        assert!(should_fallback_to_cloud(&unreachable, true));
        assert!(should_fallback_to_cloud(&timeout, true));
        assert!(!should_fallback_to_cloud(&unreachable, false));
        assert!(!should_fallback_to_cloud(&unauthorized, true));
        assert!(!should_fallback_to_cloud(&api, true));
    }

    #[test]
    fn cloud_token_invalid_clears_flag() {
        let err = RoutedLookupError::Cloud(CloudLookupError::TokenInvalid);
        assert!(err.should_clear_cloud_token());
        assert!(!err.is_unreachable());
        assert!(err.to_string().contains("401"));
    }

    #[test]
    fn both_unreachable_message_matches_frontend() {
        let msg = both_unreachable_message();
        assert!(msg.contains("nicht erreichbar"));
        let offline = offline_message();
        assert!(offline.contains("nicht erreichbar"));
    }

    /// Phase 53 / T4 — Master §10 scenarios that the pure router encodes (no network).
    #[test]
    fn acceptance_matrix_ams_first_then_cloud_then_offline() {
        // #1–3 / #4 primary: AMS configured → AMS even when Cloud JWT usable
        assert_eq!(
            select_primary_backend(SelectLookupBackend {
                ams_configured: true,
                cloud_usable: true,
            }),
            Some(LookupBackend::Ams)
        );
        // #4: AMS absent, Cloud usable → Cloud
        assert_eq!(
            select_primary_backend(SelectLookupBackend {
                ams_configured: false,
                cloud_usable: true,
            }),
            Some(LookupBackend::Cloud)
        );
        // #5–6: neither → offline
        assert_eq!(
            select_primary_backend(SelectLookupBackend {
                ams_configured: false,
                cloud_usable: false,
            }),
            None
        );
        // AMS unreachable + Cloud → fallback; AMS auth/API → no silent Cloud hop
        let unreachable = BridgeError::Unreachable {
            endpoint: Endpoint::Lookup,
            detail: "refused".into(),
        };
        let unauthorized = BridgeError::Unauthorized;
        assert!(should_fallback_to_cloud(&unreachable, true));
        assert!(!should_fallback_to_cloud(&unauthorized, true));
        // #8: Cloud 401 → clear token flag
        assert!(RoutedLookupError::Cloud(CloudLookupError::TokenInvalid).should_clear_cloud_token());
    }
}
