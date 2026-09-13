import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "@/lib/tauri";
import type { SettingsDisclosure } from "@/lib/settingsUi";

export type SettingsPatch = <K extends keyof AppConfig>(
  key: K,
  value: AppConfig[K],
) => void;

export type SettingsTabBaseProps = {
  draft: AppConfig;
  patch: SettingsPatch;
  /** Immediate persist (toggles, selects, folder picks). */
  patchNow: SettingsPatch;
  setDraft: Dispatch<SetStateAction<AppConfig | null>>;
  /** Multi-field draft update with immediate persist. */
  commitNow: (update: SetStateAction<AppConfig | null>) => void;
  /** Phase 47: simple vs advanced disclosure. */
  disclosure?: SettingsDisclosure;
};
