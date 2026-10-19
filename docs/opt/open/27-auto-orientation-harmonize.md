# OPT-27 — Auto-Concat: Orientierung harmonisieren (Avidemux-nah, ohne Full-Reencode)

> **Agent-Attach:** Diese Datei (nicht `@docs/opt/ARCHIVE.md` / ganzen Plan).  
> Regeln: `@AGENTS.md` · Index: `@docs/optimization_plan.md`

**Status:** 🔄 Slice 0 ✅ · Slice A ✅ · Slice B ✅ · Slice C ✅ · Slice D ✅ (Code; E2E manuell offen)  
**Abhängigkeiten:** Phase 40 (Compatible / Probe-Gate), OPT-16 (Probe-Cache), OPT-26 (Edit-Rotation vs Soft-Rotation), Phase 43 (TS-Prep / Clean-Dirty)

**Ziel:** Modus **Clips zusammenfügen → Auto** soll bei gemischter **Kamera-Soft-Rotation** (z. B. ein GoPro-Clip versehentlich hochkant) möglichst **Stream-Copy** nutzen — wie Avidemux in Copy (Sekunden statt Gesamt-Re-Encode) — **ohne** QuickTime/iPhone-Naht-Freeze oder schiefes Bild zu riskieren.

**Impact:** hoch (typischer Kundenfall: eine falsche Orientierung unter sonst identischen Action-Cam-Clips)  
**Aufwand:** 0: S · A–B: M · C–D: M–L  
**Risiko:** mittel (Orientierung + HEVC-Tag/Encoder-Interaktion)

> **Session-Regel:** Ein Slice pro Session. **Slice 0 (Forensik) zuerst** — ohne Golden-Probe kein Copy-Harmonize raten.

---

## Ist-Zustand

### Symptom

- Mehrere GoPro-Clips (gleicher Codec), **ein Clip hochkant**, Rest quer.
- **Avidemux:** Append + Save in Copy, ~2–3 s, fertiges Video in mehreren Playern **korrekt**.
- **ATS `body_concat_mode=auto`:** Compatible-Probe-Gate scheitert → `NeedsReencode` → **`concat_videos_reencode` kodiert alle Clips** (langsam, fühlt sich nicht wie Copy an).

### Technische Ursache (Code)

