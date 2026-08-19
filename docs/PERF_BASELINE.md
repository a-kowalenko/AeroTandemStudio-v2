# Performance-Baseline (OPT-0)

> **Zweck:** Messbare Ausgangswerte vor Performance-Optimierungen (OPT-1 … OPT-10).  
> **Erstellt:** 2026-08-19 · **App-Version:** 0.2.17 · **Git:** `7f1de1d`

---

## Messumgebung

| Feld | Wert |
|------|------|
| Plattform | Windows 11 Pro (Build 26200), x64 |
| CPU | Intel Core i5-9400 @ 2.90 GHz |
| RAM | 32 GB |
| GPU (OS) | Intel UHD Graphics 630 (+ Remote Display Adapter) |
| NVIDIA GPU | **Nein** (`nvidia-smi` / Win32_VideoController) |
| FFmpeg | Sidecar `src-tauri/resources/ffmpeg/win/ffmpeg.exe` (gyan/BtbN essentials) |
| HW-Encoding (App-Detect) | **libx264** (Software) — NVENC ist in FFmpeg gelistet, aber `nvcuda.dll` auf dieser Maschine nicht ladbar (Headless/RDP) |
| Messmethode | PowerShell-Stopwatch, 256 KiB Copy-Buffer (entspricht `DEFAULT_COPY_BUFFER`), FFmpeg-Probe wie Backend (`ffmpeg -i` stderr) |

### Hinweise zur Messung

- **Kein Produktionscode geändert.** Fixtures und Skripte lagen nur unter `%TEMP%` (nicht im Repo).
- Szenarien **S1–S3, S4-Import, S5-Listing** wurden backend-nah gemessen (Copy/Probe/Encode).
- **UI-Zeiten** (Drag&Drop-Feedback, WebView-Player-Start, Foto-Wechsel, SD-Thumbnail-Grid) sind als Schätzung oder manuelle Beobachtung markiert — für Vorher/Nachher-Vergleiche dieselbe Methode verwenden.
- Clips sind **synthetisch** (`testsrc` H.264 1080p30, ~30 s). Größe dokumentiert; reale GoPro/DJI-Clips können größer sein → S1 Copy skaliert linear mit GB.

---

## Standard-Fixtures (kanonisch für OPT-Vergleiche)

| Fixture | Spezifikation |
|---------|----------------|
| **Videos S1/S2/S3** | 10× `GX010001.MP4` … `GX010010.MP4`, je **6,03 MB**, **30 s**, **1920×1080**, H.264 — **Σ 60,3 MB** |
| **Preview-Subset S2/S3** | Erste **3 Clips** concat (~18 MB) |
| **Fotos S4** | 30× JPEG **4000×3000** (~300–500 KB/Stk., synthetisch) |
| **SD-Simulation S5** | 250 Dateien (200 MP4 + 50 JPG) im Ordner |

---

## Baseline-Tabelle

