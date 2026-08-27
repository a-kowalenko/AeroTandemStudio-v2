import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { applyAmsPathHintsWithCredentials } from "@/lib/amsPathHintsCredentialsFlow";
import {
  bindPathHintsServerInstance,
  computePathHintsDiff,
  pathHintsApplyInstanceAllowed,
} from "@/lib/amsPathHintsCore";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";
import type { AppConfig } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Props = {
  draft: AppConfig;
  setDraft: (next: AppConfig) => void;
  /** When set, persist after apply (Settings). Wizard omits this. */
  persist?: (config: AppConfig) => Promise<AppConfig | null>;
  onError?: (message: string, title?: string) => void;
  errorTitle?: string;
  disabled?: boolean;
  /** Settings / Wizard: diff from draft + store hints (avoids quiet-poll flicker). */
  diffFromDraft?: boolean;
  /** Hide while the server-profile editor is open (create/edit). */
  hidden?: boolean;
};

export function AmsPathHintsSuggestBanner({
  draft,
  setDraft,
  persist,
  onError,
  errorTitle,
  disabled = false,
  diffFromDraft = false,
  hidden = false,
}: Props) {
  const { t } = useTranslation();
  const pathHints = useAmsBridgeStore((s) => s.pathHints);
  const storeDiff = useAmsBridgeStore((s) => s.pathHintsDiff);
  const serverInstanceId = useAmsBridgeStore((s) => s.serverInstanceId);
  const connected = useAmsBridgeStore((s) => s.connected);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const [applying, setApplying] = useState(false);

  const pathHintsDiff = useMemo(() => {
    if (diffFromDraft && pathHints) {
      return computePathHintsDiff(draft, pathHints);
    }
    return storeDiff;
  }, [diffFromDraft, draft, pathHints, storeDiff]);

  const instanceAllowed = pathHintsApplyInstanceAllowed(
    draft.ams_bridge_server_instance_id,
    serverInstanceId,
  );

  if (
    hidden ||
    !connected ||
    !pathHintsDiff?.available ||
    pathHintsDiff.kind !== "suggest" ||
    !pathHintsDiff.hints
  ) {
    return null;
  }

  const hints = pathHintsDiff.hints;
  const locked = disabled || applying || !instanceAllowed;

  async function onApply() {
    if (locked) return;
    setApplying(true);
    try {
      let next = await applyAmsPathHintsWithCredentials({
        config: draft,
        hints,
        interactive: true,
      });
      next = bindPathHintsServerInstance(next, serverInstanceId);

      let saved = next;
      if (persist) {
        const persisted = await persist(next);
        if (!persisted) {
          onError?.(
            t("settings.server.pathHints.applyFailed"),
            errorTitle ?? t("settings.tabs.server"),
          );
          return;
        }
        saved = persisted;
        useConfigStore.getState().updateLocal(saved);
      }

      setDraft(saved);
      useAmsBridgeStore.getState().refreshPathHintsDiff(saved);

      if (saved.server_url.trim()) {
        void checkConnection({
          server_url: saved.server_url,
          server_login: saved.server_login,
          server_password: saved.server_password,
        });
      }
    } catch (err) {
      onError?.(
        String(err),
        errorTitle ?? t("settings.tabs.server"),
      );
    } finally {
      setApplying(false);
    }
  }

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-sky-400/35 bg-sky-500/[0.08] px-3 py-2.5 dark:border-sky-400/30 dark:bg-sky-400/[0.08]",
        disabled && "pointer-events-none opacity-60",
        applying && "opacity-80",
      )}
    >
      <span
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-900 dark:text-sky-100"
        aria-hidden
      >
        <Info className="size-3.5" strokeWidth={2.5} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-foreground">
          {t("settings.server.pathHints.suggestTitle")}
        </p>
        <p className="text-xs leading-snug text-muted">
          {t("settings.server.pathHints.suggestBody", {
            primary: hints.primarySmbUrl,
            backup: hints.backupSmbUrl
              ? t("settings.server.pathHints.suggestBackupLine", {
                  url: hints.backupSmbUrl,
                })
              : "",
          })}
        </p>
        {!instanceAllowed ? (
          <p className="text-xs leading-snug text-sky-900/90 dark:text-sky-100/90">
            {t("settings.server.pathHints.instanceMismatch")}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-xs"
        disabled={locked}
        onClick={() => void onApply()}
      >
        {applying ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {t("common.actions.checking")}
          </>
        ) : (
          t("common.actions.apply")
        )}
      </Button>
    </div>
  );
}
