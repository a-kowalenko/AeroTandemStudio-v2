//! User choice when Intro+Body stream-copy fails (avoid silent full re-encode).

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::ffmpeg::is_cancelled;

pub const EVENT_INTRO_MUX_FALLBACK: &str = "intro-mux-fallback-required";
pub const DEFAULT_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntroMuxChoice {
    /// Export body only (stream-copy remux) — default / timeout.
    WithoutIntro,
    /// Keep intro and re-encode intro+body.
    WithIntroEncode,
}

impl IntroMuxChoice {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "without_intro" | "ohne_intro" | "ohne-intro" => Some(Self::WithoutIntro),
            "with_intro_encode" | "mit_intro" | "mit-intro" | "encode" => {
                Some(Self::WithIntroEncode)
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct IntroMuxFallbackPayload {
    pub reason: String,
    pub timeout_secs: u64,
}

static PENDING: Lazy<Mutex<Option<mpsc::Sender<IntroMuxChoice>>>> =
    Lazy::new(|| Mutex::new(None));

fn clear_pending() {
    if let Ok(mut g) = PENDING.lock() {
        *g = None;
    }
}

/// Emit UI event and block until the user chooses or [`DEFAULT_TIMEOUT_SECS`] elapse.
///
/// Default / timeout / disconnect → [`IntroMuxChoice::WithoutIntro`].
/// Returns `Err(())` when encode was cancelled while waiting.
pub fn wait_for_choice(app: &AppHandle, reason: &str) -> Result<IntroMuxChoice, ()> {
    let (tx, rx) = mpsc::channel();
    {
        let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        *g = Some(tx);
    }

    let payload = IntroMuxFallbackPayload {
        reason: reason.to_string(),
        timeout_secs: DEFAULT_TIMEOUT_SECS,
    };
    let _ = app.emit(EVENT_INTRO_MUX_FALLBACK, &payload);

    let deadline = Instant::now() + Duration::from_secs(DEFAULT_TIMEOUT_SECS);
    loop {
        if is_cancelled() {
            clear_pending();
            return Err(());
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(choice) => {
                clear_pending();
                return Ok(choice);
            }
            Err(RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    clear_pending();
                    return Ok(IntroMuxChoice::WithoutIntro);
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                clear_pending();
                return Ok(IntroMuxChoice::WithoutIntro);
            }
        }
    }
}

/// Resolve a pending fallback decision from the frontend.
pub fn resolve_choice(choice: IntroMuxChoice) -> Result<(), String> {
    let tx = {
        let mut g = PENDING.lock().map_err(|e| e.to_string())?;
        g.take()
    };
    match tx {
        Some(tx) => {
            let _ = tx.send(choice);
            Ok(())
        }
        None => Err("Keine ausstehende Intro-Mux-Entscheidung".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_choice_aliases() {
        assert_eq!(
            IntroMuxChoice::parse("without_intro"),
            Some(IntroMuxChoice::WithoutIntro)
        );
        assert_eq!(
            IntroMuxChoice::parse("with_intro_encode"),
            Some(IntroMuxChoice::WithIntroEncode)
        );
        assert_eq!(IntroMuxChoice::parse("bogus"), None);
    }

    #[test]
    fn resolve_without_pending_errors() {
        clear_pending();
        assert!(resolve_choice(IntroMuxChoice::WithoutIntro).is_err());
    }
}
