# Aero Tandem Studio v2 — Agent Rules

## Hauptdokumente

| Dokument | Wann anhängen |
|----------|----------------|
| `@AGENTS.md` | Immer (dieses File) |
| `@docs/IMPLEMENTATION_PLAN.md` | Index / Tracker (schlank) |
| `@docs/phases/open/…` | **Die eine offene Phase-Spec** |
| `@docs/phases/ARCHIVE.md` | Nur Regression / erledigte Spec |
| `@docs/VORGAENGE_DIALOG_PLAN.md` | Phase 38.x (erledigt) |
| `@docs/optimization_plan.md` | Nur **ein** OPT-Paket |
| `@docs/ARCHITECTURE.md` | Bei Architekturfragen |
| `@docs/MIGRATION.md` | Legacy-Mapping, gezielt |
| `@docs/LINUX_BUILD.md` / `@docs/MACOS_BUILD.md` | Plattform-Build |

**Context-Regel:** Nicht `ARCHIVE.md` und nicht den alten Monolithen anhängen.  
Pro Session **eine** Phase aus `docs/phases/open/` (oder ein OPT-Paket).

---

## Stack

Tauri 2 + Rust + React 19 + TypeScript + FFmpeg sidecar  
Tailwind + shadcn/ui, Zustand, SQLite · Player: HTML5 + Loopback-HTTP · Win + macOS + Linux

---

## Regeln

- **v2 ist Source of Truth** — bestehenden v2-Code und die offene Phase-Spec als Basis nutzen
- **Legacy nicht an Agent-Kontext anhängen** — optional manuell bei Edge-Cases
- Video-Verarbeitung **NUR** über FFmpeg CLI in Rust — kein MoviePy, kein Python
- Hardware-Encoding: NVENC (Windows + Linux), VideoToolbox (macOS), Fallback libx264
- FFmpeg-Command-Generierung braucht **Rust Unit-Tests**
- Nach Änderungen: `cargo test` und `npm run tauri dev`
- **Eine Phase pro Session** — Scope nicht erweitern
- Produktverhalten an v2-UX und Phase-Spec halten; kein blindes Portieren aus Python
- Plattformen: **Windows + macOS + Linux** (AppImage; siehe `docs/LINUX_BUILD.md`)

---

## Projektpfad

| | Pfad |
|---|------|
| v2 (editieren) | `C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio-v2` |

---

## Legacy-Archiv (optional, nicht anhängen)

Migration abgeschlossen (Phase 0–41 weitgehend ✅). Python-Legacy unter  
`C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio` — **nicht** attachen.  
Mapping: `@docs/MIGRATION.md` · alte Plan-Anhänge: `@docs/phases/REFERENCE.md`

---

## Aktueller Stand (Kurz)

- ✅ Phase 0–22, 24–31.4, 31.6–48 (Details: `@docs/IMPLEMENTATION_PLAN.md` Tracker; Phase 46 in `@docs/phases/ARCHIVE.md`)
- 🔄 **Phase 23** USB-MTP — 23.2g Whitelist / WPD-Descend ✅; als Nächstes **23.2h** oder **23.3** Linux · Spec: `@docs/phases/open/23-usb-mtp.md`
- ⬜ **Phase 31.5** Extra-Dateien (Resync / optional löschen) · Spec: `@docs/phases/open/31.5-extra-files.md`
- ✅ **Phase 31.10** Reconnect Offer Auswahl + `ignored` · Spec: `@docs/phases/open/31.10-reconnect-upload-select.md`
- ⬜ **Phase 14** ML Foto-Klassifikation (Backlog) · Spec: `@docs/phases/open/14-ml-photo.md`
- ✅ **Phase 47** Settings + Setup-Wizard UX Rebuild · Spec: `@docs/phases/open/47-settings-wizard-ux.md`
- ✅ **Phase 48** Vorgang Medien-Viewer (lokal) · Spec: `@docs/phases/open/48-vorgang-media-viewer.md`
- ✅ **Phase 49** Forced-Codec Export (Ziel-Codec, phone-safe: H.264 `yuv420p` / H.265 `hvc1`, CapCut respektiert H.265, AAC-Copy, Fortschritt-Fix) · Spec: `@docs/phases/open/49-forced-codec-export.md`
- ✅ **Phase 50** Outro (User-Asset am Videoende; Foto/Video, Mux wie Intro, Intro+Outro erlaubt, Existenz-Gate, i18n) · Spec: `@docs/phases/open/50-outro.md`
- ✅ **Phase 51** Instructor-Foto (Settings Erweitert; Copy beim Foto-Export) · Spec: `@docs/phases/open/51-instructor-foto.md`

**Nächster Schritt:** Phase 31.5 · Phase 23.2h / 23.3  
*(AMS-Bridge Historie-Merge: **AeroMediaService-v2** — AMS neu starten nach Deploy; optional Linux-VM / Windows-WPD-Abnahme)*

### Performance-Backlog

OPT-0 … OPT-19 ✅ (OPT-13 entfernt). **OPT-20** ✅ (Slice A macOS User-Pfad + Slice B Windows Prefer-Local/smb2-Brücke). Details: `@docs/optimization_plan.md`.

---

## Schnell-Prompt für Agent

```
Implementiere Phase X aus @docs/phases/open/<datei>.md
Regeln: @AGENTS.md
Nur Phase X. Danach cargo test && npm run check && npm run tauri dev.
```

**Aktuell offen:**

```
Implementiere Phase 31.10 aus @docs/phases/open/31.10-reconnect-upload-select.md
Regeln: @AGENTS.md
Nur 31.10.
```

```
Implementiere Phase 31.5 aus @docs/phases/open/31.5-extra-files.md
Regeln: @AGENTS.md
Nur 31.5.
```

```
Implementiere Phase 23.2h aus @docs/phases/open/23-usb-mtp.md
Regeln: @AGENTS.md
Nur 23.2h.
```

```
Implementiere Phase 50 aus @docs/phases/open/50-outro.md
Regeln: @AGENTS.md
Nur 50.
```

```
Implementiere Phase 51 aus @docs/phases/open/51-instructor-foto.md
Regeln: @AGENTS.md
Nur 51.
```

**Phase 15 (Linux, erledigt):** Prompt in `@docs/LINUX_BUILD.md` 
**Performance (OPT-X):** `@docs/optimization_plan.md` — nur **ein** OPT-Paket (OPT-0…20 ✅)
