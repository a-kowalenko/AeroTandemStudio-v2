//! User confirmation before any video re-encode (except watermark videos).
//!
//! Emits a Tauri event, blocks until the UI resolves with Abort or Proceed+profile.
//! No auto-timeout on proceed.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::encode_profile::{EncodePresetId, EncodeProfile};
use super::ffmpeg::is_cancelled;

pub const EVENT_REENCODE_CONFIRM: &str = "reencode-confirm-required";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReencodeChoice {
    /// User cancelled — stop the job.
    Abort,
    /// Proceed with re-encode (profile sent separately / embedded in decision).
    Proceed,
}

impl ReencodeChoice {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "abort" | "cancel" | "abbrechen" => Some(Self::Abort),
            "proceed" | "confirm" | "ok" | "encode" | "ja" => Some(Self::Proceed),
            _ => None,
        }
    }
}

/// Result of the confirmation UI (abort or proceed with an encode profile).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReencodeDecision {
    Abort,
    Proceed(EncodeProfile),
}

/// Why / which pipeline stage needs a re-encode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReencodeKind {
    IntroMux,
    PreviewClips,
    PreviewCombined,
    PreviewRemuxFallback,
    BodyParallel,
    ConcatFallback,
    RemuxFallback,
    Rotate,
}

impl ReencodeKind {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IntroMux => "intro_mux",
            Self::PreviewClips => "preview_clips",
            Self::PreviewCombined => "preview_combined",
            Self::PreviewRemuxFallback => "preview_remux_fallback",
            Self::BodyParallel => "body_parallel",
            Self::ConcatFallback => "concat_fallback",
            Self::RemuxFallback => "remux_fallback",
            Self::Rotate => "rotate",
        }
    }
}

/// Encoding parameters shown in the confirmation dialog (legacy + extras).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ReencodeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crf: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hw_accel: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro_duration_secs: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro_mux_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degrees: Option<i32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
}

/// Full intent payload sent to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReencodeIntent {
    pub kind: ReencodeKind,
    pub reason: String,
    #[serde(default)]
    pub params: ReencodeParams,
    /// Suggested encode profile (shown as "Empfohlen").
    #[serde(default)]
    pub recommended: EncodeProfile,
}

impl ReencodeIntent {
    pub fn new(kind: ReencodeKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            reason: reason.into(),
            params: ReencodeParams::default(),
            recommended: EncodeProfile::recommend(kind, 18, true, None),
        }
    }

    pub fn with_params(mut self, params: ReencodeParams) -> Self {
        // Keep recommended in sync with displayed CRF/HW when present.
        let crf = params.crf.unwrap_or(self.recommended.crf);
        let hw = params.hw_accel.unwrap_or(self.recommended.hw_accel);
        let codec = params
            .target_codec
            .as_deref()
            .or(self.recommended.resolved_codec.as_deref())
            .or(Some(self.recommended.codec.as_str()));
        self.recommended = EncodeProfile::recommend(self.kind, crf, hw, codec);
        self.params = params;
        // Mirror key fields into params for the summary rows.
        self.params.crf = Some(self.recommended.crf);
        self.params.hw_accel = Some(self.recommended.hw_accel);
        self.params.target_codec = Some(
            self.recommended
                .resolved_codec
                .clone()
                .unwrap_or_else(|| self.recommended.codec.clone()),
        );
        self
    }

    pub fn with_recommended(mut self, profile: EncodeProfile) -> Self {
        self.params.crf = Some(profile.crf);
        self.params.hw_accel = Some(profile.hw_accel);
        self.params.target_codec = Some(
            profile
                .resolved_codec
                .clone()
                .unwrap_or_else(|| profile.codec.clone()),
        );
        self.recommended = profile;
        self
    }
}

/// Called before starting a re-encode. Return `Err(())` to abort.
pub type ReencodeAskFn =
    Arc<dyn Fn(&ReencodeIntent) -> Result<ReencodeDecision, ()> + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
pub struct ReencodeConfirmPayload {
    pub kind: ReencodeKind,
    pub reason: String,
    pub params: ReencodeParams,
    pub recommended: EncodeProfile,
    /// Preset ids the UI should offer (excluding `custom`).
    pub presets: Vec<&'static str>,
}

impl From<&ReencodeIntent> for ReencodeConfirmPayload {
    fn from(intent: &ReencodeIntent) -> Self {
        Self {
            kind: intent.kind,
            reason: intent.reason.clone(),
            params: intent.params.clone(),
            recommended: intent.recommended.clone(),
            presets: EncodePresetId::all_selectable()
                .iter()
                .map(|p| p.as_str())
                .collect(),
        }
    }
}

static PENDING: Lazy<Mutex<Option<mpsc::Sender<ReencodeDecision>>>> =
    Lazy::new(|| Mutex::new(None));

fn clear_pending() {
    if let Ok(mut g) = PENDING.lock() {
        *g = None;
    }
}

