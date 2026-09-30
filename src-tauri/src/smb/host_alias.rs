//! OPT-23C: Host aliases so an OS map matches when config and map spell the
//! host differently (IP ↔ name ↔ short name ↔ FQDN).
//!
//! Stage 1 stays a plain string compare (no DNS). Stage 2 resolves only when
//! that misses. Lookup runs on a helper thread with a 1s budget so a Tokio
//! worker never sits inside `getaddrinfo`.

use std::collections::HashMap;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

/// Per-host resolve budget (OPT-23C C3).
pub const RESOLVE_TIMEOUT: Duration = Duration::from_secs(1);
/// Successful IP sets stay cached this long.
pub const POSITIVE_TTL: Duration = Duration::from_secs(5 * 60);
/// Failures (including timeout) stay cached this long.
pub const NEGATIVE_TTL: Duration = Duration::from_secs(60);

const LOOKUP_THREAD: &str = "smb-host-alias";

struct CacheEntry {
    ips: Option<Vec<IpAddr>>,
    at: Instant,
}

struct Inflight {
    done: Mutex<bool>,
    cv: Condvar,
}

struct Inner {
    entries: HashMap<String, CacheEntry>,
    inflight: HashMap<String, Arc<Inflight>>,
    lookup_count: u64,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            inflight: HashMap::new(),
            lookup_count: 0,
        }
    }
}

/// Resolver with an injectable lookup and clock so tests never hit the network.
pub struct HostResolver {
    lookup: Arc<dyn Fn(&str) -> Option<Vec<IpAddr>> + Send + Sync>,
    now: Arc<dyn Fn() -> Instant + Send + Sync>,
    timeout: Duration,
    inner: Mutex<Inner>,
}

impl HostResolver {
    pub fn new<F>(lookup: F) -> Self
    where
        F: Fn(&str) -> Option<Vec<IpAddr>> + Send + Sync + 'static,
    {
        Self::with_clock(lookup, Instant::now, RESOLVE_TIMEOUT)
    }

    pub fn with_clock<F, N>(lookup: F, now: N, timeout: Duration) -> Self
    where
        F: Fn(&str) -> Option<Vec<IpAddr>> + Send + Sync + 'static,
        N: Fn() -> Instant + Send + Sync + 'static,
    {
        Self {
            lookup: Arc::new(lookup),
            now: Arc::new(now),
            timeout,
            inner: Mutex::new(Inner::default()),
        }
    }

    /// How many times the lookup actually ran (cache hits do not count).
    #[cfg(test)]
    pub fn lookup_count(&self) -> u64 {
        lock(&self.inner).lookup_count
    }

    /// IP set for `host`, or `None` when resolution failed or timed out.
    pub fn resolve_ips(&self, host: &str) -> Option<Vec<IpAddr>> {
        off_runtime(|| self.resolve_ips_inner(host))
    }

    /// Same machine: string, then short-name ↔ FQDN, then IP-set intersection.
    ///
    /// String and short-name hits do not resolve. Literal IPs are parsed and
    /// only the name side is looked up.
    pub fn hosts_equivalent(&self, a: &str, b: &str) -> bool {
        let a = normalize_host(a);
        let b = normalize_host(b);
        if a.is_empty() || b.is_empty() {
            return false;
        }
        if a == b || short_name_fqdn_alias(&a, &b) {
            return true;
        }
        match (literal_ip(&a), literal_ip(&b)) {
            (Some(_), Some(_)) => false,
            (Some(ip), None) => self.resolve_ips(&b).is_some_and(|ips| ips.contains(&ip)),
            (None, Some(ip)) => self.resolve_ips(&a).is_some_and(|ips| ips.contains(&ip)),
            (None, None) => match (self.resolve_ips(&a), self.resolve_ips(&b)) {
                (Some(a_ips), Some(b_ips)) => a_ips.iter().any(|ip| b_ips.contains(ip)),
                _ => false,
            },
        }
    }

    /// Host-lock key: sorted IP set when resolution works, otherwise the
    /// normalized string (OPT-23C C5).
    pub fn canonical_key(&self, host: &str) -> String {
        let norm = normalize_host(host);
        if norm.is_empty() {
            return norm;
        }
        if let Some(ip) = literal_ip(&norm) {
            return ip.to_string();
        }
        match self.resolve_ips(&norm) {
            Some(ips) if !ips.is_empty() => format_ip_key(&ips),
            _ => norm,
        }
    }

