//! Form validation (port of legacy `validation.py`).

use serde::{Deserialize, Serialize};

use super::Kunde;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
}

/// Validate customer/session form data before video creation / preview.
///
/// `oldschool_mode` requires email in manual mode (legacy behaviour).
/// `video_paths` are checked for `.mp4` existence when non-empty.
pub fn validate_kunde(
    kunde: &Kunde,
    video_paths: &[String],
    oldschool_mode: bool,
) -> ValidationResult {
    let mut errors = Vec::new();

    if kunde.tandemmaster.trim().is_empty() {
        errors.push("Tandemmaster ist erforderlich".into());
    }
    if kunde.datum.trim().is_empty() {
        errors.push("Datum ist erforderlich".into());
    }

    let vorname = kunde.vorname.as_deref().unwrap_or("").trim();
    let nachname = kunde.nachname.as_deref().unwrap_or("").trim();
    if vorname.is_empty() || nachname.is_empty() {
        errors.push("Vorname und Nachname sind erforderlich".into());
    }

    if kunde.form_mode == "manual" {
        const MIN_DIGITS: usize = 4;
        for (label, raw) in [
            ("Kunden-ID", kunde.kunden_id.as_deref()),
            ("Booking-ID", kunde.booking_id.as_deref()),
        ] {
            let id = raw.unwrap_or("").trim();
            if !id.is_empty() && id.chars().count() < MIN_DIGITS {
                errors.push(format!(
                    "{label} muss mindestens {MIN_DIGITS} Ziffern haben"
                ));
            }
        }
    }

    if oldschool_mode && kunde.form_mode == "manual" {
        let email = kunde.email.as_deref().unwrap_or("").trim();
        if email.is_empty() {
            errors.push("Email ist erforderlich".into());
        }
    }

    if kunde.is_outside_video() && kunde.videospringer.trim().is_empty() {
        errors.push("Videospringer ist erforderlich bei Outside Video".into());
    }

    let tm = kunde.tandemmaster.trim();
    let vs = kunde.videospringer.trim();
    if kunde.is_outside_video() && !tm.is_empty() && !vs.is_empty() {
        if tm.to_lowercase() == vs.to_lowercase() {
            errors.push(
                "Dieselbe Person kann nicht Tandemmaster und Videospringer zugleich sein"
                    .into(),
            );
        }
    }

    for path in video_paths {
        let lower = path.to_lowercase();
        if !lower.ends_with(".mp4") {
            errors.push(format!("'{path}' ist keine .mp4 Datei"));
        } else if !std::path::Path::new(path).exists() {
            errors.push(format!("Datei '{path}' existiert nicht"));
        }
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_kunde() -> Kunde {
        let mut k = Kunde::default();
        k.tandemmaster = "Anna".into();
        k.datum = "06.08.2026".into();
        k.gast = "Max Mustermann".into();
        k.vorname = Some("Max".into());
        k.nachname = Some("Mustermann".into());
        k
    }

    #[test]
    fn valid_minimal_kunde() {
        let r = validate_kunde(&base_kunde(), &[], false);
        assert!(r.valid);
        assert!(r.errors.is_empty());
    }

    #[test]
    fn requires_tandemmaster_and_datum() {
        let k = Kunde::default();
        let r = validate_kunde(&k, &[], false);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|e| e.contains("Tandemmaster")));
        assert!(r.errors.iter().any(|e| e.contains("Datum")));
    }

    #[test]
    fn requires_vorname_and_nachname() {
        let mut k = base_kunde();
        k.vorname = None;
        k.nachname = Some("Mustermann".into());
        let r = validate_kunde(&k, &[], false);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|e| e.contains("Vorname")));
    }

    #[test]
    fn outside_requires_videospringer() {
        let mut k = base_kunde();
        k.outside_video = true;
        let r = validate_kunde(&k, &[], false);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|e| e.contains("Videospringer")));
    }

    #[test]
    fn outside_rejects_same_person_for_both_roles() {
        let mut k = base_kunde();
        k.outside_video = true;
        k.videospringer = "anna".into();
        let r = validate_kunde(&k, &[], false);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|e| e.contains("zugleich")));
    }

    #[test]
    fn outside_allows_different_crew() {
        let mut k = base_kunde();
        k.outside_video = true;
        k.videospringer = "Ben".into();
        let r = validate_kunde(&k, &[], false);
        assert!(r.valid);
    }

    #[test]
    fn oldschool_requires_email() {
        let mut k = base_kunde();
        k.form_mode = "manual".into();
        let r = validate_kunde(&k, &[], true);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|e| e.contains("Email")));
    }

    #[test]
    fn manual_ids_must_be_at_least_four_digits() {
        let mut k = base_kunde();
        k.form_mode = "manual".into();
        k.kunden_id = Some("123".into());
        k.booking_id = Some("99".into());
        let r = validate_kunde(&k, &[], false);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|e| e.contains("Kunden-ID")));
        assert!(r.errors.iter().any(|e| e.contains("Booking-ID")));
    }

    #[test]
    fn manual_ids_of_four_digits_ok() {
        let mut k = base_kunde();
        k.form_mode = "manual".into();
        k.kunden_id = Some("1234".into());
        k.booking_id = Some("5678".into());
        let r = validate_kunde(&k, &[], false);
        assert!(r.valid);
    }

    #[test]
    fn rejects_non_mp4() {
        let r = validate_kunde(&base_kunde(), &["clip.mov".into()], false);
        assert!(!r.valid);
        assert!(r.errors.iter().any(|e| e.contains(".mp4")));
    }
}
