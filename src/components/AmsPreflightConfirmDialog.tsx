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

export type AmsPreflightConfirmChoice = "back" | "proceed";

type Props = {
  open: boolean;
  onChoose: (choice: AmsPreflightConfirmChoice) => void;
};

/**
 * Soft confirm when AMS create-preflight says the customer/booking was not found.
 * Primary (safer) action is Back; create+upload remains available.
 */
export function AmsPreflightConfirmDialog({ open, onChoose }: Props) {
  const { t } = useTranslation();
  const chosenRef = useRef(false);
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  useEffect(() => {
    if (!open) {
      chosenRef.current = false;
    }
  }, [open]);

  function choose(choice: AmsPreflightConfirmChoice) {
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
            {t("dialogs.amsPreflight.title")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">{t("dialogs.amsPreflight.body")}</p>
              <p className="text-muted">{t("dialogs.amsPreflight.hint")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => choose("proceed")}>
            {t("dialogs.amsPreflight.proceed")}
          </Button>
          <Button variant="default" onClick={() => choose("back")}>
            {t("common.actions.back")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
