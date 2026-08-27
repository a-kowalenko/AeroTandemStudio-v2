import type { AppConfig } from "@/lib/tauri";
import {
  findServerProfile,
  type ServerProfile,
} from "@/lib/serverProfile";
import {
  AMS_BACKUP_PROFILE_ID,
  backupProfileUrlFromProfiles,
} from "./amsPathHintsCore";

export {
  AMS_BACKUP_PROFILE_ID,
  DEFAULT_SERVER_URL,
  PATHS_V1_CAPABILITY,
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
  return backupProfileUrlFromProfiles(config.server_profiles);
}

export function findBackupServerProfile(
  profiles: ServerProfile[] | undefined,
): ServerProfile | undefined {
  return findServerProfile(profiles, AMS_BACKUP_PROFILE_ID);
}
