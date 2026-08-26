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
import type { UploadPreflightIssue } from "@/lib/vorgangHistory";

type Props = {
  open: boolean;
  guest: string;
  issues: UploadPreflightIssue[];
  onClose: () => void;
};

function issueLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  issue: UploadPreflightIssue,
): string {
  const codeKey = `dialogs.uploadPreflightFail.codes.${issue.code}`;
  const label = t(codeKey);
  if (issue.path) {
    return issue.detail
      ? `${label}: ${issue.path} (${issue.detail})`
      : `${label}: ${issue.path}`;
  }
  return issue.detail ? `${label} — ${issue.detail}` : label;
}

/** Hard-fail dialog after upload preflight (no SMB start). */
export function UploadPreflightHardFailDialog({
  open,
  guest,
  issues,
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
                {t("dialogs.uploadPreflightFail.body", { guest })}
              </p>
              <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5">
                {issues.map((issue, i) => (
                  <li key={`${issue.code}-${issue.path}-${i}`} className="break-all">
                    {issueLabel(t, issue)}
                  </li>
                ))}
              </ul>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="default" onClick={close}>
            {t("common.actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
