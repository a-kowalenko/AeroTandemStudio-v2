# Aero Tandem Studio v2 — Architektur

> Kurzübersicht. Details: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

## Stack

| Schicht | Technologie |
|---------|-------------|
| Shell | Tauri 2 |
| Backend | Rust (`src-tauri/`) |
| Frontend | React 19 + TypeScript (`src/`) |
| Video | FFmpeg CLI Sidecar |
| Player | HTML5 (Phase 9); libmpv später optional |
| Storage | SQLite (ab Phase 5) |
| SMB Upload | `smb2` crate (Phase 10) |
| Auto-Update | Tauri Updater Plugin (Endpoint-Stub bis Production-Feed) |
| Plattformen | Windows 10+, macOS, Linux |

## Window Chrome

Custom titlebar (Phase 11 polish):

- **Windows / Linux:** `decorations: false` at create time (`tauri.conf.json`) + Min/Max/Close in `AppChrome` (`src/components/chrome/`). Startup clamps the window to the monitor work area (`src-tauri/src/util/window_fit.rs`) so the bottom edge cannot sit below the taskbar.
- **macOS:** `tauri.macos.conf.json` sets `decorations` + `titleBarStyle: Overlay` + `hiddenTitle` at create time (no false→true toggle) + left inset; no custom close buttons
- Rollback: `localStorage.setItem('ats-custom-titlebar', '0')` then reload

## Projektstruktur

```
AeroTandemStudio-v2/
├── src/                        # React Frontend
│   ├── App.tsx
│   ├── components/
│   ├── hooks/
│   ├── store/
│   └── lib/
├── src-tauri/
│   ├── src/
│   │   ├── video/              # FFmpeg, Encoding, Concat
│   │   ├── qr/                 # QR-Scan
│   │   ├── sd_card/            # SD-Monitor + MTP/USB (Allowlist, macOS ICA, Windows WPD)
│   │   ├── storage/            # Config, History
│   │   ├── smb/                # Upload
│   │   ├── model/              # Kunde, Validation
│   │   └── commands/           # Tauri IPC
│   └── resources/
│       ├── ffmpeg/win/         # ffmpeg.exe
│       └── assets/               # hintergrund.png, logo.png
├── docs/
│   ├── IMPLEMENTATION_PLAN.md  # ← Hauptdokument
│   ├── ARCHITECTURE.md         # ← Dieses Dokument
│   └── MIGRATION.md
└── AGENTS.md
```

## Datenfluss

```
User (React UI)
    │ invoke("create_video", { kunde, paths })
    ▼
Tauri Command (Rust)
    │ processor.create(kunde, paths)
    ▼
FFmpeg Pipeline
    ├── Intro generieren (Overlay)
    ├── Clips normalisieren (1080p@30fps)
    ├── Concat
    └── Export → output.mp4
    │ Events: encode-progress
    ▼
React UI (Fortschrittsbalken)
```

## Legacy-Referenz

```
C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio
```

Nur lesen — niemals editieren. Siehe `AGENTS.md` und `MIGRATION.md`.

## Hardware-Encoding

| Plattform | Encoder | FFmpeg-Flag |
|-----------|---------|-------------|
| Windows (NVIDIA) | NVENC | `h264_nvenc` |
| Windows (Intel) | QuickSync | `h264_qsv` |
| Windows (AMD) | AMF | `h264_amf` |
| macOS | VideoToolbox | `h264_videotoolbox` |
| Fallback | Software | `libx264` |

## Config-Speicherort

- Windows: `%LOCALAPPDATA%\AeroTandemStudio\`
- macOS: `~/Library/Application Support/AeroTandemStudio/`
