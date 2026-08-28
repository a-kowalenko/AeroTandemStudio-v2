import { useTranslation } from "react-i18next";
import { AmsPathHintsDriftBanner } from "@/components/AmsPathHintsDriftBanner";
import { useConfigStore } from "@/store/configStore";
import { useUiStore } from "@/store/uiStore";

/** Quiet-poll drift banner for the main shell (no dialog spam; apply persists). */
export function AppPathHintsDriftBanner() {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const persist = useConfigStore((s) => s.persist);
  const updateLocal = useConfigStore((s) => s.updateLocal);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const showError = useUiStore((s) => s.showError);

  if (!config || settingsOpen || !config.upload_to_server) {
    return null;
  }

  return (
    <AmsPathHintsDriftBanner
      draft={config}
      setDraft={updateLocal}
      persist={persist}
      onError={showError}
      errorTitle={t("settings.tabs.server")}
      frameClassName="shrink-0 border-b border-border px-3 py-2 sm:px-4"
    />
  );
}
