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
import type { DialogPrimaryAction } from "@/store/uiStore";

type Props = {
  open: boolean;
  title?: string;
  message: string;
  /** Full technical text (e.g. FFmpeg stderr); shown collapsed by default. */
  details?: string | null;
  primaryAction?: DialogPrimaryAction | null;
  onPrimaryAction?: () => void;
  onClose: () => void;
};

export function ErrorDialog({
  open,
  title,
  message,
  details = null,
  primaryAction = null,
  onPrimaryAction,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("dialogs.error.defaultTitle");
  const actionLabel = primaryAction?.label?.trim() ?? "";
  const hasAction = Boolean(actionLabel && onPrimaryAction);
  const detailText = details?.trim() ?? "";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="z-[130] max-w-md border-l-4 border-l-destructive"
        overlayClassName="z-[130]"
      >
        <DialogHeader>
          <DialogTitle className="text-destructive">{resolvedTitle}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
            {message}
          </DialogDescription>
        </DialogHeader>
        {detailText ? (
          <details className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <summary className="cursor-pointer select-none text-sm text-muted-foreground">
              {t("dialogs.error.technicalDetails")}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground [overflow-wrap:anywhere]">
              {detailText}
            </pre>
          </details>
        ) : null}
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          {hasAction ? (
            <Button
              type="button"
              variant="secondary"
              className="shrink-0"
              onClick={onPrimaryAction}
            >
              {actionLabel}
            </Button>
          ) : null}
          <Button variant="destructive" className="shrink-0" onClick={onClose}>
            {t("common.actions.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
