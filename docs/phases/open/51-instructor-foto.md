# Phase 51 — Instructor-Foto (mit Export der Kundenfotos)

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ✅ Umgesetzt (Config/Sanitize, Encoding Erweitert, Copy nach Kundenfotos, Speculative-Fingerprint, Existenz-Gate, i18n; Unit-Tests)  
**Abhängigkeiten:** Foto-Export (`export_job::copy_photos`), Encoding-Settings (Erweitert), Speculative Create (Phase 46), Existenz-Gate analog Outro (Phase 50), AMS-Lieferliste (Disk → Manifest)  
**Ziel:** Optional ein globales **Instructor-Foto** in den Settings hinterlegen; wenn „ablegen“ aktiv ist und beim Erstellen Kundenfotos exportiert werden, wird das Instructor-Foto **zusätzlich** in die Foto-Ausgabeordner kopiert.

> Eine Agent-Session = nur Phase 51. Kein Video-Mux, kein Cutter-Export, kein Wasserzeichen auf dem Instructor-Foto, kein pro-Vorgang-/Crew-Override.

---

## Leitentscheidungen

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | Default | `instructor_foto_enabled = false` |
| 2 | Medienquelle | User-Asset (nur **JPEG/PNG**), absoluter Pfad in Config |
| 3 | Settings-UI | Nur **Erweitert** (Einfach: ausgeblendet), Encoding-Tab neben Intro/Outro |
| 4 | Geltung | **Global** in Settings (nicht pro Vorgang / Crew / Pilot) |
| 5 | Trigger | Nur wenn Vorgang **Foto-Produkt** hat **und** mindestens **ein Kundenfoto** erfolgreich exportiert/kopiert wird |
| 6 | Zielordner | In **jeden** angelegten Foto-Unterordner des Vorgangs: `Handcam_Foto` und/oder `Outside_Foto` — bei beiden Produkten **beide**, gleicher Dateiname |
| 7 | Dateiname | Einstellbar; Default `Instructor.jpg` (inkl. Extension) |
| 8 | Position | Nach den Kundenfotos (am Ende der Foto-Kopie) |
| 9 | Wasserzeichen | Instructor **nie** mit Stempel — auch bei unbezahlt |
| 10 | Fehlende Datei | Wie Outro: Create (und ggf. Preview-Pfad, falls Foto-Job betroffen) **blockieren** mit klarer Meldung |
| 11 | Cutter | Out of Scope — Instructor erscheint nicht im Working-Folder und nicht bei „Frames als Fotos exportieren“ |
| 12 | Manifest / AMS | Datei vor Manifest-Write auf Disk legen → landet automatisch in der Lieferliste |
| 13 | Speculative Create | Fingerprint inkl. Instructor-Flags/Pfad/Filename; Copy analog finalem Export-Job |

---

## UX

### Settings (Encoding, Erweitert — neben Intro/Outro)

1. Checkbox **Instructor-Foto ablegen** (default aus)
2. Datei wählen (Datei-Dialog; Filter: JPEG/PNG)
   - Ohne gültigen Pfad: Speichern verweigern **oder** Toggle automatisch wieder aus (Sanitize wie Outro)
3. Textfeld **Dateiname** (Default `Instructor.jpg`); ungültige Zeichen strippen
4. Vorschau des gewählten Bildes; Aktion „entfernen“ → Pfad leer, Toggle aus
5. Beim erfolgreichen Wählen optional Toggle auto-an (Parity Outro)

### Create

```
Settings: Instructor ablegen an + Pfad gesetzt
  → Existenz-Check instructor_foto_path (wie Outro)
  → Erstellen: Kundenfotos kopieren (≥1)
  → Danach Instructor in jeden aktiven Foto-Unterordner kopieren
     (gleicher Dateiname; kein Wasserzeichen)
```

- Ablegen an + Datei fehlt → Create blockiert (kein stilles Skip)
- Ablegen an, aber **kein** Kundenfoto exportiert (kein Foto-Produkt / leere Liste) → **kein** Instructor-Copy, Create sonst normal (kein Block nur wegen „keine Fotos“)
- Ablegen aus → Verhalten unverändert

---

## Config (Skizze)

| Key | Typ | Default | Bedeutung |
|-----|-----|---------|-----------|
| `instructor_foto_enabled` | `bool` | `false` | Beim Foto-Export Instructor ablegen |
| `instructor_foto_path` | `string` | `""` | Absoluter Pfad zu JPEG/PNG |
| `instructor_foto_filename` | `string` | `"Instructor.jpg"` | Ziel-Dateiname inkl. Extension |

Persistenz: bestehende `AppConfig`-Serde. Sanitize beim Load/Save:

- `enabled` + leerer Pfad → `enabled = false`
- Extension des Pfads muss `.jpg` / `.jpeg` / `.png` sein (case-insensitive); sonst Toggle aus bzw. Speichern ablehnen
- `filename`: trimmen; leerer Name → Default; Path-Separatoren / `..` entfernen; optional Extension an Quelldatei angleichen **oder** Config-Name unverändert nutzen (v1: **Config-Name inkl. Extension**, Default `Instructor.jpg`)

