# Phase 52 — Foto EXIF-Orientation (Preview, Wasserzeichen, QR)

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ✅ Umgesetzt (Helper, Thumbnails + Cache-Rev `o1`, Wasserzeichen, QR; Unit-Tests). Manuelle Abnahme im Release-Build offen.  
**Abhängigkeiten:** `media/rotate.rs` (`read_exif_orientation`, `apply_exif_orientation`), `media/thumbnail.rs`, `video/watermark.rs`, `qr/analyser.rs`  
**Ziel:** Jede Stelle, die Fotos mit der `image`-Crate dekodiert und die Pixel anzeigt oder neu schreibt, backt die EXIF-Orientation vorher ein. Fotos mit Orientation ≠ 1 (typisch Handy/Kamera kopfüber = `3`, hochkant = `6`/`8`) erscheinen überall aufrecht.

> Eine Agent-Session = nur Phase 52. Kein UI-Umbau, keine neue Rotate-UX, keine Migration bestehender Vorgänge.

---

## Symptome (Release-Build)

| Ort | Verhalten |
|-----|-----------|
| Strip-/Grid-Thumbnails | richtig |
| Foto-Vorschau (Review/Detail) | kurz richtig, dann 180° gedreht |
| Vorgangordner, normale Kopie | richtig |
| Vorgangordner, Wasserzeichen-Foto | falsch |

## Ursache

`image::open` ignoriert den EXIF-Orientation-Tag. Neu geschriebene JPEGs (`JpegEncoder`) enthalten keinen EXIF-Block mehr → Viewer zeigen die rohen (verdrehten) Pixel.

| Pfad | Datei | EXIF gebacken? |
|------|-------|----------------|
| LQ/HQ mit eingebettetem EXIF-Thumb | `thumbnail.rs` `try_load_exif_embedded_thumb` | ✅ |
| LQ/HQ **ohne** eingebetteten Thumb, `preview` immer | `thumbnail.rs` `generate_thumbnail_bytes` (`image::open`) | ❌ |
| Wasserzeichen-Foto | `watermark.rs` `create_photo_with_watermark` | ❌ |
| QR-Decode + persistiertes Treffer-Bild | `analyser.rs` `open_image_for_qr` / `open_jpeg_scaled` | ❌ |
| Rotate / Crop | `rotate.rs`, `crop.rs` | ✅ |
| Datei-Fallback im WebView (`convertFileSrc`) | Browser wendet EXIF an | ✅ |
| `copy_photos` (`fs::copy`) | Tag bleibt erhalten | ✅ |

Ablauf in der Vorschau: `PhotoPreview` zeigt zuerst `photoFileSrcFallback` (Original, Browser-EXIF → richtig) und ersetzt es durch den `preview`-Thumb aus Rust (ungebacken → falsch).

### Warum in `tauri dev` unauffällig

Kein separater Codepfad — der Bug ist in beiden Builds. Unterschiede:

1. **Decode-Tempo:** `[profile.dev]` optimiert Dependencies nicht (`opt-level` 0 für `image`/`zune-jpeg`). Ein 12–24-MP-Full-Decode dauert im Dev-Build Sekunden, im Release Millisekunden. In Dev bleibt der korrekte Datei-Fallback lange stehen; der Flip kommt spät oder nach dem Weiterklicken gar nicht.
2. **Wasserzeichen** wird nur beim Erstellen sichtbar — in Dev selten end-to-end getestet.
3. **Gemeinsamer Disk-Cache:** Dev und Release nutzen denselben `{data_local}/…/thumbnails/`. Ein im Release erzeugter falscher `preview` wird auch in Dev ausgeliefert (gleicher Pfad + mtime + Größe).

Gegenprobe in Dev: Foto mit Orientation 3 öffnen und ~10–20 s auf der Vorschau warten → Flip tritt auch dort auf.

---

## Leitentscheidungen

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | Zentraler Helper | Ein `open_image_oriented(path)` in `media/rotate.rs`; alle Full-Decodes von Fotos laufen darüber |
| 2 | EXIF-Quelle | Bestehendes `read_exif_orientation` (kamadak-exif) + `apply_exif_orientation` — schon getestet, identische Semantik wie Rotate/Crop |
| 3 | Thumbnail-Cache | **Cache-Version im Dateinamen** (`…_{quality}_o1.jpg`). Ohne das bleiben falsche Previews für immer gecacht (Key = Pfad+mtime+Größe ändert sich nicht) |
| 4 | QR | Orientation **vor** dem Decode anwenden → persistiertes Treffer-Bild und Spotlight-Koordinaten passen zusammen |
| 5 | Frontend | Keine Änderung. Kein CSS `image-orientation`, keine Zusatzdrehung (sonst Doppeldrehung) |
| 6 | Alte Vorgänge | Keine Migration. Bereits erzeugte falsche Wasserzeichen-Dateien bleiben; bei Bedarf neu exportieren |
| 7 | Mirror-Werte 2/4/5/7 | Über denselben Helper mit abgedeckt (selten, aber kostenlos) |

---

## Implementierung

### Slice A — Helper

**`src-tauri/src/media/rotate.rs`**

