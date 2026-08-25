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
import type { LowMediaReason } from "@/lib/lowMediaConfirm";

export type LowMediaConfirmChoice = "back" | "proceed";

type Props = {
  open: boolean;
  reasons: LowMediaReason[];
  videoCount: number;
  photoCount: number;
  uploadToServer: boolean;
  onChoose: (choice: LowMediaConfirmChoice) => void;
};

/**
 * Soft confirm when booked products have unusually few imported media.
 * Primary (safer) action is Back; proceed remains available.
 */
export function LowMediaConfirmDialog({
  open,
  reasons,
  videoCount,
  photoCount,
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

  function choose(choice: LowMediaConfirmChoice) {
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
            {t("dialogs.lowMedia.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">{t("dialogs.lowMedia.body")}</p>
              <ul className="list-disc space-y-1 pl-5">
                {reasons.includes("video") ? (
                  <li>
                    {t(
                      videoCount === 1
                        ? "dialogs.lowMedia.reasonVideo"
                        : "dialogs.lowMedia.reasonVideosMany",
                      { count: videoCount },
                    )}
                  </li>
                ) : null}
                {reasons.includes("photos") ? (
                  <li>
                    {t(
                      photoCount === 1
                        ? "dialogs.lowMedia.reasonPhotosOne"
                        : "dialogs.lowMedia.reasonPhotosMany",
                      { count: photoCount },
                    )}
                  </li>
                ) : null}
              </ul>
              <p className="text-muted">
                {uploadToServer
                  ? t("dialogs.lowMedia.hintUpload")
                  : t("dialogs.lowMedia.hintEncode")}
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => choose("proceed")}>
            {t("dialogs.lowMedia.proceed")}
          </Button>
          <Button variant="default" onClick={() => choose("back")}>
            {t("common.actions.back")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
