/**
 * Local macOS .app build for release-parity testing on this Mac (no GitHub release).
 *
 * - Downloads the static FFmpeg sidecar for the host arch
 * - Builds the .app only (skips updater artifacts when no signing key)
 * - Ad-hoc codesign + clear quarantine/xattrs
 * - Installs to /Applications (override: MAC_INSTALL_DIR) for stable TCC identity
 * - Opens the installed app
 *
 * Usage: npm run build:mac
 *
 * Override arch (rare): MAC_BUILD_ARCH=arm64|x86_64 npm run build:mac
 * Install dir:         MAC_INSTALL_DIR=/Applications  (default)
 *                      MAC_INSTALL_DIR=$HOME/Applications
 * Skip install/open:   MAC_SKIP_INSTALL=1
 */
import { existsSync, readdirSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { arch, homedir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const npmCmd = "npm";
const entitlements = join(root, "src-tauri", "Entitlements.plist");

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

function tryRun(cmd, args, opts = {}) {
  try {
    run(cmd, args, opts);
    return true;
  } catch (err) {
    console.warn(
      `Hinweis: ${cmd} ${args.join(" ")} fehlgeschlagen: ${err.message || err}\n`,
    );
    return false;
  }
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

function resolveInstallDir() {
  const raw = (process.env.MAC_INSTALL_DIR || "").trim();
  if (raw) return raw.replace(/^~(?=\/|$)/, homedir());
  return "/Applications";
}

/** Ad-hoc sign so entitlements / TCC identity are applied (Tauri may leave unsigned). */
function adHocSign(appPath) {
  console.log("\nAd-hoc codesign …\n");
  const args = ["--force", "--deep", "--sign", "-", "--timestamp=none"];
  if (existsSync(entitlements)) {
    args.push("--entitlements", entitlements);
  }
  args.push(appPath);
  run("codesign", args);
  tryRun("codesign", ["--verify", "--verbose", appPath]);
}

function clearQuarantine(appPath) {
  tryRun("xattr", ["-cr", appPath]);
}

function installApp(builtAppPath, installDir) {
  mkdirSync(installDir, { recursive: true });
  const dest = join(installDir, basename(builtAppPath));
  console.log(`\nInstalliere nach: ${dest}\n`);
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  cpSync(builtAppPath, dest, { recursive: true });
  return dest;
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

  tryRun("rustup", ["target", "add", rustTarget]);

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
  const builtApp = findAppBundle(bundleDir);
  if (!builtApp) {
    console.error(`\nKeine .app in ${bundleDir}\n`);
    process.exit(1);
  }

  clearQuarantine(builtApp);
  adHocSign(builtApp);

  const skipInstall = ["1", "true", "yes"].includes(
    (process.env.MAC_SKIP_INSTALL || "").trim().toLowerCase(),
  );

  let launchPath = builtApp;
  if (!skipInstall) {
    const installDir = resolveInstallDir();
    launchPath = installApp(builtApp, installDir);
    clearQuarantine(launchPath);
    adHocSign(launchPath);
  }

  console.log(`\nStarte: ${launchPath}\n`);
  spawnSync("open", [launchPath], { stdio: "ignore" });

  console.log(
    "Fertig. Bei erster Bridge-Suche ggf. „Lokales Netzwerk“ erlauben " +
      "(Systemeinstellungen → Datenschutz → Lokales Netzwerk).\n",
  );
}

main();
