import { invoke } from "@tauri-apps/api/core";
import type { VorgangEntry } from "@/lib/vorgangHistory";

export type VorgangFolderProbeResult = {
  vorgang_id: number;
  folder_missing: boolean;
};

export async function probeVorgangFolders(
  items: Array<{ vorgangId: number; baseOutputDir: string }>,
): Promise<VorgangFolderProbeResult[]> {
  if (items.length === 0) return [];
  return invoke<VorgangFolderProbeResult[]>("probe_vorgang_folders", {
    items: items.map((item) => ({
      vorgang_id: item.vorgangId,
      base_output_dir: item.baseOutputDir,
    })),
  });
}

/** Disk probe result map (`vorgangId → physically missing`). */
export function folderMissingMapFromProbe(
  results: VorgangFolderProbeResult[],
): Record<number, boolean> {
  const map: Record<number, boolean> = {};
  for (const row of results) {
    if (row.folder_missing) {
      map[row.vorgang_id] = true;
    }
  }
  return map;
}


export function probeItemsFromVorgaenge(
  rows: VorgangEntry[],
): Array<{ vorgangId: number; baseOutputDir: string }> {
  return rows.map((row) => ({
    vorgangId: row.id,
    baseOutputDir: row.base_output_dir,
  }));
}
