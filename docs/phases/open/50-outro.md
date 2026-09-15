# Phase 50 — Outro (User-Asset am Videoende)

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ✅ Umgesetzt (CapCut-Single-Pass Intro?+Body+Outro, optional AAC-Copy; Config/Frontend/i18n; Unit-Tests grün)  
**Abhängigkeiten:** Intro/CapCut-Pipeline (`video/processor.rs`, `export_job.rs`), Encoding-Settings, Speculative Create (Phase 46), Preview-Reuse  
**Ziel:** Optionaler **Outro**-Clip am Ende des fertigen Videos — Medium vom User (Foto oder Video), Mux/Export analog Intro.

> Eine Agent-Session = nur Phase 50. Kein Intro-Redesign, keine Übergangs-Fades, kein Kundentext auf dem Outro, kein per-Vorgang-Outro.

---

## Leitentscheidungen

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | Default | `outro_enabled = false` |
| 2 | Medienquelle | User-Asset (Foto **oder** Video), nicht Bundle-Asset |
| 3 | Mux/Export | Wie Intro (CapCut/Universal): Segment passend zum Body bauen → anhängen |
| 4 | Reihenfolge | `[Intro?] → Body → [Outro?]` — Intro und Outro gleichzeitig erlaubt |
| 5 | Aktivierung UX | Toggle wie Intro; ohne hinterlegtes Medium **nicht speicherbar** bzw. Outro wird wieder deaktiviert |
| 6 | Foto | Dauer wählbar (gleiche Stufen wie Intro-`dauer`: 1–10 s); Audio = **Stille** (wie Intro/`anullsrc`) |
| 7 | Video | Eigene Länge; nach Auswahl **Dauer anzeigen**; Soft-Warnung ab **> 10 s** (kein harter Cap in v1) |
| 8 | Video-Audio | Ton **behalten**, falls vorhanden; ohne Ton → Stille nachlegen (durchgängige Audiospur) |
| 9 | Normalisierung | Scale/Pad/FPS/Pixelformat an Body (gleiches Prinzip wie Intro aus PNG) |
| 10 | Speicherort | Absoluter Pfad in Config; bei Neuinstallation neu wählen. Vor Preview/Erstellen: **Datei existiert?** |
| 11 | Personalisierung | Kein Kundentext / drawtext auf Outro (Intro bleibt personalisiert) |
| 12 | Speculative Create | Staging weiter body-only; Outro (wie Intro) erst beim Commit / finalen CapCut-Pass |

---

## UX

### Settings (Encoding, Erweitert — neben Intro)

1. Checkbox **Outro verwenden** (default aus)
2. Nach Aktivierung: Medium wählen (Datei-Dialog und/oder Drag & Drop)
   - Erlaubt: gängige Bild- und Videoformate (an bestehende App-Filter anlehnen)
   - Ohne gültigen Pfad: Speichern verweigern **oder** Toggle automatisch wieder aus
3. **Foto gewählt:** Dauer-Select (1–10 s), analog Intro
4. **Video gewählt:** gemessene Dauer anzeigen; Soft-Warnung wenn `> 10 s`
5. Anzeige des Dateinamens (+ optional kurzer Pfad); Aktion „Medium entfernen“ → Outro aus

### Create / Preview

- Outro an + Datei fehlt → Preview/Erstellen blockieren mit klarer Meldung (kein später Encode-Fail)
- Preview und finales Video enthalten denselben Outro (Cache-/Fingerprint inkl. Outro-Flags)

```
Settings: Outro an
  → Medium wählen (Pflicht)
  → Foto: Dauer setzen | Video: Dauer + ggf. Warnung
  → Speichern nur mit gültigem Pfad

Erstellen / Vorschau
  → Existenz-Check outro_path
  → Encode: … Body … + Outro-Segment → CapCut-Mux
```

---

## Config (Skizze)

| Key | Typ | Default | Bedeutung |
|-----|-----|---------|-----------|
| `outro_enabled` | `bool` | `false` | Outro am Ende anhängen |
| `outro_path` | `string` | `""` | Absoluter Pfad zu Foto/Video |
| `outro_dauer` | `u32` | wie Intro-Default (z. B. 5) | Nur bei Bild relevant |

Medientyp aus Extension/Probe ableiten (kein separates `outro_type` nötig, optional als Cache ok).

Persistenz: bestehende `AppConfig`-Serde; leerer Pfad + `outro_enabled` darf nach Load nicht „an“ bleiben (Sanitize beim Load/Save).

---

## Technik (geplant)

