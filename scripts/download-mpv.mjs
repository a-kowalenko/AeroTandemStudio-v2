/**
 * Download / install the optional mpv sidecar for Cutter / clip player (OPT-13).
 *
 * Sources: first-party CI builds from https://github.com/mpv-player/mpv/releases
 *   Windows:  *-x86_64-w64-mingw32.zip (+ MSVC zip fallback)
 *   macOS:    *-macos-*-arm.zip / *-macos-*-intel.zip (never Homebrew)
 *   Linux:    no official zip — skip (use `apt install mpv` or place binary manually)
 *
 * Usage:
 *   node scripts/download-mpv.mjs
 *   node scripts/download-mpv.mjs --arch=x86_64   # macOS Intel (CI cross-build)
 *   MPV_MAC_ARCH=arm64 node scripts/download-mpv.mjs
 *   MPV_TAG=v0.41.0 node scripts/download-mpv.mjs   # pin release (default: latest)
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync, chmodSync, rmSync, readdirSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFileSync, execSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const mpvRoot = join(root, "src-tauri", "resources", "mpv");

const GITHUB_API = "https://api.github.com/repos/mpv-player/mpv/releases";
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
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": "AeroTandemStudio-download-mpv",
          Accept: "application/octet-stream",
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      return;
    } catch (err) {
      lastErr = err;
      const status = httpStatusFromError(err);
      const retryable = status == null ? true : RETRYABLE_STATUS.has(status);
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

/** Resolve target macOS arch: CLI `--arch=` > env MPV_MAC_ARCH > host. */
function resolveMacArchDir() {
  const fromArg = process.argv.find((a) => a.startsWith("--arch="));
  const raw = (fromArg?.slice("--arch=".length) || process.env.MPV_MAC_ARCH || "")
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
    `Invalid macOS arch '${raw}' (use arm64 or x86_64). CLI: --arch=… or MPV_MAC_ARCH=…`,
  );
}

