# macOS Build, Code Signing & Notarization

Phase 13 guide for shipping Aero Tandem Studio as a signed `.app` / `.dmg`.
Local unsigned builds work without Apple secrets; distribution to other Macs
requires **Developer ID** signing + notarization.

## Prerequisites

- macOS 11+ with Xcode Command Line Tools
- Rust (`rustup`), Node.js LTS, npm
- FFmpeg sidecar: `npm run download-ffmpeg` (or place binary under `src-tauri/resources/ffmpeg/mac/`)
- Optional: Apple Developer Program membership for signing / notarization

## Local build (unsigned / ad-hoc)

```bash
cd AeroTandemStudio-v2
npm install
npm run download-ffmpeg
npm run tauri build -- --bundles app,dmg
```

Output:

- `src-tauri/target/release/bundle/macos/*.app`
- `src-tauri/target/release/bundle/dmg/*.dmg`

Ad-hoc signing (`signingIdentity: "-"`) is enough for local testing. Gatekeeper
will still warn when opening the app on another machine until notarized.

### One-click local release test (`build:mac`)

For **release-parity** performance on this Mac (not `tauri dev`), use:

```bash
npm run build:mac
```

Same as CI for the host arch: static FFmpeg sidecar, Cargo release, `.app` only.
Without `TAURI_SIGNING_PRIVATE_KEY`, uses `tauri.conf.ci.json` (no updater artifacts).

After the build the script:

1. Ad-hoc codesigns with `Entitlements.plist` (stable TCC identity)
2. Installs to `/Applications/Aero Tandem Studio.app` (replaces existing)
3. Opens the installed app

Do **not** test from `target/.../bundle/macos/` — macOS Local Network / mDNS
treats that path as a different app than `/Applications`, so Bridge discovery
and SMB often fail while `tauri dev` and the Release install work.

| Host | FFmpeg | Target | Bundle output (then copied) |
|------|--------|--------|-------------------------------|
| Intel | `x86_64` | `x86_64-apple-darwin` | `src-tauri/target/x86_64-apple-darwin/release/bundle/macos/*.app` |
| Apple Silicon | `arm64` | `aarch64-apple-darwin` | `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/*.app` |

Overrides:

- `MAC_BUILD_ARCH=x86_64` (or `arm64`)
- `MAC_INSTALL_DIR=$HOME/Applications` — alternate install location
- `MAC_SKIP_INSTALL=1` — leave app only under `target/…` (not recommended)

RustRover: Run configuration **Build macOS** → npm script `build:mac`.

**Local Network:** `Info.plist` declares `NSLocalNetworkUsageDescription` and
`NSBonjourServices` (`_ams-bridge._tcp`). On first Bridge search, allow access in
System Settings → Privacy & Security → Local Network if prompted.

### Explicit architecture (CI / Intel)

Release CI builds **both** targets on `macos-latest` (arm64 host):

| Target | FFmpeg (static) | Command |
|--------|-----------------|---------|
| Apple Silicon | martin-riedl.de → `mac/arm64/` | `tauri build -- --target aarch64-apple-darwin` |
| Intel | evermeet.cx → `mac/x86_64/` | `tauri build -- --target x86_64-apple-darwin` |

Do **not** copy Homebrew `ffmpeg` into the bundle — it links `/opt/homebrew` dylibs and
breaks on other Macs (`could not parse video stream` on import).

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# Apple Silicon (static arm64 sidecars)
FFMPEG_MAC_ARCH=arm64 npm run download-ffmpeg
npm run tauri build -- --target aarch64-apple-darwin --bundles app,dmg

