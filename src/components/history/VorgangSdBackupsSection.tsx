import { useEffect, useState } from "react";
import { Copy, FolderOpen, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { useUiStore } from "@/store/uiStore";
import {
  listVorgangBackups,
  type VorgangBackup,
} from "@/lib/vorgangHistory";
import { cn } from "@/lib/utils";
import { VorgangFolderChip } from "./VorgangFolderChip";

type Props = {
  vorgangId: number;
  dialogOpen: boolean;
  refreshKey?: number;
};

function pathLeaf(path: string): string {
  const trimmed = path.trim().replace(/[/\\]+$/, "");
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return sep >= 0 ? trimmed.slice(sep + 1) : trimmed;
}

function BackupRow({ row }: { row: VorgangBackup }) {
  const { t } = useTranslation();
  const showError = useUiStore((s) => s.showError);
  const showSuccess = useUiStore((s) => s.showSuccess);
  const localPath = row.local_path.trim();
  const localLeaf = localPath ? pathLeaf(localPath) : "—";
  const remotePath = row.remote_path.trim();
  const renamedLocal = Boolean(row.local_renamed_at.trim());
  const renamedRemote = Boolean(row.remote_renamed_at.trim());
  const remoteError = row.remote_rename_error.trim();
  const originalLocal = row.local_original_name.trim();

  async function openLocalFolder() {
    if (!localPath || row.local_missing) return;
    try {
      await openPath(localPath);
    } catch (e) {
      showError(String(e), t("history.sdBackups.openFolder"));
    }
  }

  async function copyRemotePath() {
    if (!remotePath) return;
    try {
      await navigator.clipboard.writeText(remotePath);
      showSuccess(
        t("history.sdBackups.pathCopied"),
        t("history.sdBackups.copyRemotePath"),
      );
    } catch (e) {
      showError(String(e), t("history.sdBackups.copyRemotePath"));
    }
  }

  return (
    <li
      className={cn(
        "rounded-md border border-border/50 bg-muted/10 p-2 text-xs",
        row.local_missing && "border-amber-500/35 bg-amber-500/5",
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{localLeaf}</span>
            {renamedLocal ? (
              <span className="text-[10px] text-muted-foreground">
                {t("history.sdBackups.renamedLocal")}
              </span>
            ) : null}
            {row.local_missing ? <VorgangFolderChip /> : null}
          </div>
          {renamedLocal && originalLocal && originalLocal !== localLeaf ? (
            <p className="text-[10px] text-muted-foreground">
              {t("history.sdBackups.originalName", { name: originalLocal })}
            </p>
          ) : null}
          {row.local_missing ? (
            <p className="text-[10px] leading-snug text-amber-950 dark:text-amber-100">
              {t("history.sdBackups.folderMissingHint")}
            </p>
          ) : null}
          <p
            className="truncate text-[10px] text-muted-foreground"
            title={localPath}
          >
            {localPath}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1 px-2"
          disabled={!localPath || row.local_missing}
          title={
            row.local_missing
              ? t("history.sdBackups.folderMissingHint")
              : localPath
          }
          aria-label={t("history.sdBackups.openFolder")}
          onClick={() => void openLocalFolder()}
        >
          <FolderOpen className="h-3.5 w-3.5" aria-hidden />
          <span className="text-[11px]">{t("history.sdBackups.openFolder")}</span>
        </Button>
      </div>

      {remotePath ? (
        <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-medium text-muted-foreground">
            <Server className="h-3 w-3 shrink-0 opacity-80" aria-hidden />
            <span>{t("history.sdBackups.server")}</span>
            {renamedRemote ? (
              <span className="font-normal">
                · {t("history.sdBackups.renamedRemote")}
              </span>
            ) : null}
          </div>
          <p
            className="truncate text-[10px] text-muted-foreground"
            title={remotePath}
          >
            {remotePath}
          </p>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {t("history.sdBackups.remotePathHint")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 gap-1 px-2"
            aria-label={t("history.sdBackups.copyRemotePath")}
            onClick={() => void copyRemotePath()}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />
            <span className="text-[11px]">
              {t("history.sdBackups.copyRemotePath")}
            </span>
          </Button>
        </div>
      ) : null}

      {remoteError ? (
        <p
          className="mt-2 text-[10px] leading-snug text-amber-900 dark:text-amber-100"
          title={remoteError}
        >
          {t("history.sdBackups.remoteRenameFailed", { error: remoteError })}
        </p>
      ) : null}
    </li>
  );
}

export function VorgangSdBackupsSection({
  vorgangId,
  dialogOpen,
  refreshKey = 0,
}: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<VorgangBackup[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!dialogOpen) {
      setRows([]);
      setReady(false);
      return;
    }
    let cancelled = false;
    setReady(false);
    void listVorgangBackups(vorgangId)
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, vorgangId, refreshKey]);

  if (!ready) {
    return (
      <div className="text-[10px] text-muted-foreground">
        {t("history.sdBackups.loading")}
      </div>
    );
  }

  if (rows.length === 0) {
    return null;
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium text-muted-foreground">
        <span>{t("history.sdBackups.title")}</span>
        <span className="tabular-nums">{rows.length}</span>
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <BackupRow key={row.id} row={row} />
        ))}
      </ul>
    </div>
  );
}
