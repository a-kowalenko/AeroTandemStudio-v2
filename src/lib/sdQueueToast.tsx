import toast from "react-hot-toast";
import { SdQueueToastCard } from "../components/SdQueueToastCard";
import { resolveSdEjectDetail } from "./sdEjectToast";

export function showSdQueuedToast(drive: string): void {
  const detail = resolveSdEjectDetail(drive);
  const durationMs = 4000;
  toast.custom(
    (t) => (
      <SdQueueToastCard
        visible={t.visible}
        variant="queued"
        detail={detail || undefined}
        durationMs={durationMs}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    { duration: durationMs, id: `sd-queue-${drive}` },
  );
}

export function showSdQueueDroppedToast(drive: string): void {
  const detail = resolveSdEjectDetail(drive);
  const durationMs = 4500;
  toast.custom(
    (t) => (
      <SdQueueToastCard
        visible={t.visible}
        variant="dropped"
        detail={detail || undefined}
        durationMs={durationMs}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    { duration: durationMs, id: `sd-queue-drop-${drive}` },
  );
}
