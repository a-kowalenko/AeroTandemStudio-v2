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

export type QuitUploadConfirmChoice = "stay" | "quit";

type Props = {
  open: boolean;
  onChoose: (choice: QuitUploadConfirmChoice) => void;
};

/**
 * Soft confirm when closing the app while a background SMB upload
 * (active slot or queue) is still running.
 */
export function QuitUploadConfirmDialog({ open, onChoose }: Props) {
  const { t } = useTranslation();
  const chosenRef = useRef(false);
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  useEffect(() => {
    if (!open) {
      chosenRef.current = false;
    }
  }, [open]);

  function choose(choice: QuitUploadConfirmChoice) {
    if (chosenRef.current) return;
    chosenRef.current = true;
    onChooseRef.current(choice);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) choose("stay");
      }}
    >
      <DialogContent
        className="max-w-md overflow-hidden border-l-4 border-l-warning"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          choose("stay");
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="text-warning">
            {t("dialogs.quitUpload.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">{t("dialogs.quitUpload.body")}</p>
              <p className="text-muted">{t("dialogs.quitUpload.hint")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => choose("stay")}>
            {t("dialogs.quitUpload.stay")}
          </Button>
          <Button variant="destructive" onClick={() => choose("quit")}>
            {t("dialogs.quitUpload.quit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
