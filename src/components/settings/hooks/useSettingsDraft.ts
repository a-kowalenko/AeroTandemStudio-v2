import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig } from "@/lib/tauri";
import {
  canonicalCrewName,
  ensureCrewRole,
  findCrewMember,
  getAppInfo,
} from "@/lib/tauri";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useUiStore } from "@/store/uiStore";
import { useLocaleStore } from "@/store/localeStore";
import type { SettingsPatch } from "../types";
import { isAmsBridgeConfigured } from "@/lib/amsLookup";
import { runAmsAutoConnect } from "@/lib/amsAutoConnect";
import { pushFlatToActiveProfile } from "@/lib/serverProfile";
import { composeSdPcName, resolveSdPcName } from "@/lib/sdPcName";
import { showSettingsSaveToast } from "@/lib/settingsSaveToast";

function sortCrewList(config: AppConfig): AppConfig {
  const crew_list = [...(config.crew_list ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, "de"),
  );
  return { ...config, crew_list };
}

export function configsEqual(a: AppConfig, b: AppConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useSettingsDraft(open: boolean, config: AppConfig | null) {
  const { t } = useTranslation();
  const persist = useConfigStore((s) => s.persist);
  const resetToDefaults = useConfigStore((s) => s.resetToDefaults);
  const saving = useConfigStore((s) => s.saving);
  const showError = useUiStore((s) => s.showError);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const checkAmsHealth = useAmsBridgeStore((s) => s.checkHealth);
  const resetAmsHealth = useAmsBridgeStore((s) => s.reset);
  const activeLanguage = useLocaleStore((s) => s.language);
  const [draft, setDraft] = useState<AppConfig | null>(null);

  useEffect(() => {
    if (!open || !config) return;
    let cancelled = false;
    // Reflect any unsaved language change that was already applied live
    setDraft(sortCrewList({ ...config, ui_language: activeLanguage }));

    void getAppInfo()
      .then((info) => {
        if (cancelled) return;
        const host = info.computer_name || "";
        setDraft((d) => {
          if (!d) return d;
          const nextName = !d.sd_pc_name.trim()
            ? composeSdPcName(host, d.operator_name)
            : resolveSdPcName(d.sd_pc_name, host, d.operator_name);
          if (nextName === d.sd_pc_name) return d;
          return { ...d, sd_pc_name: nextName };
        });
      })
      .catch(() => {
        /* keep existing */
      });

    return () => {
      cancelled = true;
    };
  }, [open, config]);

  const patch = useCallback<SettingsPatch>((key, value) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    if (draft.sd_auto_backup && !draft.sd_backup_folder.trim()) {
      showError(t("settings.save.pickBackup"));
      return false;
    }
    if (draft.sd_server_backup_enabled && !draft.sd_server_backup_path.trim()) {
      showError(t("settings.save.pickSecondBackup"));
      return false;
    }

    let crew_list = [...draft.crew_list];
    const tm = draft.tandemmaster.trim();
    const vs = draft.videospringer.trim();
    if (draft.keep_tandemmaster_on_session_reset && tm) {
      crew_list = ensureCrewRole(crew_list, tm, "tandemmaster");
    }
    if (draft.keep_videospringer_on_session_reset && vs) {
      crew_list = ensureCrewRole(crew_list, vs, "videospringer");
    }
    const op = draft.operator_name.trim();
    if (op && !findCrewMember(crew_list, op)) {
      showError(t("settings.save.operatorRole"), t("settings.tabs.crew"));
      return false;
    }
    crew_list.sort((a, b) => a.name.localeCompare(b.name, "de"));

    let sd_pc_name = draft.sd_pc_name.trim();
    try {
      const host = (await getAppInfo()).computer_name || "";
      sd_pc_name = resolveSdPcName(sd_pc_name, host, op);
    } catch {
      sd_pc_name = resolveSdPcName(sd_pc_name, "", op);
    }

    const toSave: AppConfig = pushFlatToActiveProfile({
      ...draft,
      tandemmaster: draft.keep_tandemmaster_on_session_reset ? tm : "",
      videospringer: draft.keep_videospringer_on_session_reset ? vs : "",
      operator_name: op ? canonicalCrewName(crew_list, op) : "",
      sd_pc_name,
      crew_list,
    });

    const prev = config;
    const serverChanged =
      !prev ||
      prev.server_url !== toSave.server_url ||
      prev.server_login !== toSave.server_login ||
      prev.server_password !== toSave.server_password ||
      prev.active_server_profile_id !== toSave.active_server_profile_id ||
      JSON.stringify(prev.server_profiles) !==
        JSON.stringify(toSave.server_profiles);
    const amsChanged =
      !prev ||
      prev.ams_bridge_url !== toSave.ams_bridge_url ||
      prev.ams_bridge_token !== toSave.ams_bridge_token;

    const saved = await persist(toSave);
    if (!saved) {
      showError(t("settings.save.failed"));
      return false;
    }

    showSettingsSaveToast(t("settings.save.success"));
    if (serverChanged && toSave.server_url.trim()) {
      void checkConnection({
        server_url: toSave.server_url,
        server_login: toSave.server_login,
        server_password: toSave.server_password,
      }).then((result) => {
        if (result.ok) {
          void runAmsAutoConnect({ config: saved, interactive: true });
        }
      });
    }
    if (amsChanged) {
      if (isAmsBridgeConfigured(toSave)) void checkAmsHealth();
      else resetAmsHealth();
    }
    return true;
  }, [
    checkAmsHealth,
    checkConnection,
    config,
    draft,
    persist,
    resetAmsHealth,
    showError,
    t,
  ]);

  const resetToFactory = useCallback(async (): Promise<AppConfig | null> => {
    const restored = await resetToDefaults();
    if (!restored) {
      showError(t("settings.save.resetFailed"));
      return null;
    }
    const sorted = sortCrewList(restored);
    setDraft(sorted);
    return sorted;
  }, [resetToDefaults, showError, t]);

  const hasUnsavedChanges =
    draft && config ? !configsEqual(draft, config) : false;

  return {
    draft,
    setDraft,
    patch,
    save,
    resetToFactory,
    saving,
    hasUnsavedChanges,
  };
}
