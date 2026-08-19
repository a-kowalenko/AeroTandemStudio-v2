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
  primaryAction?: DialogPrimaryAction | null;
  onPrimaryAction?: () => void;
  onClose: () => void;
};

export function ErrorDialog({
  open,
  title,
  message,
  primaryAction = null,
  onPrimaryAction,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("dialogs.error.defaultTitle");
  const actionLabel = primaryAction?.label?.trim() ?? "";
  const hasAction = Boolean(actionLabel && onPrimaryAction);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="z-[100] max-w-md border-l-4 border-l-destructive"
        overlayClassName="z-[100]"
      >
        <DialogHeader>
          <DialogTitle className="text-destructive">{resolvedTitle}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-foreground">
            {message}
          </DialogDescription>
        </DialogHeader>
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