# Intel from Apple Silicon host (cross-compile)
FFMPEG_MAC_ARCH=x86_64 npm run download-ffmpeg
npm run tauri build -- --target x86_64-apple-darwin --bundles app,dmg
```

Artifacts are named with `aarch64` / `x64` so the in-app updater can pick the matching DMG.

## Entitlements & Info.plist

| File | Purpose |
|------|---------|
| `src-tauri/Entitlements.plist` | Hardened Runtime: JIT for WKWebView, disable library validation for FFmpeg sidecar. **No App Sandbox** (SD `/Volumes`, arbitrary folders, SMB). |
| `src-tauri/Info.plist` | Usage strings for removable / network volumes, Documents/Downloads, **Local Network** + Bonjour `_ams-bridge._tcp`. Merged by Tauri into the bundle. |

Configured in `tauri.conf.json` → `bundle.macOS.entitlements`.

## Code signing (Developer ID)

1. Create a **Developer ID Application** certificate in your Apple Developer account.
2. Install it in Keychain Access on the build Mac.
3. Either set in `tauri.conf.json`:

```json
"macOS": {
  "signingIdentity": "Developer ID Application: Your Name (TEAMID)",
  "entitlements": "./Entitlements.plist"
}
```

Or export for the build shell (preferred in CI):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
```

4. Rebuild: `npm run tauri build -- --bundles dmg`

## Notarization

Tauri notarizes automatically during `tauri build` when credentials are present.

### Option A — App Store Connect API key (recommended for CI)

```bash
export APPLE_API_ISSUER="<issuer-uuid>"
export APPLE_API_KEY="<key-id>"
export APPLE_API_KEY_PATH="/path/to/AuthKey_XXXXX.p8"
```

### Option B — Apple ID + app-specific password

```bash
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
```

Then:

```bash
npm run tauri build -- --bundles dmg
# optional first pass without stapling:
# npm run tauri build -- --bundles dmg --skip-stapling
```

### GitHub Actions (release.yml)

macOS matrix jobs require these secrets on the **private** source repo:

| Secret | Value |
|--------|--------|
| `APPLE_CERTIFICATE` | `openssl base64 -A -in cert.p12 -out -` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect Issuer UUID |
| `APPLE_API_KEY` | App Store Connect Key ID |
| `APPLE_API_KEY_CONTENT` | Full `AuthKey_*.p8` PEM body |

The workflow writes `AuthKey_<KEY_ID>.p8` on the runner and sets `APPLE_API_KEY_PATH`.
Tauri imports `APPLE_CERTIFICATE` and notarizes during `tauri build`. Missing Apple
secrets **fail** the macOS jobs (Windows/Linux are unaffected).

### Local builds without Apple credentials

Local machines without Apple credentials still produce a `.dmg` (unsigned or
ad-hoc). Signing / notarization steps are skipped.

## Updater artifacts

`bundle.createUpdaterArtifacts` is enabled. Release builds need:

```bash
export TAURI_SIGNING_PRIVATE_KEY="..."          # or path via TAURI_SIGNING_PRIVATE_KEY_PATH
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..." # if key is encrypted
```

Public key lives in `tauri.conf.json` → `plugins.updater.pubkey`.
CI / local builds without a private key use:

```bash
npm run tauri build -- --config src-tauri/tauri.conf.ci.json
```

(`createUpdaterArtifacts: false`)

## Manual checklist (release Mac)

- [ ] `npm run download-ffmpeg` — or `FFMPEG_MAC_ARCH=x86_64` for Intel cross-build
- [ ] `chmod +x` on mac FFmpeg; clear quarantine (`xattr`)
- [ ] `cargo test` / `npm run test:rust`
- [ ] `npm run tauri build -- --bundles app,dmg` (optional `--target …-apple-darwin`)
- [ ] Open `.app`, confirm VideoToolbox in Settings / HW info (`h264_videotoolbox`)
- [ ] Insert SD card → `/Volumes/...` detected, DCIM listed
- [ ] SMB test to `smb://host/share` (empty login → Guest)
- [ ] If distributing: Developer ID sign + notarize + staple
- [ ] Upload `.dmg` (+ updater `.sig` if used) to release endpoint

## Related

- FFmpeg layout: `src-tauri/resources/ffmpeg/README.md`
- CI checks (PR): `.github/workflows/test.yml`
- Release / updater: `docs/RELEASE.md`, `.github/workflows/release.yml`
- CI config overlay: `src-tauri/tauri.conf.ci.json`
- Plan: `docs/IMPLEMENTATION_PLAN.md` Phase 13