---

## Technik (geplant)

| Schicht | Änderung |
|---------|----------|
| Rust `AppConfig` | Keys + Defaults + Sanitize |
| Rust `export_job` | Nach erfolgreichem Kundenfoto-Copy (≥1): Instructor in Handcam- und/oder Outside-Foto-Dir kopieren |
| Rust Speculative | Gleicher Copy-Schritt / Fingerprint-Felder |
| Rust Gate | Vor Create: wenn enabled → Pfad existiert (Meldung analog Outro) |
| Rust Unit-Tests | aus; an ohne Kundenfotos; nur Handcam; nur Outside; beide; WM unberührt; fehlende Datei; Dateiname; Sanitize |
| Frontend EncodingTab | Erweitert-only: Toggle, Picker, Filename, Vorschau, entfernen |
| Frontend Create | Existenz-Gate (Reuse/ähnliche Outro-Meldung) |
| i18n | de / en / es-MX |

### Copy-Logik (Skizze)

```text
if !instructor_foto_enabled → skip
if customers_photos_copied == 0 → skip
if !path.is_file() → bereits vom Gate abgefangen
dest_name = sanitized instructor_foto_filename
for each active foto subdir (handcam / outside):
  fs::copy(path, subdir.join(dest_name))
  // bei Namenskollision: _001-Suffix oder überschreiben — v1: claim_unique analog Fotos, oder feste Überschreib-Doku
```

**Kollision:** Wenn bereits eine Kunden-Datei denselben Namen hat → eindeutigen Namen claimen (`Instructor_001.jpg`), analog `claim_unique_photo_filename` — oder in Spec-Abnahme dokumentieren. Empfohlen: Unique-Claim, damit kein Kundenfoto überschrieben wird.

Instructor **nicht** in `watermark_photo_indices` / WM-Pipeline aufnehmen.

---

## Out of Scope

- Video-Intro/Outro / Mux / FFmpeg für Instructor
- Cutter-Frame-Export / Working-Folder
- Wasserzeichen / Stempel auf Instructor
- Pro Vorgang, Crew oder Pilot
- Mehrere Instructor-Fotos
- Medium in App-Daten kopieren (v1: nur Pfad)
- HEIC / RAW / andere Formate
- Resize / Kompression der Instructor-Datei
- Anzeige in Einfach-Mode

---

## Akzeptanzkriterien

1. Default aus; ohne Medium nicht dauerhaft aktiv speicherbar
2. Nur Erweitert sichtbar; Einfach unverändert
3. Mindestens ein Kundenfoto kopiert + enabled → Instructor in jedem aktiven Foto-Unterordner mit konfiguriertem Dateinamen
4. Handcam + Outside → Instructor in **beide**, gleicher Name
5. Kein Kundenfoto / kein Foto-Produkt → kein Instructor-Copy, Create sonst ok
6. Unbezahlt: Kundenfotos ggf. mit WM; Instructor **ohne** Stempel
7. Fehlende `instructor_foto_path`-Datei bei enabled → Create geblockt mit Meldung
8. Cutter-Foto-Export unverändert (kein Instructor)
9. `cargo test` (Sanitize + Copy-Logik) + `npm run check` grün
10. i18n de / en / es-MX

---

## Manuelle Abnahme (Kurz)

| # | Fall |
|---|------|
| A | Ablegen aus → Output ohne Instructor |
| B | Nur Outside-Fotos → Instructor nur in Outside_Foto |
| C | Nur Handcam-Fotos → Instructor nur in Handcam_Foto |
| D | Handcam + Outside → Instructor in beide, gleicher Dateiname |
| E | Enabled, Dateiname `Pilot.png`, PNG-Quelle → Datei heißt wie konfiguriert |
| F | Enabled, Pfad-Datei gelöscht → Create blockiert |
| G | Enabled, Vorgang nur Video (keine Fotos) → kein Instructor, Create ok |
| H | Unbezahlt + WM-Fotos → Instructor ohne Stempel |
| I | Speculative Create mit Fotos → Instructor nach Commit im Output |

---

## Referenzen

```
src/components/settings/tabs/EncodingTab.tsx
src-tauri/src/storage/config.rs
src-tauri/src/video/export_job.rs          # copy_photos, build_photo_rename_map
src-tauri/src/video/speculative_create.rs
src/lib/createJobPlan.ts
src/locales/de.json | en.json | es-MX.json
docs/phases/open/50-outro.md               # UX-/Gate-Parity (Toggle, Existenz)
```

---

## Agent-Prompt

```
Implementiere Phase 51 aus @docs/phases/open/51-instructor-foto.md
Regeln: @AGENTS.md
Nur 51 (Instructor-Foto Settings + Copy beim Erstellen).
Kein Video-Mux, kein Cutter, kein WM auf Instructor.
Copy-Logik + Sanitize mit Unit-Tests.
i18n de/en/es-MX.
Danach cargo test && npm run check && npm run tauri dev.
```
