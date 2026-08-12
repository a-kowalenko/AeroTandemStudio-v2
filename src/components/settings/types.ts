import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "@/lib/tauri";

export type SettingsPatch = <K extends keyof AppConfig>(
  key: K,
  value: AppConfig[K],
) => void;

export type SettingsTabBaseProps = {
  draft: AppConfig;
  patch: SettingsPatch;
  setDraft: Dispatch<SetStateAction<AppConfig | null>>;
};
