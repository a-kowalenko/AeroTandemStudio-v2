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

export type CancelSecondaryBackupConfirmChoice = "keep" | "cancel";

type Props = {
  open: boolean;
  onChoose: (choice: CancelSecondaryBackupConfirmChoice) => void;
};

/**
 * Soft confirm before aborting the current SD server-backup job.
 * Local backup stays; remote may be incomplete. Does not stop Vorgang upload.
 */
export function CancelSecondaryBackupConfirmDialog({ open, onChoose }: Props) {
  const { t } = useTranslation();
  const chosenRef = useRef(false);
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  useEffect(() => {
    if (!open) {
      chosenRef.current = false;
    }
  }, [open]);

  function choose(choice: CancelSecondaryBackupConfirmChoice) {
    if (chosenRef.current) return;
    chosenRef.current = true;
    onChooseRef.current(choice);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) choose("keep");
      }}
    >
      <DialogContent
        className="max-w-md overflow-hidden border-l-4 border-l-warning"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          choose("keep");
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="text-warning">
            {t("dialogs.cancelServerBackup.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">{t("dialogs.cancelServerBackup.body")}</p>
              <p className="text-muted">{t("dialogs.cancelServerBackup.hint")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => choose("keep")}>
            {t("dialogs.cancelServerBackup.keep")}
          </Button>
          <Button variant="destructive" onClick={() => choose("cancel")}>
            {t("dialogs.cancelServerBackup.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
