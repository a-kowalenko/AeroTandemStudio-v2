/**
 * Download / install the FFmpeg sidecar for the current platform.
 *
 * Windows: gyan.dev essentials (+ BtbN win64-gpl fallback; zip → win/ffmpeg.exe)
 * macOS:   static zips only (never Homebrew — dylibs break on other Macs)
 *          arm64 → martin-riedl.de (+ osxexperts.net fallback)
 *          x86_64 → evermeet.cx
 * Linux:   BtbN static GPL tarball → linux/x86_64/ffmpeg (+ fallback linux/ffmpeg)
 *
 * Usage:
 *   node scripts/download-ffmpeg.mjs
 *   node scripts/download-ffmpeg.mjs --arch=x86_64   # macOS Intel (CI cross-build)
 *   FFMPEG_MAC_ARCH=arm64 node scripts/download-ffmpeg.mjs
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFileSync, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const ffmpegRoot = join(root, "src-tauri", "resources", "ffmpeg");

const GYAN_ESSENTIALS =
  "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
/**
 * Windows x64 static GPL (libx264, NVENC). GitHub-hosted — reliable in CI when gyan.dev is down.
 * Floating `latest` tag — pin to a dated autobuild URL if reproducibility is required.
 */
const BTBN_WIN64_GPL =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

/** Intel (x86_64) static macOS builds — includes VideoToolbox / libx264. */
const EVERMEET_FFMPEG_ZIP = "https://evermeet.cx/ffmpeg/getrelease/zip";

/**
 * Apple Silicon static builds (portable — no /opt/homebrew dylibs).
 * Scripting URLs: https://ffmpeg.martin-riedl.de/ (signed zips).
 */
const MARTIN_RIEDL_ARM64_RELEASE =
  "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip";
const MARTIN_RIEDL_ARM64_SNAPSHOT =
  "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/snapshot/ffmpeg.zip";
/** Fallback if martin-riedl is unreachable. */
const OSXEXPERTS_ARM64_ZIP = "https://www.osxexperts.net/ffmpeg81arm.zip";

/**
 * Linux x86_64 static GPL build (libx264, drawtext, h264_nvenc).
 * Floating `latest` tag — pin to a dated autobuild URL if reproducibility is required.
 * Fallback: johnvansickle release static (no NVENC).
 */
const BTBN_LINUX64_GPL =
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";
const JOHNVANSICKLE_LINUX64 =
  "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";

/** Transient HTTP statuses worth retrying (mirror/CDN blips, rate limits). */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function httpStatusFromError(err) {
  if (!(err instanceof Error)) return null;
  const m = /^HTTP (\d+) /.exec(err.message);
  return m ? Number(m[1]) : null;
}

async function download(url, dest, { attempts = 3 } = {}) {
  ensureDir(dirname(dest));
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    console.log(`Downloading ${url}${i > 1 ? ` (attempt ${i}/${attempts})` : ""}`);
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      return;
    } catch (err) {
      lastErr = err;
      const status = httpStatusFromError(err);
      const retryable =
        status == null ? true : RETRYABLE_STATUS.has(status);
      if (!retryable || i === attempts) {
        throw err;
      }
      const waitMs = 1000 * 2 ** (i - 1);
      console.warn(`Download failed (${err.message}); retrying in ${waitMs}ms…`);
      await sleep(waitMs);
    }
  }
  throw lastErr ?? new Error(`Download failed for ${url}`);
}

function hostMacArchDir() {
  return arch() === "arm64" ? "arm64" : "x86_64";
}

/** Resolve target macOS arch: CLI `--arch=` > env FFMPEG_MAC_ARCH > host. */
function resolveMacArchDir() {
  const fromArg = process.argv.find((a) => a.startsWith("--arch="));
  const raw = (fromArg?.slice("--arch=".length) || process.env.FFMPEG_MAC_ARCH || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return hostMacArchDir();
  }
  if (raw === "arm64" || raw === "aarch64") {
    return "arm64";
  }
  if (raw === "x86_64" || raw === "x64" || raw === "amd64") {
    return "x86_64";
  }
  throw new Error(
    `Invalid macOS arch '${raw}' (use arm64 or x86_64). CLI: --arch=… or FFMPEG_MAC_ARCH=…`,
  );
}

