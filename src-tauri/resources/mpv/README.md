# mpv / libmpv player backend (OPT-13)

Optional **Cutter / clip-player** backend. When a usable `mpv` binary is found and
config `use_libmpv` is true, `VideoPlayer` drives mpv over JSON-IPC and shows
decoded frames via the loopback media HTTP server. Otherwise the existing
**HTML5** player is used (CI / Dev without mpv).

Playback always uses the **working-copy absolute path** (`loadfile`), not
`asset://` / `media://`. HTML5 still uses Range HTTP for the same files.

## Layout (optional bundle)

| Platform | Binary | Optional libmpv |
|----------|--------|-----------------|
| Windows x64 | `win/mpv.exe` | `win/libmpv-2.dll` (future embed) |
| macOS | `mac/arm64/mpv` or `mac/x86_64/mpv` (or `mac/mpv`) | Homebrew `libmpv.dylib` |
| Linux | `linux/x86_64/mpv` (or `linux/mpv`) | system `libmpv.so.*` |

Also searched: `PATH`, `/opt/homebrew/bin/mpv`, `/usr/bin/mpv`,
`%ProgramFiles%\mpv\mpv.exe`.

Binaries are **not** committed (same idea as FFmpeg). Place them under this tree
or install system mpv for development.

## Dev install

### macOS

```bash
brew install mpv
# verify
mpv --version
```

### Linux (Debian/Ubuntu)

```bash
sudo apt install mpv
# optional for future in-process embed:
sudo apt install libmpv-dev
```

### Windows

1. Download a release build from https://mpv.io/installation/ (or zhongfly /
   shinchiro winbuilds).
2. Copy `mpv.exe` to `src-tauri/resources/mpv/win/mpv.exe`.
3. Optional: copy `libmpv-2.dll` next to it for future libmpv embedding.
4. Or install mpv and ensure it is on `PATH`.

Tauri already bundles `resources/` — add under `tauri.conf.json` →
`bundle.resources` if you ship mpv (currently `resources/ffmpeg/` only; extend
when you vendor mpv for release).

## Config

- `use_libmpv` (default `true`) in app config / Settings → Video → Advanced.
- Disable to force HTML5 even when mpv is present.

## Platform acceptance (OPT-13)

| Platform | Tested | Notes |
|----------|--------|-------|
| macOS (Intel, 2026-08-24) | ✅ | No system mpv → HTML5 fallback; `cargo test` 468 ok; `npm run check` ok |
| Windows | Documented | Bundle `mpv.exe` under `resources/mpv/win/` or PATH for IPC backend |
| Linux | Documented | `apt install mpv`; HTML5 + GStreamer remains fallback |

Scrub feeling (60–180 s clip): with mpv installed, seeks go through JSON-IPC +
JPEG frame refresh (hr-seek); without mpv, prior HTML5 path is unchanged.
Filmstrip prefetch (OPT-7) is independent of the player backend.
