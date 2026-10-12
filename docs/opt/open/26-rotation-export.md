# OPT-26 — Video-Drehung: Freeze-Fix + Drehung erst beim Export

> **Agent-Attach:** Diese Datei (nicht `@docs/opt/ARCHIVE.md` / ganzen Plan).  
> Regeln: `@AGENTS.md` · Index: `@docs/optimization_plan.md`

**Status:** ✅ Slice A–E (Code; manuell iPhone/QuickTime offen) · ⬜ Slice F (ein Encode mit Intro/Outro)  
**Abhängigkeiten:** Phase 43.x (Compatible-Concat / TS-Prep), OPT-16 (Probe-Cache), Phase 49 (Forced-Codec)

**Ziel:**
1. **Bugfix (Slice A):** Vorgang mit gedrehtem Clip → Video friert nach dem ersten Clip ein (Ton läuft weiter).
2. **Optimierung (Slice B–D):** Drehen ist ein Bearbeitungswert, kein Datei-Re-Encode. Pixel-Rotation passiert einmal im Gesamt-Encode beim Erstellen.

**Impact:** hoch (Bug sichtbar beim Kunden; Drehen dauert heute ~1 min pro Clip)  
**Aufwand:** A: S · B–D: L  
**Risiko:** A: niedrig · B–D: mittel

> **Session-Regel:** Ein Slice pro Session. Slice A zuerst, separat abnehmen.

---

#### Ursache (Ist-Zustand)

Log-Beispiel (GoPro HEVC, erster Clip 180° gedreht):

```
Rotate fertig: GX012455.MP4 (method=rotate-180, overwrite=true)
auto: resolved HEVC tag=hvc1
compatible: ts-prep (mixed encoders: lavc63.1.102 libx265 | gopro h.265 encoder | …)
hvc1 ensure: output tag='hev1' — stream-copy retag
```

1. `video/rotate.rs` kodiert den Clip mit `libx265` / VideoToolbox neu → anderer Encoder als die Kamera-Clips.
2. `concat_stream_copy_compatible` erkennt `mixed_encoders` und merged via TS-Prep bewusst als `hev1` (`ts_prep_merge_hevc_tag`) — in-band VPS/SPS/PPS bleiben erhalten.
3. `maybe_ensure_output_hevc_hvc1_tag` retagt anschließend auf `hvc1`. Bei `hvc1` gelten nur die Parameter-Sets aus `hvcC` (= Clip 1). Kamera-Clips nach der Naht werden mit falschen Parametern dekodiert → Standbild.

Folge: Gemischte Encoder + Ziel `hvc1` ist per Stream-Copy **nicht** lösbar.

---

#### Produktentscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| P1 | Mixed Encoder + `hvc1` | `NeedsReencode` → bestehender Pfad `concat_videos_with_opts` (Re-Encode-Dialog im Export; spekulativ: empfohlenes Profil ohne Dialog) |
| P2 | Mixed Encoder + `hev1` | Unverändert (TS-Prep, `hev1` bleibt) |
| P3 | H.264 `avc1` | Erst manuell testen (gedrehter H.264-Clip zwischen Kamera-Clips). Nur bei Freeze in Slice A mit aufnehmen |
| P4 | Drehung (ab Slice B) | Pro Clip `rotation: 0 \| 90 \| 180 \| 270` als Edit-Wert; Datei bleibt unverändert |
| P5 | Preview | HTML5-Player + Thumbs per CSS `transform`; 90/270 tauschen Seitenverhältnis im Layout |
| P6 | Export, alle Clips gleich gedreht | Stream-Copy + Display-Rotation (`-display_rotation` vor `-i`), kein Encode |
| P7 | Export, gemischte Drehung | Ein Re-Encode-Pass mit `filter_complex` (`transpose` pro Clip + `concat`) |
| P8 | Slice A bleibt nach B–D | Mixed Encoder entstehen auch ohne Drehen (Cut-Re-Encode, Fremdkamera) |

---

#### Slices

