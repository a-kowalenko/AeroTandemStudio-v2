# Plan-Referenz (Mapping, Architektur-Skizze, Config, Tests, Build)

> Ausgelagert aus `IMPLEMENTATION_PLAN.md` zur Context-Schonung.
> Bevorzugt: `docs/ARCHITECTURE.md`, `docs/MIGRATION.md`, `docs/LINUX_BUILD.md`, `docs/MACOS_BUILD.md`.
> Dieses Dokument nur bei Bedarf.

---
## 5. Legacy-Archiv

> Migration abgeschlossen. Dieser Abschnitt + [§6](#6-vollständiges-datei-mapping) sind **historische Referenz**.
> Agent-Sessions: v2-Dateien aus der jeweiligen Phase (Referenzen / Scope) — **kein** Legacy anhängen.
> Erledigte Phasen können noch `Legacy:`-Zeilen in Agent-Prompts enthalten; diese ignorieren.

### Basis-Pfad (optional, manuell)

```
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio
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
  "sd_server_backup_enabled": false,
  "sd_server_backup_url": "",
  "sd_server_backup_mode": "local_then_server_async",
  "sd_backup_mode": "confirm",
  "sd_clear_after_backup": false,
  "sd_auto_import": false,
  "sd_eject_after_workflow": false,
  "sd_eject_sound_enabled": true,
  "sd_skip_processed": false,
  "sd_size_limit_enabled": false,
  "sd_size_limit_mb": 2000,
  "usb_camera_import_enabled": true,
  "setup_completed": false,
  "crew_list": [],
  "crew_removed_names": []
}
```

`usb_camera_import_enabled` (Phase 23): MTP/WPD-Import für allowlistete Action-Cams (GoPro/DJI/Insta360); default `true` auf allen Plattformen.

`sd_eject_sound_enabled` (Phase 41): Ton nach **erfolgreichem** SD/MTP-Auswerfen; default `true`. Nur Success-Pfad in `showSdEjectToast`; kein Fehlerton.

`crew_removed_names` (Phase 36): Tombstones für absichtlich gelöschte Crew-Namen. Beim Load: fehlende Einträge aus `default_crew_list()` add-only mergen, außer Name steht in `crew_removed_names`. Rollen bestehender Einträge nie überschreiben. Factory-Reset leert Tombstones.

`body_concat_mode` (Phase 40): `"compatible"` (Default) \| `"fast"` (naives Concat) \| `"legacy"` (MPEG-TS). Alias `robust` → `legacy` (Bestand); `avidemux` → `compatible`. One-shot fleet preset may force `compatible` once on upgrade.

Config-Pfad:
- Windows: `%LOCALAPPDATA%\AeroTandemStudio\`
- macOS: `~/Library/Application Support/AeroTandemStudio/`
- Linux: `~/.local/share/AeroTandemStudio/` (XDG via `directories`)

---

## 10. Assets & Ressourcen

Frontend-SFX (Phase 41): `public/sounds/eject-ok.mp3` — von Vite/Tauri als `/sounds/eject-ok.mp3` ausgeliefert (nicht unter `src-tauri/resources/`).

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
| 31.1 | Upload an + Server offline → Soft Confirm → lokal erstellen → `upload_state=pending` |
| 31.2 | Historie „Upload nachholen“; Prefight fehlt Datei → Hard fail; Extra-Datei → Warnung; ok → SMB + Handoff |
| 31.3 | Mehrere pending sequentiell; kaputter Ordner skip; Summary; Reconnect ohne Auto-Upload |
| 32 | SMB Quiet-Poll: Status ~45 s + Tab-Focus; kein Flackern; Skip während Upload; Header-Retry laut |
| 33 | Header/Dialog „Vorgänge“ (de) / Jobs / Trabajos; Hints ohne „Historie“; Medien-Confirm unverändert |
| 35 | Bridge `paths-v1`: Suggest bei Default-URL; Backup-Profil; Credentials-Matrix; kein Auto-Overwrite |
| 36 | Update: neuer Default-Name erscheint; gelöschter Name bleibt weg; Rollen bestehender Einträge unverändert |

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
