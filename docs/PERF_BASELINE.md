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
