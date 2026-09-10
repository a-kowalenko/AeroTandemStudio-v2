import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig } from "@/lib/tauri";
import {
  canonicalCrewName,
  ensureCrewRole,
  findCrewMember,
  getAppInfo,
  syncCrewRemovedNames,
} from "@/lib/tauri";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useUiStore } from "@/store/uiStore";
import { useLocaleStore } from "@/store/localeStore";
import type { SettingsPatch } from "../types";
import { isAmsBridgeConfigured } from "@/lib/amsLookup";
import { runAmsAutoConnect } from "@/lib/amsAutoConnect";
import { getActiveServerProfile, pushFlatToActiveProfile } from "@/lib/serverProfile";
import { composeSdPcName, resolveSdPcName } from "@/lib/sdPcName";

const DEBOUNCE_MS = 500;
const SIDE_EFFECT_DEBOUNCE_MS = 900;

export type SettingsPersistState = "idle" | "pending" | "saving" | "error";

export type SettingsPersistMode = "now" | "debounce";

type ValidationFailure = {
  ok: false;
  message: string;
  title?: string;
  focus?: "server-backup-url";
  tab?: "sd" | "server" | "crew";
};

type ValidationResult = { ok: true } | ValidationFailure;

function sortCrewList(config: AppConfig): AppConfig {
  const crew_list = [...(config.crew_list ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, "de"),
  );
  return { ...config, crew_list };
}

