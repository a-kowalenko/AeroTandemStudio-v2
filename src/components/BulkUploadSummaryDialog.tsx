import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PendingUploadPreviewLines } from "@/components/PendingUploadPreviewLines";
import {
  createEmptyBulkUploadSummary,
  type BulkUploadOkItem,
  type BulkUploadSummary,
  type BulkUploadSummaryItem,
} from "@/lib/vorgangHistory";

type Props = {
  open: boolean;
  summary: BulkUploadSummary | null;
  onClose: () => void;
};

type RowTone = "success" | "warning" | "error" | "skipped";

type SummaryRow = {
  key: string;
  label: string;
  detail?: string;
  okItems?: BulkUploadOkItem[];
  tone: RowTone;
};

function reasonLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  code: string,
): string {
  const key = `dialogs.uploadPreflightFail.codes.${code}`;
  const label = t(key);
  if (label !== key) return label;
  const bulkKey = `dialogs.bulkUploadSummary.codes.${code}`;
  const bulkLabel = t(bulkKey);
  return bulkLabel === bulkKey ? code : bulkLabel;
}

function formatItems(
  t: (key: string, opts?: Record<string, unknown>) => string,
  items: BulkUploadSummaryItem[],
): string | undefined {
  if (items.length === 0) return undefined;
  return items
    .map((item) => {
      const guest = item.guest?.trim() || `#${item.vorgangId}`;
      return `${guest} — ${reasonLabel(t, item.reasonCode)}`;
    })
    .join("\n");
}

function dotClass(tone: RowTone): string {
  switch (tone) {
    case "success":
      return "bg-success";
    case "warning":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/50";
  }
}

function summaryAccent(summary: BulkUploadSummary): "success" | "warning" {
  const hasProblem =
    summary.failed > 0 || summary.blocked > 0 || summary.aborted;
  return hasProblem ? "warning" : "success";
}

function buildRows(
  t: (key: string, opts?: Record<string, unknown>) => string,
  s: BulkUploadSummary,
): SummaryRow[] {
  const rows: SummaryRow[] = [];
  if (s.ok > 0) {
    rows.push({
      key: "ok",
      label: t("dialogs.bulkUploadSummary.ok", { count: s.ok }),
      okItems: s.okItems,
      tone: "success",
    });
  }
  if (s.decided > 0) {
    rows.push({
      key: "decided",
      label: t("dialogs.bulkUploadSummary.decided", { count: s.decided }),
      okItems: s.decidedItems,
      tone: "success",
    });
  }
  if (s.skipped > 0) {
    rows.push({
      key: "skipped",
      label: t("dialogs.bulkUploadSummary.skipped", { count: s.skipped }),
      detail: formatItems(t, s.skippedItems),
      tone: "skipped",
    });
  }
  if (s.blocked > 0) {
    rows.push({
      key: "blocked",
      label: t("dialogs.bulkUploadSummary.blocked", { count: s.blocked }),
      detail: formatItems(t, s.blockedItems),
      tone: "warning",
    });
  }
  if (s.failed > 0) {
    rows.push({
      key: "failed",
      label: t("dialogs.bulkUploadSummary.failed", { count: s.failed }),
      detail: formatItems(t, s.failedItems),
      tone: "error",
    });
  }
  if (s.aborted && s.remaining > 0) {
    rows.push({
      key: "aborted",
      label: t("dialogs.bulkUploadSummary.aborted", { count: s.remaining }),
      tone: "warning",
    });
  }
  return rows;
}

/** End-of-bulk summary: ok / decided / skipped / blocked / failed (Phase 31.3 / 31.6). */
export function BulkUploadSummaryDialog({ open, summary, onClose }: Props) {
  const { t } = useTranslation();
  const closedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) closedRef.current = false;
  }, [open]);

  function close() {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  }

  const s = summary ?? createEmptyBulkUploadSummary();
  const accent = summaryAccent(s);
  const rows = buildRows(t, s);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent
        className={cn(
          "max-w-[min(28rem,calc(100vw-2rem))] gap-5 overflow-hidden border-l-4 pb-7",
          accent === "success" ? "border-l-success" : "border-l-warning",
        )}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <DialogHeader className="min-w-0 space-y-3 pr-6">
          <div className="flex min-w-0 items-center gap-3">
            {accent === "success" ? (
              <CheckCircle2 className="h-8 w-8 shrink-0 text-success" aria-hidden />
            ) : (
              <AlertTriangle className="h-8 w-8 shrink-0 text-warning" aria-hidden />
            )}
            <DialogTitle
              className={cn(
                "min-w-0 break-words",
                accent === "success" ? "text-success" : "text-warning",
              )}
            >
              {t("dialogs.bulkUploadSummary.title")}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t("dialogs.bulkUploadSummary.title")}
          </DialogDescription>
        </DialogHeader>

        {rows.length > 0 ? (
          <ul className="min-w-0 space-y-2">
            {rows.map((row) => (
              <li
                key={row.key}
                className="min-w-0 space-y-2 rounded-md border border-border/50 px-3 py-2"
              >
                <div className="flex min-w-0 gap-2">
                  <span
                    className={cn(
                      "mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full",
                      dotClass(row.tone),
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium text-foreground">
                      {row.label}
                    </p>
                    {row.detail ? (
                      <p
                        className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted [overflow-wrap:anywhere]"
                        title={row.detail}
                      >
                        {row.detail}
                      </p>
                    ) : null}
                  </div>
                </div>
                {row.okItems && row.okItems.length > 0 ? (
                  <PendingUploadPreviewLines
                    lines={row.okItems}
                    maxHeightClassName="max-h-40"
                    className="border-border/50 bg-muted/10"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <DialogFooter className="w-full min-w-0 gap-2 sm:justify-end">
          <Button
            type="button"
            className="w-full shrink-0 sm:ml-auto sm:w-auto"
            onClick={close}
          >
            {t("common.actions.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