function clearMacQuarantine(path) {
  try {
    execFileSync("xattr", ["-cr", path], { stdio: "ignore" });
  } catch {
    /* ignore — not present or already cleared */
  }
}

function installMacBinary(found, archDest, fallback, label) {
  ensureDir(dirname(archDest));
  ensureDir(dirname(fallback));
  copyFileSync(found, archDest);
  copyFileSync(found, fallback);
  chmodSync(archDest, 0o755);
  chmodSync(fallback, 0o755);
  clearMacQuarantine(archDest);
  clearMacQuarantine(fallback);
  console.log(`Installed ${archDest} (${label})`);
  console.log(`Installed ${fallback}`);
}

/**
 * Download a zip that contains an `ffmpeg` binary and install it.
 * Works on any host (CI can fetch arm64 while building on arm64 runners).
 */
async function installMacFromZip(url, archDest, fallback, label) {
  const macDir = join(ffmpegRoot, "mac");
  const safeLabel = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const zipPath = join(macDir, `ffmpeg-${safeLabel}.zip`);
  const extractDir = join(macDir, `_extract_${safeLabel}`);

  ensureDir(macDir);
  await download(url, zipPath);

  rmSync(extractDir, { recursive: true, force: true });
  ensureDir(extractDir);
  execFileSync("unzip", ["-o", zipPath, "-d", extractDir], { stdio: "inherit" });

  const found = execSync(
    `find "${extractDir}" -type f -name ffmpeg | head -n 1`,
    { encoding: "utf8" },
  ).trim();

  if (!found || !existsSync(found)) {
    throw new Error(`ffmpeg binary not found inside ${label} zip`);
  }

  installMacBinary(found, archDest, fallback, label);

  try {
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(zipPath, { force: true });
  } catch {
    /* ignore */
  }
}

async function installMacArm64(archDest, fallback) {
  const sources = [
    [MARTIN_RIEDL_ARM64_RELEASE, "martin-riedl arm64 release"],
    [MARTIN_RIEDL_ARM64_SNAPSHOT, "martin-riedl arm64 snapshot"],
    [OSXEXPERTS_ARM64_ZIP, "osxexperts.net ffmpeg81arm"],
  ];

  let lastErr;
  for (const [url, label] of sources) {
    try {
      await installMacFromZip(url, archDest, fallback, label);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`arm64 FFmpeg source failed (${label}): ${err.message}`);
    }
  }
  throw new Error(
    `Could not download static arm64 FFmpeg. Last error: ${lastErr?.message ?? "unknown"}. ` +
      "Place a portable binary at resources/ffmpeg/mac/arm64/ffmpeg manually.",
  );
}

async function installMac() {
  const archDir = resolveMacArchDir();
  const hostDir = hostMacArchDir();
  const archDest = join(ffmpegRoot, "mac", archDir, "ffmpeg");
  const fallback = join(ffmpegRoot, "mac", "ffmpeg");

  console.log(`macOS FFmpeg target arch: ${archDir} (host: ${hostDir})`);

  // Always ship static binaries — Homebrew copies break on Macs without matching cellar libs.
  if (archDir === "arm64") {
    await installMacArm64(archDest, fallback);
    return;
  }

  await installMacFromZip(
    EVERMEET_FFMPEG_ZIP,
    archDest,
    fallback,
    "evermeet.cx Intel static",
  );
}

