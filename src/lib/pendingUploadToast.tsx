import toast from "react-hot-toast";
import { StatusToastCard } from "../components/StatusToastCard";

const DURATION_MS = 4500;
const TOAST_ID = "pending-uploads-reconnect";

/** Optional once-per-reconnect hint; Historie badge remains the primary signal. */
export function showPendingUploadsToast(title: string, message: string): void {
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
