import { FolderX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HistoryStatusChip } from "./HistoryStatusChip";

type Props = {
  className?: string;
  title?: string;
};

/** Job output folder missing on disk (manual delete / moved). */
export function VorgangFolderChip({ className, title }: Props) {
  const { t } = useTranslation();
  const label = t("history.status.folderMissing");
  const tip = title ?? t("history.status.hint.folderMissing");

  return (
    <HistoryStatusChip
      label={label}
      icon={<FolderX className="size-3 shrink-0" aria-hidden />}
      toneClassName="bg-amber-500/12 text-amber-900 ring-amber-500/30 dark:text-amber-100"
      title={tip}
      className={className}
    />
  );
}
