//! User choice when Fast-Path body concat fails (no silent Legacy fallback).

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::ffmpeg::is_cancelled;

pub const EVENT_BODY_CONCAT_FALLBACK: &str = "body-concat-fallback-required";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyConcatChoice {
    /// Stop the create/export job.
    Abort,
    /// Retry with MPEG-TS / Normalize legacy pipeline.
    UseLegacy,
}

impl BodyConcatChoice {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "abort" | "cancel" | "abbrechen" => Some(Self::Abort),
            "use_legacy" | "legacy" | "legacy_mode" => Some(Self::UseLegacy),
            _ => None,
        }
    }
}

/// Called when Fast-Path body concat fails. Return `Err(())` to abort (cancellation).
pub type BodyConcatAskFn = Arc<dyn Fn(&str) -> Result<BodyConcatChoice, ()> + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
pub struct BodyConcatFallbackPayload {
    pub reason: String,
}

static PENDING: Lazy<Mutex<Option<mpsc::Sender<BodyConcatChoice>>>> =
    Lazy::new(|| Mutex::new(None));

fn clear_pending() {
    if let Ok(mut g) = PENDING.lock() {
        *g = None;
    }
}

/// Emit UI event and block until the user chooses Abort or Legacy.
///
/// No auto-timeout — waits until choice or encode cancel.
/// Returns `Err(())` when encode was cancelled while waiting.
pub fn wait_for_choice(app: &AppHandle, reason: &str) -> Result<BodyConcatChoice, ()> {
    let (tx, rx) = mpsc::channel();
    {
        let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        *g = Some(tx);
    }

    let payload = BodyConcatFallbackPayload {
        reason: reason.to_string(),
    };
    let _ = app.emit(EVENT_BODY_CONCAT_FALLBACK, &payload);

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
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                clear_pending();
                return Err(());
            }
        }
    }
}

/// Resolve a pending fallback decision from the frontend.
pub fn resolve_choice(choice: BodyConcatChoice) -> Result<(), String> {
    let tx = {
        let mut g = PENDING.lock().map_err(|e| e.to_string())?;
        g.take()
    };
    match tx {
        Some(tx) => {
            let _ = tx.send(choice);
            Ok(())
        }
        None => Err("Keine ausstehende Body-Concat-Entscheidung".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_choice_aliases() {
        assert_eq!(
            BodyConcatChoice::parse("abort"),
            Some(BodyConcatChoice::Abort)
        );
        assert_eq!(
            BodyConcatChoice::parse("use_legacy"),
            Some(BodyConcatChoice::UseLegacy)
        );
        assert_eq!(
            BodyConcatChoice::parse("legacy"),
            Some(BodyConcatChoice::UseLegacy)
        );
        assert_eq!(BodyConcatChoice::parse("bogus"), None);
    }

    #[test]
    fn resolve_without_pending_errors() {
        clear_pending();
        assert!(resolve_choice(BodyConcatChoice::Abort).is_err());
    }
}
