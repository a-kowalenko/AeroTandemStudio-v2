import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { applyAmsPathHintsWithCredentials } from "@/lib/amsPathHintsCredentialsFlow";
import {
  bindPathHintsServerInstance,
  buildPathHintsDriftDismissState,
  computePathHintsDiff,
  pathHintsApplyInstanceAllowed,
  pathHintsDriftFacets,
  shouldSuppressPathHintsDriftBanner,
} from "@/lib/amsPathHintsCore";
import {
  clearPathHintsDriftDismiss,
  readPathHintsDriftDismiss,
  writePathHintsDriftDismiss,
} from "@/lib/amsPathHintsDismiss";
import { useAmsBridgeStore } from "@/store/amsBridgeStore";
import { useConfigStore } from "@/store/configStore";
import { useServerStore } from "@/store/serverStore";
import type { AppConfig } from "@/lib/tauri";
import { PathHintsDriftList } from "@/components/PathHintsDisplay";
import { cn } from "@/lib/utils";

type Props = {
  draft: AppConfig;
  setDraft: (next: AppConfig) => void;
  /** When set, persist after apply (Settings / main shell). Wizard omits this. */
  persist?: (config: AppConfig) => Promise<AppConfig | null>;
  onError?: (message: string, title?: string) => void;
  errorTitle?: string;
  disabled?: boolean;
  /** Settings / Wizard: diff from draft + store hints (avoids quiet-poll flicker). */
  diffFromDraft?: boolean;
  /** Hide while the server-profile editor is open (create/edit). */
  hidden?: boolean;
  /**
   * Optional outer chrome (e.g. shell strip under the header).
   * Only rendered when the banner is visible — avoids an empty gap.
   */
  frameClassName?: string;
};

export function AmsPathHintsDriftBanner({
  draft,
  setDraft,
  persist,
  onError,
  errorTitle,
  disabled = false,
  diffFromDraft = false,
  hidden = false,
  frameClassName,
}: Props) {
  const { t } = useTranslation();
  const pathHints = useAmsBridgeStore((s) => s.pathHints);
  const storeDiff = useAmsBridgeStore((s) => s.pathHintsDiff);
  const serverInstanceId = useAmsBridgeStore((s) => s.serverInstanceId);
  const connected = useAmsBridgeStore((s) => s.connected);
  const checkConnection = useServerStore((s) => s.checkConnection);
  const [applying, setApplying] = useState(false);
  const [dismissRev, setDismissRev] = useState(0);

  const pathHintsDiff = useMemo(() => {
    if (diffFromDraft && pathHints) {
      return computePathHintsDiff(draft, pathHints);
    }
    return storeDiff;
  }, [diffFromDraft, draft, pathHints, storeDiff]);

  const dismissed = useMemo(() => {
    void dismissRev;
    return readPathHintsDriftDismiss();
  }, [dismissRev]);

  const instanceAllowed = pathHintsApplyInstanceAllowed(
    draft.ams_bridge_server_instance_id,
    serverInstanceId,
  );

  if (
    hidden ||
    !connected ||
    !pathHintsDiff?.available ||
    pathHintsDiff.kind !== "drift" ||
    !pathHintsDiff.hints ||
    shouldSuppressPathHintsDriftBanner(pathHintsDiff, dismissed)
  ) {
    return null;
  }

  const hints = pathHintsDiff.hints;
  const { primary: primaryDrift, backup: backupDrift } =
    pathHintsDriftFacets(pathHintsDiff);
  const locked = disabled || applying || !instanceAllowed;

  function onDismissLater() {
    const state = buildPathHintsDriftDismissState(pathHintsDiff!);
    if (state) {
      writePathHintsDriftDismiss(state);
      setDismissRev((n) => n + 1);
    }
  }

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

      clearPathHintsDriftDismiss();
      setDismissRev((n) => n + 1);
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

  const driftPrimary = primaryDrift
    ? {
        current: pathHintsDiff.currentPrimary,
        suggested: hints.primarySmbUrl,
      }
    : null;
  const driftBackup =
    backupDrift && hints.backupSmbUrl
      ? {
          current: pathHintsDiff.currentBackup || "—",
          suggested: hints.backupSmbUrl,
        }
      : null;

  const banner = (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-amber-400/40 bg-amber-500/[0.08] px-3 py-2.5 dark:border-amber-400/35 dark:bg-amber-400/[0.08]",
        disabled && "pointer-events-none opacity-60",
        applying && "opacity-80",
      )}
      role="status"
    >
      <span
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-900 dark:text-amber-100"
        aria-hidden
      >
        <AlertTriangle className="size-3.5" strokeWidth={2.5} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-foreground">
          {t("settings.server.pathHints.driftTitle")}
        </p>
        <PathHintsDriftList primary={driftPrimary} backup={driftBackup} />
        {!instanceAllowed ? (
          <p className="text-xs leading-snug text-amber-900/90 dark:text-amber-100/90">
            {t("settings.server.pathHints.instanceMismatch")}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={applying}
          onClick={onDismissLater}
        >
          {t("settings.server.pathHints.dismissLater")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7 px-2.5 text-xs"
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
    </div>
  );

  if (frameClassName) {
    return <div className={frameClassName}>{banner}</div>;
  }
  return banner;
}