| Slice | Titel | Inhalt |
|-------|-------|--------|
| **A** | Freeze-Fix | Reine Funktion `mixed_encoders_reencode_reason(vcodec, hevc_tag, mixed) -> Option<String>` in `video/concat.rs`; in `concat_stream_copy_compatible` nach `compatible_probe_gate_keys` → `ConcatError::NeedsReencode`. Log `compatible: mixed encoders + hvc1 → reencode`. Unit-Tests (HEVC+hvc1+mixed → Some; hev1 → None; gleiche Encoder → None; H.264 → None bis P3 entschieden) |
| **B** | Rotation als Edit-Wert | Datenmodell Frontend-Store + Export-Optionen (`rotation` pro Clip); `useVideoCutApply.ts` ruft kein `rotateVideo` mehr für Drehen, sondern setzt den Wert; Preview/Thumbs per CSS; Undo = Wert zurücksetzen |
| | *B umgesetzt* | `videoStore.rotations` (`setRotation` / `getRotation` / `getClipRotations`; wandert bei Split/Replace mit, fällt bei Undo/Entfernen weg). Cutter zeigt Basis-Drehung + Delta. Clip-Player via `previewRotateDeg`, Chips via `previewRotateThumbStyle`. Undo: reiner `rotate`-Mark → nur Wert zurück; Trim/Split-Mark → Backend-Undo + Wert zurück. `CreateVideoOptions.clip_rotations: Vec<i32>` + `clip_rotation(i)` (Rust, Test); gesendet von `createJob` + spekulativ (`coreKey`). Offen für D: Filmstrip im Cutter, Foto-Extraktion aus dem Cutter (Frames ungedreht), QR-Strip |
| **C** | Export mit Rotation | Neuer Args-Builder `build_concat_filter_complex_reencode_args` (Inputs × N, `[i:v]transpose=…[vi]`, `concat=n=N:v=1:a=1`, HW/SW-Encoder wie `concat_videos_reencode`); Weiche: keine Rotation → wie bisher · alle gleich → Stream-Copy + Display-Rotation · gemischt → filter_complex. Unit-Tests für Builder + Weiche (`transpose_filter_for_degrees` wiederverwenden) |
| | *C umgesetzt* | `concat.rs`: `body_rotation_route` (`None` / `Display(deg)` / `Bake`), `build_display_rotation_remux_args` (`-display_rotation` = CCW, vor `-i`, `-c copy`), `build_rotation_concat_filter` + `build_concat_filter_complex_reencode_args`, `concat_videos_rotated_reencode` (Confirm `Rotate`, HW→SW-Retry, H.264 → `yuv420p`, HEVC → `hvc1`; abweichende Ausrichtung → Letterbox auf Canvas von Clip 1). `processor::create_video`: `Display` nur ohne Intro/Outro/Ziel-Codec und ohne Quell-Soft-Rotation, sonst `Bake` (ein Encode für den Body; Intro/Outro kodieren danach wie bisher erneut). Preview-Reuse wird bei Drehung übersprungen (Fingerprint folgt in D). Probe erkennt FFmpeg-9-Format `Display Matrix: rotation of …` |
| **D** | Spekulativ + Konsumenten | Rotation in `speculative_create::build_body_fingerprint` (+ `preview_reuse` Fingerprint); QR-Analyse, Wasserzeichen, Trim/Cut, Medien-Viewer (Phase 48) prüfen; alter Datei-Rotate-Pfad (`video/rotate.rs`, `rotate_video` Command) entfernen oder nur intern behalten |
| | *D umgesetzt* | **Fingerprints:** `CreateVideoOptions::rotation_tag(n)` (`"90,0,180"`, leer wenn alles 0 → bestehende Fingerprints bleiben gleich) + `rotation_for_path`. `build_body_fingerprint` schreibt `rot:…`; `build_wm_video_fingerprint` (+ `build_wm_fingerprint`) bekommt `video_opts` und schreibt `wm_rot:…` nur für den WM-Clip. **Preview-Reuse (Entscheidung):** Preview rendert **ohne** Drehung (`clip_rotations: Vec::new()`, Tag `""`); `preview_encoding_tag(…, rotation_tag)` hängt `\|rot=…` an → gedrehter Export matcht nie die ungedrehte Preview, Reuse fällt sauber durch statt per Sonderfall. `any_rotation`-Notbehelf in `export_job.rs` entfernt. Grund: Preview mitdrehen hieße ein Encode-Pass pro Drehung im Preview (Display-Weg nur ohne Intro/Outro) — kein Gewinn, da der Export ohnehin genau einen Pass macht. **Konsumenten:** WM-Video (`build_watermark_video_args(…, rotation_deg)`: `transpose` vor `scale`, Export/Staging/Commit; Append-Job 0°). Foto-Extraktion im Cutter: `extract_video_frames` / `extract_video_frame_at` nehmen optional `rotation` → `-vf transpose` (JPEGs aufrecht; Foto-Strip zeigt sie damit korrekt). Filmstrip im Cutter + QR-Live-Strip: CSS via `previewRotateCoverStyles` (Container-Units `cqh × cqw` für 90/270). Unverändert: QR-Analyse (Decoder ist rotationsinvariant), Trim/Cut (Wert hängt am Pfad, Datei bleibt ungedreht), Medien-Viewer Phase 48 (zeigt exportierte Dateien — gebacken bzw. Display-Matrix, die der HTML5-Player respektiert). **Entfernt:** `rotate_video` Command, `video::rotate::rotate_video` / `build_rotate_video_args`, `rotateVideo` (`tauri.ts`), `hwEncodeError.ts`; `video/rotate.rs` behält nur `normalize_rotation_degrees` + `transpose_filter_for_degrees`. Tests: Body-FP ändert sich bei Drehung / gleich bei gleicher (normalisierter) Drehung; WM-FP nur bei Drehung des WM-Clips; Preview-Tag + Reuse-Mismatch; WM-/Frame-Args mit `transpose` |
| **E** | Rotation-Pass schneller | 180° als `hflip,vflip` statt `transpose=1,transpose=1`; HW-Decode vor CPU-Filtern im Rotations-Pass und im CapCut-Body |
| | *E umgesetzt* | `transpose_filter_for_degrees(180)` → `hflip,vflip` (wirkt auch auf WM-Video + Frame-Extraktion). `HwAccelInfo::hwaccel_for_cpu_filters` / `hwaccel_safe_with_cpu_filters`: nur **VideoToolbox** (ohne `-hwaccel_output_format` landen die Frames im RAM → `transpose`/`scale`/`pad`/`format` funktionieren). CUDA bleibt ausgeschlossen (ENOSYS auf Windows/NVIDIA, siehe OPT-21A / Phase 49 F-5). `concat_videos_rotated_reencode`: `-hwaccel videotoolbox` pro Input nur im HW-Versuch, SW-Retry ohne; Log `rotation: encoder=… hwaccel=…`. CapCut: `CapcutNormalizePlan::permits_hwaccel` — `capcut_hwaccel_for_decode` + beide Single-Pass-Builder behalten VideoToolbox auch bei scale/pad/fps/format. Manuell mit gebündeltem FFmpeg geprüft (HEVC+H.264, 10-bit HEVC → H.264 VT) |
| **F** | Ein Encode bei Drehung + Intro/Outro | Offen. Heute: Rotation → `body_concat.mp4` (Encode 1), danach CapCut Intro/Outro (Encode 2). Ziel: Clips direkt als N Body-Inputs in `build_intro_body_single_pass_args` / `build_intro_body_outro_single_pass_args` (pro Clip Drehung + Normalize, `concat`), ein Encode. Mitziehen: Rotate-Confirm, Canvas/Letterbox, Body-Probe (`v_params`, Dauer), Audio-Copy (`assemble_silent_plus_body_audio` erwartet eine Body-Datei → Audio neu kodieren oder Audio-only-Concat per Stream-Copy), Spekulativ-Reuse von `body_concat.mp4`. Erwartung: ~ein Body-Encode weniger (Log-Beispiel 449 s Body: ~50 s gespart) |

