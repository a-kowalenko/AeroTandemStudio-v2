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
import type { RemoteJobConflictDialogState } from "@/lib/remoteJobConflict";

export type RemoteJobConflictChoice = "proceed" | "later";

type Props = {
  state: RemoteJobConflictDialogState | null;
  onChoose: (choice: RemoteJobConflictChoice) => void;
};

export function RemoteJobConflictDialog({ state, onChoose }: Props) {
  const { t } = useTranslation();
  const chosenRef = useRef(false);
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;
  const open = state != null;

  useEffect(() => {
    if (!open) chosenRef.current = false;
  }, [open]);

  function choose(choice: RemoteJobConflictChoice) {
    if (chosenRef.current) return;
    chosenRef.current = true;
    onChooseRef.current(choice);
  }

  const action = state?.action ?? "unclear";
  const reason = state?.reason ?? "";
  const folderName = state?.folderName ?? "";
  const destructive = action === "replace";
  const canProceed = action === "heal" || action === "heal_handoff" || action === "replace";

  const titleKey =
    action === "replace"
      ? "dialogs.remoteJobConflict.replaceTitle"
      : action === "unclear"
        ? "dialogs.remoteJobConflict.unclearTitle"
        : "dialogs.remoteJobConflict.healTitle";
  const bodyKey =
    action === "replace"
      ? "dialogs.remoteJobConflict.replaceBody"
      : action === "unclear"
        ? "dialogs.remoteJobConflict.unclearBody"
        : "dialogs.remoteJobConflict.healBody";
  const hintKey =
    action === "replace"
      ? "dialogs.remoteJobConflict.replaceHint"
      : action === "unclear"
        ? "dialogs.remoteJobConflict.unclearHint"
        : reason === "ams_completed"
          ? "dialogs.remoteJobConflict.healHintCompleted"
          : reason === "fertig_waiting" || action === "heal_handoff"
            ? "dialogs.remoteJobConflict.healHintHandoff"
            : reason === "content_match"
              ? "dialogs.remoteJobConflict.healHintMatch"
              : "dialogs.remoteJobConflict.healHintActive";
  const proceedKey =
    action === "replace"
      ? "dialogs.remoteJobConflict.replace"
      : "dialogs.remoteJobConflict.markDone";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) choose("later");
      }}
    >
      <DialogContent
        className={
          destructive
            ? "max-w-md overflow-hidden border-l-4 border-l-warning"
            : "max-w-md overflow-hidden"
        }
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          choose("later");
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className={destructive ? "text-warning" : undefined}>
            {t(titleKey)}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">{t(bodyKey, { name: folderName })}</p>
              <p className="text-muted">{t(hintKey)}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          {canProceed && destructive ? (
            <Button variant="outline" onClick={() => choose("proceed")}>
              {t(proceedKey)}
            </Button>
          ) : null}
          {canProceed && !destructive ? (
            <Button variant="outline" onClick={() => choose("later")}>
              {t("dialogs.remoteJobConflict.later")}
            </Button>
          ) : null}
          {destructive || !canProceed ? (
            <Button variant="default" onClick={() => choose("later")}>
              {t("dialogs.remoteJobConflict.later")}
            </Button>
          ) : (
            <Button variant="default" onClick={() => choose("proceed")}>
              {t(proceedKey)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