    fn resolve_ips_inner(&self, host: &str) -> Option<Vec<IpAddr>> {
        let key = normalize_host(host);
        if key.is_empty() {
            return None;
        }
        // A literal never needs `getaddrinfo`.
        if let Some(ip) = literal_ip(&key) {
            return Some(vec![ip]);
        }

        loop {
            let waiter = {
                let mut guard = lock(&self.inner);
                let now = (self.now)();
                if let Some(entry) = guard.entries.get(&key) {
                    let ttl = if entry.ips.is_some() {
                        POSITIVE_TTL
                    } else {
                        NEGATIVE_TTL
                    };
                    if now.saturating_duration_since(entry.at) < ttl {
                        return entry.ips.clone();
                    }
                    guard.entries.remove(&key);
                }
                if let Some(existing) = guard.inflight.get(&key).cloned() {
                    existing
                } else {
                    let created = Arc::new(Inflight {
                        done: Mutex::new(false),
                        cv: Condvar::new(),
                    });
                    guard.inflight.insert(key.clone(), Arc::clone(&created));
                    drop(guard);

                    let ips = self.perform_lookup(&key);
                    let mut guard = lock(&self.inner);
                    guard.entries.insert(
                        key.clone(),
                        CacheEntry {
                            ips: ips.clone(),
                            at: (self.now)(),
                        },
                    );
                    guard.inflight.remove(&key);
                    drop(guard);

                    let mut done = lock(&created.done);
                    *done = true;
                    created.cv.notify_all();
                    return ips;
                }
            };

            let mut done = lock(&waiter.done);
            while !*done {
                done = waiter.cv.wait(done).unwrap_or_else(|e| e.into_inner());
            }
        }
    }

    fn perform_lookup(&self, key: &str) -> Option<Vec<IpAddr>> {
        {
            let mut guard = lock(&self.inner);
            guard.lookup_count = guard.lookup_count.saturating_add(1);
        }
        crate::storage::logging::debug("smb", format!("SMB host alias resolve {key}"));

        let lookup = Arc::clone(&self.lookup);
        let host = key.to_string();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let spawned = std::thread::Builder::new()
            .name(LOOKUP_THREAD.into())
            .spawn(move || {
                let result = normalize_ips(lookup(&host));
                let _ = tx.send(result);
            });
        if spawned.is_err() {
            return None;
        }
        match rx.recv_timeout(self.timeout) {
            Ok(ips) => ips,
            Err(_) => None,
        }
    }
}

/// Process-wide resolver used by mapping match and the host lock.
///
/// Unit tests install a no-network lookup so host-lock tests stay fast and
/// deterministic. Production resolves via [`system_lookup`].
pub fn global() -> &'static HostResolver {
    &GLOBAL
}

static GLOBAL: Lazy<HostResolver> = Lazy::new(|| HostResolver::new(process_lookup));

fn process_lookup(host: &str) -> Option<Vec<IpAddr>> {
    #[cfg(test)]
    {
        let _ = host;
        None
    }
    #[cfg(not(test))]
    {
        system_lookup(host)
    }
}

/// `host:445` via `ToSocketAddrs`. `None` on failure or an empty answer.
/// IPv6 literals are bracketed so the port is unambiguous.
pub fn system_lookup(host: &str) -> Option<Vec<IpAddr>> {
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let query = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]:445")
    } else {
        format!("{host}:445")
    };
    let ips: Vec<IpAddr> = query
        .to_socket_addrs()
        .ok()?
        .map(|addr| addr.ip())
        .collect();
    normalize_ips(Some(ips))
}

/// Canonical host spelling shared with the pre-OPT-23C lock key: no slashes,
/// no brackets, no `:port` (single colon only — IPv6 stays intact), lowercased.
pub fn normalize_host(host: &str) -> String {
    let trimmed = host.trim().trim_matches(|c| c == '\\' || c == '/').trim();
    let unbracketed = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed);
    let without_port = if unbracketed.matches(':').count() == 1 {
        unbracketed
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or(unbracketed)
    } else {
        unbracketed
    };
    without_port.to_ascii_lowercase()
}