---

#### Relevante Stellen

| Bereich | Datei |
|---------|-------|
| Concat-Weiche / Retag | `src-tauri/src/video/concat.rs` (`concat_stream_copy_compatible`, `ts_prep_merge_hevc_tag`, `maybe_ensure_output_hevc_hvc1_tag`, `concat_videos_with_opts`, `concat_videos_reencode`) |
| Rotation-Helfer | `src-tauri/src/video/rotate.rs` (`normalize_rotation_degrees`, `transpose_filter_for_degrees`), `processor::CreateVideoOptions` (`clip_rotation`, `rotation_tag`, `rotation_for_path`) |
| Frontend Drehen | `src/hooks/useVideoCutApply.ts`, `src/store/videoStore.ts` (`rotations`), `src/lib/mediaPreviewRotate.ts` |
| Spekulativer Export | `src-tauri/src/video/speculative_create.rs` (`build_body_fingerprint`, `build_wm_video_fingerprint`) |
| Preview-Reuse | `src-tauri/src/video/preview_reuse.rs` (`preview_encoding_tag`) |
| WM-Video / Frames | `src-tauri/src/video/watermark.rs`, `src-tauri/src/media/frame_extract.rs` |

---

#### DoD

**Slice A**
- [ ] Erster Clip 180° gedreht → Vorgang erstellen → Bild läuft über alle Nähte (QuickTime + iPhone)
- [ ] Log zeigt `mixed encoders + hvc1 → reencode`, kein `hvc1 ensure: … retag` mehr
- [ ] Ohne Drehung: weiterhin `compatible: clean-pass` (kein Re-Encode)
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`

**Slice B–D**
- [ ] Drehen in der UI sofort (kein FFmpeg-Lauf)
- [ ] Preview + Thumbs zeigen gedrehten Clip; 90/270 Layout korrekt
- [ ] Alle Clips gleich gedreht → Export ohne Re-Encode, korrekte Ausrichtung auf iPhone/QuickTime
- [ ] Gemischt gedreht → genau ein Encode-Pass, alle Nähte mit Bild
- [x] Spekulativer Body wird nach Drehen nicht stale wiederverwendet (Fingerprint + Unit-Test)
- [ ] Unbezahltes WM-Video + aus dem Cutter extrahierte Fotos erscheinen gedreht
- [ ] `cargo test` + `npm run check` + `npm run tauri dev`
