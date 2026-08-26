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

export type UploadExtraFilesConfirmChoice = "back" | "proceed";

type Props = {
  open: boolean;
  guest: string;
  extraPaths: string[];
  onChoose: (choice: UploadExtraFilesConfirmChoice) => void;
};

/**
 * Soft confirm when the job folder has files not listed in `_ams_manifest.v1.json`.
 * Proceed still uploads (extras included via collect_upload_files); Back cancels.
 */
export function UploadExtraFilesConfirmDialog({
  open,
  guest,
  extraPaths,
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

  function choose(choice: UploadExtraFilesConfirmChoice) {
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
            {t("dialogs.uploadExtraFiles.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">
                {t("dialogs.uploadExtraFiles.body", { guest })}
              </p>
              <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5">
                {extraPaths.map((p) => (
                  <li key={p} className="break-all">
                    {p}
                  </li>
                ))}
              </ul>
              <p className="text-muted">{t("dialogs.uploadExtraFiles.hint")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => choose("proceed")}>
            {t("dialogs.uploadExtraFiles.proceed")}
          </Button>
          <Button variant="default" onClick={() => choose("back")}>
            {t("common.actions.back")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