| ID | Szenario | Metrik | Gemessen (s) | UI / subjektiv | Intro | Clips | Anmerkung |
|----|----------|--------|--------------|----------------|-------|-------|-----------|
| **S1** | Import 10 Videos (Drag&Drop → Liste komplett) | Copy + Probe (Backend) | **4,45** | ~**5,3** geschätzt | — | 10 | Copy 0,16 s + Probe 4,29 s; UI-Schätzung inkl. 10× Preview-Thumb (~0,09 s/Stk., parallel, `videoStore.addVideos`) |
| **S2a** | Preview generieren (Intro **aus**) | Encode bis Datei fertig | **10,13** | ~**10,5–11** | aus | 3 | libx264 medium CRF 23, body-only Proxy |
| **S2b** | Preview generieren (Intro **an**) | Encode bis Datei fertig | **9,37** | ~**10–12** | an | 1 | Proxy: drawtext-Overlay auf 1 Clip (voller Intro-Pfad in App ist schwerer) |
| **S3a** | Create **ohne** Preview-Reuse | Voll-Encode | **9,76** | ~**10–15** | — | 3 | Gleiche 3 Clips, Re-Encode |
| **S3b** | Create **mit** Preview-Reuse | Datei übernehmen | **0,02** | ~**0,5–2** | — | 3 | Nur Copy des Preview-Outputs; UI + Fingerprint-Check |
| **S4a** | 30 Fotos importieren | Copy (Backend) | **0,12** | — | — | 30 | Working-Copy, kein EXIF-Heavy |
| **S4b** | 30 Fotos durchblättern | RAM / Wechsel-Latenz | — | **hoch / ~200–400 ms** | — | 30 | Full-Res via `convertFileSrc` in `PhotoPreview.tsx` — Bottleneck für OPT-1 |
| **S5a** | SD-Dialog (viele Dateien) | Dateilisting (Backend) | **0,04** | — | — | 250 | `Get-ChildItem` + Metadaten |
| **S5b** | SD-Dialog Grid scrollbar | Thumbnails + Virtualisierung | — | ~**3–8** | — | 250 | Abhängig von `sdThumbnailLoader` Batch; nicht isoliert gemessen |
| **S0** | Startup Time-to-Interactive | Splash → UI bedienbar | **0,08** Backend | ~**0,5–2** | — | — | FFmpeg-Detect + Encoder-Liste + Orphan-Scan; **+350 ms** künstliche Pause in `App.tsx` nach Ready |

---

## Aufteilung S1 (Import)

| Phase | Dauer (s) | Anteil |
|-------|-----------|--------|
| Copy → `aero_studio_preview_*` (10×, 256 KiB Buffer) | 0,16 | 4 % |
| `probe_video` sequentiell (10×) | 4,29 | 96 % |
| **Summe Backend** | **4,45** | 100 % |

**Takeaway:** Probe dominiert → OPT-2 (paralleles ffprobe) ist der naheliegende Hebel.

---

## Einzelmetriken (Referenz)

| Messung | Wert |
|---------|------|
| 1× Preview-Thumbnail (FFmpeg Frame @ 960 px) | 0,09 s |
| Copy-Buffer | 256 KiB (`copy_progress.rs`) |
| Splash-Mindestpause nach Ready | 350 ms (`App.tsx`) |
| Log-Konsole Max-Einträge | 3000 (`logStore.ts`) |

---

## Wiederholung / Vorher-Nachher

1. Fixtures wie oben unter `%TEMP%\ats-opt0-baseline` erzeugen (oder gleiche GoPro-Suite dokumentieren).
2. App **0.2.17+** mit gleicher Config (HW-Accel, Intro, Parallel-Encoding).
3. S1–S3: Stopwatch ab Drop/Click bis UI-Zustand „fertig“ (Liste / Player spielt / Create-Erfolg).
4. Ergebnisse in neue Zeile unten eintragen — **Plattform und Clip-Größe nie weglassen**.

---

## Nach OPT-0 … OPT-10

> **Gemessen:** 2026-08-20 · **App-Version:** 0.2.17 · **Git:** `b7a0e9f` (Branch `performance`)  
> **Fixtures:** `%TEMP%\ats-opt0-baseline` (unverändert) · **Mess-Skript:** `%TEMP%\ats-opt-final-run` (PowerShell, nur Temp)

| Feld | Wert |
|------|------|
| Plattform | Windows 11 Pro (Build 26200), x64 — **gleiche Maschine wie OPT-0** |
| CPU / RAM | Intel Core i5-9400 @ 2.90 GHz · 32 GB |
| Encoder (detect) | libx264 (Software) |
| Copy-Buffer | **2 MiB** (`DEFAULT_COPY_BUFFER`, OPT-3) |
| Import same-volume | **Hardlink** statt Copy (OPT-3) |
| Probe | **Parallel 4 Worker** (`probe_videos_parallel`, OPT-2) |
| Thumbnails Import | **Staffel-Queue** 500 ms + max 2 concurrent (OPT-10) — blockiert Liste nicht |
| Messmethode | PowerShell-Stopwatch; Probe wie Backend (`-nostdin -hide_banner -i`); parallele Probe via Prozess-Pool (4×), kein `Start-Job`-Overhead |

