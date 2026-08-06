/**
 * Download / install the FFmpeg sidecar for the current platform.
 *
 * Windows: essentials build from gyan.dev (zip → win/ffmpeg.exe)
 * macOS:   brew install ffmpeg → copy to mac/<arch>/ffmpeg (+ mac/ffmpeg)
 * Linux:   apt/ffmpeg or static — copies `ffmpeg` from PATH if present
 *
 * Usage: node scripts/download-ffmpeg.mjs
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFileSync, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const ffmpegRoot = join(root, "src-tauri", "resources", "ffmpeg");

const GYAN_ESSENTIALS =
  "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  ensureDir(dirname(dest));
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function macArchDir() {
  return arch() === "arm64" ? "arm64" : "x86_64";
}

async function installWindows() {
  const winDir = join(ffmpegRoot, "win");
  const dest = join(winDir, "ffmpeg.exe");
  if (existsSync(dest)) {
    console.log(`Already present: ${dest}`);
    return;
  }
  ensureDir(winDir);
  const zipPath = join(winDir, "ffmpeg-essentials.zip");
  await download(GYAN_ESSENTIALS, zipPath);

  // Prefer PowerShell Expand-Archive + find ffmpeg.exe
  const extractDir = join(winDir, "_extract");
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

  if (!found) {
    throw new Error("ffmpeg.exe not found inside essentials zip");
  }
  copyFileSync(found, dest);
  console.log(`Installed ${dest}`);

  // Cleanup extract + zip to keep tree small
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Remove-Item -LiteralPath '${extractDir}' -Recurse -Force; Remove-Item -LiteralPath '${zipPath}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } catch {
    /* ignore */
  }
}

function installMac() {
  const archDir = macArchDir();
  const archDest = join(ffmpegRoot, "mac", archDir, "ffmpeg");
  const fallback = join(ffmpegRoot, "mac", "ffmpeg");

  let src;
  try {
    execSync("brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg", {
      stdio: "inherit",
      shell: true,
    });
    src = execSync("brew --prefix ffmpeg", { encoding: "utf8" }).trim();
    src = join(src, "bin", "ffmpeg");
  } catch {
    src = execSync("which ffmpeg", { encoding: "utf8" }).trim();
  }

  if (!existsSync(src)) {
    throw new Error(
      "Could not locate ffmpeg. Install Homebrew ffmpeg or place a binary under resources/ffmpeg/mac/",
    );
  }

  ensureDir(dirname(archDest));
  ensureDir(dirname(fallback));
  copyFileSync(src, archDest);
  copyFileSync(src, fallback);
  chmodSync(archDest, 0o755);
  chmodSync(fallback, 0o755);
  console.log(`Installed ${archDest}`);
  console.log(`Installed ${fallback}`);
}

function installLinux() {
  const dest = join(ffmpegRoot, "linux", "ffmpeg");
  if (existsSync(dest)) {
    console.log(`Already present: ${dest}`);
    return;
  }
  let src;
  try {
    src = execSync("which ffmpeg", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("ffmpeg not on PATH — install via apt or place linux/ffmpeg manually");
  }
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`Installed ${dest}`);
}

const os = platform();
if (os === "win32") {
  await installWindows();
} else if (os === "darwin") {
  installMac();
} else if (os === "linux") {
  installLinux();
} else {
  throw new Error(`Unsupported platform: ${os}`);
}

console.log("FFmpeg sidecar ready.");
