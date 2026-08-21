import toast from "react-hot-toast";
import { StatusToastCard } from "../components/StatusToastCard";

const DURATION_MS = 3500;
const TOAST_ID = "session-reset";

/** Non-blocking success toast after a confirmed session reset. */
export function showSessionResetToast(title: string, message: string): void {
  toast.custom(
    (t) => (
      <StatusToastCard
        visible={t.visible}
        title={title}
        message={message}
        durationMs={DURATION_MS}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    { duration: DURATION_MS, id: TOAST_ID },
  );
}
