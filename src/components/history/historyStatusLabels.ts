/** Operator-facing status labels for the Vorgänge dialog (`history.status.*`). */

import { tr } from "@/i18n";
import {
  isAmsCancelled,
  type AmsHandoffView,
} from "@/lib/amsHandoffStatus";
import { normalizeUploadState } from "@/lib/uploadState";

export const HISTORY_AMS_STEPS = [
  { id: "pending", labelKey: "history.status.step.amsPending" },
  { id: "accepted", labelKey: "history.status.step.amsAccepted" },
  { id: "queued", labelKey: "history.status.step.amsQueued" },
  { id: "uploading", labelKey: "history.status.step.amsUploading" },
  { id: "completed", labelKey: "history.status.step.amsCompleted" },
] as const;

export type HistoryAmsStepId = (typeof HISTORY_AMS_STEPS)[number]["id"];

export function uploadStateLabel(state: string): string {
  const s = normalizeUploadState(state);
  switch (s) {
    case "pending":
      return tr("history.status.smbPending");
    case "uploading":
      return tr("history.status.smbUploading");
    case "failed":
      return tr("history.upload.failed");
    case "cancelled":
      return tr("history.upload.cancelled");
    default:
      return s;
  }
}

export function uploadStateHint(state: string): string {
  const s = normalizeUploadState(state);
  switch (s) {
    case "pending":
      return tr("history.status.hint.smbPending");
    case "uploading":
      return tr("history.upload.uploadingHint");
    case "failed":
      return tr("history.upload.failedHint");
    case "cancelled":
      return tr("history.upload.cancelledHint");
    default:
      return "";
  }
}

export function amsStateLabel(
  view: AmsHandoffView,
  _opts?: { compact?: boolean },
): string {
  if (isAmsCancelled(view)) return tr("history.status.amsCancelled");
  switch (view.state.trim().toLowerCase()) {
    case "pending":
    case "":
      return tr("history.status.amsPending");
    case "accepted":
      return tr("history.status.amsAccepted");
    case "rejected":
      return tr("history.status.amsRejected");
    case "queued":
      return tr("history.status.amsQueued");
    case "uploading":
      return tr("history.status.amsUploading");
    case "completed":
      return tr("history.status.amsCompleted");
    case "failed":
      return tr("common.status.error");
    default:
      return view.state.trim() || "—";
  }
}

export function amsStateHint(view: AmsHandoffView): string | null {
  if (view.offline) {
    return tr("ams.handoff.hint.offline");
  }
  if (isAmsCancelled(view)) {
    return view.errorMessage?.trim() || tr("ams.handoff.hint.uploadCancelled");
  }
  if (view.state === "pending" || view.state === "") {
    return tr("history.status.hint.amsPending");
  }
  if (view.state === "rejected" || view.state === "failed") {
    const code = view.errorCode?.trim();
    const msg = view.errorMessage?.trim();
    if (code && msg) return `${code}: ${msg}`;
    return msg || code || null;
  }
  if (view.archive) {
    return tr("ams.handoff.hint.archive", { archive: view.archive });
  }
  return null;
}

export function amsStepLabel(stepId: HistoryAmsStepId | string): string {
  switch (stepId.trim().toLowerCase()) {
    case "pending":
    case "":
      return tr("history.status.step.amsPending");
    case "accepted":
      return tr("history.status.step.amsAccepted");
    case "queued":
      return tr("history.status.step.amsQueued");
    case "uploading":
      return tr("history.status.step.amsUploading");
    case "completed":
      return tr("history.status.step.amsCompleted");
    case "smb":
      return tr("history.status.step.smb");
    default:
      return stepId;
  }
}
