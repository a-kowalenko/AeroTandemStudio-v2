import { HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HistoryStatusChip } from "./HistoryStatusChip";
import { localChipTone } from "./historyChipTones";

type Props = {
  className?: string;
  title?: string;
};

/** Job was created without server upload intent (`upload_state=none`). */
export function VorgangLocalChip({ className, title }: Props) {
  const { t } = useTranslation();
  const label = t("history.status.localOnly");
  const tip = title ?? t("history.status.hint.localOnly");

  return (
    <HistoryStatusChip
      label={label}
      icon={<HardDrive className="size-3 shrink-0 opacity-90" aria-hidden />}
      toneClassName={localChipTone()}
      title={tip}
      className={className}
    />
  );
}
