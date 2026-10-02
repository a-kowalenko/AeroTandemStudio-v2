//! Per-key event throttle (OPT-24 D1): progress ≤ N Hz per source, phase changes forced.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Throttle<K> {
    min_interval: Duration,
    last: Mutex<HashMap<K, Instant>>,
}

impl<K: Eq + Hash> Throttle<K> {
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last: Mutex::new(HashMap::new()),
        }
    }

    /// Max `hz` emits per key per second.
    pub fn per_second(hz: u32) -> Self {
        Self::new(Duration::from_millis(1000 / u64::from(hz.max(1))))
    }

    /// `true` when the event should be emitted now (records the emit time).
    pub fn should_emit(&self, key: K, force: bool) -> bool {
        self.should_emit_at(key, force, Instant::now())
    }

    fn should_emit_at(&self, key: K, force: bool, now: Instant) -> bool {
        let Ok(mut last) = self.last.lock() else {
            return true;
        };
        if !force {
            if let Some(prev) = last.get(&key) {
                if now.saturating_duration_since(*prev) < self.min_interval {
                    return false;
                }
            }
        }
        last.insert(key, now);
        true
    }

    /// Forget a key (e.g. after `done`) so the map does not grow unbounded.
    pub fn forget(&self, key: &K) {
        if let Ok(mut last) = self.last.lock() {
            last.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttles_within_interval_per_key() {
        let t = Throttle::new(Duration::from_millis(100));
        let t0 = Instant::now();
        assert!(t.should_emit_at("a", false, t0));
        assert!(!t.should_emit_at("a", false, t0 + Duration::from_millis(50)));
        assert!(t.should_emit_at("b", false, t0 + Duration::from_millis(50)));
        assert!(t.should_emit_at("a", false, t0 + Duration::from_millis(100)));
    }

    #[test]
    fn force_always_emits_and_resets_window() {
        let t = Throttle::new(Duration::from_millis(100));
        let t0 = Instant::now();
        assert!(t.should_emit_at(1u32, false, t0));
        assert!(t.should_emit_at(1u32, true, t0 + Duration::from_millis(10)));
        assert!(!t.should_emit_at(1u32, false, t0 + Duration::from_millis(60)));
        assert!(t.should_emit_at(1u32, false, t0 + Duration::from_millis(110)));
    }

    #[test]
    fn forget_allows_immediate_emit() {
        let t = Throttle::per_second(10);
        assert!(t.should_emit("x".to_string(), false));
        assert!(!t.should_emit("x".to_string(), false));
        t.forget(&"x".to_string());
        assert!(t.should_emit("x".to_string(), false));
    }
}
