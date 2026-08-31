# Legacy → v2 Migration Mapping

> **Archiv.** Migration ist abgeschlossen — v2 ist Source of Truth.  
> Dieses Dokument nur bei gezieltem Nachschlagen (welche Legacy-Datei wofür war).  
> **Nicht** in Agent-Prompts anhängen. Vollständiger Plan: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

## Legacy-Basis-Pfad (Archiv, optional)

```
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio
```

## Status-Legende

- ⬜ Offen
- 🔄 In Arbeit
- ✅ Erledigt
- ⏭️ Nicht portieren

---

## Video & Encoding

| Status | Legacy | v2 (Rust) |
|--------|--------|-----------|
| ✅ | `src/utils/hardware_acceleration.py` | `src-tauri/src/video/hw_accel.rs` (NVENC / VideoToolbox / libx264) |
| ✅ | `src/video/logger.py` | `src-tauri/src/video/progress.rs` |
| ✅ | `src/video/concat_utils.py` | `src-tauri/src/video/concat.rs` |
| ✅ | `src/video/processor.py` | `src-tauri/src/video/processor.rs` + `export_job.rs` / `export_paths.rs` / `marker.rs` / `watermark.rs` |
| ✅ | `src/video/parallel_processor.py` | `src-tauri/src/video/parallel.rs` |
| ✅ | `src/video/cutter_service.py` | `src-tauri/src/video/cutter.rs` |
| ✅ | `src/utils/encoding_quality.py` | `src-tauri/src/video/encoding_quality.rs` |
| ✅ | `src/utils/preview_encode_target.py` | `src-tauri/src/video/preview_encode.rs` |
| ⏭️ | `src/video/processor_old_backup.py` | — |

## QR & Medien

| Status | Legacy | v2 (Rust) |
|--------|--------|-----------|
| ✅ | `src/video/qr_analyser.py` | `src-tauri/src/qr/analyser.rs` |
| ✅ | `src/video/qr_parallel_allocator.py` | `src-tauri/src/qr/parallel.rs` |
| ✅ | `src/utils/media_datetime.py` | `src-tauri/src/media/datetime.rs` |
| ✅ | `src/utils/dji_media_paths.py` | `src-tauri/src/media/dji_paths.rs` |
| ✅ | `src/utils/photo_thumbnail.py` | `src-tauri/src/media/thumbnail.rs` |
| ✅ | `src/utils/natural_sort.py` | `src-tauri/src/util/natural_sort.rs` |

## SD-Karten & Storage

| Status | Legacy | v2 (Rust) |
|--------|--------|-----------|
| ✅ | `src/utils/sd_card_monitor.py` | `src-tauri/src/sd_card/monitor.rs` (Win + macOS `/Volumes`) |
| ✅ | `src/utils/media_history.py` | `src-tauri/src/storage/media_history.rs` |
| ✅ | `src/utils/config.py` | `src-tauri/src/storage/config.rs` |
| ✅ | `src/utils/cache_cleanup.py` | `src-tauri/src/storage/cache.rs` |
| ✅ | *(neu Phase 11)* Logging | `src-tauri/src/storage/logging.rs` (`app.log`) |
| ✅ | `src/utils/file_times.py` | `src-tauri/src/util/file_times.rs` |

## Netzwerk & Installer

| Status | Legacy | v2 |
|--------|--------|-----|
| ✅ | `src/utils/file_utils.py` (SMB) | `src-tauri/src/smb/client.rs` |
| ✅ | `src/installer/updater.py` | Tauri Updater Plugin (+ Stub) |
| ✅ | `src/installer/ffmpeg_installer.py` | `src-tauri/resources/ffmpeg/` (+ `scripts/download-ffmpeg.mjs`) |
| ✅ | *(neu Phase 13)* macOS Bundle / CI | `docs/MACOS_BUILD.md`, `.github/workflows/build.yml`, `Entitlements.plist`, `Info.plist` |

## Domain

| Status | Legacy | v2 (Rust) |
|--------|--------|-----------|
| ✅ | `src/model/kunde.py` | `src-tauri/src/model/kunde.rs` |
| ✅ | `src/utils/validation.py` | `src-tauri/src/model/validation.rs` |
| ✅ | `src/utils/constants.py` | `src-tauri/src/constants.rs` |
| ⬜ | `src/utils/path_helper.py` | Tauri `path` API |
| ⬜ | `src/utils/file_utils.py` (allgemein) | diverse Rust-Module |

## GUI → React

| Status | Legacy | v2 (React) |
|--------|--------|------------|
| ✅ | `src/gui/app.py` | `src/App.tsx` |
| ✅ | `src/gui/splash_screen.py` | `src/components/SplashScreen.tsx` |
| ✅ | `src/gui/components/drag_drop.py` | `src/components/VideoDropZone.tsx` |
| ✅ | `src/gui/components/form_fields.py` | `src/components/CustomerForm.tsx` |
| ✅ | `src/gui/components/video_preview.py` | `src/components/VideoPreview.tsx` |
| ✅ | `src/gui/components/video_player.py` | `src/components/VideoPlayer.tsx` |
| ✅ | `src/gui/components/video_cutter.py` | `src/components/VideoCutter.tsx` |
| ✅ | `src/gui/components/sd_file_selector_dialog.py` | `src/components/SdFileSelector.tsx` |
| ✅ | `src/gui/components/sd_status_indicator.py` | `src/components/SdStatusIndicator.tsx` |
| ✅ | `src/gui/components/sd_mode_selector.py` | `src/components/SdModeSelector.tsx` |
| ✅ | `src/gui/components/settings_dialog.py` | `src/components/SettingsDialog.tsx` |
| ✅ | `src/gui/components/progress_indicator.py` | `src/components/ProgressIndicator.tsx` |
| ✅ | `src/gui/components/error_dialog.py` | `src/components/ErrorDialog.tsx` |
| ✅ | `src/gui/components/success_dialog.py` | `src/components/SuccessDialog.tsx` |
| ✅ | `src/gui/components/warning_dialog.py` | `src/components/WarningDialog.tsx` |
| ✅ | `src/gui/components/loading_window.py` | `src/components/LoadingOverlay.tsx` |
| ✅ | `src/gui/components/circular_spinner.py` | `src/components/Spinner.tsx` |
| ✅ | `src/gui/components/photo_preview.py` | `src/components/PhotoPreview.tsx` |
| ✅ | `src/gui/components/processed_files_dialog.py` | `src/components/ProcessedFilesDialog.tsx` |
| ✅ | `src/gui/pending_video_cut.py` | `src/hooks/usePendingVideoCuts.ts` |
| ✅ | *(neu Phase 10)* | `src/components/ServerStatusIndicator.tsx` |
| ✅ | *(neu Phase 10)* | `src/components/UpdateDialog.tsx` |
| ⏭️ | `src/gui/components/video_preview_old_backup.py` | — |