/// Cheap alias before DNS: `nas` ↔ `nas.local` (one label vs FQDN with that
/// first label). IP literals are not names. `nas.local` ↔ `nas.example` is
/// left to DNS — neither is a short name of the other.
pub fn short_name_fqdn_alias(a: &str, b: &str) -> bool {
    let a = normalize_host(a);
    let b = normalize_host(b);
    if a.is_empty() || b.is_empty() || literal_ip(&a).is_some() || literal_ip(&b).is_some() {
        return false;
    }
    let la = dns_labels(&a);
    let lb = dns_labels(&b);
    if la.is_empty() || lb.is_empty() || la[0] != lb[0] {
        return false;
    }
    if la == lb {
        // Same labels, strings differed only by extra dots (`nas.local.`).
        return a != b;
    }
    let (shorter, longer) = if la.len() < lb.len() {
        (&la, &lb)
    } else {
        (&lb, &la)
    };
    shorter.len() == 1
        && shorter[0].chars().any(|c| c.is_ascii_alphabetic())
        && longer.starts_with(shorter.as_slice())
}

fn dns_labels(host: &str) -> Vec<&str> {
    host.split('.').filter(|label| !label.is_empty()).collect()
}

fn literal_ip(host: &str) -> Option<IpAddr> {
    host.parse().ok()
}

fn normalize_ips(ips: Option<Vec<IpAddr>>) -> Option<Vec<IpAddr>> {
    let mut ips = ips?;
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        None
    } else {
        Some(ips)
    }
}

