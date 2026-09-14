# Phase 49 — Forced-Codec Export (Ziel-Codec, phone-safe)

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ✅ Erledigt (Kern) · ⬜ Follow-ups offen
**Abhängigkeiten:** Create-Pipeline (`video/processor.rs`), `encode_profile.rs`, `encoding_quality.rs`
**Ziel:** Die Einstellung **Video-Codec** (Auto / H.264 / H.265) ist ein echter Vertrag: der exportierte
Codec ist der eingestellte. Stream-Copy nur, wenn die Quelle bereits passt; sonst Neu-Encode auf den
Ziel-Codec — in iPhone-/QuickTime-tauglichem Format.

> Eine Agent-Session = nur Phase 49. Kein Preview-Refactor, keine VP9/AV1-Verdrahtung.

---

## Leitentscheidungen

| # | Entscheidung |
|---|--------------|
| 1 | **Auto** = Quellcodec behalten → Stream-Copy wenn möglich (nie erzwungener Re-Encode) |
| 2 | **H.264 / H.265 explizit** = Output ist dieser Codec; Copy nur bei Quell-Match |
| 3 | **CapCut/Intro-Pfad** respektiert explizites H.265 (`hvc1`); Auto/H.264 bleibt H.264 (universal) |
| 4 | **H.264-Ziel** immer `yuv420p` (8-bit) → auch aus 10-bit-HEVC-Quellen iOS-tauglich |
| 5 | **Audio** wird bei bereits AAC stream-kopiert, sonst nach AAC 192k transkodiert |
| 6 | VP9/AV1 bleiben No-Op (Frontend sendet nur h264/h265/auto) — separater Backlog |

---

## Technik (implementiert)

| Schicht | Änderung |
|---------|----------|
| Rust `processor.rs` | `body_needs_forced_reencode(pref, body_codec)` — Entscheidung Copy vs. Encode |
| Rust `processor.rs` | `force_codec` routet Body in Temp-Datei, damit Export-Schritt greift |
| Rust `processor.rs` | `export_body_to_output(force_reencode)` + `encode_body_to_output` (geteilt mit Remux-Fallback) |
| Rust `processor.rs` | `build_body_reencode_output_tail` / `build_body_reencode_mid_args` — pix_fmt nur bei Bedarf; explizites `-vf format=yuv420p` |
| Rust `processor.rs` | `encode_body_to_output`: HW→SW-Retry (wie CapCut) bei NVENC/Filter-Fail |
| Rust `processor.rs` | CapCut-Zweig: Ziel-Codec aus `options.video_codec` (H.265 → HEVC/hvc1) |
| Rust `encode_profile.rs` | `capcut_export(hw, crf, target_codec)` — H.264 default, H.265 explizit |
| Frontend `progressPercentReset.ts` | `Kodiere neu:` als Reset-Label → Fortschritt folgt Live-FFmpeg 0→100 |

### Fortschritt-Fix
Der Gesamt-Balken ist monoton; der Encode-Schritt startet bei 0 % und wird über das Reset-Label
`Kodiere neu:` von der Live-FFmpeg-Prozentzahl getrieben (vorher: Start bei 50 %, Stall bis Encode > 50 %).

---

## Verhalten (Matrix)

| Einstellung | Quelle | Aktion |
|-------------|--------|--------|
| Auto | beliebig copy-fähig | Stream-Copy |
| H.264 | H.264 | Stream-Copy |
| H.264 | H.265 / 10-bit / andere | Encode → H.264 (`avc1`, `yuv420p`) |
| H.265 | H.265 | Stream-Copy |
| H.265 | H.264 / andere | Encode → H.265 (`hvc1`) |
| + Intro (CapCut) | — | Ein durchgehender Bitstream; H.265 nur bei explizitem H.265, sonst H.264 |

---

## Tests

- `body_needs_forced_reencode` (Auto nie, Match nie, Mismatch immer, exotisch → Ziel)
- `h264_needs_yuv420_convert` / `build_body_reencode_mid_args` (nur bei Nicht-8-bit; `-vf` vor `-c:v`)
- `build_body_reencode_output_tail` (AAC-Copy vs. Transcode)
- `capcut_export_*` (H.264/Auto → h264; H.265 → h265)
- Frontend `shouldResetOverallProgressPercent("Kodiere neu: …")`

---

## Follow-ups

- **F-5** Forced-Body-Re-Encode: HW→SW-Fallback + robustes Pixelformat — ✅
  - Symptom: `vf#0:0 Function not implemented` → `h264_nvenc Could not open encoder before EOF`
    (HW an; CapCut hatte Retry, Forced-Pfad nicht).
  - Fix A: In `encode_body_to_output` Retry wie CapCut (`force_sw: false` dann `true`).
  - Fix B: `yuv420p` nur wenn Quelle nicht schon 8-bit 420; dann explizites `-vf format=yuv420p`
    (+ `-pix_fmt yuv420p`) statt blindem Auto-Filter.
- **F-6** Intro/CapCut-Progress: kein vorzeitiges 100 % — ✅
  - Symptom: Export-Schritt springt sofort auf 100 % und bleibt dort (oft mit NVENC / kurzer Dauer-Probe).
  - Live-Ticks (`continue`) max. 99 % bis FFmpeg `end`; Dauer-Denominator +5 % Headroom;
    HW→SW-Retry setzt den Balken erneut per `emit_step_start` zurück.
- **F-1** Gemeinsamer „phone-safe" Encode-Builder für CapCut + Forced-Body (H.264/H.265) — beseitigt
  die aktuelle Asymmetrie (HEVC bekommt Splice-Params über `build_software_quality_params`, H.264 nicht).
- **F-2** VP9/AV1 in `EncodingTab` als „nicht unterstützt" kennzeichnen **oder** echt verdrahten
  (Frontend + `VideoCodecPreference`).
- **F-3** UI-Checkbox „Passende Clips neu encodieren" (`reencode_matching_clips`) wieder einblenden;
  im Create-Pfad berücksichtigen (aktuell nur Preview).
- **F-4** Standalone-Body (kein Intro): B-Frames für HEVC erlauben (kein `bframes=0` ohne Splice) → bessere Kompression.