```rust
/// Full decode with EXIF Orientation baked into pixels (tag treated as 1 afterwards).
pub(crate) fn open_image_oriented(path: &Path) -> image::ImageResult<DynamicImage> {
    let orientation = read_exif_orientation(path);
    Ok(apply_exif_orientation(image::open(path)?, orientation))
}
```

- `rotate_photo` und `crop_photo` auf den Helper umstellen (reine Vereinfachung, gleiches Verhalten).
- Test-Fixture-Helper (in `rotate.rs` `#[cfg(test)]`, `pub(crate)` für andere Module): schreibt ein **asymmetrisches** JPEG (obere Hälfte rot, untere blau, z. B. 64×32) mit APP1-EXIF und gesetztem `Tag::Orientation` (`Value::Short(vec![n])`). Vorlage: `write_jpeg_with_exif_thumb` in `thumbnail.rs`.
- Tests:
  - Orientation 1 → unverändert
  - Orientation 3 → oben blau, unten rot (Farbvergleich mit Toleranz wegen JPEG)
  - Orientation 6 → Breite/Höhe vertauscht
  - Datei ohne EXIF → unverändert, kein Fehler

### Slice B — Thumbnails

**`src-tauri/src/media/thumbnail.rs`**

- In `generate_thumbnail_bytes` den Photo-Zweig `image::open(path)?` → `open_image_oriented(path)?`. Deckt `preview` **und** LQ/HQ-Fallback ohne eingebetteten Thumb ab.
- `cache_file_name`: Konstante `THUMB_CACHE_REV: &str = "o1"` anhängen. Gilt auch für Video-Thumbs (einmaliges Neu-Erzeugen, akzeptabel).
- Alte Cache-Dateien nicht aktiv löschen (bestehendes Cleanup / Platz unkritisch); optional später.
- Tests:
  - Orientation 3, Quality `preview` → Ausgabe oben blau / unten rot
  - Orientation 6, Quality `preview` → Hochformat
  - Orientation 3, **ohne** eingebetteten Thumb, Quality `lq` → aufrecht
  - Cache-Name enthält Revision

### Slice C — Wasserzeichen

**`src-tauri/src/video/watermark.rs`**

- `create_photo_with_watermark`: `image::open(input)` → `crate::media::rotate::open_image_oriented(input)`; Fehler-Mapping wie bisher (`"Foto öffnen …"`).
- Stempel bleibt `image::open` (PNG-Asset).
- Betrifft alle Aufrufer automatisch: `export_job.rs`, `speculative_create.rs` (2×), `append_job.rs`.
- Tests:
  - Orientation 3 → Ausgabe aufrecht (Farbprobe außerhalb der Stempelfläche, z. B. Randstreifen oben/unten)
  - Orientation 6 → Ausgabe Hochformat, Höhe 720, Breite < 720

### Slice D — QR

**`src-tauri/src/qr/analyser.rs`**

- `open_image_for_qr`: nach erfolgreichem `open_jpeg_scaled` **und** im `image::open`-Fallback `apply_exif_orientation(img, read_exif_orientation(path))` anwenden.
- Keine Änderung an `max_width`-Logik (Skalierung bleibt Breite der Rohdatei; bei 90° minimal anderes Budget, unkritisch).
- Test: Orientation 3 → `open_image_for_qr` liefert aufrechtes Bild (Farbprobe). Optional: Orientation 6 → Hochformat.
- Manuell: QR-Treffer-Vorschau (`QrSpotlightPreview`) bei kopfüber fotografiertem QR aufrecht, Spotlight sitzt auf dem Code.

---

## Abnahme

1. `cargo test` (rotate, crop, thumbnail, watermark, qr).
2. `npm run check`.
3. Testset: je ein JPEG mit Orientation 1, 3, 6, 8 (Handy hochkant/kopfüber) + eins ohne EXIF-Thumb.
4. **Release-Build** (`npm run tauri build`) oder Dev mit Wartezeit:
   - [ ] Strip/Grid aufrecht
   - [ ] Review/Detail: bleibt aufrecht nach Preview-Upgrade (kein Flip)
   - [ ] Vorgang-Medien-Viewer: aufrecht
   - [ ] Erstellen mit Wasserzeichen: `_wm`-/Stempel-Fotos im Vorgangordner aufrecht
   - [ ] Erstellen ohne Wasserzeichen: Kopien unverändert korrekt
   - [ ] Rotate/Crop im PhotoEditor: unverändert (keine Doppeldrehung)
   - [ ] QR-Treffer-Vorschau aufrecht
5. Kein manuelles Cache-Löschen nötig (Cache-Revision greift).

## Akzeptanzkriterien

- Kein Codepfad dekodiert Kundenfotos für Anzeige/Ausgabe mehr ohne Orientation-Bake (Grep: `image::open` nur noch für Stempel, Video-Frames, Helper selbst).
- Unit-Tests für Orientation 3 und 6 in Helper, Thumbnail, Wasserzeichen, QR.
- Alte falsche Preview-Thumbs werden nach Update nicht mehr ausgeliefert.

## Out of Scope

- Migration/Neuerzeugung bestehender Vorgangordner
- EXIF-Erhalt in neu geschriebenen JPEGs (Bake reicht)
- Auflösungsanzeige (`width`/`height` im Detail-Panel) bei 90°-Orientation — separat prüfen
- HEIC/RAW