export function configsEqual(a: AppConfig, b: AppConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function normalizeDraftForPersist(draft: AppConfig): Promise<AppConfig> {
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
  crew_list.sort((a, b) => a.name.localeCompare(b.name, "de"));
  const crew_removed_names = syncCrewRemovedNames(
    draft.crew_removed_names,
    crew_list,
  );

  let sd_pc_name = draft.sd_pc_name.trim();
  try {
    const host = (await getAppInfo()).computer_name || "";
    sd_pc_name = resolveSdPcName(sd_pc_name, host, op);
  } catch {
    sd_pc_name = resolveSdPcName(sd_pc_name, "", op);
  }

  const activeBackupUrl =
    getActiveServerProfile(draft)?.backup_url?.trim() ?? "";

  return pushFlatToActiveProfile({
    ...draft,
    tandemmaster: draft.keep_tandemmaster_on_session_reset ? tm : "",
    videospringer: draft.keep_videospringer_on_session_reset ? vs : "",
    operator_name: op ? canonicalCrewName(crew_list, op) : "",
    sd_pc_name,
    /** Keep flat field in sync for Rust SD mirror (source of truth = profile). */
    sd_server_backup_url: activeBackupUrl,
    crew_list,
    crew_removed_names,
  });
}

function validateDraft(
  draft: AppConfig,
  t: (key: string) => string,
): ValidationResult {
  if (draft.sd_auto_backup && !draft.sd_backup_folder.trim()) {
    return {
      ok: false,
      message: t("settings.save.pickBackup"),
      tab: "sd",
    };
  }
  const activeBackupUrl =
    getActiveServerProfile(draft)?.backup_url?.trim() ?? "";
  if (draft.sd_server_backup_enabled && !activeBackupUrl) {
    return {
      ok: false,
      message: t("settings.save.pickSecondBackup"),
      title: t("settings.tabs.sd"),
      focus: "server-backup-url",
      tab: "server",
    };
  }
  const op = draft.operator_name.trim();
  if (op && !findCrewMember(draft.crew_list, op)) {
    return {
      ok: false,
      message: t("settings.save.operatorRole"),
      title: t("settings.tabs.crew"),
      tab: "crew",
    };
  }
  return { ok: true };
}

function connectionFieldsChanged(prev: AppConfig, next: AppConfig): boolean {
  return (
    prev.server_url !== next.server_url ||
    prev.server_login !== next.server_login ||
    prev.server_password !== next.server_password ||
    prev.active_server_profile_id !== next.active_server_profile_id ||
    JSON.stringify(prev.server_profiles) !== JSON.stringify(next.server_profiles)
  );
}

function amsFieldsChanged(prev: AppConfig, next: AppConfig): boolean {
  return (
    prev.ams_bridge_url !== next.ams_bridge_url ||
    prev.ams_bridge_token !== next.ams_bridge_token
  );
}

export function useSettingsDraft(open: boolean, config: AppConfig | null) {
  const { t } = useTranslation();
  const persist = useConfigStore((s) => s.persist);
  const resetToDefaults = useConfigStore((s) => s.resetToDefaults);
  const saving = useConfigStore((s) => s.saving);
  const showError = useUiStore((s) => s.showError);
  const openSettings = useUiStore((s) => s.openSettings);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const checkAmsHealth = useAmsBridgeStore((s) => s.checkHealth);
  const resetAmsHealth = useAmsBridgeStore((s) => s.reset);
  const activeLanguage = useLocaleStore((s) => s.language);

  const [draft, setDraftState] = useState<AppConfig | null>(null);
  const [persistState, setPersistState] =
    useState<SettingsPersistState>("idle");

  const draftRef = useRef<AppConfig | null>(null);
  const lastPersistedRef = useRef<AppConfig | null>(null);
  const persistGenRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);
  const sideEffectTimerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const rerunAfterFlightRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current != null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearSideEffectTimer = useCallback(() => {
    if (sideEffectTimerRef.current != null) {
      window.clearTimeout(sideEffectTimerRef.current);
      sideEffectTimerRef.current = null;
    }
  }, []);

  const reportValidation = useCallback(
    (failure: ValidationFailure) => {
      showError(failure.message, failure.title);
      if (failure.focus) {
        openSettings({ tab: "server", focus: failure.focus });
      } else if (failure.tab) {
        openSettings({ tab: failure.tab });
      }
      setPersistState("error");
    },
    [openSettings, showError],
  );

  const runSideEffects = useCallback(
    (prev: AppConfig, saved: AppConfig) => {
      clearSideEffectTimer();
      sideEffectTimerRef.current = window.setTimeout(() => {
        sideEffectTimerRef.current = null;
        const serverChanged = connectionFieldsChanged(prev, saved);
        const amsChanged = amsFieldsChanged(prev, saved);
        if (serverChanged && saved.server_url.trim()) {
          void checkConnection({
            server_url: saved.server_url,
            server_login: saved.server_login,
            server_password: saved.server_password,
          }).then((result) => {
            if (result.ok) {
              void runAmsAutoConnect({ config: saved, interactive: true });
            }
          });
        }
        if (amsChanged) {
          if (isAmsBridgeConfigured(saved)) void checkAmsHealth();
          else resetAmsHealth();
        }
      }, SIDE_EFFECT_DEBOUNCE_MS);
    },
    [
      checkAmsHealth,
      checkConnection,
      clearSideEffectTimer,
      resetAmsHealth,
    ],
  );

  const persistDraft = useCallback(
    async (
      source: AppConfig,
      opts: { showValidationErrors: boolean; silent?: boolean },
    ): Promise<boolean> => {
      const normalized = await normalizeDraftForPersist(source);
      const validation = validateDraft(normalized, t);
      if (!validation.ok) {
        if (opts.showValidationErrors) reportValidation(validation);
        else {
          setPersistState("idle");
        }
        return false;
      }

      const gen = ++persistGenRef.current;
      const prevSaved = lastPersistedRef.current;
      inFlightRef.current = true;
      setPersistState("saving");

      const saved = await persist(normalized);
      if (gen !== persistGenRef.current) {
        // Superseded by a newer persist call (that owns inFlight).
        return false;
      }

      inFlightRef.current = false;

      if (!saved) {
        if (!opts.silent) showError(t("settings.save.failed"));
        setPersistState("error");
        return false;
      }

      lastPersistedRef.current = saved;

      const current = draftRef.current;
      if (
        current &&
        (configsEqual(current, source) || configsEqual(current, normalized))
      ) {
        const sorted = sortCrewList(saved);
        draftRef.current = sorted;
        setDraftState(sorted);
      } else if (current && openRef.current) {
        rerunAfterFlightRef.current = true;
      }

      if (prevSaved && !opts.silent) {
        runSideEffects(prevSaved, saved);
      } else if (!prevSaved && !opts.silent) {
        // First persist after open — still run if connection fields differ from store seed.
        const seed = useConfigStore.getState().config;
        if (seed) runSideEffects(seed, saved);
      }

      if (rerunAfterFlightRef.current && openRef.current) {
        rerunAfterFlightRef.current = false;
        const latest = draftRef.current;
        if (latest && !configsEqual(latest, saved)) {
          setPersistState("pending");
          void persistDraft(latest, {
            showValidationErrors: false,
            silent: opts.silent,
          });
          return true;
        }
      }

      setPersistState("idle");
      return true;
    },
    [persist, reportValidation, runSideEffects, showError, t],
  );

  const schedulePersist = useCallback(
    (mode: SettingsPersistMode, opts?: { showValidationErrors?: boolean }) => {
      if (!openRef.current) return;
      const showValidationErrors = opts?.showValidationErrors ?? mode === "now";

      clearDebounceTimer();

      if (mode === "debounce") {
        setPersistState((s) => (s === "saving" ? s : "pending"));
        debounceTimerRef.current = window.setTimeout(() => {
          debounceTimerRef.current = null;
          const latest = draftRef.current;
          if (!latest || !openRef.current) return;
          const persisted = lastPersistedRef.current;
          if (persisted && configsEqual(latest, persisted)) {
            setPersistState("idle");
            return;
          }
          if (inFlightRef.current) {
            rerunAfterFlightRef.current = true;
            return;
          }
          void persistDraft(latest, {
            showValidationErrors: false,
            silent: false,
          });
        }, DEBOUNCE_MS);
        return;
      }

      // mode === "now"
      clearDebounceTimer();
      const latest = draftRef.current;
      if (!latest) return;
      const persisted = lastPersistedRef.current;
      if (persisted && configsEqual(latest, persisted)) {
        setPersistState("idle");
        return;
      }
      if (inFlightRef.current) {
        rerunAfterFlightRef.current = true;
        setPersistState("pending");
        return;
      }
      void persistDraft(latest, { showValidationErrors, silent: false });
    },
    [clearDebounceTimer, persistDraft],
  );

  const applyDraftUpdate = useCallback(
    (
      update: SetStateAction<AppConfig | null>,
      mode: SettingsPersistMode | false,
    ) => {
      setDraftState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        draftRef.current = next;
        if (!next || mode === false) return next;

        const cfg = useConfigStore.getState().config;
        if (cfg && configsEqual(next, cfg)) {
          lastPersistedRef.current = cfg;
          clearDebounceTimer();
          setPersistState("idle");
          return next;
        }

        // Defer schedule so we don't call setState of persistState inside this updater.
        queueMicrotask(() => {
          if (draftRef.current !== next) return;
          schedulePersist(mode);
        });
        return next;
      });
    },
    [clearDebounceTimer, schedulePersist],
  );

  const setDraft = useCallback<Dispatch<SetStateAction<AppConfig | null>>>(
    (update) => applyDraftUpdate(update, "debounce"),
    [applyDraftUpdate],
  );

  const commitNow = useCallback(
    (update: SetStateAction<AppConfig | null>) =>
      applyDraftUpdate(update, "now"),
    [applyDraftUpdate],
  );

  const patch = useCallback<SettingsPatch>(
    (key, value) => {
      applyDraftUpdate(
        (prev) => (prev ? { ...prev, [key]: value } : prev),
        "debounce",
      );
    },
    [applyDraftUpdate],
  );

  const patchNow = useCallback<SettingsPatch>(
    (key, value) => {
      applyDraftUpdate(
        (prev) => (prev ? { ...prev, [key]: value } : prev),
        "now",
      );
    },
    [applyDraftUpdate],
  );

  const persistDraftRef = useRef(persistDraft);
  persistDraftRef.current = persistDraft;

  const flush = useCallback(async (): Promise<boolean> => {
    clearDebounceTimer();
    const latest = draftRef.current;
    if (!latest) return true;

    const persisted = lastPersistedRef.current;
    const cfg = useConfigStore.getState().config;
    if (
      (persisted && configsEqual(latest, persisted)) ||
      (cfg && configsEqual(latest, cfg))
    ) {
      setPersistState("idle");
      return true;
    }

    // Wait out an in-flight save, then persist latest if still dirty.
    if (inFlightRef.current) {
      for (let i = 0; i < 100 && inFlightRef.current; i++) {
        await new Promise((r) => window.setTimeout(r, 50));
      }
      const after = draftRef.current;
      const afterPersisted = lastPersistedRef.current;
      if (
        after &&
        afterPersisted &&
        configsEqual(after, afterPersisted)
      ) {
        setPersistState("idle");
        return true;
      }
    }

    const toSave = draftRef.current;
    if (!toSave) return true;
    return persistDraftRef.current(toSave, {
      showValidationErrors: true,
      silent: false,
    });
  }, [clearDebounceTimer]);

  // Seed draft only when the dialog opens — not on every quiet-poll config touch.
  useEffect(() => {
    if (!open) {
      clearDebounceTimer();
      clearSideEffectTimer();
      persistGenRef.current += 1;
      inFlightRef.current = false;
      rerunAfterFlightRef.current = false;
      setPersistState("idle");
      return;
    }

    const cfg = useConfigStore.getState().config;
    const lang = useLocaleStore.getState().language;
    if (!cfg) return;

    let cancelled = false;
    const seeded = sortCrewList({ ...cfg, ui_language: lang });
    draftRef.current = seeded;
    lastPersistedRef.current = seeded;
    setDraftState(seeded);
    setPersistState("idle");

    void getAppInfo()
      .then((info) => {
        if (cancelled || !openRef.current) return;
        const host = info.computer_name || "";
        const current = draftRef.current;
        if (!current) return;
        const nextName = !current.sd_pc_name.trim()
          ? composeSdPcName(host, current.operator_name)
          : resolveSdPcName(current.sd_pc_name, host, current.operator_name);
        if (nextName === current.sd_pc_name) return;
        const next = { ...current, sd_pc_name: nextName };
        draftRef.current = next;
        setDraftState(next);
        void persistDraftRef.current(next, {
          showValidationErrors: false,
          silent: true,
        });
      })
      .catch(() => {
        /* keep existing */
      });

    return () => {
      cancelled = true;
    };
  }, [open, clearDebounceTimer, clearSideEffectTimer]);

  // Config arrived after open (or first paint with null): seed once, never clobber edits.
  useEffect(() => {
    if (!open || !config) return;
    setDraftState((prev) => {
      if (prev) return prev;
      const seeded = sortCrewList({
        ...config,
        ui_language: activeLanguage,
      });
      draftRef.current = seeded;
      lastPersistedRef.current = seeded;
      return seeded;
    });
  }, [open, config, activeLanguage]);

  useEffect(() => {
    return () => {
      clearDebounceTimer();
      clearSideEffectTimer();
    };
  }, [clearDebounceTimer, clearSideEffectTimer]);

  const resetToFactory = useCallback(async (): Promise<AppConfig | null> => {
    clearDebounceTimer();
    clearSideEffectTimer();
    persistGenRef.current += 1;
    const restored = await resetToDefaults();
    if (!restored) {
      showError(t("settings.save.resetFailed"));
      return null;
    }
    const sorted = sortCrewList(restored);
    draftRef.current = sorted;
    lastPersistedRef.current = sorted;
    setDraftState(sorted);
    setPersistState("idle");
    return sorted;
  }, [
    clearDebounceTimer,
    clearSideEffectTimer,
    resetToDefaults,
    showError,
    t,
  ]);

  return {
    draft,
    setDraft,
    commitNow,
    patch,
    patchNow,
    flush,
    resetToFactory,
    saving,
    persistState,
  };
}
