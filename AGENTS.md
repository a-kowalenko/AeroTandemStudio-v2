# Aero Tandem Studio v2 — Agent Rules

## Hauptdokument

**Implementierungsplan:** `@docs/IMPLEMENTATION_PLAN.md`  
**Architektur:** `@docs/ARCHITECTURE.md`  
**Migration-Mapping:** `@docs/MIGRATION.md`  
**macOS Build:** `@docs/MACOS_BUILD.md`  
**Linux Build:** `@docs/LINUX_BUILD.md`

In jedem neuen Kontextfenster `@docs/IMPLEMENTATION_PLAN.md` referenzieren und **nur eine Phase** implementieren.

---

## Stack

Tauri 2 + Rust + React 19 + TypeScript + FFmpeg sidecar

Tailwind + shadcn/ui, Zustand, SQLite — eingeführt ab Phase 5. Player: HTML5 (Phase 9); libmpv später optional.

---

## Regeln

- **NIEMALS** Dateien im Legacy-Projekt ändern (nur lesen)
- Video-Verarbeitung **NUR** über FFmpeg CLI in Rust — kein MoviePy, kein Python
- Hardware-Encoding: NVENC (Windows + Linux), VideoToolbox (macOS), Fallback libx264
- FFmpeg-Command-Generierung braucht **Rust Unit-Tests**
- Nach Änderungen: `cargo test` und `npm run tauri dev`
- **Eine Phase pro Session** — Scope nicht erweitern
- Verhalten aus Legacy portieren, nicht 1:1 copy-pasten
- Plattformen: **Windows + macOS + Linux** (AppImage; siehe `docs/LINUX_BUILD.md`)

---

## Projektpfade

| | Pfad |
|---|------|
| v2 (editieren) | `C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio-v2` |
| Legacy (NUR LESEN) | `C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio` |

---

## Legacy-Referenz (NUR LESEN)

Basis: `C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio`

### Kern-Dateien

| Legacy | v2 Modul | Phase |
|--------|----------|-------|
| `src/utils/hardware_acceleration.py` | `src-tauri/src/video/hw_accel.rs` | 0 |
| `src/video/concat_utils.py` | `src-tauri/src/video/concat.rs` | 1 |
| `src/video/processor.py` | `src-tauri/src/video/processor.rs` | 3 |
| `src/video/parallel_processor.py` | `src-tauri/src/video/parallel.rs` | 4 |
| `src/video/qr_analyser.py` | `src-tauri/src/qr/analyser.rs` | 6 |
| `src/utils/sd_card_monitor.py` | `src-tauri/src/sd_card/monitor.rs` | 7 |
| `src/utils/config.py` | `src-tauri/src/storage/config.rs` | 5 |
| `src/model/kunde.py` | `src-tauri/src/model/kunde.rs` | 5 |
| `src/gui/components/sd_file_selector_dialog.py` | `src/components/SdFileSelector.tsx` | 7 |
| `src/gui/components/drag_drop.py` | `src/components/VideoDropZone.tsx` | 2 |

Vollständiges Mapping: `@docs/MIGRATION.md`

### Legacy-Pfade für @-Referenzen

```
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\hardware_acceleration.py
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\processor.py
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\video\concat_utils.py
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\sd_card_monitor.py
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\utils\config.py
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio\src\model\kunde.py
```

---

## Aktueller Stand

- ✅ Tauri 2 Scaffold (React + TypeScript)
- ✅ `npm run tauri dev` funktioniert
- ✅ Phase 0: FFmpeg-Grundgerüst
- ✅ Phase 1: Concat & Trim
- ✅ Phase 2: Video-Liste & Drag & Drop
- ✅ Phase 3: Intro-Pipeline & Encoding
- ✅ Phase 4: Paralleles Encoding & Fortschritt
- ✅ Phase 5: Config, Kundenmodell & Basis-UI
- ✅ Phase 6: QR-Code-Erkennung
- ✅ Phase 7: SD-Karten Monitor & Dateiauswahl
- ✅ Phase 8: Video-Vorschau (Preview-Encode, VideoPreview, PhotoPreview)
- ✅ Phase 9: Player & Cutter (HTML5 VideoPlayer, VideoCutter, cut/split, Pending Cuts)
- ✅ Phase 10: SMB-Upload & Auto-Update (smb2 client, Server-Status, Updater-Stub)
- ✅ Phase 11: App-Shell, Splash, Cache-Cleanup, Logging, Session-Reset
- ✅ Phase 12: Vorgang Erstellen & Legacy-Export (Ordner, Marker, WM, Upload)
- ✅ Phase 13: macOS Build & Plattform-Tests (FFmpeg mac, VideoToolbox/SD/SMB Fixes, CI, Entitlements, Signing-Docs)
- ✅ Import Working-Folder: Medien werden beim Import in `aero_studio_preview_*` kopiert; Cuts treffen nur Kopien
- ✅ Phase 15: Linux Build & Plattform-Parity (static FFmpeg, fontfile, NVENC, SD-Heuristik, AppImage-Updater, Ubuntu CI)
- ✅ Phase 16: First-Run Setup-Wizard (`setup_completed`, Theme/Pfade/Backup/Server, Skip, Reset → Wizard; Intro default aus)
- ✅ Phase 17: QR-Treffer-Preview (Spotlight im SuccessDialog; rxing-Punkte + Hit-Frame)

**Nächster Schritt:** optional Phase 14 — ML Foto-Klassifikation (Backlog) aus `@docs/IMPLEMENTATION_PLAN.md`  
*(oder manuelle Linux-VM-Abnahme laut `docs/LINUX_BUILD.md`)*

---

## Schnell-Prompt für Agent

```
Implementiere Phase X aus @docs/IMPLEMENTATION_PLAN.md
Regeln: @AGENTS.md
Legacy: [Pfade aus Phase X im Plan]
Nur Phase X. Danach cargo test && npm run tauri dev.
```

**Phase 15 (Linux):** Prompt in `@docs/LINUX_BUILD.md` (Abschnitt „Agent prompt“) verwenden.
