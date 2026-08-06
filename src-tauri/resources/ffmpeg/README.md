# FFmpeg Sidecar

Bundled FFmpeg CLI used by the Rust video pipeline. Binaries are **not** committed
(see root `.gitignore`); download them locally or via `npm run download-ffmpeg`.

## Layout

| Platform | Path (preferred) | Fallback |
|----------|------------------|----------|
| Windows x64 | `win/ffmpeg.exe` | — |
| macOS Apple Silicon | `mac/arm64/ffmpeg` | `mac/ffmpeg` |
| macOS Intel | `mac/x86_64/ffmpeg` | `mac/ffmpeg` |
| Linux | `linux/ffmpeg` | — |

Tauri bundles the whole `resources/ffmpeg/` tree (`tauri.conf.json` → `bundle.resources`).
At runtime `find_ffmpeg` picks the arch-specific binary first, then the fallback.

## Windows

1. Download **ffmpeg essentials** (GPL): https://www.gyan.dev/ffmpeg/builds/
2. Extract `ffmpeg.exe` → `win/ffmpeg.exe`

Or run from the repo root:

```powershell
npm run download-ffmpeg
```

## macOS

1. Prefer a **static** build matching the machine you build on (`arm64` or `x86_64`).
2. Place the binary at `mac/arm64/ffmpeg` or `mac/x86_64/ffmpeg` (or `mac/ffmpeg`).
3. Make it executable:

```bash
chmod +x src-tauri/resources/ffmpeg/mac/ffmpeg
chmod +x src-tauri/resources/ffmpeg/mac/arm64/ffmpeg   # if used
chmod +x src-tauri/resources/ffmpeg/mac/x86_64/ffmpeg  # if used
xattr -dr com.apple.quarantine src-tauri/resources/ffmpeg/mac 2>/dev/null || true
```

### Download options

| Arch | Source |
|------|--------|
| arm64 / x86_64 | `npm run download-ffmpeg` (Homebrew on macOS CI/dev) |
| Manual | https://evermeet.cx/ffmpeg/ (Intel) · https://www.osxexperts.net/ (arm64) |

The binary **must** include `h264_videotoolbox` (and ideally `libx264` as fallback):

```bash
./mac/ffmpeg -hide_banner -encoders | grep videotoolbox
```

## CI

GitHub Actions (`.github/workflows/build.yml`) runs `npm run download-ffmpeg` before
`npm run tauri build` on `windows-latest` and `macos-latest`.

## License note

Distribute FFmpeg under the license of the build you ship (LGPL vs GPL). Prefer builds
that match your redistribution policy.
