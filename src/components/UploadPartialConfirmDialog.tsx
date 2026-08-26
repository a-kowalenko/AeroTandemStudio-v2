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

export type UploadPartialConfirmChoice = "back" | "proceed";

type Props = {
  open: boolean;
  guest: string;
  missingPaths: string[];
  onChoose: (choice: UploadPartialConfirmChoice) => void;
};

/** Soft confirm before uploading without missing files (Phase 31.4). */
export function UploadPartialConfirmDialog({
  open,
  guest,
  missingPaths,
  onChoose,
}: Props) {
  const { t } = useTranslation();
  const chosenRef = useRef(false);
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  useEffect(() => {
    if (!open) {
      chosenRef.current = false;
    }
  }, [open]);

  function choose(choice: UploadPartialConfirmChoice) {
    if (chosenRef.current) return;
    chosenRef.current = true;
    onChooseRef.current(choice);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) choose("back");
      }}
    >
      <DialogContent
        className="max-w-md overflow-hidden border-l-4 border-l-warning"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          choose("back");
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="text-warning">
            {t("dialogs.uploadPartialConfirm.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">
                {t("dialogs.uploadPartialConfirm.body", {
                  guest,
                  count: missingPaths.length,
                })}
              </p>
              <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5">
                {missingPaths.map((p) => (
                  <li key={p} className="break-all">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => choose("proceed")}>
            {t("dialogs.uploadPartialConfirm.proceed")}
          </Button>
          <Button variant="default" onClick={() => choose("back")}>
            {t("common.actions.back")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
