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

export type FolderConflictConfirmChoice = "back" | "replace";

type Props = {
  open: boolean;
  folderName: string;
  hasMarker: boolean;
  videoFileCount: number;
  photoFileCount: number;
  otherFileCount: number;
  uploadToServer: boolean;
  onChoose: (choice: FolderConflictConfirmChoice) => void;
};

/**
 * Soft confirm when the planned create folder already has files.
 * Replace clears the folder; Back cancels. No silent merge.
 */
export function FolderConflictConfirmDialog({
  open,
  folderName,
  hasMarker,
  videoFileCount,
  photoFileCount,
  otherFileCount,
  uploadToServer,
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

  function choose(choice: FolderConflictConfirmChoice) {
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
            {t("dialogs.folderConflict.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">
                {t("dialogs.folderConflict.body", { name: folderName })}
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {videoFileCount > 0 ? (
                  <li>
                    {t(
                      videoFileCount === 1
                        ? "dialogs.folderConflict.videosOne"
                        : "dialogs.folderConflict.videosMany",
                      { count: videoFileCount },
                    )}
                  </li>
                ) : null}
                {photoFileCount > 0 ? (
                  <li>
                    {t(
                      photoFileCount === 1
                        ? "dialogs.folderConflict.photosOne"
                        : "dialogs.folderConflict.photosMany",
                      { count: photoFileCount },
                    )}
                  </li>
                ) : null}
                {otherFileCount > 0 &&
                videoFileCount === 0 &&
                photoFileCount === 0 ? (
                  <li>
                    {t("dialogs.folderConflict.otherFiles", {
                      count: otherFileCount,
                    })}
                  </li>
                ) : null}
                {hasMarker ? (
                  <li>{t("dialogs.folderConflict.hasMarker")}</li>
                ) : null}
              </ul>
              <p className="text-muted">
                {uploadToServer
                  ? t("dialogs.folderConflict.hintUpload")
                  : t("dialogs.folderConflict.hintEncode")}
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => choose("replace")}>
            {t("dialogs.folderConflict.replace")}
          </Button>
          <Button variant="default" onClick={() => choose("back")}>
            {t("common.actions.back")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