fn format_ip_key(ips: &[IpAddr]) -> String {
    ips.iter()
        .map(IpAddr::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}

/// DNS / `getaddrinfo` must not run on a Tokio worker (OPT-23C C3).
/// Multi-thread runtimes park the worker via `block_in_place`. Current-thread
/// tests and `spawn_blocking` callers just wait — they are already off the
/// worker, and `block_in_place` panics on a current-thread runtime.
fn off_runtime<R: Send>(f: impl FnOnce() -> R + Send) -> R {
    let on_multi_thread = tokio::runtime::Handle::try_current()
        .is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread);
    if on_multi_thread {
        tokio::task::block_in_place(f)
    } else {
        f()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    fn ip(octets: [u8; 4]) -> IpAddr {
        IpAddr::V4(Ipv4Addr::from(octets))
    }

    #[test]
    fn alias_budget_matches_spec() {
        assert_eq!(RESOLVE_TIMEOUT, Duration::from_secs(1));
        assert_eq!(POSITIVE_TTL, Duration::from_secs(5 * 60));
        assert_eq!(NEGATIVE_TTL, Duration::from_secs(60));
    }

    #[test]
    fn short_name_matches_fqdn_without_being_a_different_domain() {
        assert!(short_name_fqdn_alias("nas", "nas.local"));
        assert!(short_name_fqdn_alias("NAS.LOCAL", "nas"));
        assert!(short_name_fqdn_alias("nas", "nas.local.lan"));
        assert!(!short_name_fqdn_alias("nas.local", "nas.example"));
        assert!(!short_name_fqdn_alias("nas", "other.local"));
        assert!(!short_name_fqdn_alias("nas", "nas"));
        assert!(!short_name_fqdn_alias("10.0.0.1", "10.0.0.1"));
        assert!(!short_name_fqdn_alias("10", "10.0.0.1"));
        assert!(!short_name_fqdn_alias("192.168.1.10", "nas.local"));
    }

    #[test]
    fn ip_and_name_match_via_fake_resolver() {
        let resolver = HostResolver::new(|host| match host {
            "nas" => Some(vec![ip([192, 168, 1, 10]), ip([10, 0, 0, 5])]),
            "other" => Some(vec![ip([192, 168, 1, 10])]),
            "lonely" => Some(vec![ip([10, 1, 1, 1])]),
            _ => None,
        });

        assert!(resolver.hosts_equivalent("192.168.1.10", "NAS"));
        assert!(resolver.hosts_equivalent("nas", "other"));
        assert!(!resolver.hosts_equivalent("nas", "lonely"));
        assert!(!resolver.hosts_equivalent("10.9.9.9", "nas"));
        // C5: key is the full sorted set, so a single A record does not share
        // the lock key with a name that also has a second address.
        assert_eq!(resolver.canonical_key("nas"), "10.0.0.5,192.168.1.10");
        assert_eq!(resolver.canonical_key("NAS"), resolver.canonical_key("nas"));
        assert_eq!(resolver.canonical_key("other"), "192.168.1.10");
        assert_eq!(
            resolver.canonical_key("192.168.1.10"),
            resolver.canonical_key("other")
        );
        assert_ne!(
            resolver.canonical_key("nas"),
            resolver.canonical_key("other")
        );
        // The literal is parsed; only names are looked up.
        assert_eq!(resolver.lookup_count(), 3);
    }

    #[test]
    fn short_name_equivalence_does_not_resolve() {
        let resolver = HostResolver::new(|_| Some(vec![ip([1, 2, 3, 4])]));
        assert!(resolver.hosts_equivalent("nas", "nas.local"));
        assert_eq!(resolver.lookup_count(), 0);
        assert_eq!(resolver.canonical_key("nas"), "1.2.3.4");
        assert_eq!(resolver.lookup_count(), 1);
    }

    #[test]
    fn canonical_key_falls_back_to_normalized_string() {
        let resolver = HostResolver::new(|_| None);
        assert_eq!(resolver.canonical_key(r"\\AMS-PC\"), "ams-pc");
        assert_eq!(resolver.canonical_key("NoSuchHost:445"), "nosuchhost");
        assert_eq!(resolver.canonical_key("[::1]"), "::1");
        assert!(!resolver.hosts_equivalent("nas", "other"));
    }

    #[test]
    fn negative_cache_suppresses_repeat_lookups_until_ttl() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_lookup = Arc::clone(&calls);
        let now = Arc::new(Mutex::new(Instant::now()));
        let now_fn = {
            let now = Arc::clone(&now);
            move || *lock(&now)
        };
        let resolver = HostResolver::with_clock(
            move |host| {
                assert_eq!(host, "nas");
                calls_lookup.fetch_add(1, Ordering::SeqCst);
                None
            },
            now_fn,
            RESOLVE_TIMEOUT,
        );

        assert!(resolver.resolve_ips("NAS").is_none());
        *lock(&now) += Duration::from_secs(30);
        assert!(resolver.resolve_ips("nas").is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        *lock(&now) += Duration::from_secs(31);
        assert!(resolver.resolve_ips("nas").is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(resolver.lookup_count(), 2);
    }

    #[test]
    fn positive_cache_lasts_five_minutes() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_lookup = Arc::clone(&calls);
        let now = Arc::new(Mutex::new(Instant::now()));
        let now_fn = {
            let now = Arc::clone(&now);
            move || *lock(&now)
        };
        let resolver = HostResolver::with_clock(
            move |_| {
                calls_lookup.fetch_add(1, Ordering::SeqCst);
                Some(vec![ip([192, 168, 1, 10])])
            },
            now_fn,
            RESOLVE_TIMEOUT,
        );

        assert_eq!(
            resolver.resolve_ips("nas").unwrap(),
            vec![ip([192, 168, 1, 10])]
        );
        *lock(&now) += Duration::from_secs(5 * 60 - 1);
        assert!(resolver.resolve_ips("nas").is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        *lock(&now) += Duration::from_secs(2);
        assert!(resolver.resolve_ips("nas").is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn lookup_runs_on_alias_thread() {
        let caller = thread::current().id();
        let seen = Arc::new(Mutex::new(None));
        let seen_lookup = Arc::clone(&seen);
        let resolver = HostResolver::new(move |_| {
            *lock(&seen_lookup) = Some((
                thread::current().id(),
                thread::current().name().map(str::to_string),
            ));
            None
        });
        assert!(resolver.resolve_ips("nas").is_none());
        let (id, name) = seen.lock().unwrap().clone().expect("lookup did not run");
        assert_ne!(id, caller);
        assert_eq!(name.as_deref(), Some(LOOKUP_THREAD));
    }

    #[test]
    fn lookup_timeout_is_cached_as_negative() {
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let release_thread = Arc::clone(&release);
        let resolver = HostResolver::with_clock(
            move |_| {
                let (lock, cv) = &*release_thread;
                let mut go = lock.lock().unwrap();
                while !*go {
                    go = cv.wait(go).unwrap();
                }
                Some(vec![ip([1, 1, 1, 1])])
            },
            Instant::now,
            Duration::from_millis(40),
        );

        let started = Instant::now();
        assert!(resolver.resolve_ips("nas").is_none());
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(1),
            "timeout budget exceeded: {elapsed:?}"
        );
        // Timed-out failure is a negative hit — the slow lookup must not run again.
        assert!(resolver.resolve_ips("nas").is_none());
        assert_eq!(resolver.lookup_count(), 1);

        let (lock, cv) = &*release;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }

    #[test]
    fn system_lookup_literal_needs_no_dns() {
        assert_eq!(
            system_lookup("127.0.0.1").unwrap(),
            vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]
        );
        assert_eq!(
            system_lookup("::1").unwrap(),
            vec![IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)]
        );
        assert!(system_lookup("").is_none());
    }
}
