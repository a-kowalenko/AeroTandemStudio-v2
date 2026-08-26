import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  createEmptyBulkUploadSummary,
  type BulkUploadSummary,
  type BulkUploadSummaryItem,
} from "@/lib/vorgangHistory";

type Props = {
  open: boolean;
  summary: BulkUploadSummary | null;
  onClose: () => void;
};

function reasonLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  code: string,
): string {
  const key = `dialogs.uploadPreflightFail.codes.${code}`;
  const label = t(key);
  return label === key ? code : label;
}

function SummaryEntryList({
  title,
  items,
}: {
  title: string;
  items: BulkUploadSummaryItem[];
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="font-medium text-foreground">{title}</p>
      <ul className="max-h-40 list-none space-y-1 overflow-y-auto rounded-md border border-border/60 bg-muted/10 p-2 text-xs">
        {items.map((item) => (
          <li key={`${item.vorgangId}-${item.reasonCode}`} className="min-w-0">
            <span className="font-medium">{item.guest}</span>
            <span className="text-muted">
              {" — "}
              {t("dialogs.bulkUploadSummary.reason", {
                reason: reasonLabel(t, item.reasonCode),
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
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

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent
        className="max-w-md overflow-hidden border-l-4 border-l-primary"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle>{t("dialogs.bulkUploadSummary.title")}</DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <ul className="space-y-1.5 tabular-nums">
                <li>{t("dialogs.bulkUploadSummary.ok", { count: s.ok })}</li>
                {s.decided > 0 ? (
                  <li>
                    {t("dialogs.bulkUploadSummary.decided", {
                      count: s.decided,
                    })}
                  </li>
                ) : null}
                <li>
                  {t("dialogs.bulkUploadSummary.skipped", { count: s.skipped })}
                </li>
                {s.blocked > 0 ? (
                  <li>
                    {t("dialogs.bulkUploadSummary.blocked", {
                      count: s.blocked,
                    })}
                  </li>
                ) : null}
                <li>
                  {t("dialogs.bulkUploadSummary.failed", { count: s.failed })}
                </li>
              </ul>
              <SummaryEntryList
                title={t("dialogs.bulkUploadSummary.blockedList")}
                items={s.blockedItems}
              />
              <SummaryEntryList
                title={t("dialogs.bulkUploadSummary.skippedList")}
                items={s.skippedItems}
              />
              {s.aborted && s.remaining > 0 ? (
                <p className="text-muted">
                  {t("dialogs.bulkUploadSummary.aborted", {
                    count: s.remaining,
                  })}
                </p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="default" onClick={close}>
            {t("common.actions.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
