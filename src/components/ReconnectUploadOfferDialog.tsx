import { useEffect, useMemo, useRef, useState } from "react";
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
  pendingUploadPreviewLine,
  RECONNECT_UPLOAD_OFFER_DISMISS_GRACE_MS,
  type ReconnectUploadOfferState,
} from "@/lib/reconnectUploadOffer";
import { PendingUploadPreviewLines } from "@/components/PendingUploadPreviewLines";

export type ReconnectUploadOfferChoice =
  | { action: "later" }
  | { action: "now"; selectedIds: number[] };

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
 * Checkboxes: default all selected; unchecked → ignored on „Jetzt“ (Phase 31.10).
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
  const entries = offer?.entries ?? [];
  const lines = useMemo(
    () => entries.map(pendingUploadPreviewLine),
    [entries],
  );
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());

  const title =
    variant === "history"
      ? t("history.upload.bulkConfirmTitle")
      : t("dialogs.reconnectUpload.title");

  useEffect(() => {
    if (!open || !offer) {
      chosenRef.current = false;
      openedAtRef.current = 0;
      return;
    }
    openedAtRef.current = Date.now();
    chosenRef.current = false;
    setSelectedIds(new Set(offer.entries.map((e) => e.id)));
  }, [open, offer]);

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

  function toggleId(id: number, next: boolean) {
    setSelectedIds((prev) => {
      const nextSet = new Set(prev);
      if (next) nextSet.add(id);
      else nextSet.delete(id);
      return nextSet;
    });
  }

  const selectedCount = selectedIds.size;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) return;
        if (dismissGraceActive()) return;
        choose({ action: "later" });
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
          choose({ action: "later" });
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">
                {t("dialogs.reconnectUpload.body", { count: entries.length })}
              </p>
              <PendingUploadPreviewLines
                lines={lines}
                maxHeightClassName="max-h-64"
                selectedIds={selectedIds}
                onToggle={toggleId}
              />
              <p className="break-words text-xs text-muted">
                {t("dialogs.reconnectUpload.selectionHint")}
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => choose({ action: "later" })}
          >
            {t("dialogs.reconnectUpload.later")}
          </Button>
          <Button
            variant="default"
            onClick={() =>
              choose({
                action: "now",
                selectedIds: [...selectedIds],
              })
            }
          >
            {selectedCount > 0
              ? t("dialogs.reconnectUpload.nowCount", { count: selectedCount })
              : t("dialogs.reconnectUpload.nowIgnoreOnly")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
