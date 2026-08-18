//! `_fertig.txt` marker file (port of legacy processor marker write).

use serde_json::{json, Map, Value};

use crate::model::Kunde;
use crate::storage::config::AppConfig;

use super::export_paths::OutputLayout;

/// Build JSON payload for `_fertig.txt` matching legacy rules.
pub fn build_marker_json(
    kunde: &Kunde,
    outside_mode: bool,
    oldschool_mode: bool,
) -> Value {
    let marker_type = if outside_mode { "Outside" } else { "Handcam" };

    if oldschool_mode && kunde.form_mode != "kunde" {
        let mut map = Map::new();
        map.insert(
            "vorname".into(),
            json!(kunde.vorname.as_deref().unwrap_or("").trim()),
        );
        map.insert(
            "nachname".into(),
            json!(kunde.nachname.as_deref().unwrap_or("").trim()),
        );
        map.insert(
            "email".into(),
            json!(kunde.email.as_deref().unwrap_or("").trim()),
        );
        map.insert("type".into(), json!(marker_type));
        insert_media_flags(&mut map, kunde);
        let telefon = kunde.telefon.as_deref().unwrap_or("").trim();
        if !telefon.is_empty() {
            map.insert("telefon".into(), json!(telefon));
        }
        return Value::Object(map);
    }

    // QR / API mode: IDs + type + product flags (no PII). Flags are required for AMS Nachreichen.
    let mut map = Map::new();
    map.insert("type".into(), json!(marker_type));

    if kunde.form_mode == "kunde" {
        let kh = kunde
            .kunden_id_hash
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let bh = kunde
            .booking_id_hash
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        map.insert("kunden_id_hash".into(), json!(kh));
        map.insert("booking_id_hash".into(), json!(bh));
    } else {
        let kid = kunde
            .kunden_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let bid = kunde
            .booking_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        map.insert("kunden_id".into(), json!(kid));
        map.insert("booking_id".into(), json!(bid));
    }

    insert_media_flags(&mut map, kunde);
    Value::Object(map)
}

fn insert_media_flags(map: &mut Map<String, Value>, kunde: &Kunde) {
    map.insert("handcam_foto".into(), json!(kunde.handcam_foto));
    map.insert("handcam_video".into(), json!(kunde.handcam_video));
    map.insert("outside_foto".into(), json!(kunde.outside_foto));
    map.insert("outside_video".into(), json!(kunde.outside_video));
    map.insert(
        "ist_bezahlt_handcam_foto".into(),
        json!(kunde.ist_bezahlt_handcam_foto),
    );
    map.insert(
        "ist_bezahlt_handcam_video".into(),
        json!(kunde.ist_bezahlt_handcam_video),
    );
    map.insert(
        "ist_bezahlt_outside_foto".into(),
        json!(kunde.ist_bezahlt_outside_foto),
    );
    map.insert(
        "ist_bezahlt_outside_video".into(),
        json!(kunde.ist_bezahlt_outside_video),
    );
}

pub fn write_marker_file(
    layout: &OutputLayout,
    kunde: &Kunde,
    config: &AppConfig,
) -> Result<std::path::PathBuf, String> {
    let outside_mode = kunde.is_outside_video() || kunde.video_mode == "outside";
    let json = build_marker_json(kunde, outside_mode, config.oldschool_mode);
    let text = serde_json::to_string(&json).map_err(|e| e.to_string())?;
    crate::video::handoff_manifest::write_marker_file_atomic(layout, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oldschool_marker_includes_contact() {
        let mut k = Kunde::default();
        k.form_mode = "manual".into();
        k.vorname = Some("Max".into());
        k.nachname = Some("M".into());
        k.email = Some("a@b.c".into());
        k.handcam_video = true;
        let v = build_marker_json(&k, false, true);
        assert_eq!(v["type"], "Handcam");
        assert_eq!(v["vorname"], "Max");
        assert_eq!(v["email"], "a@b.c");
        assert_eq!(v["handcam_video"], true);
    }

    #[test]
    fn qr_marker_has_hashes_only() {
        let mut k = Kunde::default();
        k.form_mode = "kunde".into();
        k.kunden_id_hash = Some("abc".into());
        k.booking_id_hash = Some("def".into());
        k.vorname = Some("Secret".into());
        k.handcam_foto = true;
        let v = build_marker_json(&k, true, false);
        assert_eq!(v["type"], "Outside");
        assert_eq!(v["kunden_id_hash"], "abc");
        assert!(v.get("vorname").is_none());
        assert_eq!(v["handcam_foto"], true);
        assert_eq!(v["ist_bezahlt_handcam_foto"], false);
    }

    #[test]
    fn manual_marker_has_plain_ids() {
        let mut k = Kunde::default();
        k.form_mode = "manual".into();
        k.kunden_id = Some("K1".into());
        k.booking_id = Some("B1".into());
        k.outside_video = true;
        k.ist_bezahlt_outside_video = true;
        let v = build_marker_json(&k, false, false);
        assert_eq!(v["kunden_id"], "K1");
        assert_eq!(v["booking_id"], "B1");
        assert!(v.get("kunden_id_hash").is_none());
        assert_eq!(v["outside_video"], true);
        assert_eq!(v["ist_bezahlt_outside_video"], true);
    }
}
