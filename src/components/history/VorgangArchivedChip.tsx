import { Archive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HistoryStatusChip } from "./HistoryStatusChip";

type Props = {
  className?: string;
  title?: string;
};

/** Local job folder removed after successful server upload (expected cleanup). */
export function VorgangArchivedChip({ className, title }: Props) {
  const { t } = useTranslation();
  const label = t("history.status.folderCleanedUp");
  const tip = title ?? t("history.status.hint.folderCleanedUp");

  return (
    <HistoryStatusChip
      label={label}
      icon={<Archive className="size-3 shrink-0 opacity-80" aria-hidden />}
      toneClassName="bg-muted/35 text-muted-foreground ring-border/55"
      title={tip}
      className={className}
    />
  );
}
