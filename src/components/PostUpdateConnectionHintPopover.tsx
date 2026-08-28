import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PostUpdateConnectionHintPopoverProps = {
  open: boolean;
  onAcknowledge: () => void;
};

export function PostUpdateConnectionHintPopover({
  open,
  onAcknowledge,
}: PostUpdateConnectionHintPopoverProps) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label={t("header.connection.postUpdateHint.title")}
      className={cn(
        "absolute top-full left-0 z-50 mt-1.5 w-[min(18rem,calc(100vw-1.5rem))]",
        "rounded-xl border border-border/80 bg-card/95 p-3 shadow-lg backdrop-blur-md",
        "ats-progress-float-in",
      )}
    >
      <p className="text-sm font-medium text-foreground">
        {t("header.connection.postUpdateHint.title")}
      </p>
      <p className="mt-1.5 text-xs leading-snug text-muted">
        {t("header.connection.postUpdateHint.body")}
      </p>
      <div className="mt-2.5 flex justify-end">
        <Button type="button" size="sm" onClick={onAcknowledge}>
          {t("header.connection.postUpdateHint.ok")}
        </Button>
      </div>
    </div>
  );
}
