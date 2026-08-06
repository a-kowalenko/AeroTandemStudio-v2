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

## Entitlements & Info.plist

| File | Purpose |
|------|---------|
| `src-tauri/Entitlements.plist` | Hardened Runtime: JIT for WKWebView, disable library validation for FFmpeg sidecar. **No App Sandbox** (SD `/Volumes`, arbitrary folders, SMB). |
| `src-tauri/Info.plist` | Usage strings for removable / network volumes and Documents/Downloads. Merged by Tauri into the bundle. |

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

### Stub when secrets are missing

CI and local machines without Apple credentials still produce a `.dmg` (unsigned or
ad-hoc). Signing / notarization steps are skipped; see GitHub Actions logs for
`APPLE_*` / `TAURI_SIGNING_*` notices.

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

- [ ] `npm run download-ffmpeg` — binary is `arm64` or `x86_64` matching the build
- [ ] `chmod +x` on mac FFmpeg; clear quarantine (`xattr`)
- [ ] `cargo test` / `npm run test:rust`
- [ ] `npm run tauri build -- --bundles app,dmg`
- [ ] Open `.app`, confirm VideoToolbox in Settings / HW info (`h264_videotoolbox`)
- [ ] Insert SD card → `/Volumes/...` detected, DCIM listed
- [ ] SMB test to `smb://host/share` (empty login → Guest)
- [ ] If distributing: Developer ID sign + notarize + staple
- [ ] Upload `.dmg` (+ updater `.sig` if used) to release endpoint

## Related

- FFmpeg layout: `src-tauri/resources/ffmpeg/README.md`
- CI: `.github/workflows/build.yml`
- CI config overlay: `src-tauri/tauri.conf.ci.json`
- Plan: `docs/IMPLEMENTATION_PLAN.md` Phase 13
