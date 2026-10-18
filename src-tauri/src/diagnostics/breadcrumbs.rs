//! Ring buffer of recent user-flow actions for diagnostic events.

use std::collections::VecDeque;
use std::sync::Mutex;

use chrono::Utc;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BREADCRUMB_CAP: usize = 15;

static BUFFER: Lazy<Mutex<VecDeque<Breadcrumb>>> =
    Lazy::new(|| Mutex::new(VecDeque::with_capacity(BREADCRUMB_CAP)));

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Breadcrumb {
    pub t: i64,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// Append a breadcrumb (`action` must be a stable constant from [`super::actions`]).
pub fn push_breadcrumb(action: &str, meta: Option<Value>) {
    let entry = Breadcrumb {
        t: Utc::now().timestamp(),
        action: action.to_string(),
        meta,
    };
    let mut guard = BUFFER.lock().expect("breadcrumb buffer poisoned");
    if guard.len() >= BREADCRUMB_CAP {
        guard.pop_front();
    }
    guard.push_back(entry);
}

/// Copy of the current trail (oldest → newest).
pub fn snapshot_breadcrumbs() -> Vec<Breadcrumb> {
    let guard = BUFFER.lock().expect("breadcrumb buffer poisoned");
    guard.iter().cloned().collect()
}

#[cfg(test)]
pub(crate) static BREADCRUMB_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[cfg(test)]
pub(crate) fn clear_breadcrumbs_for_test() {
    let mut guard = BUFFER.lock().expect("breadcrumb buffer poisoned");
    guard.clear();
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn cap_drops_oldest() {
        let _g = super::BREADCRUMB_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        clear_breadcrumbs_for_test();
        for i in 0..=BREADCRUMB_CAP {
            push_breadcrumb("test.action", Some(serde_json::json!({ "i": i })));
        }
        let snap = snapshot_breadcrumbs();
        assert_eq!(snap.len(), BREADCRUMB_CAP);
        assert_eq!(
            snap.first().and_then(|b| b.meta.as_ref()),
            Some(&serde_json::json!({ "i": 1 }))
        );
        assert_eq!(
            snap.last().and_then(|b| b.meta.as_ref()),
            Some(&serde_json::json!({ "i": BREADCRUMB_CAP }))
        );
        clear_breadcrumbs_for_test();
    }
}