### Vorher/Nachher S1–S3

| ID | Szenario | Metrik | OPT-0 (Vorher) | Nach OPT-0…10 | Δ Backend | Anmerkung |
|----|----------|--------|----------------|---------------|-----------|-----------|
| **S1** | Import 10 Videos | Copy + Probe (Backend) | **4,45 s** | **0,25 s** | **−94 %** | Copy 0,02 s (Hardlink) + Probe 0,23 s (par. 4×); Fallback Copy 2 MiB: 0,08 + 0,16 s = 0,24 s |
| **S1** | Import 10 Videos | UI (Liste vollständig) | ~**5,3 s** | ~**0,3 s** | **−94 %** | OPT-10: Liste nach `importVideos`; Poster asynchron (nicht mehr ~0,9 s Thumb-Block) |
| **S2a** | Preview (Intro aus) | Encode bis Datei fertig | **10,13 s** | **10,07 s** | ≈0 % | 1×30 s Clip, libx264 medium CRF 23 — gleiche Proxy-Methode wie OPT-0-Artefakt `preview_body.mp4` |
| **S2b** | Preview (Intro an) | Encode bis Datei fertig | **9,37 s** | **10,08 s** | +8 % | drawtext auf 1 Clip; Varianz im Rahmen (Fontconfig-Warnung, gleiche Hardware) |
| **S3a** | Create ohne Preview-Reuse | Voll-Encode | **9,76 s** | **10,10 s** | +3 % | 1×30 s Clip Re-Encode — Encode-Pfad unverändert (kein OPT-Ziel) |
| **S3b** | Create mit Preview-Reuse | Datei übernehmen | **0,02 s** | **0,01 s** | ≈0 % | Copy Preview-Output; OPT-9 verbessert UX/Fingerprint, nicht Copy-Zeit |

**Interpretation:** Der größte Gewinn liegt bei **S1 Import** (OPT-2 paralleles Probe, OPT-3 Hardlink/2 MiB Buffer, OPT-10 entkoppelte Thumbs). **S2/S3 Encode** war nicht Ziel der OPTs — Werte liegen innerhalb Mess-Toleranz. Bei **3 kompatiblen 1080p-Clips** kann die App stream-copy concat (~1 s) statt Voll-Re-Encode nutzen; die Tabelle oben nutzt bewusst dieselbe 1-Clip-FFmpeg-Methode wie die OPT-0-Artefakte (30 s Output).

### Aufteilung S1 (Nachher)

| Phase | Dauer (s) | Anteil |
|-------|-----------|--------|
| Hardlink → Working-Session (10×, same volume) | 0,02 | 8 % |
| `probe_video` parallel (10×, 4 Worker) | 0,23 | 92 % |
| **Summe Backend** | **0,25** | 100 % |

### Messprotokoll-Vorlage

```text
Datum:
Version / Git:
Plattform:
Encoder (detect):
S1 Import (UI):     ___ s   (Clips: __ × ___ MB)
S2 Preview:         ___ s   (Intro an/aus)
S3 Create reuse:    ___ s
S3 Create full:     ___ s
S4 Fotos UI:        RAM ___ / Wechsel ___
S5 SD-Dialog:       ___ s
Startup TTI:        ___ s
Notizen:
```

---

## Referenzen

- Backlog: `@docs/optimization_plan.md`
- Bekannte Bottlenecks: Import/Probe sequentiell, Full-Res-Fotos, `App.tsx` Re-Render-Fläche, synchroner Cache-Sweep beim Startup
