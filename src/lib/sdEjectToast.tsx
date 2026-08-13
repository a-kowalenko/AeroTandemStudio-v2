import toast from "react-hot-toast";
import { SdEjectToastCard } from "../components/SdEjectToastCard";
import { listDriveLabel, compactDriveLabel } from "./sdDriveLabel";
import { useSdStore } from "../store/sdStore";

/** Resolve letter / mount basename + useful volume name while the drive is still known. */
export function resolveSdEjectDetail(drive: string): string {
  const info = useSdStore.getState().drives.find((d) => d.drive === drive);
  if (info) return listDriveLabel(info);
  return compactDriveLabel(drive);
}

/** Lightweight mid-workflow / manual eject feedback (non-blocking). */
export function showSdEjectToast(opts: {
  drive: string;
  /** Capture before eject — drive may disappear from the store afterwards. */
  detail?: string;
  ok: boolean;
  error?: string;
}): void {
  const detail = (opts.detail ?? resolveSdEjectDetail(opts.drive)).trim();
  const durationMs = opts.ok ? 4500 : 6000;

  toast.custom(
    (t) => (
      <SdEjectToastCard
        visible={t.visible}
        ok={opts.ok}
        detail={detail || undefined}
        error={opts.error}
        durationMs={durationMs}
        onDismiss={() => toast.dismiss(t.id)}
      />
    ),
    {
      duration: durationMs,
      id: `sd-eject-${opts.drive}-${opts.ok ? "ok" : "fail"}`,
    },
  );
}