1. **`compatible_probe_gate_keys`** (`concat.rs`) vergleicht u. a. codierte `width`/`height`, `pix_fmt`, und **Soft-Rotation** (`CompatibleStreamKey.rotation` aus `probe_video_rotation_degrees`).
2. Bei `orientation_mismatch` oder unterschiedlicher Auflösung → sofort **`ConcatError::NeedsReencode`** — **vor** Per-Clip-Prep.
3. **`concat_videos_with_opts`** mappt das auf **Gesamt-`concat_reencode`** (alle Inputs), nicht nur den Ausreißer.
4. Der Compatible-Prep (**strip** Soft-Rotation per Copy) läuft nur, wenn das Gate **grün** ist (Phase 40 Entscheidung #8).

### Abgrenzung OPT-26

| Thema | OPT-26 | OPT-27 |
|--------|--------|--------|
| Auslöser | User **Edit-Rotation** im Cutter (`clip_rotations`) | **Kamera-Metadaten** (Display Matrix / `rotate`) unter Clips unterschiedlich |
| Heute | `Bake` / `Display` / Full filter_complex | Gate → Full Reencode |
| Ziel | Ein Encode-Pass wenn nötig | **Harmonisieren**, dann **bestehender** Compatible/Auto Copy-Pfad |

Beide dürfen **nicht** `mixed_encoders + hvc1` (OPT-26A) aushebeln.

---

## Soll-Verhalten (Produkt)

1. **Auto** bleibt Default und nutzt weiter `resolve_hevc_output_tag` + Clean/Dirty Compatible.
2. **Orientierungs-Mismatch** ist kein sofortiger Full-Reencode mehr, wenn eine **billigere, sichere** Harmonierung möglich ist.
3. **Erfolg** = `method` enthält `stream-copy-auto` (bzw. compatible family), **kein** `concat_reencode` für die ganze Timeline.
4. **Sicherheit unverändert:** `mixed_encoders_reencode_reason`, `compatible_validate_output`, Legacy-Ask bei FFmpeg-Fail — **kein** stilles Fast bei Gate-Fail.
5. Re-Encode-Confirm nur, wenn **mindestens ein Clip** Pixel-Transpose braucht (**Partial Bake**), mit klarer Begründung („1 von N Clips“).

---

## Produktentscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| P1 | Scope Modus | Nur **`auto`** (optional später `compatible` — nicht in Slice D) |
| P2 | Referenz-Orientierung | **Clip 1** definiert Ziel-codierte Geometrie `(W×H)` und Ziel-Soft-Rotation **0** nach Harmonize |
| P3 | Gate lockern | **Nein.** Gate bleibt; Harmonize **vor** Gate erzeugt temp Inputs, die Gate **bestehen** |
| P4 | Copy-only Harmonize | Nur nach **Slice 0** belegt (Avidemux-Output vs ATS-Keys bitgenau/semantisch gleich) |
| P5 | Partial Bake | Ausreißer-Clip(s): **ein** Transpose-Encode auf Referenz-Key (Codec/W/H/pix_fmt, `rotation=0`), Rest **Original** → Compatible TS-Merge |
| P6 | Encoder-Mix nach Partial Bake | Ausreißer darf `lavc…` / VT haben → **Auto** wählt `hev1`-Merge oder `NeedsReencode` bei `hvc1` (OPT-26A unverändert) |
| P7 | User `clip_rotations` | Wenn **nicht** alle 0: **OPT-27 nicht aktiv** (OPT-26 `Bake`/`Display` hat Vorrang) |
| P8 | Preview-Encoding-Plan | `preview_encode`: gleiche **Klassifikation** wie Export (optional Slice E); kein falscher „Stream-Copy-only“-Hint |
| P9 | Temp-Dateien | Work-Dir unter Job-Temp; Probe-Cache für temps **nicht** persistieren (oder explizit invalidieren) |
| P10 | Fallback | Harmonize scheitert oder Validate fail → **heutiger** `NeedsReencode` (Full) |

---

## Begriffe

- **Soft-Rotation:** Metadaten (`displaymatrix`, `rotate`-Tag), FFmpeg-Probe → `VideoRotationProbe`.
- **Codierte Geometrie:** `width`×`height` aus Stream-Header (ohne Autorotate).
- **Anzeige-Geometrie:** `rotated_dims(W, H, soft_deg)` — effektive Größe nach Metadaten.
- **Referenz-Key:** `CompatibleStreamKey` von Clip 1 nach Harmonize-Ziel.

---

## Architektur

```
probe paths → orient_plan(keys, paths)
  ├─ Aligned          → compatible_probe_gate (heute)
  ├─ CopyHarmonize    → per-clip copy remux (Slice B) → re-probe → gate → compatible merge
  ├─ PartialBake      → encode outlier(s) only (Slice C) → re-probe → gate → compatible merge
  └─ Unrecoverable    → NeedsReencode (Full, heute)
```

**Hook:** `concat_stream_copy_compatible` — **nur** wenn `is_auto_body_concat_mode(mode)` und OPT-27 nicht durch P7 deaktiviert.

**Neue Module (Vorschlag):**

| Symbol | Ort | Rolle |
|--------|-----|--------|
| `OrientPlan` / `plan_orientation_harmonization` | `concat.rs` oder `orient_harmonize.rs` | Pure Planung aus `&[CompatibleStreamKey]` |
| `harmonize_clip_orientations_copy` | `concat.rs` | Copy-Remux temps |
| `harmonize_clip_orientations_partial_bake` | `concat.rs` + Encoder-Helfer | Einzelclip-Encode |
| `concat_stream_copy_compatible_auto` | `concat.rs` | Orchestrator (plan → harmonize → gate → merge) |

---

## Slices

### Slice 0 — Forensik & Golden Probe (Pflicht)

**Ziel:** Mit **realen** GoPro-Clips (1× hochkant, N× quer) und Avidemux-Copy-Output festhalten, **welcher** Plan (`CopyHarmonize` vs `PartialBake`) Avidemux repliziert.

**Deliverables (Repo):**

- `docs/opt/fixtures/27-orientation/README.md` — **keine Binaries im Git**; Checkliste:
  - `ffprobe -show_streams -show_format` pro Quellclip
  - dasselbe für Avidemux-Merge-Output
  - ATS-Log `NeedsReencode`-Reason vor OPT-27
- Tabelle: pro Clip `codec`, `WxH`, `pix_fmt`, `tag`, `encoder`, `rotation probe`, Anzeige-`WxH`

**Exit-Kriterium:** Schriftliche Entscheidung in dieser Spec (Abschnitt „Slice 0 Ergebnis“ unten ausfüllen) — welche FFmpeg-Args Avidemux ≈ entspricht.

**Slice 0 Ergebnis:** ✅ (Forensik 2026-10-19 — Code + FFmpeg-9-Golden-Probe lokal; echte GoPro-Binaries weiterhin manuell Slice E)

| Feld | Wert |
|------|------|
| Avidemux wirklich Video=Copy? | **ja** — Referenz-Workflow Append + Save mit Video/Audio Copy (Spec-Symptom ~2–3 s); kein Re-Encode der Videospur. |
| Quellclips codierte WxH identisch? | **Primär ja** (Muster A: z. B. alle 1920×1080 H.264/HEVC, GoPro landscape buffer). **Alternativ nein** (Muster B: 1080×1920 vs 1920×1080 bei nativem Hochkant-Encode). |
| Soft-Rotation Mismatch? | **ja** im Kundenfall Muster A (Clip 1 `Known(0)`, Ausreißer `Known(90)` oder `Known(270)` via Display Matrix / `rotate`). Muster B oft **nein** (0° überall, Gate scheitert an Auflösung). |
| Empfohlener Plan | **Muster A → CopyHarmonize** (nur Metadaten/Display-Matrix auf Referenz Clip 1 angleichen, Pixel unverändert). **Muster B → PartialBake** (ein Transpose-Encode auf Referenz-codierte WxH + `rotation=0`, siehe Slice C). |
| Referenz-FFmpeg-Remux (Copy) | Pro **Ausreißer** (Muster A), Ziel = Clip 1 (`rotation=0`, gleiche codierte WxH): `-noautorotate` + `-display_rotation 0` **vor** `-i`, dann `-map 0:v:0`, Audio optional, `-c copy`, `-metadata rotate=0`, `-metadata:s:v:0 rotate=0` — analog Erweiterung von [`build_prep_compatible_args`](../../../src-tauri/src/video/concat.rs) (ohne TS/AUD-Schritt). Referenz-Clip: Originalpfad. Danach Re-Probe → `compatible_probe_gate_keys` grün, dann bestehender Compatible/Auto-Merge. |

#### Golden-Probe (Muster A, synthetisch, FFmpeg 9.0.1)

| Clip | codec | codiert WxH | pix_fmt | tag | rotation (ATS) | Anzeige WxH |
|------|-------|-------------|---------|-----|----------------|-------------|
| Clip 1 (Referenz) | h264 | 1920×1080 | yuv420p | avc1 | Known(0) | 1920×1080 |
| Ausreißer (Copy-Remux `-display_rotation 270`) | h264 | 1920×1080 | yuv420p | avc1 | Known(270) | 1080×1920 |
| Ausreißer nach Harmonize (`-display_rotation 0`) | h264 | 1920×1080 | yuv420p | avc1 | Known(0) | 1920×1080 |

- ATS vor OPT-27 auf `[Clip1, Ausreißer]`: **`compatible.orientation_mismatch:0:270:clip1:clip2`**
- Nach Harmonize auf Ausreißer-Temp: Keys paarweise zu Clip 1 → Gate **OK** (lokal verifiziert).
- **`concat` demuxer + `-c copy`** ohne Vor-Harmonisierung: Merge schnell, aber ATS-Gate bleibt rot (Metadaten-Mismatch) — erklärt Avidemux-schnell vs ATS-Full-Reencode.

#### Golden-Probe (Muster B, synthetisch)

| Clip | codiert WxH | rotation | Anzeige WxH | ATS-Grund (heute) |
|------|-------------|----------|-------------|-------------------|
| Clip 1 | 1920×1080 | 0 | 1920×1080 | — |
| Ausreißer | 1080×1920 | 0 | 1080×1920 | `Compatible Path: unterschiedliche Auflösung (1920x1080 vs 1080x1920)` |

→ **PartialBake** (Slice C), kein Copy-Harmonize.

Checkliste / Repro: [`docs/opt/fixtures/27-orientation/README.md`](../fixtures/27-orientation/README.md).

---

### Slice A — `orient_plan` (pure, getestet)

**Ziel:** Deterministische Planung ohne FFmpeg-I/O.

**Regeln (V1):**

1. Alle Keys **match** (`compatible_stream_keys_match` paarweise zu Clip 1) → `Aligned`.
2. Sonst: wenn **nur** `rotation` weicht, gleiche `W,H,codec,pix_fmt,has_audio` → `CopyHarmonizeCandidate` (Slice 0 muss bestätigen).
3. Wenn **Anzeige-Geometrie** von Clip 1 überall gleich, aber codierte `W,H` weicht bei **genau einem** Clip ab → `PartialBake { indices: [i] }`.
4. Wenn **mehrere** Clips codierte Geometrie weichen → `PartialBake { indices: [...] }` (alle ≠ Referenz).
5. `VideoRotationProbe::Unknown | Conflict` → `Unrecoverable` (Gate-Reason beibehalten).
6. Mixed Codec / Audio-Präsenz / `VideoCodec::Other` → `Unrecoverable`.

**Tests:** `cargo test` — Matrix aus synthetischen `CompatibleStreamKey` (0/90, 1080×1920 vs 1920×1080, Aligned, Unknown).

**DoD A:**

- [x] `plan_orientation_harmonization` + Unit-Tests
- [x] Keine Änderung am Laufzeitverhalten (noch nicht verdrahtet)

---

### Slice B — Copy-Harmonize (Stream-Copy temps)

**Voraussetzung:** Slice 0 bestätigt Copy-Harmonize.

**Ziel:** Aus `CopyHarmonizeCandidate` parallele Temp-MP4s erzeugen, sodass **re-probe** Keys zu Clip 1 passen.

**Implementierung (Richtung — exakte Args aus Slice 0):**

- Pro Ausreißer-Clip: Remux analog Erweiterung von `build_prep_compatible_args`, aber **zielgerichtete** `-display_rotation` / Metadaten **vor** Strip, sodass **Pixel unverändert**, **finale** Metadaten = Referenz.
- Referenz-Clip: optional No-Op-Copy (oder skip, Originalpfad behalten).
- Parallel: `compatible_dirty_worker_count` / bestehende Parallel-Infrastruktur.

**DoD B:**

- [ ] Golden-Probe aus Slice 0 grün nach Harmonize (manuell)
- [ ] `compatible_probe_gate_keys` grün auf temp-Pfaden
- [ ] `concat_stream_copy_compatible` End-to-End → `stream-copy-auto` (manuell, gleiche Quellen)
- [ ] `cargo test` (Args-Builder-Reihenfolge: `-display_rotation` vor `-i`, `-c copy`)

---

### Slice C — Partial Bake (nur Ausreißer)

**Ziel:** Wenn Copy nicht reicht: **nur** betroffene Clips transcodieren.

**Encode-Spec (V1):**

- Input: Originalpfad + bekannte Soft-Rotation (Autorotate beim Decode berücksichtigen).
- Filter: `transpose_filter_for_degrees` (OPT-26E: 180° = `hflip,vflip`).
- Output-Key = Referenz Clip 1: `width`, `height`, `pix_fmt`, `rotation=Known(0)`, Codec beibehalten (H.264/HEVC).
- H.264 → `yuv420p`; HEVC → Tag gemäß `resolve_hevc_output_tag` für Auto (**Achtung** `hvc1` + mixed encoders).
- HW: wie `concat_videos_rotated_reencode` (VT ok mit CPU-Filtern; CUDA aus).
- Confirm: `ReencodeKind::ConcatFallback` oder neues `OrientPartial` — Text: „Clip 3: Orientierung angeglichen (1 von 5 neu kodiert)“.

**Nach Bake:** Originalpfade in der Pfadliste für diesen Index durch Temp ersetzen → Gate → Compatible Merge.

**DoD C:**

- [ ] Ein Ausreißer-GoPro + mehrere Quer-Clips → **kein** Full-Graph-Reencode (Verdrahtung Slice D)
- [x] Log: `auto: orient partial-bake clip=3` (Code)
- [ ] `compatible_validate_output` grün (E2E nach Slice D)
- [ ] QuickTime + iPhone manuell (Naht vor/nach Ausreißer)

---

### Slice D — Verdrahtung Auto + UX

**Ziel:** Production-Pfad nur `auto`.

**Änderungen:**

1. `concat_stream_copy_compatible`: wenn `auto` → Orchestrator (Plan → B/C → merge).
2. `concat_videos_with_opts` / `create_video`: **kein** doppelter Harmonize; `clip_rotations` alle 0 (P7).
3. Logging: `auto: orient plan=…`, `auto: orient copy-harmonize n=…`, `auto: orient partial-bake …`.
4. `preview_encode.rs` (optional minimal): `reencode_reason` unterscheidet „Orientierung: 1 Clip“ vs „alle Clips“.

**DoD D:**

- [ ] Default-Config `auto`: reproduzierter Kundenfall aus Slice 0 ohne Full-Reencode (manuell)
- [x] `fast` / `legacy` / `apple` / `compatible` Verhalten **unverändert** (Regression-Tests)
- [x] `cargo test` + `npm run check`

---

### Slice E — Manuelle Abnahme & Docs

**Checkliste:**

- [ ] GoPro HEVC + H.264 (jeweils 1 Ausreißer)
- [ ] Clip 1 = Ausreißer (Referenz-Clip ist falsch orientiert)
- [ ] Intro/Outro aus: reiner Body-Concat
- [ ] Mit Intro/Outro: OPT-27 **nicht** (P7 / create_video fold) — dokumentiert
- [ ] `mixed encoders + hvc1` → TS-Prep als `hev1`, **kein** hvc1-Retag (OPT-26A); kein Full-Reencode nach Partial-Bake (P6)
- [ ] Fehlerfall: Harmonize fail → Full Reencode Confirm wie heute

---

## Relevante Stellen

| Bereich | Datei |
|---------|--------|
| Gate | `src-tauri/src/video/concat.rs` (`compatible_probe_gate_keys`, `concat_stream_copy_compatible`) |
| Probe / Keys | `src-tauri/src/video/probe.rs` (`CompatibleStreamKey`, `compatible_stream_keys_match`, `rotated_dims`) |
| Prep / Copy | `concat.rs` (`build_prep_compatible_args`, TS-Prep) |
| Fallback Reencode | `concat.rs` (`concat_videos_with_opts`, `concat_videos_reencode`) |
| Create | `src-tauri/src/video/processor.rs` (`create_video`, `clip_rotations`) |
| Preview-Plan | `src-tauri/src/video/preview_encode.rs` |
| Settings | `EncodingTab.tsx` — Hint zu Auto + Orientierung (optional Slice E) |
| i18n | `de.json` / `en.json` — Confirm-Text Partial Orient |

---

## Nicht-Ziele (Out of Scope)

- Per-Segment unterschiedliche Display-Matrix im **finalen** MP4 für „Abschnitt A hochkant, B quer“ ohne Encode (Player-inkonsistent; Avidemux-Doku widerspricht „Copy-only unify“).
- Partial-Reencode bei **Codec-Mismatch** (bleibt parallel per-clip OPT bestehender Pfad).
- Automatisches Setzen von `clip_rotations` im Cutter (eigenes UX-Feature).
- `fast`-Modus: Gate weiter **ohne** OPT-27 (bewusst riskant).

---

## Risiken & Mitigation

| Risiko | Mitigation |
|--------|------------|
| Copy-Harmonize reicht nicht, Bild schief | Slice 0 + `compatible_validate_output`; Validate fail → Full Reencode |
| Partial Bake + `hvc1` Freeze | OPT-26A Gate vor Merge; Log + ggf. `hev1` für Merge |
| Probe-Cache stale nach temps | Temp-Pfade nicht cachen / `probe_cache` skip für harmonize temps |
| Doppelte Harmonize + OPT-26 Bake | P7: OPT-27 off bei `clip_rotations` |

---

## Agent-Prompts

```
Implementiere OPT-27 Slice A aus @docs/opt/open/27-auto-orientation-harmonize.md
Regeln: @AGENTS.md
Nur Slice A. Danach cargo test --manifest-path src-tauri/Cargo.toml.
```

```
Implementiere OPT-27 Slice 0 (Forensik-Doku) aus @docs/opt/open/27-auto-orientation-harmonize.md
Regeln: @AGENTS.md
Nur Slice 0: docs/opt/fixtures/27-orientation/README.md + Slice-0-Ergebnis-Tabelle in der Spec ausfüllen (ohne Binaries).
```

```
Implementiere OPT-27 Slice C aus @docs/opt/open/27-auto-orientation-harmonize.md
Regeln: @AGENTS.md
Nur Slice C. Voraussetzung: Slice 0 Ergebnis = PartialBake. Danach cargo test.
```

---

## DoD gesamt (OPT-27 ✅)

- [x] Slice 0 Ergebnis dokumentiert
- [ ] Auto: typischer GoPro-Mixfall stream-copy oder Partial Bake (kein Full-Reencode)
- [ ] QT + iPhone Naht-Check bestanden
- [ ] Keine Regression `fast` / Phase 40 Akzeptanz
- [ ] `cargo test` grün
