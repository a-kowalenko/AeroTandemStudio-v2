//! Strip paths, secrets, and identifiers before diagnostics leave the client.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

const REDACTED: &str = "[REDACTED]";

static RE_BEARER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+\b").expect("bearer regex"));
static RE_JWT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b").expect("jwt regex")
});
static RE_UNC: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\\\\[A-Za-z0-9._$-]+\\[A-Za-z0-9._ $-]+(?:\\[^\\]+)*").expect("unc regex")
});
static RE_WIN_PATH: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"[A-Za-z]:\\(?:[^\\]+\\)*[^\\]*").expect("win path regex")
});
static RE_UNIX_PATH: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"/(?:Users|home|var|tmp|Volumes|mnt|opt|private)(?:/[^/\s]+)+").expect("unix path")
});
static RE_SMB_URL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bsmb://[^\s]+").expect("smb url regex"));
static RE_FILE_URL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bfile://[^\s]+").expect("file url regex"));
static RE_BOOKING_CUSTOMER: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(customer[_-]?id|booking[_-]?id|kunden?[_-]?id|buchungs?[_-]?id|marker[_-]?type)\s*[:=]\s*\S+",
    )
    .expect("booking/customer regex")
});
static RE_WS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").expect("whitespace regex"));

fn apply_redaction_patterns(input: &str) -> String {
    let mut s = input.to_string();
    for re in [
        &*RE_BEARER,
        &*RE_JWT,
        &*RE_UNC,
        &*RE_WIN_PATH,
        &*RE_UNIX_PATH,
        &*RE_SMB_URL,
        &*RE_FILE_URL,
        &*RE_BOOKING_CUSTOMER,
    ] {
        s = re.replace_all(&s, REDACTED).into_owned();
    }
    s
}

/// Redact sensitive substrings in a human-readable error / log line.
pub fn redact_message(message: &str) -> String {
    apply_redaction_patterns(message)
}

fn normalize_message_for_fingerprint(message: &str) -> String {
    let redacted = redact_message(message);
    RE_WS
        .replace_all(redacted.trim(), " ")
        .trim()
        .to_string()
}

/// Recursively redact string leaves in a JSON details object.
pub fn redact_details(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(redact_message(&s)),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_details).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, redact_details(v)))
                .collect(),
        ),
        other => other,
    }
}

pub(crate) fn normalize_message_for_fingerprint_pub(message: &str) -> String {
    normalize_message_for_fingerprint(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_and_jwt() {
        let msg = "Auth failed Bearer secret-token-xyz and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
        let out = redact_message(msg);
        assert!(!out.contains("secret-token"));
        assert!(!out.contains("eyJhbGci"));
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn redacts_paths_and_unc() {
        let msg = r"Failed \\NAS\share\job\file.mp4 at C:\Users\secret\Videos\out.mp4 and /Users/secret/out.mp4";
        let out = redact_message(msg);
        assert!(!out.contains(r"\\NAS"));
        assert!(!out.contains(r"C:\Users"));
        assert!(!out.contains("/Users/secret"));
    }

    #[test]
    fn redacts_booking_customer_kv() {
        let msg = "lookup customer_id=abc123 booking_id: 999 marker_type=hash";
        let out = redact_message(msg);
        assert!(!out.contains("abc123"));
        assert!(!out.contains("999"));
    }

    #[test]
    fn redact_details_walks_json() {
        let v = serde_json::json!({
            "path": "/Users/x/a.mp4",
            "nested": { "token": "Bearer abc" },
            "n": 1
        });
        let out = redact_details(v);
        assert_eq!(out["path"], REDACTED);
        assert_eq!(out["nested"]["token"], REDACTED);
        assert_eq!(out["n"], 1);
    }

    #[test]
    fn fingerprint_normalization_collapses_whitespace() {
        let a = normalize_message_for_fingerprint_pub("  foo   bar  ");
        let b = normalize_message_for_fingerprint_pub("foo bar");
        assert_eq!(a, b);
    }
}
