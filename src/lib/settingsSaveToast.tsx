import toast from "react-hot-toast";
import { StatusToastCard } from "../components/StatusToastCard";

const DURATION_MS = 3500;
const TOAST_ID = "settings-save";

/** Non-blocking success toast after settings are persisted. */
export function showSettingsSaveToast(title: string): void {
  toast.custom(
    (t) => (
      <StatusToastCard
        visible={t.visible}
        title={title}
        durationMs={DURATION_MS}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    { duration: DURATION_MS, id: TOAST_ID },
  );
}
