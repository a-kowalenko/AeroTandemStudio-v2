import { AlertCircle, Loader2, Upload, XCircle } from "lucide-react";
import { isListUploadStatus, normalizeUploadState } from "@/lib/uploadState";
import { HistoryStatusChip } from "./HistoryStatusChip";
import { uploadChipTone } from "./historyChipTones";
import { uploadStateHint, uploadStateLabel } from "./historyStatusLabels";

type Props = {
  state: string;
};

/** SMB upload chip (Phase 31.1 / 31.8); retry action in detail panel (31.2). */
export function VorgangUploadChip({ state }: Props) {
  const s = normalizeUploadState(state);
  if (!isListUploadStatus(s)) {
    return null;
  }

  const label = uploadStateLabel(state);
  const tip = uploadStateHint(state);

  const icon =
    s === "uploading" ? (
      <Upload className="size-3 shrink-0 animate-pulse" aria-hidden />
    ) : s === "pending" ? (
      <Loader2
        className="size-3 shrink-0 animate-spin [animation-duration:1.4s]"
        aria-hidden
      />
    ) : s === "failed" ? (
      <AlertCircle className="size-3 shrink-0" aria-hidden />
    ) : s === "cancelled" ? (
      <XCircle className="size-3 shrink-0" aria-hidden />
    ) : undefined;

  return (
    <HistoryStatusChip
      label={label}
      icon={icon}
      toneClassName={uploadChipTone(s)}
      title={tip}
      active={s === "uploading"}
    />
  );
}
