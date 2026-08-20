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

**Nächste Phase:** [Phase 23.3 — Linux libmtp](#phase-23--usb-action-cams-mtp-erkennen--importieren)  
*(Phase 23.1 Windows WPD erledigt — manuelle Cam-Abnahme offen.)*  
*(Phase 28 Fotos Master–Detail erledigt.)*  
*(Phase 27 Encode-Profil & Reencode-Confirm UX erledigt.)*  
*(Phase 25 AMS-Lookup Autofill erledigt.)*  
*(Phase 24 AMS-Nachreichen erledigt.)*  
*(optional danach: [Phase 14 — ML Foto-Klassifikation](#phase-14--ml-foto-klassifikation-optional-später))*  
*(Phase 22: macOS Titlebar-Align + Dialog-Zentrierung erledigt.)*
*(Phase 20–21.1: Medien-Drehen + Foto-Crop + Crop-Settle UX erledigt.)*
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
- Formular: Pin `{Name} (Ich)` + Separator; Pin nur bei Rolle
- Session-Keep-Dropdowns (Wizard/Settings): nach Keep-Modi Divider + gleicher Ich-Pin bei Rolle
- Combobox: `disabledValues` / disabled pinned rows; Separatoren auch innerhalb von `pinnedOptions`
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

### Phase 20 — Medien-Bearbeitung: Drehen (Video + Foto)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 9 (Cutter), Phase 8 (PhotoPreview)  
**Ziel:** Medien 90°-weise drehen; Schneiden-Dialog → **Bearbeiten**; Foto-Editor analog.

#### Entscheidungen

| Thema | Entscheidung |
|-------|----------------|
| Video-Rotation | Pixel-`transpose` + Re-Encode (kein Metadata-only) |
| Foto-Rotation | `image`-Crate, EXIF-Orientation vorher einbacken |
| Preview | CSS im Dialog; Apply schreibt Working-Copy |
| Trim + Rotate | Nicht gleichzeitig: Trim/Split gesperrt bei ausstehender Drehung |
| Undo | Video: bestehendes Cut-Undo; Foto: `photo_edit_undo` |
| Batch | Auswahl drehen in Foto-Vorschau |

#### Aufgaben

- [x] `video/rotate.rs` — FFmpeg-Args + `rotate_video` Command + Unit-Tests
- [x] `media/rotate.rs` + `media/photo_edit_undo.rs` — Foto drehen / Undo
- [x] Rename UI: Schneiden → **Bearbeiten**; Undo → **Bearbeitung rückgängig**
- [x] `VideoCutter`: Drehen-Bar, CSS-Preview, „Drehen übernehmen“
- [x] `PhotoEditor` + Entry in `PhotoPreview` / Kontextmenü
- [x] Batch-Rotate für Foto-Auswahl
- [x] `mediaRevision` / Edit-Marks für Cache-Bust

#### Referenzen

```
src-tauri/src/video/rotate.rs
src-tauri/src/media/rotate.rs
src-tauri/src/media/photo_edit_undo.rs
src/components/VideoCutter.tsx
src/components/PhotoEditor.tsx
src/components/MediaEditRotateBar.tsx
src/hooks/useVideoCutApply.ts
src/hooks/usePhotoEditApply.ts
```

---

### Phase 21 — Foto-Zuschnitt (Crop)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 20 (PhotoEditor, photo_edit_undo)  
**Ziel:** Freies Zuschneiden der Foto-Working-Copy im Bearbeiten-Dialog.

#### Entscheidungen

| Thema | Entscheidung |
|-------|----------------|
| Koordinaten | Normiert 0–1 nach EXIF-Bake |
| Apply | `image`-Crate Crop + Undo wie Rotate |
| UI | Mode „Zuschnitt“ + Overlay (Maske, Handles) |
| Video-Crop / Batch / Aspect-Presets | Out of scope v1 |

#### Aufgaben

- [x] `media/crop.rs` — `crop_photo` + Unit-Tests + Command
- [x] `PhotoCropOverlay` + Mode in `PhotoEditor`
- [x] `usePhotoEditApply.applyCrop` + Marks/Revision
- [x] Preview-Badge Crop/Rot

#### Referenzen

```
src-tauri/src/media/crop.rs
src/components/PhotoCropOverlay.tsx
src/components/PhotoEditor.tsx
src/hooks/usePhotoEditApply.ts
```

---

### Phase 21.1 — Crop-Settle UX

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 21  
**Ziel:** iOS-näheres Settle nach Crop (vor Fertig-Commit): Idle-Settle, Overlay am gecroppten Rand, smooth Outside-Reveal im Shadow — ohne Click-to-reopen.

#### Entscheidungen

| Thema | Entscheidung |
|-------|----------------|
| Idle bis Settle | ~1400 ms nach Gesture-Ende / Preset |
| Settled-UI | Viewport = Crop; Overlay-Chrome am Rand (Handles bleiben) |
| Re-Edit | Nur Handle/Move-Drag unsettled — kein Tap-to-reopen |
| Preview | Eine Pipeline: Vollbild-Inner + Frame-Clip; kein Hart-Umschalten Settled↔Full |
| Shadow | Outside fade-in bei Unsettle (`shadowOpacity` 0 → ~0.55) |
| Grid | Nur während aktivem Drag |
| Phasen | `editing` \| `settled` (Unsettle = zurück nach `editing`) |

#### Aufgaben

- [x] `CROP_SETTLE_MS = 1400`; Timer bei Gesture/Preset neu
- [x] Unified Crop-Preview (Frame-Contain + Inner-Position, CSS-Transition)
- [x] Overlay im Settled am Crop-Rand; Drag → Unsettle + kontinuierliche Gesture
- [x] `PhotoCropOverlay`: `shadowOpacity`, Grid nur beim Drag, größeres Hit-Slop
- [x] Preset/Reset/Rotate-Mode-Randfälle beibehalten

#### Referenzen

```
src/components/PhotoEditor.tsx
src/components/PhotoCropOverlay.tsx
```

---

### Phase 22 — macOS Titlebar-Align & Dialog-Zentrierung

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 11 / AppChrome  
**Ziel:** (1) Auf macOS (Overlay-Titlebar) sind die Traffic Lights **vertikal mittig** zum Logo-Tile (34px) ausgerichtet. (2) Dialoge (inkl. Update-Dialog) sind wieder stabil zentriert — Regression durch `inset-0`+`m-auto`+`h-fit` auf WKWebView behoben.

#### Entscheidungen

| Thema | Entscheidung |
|-------|----------------|
| Traffic Lights | `trafficLightPosition: { x: 14, y: 16 }` — Center-Formel `padY + (logoTile − lightH) / 2` = `5 + (34 − 12) / 2` |
| Sync | Konstanten in `macTrafficLights.ts` + Kommentar in `AppChrome` — Conf-`y` und Header/Logo-Maße gekoppelt halten |
| Dialog-Zentrierung | Flex-Wrapper um `DialogContent` (kein `transform`, kein `inset-0`+`m-auto`+`h-fit`) — Select/Combobox-Koordinaten bleiben korrekt, macOS-Layout stabil |

#### Aufgaben

- [x] `trafficLightPosition` in `tauri.conf.json` / `tauri.macos.conf.json` setzen (Overlay + decorations)
- [x] `macTrafficLights.ts` + Header-Inset/Center-Kommentar in `AppChrome`
- [x] `DialogContent`: Flex-Center ohne Transform; z-Index-Layer für gestapelte Dialoge
- [x] Win/Linux unverändert (Custom-Controls / kein Overlay)

#### Referenzen

```
src-tauri/tauri.conf.json
src-tauri/tauri.macos.conf.json
src/components/chrome/macTrafficLights.ts
src/components/chrome/AppChrome.tsx
src/components/ui/dialog.tsx
src/components/UpdateDialog.tsx
```

---

### Phase 23 — USB-Action-Cams (MTP) erkennen & importieren

**Status:** 🔄 In Arbeit (23.0 ✅ · 23.1 Windows WPD ✅ · 23.2 Detect ✅ · 23.2b ICA Staging ✅ · 23.2c ICA UI-Perf ✅ · 23.2d Leere Kataloge ✅ · 23.2e ICA-Browser Replug ✅)  
**Abhängigkeiten:** Phase 7 (SD-Pipeline), Phase 5 (Config)  
**Ziel:** GoPro-, DJI- und Insta360-Kameras per USB (MTP/WPD) erkennen und in denselben Backup-/Import-Workflow bringen wie SD-Karten — **ohne** zusätzliche False Positives bei normalen Datenträgern oder Handys.

#### Problem

Neuere Action-Cams erscheinen per USB oft als **MTP/WPD-Gerät**, nicht als Mass-Storage-Volume. Der bestehende Monitor sieht nur Laufwerke/`/Volumes` + `DCIM` → Kamera bleibt unsichtbar. (Insta360 im U-Disk-Modus bleibt über den Volume-Monitor abgedeckt.)

#### Entscheidungen

| Thema | Entscheidung |
|-------|----------------|
| Volume-Monitor | **unverändert** (`is_removable_drive`, macOS/Linux-Kandidaten, `DCIM`) |
| Neuer Pfad | Parallel: **Allowlist-MTP-Monitor** — nie „alle Portable Devices“ |
| Identifikation | Primär USB **VID** (+ bekannte PIDs für Label); sekundär Friendly Name; **immer** Inhalts-Signatur |
| Hersteller | GoPro (`0x2672`), DJI (`0x2CA3`), Insta360/Arashi (`0x2E1A`) |
| DJI-Vorsicht | Gleiche VID auch für Controller/Goggles → **ohne** Action-Cam-Signatur kein Match |
| Dateizugriff | Immer **Staging-Kopie** nach `sd_backup_folder` → danach normale Pfade |
| Plattform | **23a Windows**, **23b macOS**, **23c Linux** (je eigene Abnahme) |
| Eject / Clear | MTP: Soft-Disconnect; Clear nur wenn Delete zuverlässig + Config |
| Config | `usb_camera_import_enabled` (default nach Windows-Abnahme) |
| Nicht-Ziele | Keine Handys; Volume-Heuristik nicht lockern; kein FFmpeg auf MTP; kein FUSE/mtpfs |

#### Architektur

```text
VolumeMonitor (Phase 7)          MtpCameraMonitor (Allowlist)
        │                                    │
        └────────────┬───────────────────────┘
                     ▼
              MediaSourceId
           volume:E:  |  mtp:gopro|dji|insta360:<serial>
                     ▼
         list / backup / progress (bestehende Events)
                     ▼
         Staging → lokaler Backup-Pfad → Import/FFmpeg
```

#### MTP-Allowlist (Vendor + Signatur)

Modul: `src-tauri/src/sd_card/mtp/allowlist.rs`

| Vendor-Slug | USB VID | Bekannte PIDs (Label, nicht exklusiv) | Inhalts-Signatur (DCIM) |
|-------------|---------|--------------------------------------|-------------------------|
| `gopro` | `0x2672` | HERO3+ … HERO11 / MAX aus libmtp; neuere Hero-PIDs per VID+Signatur | `100GOPRO` / `GX*.MP4` / `GH*.MP4` / `GP*.MP4` |
| `dji` | `0x2CA3` | Action/Osmo soweit bekannt; **Controller/Goggles ohne Signatur ablehnen** | `DJI_*.MP4/JPG`, typ. `100MEDIA` / DJI-DCIM |
| `insta360` | `0x2E1A` | Action-/360-Kameras (Arashi Vision) | `Camera01` / `.insv` / `.lrv` / Insta-Dateimuster |

Match-Regel: `(VID in Allowlist OR Friendly-Name-Hint) AND content_signature` — nie nur „irgendein MTP mit DCIM“.

#### Aufgaben

**23.0 — Vertrags- & Allowlist-Schicht (plattformneutral)**
- [x] `sd_card/mtp/allowlist.rs` — VID-Tabelle GoPro/DJI/Insta360 + Signatur-Matcher + Unit-Tests
- [ ] `MediaSourceKind`: `Volume` \| `MtpCamera`; stabile IDs `mtp:<slug>:<serial_or_hash>`
- [ ] Trait/Adapter-Skizze: `list_media`, `copy_to_backup`, `disconnect`

**23.1 — Windows (WPD/MTP) — MVP**
- [x] WPD-Enumeration + Hotplug/Polling; nur Allowlist + Signatur
- [x] Events `sd-card-inserted` / `sd-card-removed` mit `source_id` (rückwärtskompatibel)
- [x] List + Staging-Backup mit Progress; Import ab lokalem FS
- [x] Config `usb_camera_import_enabled` + Settings-Toggle
- [x] UI-Label z. B. „GoPro (USB)“ / „DJI (USB)“ / „Insta360 (USB)“
- [ ] Abnahme: SD unverändert; GoPro/DJI/Insta USB ok; Handy/Stick-ohne-Allowlist **nicht**

**23.2 — macOS**
- [x] USB-Detect via `system_profiler` + Allowlist (Hero 8/13, Label-Fix PID `0x0059`)
- [x] Image Capture Core Staging (`native/macos/AtsImageCapture.m` → Cache → SD-Pipeline)
- [x] Clear auf Kamera via Image Capture (gleiche Config wie SD); Volume-Heuristik unverändert
- [x] ICA-Session nach Staging halten (GoPro: Clear in derselben PTP-Session)
- [x] Liste = ICA-Katalog (kein Full-Download); Backup lädt Auswahl mit SD-Progress; Disconnect überschreibt Timeout nicht
- [x] ICA-Session sauber schließen + Browse-Retries (GoPro „Gefunden: (keine)“ nach Reconnect)
- [x] USB-Auswerfen: ICA freigeben + Gerät aus Liste bis Kabel-Replug
- [x] Kein PTPCamera-kill vor Browse (zerstört ICA-Erkennung; kürzerer Browse-Timeout)
- [x] Erkennung Webcam/USB-Connect-Modus (bDeviceClass 2) → klare MTP-Anweisung statt ICA-Timeout
- [x] ICA nur Local-USB (kein Bonjour/Shared) — Netzwerkdrucker störten PTP („Gefunden: (keine)“ trotz MTP)
- [x] CFBundleIdentifier + Photos-Library-Entitlement; Fehlermeldung bei PTP-ready ohne ICA
- [ ] Fallback-Dialog nur noch wenn ICA fehlschlägt

**23.2b — macOS Image Capture Staging-Import**
- [x] `ats_ica_stage_all` (ObjC) + `macos_ica.rs` Cache/TTL
- [x] `scan_mtp_media` / Backup-Pfad für `mtp:` Sources
- [x] UI: USB-Detect startet Confirm/Auto-Flow
- [x] Confirm-Dialog streamt ICA-Katalog (kein 60s Overlay); Grid virtualisiert; ICA-Thumbs ohne Full-Lock
- [x] ICA-UI-Perf: Katalog-Ticks nicht über `App.tsx`; JSON off-main; Thumbs erst nach Listing (Browser bleibt für gehaltene PTP-Session)
- [x] Backup-Nachlauf: Hash on-complete + Batch-SQLite; Clear fail-fast / chunked + Progress

**23.2d — Leere Kataloge (SD + MTP)**

Leere Kamera/SD ist ein **gültiger Zustand**, kein Fehler. Nicht mit ICA-/DCIM-Ausfällen vermischen.

| Zustand | Log | Confirm (`sd_backup_mode=confirm`) | Auto |
|---------|-----|--------------------------------------|------|
| 0 Medien nach erfolgreichem Scan | **WARN** | Dialog offen; Label in der Medienliste | Warn-Dialog, Workflow überspringen; Auswerfen wenn gesetzt |
| Nur Timelapse/Proxies (nichts importierbar) | **WARN** | Label „Keine importierbaren Medien (nur Timelapse/Proxies).“ | wie leer |
| Kamera nicht sichtbar / ICA-Session tot / DCIM fehlt | **ERROR** | Error-Dialog, Selector schließen | Error-Dialog |
| Download/Backup: Auswahl nicht auf der Kamera | **ERROR** | bleibt Fehler | bleibt Fehler |

- [x] ICA `beginList`: leeren Katalog als Erfolg schreiben (`[]`), nicht `failWithMessage`
- [x] `list_sd_files`: 0 Dateien → WARN (`SD-Liste leer`), nicht `SD-Liste fehlgeschlagen` / ERROR
- [x] Texte vereinheitlichen: MTP „Keine Medien auf der Kamera gefunden.“ · SD „Keine Mediendateien auf der SD-Karte gefunden.“
- [x] Confirm: Overlay in der Liste (gleicher Platz wie „SD-Dateien werden gelesen…“); Backup/Import/Bereinigen aus; **Auswerfen** und **Erneut lesen** bleiben
- [x] Auto: kein Error-Dialog bei leerem Katalog; Backup-Fail „keine Medien“ ebenfalls WARN
- [x] `beginDownloads` mit 0 Dateien bleibt Operationsfehler (nicht die Liste)

**23.2e — ICA-Browser überlebt Auswerfen / Replug**

`ICDeviceBrowser` einmal pro Prozess starten und **nicht** bei Eject/Unplug stoppen. Neuer Browser im selben Prozess → GoPro bleibt `Gefunden: (keine)` bis App-Neustart.

- [x] Prozessweiter `AtsIcaHub` als einziger Browser-Delegate
- [x] Auswerfen/Unplug: Session schließen, Kamera-Ref verwerfen; Browser läuft weiter
- [x] Replug: `didAddDevice` auf demselben Browser, dann Liste
- [x] Kein Browser-Restart nach 7 s (würde denselben ICA-Tod auslösen)
- [x] Confirm-Overlay: `min-h-[16rem]`, Label nicht in 1px-Grid abschneiden

**23.3 — Linux**
- [ ] `libmtp` (AppImage klären in `docs/LINUX_BUILD.md`); gleiche Allowlist

**23.4 — Docs / UX**
- [ ] Settings-Kurztext; `ARCHITECTURE.md` MediaSource; Phase-Status in AGENTS

#### Agent-Prompt

```
Implementiere Phase 23.1 aus @docs/IMPLEMENTATION_PLAN.md
(Windows WPD/MTP Allowlist GoPro/DJI/Insta360 + Staging).
Regeln: @AGENTS.md
Volume-Heuristik NICHT aufweichen. Kein Handy-MTP.
Danach cargo test.
```

#### Referenzen

```
src-tauri/src/sd_card/monitor.rs
src-tauri/src/sd_card/mtp/allowlist.rs
src-tauri/src/commands/sd_card.rs
src/hooks/useSdCardMonitor.ts
```

---

### Phase 24 — AMS-Nachreichen (Append-Handoff)

**Status:** ✅ Erledigt (manuelle Abnahme offen)  
**Abhängigkeiten:** Phase 12 (Vorgang/Historie), Phase 13 L4 (AMS-Status), AMS Phase 15  
**Spec:** AeroMediaService-v2 `docs/HANDOFF.md` §6.1  
**Ziel:** Aus der ATS-Historie weitere Medien in **denselben Cloud-Ordner / denselben Share-Link** nachreichen — ohne neuen Kundenordner und ohne Kunden-Mail.

#### Entscheidungen

| Thema | Entscheidung |
|--------|----------------|
| Staging | `{base}_nachreichung_01` auf `aktuell` — **nicht** ins AMS-Archiv schreiben |
| Manifest | Schema v1; `extensions.kind=append` + `parent_correlation_id` |
| Ungebucht | Default **Preview** (Wasserzeichen); Voll nur mit Bestätigung |
| Cloud-Ordner | nicht umbenennen, wenn Outside später dazukommt |
| Button | nur wenn Erst-Handoff `completed` (nicht Lokal, nicht noch uploading) |
| Altes AMS | Bridge ohne `append-v1` → Senden blockieren (sonst neuer Dropbox-Ordner) |
| Fallback | Datei-Handoff wenn Bridge down |

#### Aufgaben

- [x] `video/append_job.rs` — Kategorien HV/HF/OV/OF, Copy oder Preview-WM, Marker + Append-Manifest
- [x] Historie `vorgang_appends` + Status-Poll ohne Überschreiben des Erst-Handoffs
- [x] Command `create_append_job` + `handoff/ready`
- [x] Historie-Dialog „Nachreichen…“ + Kategorie/Preview-UI
- [x] Unit-Tests (Ordnername, Manifest-Append, Historie isoliert vom Erst-Handoff)

#### Agent-Prompt

```
Implementiere Phase 24 aus @docs/IMPLEMENTATION_PLAN.md
Spec: AMS docs/HANDOFF.md §6.1
Regeln: @AGENTS.md
Upload-Pipeline in AMS nicht umbauen.
Danach cargo test.
```

---

### Phase 25 — AMS-Lookup Autofill (Manuell / ID)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 13 P2 (Bridge Lookup), Phase 5 (Kundenform), Phase 12 (Marker `api_id`)  
**Spec:** AeroMediaService-v2 `docs/HANDOFF.md` §9 (`POST /v1/customer/lookup`, `mode=id`)  
**Ziel:** Im manuellen **ID**-Modus, sobald Kunden-ID und Booking-ID stehen und die AMS-Bridge erreichbar ist, Kundendaten per Lookup holen, die Form automatisch füllen und wie im QR-Modus sperren. **Keine Hashes** — IDs bleiben die Identität, Marker bleibt `api_id`.

Lookup existiert bereits (`ams_bridge_customer_lookup` / `preflight_customer_lookup`), füllt die Form aber nicht (nur Gate beim Erstellen).

#### Out of Scope

- Keine `kunden_id_hash` / `booking_id_hash` in Form, Store oder Marker
- Kein Umschalten auf `form_mode: "kunde"` (kein QR-Snapshot, kein `api_hash`-Marker)
- Keine AMS-API-Änderung (kein optionales `type`, keine Hash-Felder in der Response)
- Kein Lookup in Kontakt- oder Lokal-Modus
- Kein Health-Polling in der Form
- Phase 23.1 (WPD) und Phase 24 nicht anfassen

#### Entscheidungen

| Thema | Entscheidung |
|--------|----------------|
| Identität | `kunden_id` + `booking_id` bleiben; Hashes weder anzeigen noch schreiben |
| `form_mode` | bleibt `"manual"`; `manual_entry_mode` bleibt `"id"` |
| Marker / Manifest | unverändert `api_id` (Preflight weiter `mode=id`) |
| Sperre | wie QR: Name, IDs, Medien (inkl. Bezahlt) gesperrt; Crew frei; Button **Bearbeiten / Sperren** |
| Provenienz | eigenes Flag (z. B. `amsLookupLocked` / Revision), **nicht** `qrSnapshot` / `qrRevision` |
| Trigger | nur Manuell + ID; beide IDs nicht leer; Bridge konfiguriert; Debounce (~500 ms) nach letzter ID-Änderung; In-flight abbrechen |
| AMS down / kein Capability `lookup` | soft: nichts füllen, nichts sperren, manuell weiter |
| Kunde unbekannt / Lookup-Fehler (nicht unreachable) | Fehlerzeile unter den IDs; Felder bleiben editierbar; kein Lock |
| Treffer | Vorname, Nachname, `gast`, `video_mode`, Produktflags **und** `ist_bezahlt_*` setzen, dann sperren |
| E-Mail / Telefon | in ID-Modus **nicht** aus AMS übernehmen (wie QR) |
| Lookup-`type` | AMS verlangt `type`. Wenn `video_mode` schon `handcam`/`outside` → diesen Typ senden. Wenn leer → zwei Lookups (`Handcam`, `Outside`); ersten `ok` mit mindestens einem Medienflag nehmen; bei zwei Treffern Flags vereinigen, `video_mode` aus der Familie mit Flags. **Antwort** ist Quelle für Medien, nicht die leere Form. |
| Konflikt | wenn schon eine andere manuelle Identität da ist (Name oder andere IDs) → Confirm wie QR-Override, nicht still ersetzen |
| IDs nach Unlock ändern | abgeleitete Name/Medien leeren, Lock lösen, Lookup neu |
| Moduswechsel | QR / Kontakt / Lokal nach Lock → AMS-Lock lösen; QR-Scan bleibt eigener Override (`presentQrHit`) |
| Medien-Autosync | solange AMS-Lock: `syncProductsFromMedia` darf AMS-Flags **nicht** überschreiben |
| Preflight beim Erstellen | behalten (Recheck); unreachable weiter soft; „nicht gefunden“ weiter hart |
| Connectivity | kein extra Health-Ping; der Lookup selbst ist der Test (401 vs. unreachable unterscheiden) |

#### Mapping (Bridge-Customer → Form)

| AMS (`BridgeCustomer`) | ATS (`Kunde`) |
|------------------------|----------------|
| `first_name` | `vorname` (+ `gast` ableiten) |
| `last_name` | `nachname` |
| `handcam_*` / `outside_*` | dieselben Produktflags |
| `ist_bezahlt_*` (Rust-DTO; TS-Typen nachziehen) | dieselben Bezahlt-Flags |
| `customer_type` / gesetzte Flags | `video_mode` `handcam` \| `outside` |
| `customer_number` / `booking_number` | **nicht** über IDs stülpen — eingegebene IDs bleiben |
| `email` / `phone` | ignorieren |

Frontend-Typ `AmsBridgeLookupResponse.customer` um Medien-/Bezahlt-Flags und `type` ergänzen (Rust `BridgeCustomer` ist Quelle).

#### UX

- IDs bleiben sichtbar (Hash-Präfix wie bisher), nach Lock disabled.
- Status unter den ID-Feldern, z. B. `Gefunden: Max Mustermann · Outside Video` / `Suche…` / `Kunde nicht gefunden` / (still, wenn AMS offline).
- Button **Bearbeiten / Sperren** nur wenn AMS-Lock aktiv (analog QR, nicht den QR-Button wiederverwenden).
- Crew-Attention wie nach QR ist optional; nicht Pflicht, wenn TM/VS schon aus Config kommen.

#### Aufgaben

- [x] `kundeStore`: `applyFromAmsLookup`, Lock-/Revision-State, Unlock setzt Lock zurück ohne QR anzufassen
- [x] `CustomerForm`: Trigger (Debounce, nur ID-Modus), Statuszeile, Sperre Name/IDs/Medien, Bearbeiten-Button
- [x] Lookup-Aufruf `mode: "id"`; Stale-Response verwerfen; `type` laut Entscheidungstabelle
- [x] Confirm bei Konflikt mit bestehender manueller Identität
- [x] `AmsBridgeLookupResponse` an Rust-DTO angleichen
- [x] `syncProductsFromMedia` / `autoCheckProducts`: Lock respektieren
- [x] Tests: Mapping ohne Hashes; Lock unabhängig von QR; `type`-Fallback (leer → dual lookup); Marker bleibt `api_id`

#### Agent-Prompt

```
Implementiere Phase 25 aus @docs/IMPLEMENTATION_PLAN.md
Spec: AMS docs/HANDOFF.md §9 Lookup mode=id
Regeln: @AGENTS.md
Keine Hashes, form_mode bleibt manual, Marker bleibt api_id.
AMS-API nicht ändern. Phase 23/24 nicht anfassen.
Danach cargo test && npm run check.
```

#### Referenzen

```
src/components/CustomerForm.tsx
src/store/kundeStore.ts
src/hooks/useAmsIdLookup.ts
src/lib/amsLookup.ts
src/lib/tauri.ts                    # amsBridgeCustomerLookup, AmsBridgeLookupResponse
src/lib/qrPresent.ts                # Konflikt-Confirm-Vorbild
src/lib/syncProductsFromMedia.ts
src-tauri/src/bridge/mod.rs         # customer_lookup, lookup_request_from_kunde, BridgeCustomer
src-tauri/src/bridge/lookup_map.rs  # Mapping, dual type, api_id tests
src-tauri/src/commands/bridge.rs
src-tauri/src/video/marker.rs       # api_id unverändert
```

### Phase 27 — Encode-Profil, Preview=Export & Reencode-Confirm UX

**Ziel:** Ein gemeinsames Encode-Profil für Preview und Export; Reencode-Confirm mit Presets; klare Codec-Auflösung bei gemischten Clips; kompakter Confirm-Dialog.

**Abhängigkeiten:** Phase 12 (Create), Phase 8 (Preview), OPT-9 (Reuse)

#### Regeln / Empfehlungen (Codec bei `auto`)

1. **Anzeige = Encode-Entscheidung** — `resolved_codec` vor dem Confirm setzen (nie nur Literal `"auto"` ohne Auflösung).
2. **Mehrheits-Codec** — bei gemischten Clips Ziel = Mehrheit H.264 vs. HEVC; **Gleichstand → H.264** (AMS/Browser-Kompatibilität). Nicht „erster Clip“ als alleinige Heuristik.
3. **Forced Preference** — Settings `h264` / `h265` überschreiben die Mehrheit.
4. **Dialog** — Preset zuerst; Kurz-Zusammenfassung (`auto (H.264) · CRF 18 · HW …`); Details eingeklappt.
5. **Backlog (später):** nur abweichende Clips reencoden, passende per Stream-Copy behalten.

#### Scope

- [x] `EncodeProfile` + Presets (Empfohlen / Max / Ausgewogen / Schnell / Kompatibel)
- [x] Confirm gibt Profil an Rust zurück (`resolve_reencode_confirm`)
- [x] Preview-Scale default = Source (Preview ≈ Export); Compat = 1080p@30
- [x] Rotate nutzt `encoding_quality` / Profil (nicht CRF-23-`from_hw`)
- [x] Body-Parallel: Mehrheit vor Confirm → `auto (H.264|H.265)`
- [x] Confirm-Dialog UI verschlankt
- [ ] Optional: nur mismatched Clips reencoden (Backlog)

#### Agent-Prompt

```
Implementiere Phase 27 aus @docs/IMPLEMENTATION_PLAN.md
Regeln: @AGENTS.md
Nur Phase 27. Danach cargo test && npm run check.
```

#### Referenzen

```
src-tauri/src/video/encode_profile.rs
src-tauri/src/video/reencode_confirm.rs
src-tauri/src/video/encoding_quality.rs   # majority_body_codec
src-tauri/src/video/processor.rs          # BodyParallel + resolve_mixed_body_target_pref
src/components/ReencodeConfirmDialog.tsx
src/lib/encodeProfile.ts
```

---

### Phase 28 — Fotos-Tab Master–Detail (Übersicht / Review)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 8 (`PhotoPreview`), Phase 20–21 (Bearbeiten/Crop/Batch), OPT-1/OPT-10/OPT-11 (Thumbnail-Queue)  
**Ziel:** Im Fotos-Tab ein klares **Master–Detail**-Layout: links Navigation (Kachel-Übersicht **oder** Review mit großer Stage + Strip), rechts festes Detail-Panel zum fokussierten Foto. Kein Entweder-oder als zwei Features — **ein Layout, zwei Darstellungsmodi**.

#### Ausgangslage (Ist)

- `PhotoPreview`: große Stage (`aspect-video`) + Prev/Next + horizontaler Filmstrip + Meta-Karten **unter** der Stage
- darunter zusätzlich `MediaListPanel kind="foto"` → doppelte Liste, langer Scroll
- State: `currentIndex` (Fokus), `selected` / `explicitlySelected` (Multi-Select), WM, Edit-Marks, `photoThumbnailQueue`
- Operator-Aktionen: QR, Bearbeiten/Undo, Entfernen, Batch-90°, WM-Toggle, Tastatur ←/→/Delete/Ctrl+A

#### Entscheidungen

| Thema | Entscheidung |
|--------|----------------|
| Layout | Desktop: **Split** — links Master, rechts Detail (min. ~280 px). Schmal: Detail unter Master oder einklappbar/Drawer |
| Modi | Toggle **Übersicht** (Kachelgrid) \| **Review** (große Stage + schmaler Strip). Nicht zwei getrennte Screens |
| Default-Modus | `photoList.length > 8` → Übersicht, sonst Review; letzte Wahl in Session merken (`uiStore` oder transient); optional später Config |
| Fokus vs. Auswahl | Klick = Fokus (`currentIndex` + Detail rechts). Ctrl/Cmd / Shift = Multi-Select wie heute. Optional Checkboxen auf Kacheln |
| Detail-Inhalt | Dateiname, `n/N`, Größe, Auflösung, Kamera; WM; Bearbeiten / Undo / QR / Entfernen; bei Multi-Select Batch-Leiste; Session-Summen (Anzahl, Gesamtgröße, WM-Zähler) |
| Doppelung | Foto-`MediaListPanel` im Fotos-Tab **entfernen oder auf eine Zeile Session-Info reduzieren**. Video-Liste unverändert |
| Thumbs | Kacheln = LQ über `photoThumbnailQueue`; Stage/Detail-Preview = `"preview"` nur für Fokus; während Auto-QR Placeholder ok (OPT-11) |
| Virtualisierung | Grid **virtualisieren** (Vorbild `src/lib/virtualList.ts` / LogConsole); Strip bei vielen Fotos ggf. nur sichtbare Thumbs (IntersectionObserver wie heute) |
| Crop/Editor | bleibt Modal (`PhotoEditor`) — nicht ins Detail-Panel |
| i18n | alle neuen Strings in `de` / `en` / `es-MX` |
| Out of Scope | EXIF-Vollanzeige, Lightbox-Fullscreen, Drag-Reorder der Fotos, Video-Tab umbauen, neue Rust-Commands, OPT-Pakete außer Nutzung bestehender Queue |

#### Layout-Skizze

```
┌────────────────────────────────┬─────────────────────┐
│ Toolbar: [Übersicht|Review] …  │                     │
├────────────────────────────────┤  Detail-Panel       │
│                                │  (kleines Preview   │
│  Übersicht: virtualisiertes    │   optional)         │
│  Kachelgrid                    │  Meta + WM +        │
│  — oder —                      │  Aktionen +         │
│  Review: Stage + Strip         │  Session-Summen     │
│                                │  (+ Batch wenn Sel.)│
└────────────────────────────────┴─────────────────────┘
```

#### Scope

- [x] Master–Detail-Split in `PhotoPreview` (oder schlanke Unterkomponenten: `PhotoBrowsePane` + `PhotoDetailPanel`)
- [x] Ansichts-Toggle Übersicht / Review; Zustand speichern (Session)
- [x] Übersicht: responsives Kachelgrid, Virtualisierung, bestehende Strip-Thumb-Logik/Queue wiederverwenden
- [x] Review: bestehende Stage + Prev/Next + Strip beibehalten (ggf. kompakter), Meta nach rechts verschieben
- [x] Detail-Panel: Meta + Aktionen aus den heutigen Karten umziehen; Batch-Leiste bei Multi-Select
- [x] Fokus vs. Select UX beibehalten (Tastatur, Shift/Ctrl)
- [x] `WorkflowLayout`: Foto-`MediaListPanel` entfernen/verschlanken (kein Doppel-UI)
- [x] Nach Import: Fokus sinnvoll setzen, Grid/Strip zum Fokus scrollen
- [x] i18n-Keys für Toggle, Panel-Titel, leere Zustände
- [ ] Manuell: 1 Foto, ~10 Fotos, 30+ Fotos; Multi-Select Batch; WM; QR; Bearbeiten; schmales Fenster

#### Nicht tun

- Kein neues Thumbnail-Backend / keine Base64-Thumbs zurück
- Kein Parallel-Render aller Full-Res-Bilder im Grid
- Phase 23.1 / Encode / AMS nicht anfassen
- Keine Änderungen am Legacy-Projekt

#### Agent-Prompt

```
Implementiere Phase 28 aus @docs/IMPLEMENTATION_PLAN.md
Regeln: @AGENTS.md
Nur Phase 28 (Fotos Master–Detail: Übersicht/Review + Detail rechts).
MediaListPanel für Fotos entdoppeln. Thumbs weiter über photoThumbnailQueue.
i18n de/en/es-MX. Danach npm run check (und bei Bedarf cargo test).
Manuell: npm run tauri dev — 1 / 10 / 30+ Fotos, Multi-Select, WM, QR, Edit.
```

#### Referenzen

```
src/components/PhotoPreview.tsx
src/components/app/WorkflowLayout.tsx
src/components/MediaListPanel.tsx
src/store/photoStore.ts
src/lib/photoThumbnailQueue.ts
src/lib/virtualList.ts                 # Grid-Virtualisierung Vorbild
src/components/LogConsole.tsx          # Virtual-List-Nutzung
src/locales/de.json | en.json | es-MX.json
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
  "usb_camera_import_enabled": false,
  "setup_completed": false
}
```

`usb_camera_import_enabled` (Phase 23): MTP/WPD-Import für allowlistete Action-Cams (GoPro/DJI/Insta360); default `false` bis Windows-Abnahme, danach ggf. `true`.

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
| 9 | Video schneiden/teilen/drehen |
| 20 | Foto drehen, Undo, Auswahl-Batch |
| 10 | SMB-Upload, Update-Check |
| 13 | macOS: VT encode, SD `/Volumes`, DMG |
| 15 | Linux: AppImage, FFmpeg sidecar, SD mounts, SMB, Updater |
| 25 | Manuell/ID + AMS online: IDs eingeben → Name/Medien füllen, Form sperren; offline: manuell weiter |
| 28 | Fotos-Tab: Übersicht/Review-Toggle; Klick → Detail rechts; 30+ Fotos Grid flüssig; kein doppeltes MediaListPanel |

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
| 20 | Medien-Bearbeitung: Drehen | ✅ |
| 21 | Foto-Zuschnitt (Crop) | ✅ |
| 21.1 | Crop-Settle UX | ✅ |
| 22 | macOS Titlebar-Align & Dialog-Zentrierung | ✅ |
| 23 | USB-Action-Cams (MTP) GoPro/DJI/Insta360 | 🔄 |
| 23.0 | MTP-Allowlist (plattformneutral) | ✅ |
| 23.1 | Windows WPD/MTP + Staging | ✅ |
| 23.2 | macOS USB-Detect (system_profiler) + Hinweis | ✅ |
| 23.2b | macOS Image Capture Staging-Import | ✅ |
| 23.2c | ICA UI-Perf (Main-Thread / Katalog-Ticks) | ✅ |
| 23.2d | Leere Kataloge (WARN + Confirm-Label) | ✅ |
| 23.2e | ICA-Browser überlebt Auswerfen / Replug | ✅ |
| 23.3 | Linux libmtp | ⬜ |
| 23.4 | UX & Docs | ⬜ |
| 24 | AMS-Nachreichen (Append-Handoff) | ✅ |
| 25 | AMS-Lookup Autofill (Manuell / ID) | ✅ |
| 27 | Encode-Profil & Reencode-Confirm UX | ✅ |
| 28 | Fotos-Tab Master–Detail (Übersicht / Review) | ✅ |

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

*Letzte Aktualisierung: 2026-08-20 · Projekt: Aero Tandem Studio v2 · Phase 28 Fotos Master–Detail erledigt*