function clearMacQuarantine(path) {
  try {
    execFileSync("xattr", ["-cr", path], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

/** @returns {Promise<{ tag: string, assets: { name: string, browser_download_url: string }[] }>} */
async function fetchMpvRelease() {
  const tag = (process.env.MPV_TAG || "").trim();
  const url = tag
    ? `${GITHUB_API}/tags/${encodeURIComponent(tag)}`
    : `${GITHUB_API}/latest`;
  console.log(`Resolving mpv release: ${tag || "latest"}`);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "AeroTandemStudio-download-mpv",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}`);
  }
  const json = await res.json();
  if (!json?.tag_name || !Array.isArray(json.assets)) {
    throw new Error("Unexpected GitHub release payload");
  }
  return {
    tag: json.tag_name,
    assets: json.assets.map((a) => ({
      name: a.name,
      browser_download_url: a.browser_download_url,
    })),
  };
}

function pickAsset(assets, predicates) {
  for (const pred of predicates) {
    const hit = assets.find((a) => pred(a.name));
    if (hit) return hit;
  }
  return null;
}

function findFileRecursive(dir, name) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name === name) {
      return full;
    }
    if (e.isDirectory()) {
      const nested = findFileRecursive(full, name);
      if (nested) return nested;
    }
  }
  return null;
}

function copyTreeFiles(srcDir, destDir) {
  ensureDir(destDir);
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dest = join(destDir, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      copyTreeFiles(src, dest);
    } else if (st.isFile()) {
      copyFileSync(src, dest);
    }
  }
}

function unzip(zipPath, extractDir) {
  rmSync(extractDir, { recursive: true, force: true });
  ensureDir(extractDir);
  if (platform() === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("unzip", ["-o", zipPath, "-d", extractDir], { stdio: "inherit" });
  }
}

/**
 * macOS CI zips are often an .app bundle or a flat `mpv` binary.
 * Prefer Contents/MacOS/mpv inside *.app, else any file named `mpv`.
 */
function findMacMpvBinary(extractDir) {
  const apps = execSync(`find "${extractDir}" -type d -name '*.app' 2>/dev/null || true`, {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const app of apps) {
    const candidate = join(app, "Contents", "MacOS", "mpv");
    if (existsSync(candidate)) {
      return { binary: candidate, appRoot: app };
    }
  }
  const found = execSync(
    `find "${extractDir}" -type f -name mpv | head -n 1`,
    { encoding: "utf8" },
  ).trim();
  if (found && existsSync(found)) {
    return { binary: found, appRoot: null };
  }
  return null;
}

/** Official macOS CI zips wrap `mpv.tar.gz` which contains `mpv.app`. */
function expandNestedMacArchives(extractDir) {
  const tarballs = execSync(
    `find "${extractDir}" -type f \\( -name 'mpv.tar.gz' -o -name '*.tar.gz' \\) 2>/dev/null || true`,
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const tar of tarballs) {
    console.log(`Extracting nested ${basename(tar)}`);
    execFileSync("tar", ["-xzf", tar, "-C", extractDir], { stdio: "inherit" });
  }
}

async function installMacFromAsset(asset, archDest, fallback, label) {
  const macDir = join(mpvRoot, "mac");
  const safeLabel = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const zipPath = join(macDir, `mpv-${safeLabel}.zip`);
  const extractDir = join(macDir, `_extract_${safeLabel}`);

  ensureDir(macDir);
  await download(asset.browser_download_url, zipPath);
  unzip(zipPath, extractDir);
  expandNestedMacArchives(extractDir);

  const found = findMacMpvBinary(extractDir);
  if (!found) {
    throw new Error(`mpv binary not found inside ${asset.name}`);
  }

  ensureDir(dirname(archDest));
  ensureDir(dirname(fallback));

  // Flatten mpv.app → mac/<arch>/mpv + lib/ (@executable_path/lib/…).
  // Avoid shipping a nested .app: Tauri's resource walker hit Permission denied
  // on the signed CI bundle layout. MoltenVK/.app Resources are unused (--vo=null).
  if (found.appRoot) {
    const macosDir = join(found.appRoot, "Contents", "MacOS");
    const binSrc = join(macosDir, "mpv");
    const libSrc = join(macosDir, "lib");
    if (!existsSync(binSrc)) {
      throw new Error(`mpv binary missing in app: ${binSrc}`);
    }

    const archDirPath = dirname(archDest);
    ensureDir(archDirPath);
    rmSync(archDest, { force: true });
    rmSync(join(archDirPath, "lib"), { recursive: true, force: true });
    rmSync(join(archDirPath, "mpv.app"), { recursive: true, force: true });
    copyFileSync(binSrc, archDest);
    chmodSync(archDest, 0o755);
    if (existsSync(libSrc)) {
      copyTreeFiles(libSrc, join(archDirPath, "lib"));
    }
    clearMacQuarantine(archDirPath);

    // Relative symlink mac/mpv → <arch>/mpv (dyld uses real binary dir for @executable_path).
    const macDirPath = dirname(fallback);
    const archName = basename(archDirPath);
    rmSync(fallback, { force: true });
    rmSync(join(macDirPath, "lib"), { recursive: true, force: true });
    rmSync(join(macDirPath, "mpv.app"), { recursive: true, force: true });
    try {
      execFileSync("ln", ["-sfn", join(archName, "mpv"), fallback], { stdio: "ignore" });
    } catch {
      copyFileSync(binSrc, fallback);
      chmodSync(fallback, 0o755);
    }

    console.log(`Installed ${archDest} (+ lib/) (${label})`);
    console.log(`Linked ${fallback} → ${join(archName, "mpv")}`);
  } else {
    copyFileSync(found.binary, archDest);
    copyFileSync(found.binary, fallback);
    chmodSync(archDest, 0o755);
    chmodSync(fallback, 0o755);
    clearMacQuarantine(archDest);
    clearMacQuarantine(fallback);
    console.log(`Installed ${archDest} (${label})`);
    console.log(`Installed ${fallback}`);
  }

  try {
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(zipPath, { force: true });
  } catch {
    /* ignore */
  }
}

async function installMac(release) {
  const archDir = resolveMacArchDir();
  const hostDir = hostMacArchDir();
  const archDest = join(mpvRoot, "mac", archDir, "mpv");
  const fallback = join(mpvRoot, "mac", "mpv");

  console.log(`macOS mpv target arch: ${archDir} (host: ${hostDir}), release ${release.tag}`);

  const predicates =
    archDir === "arm64"
      ? [
          (n) => /macos-15-arm\.zip$/i.test(n),
          (n) => /macos-14-arm\.zip$/i.test(n),
          (n) => /macos-.*-arm\.zip$/i.test(n),
        ]
      : [
          (n) => /macos-15-intel\.zip$/i.test(n),
          (n) => /macos-.*-intel\.zip$/i.test(n),
        ];

  const asset = pickAsset(release.assets, predicates);
  if (!asset) {
    throw new Error(
      `No macOS ${archDir} zip in ${release.tag}. Place mpv at resources/mpv/mac/${archDir}/mpv manually.`,
    );
  }

  await installMacFromAsset(asset, archDest, fallback, `${release.tag} ${asset.name}`);
}

async function installWindows(release) {
  const destDir = join(mpvRoot, "win");
  const destExe = join(destDir, "mpv.exe");
  if (existsSync(destExe)) {
    console.log(`Already present: ${destExe}`);
    return;
  }

  const asset = pickAsset(release.assets, [
    (n) => /x86_64-w64-mingw32\.zip$/i.test(n),
    (n) => /x86_64-pc-windows-msvc\.zip$/i.test(n),
  ]);
  if (!asset) {
    throw new Error(
      `No Windows x86_64 zip in ${release.tag}. Place mpv.exe (+ DLLs) under resources/mpv/win/ manually.`,
    );
  }

  const zipPath = join(destDir, basename(asset.name));
  const extractDir = join(destDir, "_extract");
  ensureDir(destDir);
  await download(asset.browser_download_url, zipPath);
  unzip(zipPath, extractDir);

  const found = findFileRecursive(extractDir, "mpv.exe");
  if (!found) {
    throw new Error(`mpv.exe not found inside ${asset.name}`);
  }

  // Copy the directory that contains mpv.exe so companion DLLs resolve.
  const exeDir = dirname(found);
  for (const name of readdirSync(exeDir)) {
    const src = join(exeDir, name);
    const st = statSync(src);
    if (!st.isFile()) continue;
    copyFileSync(src, join(destDir, name));
  }
  if (!existsSync(destExe)) {
    throw new Error(`Failed to install ${destExe}`);
  }
  console.log(`Installed ${destExe} (${release.tag} ${asset.name})`);

  try {
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(zipPath, { force: true });
  } catch {
    /* ignore */
  }
}

async function installLinux() {
  const archDest = join(mpvRoot, "linux", "x86_64", "mpv");
  const fallback = join(mpvRoot, "linux", "mpv");
  if (existsSync(archDest) || existsSync(fallback)) {
    console.log(`Already present: ${existsSync(archDest) ? archDest : fallback}`);
    return;
  }
  console.log(
    "Linux: no official mpv zip on GitHub releases. " +
      "Install system mpv (`sudo apt install mpv`) or place a binary at " +
      "resources/mpv/linux/x86_64/mpv. HTML5 fallback remains available.",
  );
}

const os = platform();
if (os === "linux") {
  await installLinux();
  console.log("mpv sidecar step done (Linux — system/manual).");
} else {
  const release = await fetchMpvRelease();
  if (os === "win32") {
    await installWindows(release);
  } else if (os === "darwin") {
    await installMac(release);
  } else {
    throw new Error(`Unsupported platform: ${os}`);
  }
  console.log("mpv sidecar ready.");
}
