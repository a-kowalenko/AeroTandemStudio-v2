import { useEffect, useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";

export type UploadExtraFilesConfirmChoice =
  | "back"
  | { action: "proceed"; purgeExtras: boolean };

type Props = {
  open: boolean;
  guest: string;
  extraPaths: string[];
  onChoose: (choice: UploadExtraFilesConfirmChoice) => void;
};

/**
 * Soft confirm when the job folder has files not in the original delivery list.
 * Default: resync delivery list and upload all files. Optional: delete extras first.
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
  const [purgeExtras, setPurgeExtras] = useState(false);

  useEffect(() => {
    if (!open) {
      chosenRef.current = false;
      setPurgeExtras(false);
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
              <label
                htmlFor="upload-extra-purge-switch"
                className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5"
              >
                <Switch
                  id="upload-extra-purge-switch"
                  checked={purgeExtras}
                  onCheckedChange={setPurgeExtras}
                />
                <span className="text-sm text-foreground">
                  {t("dialogs.uploadExtraFiles.purgeSwitch")}
                </span>
              </label>
              <p className="text-muted">
                {purgeExtras
                  ? t("dialogs.uploadExtraFiles.hintPurge")
                  : t("dialogs.uploadExtraFiles.hintInclude")}
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() =>
              choose({ action: "proceed", purgeExtras })
            }
          >
            {purgeExtras
              ? t("dialogs.uploadExtraFiles.proceedPurge")
              : t("dialogs.uploadExtraFiles.proceedInclude")}
          </Button>
          <Button variant="default" onClick={() => choose("back")}>
            {t("common.actions.back")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
