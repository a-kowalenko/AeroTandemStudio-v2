//! Background outbox flush (transport wired in R3).

use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::sync::Notify;
use tokio::time::{interval, MissedTickBehavior};

use crate::commands::config::ConfigState;
use crate::storage::logging;

use super::outbox::{
    DiagnosticsOutboxStore, OutboxRow, OUTBOX_FLUSH_BATCH, OUTBOX_STATUS_PENDING,
};

/// How often the worker wakes when idle.
pub const FLUSH_PERIOD: Duration = Duration::from_secs(90);

static FLUSH_NOTIFY: OnceLock<Notify> = OnceLock::new();
static SEND_HOOK: OnceLock<FlushSendHook> = OnceLock::new();

type FlushSendHook = fn(&[OutboxRow]) -> FlushSendOutcome;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushSendOutcome {
    /// R3: batch accepted by AMS/Cloud.
    Sent,
    /// No transport yet or transient failure — apply backoff.
    Deferred,
}

fn notify_handle() -> &'static Notify {
    FLUSH_NOTIFY.get_or_init(Notify::new)
}

/// Wake the background flusher (export end, manual tests).
pub fn request_diagnostics_flush() {
    notify_handle().notify_one();
}

fn default_send_hook(_rows: &[OutboxRow]) -> FlushSendOutcome {
    FlushSendOutcome::Deferred
}

fn invoke_send_hook(rows: &[OutboxRow]) -> FlushSendOutcome {
    if let Some(h) = SEND_HOOK.get() {
        h(rows)
    } else {
        default_send_hook(rows)
    }
}

/// R3 replaces the default no-op hook (unit tests may override too).
pub fn set_flush_send_hook(hook: FlushSendHook) {
    let _ = SEND_HOOK.set(hook);
}

pub fn spawn_diagnostics_outbox_flusher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(FLUSH_PERIOD);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = notify_handle().notified() => {}
            }
            let app_clone = app.clone();
            if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
                flush_outbox_once(&app_clone)
            })
            .await
            {
                logging::warn(
                    "diagnostics",
                    format!("Outbox-Flush (join) fehlgeschlagen: {e}"),
                );
            }
        }
    });
}

fn flush_outbox_once(app: &AppHandle) {
    let state = match app.try_state::<ConfigState>() {
        Some(s) => s,
        None => return,
    };
    let config = match state.cache.lock() {
        Ok(c) => c.clone(),
        Err(_) => return,
    };
    if !super::send_error_reports_enabled(&config) {
        return;
    }
    let store = match DiagnosticsOutboxStore::open_default() {
        Ok(s) => s,
        Err(e) => {
            logging::warn("diagnostics", format!("Outbox öffnen fehlgeschlagen: {e}"));
            return;
        }
    };
    let due = match store.list_due_pending(OUTBOX_FLUSH_BATCH) {
        Ok(rows) => rows,
        Err(e) => {
            logging::warn("diagnostics", format!("Outbox lesen fehlgeschlagen: {e}"));
            return;
        }
    };
    if due.is_empty() {
        return;
    }
    match invoke_send_hook(&due) {
        FlushSendOutcome::Sent => {
            let ids: Vec<String> = due.iter().map(|r| r.event_id.clone()).collect();
            if let Err(e) = store.mark_sent(&ids) {
                logging::warn("diagnostics", format!("Outbox mark_sent fehlgeschlagen: {e}"));
            }
        }
        FlushSendOutcome::Deferred => {
            for row in &due {
                if row.status != OUTBOX_STATUS_PENDING {
                    continue;
                }
                if let Err(e) = store.record_flush_failure(&row.event_id) {
                    logging::warn(
                        "diagnostics",
                        format!("Outbox Backoff für {} fehlgeschlagen: {e}", row.event_id),
                    );
                }
            }
        }
    }
}

