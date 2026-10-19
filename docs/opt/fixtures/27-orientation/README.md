# OPT-27 — Forensik-Checkliste (Orientierung / Auto-Concat)

**Keine Video-Binaries in Git.** Quellclips und Avidemux-Output lokal halten (z. B. unter `_local_probe/`, gitignored). Ergebnisse in [`docs/opt/open/27-auto-orientation-harmonize.md`](../../open/27-auto-orientation-harmonize.md) (Abschnitt **Slice 0 Ergebnis**).

Bundled FFmpeg (Windows): `src-tauri/resources/ffmpeg/win/ffmpeg.exe` — siehe [`resources/ffmpeg/README.md`](../../../../src-tauri/resources/ffmpeg/README.md).

---

## Material

| Artefakt | Zweck |
|----------|--------|
| Quellclips | N−1× quer, 1× hochkant (GoPro H.264/HEVC, gleiche Session wenn möglich) |
| Avidemux-Merge | Append + Save, Video **Copy**, Audio **Copy** (~2–3 s) |
| ATS (vor OPT-27) | `body_concat_mode=auto`, reiner Body-Concat, `clip_rotations` alle 0 |

---

## Pro Datei (Quelle + Avidemux-Output)

```bash
ffmpeg -hide_banner -i "DATEI.mp4" -f null -
```

Optional codierte Geometrie (ohne Autorotate — entspricht ATS-Prep):

```bash
ffmpeg -hide_banner -noautorotate -i "DATEI.mp4" -f null -
```

Strukturiert (wenn `ffprobe` verfügbar):

```bash
ffprobe -hide_banner -show_streams -show_format -i "DATEI.mp4"
```

### Tabelle (manuell ausfüllen)

| Feld | Clip 1 (Referenz) | Clip 2 … N | Ausreißer | Avidemux out |
|------|-------------------|------------|-----------|--------------|
| `codec_name` | | | | |
| codierte **W×H** (Stream-Header) | | | | |
| **Anzeige-W×H** | | | | |
| `pix_fmt` | | | | |
| `tag` / fourcc | | | | |
| Stream-`encoder` | | | | |
| Soft-Rotation (ATS) | | | | |

**Anzeige-W×H** (wie in OPT-27 Spec): bei bekannter Soft-Rotation `{0,90,180,270}` → `rotated_dims(W, H, deg)` aus `concat.rs` (90°/270° tauschen Breite/Höhe).

**Soft-Rotation (ATS)** entspricht `probe_video_rotation_degrees` auf derselben stderr wie `ffmpeg_probe_stderr` (`ffmpeg -hide_banner -i`, **ohne** `-noautorotate`):

- `Display Matrix: rotation of -90.00 degrees` → `Known(270)`
- `rotate : 90` (Metadaten) → `Known(90)` (wenn keine widersprüchliche Matrix)

---

## Zwei GoPro-Muster (Forensik)

| Muster | Codierte WxH | Soft-Rotation | ATS `NeedsReencode` (heute) | OPT-27 Plan |
|--------|--------------|---------------|-----------------------------|-------------|
| **A** (häufiger Kundenfall) | **identisch** (z. B. 1920×1080) | Ausreißer ±90°/270° vs Clip 1 = 0° | `compatible.orientation_mismatch:0:270:clip1:clipK` | **CopyHarmonize** |
| **B** (vertikaler Encode) | **abweichend** (1080×1920 vs 1920×1080) | oft 0° auf allen | `Compatible Path: unterschiedliche Auflösung (…)` | **PartialBake** (Ausreißer transcodieren) |

Muster A: Pixel-Buffer bleibt gleich orientiert; nur Display-Matrix/`rotate` weicht.  
Muster B: codierte Auflösung weicht ab; Anzeige-Geometrie kann trotzdem „hochkant“ wirken.

---

## Avidemux

- [ ] Video-Encoder = **Copy** (Info-Dialog / Log)
- [ ] Audio = **Copy**
- [ ] Dauer Import + Export (Stopuhr)
- [ ] Output in VLC + QuickTime + iPhone: Naht + Orientierung notieren

Avidemux kann pro Segment unterschiedliche Display-Metadaten im Copy-Mux belassen; ATS **Compatible/Auto** verlangt vor dem Merge **einheitliche** `CompatibleStreamKey`-Werte (Phase 40 Gate).

---

## ATS (vor OPT-27)

Relevante Log-/Confirm-Gründe:

| Grund | Auslöser im Code |
|-------|------------------|
| `compatible.orientation_mismatch:…` | `compatible_probe_gate_keys` — unterschiedliche Soft-Rotation bei sonst gleichem Key |
| `Compatible Path: unterschiedliche Auflösung (…)` | codierte `width`/`height` |
| `compatible.orientation_unknown:…` / `…_conflict:…` | unzuverlässige Rotation |
| `mixed encoders + hvc1` | OPT-26A (unverändert; kein OPT-27) |

Gate: `src-tauri/src/video/concat.rs` → `compatible_probe_gate_keys`.  
Probe-Keys: `compatible_stream_key_from_probe` in `probe.rs` (Rotation **vor** `-noautorotate`-Prep).

---

## Golden Probe (lokal, ohne Git-Binaries)

Entwickler können Muster A mit Stream-Copy nachstellen (FFmpeg 9, Windows, 2026-10-19):

```bash
# Ausreißer: gleiche codierte 1920×1080, Display Matrix −90°
ffmpeg -y -noautorotate -display_rotation 270 -i clip1_landscape.mp4 -map 0:v:0 -map 0:a? -c copy clip_outlier.mp4

# Harmonize → Ziel Clip 1 (rotation 0), Stream-Copy
ffmpeg -y -noautorotate -display_rotation 0 -i clip_outlier.mp4 -map 0:v:0 -map 0:a? -c copy \
  -metadata rotate=0 -metadata:s:v:0 rotate=0 clip_outlier_harmonized.mp4
```

Nach Harmonize: Re-Probe → `rotation=Known(0)`, gleiche codierte WxH wie Clip 1 → Gate **grün** (synthetisch verifiziert).

Copy-Concat (Avidemux-nah, **ohne** Key-Harmonisierung — kann Gate weiterhin scheitern lassen):

```bash
# list.txt: file 'clip1.mp4' / file 'clip2.mp4'
ffmpeg -y -f concat -safe 0 -i list.txt -c copy merged_copy.mp4
```

---

## Entscheidung

Ergebnis in Spec-Tabelle **Slice 0 Ergebnis** in [`27-auto-orientation-harmonize.md`](../../open/27-auto-orientation-harmonize.md) pflegen. Slice B/C nutzen exakt die dort dokumentierte **Referenz-FFmpeg-Remux**-Skizze.
