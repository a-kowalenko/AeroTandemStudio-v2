# mpv / libmpv player backend (OPT-13)

Optional **Cutter / clip-player** backend. When a usable `mpv` binary is found and
config `use_libmpv` is true, `VideoPlayer` drives mpv over JSON-IPC and shows
decoded frames via the loopback media HTTP server. Otherwise the existing
**HTML5** player is used (CI / Dev without mpv).

Playback always uses the **working-copy absolute path** (`loadfile`), not
`asset://` / `media://`. HTML5 still uses Range HTTP for the same files.

## Layout (bundled sidecar)

| Platform | Binary | Notes |
|----------|--------|-------|
| Windows x64 | `win/mpv.exe` (+ DLLs in same folder) | First-party mingw zip from mpv releases |
| macOS | `mac/arm64/mpv` + `mac/arm64/lib/` (or `mac/x86_64/…`) | Flattened from GitHub `mpv.app` (`@executable_path/lib`) |
| Linux | `linux/x86_64/mpv` (optional) | No official zip — system `apt install mpv` |

Also searched: `PATH`, `/opt/homebrew/bin/mpv`, `/usr/bin/mpv`,
`%ProgramFiles%\mpv\mpv.exe`.

Binaries are **not** committed (same idea as FFmpeg). Download for the host:

```bash
npm run download-mpv
# CI / Intel Mac on arm64 runner:
MPV_MAC_ARCH=x86_64 npm run download-mpv
# pin release:
MPV_TAG=v0.41.0 npm run download-mpv
```

Tauri bundles `resources/mpv/` (`tauri.conf.json` → `bundle.resources`). Release CI
runs `download-mpv` before `tauri-action` (Win + both Mac arches; Linux step is a no-op).

macOS note: official CI zips contain `mpv.tar.gz` → `mpv.app`. The download script
extracts **only** `Contents/MacOS/mpv` and `Contents/MacOS/lib/` (enough for
`--vo=null` IPC). A relative `mac/mpv` → `<arch>/mpv` symlink is added for detect fallback.

## Dev install (alternative)

### macOS

```bash
npm run download-mpv
# or: brew install mpv
mpv --version
```

### Linux (Debian/Ubuntu)

```bash
sudo apt install mpv
# optional for future in-process embed:
sudo apt install libmpv-dev
```

### Windows

```powershell
npm run download-mpv
```

Or download from https://mpv.io/installation/ / [mpv releases](https://github.com/mpv-player/mpv/releases)
and copy `mpv.exe` **plus companion DLLs** into `src-tauri/resources/mpv/win/`.

## Config

- `use_libmpv` (default `true`) in app config / Settings → Video → Advanced.
- Disable to force HTML5 even when mpv is present.

## License

mpv and its bundled libraries are covered by GPL / LGPL and other licenses from
upstream. Redistribution of the sidecar follows the same terms as shipping the
[official CI release zips](https://github.com/mpv-player/mpv/releases). Keep the
upstream copyright notices with any redistributed binaries.

## Platform acceptance (OPT-13 + sidecar)

| Platform | Tested | Notes |
|----------|--------|-------|
| macOS (Intel, 2026-08-25) | ✅ | `npm run download-mpv` → flat `mac/x86_64/mpv`+`lib/`; detect IPC; `cargo test` player::detect ok |
| Windows | Documented | `download-mpv` → `win/mpv.exe` + DLLs; bundled in release |
| Linux | Documented | system `mpv` or manual `linux/x86_64/mpv`; HTML5 fallback |

Scrub feeling (60–180 s clip): with mpv installed, seeks go through JSON-IPC +
JPEG frame refresh (hr-seek); without mpv, prior HTML5 path is unchanged.
Filmstrip prefetch (OPT-7) is independent of the player backend.