/// Emit UI event and block until the user chooses Proceed(+profile) or Abort.
pub fn wait_for_choice(app: &AppHandle, intent: &ReencodeIntent) -> Result<ReencodeDecision, ()> {
    let (tx, rx) = mpsc::channel();
    {
        let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        *g = Some(tx);
    }

    let payload = ReencodeConfirmPayload::from(intent);
    let _ = app.emit(EVENT_REENCODE_CONFIRM, &payload);

    loop {
        if is_cancelled() {
            clear_pending();
            return Err(());
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(decision) => {
                clear_pending();
                return Ok(decision);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                clear_pending();
                return Err(());
            }
        }
    }
}

/// Resolve a pending confirmation from the frontend.
pub fn resolve_choice(
    choice: ReencodeChoice,
    profile: Option<EncodeProfile>,
) -> Result<(), String> {
    let decision = match choice {
        ReencodeChoice::Abort => ReencodeDecision::Abort,
        ReencodeChoice::Proceed => {
            let p = profile.ok_or_else(|| {
                "Neu-Kodierung bestätigt, aber kein Encode-Profil übergeben".to_string()
            })?;
            ReencodeDecision::Proceed(p)
        }
    };
    let tx = {
        let mut g = PENDING.lock().map_err(|e| e.to_string())?;
        g.take()
    };
    match tx {
        Some(tx) => {
            let _ = tx.send(decision);
            Ok(())
        }
        None => Err("Keine ausstehende Neu-Kodierungs-Bestätigung".into()),
    }
}

/// Ask the user (when `ask` is set). `None` → use recommended profile (tests / silent).
///
/// Returns the profile to use for encoding, or `Err(())` when aborted/cancelled.
pub fn require_confirm(
    ask: Option<&ReencodeAskFn>,
    intent: &ReencodeIntent,
) -> Result<EncodeProfile, ()> {
    let recommended = intent.recommended.clone();
    let Some(ask) = ask else {
        return Ok(recommended);
    };
    match ask(intent) {
        Ok(ReencodeDecision::Proceed(profile)) => Ok(profile),
        Ok(ReencodeDecision::Abort) | Err(()) => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_choice_aliases() {
        assert_eq!(ReencodeChoice::parse("abort"), Some(ReencodeChoice::Abort));
        assert_eq!(
            ReencodeChoice::parse("proceed"),
            Some(ReencodeChoice::Proceed)
        );
        assert_eq!(
            ReencodeChoice::parse("confirm"),
            Some(ReencodeChoice::Proceed)
        );
        assert_eq!(ReencodeChoice::parse("bogus"), None);
    }

    #[test]
    fn resolve_without_pending_errors() {
        clear_pending();
        assert!(resolve_choice(ReencodeChoice::Abort, None).is_err());
    }

    #[test]
    fn require_confirm_none_returns_recommended() {
        let intent = ReencodeIntent::new(ReencodeKind::Rotate, "test");
        let p = require_confirm(None, &intent).unwrap();
        assert_eq!(p.preset_id, EncodePresetId::Recommended);
        assert!(p.crf <= 16);
    }

    #[test]
    fn require_confirm_abort() {
        let ask: ReencodeAskFn = Arc::new(|_i| Ok(ReencodeDecision::Abort));
        let intent = ReencodeIntent::new(ReencodeKind::ConcatFallback, "codecs");
        assert!(require_confirm(Some(&ask), &intent).is_err());
    }

    #[test]
    fn require_confirm_proceed_profile() {
        let ask: ReencodeAskFn = Arc::new(|i| {
            assert_eq!(i.kind, ReencodeKind::IntroMux);
            Ok(ReencodeDecision::Proceed(i.recommended.clone()))
        });
        let intent = ReencodeIntent::new(ReencodeKind::IntroMux, "intro").with_params(
            ReencodeParams {
                crf: Some(18),
                clip_count: Some(2),
                ..Default::default()
            },
        );
        let p = require_confirm(Some(&ask), &intent).unwrap();
        assert_eq!(p.crf, 18);
    }

    #[test]
    fn kind_as_str_stable() {
        assert_eq!(ReencodeKind::IntroMux.as_str(), "intro_mux");
        assert_eq!(ReencodeKind::Rotate.as_str(), "rotate");
    }

    #[test]
    fn with_params_builds_recommended() {
        let intent = ReencodeIntent::new(ReencodeKind::PreviewClips, "x").with_params(
            ReencodeParams {
                crf: Some(16),
                hw_accel: Some(false),
                target_codec: Some("h265".into()),
                ..Default::default()
            },
        );
        assert_eq!(intent.recommended.crf, 16);
        assert!(!intent.recommended.hw_accel);
        assert_eq!(intent.recommended.codec, "auto");
        assert_eq!(intent.recommended.resolved_codec.as_deref(), Some("h265"));
    }
}
