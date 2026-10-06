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

export type SdDeleteConfirmChoice = "cancel" | "delete";

type Props = {
  open: boolean;
  paths: string[];
  busy?: boolean;
  onChoose: (choice: SdDeleteConfirmChoice) => void;
};

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Confirm before permanently deleting media from the SD card / USB camera.
 * Safer primary action is Cancel.
 */
export function SdDeleteConfirmDialog({
  open,
  paths,
  busy = false,
  onChoose,
}: Props) {
  const { t } = useTranslation();
  const chosenRef = useRef(false);
  const onChooseRef = useRef(onChoose);
  onChooseRef.current = onChoose;

  useEffect(() => {
    if (!open) chosenRef.current = false;
  }, [open]);

  function choose(choice: SdDeleteConfirmChoice) {
    if (chosenRef.current || busy) return;
    chosenRef.current = true;
    onChooseRef.current(choice);
  }

  const count = paths.length;
  const preview = paths.slice(0, 5).map(basename);
  const extra = count > preview.length ? count - preview.length : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) choose("cancel");
      }}
    >
      <DialogContent
        className="z-[130] max-w-md overflow-hidden border-l-4 border-l-destructive"
        overlayClassName="z-[130]"
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          if (!busy) choose("cancel");
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="text-destructive">
            {count === 1
              ? t("dialogs.sdDelete.titleOne")
              : t("dialogs.sdDelete.titleMany", { count })}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0 space-y-3 text-sm text-foreground">
              <p className="break-words">
                {count === 1
                  ? t("dialogs.sdDelete.bodyOne", { name: preview[0] ?? "" })
                  : t("dialogs.sdDelete.bodyMany", { count })}
              </p>
              {count > 1 ? (
                <ul className="max-h-32 list-disc space-y-0.5 overflow-auto pl-5 text-muted">
                  {preview.map((name) => (
                    <li key={name} className="break-all">
                      {name}
                    </li>
                  ))}
                  {extra > 0 ? (
                    <li>{t("dialogs.sdDelete.andMore", { count: extra })}</li>
                  ) : null}
                </ul>
              ) : null}
              <p className="text-muted">{t("dialogs.sdDelete.hint")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="min-w-0 gap-2 sm:justify-between">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => choose("cancel")}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || count === 0}
            onClick={() => choose("delete")}
          >
            {busy
              ? t("dialogs.sdDelete.deleting")
              : count === 1
                ? t("dialogs.sdDelete.confirmOne")
                : t("dialogs.sdDelete.confirmMany", { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
