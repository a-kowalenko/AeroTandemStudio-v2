import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  guest: string;
  folderPath: string;
  missingPaths: string[];
  onUploadAvailable: () => void;
  onClose: () => void;
};

/** Hard fail when manifest files are missing — offers folder open + partial upload. */
export function UploadMissingFilesDialog({
  open,
  guest,
  folderPath,
  missingPaths,
  onUploadAvailable,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const closedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      closedRef.current = false;
    }
  }, [open]);

  function close() {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  }

  async function openFolder() {
    const path = folderPath.trim();
    if (!path) return;
    try {
      await openPath(path);
    } catch {
      // ignore — folder may be unreachable on some platforms
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent
        className="max-w-md overflow-hidden border-l-4 border-l-destructive"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="text-destructive">
            {t("dialogs.uploadPreflightFail.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">
                {t("dialogs.uploadMissingFiles.body", { guest })}
              </p>
              <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5">
                {missingPaths.map((p) => (
                  <li key={p} className="break-all">
                    {p}
                  </li>
                ))}
              </ul>
              <p className="text-muted">{t("dialogs.uploadMissingFiles.hint")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 flex-col gap-2 sm:flex-col sm:items-stretch">
          <Button variant="outline" onClick={() => void openFolder()}>
            {t("dialogs.uploadMissingFiles.openFolder")}
          </Button>
          <Button variant="outline" onClick={onUploadAvailable}>
            {t("dialogs.uploadMissingFiles.uploadAvailable")}
          </Button>
          <Button variant="default" onClick={close}>
            {t("common.actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
