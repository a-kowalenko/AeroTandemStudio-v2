import { useTranslation } from "react-i18next";
import { Spinner } from "./Spinner";

type LoadingOverlayProps = {
  open: boolean;
  message?: string;
};

export function LoadingOverlay({ open, message }: LoadingOverlayProps) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
      <div className="flex min-w-[220px] flex-col items-center gap-3 rounded-lg border border-border bg-card px-8 py-6 shadow-lg">
        <Spinner size={36} />
        <p className="text-sm text-muted">{message ?? t("common.actions.pleaseWait")}</p>
      </div>
    </div>
  );
}
