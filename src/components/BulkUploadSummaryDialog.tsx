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
import type { BulkUploadSummary } from "@/lib/vorgangHistory";

type Props = {
  open: boolean;
  summary: BulkUploadSummary | null;
  onClose: () => void;
};

/** End-of-bulk summary: ok / skipped / failed (Phase 31.3). */
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

  const s = summary ?? { ok: 0, skipped: 0, failed: 0, aborted: false, remaining: 0 };

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
                <li>
                  {t("dialogs.bulkUploadSummary.skipped", { count: s.skipped })}
                </li>
                <li>
                  {t("dialogs.bulkUploadSummary.failed", { count: s.failed })}
                </li>
              </ul>
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
