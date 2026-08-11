/** Helpers for wizard default media folders (Speicherort / SD-Backup). */

import {
  ensureDefaultMediaDir,
  getAppInfo,
  proposeDefaultMediaDirs,
  type DefaultMediaDirKind,
  type DefaultMediaDirsProposal,
  type EnsureDefaultMediaDirResult,
} from "@/lib/tauri";

export type ApplyDefaultMediaDirResult = {
  ensured: EnsureDefaultMediaDirResult;
  usedAlternate: boolean;
  computerName: string;
};

const ALTERNATE_HINT_PREFIX = "Weiterer lokaler Datenträger";

function proposedPathForKind(
  proposal: DefaultMediaDirsProposal,
  kind: DefaultMediaDirKind,
  alternate: boolean,
): string {
  if (kind === "speicherort") {
    return alternate
      ? proposal.alternate_speicherort || proposal.speicherort
      : proposal.speicherort;
  }
  return alternate
    ? proposal.alternate_sd_backup_folder || proposal.sd_backup_folder
    : proposal.sd_backup_folder;
}

/**
 * Propose → optional alternate confirm → create one folder for `kind`.
 * Returns null when the user cancels a confirmation prompt.
 */
export async function applyDefaultMediaDir(
  kind: DefaultMediaDirKind,
  opts?: {
    confirmAlternate?: (proposal: DefaultMediaDirsProposal) => boolean;
    confirmWarnings?: (warnings: string[], path: string) => boolean;
  },
): Promise<ApplyDefaultMediaDirResult | null> {
  const proposal = await proposeDefaultMediaDirs();
  let root = proposal.root;
  let usedAlternate = false;

  if (proposal.alternate_root) {
    const useAlt = opts?.confirmAlternate
      ? opts.confirmAlternate(proposal)
      : window.confirm(
          [
            "Ein anderer lokaler Datenträger hat deutlich mehr freien Speicher.",
            "",
            `Standard: ${proposedPathForKind(proposal, kind, false)}`,
            `Alternative: ${proposedPathForKind(proposal, kind, true)}`,
            "",
            "OK = Alternative verwenden, Abbrechen = Standard behalten.",
          ].join("\n"),
        );
    if (useAlt) {
      root = proposal.alternate_root;
      usedAlternate = true;
    }
  }

  const targetPath = proposedPathForKind(proposal, kind, usedAlternate);
  const warnForChosen = proposal.warnings.filter(
    (w) => !w.startsWith(ALTERNATE_HINT_PREFIX),
  );
  if (!usedAlternate && warnForChosen.length > 0) {
    const ok = opts?.confirmWarnings
      ? opts.confirmWarnings(warnForChosen, targetPath)
      : window.confirm(
          [
            "Hinweise zum Speicherort:",
            ...warnForChosen.map((w) => `• ${w}`),
            "",
            `Ordner anlegen:\n${targetPath}`,
            "",
            "Trotzdem fortfahren?",
          ].join("\n"),
        );
    if (!ok) return null;
  }

  const ensured = await ensureDefaultMediaDir(kind, root);
  let computerName = "";
  try {
    computerName = (await getAppInfo()).computer_name || "";
  } catch {
    computerName = "";
  }

  return { ensured, usedAlternate, computerName };
}
