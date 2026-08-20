import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProgressIndicator } from "@/components/ProgressIndicator";
import { ReleaseNotes } from "@/components/ReleaseNotes";
import { cn } from "@/lib/utils";
import type { UpdateInstallProgress } from "@/lib/tauri";
import { compareVersionParts } from "@/lib/versionCompare";

export type VersionInstallDialogProps = {
  open: boolean;
  fromVersion: string;
  toVersion: string | null;
  notes: string | null;
  /** Whether an install action is offered (update/switch available). */
  available: boolean;
  message: string;
  installing?: boolean;
  installProgress?: UpdateInstallProgress | null;
  /** When false, show installer download escape hatch instead of silent install. */
  silentAvailable?: boolean;
  /** When set, install is disabled (encode/SD/QR/upload in progress). */
  blockedReason?: string | null;
  /** Install-location hint (e.g. macOS not in /Applications). */
  platformHint?: string | null;
  /** Escape hatch when silent install is unavailable for this release. */
  installerUrl?: string | null;
  onInstall: () => void;
  onCancelInstall?: () => void;
  onLater: () => void;
  onClose: () => void;
};

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

function installDirection(
  from: string,
  to: string | null,
): "upgrade" | "downgrade" | "same" | null {
  if (!to) return null;
  const cmp = compareVersionParts(to, from);
  if (cmp > 0) return "upgrade";
  if (cmp < 0) return "downgrade";
  return "same";
}

export function UpdateDialog({
  open,
  fromVersion,
  toVersion,
  notes,
  available,
  message,
  installing = false,
  installProgress = null,
  silentAvailable = true,
  blockedReason = null,
  platformHint = null,
  installerUrl = null,
  onInstall,
  onCancelInstall,
  onLater,
  onClose,
}: VersionInstallDialogProps) {
  const { t } = useTranslation();
  const [notesOpen, setNotesOpen] = useState(false);
  const direction = installDirection(fromVersion, toVersion);
  const isDowngrade = direction === "downgrade";
  const canSilentInstall =
    available &&
    silentAvailable &&
    Boolean(toVersion) &&
    direction !== "same";
  const installDisabled = installing || Boolean(blockedReason) || !canSilentInstall;
  const phase = installProgress?.phase ?? (installing ? "download" : null);
  const canCancelDownload =
    installing && phase !== "install" && Boolean(onCancelInstall);

  useEffect(() => {
    if (!open) setNotesOpen(false);
  }, [open]);

  const progressLabel =
    phase === "install"
      ? isDowngrade
        ? t("dialogs.update.installingVersion")
        : t("dialogs.update.installingUpdate")
      : phase === "download"
        ? isDowngrade
          ? t("dialogs.update.downloadingVersion")
          : t("dialogs.update.downloadingUpdate")
        : installing
          ? t("dialogs.update.preparing")
          : undefined;

  const detailParts: string[] = [];
  if (installProgress && phase === "download") {
    const done = formatBytes(installProgress.downloadedBytes);
    const total =
      installProgress.totalBytes != null && installProgress.totalBytes > 0
        ? formatBytes(installProgress.totalBytes)
        : null;
    detailParts.push(total ? `${done} / ${total}` : done);
    const speed = formatSpeed(installProgress.speedBps);
    if (speed) detailParts.push(speed);
  }

  const title = !available
    ? t("dialogs.update.checkTitle")
    : isDowngrade
      ? t("dialogs.update.downgradeTitle")
      : t("dialogs.update.availableTitle");

  const primaryLabel = installing
    ? t("dialogs.update.installing")
    : isDowngrade
      ? t("dialogs.update.switchNow")
      : t("dialogs.update.updateNow");

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !installing) onClose();
      }}
    >
      <DialogContent
        className="z-[70] max-w-lg overflow-hidden"
        overlayClassName="z-[70]"
        hideCloseButton={installing}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const root = e.currentTarget;
          if (!(root instanceof HTMLElement)) return;
          const primary =
            root.querySelector<HTMLElement>('[data-update-primary]') ??
            root.querySelector<HTMLElement>("button:not([disabled])");
          primary?.focus();
        }}
        onEscapeKeyDown={(e) => {
          if (canCancelDownload) {
            e.preventDefault();
            onCancelInstall?.();
            return;
          }
          if (installing) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (installing) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (installing) e.preventDefault();
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="min-w-0 break-words">
            {message || t("dialogs.update.statusLoading")}
          </DialogDescription>
        </DialogHeader>

        {available && toVersion ? (
          <div className="min-w-0 space-y-3 text-sm">
            <p className="min-w-0 break-words">
              {isDowngrade ? (
                t("dialogs.update.replaceVersion", {
                  to: toVersion,
                  from: fromVersion,
                })
              ) : (
                <>
                  {t("dialogs.update.canInstall", { to: toVersion })}
                  <br />
                  {t("dialogs.update.current", { version: fromVersion })}
                </>
              )}
            </p>
            {isDowngrade ? (
              <p className="text-xs text-muted">
                {t("dialogs.update.downgradeHint")}
              </p>
            ) : null}
            <div className="min-w-0 space-y-1.5">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={notesOpen}
                disabled={installing}
                onClick={() => setNotesOpen((v) => !v)}
              >
                {t("dialogs.update.patchNotes")}
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 transition-transform duration-200",
                    notesOpen && "rotate-180",
                  )}
                />
              </button>
              {notesOpen ? (
                <div className="min-w-0 overflow-hidden border-l border-border/70 pl-3">
                  <ReleaseNotes
                    markdown={notes?.trim() ?? ""}
                    emptyLabel={t("dialogs.update.noNotes")}
                    className="max-h-52 max-w-full"
                  />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {platformHint && !installing ? (
          <p className="text-xs text-muted">{platformHint}</p>
        ) : null}

        {blockedReason && !installing ? (
          <p className="text-xs text-destructive">{blockedReason}</p>
        ) : null}

        {installing ? (
          <div className="min-w-0 space-y-2">
            <ProgressIndicator
              percent={
                installProgress?.percent ?? (phase === "install" ? 100 : 0)
              }
              label={progressLabel}
            />
            {detailParts.length > 0 ? (
              <p className="text-xs tabular-nums text-muted">
                {detailParts.join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="min-w-0 gap-2">
          {available ? (
            <>
              {canCancelDownload ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => onCancelInstall?.()}
                >
                  {t("common.actions.cancel")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={onLater}
                  disabled={installing}
                >
                  {t("dialogs.update.later")}
                </Button>
              )}
              {canSilentInstall ? (
                <Button
                  type="button"
                  data-update-primary
                  onClick={onInstall}
                  disabled={installDisabled}
                >
                  {primaryLabel}
                </Button>
              ) : installerUrl ? (
                <Button
                  type="button"
                  variant="secondary"
                  data-update-primary
                  disabled={installing}
                  onClick={() => {
                    void openUrl(installerUrl).catch(() => undefined);
                  }}
                >
                  {t("dialogs.update.downloadInstaller")}
                </Button>
              ) : null}
            </>
          ) : (
            <Button type="button" data-update-primary onClick={onClose}>
              {t("common.actions.ok")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
