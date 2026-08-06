//! Customer / session form model (port of legacy `kunde.py` + form session fields).

use serde::{Deserialize, Serialize};

/// Full customer + intro session data used by the form and `create_video`.
///
/// Domain fields match legacy `Kunde`; session fields (`gast`, `tandemmaster`,
/// `datum`, `ort`, …) come from the form and replace the Phase-3 `IntroKunde`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Kunde {
    #[serde(default)]
    pub kunden_id: Option<String>,
    #[serde(default)]
    pub kunden_id_hash: Option<String>,
    #[serde(default)]
    pub booking_id: Option<String>,
    #[serde(default)]
    pub booking_id_hash: Option<String>,
    #[serde(default)]
    pub vorname: Option<String>,
    #[serde(default)]
    pub nachname: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub telefon: Option<String>,

    /// Display name for the intro overlay (legacy form `gast`).
    #[serde(default)]
    pub gast: String,
    #[serde(default)]
    pub tandemmaster: String,
    #[serde(default)]
    pub videospringer: String,
    #[serde(default)]
    pub datum: String,
    #[serde(default)]
    pub ort: String,
    /// `handcam` | `outside` | empty
    #[serde(default)]
    pub video_mode: String,
    /// `manual` | `kunde`
    #[serde(default = "default_form_mode")]
    pub form_mode: String,

    #[serde(default)]
    pub handcam_foto: bool,
    #[serde(default)]
    pub handcam_video: bool,
    #[serde(default)]
    pub outside_foto: bool,
    #[serde(default)]
    pub outside_video: bool,
    #[serde(default)]
    pub ist_bezahlt_handcam_foto: bool,
    #[serde(default)]
    pub ist_bezahlt_handcam_video: bool,
    #[serde(default)]
    pub ist_bezahlt_outside_foto: bool,
    #[serde(default)]
    pub ist_bezahlt_outside_video: bool,
}

fn default_form_mode() -> String {
    "manual".into()
}

impl Default for Kunde {
    fn default() -> Self {
        Self {
            kunden_id: None,
            kunden_id_hash: None,
            booking_id: None,
            booking_id_hash: None,
            vorname: None,
            nachname: None,
            email: None,
            telefon: None,
            gast: String::new(),
            tandemmaster: String::new(),
            videospringer: String::new(),
            datum: String::new(),
            ort: "Calden".into(),
            video_mode: String::new(),
            form_mode: default_form_mode(),
            handcam_foto: false,
            handcam_video: false,
            outside_foto: false,
            outside_video: false,
            ist_bezahlt_handcam_foto: false,
            ist_bezahlt_handcam_video: false,
            ist_bezahlt_outside_foto: false,
            ist_bezahlt_outside_video: false,
        }
    }
}

impl Kunde {
    /// Resolve the guest display name for the intro (legacy form logic).
    pub fn resolve_gast(&self) -> String {
        let gast = self.gast.trim();
        if !gast.is_empty() {
            return gast.to_string();
        }
        let from_name = format!(
            "{} {}",
            self.vorname.as_deref().unwrap_or("").trim(),
            self.nachname.as_deref().unwrap_or("").trim()
        )
        .trim()
        .to_string();
        if !from_name.is_empty() {
            return from_name;
        }
        if let Some(id) = self.kunden_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            return id.to_string();
        }
        "Unbekannt".into()
    }

    /// Effective outside-video flag (product checkbox or video_mode).
    pub fn is_outside_video(&self) -> bool {
        self.outside_video || self.video_mode == "outside"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_gast_prefers_explicit_gast() {
        let mut k = Kunde::default();
        k.gast = "Max".into();
        k.vorname = Some("Other".into());
        assert_eq!(k.resolve_gast(), "Max");
    }

    #[test]
    fn resolve_gast_falls_back_to_name() {
        let mut k = Kunde::default();
        k.vorname = Some("Anna".into());
        k.nachname = Some("Schmidt".into());
        assert_eq!(k.resolve_gast(), "Anna Schmidt");
    }

    #[test]
    fn serde_roundtrip_defaults() {
        let k = Kunde::default();
        let json = serde_json::to_string(&k).unwrap();
        let back: Kunde = serde_json::from_str(&json).unwrap();
        assert_eq!(k, back);
    }
}
