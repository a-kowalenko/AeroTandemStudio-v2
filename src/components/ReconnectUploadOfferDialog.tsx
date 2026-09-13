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
import { cn } from "@/lib/utils";
import {
  formatPendingUploadPreview,
  RECONNECT_UPLOAD_OFFER_DISMISS_GRACE_MS,
  type ReconnectUploadOfferState,
} from "@/lib/reconnectUploadOffer";
import { PendingUploadPreviewLines } from "@/components/PendingUploadPreviewLines";

export type ReconnectUploadOfferChoice = "later" | "now";

export type PendingUploadsOfferVariant = "reconnect" | "history";

type Props = {
  offer: ReconnectUploadOfferState | null;
  onChoose: (choice: ReconnectUploadOfferChoice) => void;
  /** `reconnect` = Server-online copy; `history` = Vorgänge bulk. */
  variant?: PendingUploadsOfferVariant;
  /**
   * When nested under Historie (already a dialog), raise z-index so the offer
   * stacks above the parent.
   */
  elevated?: boolean;
};

/**
 * Soft confirm for pending uploads (Reconnect offer + Historie bulk).
 * Primary action starts scan → bulk (no second confirm).
 */
export function ReconnectUploadOfferDialog({
  offer,
  onChoose,
  variant = "reconnect",
  elevated = false,
}: Props) {
  const { t } = useTranslation();
  const chosenRef = useRef(false);
  const openedAtRef = useRef(0);
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  const open = offer != null;
  const count = offer?.entries.length ?? 0;
  const preview = formatPendingUploadPreview(offer?.entries ?? []);
  const title =
    variant === "history"
      ? t("history.upload.bulkConfirmTitle")
      : t("dialogs.reconnectUpload.title");

  useEffect(() => {
    if (!open) {
      chosenRef.current = false;
      openedAtRef.current = 0;
      return;
    }
    openedAtRef.current = Date.now();
    chosenRef.current = false;
  }, [open, offer?.entries]);

  function choose(choice: ReconnectUploadOfferChoice) {
    if (chosenRef.current) return;
    chosenRef.current = true;
    onChooseRef.current(choice);
  }

  function dismissGraceActive(): boolean {
    const openedAt = openedAtRef.current;
    if (openedAt <= 0) return true;
    return Date.now() - openedAt < RECONNECT_UPLOAD_OFFER_DISMISS_GRACE_MS;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) return;
        if (dismissGraceActive()) return;
        choose("later");
      }}
    >
      <DialogContent
        className={cn(
          "max-w-md overflow-hidden border-l-4 border-l-primary",
          elevated && "z-[60]",
        )}
        overlayClassName={elevated ? "z-[60]" : undefined}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          if (dismissGraceActive()) return;
          choose("later");
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">
                {t("dialogs.reconnectUpload.body", { count })}
              </p>
              <PendingUploadPreviewLines
                lines={preview.lines}
                footer={
                  preview.more > 0
                    ? t("dialogs.reconnectUpload.andMore", {
                        count: preview.more,
                      })
                    : null
                }
              />
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => choose("later")}>
            {t("dialogs.reconnectUpload.later")}
          </Button>
          <Button variant="default" onClick={() => choose("now")}>
            {t("dialogs.reconnectUpload.now")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
