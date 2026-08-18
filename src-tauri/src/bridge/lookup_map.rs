//! Map AMS Bridge lookup (`mode=id`) onto ATS `Kunde` without hashes.
//! Spec: Phase 25 — identity stays `kunden_id`/`booking_id`; `form_mode` stays `manual`.
//! Mirrored in `src/lib/amsLookup.ts` for the form; this module is the cargo-tested contract.

#![allow(dead_code)]

use crate::model::Kunde;

use super::BridgeCustomer;

fn nonempty(value: Option<&String>) -> Option<String> {
    value
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn has_media_flags(customer: &BridgeCustomer) -> bool {
    customer.handcam_foto
        || customer.handcam_video
        || customer.outside_foto
        || customer.outside_video
}

fn type_to_video_mode(customer_type: Option<&String>) -> Option<&'static str> {
    match customer_type
        .map(|s| s.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("handcam") | Some("handycam") => Some("handcam"),
        Some("outside") => Some("outside"),
        _ => None,
    }
}

/// `video_mode` from flags first, then AMS `type`.
pub fn video_mode_from_customer(customer: &BridgeCustomer) -> String {
    let handcam = customer.handcam_foto || customer.handcam_video;
    let outside = customer.outside_foto || customer.outside_video;
    if handcam && !outside {
        return "handcam".into();
    }
    if outside && !handcam {
        return "outside".into();
    }
    if let Some(mode) = type_to_video_mode(customer.customer_type.as_ref()) {
        return mode.into();
    }
    if handcam {
        "handcam".into()
    } else {
        String::new()
    }
}

/// Types to send in `LookupRequest.type`. ID-mode always queries both.
pub fn lookup_marker_types(_video_mode: &str) -> Vec<&'static str> {
    vec!["Handcam", "Outside"]
}

pub const MIN_LOOKUP_ID_DIGITS: usize = 4;

pub fn is_lookup_id_ready(id: &str) -> bool {
    let t = id.trim();
    t.len() >= MIN_LOOKUP_ID_DIGITS && t.chars().all(|c| c.is_ascii_digit())
}

