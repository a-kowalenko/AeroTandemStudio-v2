# OPT-21 — CapCut-Export: schnell + robust (Diagnose → GPU/RC → Encoder)

> **Agent-Attach:** Diese Datei (nicht `@docs/opt/ARCHIVE.md` / ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/optimization_plan.md`

**Status:** 🔄 Slice 0 ✅ · Slice A ✅ · Slices B–E ⬜  
**Abhängigkeiten:** Phase 49/50  
**Ziel:** Phone-sicherer CapCut-Export näher an App-Geschwindigkeit, ohne Robustheitsvertrag zu brechen.

> Eine Agent-Session = **nur ein Slice** (0, A, B, …). Kein Phase-23/31.5-Scope.

> Kontext: ATS „CapCut“ = phone-sicherer Single-Pass-Bitstream (`intro_mux_mode=capcut`);
> die CapCut-**App** ist trotzdem deutlich schneller. Ziel: denselben Robustheitsvertrag
> halten und die echten Bottlenecks schließen.

#### Ist-Zustand (verdächtige Gaps)

| # | Gap | ATS heute | CapCut / vergleichbare Apps |
|---|-----|-----------|------------------------------|
| G1 | Frame-Pfad | CPU-`filter_complex` (scale/pad/fps/format/concat), oft **ohne** `-hwaccel` | Decode→Compose→Encode in Device-Memory (MF / VT / GPU) |
| G2 | Rate Control | CRF/CQ ~18–20 + NVENC `-tune hq` | Bitrate-/Social-Stufen, oft LL/ull-ähnlich |
| G3 | Normalisierung | Blind Scale/Pad/FPS am Export | Früh (Import/Timeline) oder skip wenn Match |
| G4 | Durchläufe | Body-Concat/Staging + CapCut-Final | Ein Timeline-Render |
| G5 | Encoder-Abdeckung | nur NVENC + VideoToolbox → sonst libx264 | MF / QSV / AMF bleiben HW |
| G6 | Robustheit | HW→SW-Retry (schnell → **sehr** langsam) | Vendor-Pfad bleibt HW |
| G7 | Diagnose | FFmpeg-Fehler auf **8 stderr-Zeilen** gekürzt | volle Logs |

#### Leitentscheidungen

| # | Entscheidung |
|---|--------------|
| 1 | Phone-safe Vertrag bleibt: ein Bitstream, `avc1`/`hvc1`, 8-bit 420, closed GOP / Splice-Tags |
| 2 | Kein Stream-Copy-Splice als „schnell“-Ersatz (iPhone-Audio-only-Regression) |
| 3 | Speed-Wins nur mit Messpunkt (Slice 0 Logs) und A/B gegen Baseline |
| 4 | Ein OPT-Slice pro Session; Slice 0 ist Voraussetzung für 21A+ |
| 5 | Fehlerlogs: **kein Truncate** von FFmpeg-stderr in `app.log` / Ring / `FfmpegError` |

#### Slices

| Slice | Titel | Impact | Status |
|-------|-------|--------|--------|
| **0** | Instrumentation: CapCut/Encode-Logs + volle FFmpeg-Fehler | Diagnose | ✅ |
| **A** | Skip-redundant-Filters (kein scale/pad/fps wenn Match) + optionales `-hwaccel` wo sicher | hoch | ✅ |
| **B** | Fast RC-Profil für CapCut (p1/p2, ohne `tune hq`, CQ/Bitrate an Social) | hoch | ⬜ |
| **C** | Doppel-Encode vermeiden (Staging-Body → Final ohne zweite Vollencode wenn möglich) | hoch | ⬜ |
| **D** | Extra HW-Encoder (QSV / AMF / `h264_mf`) + Prefer-HW-Retry statt sofort SW | mittel | ⬜ |
| **E** | Export-Cap 1080p (optional Setting) wenn Source > 1080 | mittel | ⬜ |

#### Slice 0 — Logging (dieses Session-Deliverable)

**Dateien:** `video/ffmpeg.rs`, `video/processor.rs`, ggf. `app.log` / Log-Konsole

| Event | Level | Inhalt |
|-------|-------|--------|
| `capcut.start` | INFO | Variante (intro/outro/body), Encoder-Ziel, HW-Flag, CRF, WxH@fps, Dauer-s |
| `capcut.attempt` | INFO | Versuch `#`, `force_sw`, Encoder-Name |
| `capcut.ok` | INFO | Encoder, Elapsed-ms, Method-Tag |
| `capcut.fallback_sw` | WARN | vorheriger Fehler (Kurz+Verweis), Switch HW→SW |
| `capcut.fail` / `ffmpeg` | ERROR | **volles** FFmpeg-stderr (**kein** `take(8)`) |
| `encode.body` | INFO/ERROR | Forced-Codec / Remux-Fallback analog |

**Akzeptanz Slice 0**

- [x] FFmpeg-Exit: stderr vollständig in Log + `FfmpegError::Message`
- [x] CapCut Single-Pass (Intro / Outro) loggt start/attempt/ok/fallback
- [x] Forced-Body-Re-Encode loggt analog
- [x] Unit-Tests für Exit-Error-Formatter (kein Truncate)

#### Slice A — Filter / Decode

- [x] Conditional graph: wenn Body schon `W×H`, `fps`, `yuv420p` → keine scale/pad/fps
- [x] Wo Filter entfallen: `-hwaccel cuda|videotoolbox` + HW-Encode testen
- [x] Bei verbleibendem CPU-Filter: bewusst **kein** broken HW-Decode (ENOSYS-Vermeidung)
- [x] Tests: Graph-Builder mit Match vs. Mismatch

**Implementierung:** `capcut_normalize_plan` / `build_capcut_segment_vfilter` in `processor.rs`;
CapCut Single-Pass (Intro+Body / +Outro) skippt Body-Normalize bei Match; Log `capcut.filters`.

#### Slice B — Rate Control

- CapCut-Profil: NVENC `p1`/`p2`, **kein** `-tune hq`; CQ an CapCut-ähnlich oder `-b:v` Ladder
- SW: `veryfast`/`superfast` behalten; CRF nicht aggressiver als Settings-Default ohne UX-Hinweis
- A/B: gleiche Datei, Zeit + Dateigröße + iPhone-Play

#### Slice C — Ein Durchlauf

- Speculative/Compatible: wenn Final CapCut sowieso re-encodet → Body staging als Copy/leichtes Remux
- Kein zweites Forced-Codec nach CapCut (bereits Phase 49 — Regressionstests)

#### Slice D — Mehr HW + robust bleiben

- Detect `h264_qsv` / `h264_amf` / `h264_mf` (Windows)
- Retry-Kette: NVENC → QSV/AMF/MF → SW (nicht direkt SW)
- Logs aus Slice 0 müssen die Kette zeigen

#### Slice E — Auflösungs-Cap (optional)

- Setting „Export max. 1080p“ (Default off oder fleet-opt-in)
- CapCut-Graph scale nur dann

#### Nicht in OPT-21

| Thema | Wohin |
|-------|--------|
| Phone-safe Vertrag ändern / Soft-Splice | Feature-Phase / Regression |
| Preview-720p Fast Mode | separates Backlog (siehe §5) |
| Eigene GPU-Compositor-Engine (kein FFmpeg) | Architektur — out of scope |

#### Agent-Prompts

```
Implementiere OPT-21 Slice A aus @docs/opt/open/21-capcut-export.md
Regeln: @AGENTS.md
Nur OPT-21A. Danach cargo test.
```

```
Implementiere OPT-21 Slice B aus @docs/opt/open/21-capcut-export.md
Regeln: @AGENTS.md
Nur OPT-21B. Danach cargo test.
```

---