async function installWindowsFromZip(url, dest, label) {
  const winDir = dirname(dest);
  const safeLabel = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const zipPath = join(winDir, `ffmpeg-${safeLabel}.zip`);
  const extractDir = join(winDir, `_extract_${safeLabel}`);

  ensureDir(winDir);
  await download(url, zipPath);

  rmSync(extractDir, { recursive: true, force: true });
  ensureDir(extractDir);
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ],
    { stdio: "inherit" },
  );

  const found = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-ChildItem -Path '${extractDir}' -Recurse -Filter ffmpeg.exe | Select-Object -First 1 -ExpandProperty FullName`,
    ],
    { encoding: "utf8" },
  ).trim();

  if (!found || !existsSync(found)) {
    throw new Error(`ffmpeg.exe not found inside ${label} zip`);
  }
  copyFileSync(found, dest);
  console.log(`Installed ${dest} (${label})`);

  try {
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(zipPath, { force: true });
  } catch {
    /* ignore */
  }
}

async function installWindows() {
  const dest = join(ffmpegRoot, "win", "ffmpeg.exe");
  if (existsSync(dest)) {
    console.log(`Already present: ${dest}`);
    return;
  }

  // gyan.dev is often flaky (503); BtbN is GitHub-hosted and reliable in Actions.
  const sources = process.env.GITHUB_ACTIONS
    ? [
        [BTBN_WIN64_GPL, "BtbN win64-gpl"],
        [GYAN_ESSENTIALS, "gyan.dev essentials"],
      ]
    : [
        [GYAN_ESSENTIALS, "gyan.dev essentials"],
        [BTBN_WIN64_GPL, "BtbN win64-gpl"],
      ];

  let lastErr;
  for (const [url, label] of sources) {
    try {
      await installWindowsFromZip(url, dest, label);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`Windows FFmpeg source failed (${label}): ${err.message}`);
      try {
        rmSync(dest, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error(
    `Could not download Windows FFmpeg. Last error: ${lastErr?.message ?? "unknown"}. ` +
      "Place ffmpeg.exe at resources/ffmpeg/win/ffmpeg.exe manually.",
  );
}

async function installLinuxFromTarball(url, archDest, fallback, label) {
  const linuxDir = join(ffmpegRoot, "linux");
  const archivePath = join(linuxDir, "ffmpeg-linux64.tar.xz");
  const extractDir = join(linuxDir, "_linux_extract");

  ensureDir(linuxDir);
  await download(url, archivePath);

  rmSync(extractDir, { recursive: true, force: true });
  ensureDir(extractDir);
  execFileSync("tar", ["-xJf", archivePath, "-C", extractDir], { stdio: "inherit" });

  const found = execSync(
    `find "${extractDir}" -type f -name ffmpeg | head -n 1`,
    { encoding: "utf8" },
  ).trim();

  if (!found || !existsSync(found)) {
    throw new Error(`ffmpeg binary not found inside ${label} archive`);
  }

  ensureDir(dirname(archDest));
  ensureDir(dirname(fallback));
  copyFileSync(found, archDest);
  copyFileSync(found, fallback);
  chmodSync(archDest, 0o755);
  chmodSync(fallback, 0o755);
  console.log(`Installed ${archDest} (${label})`);
  console.log(`Installed ${fallback}`);

  try {
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(archivePath, { force: true });
  } catch {
    /* ignore */
  }
}

async function installLinux() {
  const archDest = join(ffmpegRoot, "linux", "x86_64", "ffmpeg");
  const fallback = join(ffmpegRoot, "linux", "ffmpeg");

  if (existsSync(archDest) && existsSync(fallback)) {
    console.log(`Already present: ${archDest}`);
    return;
  }

  if (arch() !== "x64" && arch() !== "x86_64") {
    console.warn(
      `Host arch is ${arch()}; shipping x86_64 sidecar only. Place linux/x86_64/ffmpeg manually for other arches.`,
    );
  }

  try {
    await installLinuxFromTarball(BTBN_LINUX64_GPL, archDest, fallback, "BtbN linux64-gpl");
  } catch (err) {
    console.warn(`BtbN download failed (${err.message}); trying johnvansickle…`);
    await installLinuxFromTarball(
      JOHNVANSICKLE_LINUX64,
      archDest,
      fallback,
      "johnvansickle amd64-static",
    );
  }
}

const os = platform();
if (os === "win32") {
  await installWindows();
} else if (os === "darwin") {
  await installMac();
} else if (os === "linux") {
  await installLinux();
} else {
  throw new Error(`Unsupported platform: ${os}`);
}

console.log("FFmpeg sidecar ready.");
