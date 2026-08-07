# Linux Build & Plattform-Parity

Phase 15 guide for shipping Aero Tandem Studio as a fully functional Linux desktop
app (feature parity with Windows / macOS). Local builds and CI produce an
**AppImage** (optional `.deb`); Flatpak/Snap are out of scope for v1.

Plan checklist: `docs/IMPLEMENTATION_PLAN.md` → Phase 15.

---

## Goals (v1)

- Target: **x86_64-unknown-linux-gnu**
- Bundle: **AppImage** primary; `.deb` optional
- Bundled FFmpeg under `resources/ffmpeg/linux/…` (not a PATH copy of system ffmpeg)
- Encoding: **NVENC** when available, else **libx264** (VAAPI = backlog)
- SD mounts, SMB upload, in-app updater for AppImage
- No breaking changes for Win/Mac users

### Non-goals (v1)

- Flatpak / Snap (sandbox blocks SD, SMB, arbitrary paths)
- Distro package repos, aarch64 Linux, Apple-style code signing
- VAAPI hardware encode parity

---

## Prerequisites (Ubuntu 22.04 / 24.04)

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  fonts-dejavu-core
```

Also:

- Rust stable (`rustup`)
- Node.js LTS + npm
- FFmpeg sidecar: `npm run download-ffmpeg` (after Phase 15 download script ships a static binary)

Optional for NVENC testing: NVIDIA driver + `nvidia-smi`; FFmpeg sidecar must list `h264_nvenc`.

---

## Local build

```bash
cd AeroTandemStudio-v2
npm install
npm run download-ffmpeg
npm run test:rust          # or: cd src-tauri && cargo test
npm run tauri build -- --bundles appimage
# optional:
# npm run tauri build -- --bundles appimage,deb
```

Output (typical):

- `src-tauri/target/release/bundle/appimage/*.AppImage`
- `src-tauri/target/release/bundle/deb/*.deb` (if requested)

Run the AppImage:

```bash
chmod +x path/to/*.AppImage
./path/to/*.AppImage
```

### Dev loop

```bash
npm run download-ffmpeg
npm run tauri dev
```

---

## FFmpeg sidecar

### Layout (target after Phase 15)

| Arch | Preferred path | Fallback |
|------|----------------|----------|
| Linux x86_64 | `linux/x86_64/ffmpeg` | `linux/ffmpeg` |

Tauri bundles `resources/ffmpeg/` (`tauri.conf.json` → `bundle.resources`).
Runtime resolution: `src-tauri/src/video/ffmpeg.rs` (`platform_subdir()` → `"linux"`).

### Current gap

`scripts/download-ffmpeg.mjs` → `installLinux()` currently copies `which ffmpeg`.
That is **not** release-safe (shared libs, missing encoders, host drift).

### Required implementation

1. Download a **static** (or fully self-contained) Linux x64 build that includes at least:
   - `libx264`
   - `drawtext` (+ fontconfig or rely on bundled `fontfile`)
   - ideally `h264_nvenc` when redistributing an NVIDIA-capable build is acceptable
2. Install to `src-tauri/resources/ffmpeg/linux/x86_64/ffmpeg` (and/or `linux/ffmpeg`)
3. `chmod +x`
4. Document license (LGPL vs GPL) in `resources/ffmpeg/README.md` — same policy as Windows essentials

Verify:

```bash
./src-tauri/resources/ffmpeg/linux/x86_64/ffmpeg -hide_banner -encoders | grep -E 'libx264|nvenc'
./src-tauri/resources/ffmpeg/linux/x86_64/ffmpeg -hide_banner -filters | grep drawtext
```

Suggested sources (pick one and pin URL/version in the download script): johnvansickle static builds, BtbN GitHub releases, or a project-controlled mirror.

---

## Hardware encoding

| Priority | Encoder | Detection |
|----------|---------|-----------|
| 1 | `h264_nvenc` / `hevc_nvenc` | `nvidia-smi` OK + encoder listed in sidecar |
| 2 | `libx264` | always (fallback) |
| — | VAAPI | backlog only |

Today `has_nvidia_gpu()` is `#[cfg(windows)]` (PowerShell + `nvidia-smi`).
For Linux: enable the **`nvidia-smi`** branch under `#[cfg(any(windows, target_os = "linux"))]` and keep the PowerShell path Windows-only.

Unit tests for NVENC/libx264 arg building stay platform-agnostic.

---

## Fonts / Intro `drawtext`

Today Linux uses font **name** `DejaVu Sans` without `fontfile=` — fragile on minimal systems.

### Required approach

1. Resolve a real `.ttf` path, e.g.:
   - `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`
   - `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`
   - optional bundled: `resources/assets/fonts/DejaVuSans.ttf`
2. On Linux, prefer FFmpeg `fontfile=…` in the drawtext filter (escape paths correctly).
3. Keep Windows / macOS behavior unchanged (`font=` / system names).
4. Add unit tests for path selection and escaping.

Dev packages: `fonts-dejavu-core`. For releases, a bundled TTF is the robust default.

---

## SD card monitor

Existing Unix path: scan `/media`, `/run/media`, `/mnt` (`unix_media_mounts` in `sd_card/monitor.rs`).

### Harden for production

- Prefer user mounts: `/run/media/$USER/<label>`, `/media/$USER/<label>`
- Reduce false positives (random `/mnt/data` with DCIM)
- Optionally consult `/proc/mounts` and `/sys/block/<dev>/removable`
- Keep DCIM / action-cam heuristics aligned with Win/Mac
- Add pure unit tests (string/path filters), mirroring `is_macos_volume_candidate`

Manual check: insert USB/SD with DCIM → insert event → import/backup UI.

---

## Paths & config

| Item | Linux location |
|------|----------------|
| App config / SQLite | `~/.local/share/AeroTandemStudio/` (`directories` → `data_local_dir`) |
| Working / preview copies | existing Unix temp / session logic |

No config schema migration. Document XDG path in Settings/docs if user-facing.

---

## SMB

`smb2` client is already cross-platform (`src-tauri/src/smb/client.rs`).

Acceptance:

- Connection test: Guest (empty login) and user/password
- Upload of a small export folder to the same NAS used on Windows
- Local path targets (already supported) still work

Fix only if Linux-specific auth/path bugs appear — no rewrite.

---

## Updater

Today Linux stubs:

- `pick_installer_url` → `None`
- `launch_installer` → error (“nicht unterstützt”)

### Required

1. Prefer release assets ending in `.AppImage` (optional arch token in filename)
2. Download to temp, `chmod +x`, spawn / replace per chosen UX
3. Align with Tauri updater artifacts + `latest.json` when `createUpdaterArtifacts` is enabled
4. Win/Mac asset selection must keep ignoring Linux files

Document user expectation: replace/relaunch AppImage (AppImageUpdate optional later).

---

## Tauri bundle notes

- Prefer explicit `--bundles appimage` (and optional `deb`) in docs/CI
- No App Sandbox — arbitrary folders, SD mounts, SMB required (same rationale as macOS entitlements)
- Icons: existing PNG set is enough for AppImage
- Capabilities (`capabilities/default.json`): dialog, opener, updater — smoke-test on Linux

---

## CI / Release

Extend `.github/workflows/release.yml` matrix:

```yaml
- platform: ubuntu-22.04   # pin for WebKitGTK predictability
  args: ""
  ffmpeg_arch: x86_64
```

Job steps (in addition to Node/Rust):

1. Install apt build deps (see Prerequisites)
2. `npm ci`
3. `npm run download-ffmpeg`
4. `tauri-apps/tauri-action` with AppImage (optional deb)
5. Upload artifacts to the public releases repo (same flow as Win/Mac)
6. Ensure updater JSON includes Linux entry when signing secrets are present

Optional: run `cargo test` on Ubuntu so Linux `cfg` branches are exercised in CI.

PR workflow (`.github/workflows/test.yml`) may stay Windows-only for speed; full Linux verification is release + local.

---

## Manual checklist (release Linux)

- [ ] Apt deps installed on build machine / CI image
- [ ] `npm run download-ffmpeg` → static binary under `linux/x86_64/`
- [ ] `cargo test` / `npm run test:rust`
- [ ] `npm run tauri build -- --bundles appimage`
- [ ] Launch AppImage; UI loads
- [ ] Intro encode shows umlauts (fontfile OK)
- [ ] Settings / HW info: NVENC or software fallback as expected
- [ ] SD/USB with DCIM detected; import works
- [ ] Preview + full encode
- [ ] Cut / pending cuts
- [ ] SMB test + upload
- [ ] Updater picks `.AppImage` from a test release (if shipped)
- [ ] Upload AppImage (+ `.sig` if used) to release endpoint

---

## Implementation order (recommended)

1. FFmpeg download + path layout + tests  
2. Fonts (`fontfile`) + NVENC Linux detection  
3. SD mount hardening + tests  
4. Updater AppImage pick/launch  
5. CI matrix + docs polish (`README` ffmpeg, `AGENTS.md` platform line)

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `webkit` / linker errors at build | Missing GTK/WebKit deps | Install Prerequisites apt packages |
| AppImage won’t start | Missing `chmod +x` / FUSE | `chmod +x`; install `libfuse2` on older hosts if needed |
| Encode fails / no x264 | System ffmpeg copied into resources | Use static sidecar download |
| Intro text missing | Font not found | Bundle TTF + `fontfile=` |
| SD never appears | Mount outside scanned roots | Check `/run/media/$USER`; harden monitor |
| Updater “nicht unterstützt” | Linux stubs still present | Implement pick/launch for AppImage |
| NVENC not selected | Detection Windows-only or sidecar without nvenc | Extend `hw_accel`; ship capable FFmpeg |

---

## Related

- Plan: `docs/IMPLEMENTATION_PLAN.md` Phase 15  
- macOS mirror: `docs/MACOS_BUILD.md`  
- FFmpeg layout: `src-tauri/resources/ffmpeg/README.md`  
- Release / updater: `docs/RELEASE.md`, `.github/workflows/release.yml`  
- Key code: `ffmpeg.rs`, `hw_accel.rs`, `processor.rs`, `sd_card/monitor.rs`, `updater/mod.rs`, `scripts/download-ffmpeg.mjs`

---

## Agent prompt (copy into a new context window)

```
Implementiere Phase 15 — Linux Build & Plattform-Parity aus @docs/IMPLEMENTATION_PLAN.md
vollständig und sauber (Feature-Parity Win/Mac).

Regeln: @AGENTS.md
Ausführlicher Guide: @docs/LINUX_BUILD.md
Spiegel-Struktur: @docs/MACOS_BUILD.md

Scope NUR Phase 15 — kein Phase-14-ML, keine Flatpak/Snap, kein VAAPI außer als klar markierter optionaler Stub.

Umsetzen:
1) FFmpeg: download-ffmpeg.mjs → statisches linux/x86_64 Binary; find_ffmpeg + README + Unit-Tests
2) Fonts: Linux fontfile-Auflösung für Intro-drawtext (Win/Mac unverändert); Tests
3) hw_accel: NVENC-Detection auch unter Linux via nvidia-smi
4) SD-Monitor härten + Unit-Tests für Mount-Heuristik
5) Updater: AppImage pick_installer_url + launch_installer
6) release.yml: ubuntu-Job mit Apt-Deps, download-ffmpeg, AppImage-Upload
7) Docs: LINUX_BUILD.md Checklisten abhaken wo erledigt; AGENTS.md Plattform/HW-Zeile; ffmpeg README

Breaking Changes für Win/Mac vermeiden (additiv).
Danach: cargo test && npm run check (soweit vorhanden). tauri build für Linux nur wenn Runner/Umgebung Linux ist — sonst Code+CI so vorbereiten, dass der Ubuntu-Release-Job grün werden kann.

Am Ende: kurze Zusammenfassung was gebaut wurde und was manuell auf einer Linux-VM noch zu prüfen ist.
```
