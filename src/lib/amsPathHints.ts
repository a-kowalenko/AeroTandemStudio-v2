import type { AppConfig } from "@/lib/tauri";
import { getActiveServerProfile } from "@/lib/serverProfile";
import { backupProfileUrlFromProfiles } from "./amsPathHintsCore";

export {
  AMS_BACKUP_PROFILE_ID,
  DEFAULT_SERVER_URL,
  PATHS_V1_CAPABILITY,
  anyProfileMatchesPathHints,
  backupHintDrift,
  backupProfileUrlFromProfiles,
  bindPathHintsServerInstance,
  buildPathHintsDriftDismissState,
  computePathHintsDiff,
  diffPathHintsFromHealth,
  hasPathsV1Capability,
  isPlaceholderServerUrl,
  normalizeSmbUrlForCompare,
  parsePathHintsFromHealth,
  pathHintsApplyInstanceAllowed,
  pathHintsDriftFacets,
  pathHintsDriftSignature,
  pathHintsHintsSignature,
  shouldSuppressPathHintsDriftBanner,
  type AmsPathHints,
  type AmsPathHintsDiff,
  type AmsPathHintsDiffKind,
  type PathHintsDriftDismissState,
} from "./amsPathHintsCore";

export function backupProfileUrl(config: AppConfig): string {
  return backupProfileUrlFromProfiles(
    config.server_profiles,
    config.active_server_profile_id,
  );
}

export function activeProfileBackupUrl(config: AppConfig): string {
  return getActiveServerProfile(config)?.backup_url?.trim() ?? "";
}
