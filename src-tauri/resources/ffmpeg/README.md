# FFmpeg Sidecar

Bundled FFmpeg CLI used by the Rust video pipeline. Binaries are **not** committed
(see root `.gitignore`); download them locally or via `npm run download-ffmpeg`.

## Layout

| Platform | Path (preferred) | Fallback |
|----------|------------------|----------|
| Windows x64 | `win/ffmpeg.exe` | — |
| macOS Apple Silicon | `mac/arm64/ffmpeg` | `mac/ffmpeg` |
| macOS Intel | `mac/x86_64/ffmpeg` | `mac/ffmpeg` |
| Linux x86_64 | `linux/x86_64/ffmpeg` | `linux/ffmpeg` |

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
| Native host arch | `npm run download-ffmpeg` (Homebrew) |
| Intel (`x86_64`), also when cross-building on Apple Silicon | `FFMPEG_MAC_ARCH=x86_64 npm run download-ffmpeg` → [evermeet.cx](https://evermeet.cx/ffmpeg/) |
| Manual | https://evermeet.cx/ffmpeg/ (Intel) · https://www.osxexperts.net/ (arm64) |

The binary **must** include `h264_videotoolbox` (and ideally `libx264` as fallback):

```bash
./mac/ffmpeg -hide_banner -encoders | grep videotoolbox
```

## Linux

`npm run download-ffmpeg` on Linux installs a **static** x86_64 build (not a PATH
copy of system ffmpeg):

| Priority | Source |
|----------|--------|
| 1 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) `linux64-gpl` (`latest` tag) — libx264, drawtext, h264_nvenc |
| 2 | [johnvansickle](https://johnvansickle.com/ffmpeg/) amd64-static (fallback; typically no NVENC) |

Installs to `linux/x86_64/ffmpeg` and `linux/ffmpeg`. Verify:

```bash
./src-tauri/resources/ffmpeg/linux/x86_64/ffmpeg -hide_banner -encoders | grep -E 'libx264|nvenc'
./src-tauri/resources/ffmpeg/linux/x86_64/ffmpeg -hide_banner -filters | grep drawtext
```

## CI

`.github/workflows/release.yml` runs `npm run download-ffmpeg` before `tauri-action`
on Windows, both Mac targets (`aarch64-apple-darwin`, `x86_64-apple-darwin`), and
Ubuntu (`AppImage`). Mac legs set `FFMPEG_MAC_ARCH` per matrix entry.

## License note

Distribute FFmpeg under the license of the build you ship (LGPL vs GPL). Prefer builds
that match your redistribution policy. Windows essentials and BtbN `*-gpl` are GPL.
