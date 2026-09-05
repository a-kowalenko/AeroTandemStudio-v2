#!/usr/bin/env bash
# Sign bundled FFmpeg sidecars for Apple notarization (Developer ID + hardened runtime).
# Tauri signs MacOS/Frameworks nested code, but not Mach-Os under Contents/Resources.
#
# Usage (macOS, identity already in a unlocked keychain):
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" \
#     ./scripts/sign-macos-ffmpeg.sh
#
# Optional: FFMPEG_ROOT (default: src-tauri/resources/ffmpeg relative to repo root)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FFMPEG_ROOT="${FFMPEG_ROOT:-$ROOT/src-tauri/resources/ffmpeg}"
MAC_DIR="$FFMPEG_ROOT/mac"

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  echo "APPLE_SIGNING_IDENTITY is required" >&2
  exit 1
fi

if [ ! -d "$MAC_DIR" ]; then
  echo "No mac FFmpeg dir at $MAC_DIR — nothing to sign" >&2
  exit 1
fi

# Clear quarantine / finder xattrs that break codesign.
xattr -cr "$MAC_DIR" 2>/dev/null || true

shopt -s nullglob
candidates=(
  "$MAC_DIR/ffmpeg"
  "$MAC_DIR/arm64/ffmpeg"
  "$MAC_DIR/x86_64/ffmpeg"
)

signed=0
for bin in "${candidates[@]}"; do
  if [ -f "$bin" ] && [ -x "$bin" ]; then
    echo "codesign FFmpeg: $bin"
    codesign \
      --force \
      --options runtime \
      --timestamp \
      --sign "$IDENTITY" \
      "$bin"
    codesign --verify --verbose=2 "$bin"
    signed=$((signed + 1))
  fi
done

if [ "$signed" -eq 0 ]; then
  echo "ERROR: no executable FFmpeg binaries found under $MAC_DIR" >&2
  find "$MAC_DIR" -type f -print 2>/dev/null || true
  exit 1
fi

echo "Signed $signed FFmpeg sidecar(s) with: $IDENTITY"
