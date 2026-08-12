# Aero Tandem Studio v2 — Implementierungsplan

> **Zweck:** Dieses Dokument ist der zentrale Leitfaden für die Neuentwicklung.
> In jedem neuen Cursor-/Agent-Kontextfenster mit `@docs/IMPLEMENTATION_PLAN.md` referenzieren.
> Pro Session **nur eine Phase** implementieren.

---

## Inhaltsverzeichnis

1. [Projektübersicht](#1-projektübersicht)
2. [Aktueller Stand](#2-aktueller-stand)
3. [Tech-Stack](#3-tech-stack)
4. [Entwicklungsumgebung](#4-entwicklungsumgebung)
5. [Legacy-Referenz](#5-legacy-referenz)
6. [Vollständiges Datei-Mapping](#6-vollständiges-datei-mapping)
7. [Architektur](#7-architektur)
8. [Phasenplan](#8-phasenplan)
9. [Config-Schema](#9-config-schema)
10. [Assets & Ressourcen](#10-assets--ressourcen)
11. [Teststrategie](#11-teststrategie)
12. [Build & Deployment](#12-build--deployment)
13. [Fortschritts-Tracker](#13-fortschritts-tracker)

---

## 1. Projektübersicht

**Aero Tandem Studio** ist eine Desktop-App zur automatisierten Erstellung von Tandem-Fallschirmsprung-Videos:

- Intro mit Kunden- und Springer-Daten
- Video-Import (Drag & Drop, SD-Karten)
- QR-Code-Erkennung für Kundendaten
- Video-Schneiden, Vorschau, Encoding (1080p/4K)
- SMB-Upload, Auto-Update
- Windows + macOS + Linux (Phase 15)

### Projektpfade

| | Pfad |
|---|------|
| **Neues Projekt (v2)** | `C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio-v2` |
| **Legacy (NUR LESEN)** | `C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio` |

---

## 2. Aktueller Stand

| Item | Status |
|------|--------|
| Tauri 2 Scaffold (React + TypeScript) | ✅ Erledigt |
| `npm run tauri dev` startet | ✅ Erledigt |
| FFmpeg Sidecar | ✅ Erledigt (Win + Mac + Linux) |
| Rust Video-Module | ✅ Phase 0–13 + 15 |
| AGENTS.md | ✅ Vorhanden |
| Implementierungsplan | ✅ Dieses Dokument |
| CI (Win + Mac + Linux) | ✅ `.github/workflows/release.yml` |
| Linux Build | ✅ Phase 15 (`docs/LINUX_BUILD.md`) |

**Nächste Phase:** optional [Phase 14 — ML Foto-Klassifikation](#phase-14--ml-foto-klassifikation-optional-später) (Backlog)  
*(Phase 15–19: Linux, Setup-Wizard, QR-Spotlight, Standard-Medienordner, Operator-Identität)*

---

## 3. Tech-Stack

| Schicht | Technologie | Hinweis |
|---------|-------------|---------|
| Desktop-Shell | Tauri 2 | Win + Mac + Linux |
| Backend | Rust | `src-tauri/src/` |
| Frontend | React 19 + TypeScript | `src/` |
| Styling (ab Phase 5) | Tailwind CSS + shadcn/ui | Schrittweise einführen |
| State (ab Phase 5) | Zustand | Globaler App-State |
| Video-Engine | FFmpeg CLI (Sidecar) | **Kein MoviePy** |
| Player (ab Phase 9) | libmpv | Ersetzt python-vlc |
| QR (ab Phase 6) | `rxing` oder `zbar` (Rust) | Kein pyzbar |
| Storage (ab Phase 5) | SQLite (`rusqlite`) | Config + Media-History |
| SMB (ab Phase 10) | `smb2` crate | Cross-platform |
| ML (später) | ONNX Runtime | Training separat in Python |

### Agent-Regeln (immer gültig)

- **NIEMALS** Dateien im Legacy-Projekt ändern
- Video-Verarbeitung **NUR** über FFmpeg CLI in Rust
- Hardware-Encoding: **NVENC** (Windows + Linux), **VideoToolbox** (macOS), Fallback **libx264** (VAAPI optional später)
- FFmpeg-Command-Generierung braucht **Rust Unit-Tests**
- Nach jeder Phase: `cargo test` + `npm run check` + `npm run tauri dev`
- **Eine Phase pro Agent-Session**

---

## 4. Entwicklungsumgebung

### IDE

- **RustRover** (oder IntelliJ Ultimate) — Hauptprojekt: `AeroTandemStudio-v2`
- Legacy-Projekt **nicht attachieren** — stattdessen Pfade aus [Abschnitt 5](#5-legacy-referenz) im Prompt verwenden
- **Cursor Agent** via ACP in JetBrains AI Chat

### Befehle

```powershell
cd C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio-v2

npm install                  # Frontend-Dependencies
npm run tauri dev            # Dev-Modus (React + Rust)
cargo test                   # Rust-Tests (in src-tauri/)
npm run check                # TypeScript-Check (wenn konfiguriert)
npm run tauri build          # Production-Build
```

### FFmpeg Sidecar

```
src-tauri/resources/ffmpeg/
  win/ffmpeg.exe
  mac/ffmpeg                 # später auf Mac
```

Download Windows: https://www.gyan.dev/ffmpeg/builds/ → „release essentials"

---

## 5. Legacy-Referenz

### Basis-Pfad

```
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio
```

### Wichtigste Dateien (Copy-Paste für Agent-Prompts)

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\hardware_acceleration.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\processor.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\concat_utils.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\parallel_processor.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\qr_analyser.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\cutter_service.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\sd_card_monitor.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\config.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\file_utils.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\model\kunde.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\components\sd_file_selector_dialog.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\components\drag_drop.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\constants.py
```

### Was NICHT aus Legacy kopieren

- `trainingsdata/` — ML-Daten, separates Repo
- `dependency_installer/` — FFmpeg/VLC werden neu gebundelt
- `build/`, `dist/`, `venv/`, `__pycache__/`
- `*_old_backup.py` — nur bei Bedarf als Referenz lesen

---

## 6. Vollständiges Datei-Mapping

### Video & Encoding (Rust — Priorität HOCH)

| Legacy | Neu | Phase |
|--------|-----|-------|
| `src/video/processor.py` | `src-tauri/src/video/processor.rs` | 3, 4 |
| `src/video/concat_utils.py` | `src-tauri/src/video/concat.rs` | 1 |
| `src/utils/hardware_acceleration.py` | `src-tauri/src/video/hw_accel.rs` | 0 |
| `src/video/parallel_processor.py` | `src-tauri/src/video/parallel.rs` | 4 |
| `src/video/logger.py` | `src-tauri/src/video/progress.rs` | 0 |
| `src/video/cutter_service.py` | `src-tauri/src/video/cutter.rs` | 9 |
| `src/utils/encoding_quality.py` | `src-tauri/src/video/encoding_quality.rs` | 3 |
| `src/utils/preview_encode_target.py` | `src-tauri/src/video/preview_encode.rs` | 8 |

### QR & Medien (Rust)

| Legacy | Neu | Phase |
|--------|-----|-------|
| `src/video/qr_analyser.py` | `src-tauri/src/qr/analyser.rs` | 6 |
| `src/video/qr_parallel_allocator.py` | `src-tauri/src/qr/parallel.rs` | 6 |
| `src/utils/media_datetime.py` | `src-tauri/src/media/datetime.rs` | 7 |
| `src/utils/dji_media_paths.py` | `src-tauri/src/media/dji_paths.rs` | 7 |
| `src/utils/photo_thumbnail.py` | `src-tauri/src/media/thumbnail.rs` | 7 |
| `src/utils/natural_sort.py` | `src-tauri/src/util/natural_sort.rs` | 2 |

### SD-Karten & Storage (Rust)

| Legacy | Neu | Phase |
|--------|-----|-------|
| `src/utils/sd_card_monitor.py` | `src-tauri/src/sd_card/monitor.rs` | 7 |
| `src/utils/media_history.py` | `src-tauri/src/storage/media_history.rs` | 7 |
| `src/utils/config.py` | `src-tauri/src/storage/config.rs` | 5 |
| `src/utils/cache_cleanup.py` | `src-tauri/src/storage/cache.rs` | 11 |
| `src/utils/file_times.py` | `src-tauri/src/util/file_times.rs` | 7 |

### Netzwerk & Installer (Rust)

| Legacy | Neu | Phase |
|--------|-----|-------|
| `src/utils/file_utils.py` (SMB-Teil) | `src-tauri/src/smb/client.rs` | 10 |
| `src/installer/updater.py` | Tauri Updater Plugin | 10 |
| `src/installer/ffmpeg_installer.py` | Sidecar in `resources/` | 0 |

### Domain-Modelle (Rust)

| Legacy | Neu | Phase |
|--------|-----|-------|
| `src/model/kunde.py` | `src-tauri/src/model/kunde.rs` | 5 |
| `src/utils/validation.py` | `src-tauri/src/model/validation.rs` | 5 |
| `src/utils/constants.py` | `src-tauri/src/constants.rs` | 3 |

### GUI (React + TypeScript)

| Legacy | Neu | Phase |
|--------|-----|-------|
| `src/gui/app.py` | `src/App.tsx` + Layout | 5, 11 |
| `src/gui/components/drag_drop.py` | `src/components/VideoDropZone.tsx` | 2 |
| `src/gui/components/form_fields.py` | `src/components/CustomerForm.tsx` | 5 |
| `src/gui/components/video_preview.py` | `src/components/VideoPreview.tsx` | 8 |
| `src/gui/components/video_player.py` | `src/components/VideoPlayer.tsx` | 9 |
| `src/gui/components/video_cutter.py` | `src/components/VideoCutter.tsx` | 9 |
| `src/gui/components/sd_file_selector_dialog.py` | `src/components/SdFileSelector.tsx` | 7 |
| `src/gui/components/sd_status_indicator.py` | `src/components/SdStatusIndicator.tsx` | 7 |
| `src/gui/components/sd_mode_selector.py` | `src/components/SdModeSelector.tsx` | 7 |
| `src/gui/components/settings_dialog.py` | `src/components/SettingsDialog.tsx` | 5 |
| `src/gui/components/progress_indicator.py` | `src/components/ProgressIndicator.tsx` | 0 |
| `src/gui/components/error_dialog.py` | `src/components/ErrorDialog.tsx` | 5 |
| `src/gui/components/success_dialog.py` | `src/components/SuccessDialog.tsx` | 5 |
| `src/gui/components/warning_dialog.py` | `src/components/WarningDialog.tsx` | 5 |
| `src/gui/components/loading_window.py` | `src/components/LoadingOverlay.tsx` | 5 |
| `src/gui/components/circular_spinner.py` | `src/components/Spinner.tsx` | 5 |
| `src/gui/components/photo_preview.py` | `src/components/PhotoPreview.tsx` | 8 |
| `src/gui/components/processed_files_dialog.py` | `src/components/ProcessedFilesDialog.tsx` | 7 |
| `src/gui/splash_screen.py` | `src/components/SplashScreen.tsx` | 11 |
| `src/gui/pending_video_cut.py` | `src/hooks/usePendingVideoCuts.ts` | 9 |

### Nicht portieren (verworfen / Backup)

| Legacy | Grund |
|--------|-------|
| `src/video/processor_old_backup.py` | Backup — nur bei Bedarf lesen |
| `src/gui/components/video_preview_old_backup.py` | Backup — nur bei Bedarf lesen |

---

## 7. Architektur

```
┌─────────────────────────────────────────────────────────┐
│  React Frontend (src/)                                   │
│  App.tsx, Components, Zustand Store, Tauri IPC          │
└────────────────────────┬────────────────────────────────┘
                         │ invoke() / Events
┌────────────────────────▼────────────────────────────────┐
│  Tauri Commands (src-tauri/src/lib.rs, commands/)       │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Rust Core                                               │
│  video/   qr/   sd_card/   storage/   smb/   model/     │
└────────────────────────┬────────────────────────────────┘
                         │ subprocess
┌────────────────────────▼────────────────────────────────┐
│  FFmpeg Sidecar (resources/ffmpeg/)                      │
│  optional: libmpv (Phase 9)                              │
└─────────────────────────────────────────────────────────┘
```

### Geplante Rust-Modulstruktur

```
src-tauri/src/
  lib.rs
  constants.rs
  commands/
    mod.rs
    video.rs
    config.rs
    sd_card.rs
    qr.rs
  video/
    mod.rs
    ffmpeg.rs       # Binary finden, Prozess starten
    hw_accel.rs     # Encoder-Erkennung
    concat.rs       # Concat/Trim/Remux
    processor.rs    # Intro-Pipeline
    parallel.rs     # Paralleles Encoding
    cutter.rs       # Schneiden/Teilen
    progress.rs     # stderr → Events
  qr/
    mod.rs
    analyser.rs
  sd_card/
    mod.rs
    monitor.rs
  storage/
    mod.rs
    config.rs
    media_history.rs
  smb/
    mod.rs
    client.rs
  model/
    mod.rs
    kunde.rs
    validation.rs
  media/
    mod.rs
    thumbnail.rs
    datetime.rs
    dji_paths.rs
  util/
    mod.rs
    natural_sort.rs
    file_times.rs
```

### Geplante React-Struktur

```
src/
  App.tsx
  main.tsx
  components/
    VideoDropZone.tsx
    CustomerForm.tsx
    VideoPreview.tsx
    VideoPlayer.tsx
    VideoCutter.tsx
    SdFileSelector.tsx
    SdStatusIndicator.tsx
    SettingsDialog.tsx
    ProgressIndicator.tsx
    ErrorDialog.tsx
    ...
  hooks/
    useTauriEvent.ts
    useVideoList.ts
    useConfig.ts
  store/
    appStore.ts          # Zustand
  lib/
    tauri.ts             # Typed invoke wrappers
```

---

## 8. Phasenplan

> **Anleitung:** Kopiere den Prompt der jeweiligen Phase in ein neues Agent-Fenster.
> Hänge `@docs/IMPLEMENTATION_PLAN.md` und die genannten Legacy-Dateien an.

---

### Phase 0 — FFmpeg-Grundgerüst

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Keine  
**Ziel:** Erster funktionierender Video-Transcode

#### Aufgaben

**Rust:**
- [x] `src-tauri/src/video/mod.rs`, `ffmpeg.rs`, `hw_accel.rs`, `progress.rs`
- [x] FFmpeg-Binary unter `resources/ffmpeg/win/ffmpeg.exe` finden
- [x] Hardware-Encoder erkennen (NVENC / VideoToolbox / libx264)
- [x] Tauri-Command `encode_video(input, output)` → 1080p, 30fps
- [x] Progress-Events via Tauri (`encode-progress`)
- [x] Abbruch via `CancellationToken` / Kill FFmpeg-Prozess
- [x] Unit-Tests für Command-Generierung

**React:**
- [x] Minimale Test-UI: Datei wählen, Encode-Button, Fortschrittsbalken

**Config:**
- [x] `tauri.conf.json`: `resources/` bundeln

#### Erfolgskriterien

- [x] Test-MP4 wird auf 1080p@30fps transcodiert
- [x] Fortschritt wird live angezeigt
- [x] `cargo test` grün
- [x] `npm run tauri dev` startet

#### Agent-Prompt

```
Phase 0 implementieren.

Kontext: @docs/IMPLEMENTATION_PLAN.md @AGENTS.md
Legacy: @C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\hardware_acceleration.py

Aufgaben laut IMPLEMENTATION_PLAN Phase 0.
Nur Phase 0 — kein Intro, kein SD, kein QR.
Danach: cargo test && npm run tauri dev ausführen und Ergebnis melden.
```

---

### Phase 1 — Concat & Trim

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 0  
**Ziel:** Mehrere MP4s zusammenfügen, Trim an Keyframes

#### Aufgaben

- [x] `src-tauri/src/video/concat.rs` — Port von `concat_utils.py`
- [x] Stream-Copy wo möglich, Re-Encode wo nötig
- [x] HEVC/H.264 Splice-Logik
- [x] Tauri-Command `concat_videos(paths, output)`
- [x] Tauri-Command `trim_video(input, start, end, output)`
- [x] Unit-Tests für alle Command-Varianten

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\concat_utils.py
```

#### Agent-Prompt

```
Phase 1 implementieren. @docs/IMPLEMENTATION_PLAN.md
Legacy: @C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\concat_utils.py
Portiere Concat/Trim-Logik nach src-tauri/src/video/concat.rs.
Unit-Tests für Command-Generierung. Nur Phase 1.
```

---

### Phase 2 — Video-Liste & Drag & Drop (UI)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 0  
**Ziel:** Videos per Drag & Drop importieren und verwalten

#### Aufgaben

**Rust:**
- [x] `util/natural_sort.rs`
- [x] Tauri-Command `probe_video(path)` → Metadaten (Dauer, Auflösung, Codec)
- [x] Tauri-Command `import_videos(paths)` → sortierte Liste

**React:**
- [x] `VideoDropZone.tsx` — Drag & Drop (@dnd-kit oder native)
- [x] Video-Liste mit Metadaten, Entfernen, Sortierung
- [x] Zustand Store: `videoList`

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\components\drag_drop.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\natural_sort.py
```

---

### Phase 3 — Intro-Pipeline & Encoding

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 0, 1  
**Ziel:** Intro mit Kundendaten + Body-Videos → finales MP4

#### Aufgaben

- [x] `video/processor.rs` — Port der Intro-Logik aus `processor.py`
- [x] `constants.rs` — Content-Area, Hintergrund-Dimensionen (aus `constants.py`)
- [x] Hintergrund-PNG + Text-Overlay via FFmpeg
- [x] `encoding_quality.rs` — CRF, Codec-Auswahl (h264/h265/auto)
- [x] Tauri-Command `create_video(kunde, video_paths, output)`
- [x] Assets kopieren: `assets/hintergrund.png`, `assets/logo.png`

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\processor.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\constants.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\encoding_quality.py
```

---

### Phase 4 — Paralleles Encoding & Fortschritt

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 3  
**Ziel:** Mehrere Clips parallel encodieren, Gesamtfortschritt

#### Aufgaben

- [x] `video/parallel.rs` — ThreadPool, Worker-Limit (wie `parallel_processor.py`)
- [x] Multi-Task-Fortschritt: Events mit `task_id` + `percent`
- [x] Abbruch aller laufenden FFmpeg-Prozesse
- [x] React: Multi-Bar Fortschrittsanzeige

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\parallel_processor.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\logger.py
```

---

### Phase 5 — Config, Kundenmodell & Basis-UI

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 2  
**Ziel:** Einstellungen speichern, Kundenformular, Dialog-System

#### Aufgaben

**Rust:**
- [x] `storage/config.rs` — SQLite, Migration von config.json Schema
- [x] `model/kunde.rs` + `model/validation.rs`
- [x] Tauri-Commands: `get_config`, `save_config`, `validate_kunde`

**React:**
- [x] Tailwind + shadcn/ui einrichten
- [x] `CustomerForm.tsx` — alle Kunde-Felder
- [x] `SettingsDialog.tsx` — Einstellungen
- [x] `ErrorDialog.tsx`, `SuccessDialog.tsx`, `WarningDialog.tsx`
- [x] `LoadingOverlay.tsx`, `Spinner.tsx`
- [x] Zustand Store: `configStore`, `kundeStore`
- [x] App-Layout (Header, Sidebar, Main)

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\config.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\model\kunde.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\components\form_fields.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\components\settings_dialog.py
```

---

### Phase 6 — QR-Code-Erkennung

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 2, 5  
**Ziel:** QR aus Video/Fotos scannen → Kundendaten auto-ausfüllen

#### Aufgaben

- [x] `qr/analyser.rs` — Frame-Extraktion (FFmpeg) + Decode (rxing/zbar)
- [x] `qr/parallel.rs` — paralleles Scannen mehrerer Clips
- [x] JSON-Parsing → `Kunde` struct
- [x] Tauri-Command `scan_qr_video(path)` / `scan_qr_photo(path)`
- [x] React: QR-Scan-Button, Auto-Fill Formular

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\qr_analyser.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\qr_parallel_allocator.py
```

---

### Phase 7 — SD-Karten Monitor & Dateiauswahl

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 2, 5  
**Ziel:** SD-Karten erkennen, Backup, Dateiauswahl-Dialog

#### Aufgaben

**Rust:**
- [x] `sd_card/monitor.rs` — Laufwerkserkennung (Windows WMI / macOS Disk Arrival)
- [x] DCIM-Erkennung, Backup-Koordination
- [x] `storage/media_history.rs` — Hash-basierte Duplikat-Erkennung
- [x] `media/thumbnail.rs`, `media/dji_paths.rs`, `media/datetime.rs`
- [x] Tauri-Commands: `list_sd_files`, `backup_sd_card`, `import_sd_files`
- [x] Events: `sd-card-inserted`, `sd-card-removed`

**React:**
- [x] `SdFileSelector.tsx` — Kachel + Detail-Ansicht, Thumbnails, Filter, Drag-Selection
- [x] `SdStatusIndicator.tsx`, `SdModeSelector.tsx`
- [x] `ProcessedFilesDialog.tsx`

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\sd_card_monitor.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\components\sd_file_selector_dialog.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\media_history.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\dji_media_paths.py
```

---

### Phase 8 — Video-Vorschau

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 1, 3, 5  
**Ziel:** Kombinierte Vorschau vor dem Export

#### Aufgaben

- [x] Temporäres Arbeitsverzeichnis für Preview-Encode
- [x] `video/preview_encode.rs` — schneller Preview-Encode (CRF aus Config)
- [x] Tauri-Command `generate_preview(video_paths, kunde)` → preview_path
- [x] React: `VideoPreview.tsx`, `PhotoPreview.tsx`

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\components\video_preview.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\preview_encode_target.py
```

---

### Phase 9 — Video-Player & Cutter

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 8  
**Ziel:** Videos abspielen, schneiden, teilen

#### Aufgaben

- [x] libmpv: pragmatischer Zwischenweg — HTML5 `VideoPlayer` (libmpv später)
- [x] `video/cutter.rs` — Trim/Split Commands (Stream-Copy + optionales Re-Encode)
- [x] Tauri-Commands: `cut_video`, `split_video`
- [x] React: `VideoPlayer.tsx`, `VideoCutter.tsx`
- [x] `usePendingVideoCuts.ts` — Batch-Schnitte
- [x] Unit-Tests für Command-Generierung

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\components\video_cutter.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\components\video_player.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\cutter_service.py
```

---

### Phase 10 — SMB-Upload & Auto-Update

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 3, 5  
**Ziel:** Server-Upload, Update-Prüfung

#### Aufgaben

- [x] `smb/client.rs` — SMB-Upload (smb2 crate)
- [x] Tauri-Commands: `test_server_connection`, `upload_to_server`
- [x] Tauri Updater Plugin konfigurieren
- [x] React: Server-Status-Anzeige, Update-Dialog

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\file_utils.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\installer\updater.py
```

---

### Phase 11 — App-Shell, Splash & Polish

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Alle vorherigen Phasen  
**Ziel:** Vollständige App mit Splash, Session-Reset, Cache-Cleanup

#### Aufgaben

- [x] `App.tsx` — Gesamtlayout, Tab-Navigation (Video/Foto)
- [x] `SplashScreen.tsx` — Startup mit FFmpeg/HW-Check
- [x] Session-Reset (Kundendaten zurücksetzen, Videos behalten)
- [x] `storage/cache.rs` — Temp-Ordner aufräumen
- [x] Logging nach Datei (`app.log` in AppData)
- [x] App-Icon, Fenstertitel, Version

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\app.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\splash_screen.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\cache_cleanup.py
```

---

### Phase 12 — Vorgang Erstellen & Legacy-Export

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 5–11  
**Ziel:** Einheitlicher „Erstellen“-Vorgang mit Legacy-Ordnerstruktur, Marker und Upload

#### Aufgaben

- [x] Output-Pfade: `{YYYYMMDD}_{Gast}_TA_{TM}[_V_{VS}]` unter `speicherort`
- [x] Unterordner: `Handcam_Video` / `Outside_Video` / `Handcam_Foto` / `Outside_Foto` / `Preview_*`
- [x] Marker `_fertig.txt` (JSON, QR/Oldschool-Varianten)
- [x] Foto-Kopie + Wasserzeichen Video/Foto (`preview_stempel.png`)
- [x] Tauri-Commands `create_job` / `validate_create_job`
- [x] UI: Button „Erstellen“, Live-Validierung, Speicherort-Dialog bei leerem Config
- [x] Upload des gesamten Ausgabeordners (inkl. `_fertig.txt`)
- [x] Wasserzeichen-Auswahl in Medienliste (WM-Spalte bei unbezahlt)

#### Legacy

```
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\processor.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\file_utils.py
@C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\gui\app.py
```

---

### Phase 13 — macOS Build & Plattform-Tests

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 12  
**Ziel:** `.dmg` Build, Code Signing, plattformspezifische Fixes

#### Aufgaben

- [x] FFmpeg Sidecar `resources/ffmpeg/mac/ffmpeg` (+ arch-Pfade, Download-Skript, README)
- [x] VideoToolbox-Encoding prüfen (Unit-Tests für Params/Args; Runtime auf macOS)
- [x] SD-Karten-Erkennung auf macOS (`/Volumes`, System-Volumes filtern)
- [x] SMB via smb2 (Guest, `user@host`, Unix-Lokalpfade)
- [x] GitHub Actions: Win + Mac CI (`.github/workflows/build.yml`)
- [x] `.dmg` + Notarization-Hinweise (`docs/MACOS_BUILD.md`, Entitlements, Info.plist)

---

### Phase 14 — ML Foto-Klassifikation (optional, später)

**Status:** ⬜ Backlog  
**Abhängigkeiten:** Phase 7  
**Ziel:** Handcam-Phasen automatisch erkennen (plane, door, exit, …)

#### Aufgaben

- [ ] Separates Python-Trainings-Repo (`AeroTandemStudio-ml`)
- [ ] Modell exportieren als ONNX
- [ ] `ort` (ONNX Runtime) in Rust — DirectML (Win) / CoreML (Mac) / optional Linux EP
- [ ] Tauri-Command `classify_photo(path)` → phase_label

---

### Phase 15 — Linux Build & Plattform-Parity

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 13  
**Ziel:** Voll funktionsfähiger Linux-Desktop-Build (Feature-Parity Win/Mac)  
**Guide:** `@docs/LINUX_BUILD.md`

Offiziell Win + Mac + Linux. Code-Lücken aus Phase 15 geschlossen: release-taugliches
FFmpeg-Download, Font/`fontfile`, NVENC-Detection Linux, SD-Härtung, Updater-AppImage, Ubuntu CI.

#### Architektur-Entscheidungen (v1)

| Thema | Entscheidung |
|-------|----------------|
| Target | `x86_64-unknown-linux-gnu` (aarch64 optional später) |
| Bundle | **AppImage** primär; `.deb` optional parallel |
| Nicht in v1 | Flatpak/Snap (Sandbox blockiert SD/SMB/arbitrary paths) |
| FFmpeg | Statisches/bundled Binary → `resources/ffmpeg/linux/x86_64/ffmpeg` (nicht PATH-Copy) |
| HW-Encode | NVENC wenn `nvidia-smi` + Encoder; sonst libx264; VAAPI = Backlog |
| Updater | AppImage in Release + `pick_installer_url` / `launch_installer` |
| Breaking Changes | Keine für Win/Mac (additiv) |

#### Aufgaben — Foundation

- [x] System-Deps dokumentieren (WebKitGTK, GTK, `patchelf`, …) in `docs/LINUX_BUILD.md`
- [x] FFmpeg: echtes Download in `scripts/download-ffmpeg.mjs` (statt `which ffmpeg` kopieren)
- [x] Layout `linux/x86_64/ffmpeg` + Fallback `linux/ffmpeg`; `find_ffmpeg` + Unit-Tests
- [x] `resources/ffmpeg/README.md` Linux-Quelle aktualisieren
- [x] Font-Auflösung Linux: System-DejaVu und/oder Bundle-TTF; Intro-`drawtext` mit `fontfile=` wo nötig
- [x] `hw_accel.rs`: NVENC-Detection auch unter Linux (`nvidia-smi`; ohne PowerShell-Zweig)

#### Aufgaben — Plattform-Features

- [x] SD-Monitor härten: False-Positives filtern; `/run/media/$USER/…` / `/media/$USER/…`; optional `/sys/block/…/removable`
- [x] Unit-Tests für Linux-Mount-Heuristik (analog `is_macos_volume_candidate`)
- [x] SMB Smoke (Guest + Credentials) — Code cross-platform, Verifikation + ggf. kleine Fixes
- [x] Config-/Cache-Docs: XDG `~/.local/share/AeroTandemStudio`

#### Aufgaben — Ship

- [x] `tauri build` → AppImage (+ optional deb); Bundle-Targets klar dokumentieren/konfigurieren
- [x] Updater: `pick_installer_url` (`.AppImage`), `launch_installer` (`chmod +x` + spawn)
- [x] `.github/workflows/release.yml`: `ubuntu-22.04` (o. ä.) + Apt-Deps + `download-ffmpeg` + Upload
- [x] Optional: Linux `cargo test` in CI für cfg-Zweige — bewusst nicht (nur lokal `npm run test:rust`)
- [x] `AGENTS.md` / Plan-Tracker: Win + Mac + Linux; HW-Liste NVENC Win/Linux
- [ ] Manuelle E2E-Abnahme laut Feature-Matrix unten (Linux-VM / Release-Job)

#### Feature-Parity (Abnahme)

| Feature | Soll Linux |
|---------|------------|
| UI starten, Drag&Drop, Dialoge | ✅ |
| Preview + Full Encode | ✅ (NVENC oder x264) |
| Intro drawtext (Umlaute) | ✅ |
| Cut / Split / Pending Cuts | ✅ |
| QR | ✅ |
| SD Monitor + Import/Backup | ✅ |
| Vorgang / Export / Marker / WM | ✅ |
| SMB Upload | ✅ |
| Auto-Update (AppImage) | ✅ |
| Cache / Session-Reset / Logs | ✅ |

#### Nicht-Ziele v1

- Flatpak/Snap, Distro-Repos, Code-Signing à la macOS, aarch64-Linux, VAAPI-Parity

#### Referenzen

```
@docs/LINUX_BUILD.md
@docs/MACOS_BUILD.md          # Spiegel für Struktur
src-tauri/src/video/ffmpeg.rs
src-tauri/src/video/hw_accel.rs
src-tauri/src/video/processor.rs
src-tauri/src/sd_card/monitor.rs
src-tauri/src/updater/mod.rs
scripts/download-ffmpeg.mjs
.github/workflows/release.yml
```

---

### Phase 16 — First-Run Setup-Wizard

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 5 (Config), Phase 11 (Splash)  
**Ziel:** Beim ersten Start (und nach Werkseinstellungen) kurze Einrichtung der Kern-Settings

#### Aufgaben

- [x] `setup_completed` in `AppConfig` + Migration für bestehende Installationen
- [x] `intro_enabled` Default `false`
- [x] `SetupWizard.tsx`: Theme, Speicherort/Ort, Backup/PC-Name, Server, Zusammenfassung
- [x] Dezenter Skip; Abschluss setzt `setup_completed`
- [x] Boot-Gate nach Splash; Factory-Reset öffnet Wizard erneut
- [x] Unit-Tests für Setup-Migration

#### Referenzen

```
src/components/SetupWizard.tsx
src-tauri/src/storage/config.rs
src/components/SettingsDialog.tsx
src/App.tsx
```

---

### Phase 17 — QR-Treffer-Preview (Spotlight)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 6 (QR), Phase 5 (`SuccessDialog`)  
**Ziel:** Bei erkanntem QR im Erfolgsdialog den Treffer-Frame zeigen — QR in klar markiertem Quadrat, Umgebung abgedunkelt (Spotlight)

#### UX / Layout

- Links: bestehender QR-Erfolgsdialog unverändert (Titel, Highlight/Name, Actions, Auto-Close)
- Rechts: Frame-Preview (2-Spalten-Dialog, etwas breiter; mobil: Text oben, Preview darunter)
- Spotlight: QR-Region als Quadrat mit Border; alles außerhalb abgedunkelt
- Kurzes Fade-in der Abdunklung (~200 ms)
- Fallback: keine Punkte / kein Frame → Dialog wie heute (nur Text)

#### Technik

1. **Primär:** CSS-Overlay auf dem Treffer-Frame; Bounding-Box aus rxing `getPoints()` (Rust → DTO)
2. Preview nur beim Hit persistieren (`aero_studio_qr_preview_*`), nicht jeden Scan-Frame annotieren
3. Temp-Preview nach Dialog-Close + Orphan-Cleanup

#### Aufgaben

- [x] Decode: Corner-Punkte aus rxing; Spotlight-Quadrat (Padding) normalisiert [0,1]
- [x] Bei Video-Hit: Treffer-Frame persistieren; bei Foto: Decode-Bild als Preview (überlebt Quellen-Cleanup)
- [x] `QrScanResultDto` / Frontend-Typen um Preview + Spotlight erweitern
- [x] `SuccessDialog` Variante `qr`: optionale rechte Preview-Spalte
- [x] Temp-Preview nach Dialog-Close aufräumen; Orphan-Prefix in Cache-Cleanup
- [x] Unit-Tests für Spotlight-Geometrie
- [x] Session-Replay: Button „Scan“ neben QR/Manuell; Dialog mit Schatten-Toggle; Preview im `kundeStore` bis Session-Reset

#### Nicht-Ziele

- Live-Kamera-Scanner / Dauer-Overlay während des Scans
- Änderung der Scan-Logik oder Cleanup-Regeln für Medien

#### Referenzen

```
src/components/SuccessDialog.tsx
src/components/QrSpotlightPreview.tsx
src/lib/qrSuccess.ts
src/lib/autoQrScan.ts
src-tauri/src/qr/analyser.rs
src-tauri/src/commands/qr.rs
```

---

### Phase 18 — Standard-Medienordner anlegen (Wizard + Settings)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 16 (Setup-Wizard), Phase 5 (Config)  
**Ziel:** Ein Klick legt OS-passende Standardordner an und setzt `speicherort` + `sd_backup_folder` konsistent — ohne stille Config-Änderung vor User-Aktion.

#### Defaults (OS)

Gemeinsame Wurzel, getrennte Unterordner (pro Klick nur einer):

| OS | Wurzel | `speicherort` | `sd_backup_folder` |
|---|---|---|---|
| Windows | `%USERPROFILE%\Videos\AeroTandemStudio` | `…\Erstellt` | `…\SD-Backups` |
| macOS | `~/Movies/AeroTandemStudio` | `…/Erstellt` | `…/SD-Backups` |
| Linux | `~/Videos/AeroTandemStudio` (XDG) | `…/Erstellt` | `…/SD-Backups` |

Resolver: `directories::UserDirs::video_dir()` (macOS → Movies). Fallback: `home/Videos` bzw. `home/Movies`.  
**Nicht** App-Config-Dir.

#### UX

- Button **„Standard anlegen“** nur im SetupWizard (je Feld eigener Klick)
- Label darunter: `Standard: <Pfad>` für das jeweilige Feld
- Alternate Fixed-Volume-Vorschlag mit Bestätigung; Cloud-/Platz-Warnungen
- `openDialog` `defaultPath` = vorgeschlagene Wurzel
- Leeres `sd_pc_name` → Hostname beim Anlegen des Backup-Ordners

#### Technik

- `storage/default_media_dirs.rs`: `propose_default_media_dirs`, `ensure_default_media_dir(kind)`
- Tauri: `propose_default_media_dirs`, `ensure_default_media_dir`
- Frontend: `src/lib/defaultMediaDirs.ts` (nur Wizard)

#### Nicht-Ziele

- Feature in SettingsDialog
- Beide Ordner mit einem Klick anlegen
- Automatisches Setzen beim ersten Start ohne User-Aktion
- Verschieben bestehender Vorgänge/Backups
- Server-/SMB-Backup-Pfade

#### Referenzen

```
src/components/SetupWizard.tsx
src/lib/defaultMediaDirs.ts
src-tauri/src/storage/default_media_dirs.rs
src-tauri/src/commands/config.rs
```

---

### Phase 19 — Operator-Identität (Ich / Favorit in Crew-Dropdowns)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 5 (Config/Crew), Phase 16 (Setup-Wizard)  
**Ziel:** `operator_name` speichern; in TM/VS-Formular-Dropdowns als Favorit oben mit Divider (nur bei passender Crew-Rolle). Gegenseitiger Ausschluss TM ↔ VS.

#### Datenmodell

- Config: `operator_name: string` (Default `""`)
- Rollen **nicht** separat — aus matching `CrewMember` (case-insensitive)
- Neuer Freitext-Name → beim Speichern `ensureCrewMember` (beide Rollen)

#### UI

- Wizard Step Crew + Settings Crew-Tab: „Ich bin“
- Formular: Pin `Du · {Name}` + Separator; Pin nur bei Rolle
- Combobox: `disabledValues` / disabled pinned rows
- TM und VS dürfen nicht dieselbe Person sein (Liste ausgegraut; Validation blockiert Create)

#### Nicht-Ziele

- Auto-Fill der Formularfelder allein durch Operator (bleibt Session-Keep)
- Kopplung an `sd_pc_name` / Shared-PC-Logik
- Session-Keep an Operator koppeln

#### Referenzen

```
src-tauri/src/storage/config.rs
src-tauri/src/model/validation.rs
src/lib/tauri.ts
src/components/ui/combobox.tsx
src/components/CustomerForm.tsx
src/components/SetupWizard.tsx
src/components/settings/tabs/CrewTab.tsx
src/components/settings/hooks/useCrewEditor.ts
```

---

## 9. Config-Schema

Portieren aus `config.py` → SQLite. Alle Keys:

```json
{
  "speicherort": "",
  "ort": "Calden",
  "dauer": 5,
  "intro_enabled": false,
  "outside_video": false,
  "gast_name": "",
  "tandemmaster": "",
  "videospringer": "",
  "operator_name": "",
  "upload_to_server": false,
  "server_url": "smb://169.254.169.254/aktuell",
  "hardware_acceleration_enabled": true,
  "parallel_processing_enabled": true,
  "video_codec": "auto",
  "encoding_strategy": "per_clip",
  "qr_check_enabled": false,
  "photo_qr_check_enabled": false,
  "qr_video_scan_seconds": 5,
  "sd_auto_backup": false,
  "sd_backup_folder": "",
  "sd_backup_mode": "confirm",
  "sd_clear_after_backup": false,
  "sd_auto_import": false,
  "sd_skip_processed": false,
  "sd_size_limit_enabled": false,
  "sd_size_limit_mb": 2000,
  "setup_completed": false
}
```

Config-Pfad:
- Windows: `%LOCALAPPDATA%\AeroTandemStudio\`
- macOS: `~/Library/Application Support/AeroTandemStudio/`
- Linux: `~/.local/share/AeroTandemStudio/` (XDG via `directories`)

---

## 10. Assets & Ressourcen

Aus Legacy kopieren nach `src-tauri/resources/assets/`:

| Legacy | Neu |
|--------|-----|
| `AeroTandemStudio/assets/icon.ico` | `src-tauri/icons/` |
| `AeroTandemStudio/assets/hintergrund.png` | `src-tauri/resources/assets/hintergrund.png` |
| `AeroTandemStudio/assets/logo.png` | `src-tauri/resources/assets/logo.png` |
| `AeroTandemStudio/assets/preview_stempel.png` | `src-tauri/resources/assets/preview_stempel.png` |
| `AeroTandemStudio/assets/paypal_logo.png` | `src-tauri/resources/assets/paypal_logo.png` |

Content-Area-Konstanten (aus `constants.py`):

```
HINTERGRUND_ORIGINAL: 3056 × 2037 px
CONTENT_AREA: (94, 94) → (1626, 1974)
PADDING: left 5%, right 2%, top/bottom 5%
```

---

## 11. Teststrategie

### Rust Unit-Tests (jede Phase)

```rust
#[cfg(test)]
mod tests {
    // FFmpeg-Command-Generierung testen (kein echter Encode)
    // Hardware-Detection mocken
    // Config serialize/deserialize
}
```

```powershell
cd src-tauri
cargo test
```

### Manuelle Tests (nach jeder Phase)

| Phase | Test |
|-------|------|
| 0 | MP4 encodieren, Fortschritt sichtbar |
| 1 | 2 MP4s concat, Trim testen |
| 2 | Drag & Drop, Liste aktualisiert |
| 3 | Intro + Body → finales Video |
| 5 | Config speichern/laden, Formular validieren |
| 6 | QR-Code aus Testvideo scannen |
| 7 | SD-Karte einstecken → Backup/Dialog |
| 9 | Video schneiden und teilen |
| 10 | SMB-Upload, Update-Check |
| 13 | macOS: VT encode, SD `/Volumes`, DMG |
| 15 | Linux: AppImage, FFmpeg sidecar, SD mounts, SMB, Updater |

### End-to-End (Phase 11)

1. SD-Karte einstecken → Import
2. QR scannen → Kundendaten
3. Vorschau generieren
4. Video erstellen
5. Upload (optional)

---

## 12. Build & Deployment

### Lokal

```powershell
npm run tauri build
```

Output: `src-tauri/target/release/bundle/`

### CI (Phase 13 + Phase 15)

```yaml
# .github/workflows/release.yml
# - windows-latest + macos-latest + ubuntu-22.04
# - npm run download-ffmpeg → tauri-action → Releases-Repo
# - Artifacts: NSIS/EXE (Win), .dmg (Mac), AppImage (Linux)
# - Mac signing/notarization: docs/MACOS_BUILD.md
# - Linux: docs/LINUX_BUILD.md
```

### Versionierung

SemVer in `src-tauri/tauri.conf.json` + `src-tauri/Cargo.toml`.

---

## 13. Fortschritts-Tracker

| Phase | Name | Status |
|-------|------|--------|
| 0 | FFmpeg-Grundgerüst | ✅ |
| 1 | Concat & Trim | ✅ |
| 2 | Video-Liste & Drag & Drop | ✅ |
| 3 | Intro-Pipeline | ✅ |
| 4 | Paralleles Encoding | ✅ |
| 5 | Config & Basis-UI | ✅ |
| 6 | QR-Code | ✅ |
| 7 | SD-Karten | ✅ |
| 8 | Video-Vorschau | ✅ |
| 9 | Player & Cutter | ✅ |
| 10 | SMB & Update | ✅ |
| 11 | App-Shell & Polish | ✅ |
| 12 | Vorgang Erstellen & Legacy-Export | ✅ |
| 13 | macOS Build & Plattform-Tests | ✅ |
| 14 | ML Foto-Klassifikation (optional) | ⬜ |
| 15 | Linux Build & Plattform-Parity | ✅ |
| 16 | First-Run Setup-Wizard | ✅ |
| 17 | QR-Treffer-Preview (Spotlight) | ✅ |
| 18 | Standard-Medienordner anlegen | ✅ |
| 19 | Operator-Identität (Ich / Favorit) | ✅ |

**Legende:** ⬜ Offen · 🔄 In Arbeit · ✅ Erledigt

---

## Schnellstart für neues Agent-Fenster

```
Implementiere Phase X aus @docs/IMPLEMENTATION_PLAN.md
Regeln: @AGENTS.md
Legacy-Dateien: [siehe Phase X im Plan]
Nur Phase X. Danach cargo test && npm run tauri dev.
```

**Linux (Phase 15):** zusätzlich `@docs/LINUX_BUILD.md` — siehe Prompt dort bzw. unten in der Datei.

---

*Letzte Aktualisierung: 2026-08-12 · Projekt: Aero Tandem Studio v2 · Phase 19 Operator-Identität*
