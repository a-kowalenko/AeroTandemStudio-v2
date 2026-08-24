/**
 * Local Windows NSIS build for ad-hoc testing on another PC (no GitHub release).
 *
 * - Downloads FFmpeg + mpv sidecars if needed
 * - Builds NSIS setup only (skips updater artifacts when no signing key)
 * - Opens the nsis output folder in Explorer
 *
 * Usage: npm run build:win
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const npmCmd = platform() === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: platform() === "win32",
    ...opts,
  });
}

function openNsisFolder() {
  if (!existsSync(nsisDir)) {
    console.warn(`\nNSIS-Ordner nicht gefunden: ${nsisDir}`);
    console.warn("Build ggf. fehlgeschlagen oder Bundle-Pfad anders.\n");
    return;
  }

  console.log(`\nÖffne: ${nsisDir}\n`);
  if (platform() === "win32") {
    // explorer returns non-zero even on success — ignore status
    spawnSync("explorer.exe", [nsisDir], { stdio: "ignore" });
  } else {
    spawnSync("xdg-open", [nsisDir], { stdio: "ignore" });
  }
}

function main() {
  if (platform() !== "win32") {
    console.error("build:win ist nur für Windows gedacht.");
    process.exit(1);
  }

  run(npmCmd, ["run", "download-ffmpeg"]);
  run(npmCmd, ["run", "download-mpv"]);

  // Without updater signing secrets, skip updater artifacts (same as CI overlay).
  const hasKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim());
  const buildArgs = ["run", "tauri", "--", "build", "--bundles", "nsis"];
  if (!hasKey) {
    buildArgs.push("--config", "src-tauri/tauri.conf.ci.json");
    console.log(
      "Hinweis: Kein TAURI_SIGNING_PRIVATE_KEY — Build ohne Updater-Artefakte (tauri.conf.ci.json).\n",
    );
  }

  run(npmCmd, buildArgs);
  openNsisFolder();

  console.log("Fertig. Setup.exe aus dem Explorer-Fenster auf den Ziel-PC kopieren.\n");
}

main();
