import toast from "react-hot-toast";
import { BackgroundUploadToastCard } from "../components/BackgroundUploadToastCard";

const OK_MS = 4000;
const FAIL_MS = 7000;
const TOAST_ID = "background-upload";

export function showBackgroundUploadDoneToast(opts: {
  title: string;
  message?: string;
}): void {
  toast.custom(
    (t) => (
      <BackgroundUploadToastCard
        visible={t.visible}
        ok
        title={opts.title}
        message={opts.message}
        durationMs={OK_MS}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    { duration: OK_MS, id: `${TOAST_ID}-ok` },
  );
}

export function showBackgroundUploadFailToast(opts: {
  title: string;
  message?: string;
}): void {
  toast.custom(
    (t) => (
      <BackgroundUploadToastCard
        visible={t.visible}
        ok={false}
        title={opts.title}
        message={opts.message}
        durationMs={FAIL_MS}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    { duration: FAIL_MS, id: `${TOAST_ID}-fail` },
  );
}

/** Soft info when the current SD server-backup job was cancelled (local remains). */
export function showSecondaryBackupCancelledToast(opts: {
  title: string;
  message?: string;
}): void {
  toast.custom(
    (t) => (
      <BackgroundUploadToastCard
        visible={t.visible}
        ok
        title={opts.title}
        message={opts.message}
        durationMs={5000}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    { duration: 5000, id: "secondary-backup-cancelled" },
  );
}