/// Frontend gate: URL configured is not enough — AMS must be up (and advertise lookup).
pub fn can_run_ams_id_lookup(configured: bool, connected: bool, capabilities: &[&str]) -> bool {
    if !configured || !connected {
        return false;
    }
    if capabilities.is_empty() {
        return true;
    }
    capabilities.iter().any(|c| *c == "lookup")
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClassifiedLookupHits {
    None,
    One {
        customer: BridgeCustomer,
        video_mode: &'static str,
    },
    Choice {
        handcam: BridgeCustomer,
        outside: BridgeCustomer,
    },
}

/// Two typed AMS responses: never merge families.
pub fn classify_typed_hits(
    handcam: Option<&BridgeCustomer>,
    outside: Option<&BridgeCustomer>,
) -> ClassifiedLookupHits {
    let h = handcam.filter(|c| has_media_flags(c));
    let o = outside.filter(|c| has_media_flags(c));
    match (h, o) {
        (Some(a), Some(b)) => ClassifiedLookupHits::Choice {
            handcam: a.clone(),
            outside: b.clone(),
        },
        (Some(a), None) => ClassifiedLookupHits::One {
            customer: a.clone(),
            video_mode: "handcam",
        },
        (None, Some(b)) => ClassifiedLookupHits::One {
            customer: b.clone(),
            video_mode: "outside",
        },
        (None, None) => ClassifiedLookupHits::None,
    }
}

/// Fill name + media from AMS. Keeps typed IDs, `form_mode=manual`, ignores email/phone/hashes.
pub fn apply_bridge_customer_to_kunde(kunde: &Kunde, hit: &BridgeCustomer) -> Kunde {
    let vorname = nonempty(hit.first_name.as_ref());
    let nachname = nonempty(hit.last_name.as_ref());
    let gast = match (&vorname, &nachname) {
        (Some(v), Some(n)) => format!("{v} {n}"),
        (Some(v), None) => v.clone(),
        (None, Some(n)) => n.clone(),
        (None, None) => kunde.gast.clone(),
    };

    Kunde {
        kunden_id: kunde.kunden_id.clone(),
        booking_id: kunde.booking_id.clone(),
        kunden_id_hash: None,
        booking_id_hash: None,
        vorname,
        nachname,
        email: kunde.email.clone(),
        telefon: kunde.telefon.clone(),
        gast,
        tandemmaster: kunde.tandemmaster.clone(),
        videospringer: kunde.videospringer.clone(),
        datum: kunde.datum.clone(),
        ort: kunde.ort.clone(),
        video_mode: video_mode_from_customer(hit),
        form_mode: "manual".into(),
        handcam_foto: hit.handcam_foto,
        handcam_video: hit.handcam_video,
        outside_foto: hit.outside_foto,
        outside_video: hit.outside_video,
        ist_bezahlt_handcam_foto: hit.ist_bezahlt_handcam_foto,
        ist_bezahlt_handcam_video: hit.ist_bezahlt_handcam_video,
        ist_bezahlt_outside_foto: hit.ist_bezahlt_outside_foto,
        ist_bezahlt_outside_video: hit.ist_bezahlt_outside_video,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::config::AppConfig;
    use crate::video::handoff_manifest::marker_hint_for;
    use crate::video::marker::build_marker_json;

    fn hit_outside() -> BridgeCustomer {
        BridgeCustomer {
            first_name: Some("Max".into()),
            last_name: Some("Mustermann".into()),
            email: Some("ams@example.test".into()),
            phone: Some("0123".into()),
            customer_number: Some("999".into()),
            booking_number: Some("888".into()),
            customer_type: Some("Outside".into()),
            outside_video: true,
            ist_bezahlt_outside_video: true,
            ..BridgeCustomer::default()
        }
    }

    #[test]
    fn lookup_types_id_mode_is_always_dual() {
        assert_eq!(lookup_marker_types(""), vec!["Handcam", "Outside"]);
        assert_eq!(lookup_marker_types("handcam"), vec!["Handcam", "Outside"]);
        assert_eq!(lookup_marker_types("outside"), vec!["Handcam", "Outside"]);
    }

    #[test]
    fn lookup_id_ready_requires_four_digits() {
        assert!(!is_lookup_id_ready(""));
        assert!(!is_lookup_id_ready("123"));
        assert!(is_lookup_id_ready("1234"));
        assert!(is_lookup_id_ready("012345"));
        assert!(!is_lookup_id_ready("12ab"));
    }

    #[test]
    fn id_lookup_stays_silent_when_ams_is_down() {
        assert!(!can_run_ams_id_lookup(true, false, &["lookup"]));
        assert!(!can_run_ams_id_lookup(false, true, &["lookup"]));
        assert!(can_run_ams_id_lookup(true, true, &[]));
        assert!(can_run_ams_id_lookup(true, true, &["lookup", "ready"]));
        assert!(!can_run_ams_id_lookup(true, true, &["ready", "append-v1"]));
    }

    #[test]
    fn classify_two_family_hits_is_choice_not_merge() {
        let handcam = BridgeCustomer {
            first_name: Some("Ada".into()),
            handcam_video: true,
            ist_bezahlt_handcam_video: true,
            ..BridgeCustomer::default()
        };
        let outside = BridgeCustomer {
            last_name: Some("Lovelace".into()),
            outside_foto: true,
            ..BridgeCustomer::default()
        };
        let nameless = BridgeCustomer {
            first_name: Some("Ignorieren".into()),
            ..BridgeCustomer::default()
        };
        match classify_typed_hits(Some(&handcam), Some(&outside)) {
            ClassifiedLookupHits::Choice { handcam: h, outside: o } => {
                assert!(h.handcam_video && !h.outside_foto);
                assert!(o.outside_foto && !o.handcam_video);
                assert_eq!(h.first_name.as_deref(), Some("Ada"));
                assert_eq!(o.last_name.as_deref(), Some("Lovelace"));
            }
            other => panic!("expected choice, got {other:?}"),
        }
        assert!(matches!(
            classify_typed_hits(Some(&nameless), None),
            ClassifiedLookupHits::None
        ));
        match classify_typed_hits(Some(&handcam), Some(&nameless)) {
            ClassifiedLookupHits::One { video_mode, .. } => {
                assert_eq!(video_mode, "handcam");
            }
            other => panic!("expected one handcam, got {other:?}"),
        }
    }

    #[test]
    fn apply_keeps_plain_ids_no_hashes_and_manual_mode() {
        let mut k = Kunde::default();
        k.form_mode = "manual".into();
        k.kunden_id = Some("42".into());
        k.booking_id = Some("99".into());
        k.kunden_id_hash = Some("should-drop".into());
        k.email = Some("keep@example.test".into());
        k.tandemmaster = "TM".into();

        let next = apply_bridge_customer_to_kunde(&k, &hit_outside());
        assert_eq!(next.form_mode, "manual");
        assert_eq!(next.kunden_id.as_deref(), Some("42"));
        assert_eq!(next.booking_id.as_deref(), Some("99"));
        assert!(next.kunden_id_hash.is_none());
        assert!(next.booking_id_hash.is_none());
        assert_eq!(next.vorname.as_deref(), Some("Max"));
        assert_eq!(next.nachname.as_deref(), Some("Mustermann"));
        assert_eq!(next.gast, "Max Mustermann");
        assert_eq!(next.email.as_deref(), Some("keep@example.test"));
        assert_eq!(next.telefon, None);
        assert_eq!(next.tandemmaster, "TM");
        assert!(next.outside_video);
        assert!(next.ist_bezahlt_outside_video);
        assert!(!next.handcam_video);
        assert_eq!(next.video_mode, "outside");

        let req = super::super::lookup_request_from_kunde(&next).unwrap();
        assert_eq!(req.mode, "id");
        assert_eq!(req.customer_id, "42");
        assert_eq!(req.booking_id, "99");
    }

    #[test]
    fn apply_does_not_overlay_ams_customer_numbers() {
        let mut k = Kunde::default();
        k.kunden_id = Some("1".into());
        k.booking_id = Some("2".into());
        let next = apply_bridge_customer_to_kunde(&k, &hit_outside());
        assert_eq!(next.kunden_id.as_deref(), Some("1"));
        assert_eq!(next.booking_id.as_deref(), Some("2"));
    }

    #[test]
    fn marker_stays_api_id_after_lookup_fill() {
        let mut k = Kunde::default();
        k.form_mode = "manual".into();
        k.kunden_id = Some("42".into());
        k.booking_id = Some("99".into());
        let filled = apply_bridge_customer_to_kunde(&k, &hit_outside());
        let hint = marker_hint_for(&filled, &AppConfig::default());
        assert_eq!(hint.format, "api_id");

        let marker = build_marker_json(&filled, true, false);
        assert_eq!(marker["kunden_id"], "42");
        assert_eq!(marker["booking_id"], "99");
        assert!(marker.get("kunden_id_hash").is_none());
        assert!(marker.get("booking_id_hash").is_none());
        assert!(marker.get("vorname").is_none());
    }

    #[test]
    fn bridge_customer_deserializes_paid_flags() {
        let v = serde_json::json!({
            "first_name": "Max",
            "type": "Handcam",
            "handcam_video": true,
            "ist_bezahlt_handcam_video": true
        });
        let c: BridgeCustomer = serde_json::from_value(v).unwrap();
        assert!(c.handcam_video);
        assert!(c.ist_bezahlt_handcam_video);
        assert!(!c.ist_bezahlt_handcam_foto);
        assert_eq!(c.customer_type.as_deref(), Some("Handcam"));
    }
}
