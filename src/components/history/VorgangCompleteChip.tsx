import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HistoryStatusChip } from "./HistoryStatusChip";
import { completeChipTone } from "./historyChipTones";

type Props = {
  className?: string;
  title?: string;
};

/** Server + cloud upload finished successfully. */
export function VorgangCompleteChip({ className, title }: Props) {
  const { t } = useTranslation();
  const label = t("history.status.jobComplete");
  const tip = title ?? t("history.status.hint.jobComplete");

  return (
    <HistoryStatusChip
      label={label}
      icon={<Check className="size-3 shrink-0" strokeWidth={2.5} aria-hidden />}
      toneClassName={completeChipTone()}
      title={tip}
      className={className}
    />
  );
}
