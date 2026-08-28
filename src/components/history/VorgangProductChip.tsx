import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HistoryStatusChip } from "./HistoryStatusChip";
import { productChipTone } from "./historyChipTones";

export type VorgangProductBadge = {
  key: string;
  label: string;
  paid: boolean;
};

type Props = {
  badge: VorgangProductBadge;
};

export function VorgangProductChip({ badge }: Props) {
  const { t } = useTranslation();

  return (
    <HistoryStatusChip
      label={badge.label}
      toneClassName={productChipTone(badge.paid)}
      title={
        badge.paid
          ? t("history.paidTitle", { label: badge.label })
          : badge.label
      }
      icon={
        badge.paid ? (
          <Check className="size-3 shrink-0" strokeWidth={2.5} aria-hidden />
        ) : undefined
      }
    />
  );
}