| Schicht | Änderung |
|---------|----------|
| Rust `AppConfig` | Keys + Defaults + Sanitize (`enabled` nur mit nicht-leerem existierendem Pfad optional erst zur Laufzeit prüfen) |
| Rust `CreateVideoOptions` / processor | CapCut-Single-Pass: `[Intro?] → Body → Outro` in **einem** Filtergraph (wie Intro-only); optional AAC-Audio-Copy danach |
| Rust CapCut/Intro-Pfad | `build_intro_body_outro_single_pass_args` + `mux_with_outro` (kein Vorab-Segment-Encode) |
| Rust Speculative | Fingerprint inkl. Outro; Commit wendet Outro mit Intro an |
| Rust Unit-Tests | FFmpeg-Arg-Builder Foto/Video/Stille; Single-Pass Mux; Sanitize |
| Frontend EncodingTab | Toggle, Picker/Drop, Dauer, Dauer-Anzeige, Soft-Warnung |
| Frontend Create/Preview | Existenz-Gate; Job-Plan/Progress falls Steps gesplittet; Cache-Key |
| i18n | de / en / es-MX |

### Segment-Bau (Analogie Intro / CapCut-Single-Pass)

- **Ein FFmpeg-Durchlauf:** optional Intro-PNG (+ drawtext) + Body + Outro (Foto-Loop **oder** Video) im Filtergraph → durchgängig kodieren
- **Foto-Outro:** `-loop 1` + scale/pad + `trim=outro_dauer` + Stille (kein drawtext)
- **Video-Outro:** scale/pad/FPS an Body; Ton behalten wenn vorhanden, sonst Stille
- **Optional AAC-Copy:** wie Intro-only, wenn Body-AAC copyable und Outro keinen eigenen Ton braucht (Foto / stummes Video)

---

## Out of Scope

- Fade / Übergangseffekte
- Kundentext oder Logo-Overlay auf dem Outro
- Outro pro Vorgang / pro Kunde
- Medium in App-Daten kopieren (v1: nur Pfad)
- Harte Ablehnung/Trim bei Video > 10 s
- Intro-Medienquelle auf User-Asset umbauen
- Neuer Mux-Modus jenseits CapCut/bestehender Intro-Pipeline

---

## Akzeptanzkriterien

1. Outro default aus; ohne Medium nicht dauerhaft aktiv speicherbar
2. Foto-Outro: gewählte Dauer, Stille-Audio, am Ende des Finalvideos
3. Video-Outro mit Ton: Ton hörbar; ohne Ton: kein Audibruch (Stille)
4. Intro + Outro gleichzeitig: Reihenfolge Intro → Flug → Outro
5. Video > 10 s: Dauer sichtbar + Soft-Warnung; Encode trotzdem möglich
6. Fehlende `outro_path`-Datei: Preview/Erstellen geblockt mit Meldung
7. Preview und Create liefern denselben Outro-Inhalt (Fingerprint/Invalidation)
8. `cargo test` (inkl. neuer Arg-Builder-Tests) + `npm run check` grün
9. i18n de / en / es-MX

---

## Manuelle Abnahme (Kurz)

| # | Fall |
|---|------|
| A | Nur Outro-Foto, Intro aus |
| B | Nur Outro-Video (mit Ton), Intro aus |
| C | Intro + Outro-Foto |
| D | Intro + Outro-Video |
| E | Outro an, Datei löschen → Create blockiert |
| F | Video 15 s → Warnung, Encode ok |
| G | Speculative Create mit Intro+Outro → Commit korrekt |

---

## Referenzen

```
src/components/settings/tabs/EncodingTab.tsx
src-tauri/src/storage/config.rs
src-tauri/src/video/processor.rs          # build_intro_ffmpeg_args, CapCut-Mux
src-tauri/src/video/export_job.rs
src-tauri/src/video/speculative_create.rs
src/hooks/useSpeculativeCreate.ts
src/lib/createJobPlan.ts
src/store/previewCacheStore.ts
src/locales/de.json | en.json | es-MX.json
```

---

## Agent-Prompt

```
Implementiere Phase 50 aus @docs/phases/open/50-outro.md
Regeln: @AGENTS.md
Nur 50 (Outro User-Asset am Ende; Mux wie Intro; Intro+Outro erlaubt).
Kein Intro-Redesign, keine Fades, kein Kundentext auf Outro.
FFmpeg-Arg-Builder + Sanitize mit Unit-Tests.
i18n de/en/es-MX.
Danach cargo test && npm run check && npm run tauri dev.
```
