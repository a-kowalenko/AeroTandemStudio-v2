/**
 * Local macOS .app build for release-parity testing on this Mac (no GitHub release).
 *
 * - Downloads the static FFmpeg sidecar for the host arch
 * - Builds the .app only (skips updater artifacts when no signing key)
 * - Opens the macos bundle folder in Finder
 *
 * Usage: npm run build:mac
 *
 * Override arch (rare): MAC_BUILD_ARCH=arm64|x86_64 npm run build:mac
 */
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { arch, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const npmCmd = "npm";

/**
 * @returns {{ ffmpegArch: "arm64" | "x86_64", rustTarget: string }}
 */
function resolveMacArch() {
  const raw = (process.env.MAC_BUILD_ARCH || "").trim().toLowerCase();
  let ffmpegArch;
  if (raw === "arm64" || raw === "aarch64") {
    ffmpegArch = "arm64";
  } else if (raw === "x86_64" || raw === "x64" || raw === "amd64") {
    ffmpegArch = "x86_64";
  } else if (raw) {
    console.error(
      `Ungültiges MAC_BUILD_ARCH='${raw}' (erlaubt: arm64, x86_64).`,
    );
    process.exit(1);
  } else {
    ffmpegArch = arch() === "arm64" ? "arm64" : "x86_64";
  }

  const rustTarget =
    ffmpegArch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return { ffmpegArch, rustTarget };
}

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    ...opts,
  });
}

function macosBundleDir(rustTarget) {
  return join(
    root,
    "src-tauri",
    "target",
    rustTarget,
    "release",
    "bundle",
    "macos",
  );
}

function findAppBundle(dir) {
  if (!existsSync(dir)) return null;
  const apps = readdirSync(dir).filter((name) => name.endsWith(".app"));
  return apps.length ? join(dir, apps[0]) : null;
}

function openMacosFolder(dir) {
  if (!existsSync(dir)) {
    console.warn(`\nmacOS-Bundle-Ordner nicht gefunden: ${dir}`);
    console.warn("Build ggf. fehlgeschlagen oder Bundle-Pfad anders.\n");
    return;
  }

  console.log(`\nÖffne: ${dir}\n`);
  spawnSync("open", [dir], { stdio: "ignore" });
}

function main() {
  if (platform() !== "darwin") {
    console.error("build:mac ist nur für macOS gedacht.");
    process.exit(1);
  }

  const { ffmpegArch, rustTarget } = resolveMacArch();
  console.log(
    `Lokaler macOS Release-Build: FFmpeg=${ffmpegArch}, target=${rustTarget}\n`,
  );

  try {
    run("rustup", ["target", "add", rustTarget]);
  } catch {
    console.warn(
      `Hinweis: rustup target add ${rustTarget} fehlgeschlagen — Target ggf. schon installiert.\n`,
    );
  }

  run(npmCmd, ["run", "download-ffmpeg"], {
    env: { ...process.env, FFMPEG_MAC_ARCH: ffmpegArch },
  });

  const hasKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim());
  const buildArgs = [
    "run",
    "tauri",
    "--",
    "build",
    "--target",
    rustTarget,
    "--bundles",
    "app",
  ];
  if (!hasKey) {
    buildArgs.push("--config", "src-tauri/tauri.conf.ci.json");
    console.log(
      "Hinweis: Kein TAURI_SIGNING_PRIVATE_KEY — Build ohne Updater-Artefakte (tauri.conf.ci.json).\n",
    );
  }

  run(npmCmd, buildArgs);

  const bundleDir = macosBundleDir(rustTarget);
  openMacosFolder(bundleDir);

  const appPath = findAppBundle(bundleDir);
  if (appPath) {
    console.log(`Fertig. App starten mit:\n  open "${appPath}"\n`);
  } else {
    console.log(
      "Fertig. .app im Finder-Fenster doppelklicken (Release-Parity, nicht tauri dev).\n",
    );
  }
}

main();
