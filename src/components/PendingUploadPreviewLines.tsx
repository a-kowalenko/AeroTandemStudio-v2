import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type {
  PendingUploadMediaKey,
  PendingUploadPreviewLine,
} from "@/lib/reconnectUploadOffer";

const MEDIA_SHORT: Record<PendingUploadMediaKey, string> = {
  handcamVideo: "HV",
  handcamPhoto: "HF",
  outsideVideo: "OV",
  outsidePhoto: "OF",
};

function MediaChip({ mediaKey }: { mediaKey: PendingUploadMediaKey }) {
  const { t } = useTranslation();
  const full = t(`form.media.${mediaKey}`);
  return (
    <span
      title={full}
      className="inline-flex h-5 shrink-0 items-center rounded border border-border/70 bg-card px-1.5 text-[10px] font-semibold tracking-wide text-foreground/80"
    >
      {MEDIA_SHORT[mediaKey]}
    </span>
  );
}

function PreviewLine({ line }: { line: PendingUploadPreviewLine }) {
  const { t } = useTranslation();
  const crewParts: string[] = [];
  if (line.tandemmaster) {
    crewParts.push(t("history.ta", { name: line.tandemmaster }));
  }
  if (line.videospringer) {
    crewParts.push(t("history.vs", { name: line.videospringer }));
  }
  const crew = crewParts.join(" · ");

  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-x-2 px-2.5 py-2 text-sm">
      <span className="min-w-0 truncate font-medium text-foreground" title={line.guest}>
        {line.guest}
      </span>
      <span
        className="min-w-0 truncate text-xs text-muted"
        title={crew || undefined}
      >
        {crew}
      </span>
      <span className="flex min-h-5 items-center justify-end gap-1">
        {line.mediaKeys.map((key) => (
          <MediaChip key={key} mediaKey={key} />
        ))}
      </span>
    </li>
  );
}

type Props = {
  lines: PendingUploadPreviewLine[];
  className?: string;
  maxHeightClassName?: string;
  /** Extra footer line (e.g. „und N weitere“). */
  footer?: string | null;
};

/** Compact guest · crew · media rows (Reconnect offer + bulk summary). */
export function PendingUploadPreviewLines({
  lines,
  className,
  maxHeightClassName = "max-h-52",
  footer = null,
}: Props) {
  if (lines.length === 0 && !footer) return null;

  return (
    <ul
      className={cn(
        "divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60 bg-muted/15",
        maxHeightClassName,
        className,
      )}
    >
      {lines.map((line, i) => (
        <PreviewLine key={`${i}-${line.guest}`} line={line} />
      ))}
      {footer ? (
        <li className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] px-2.5 py-2 text-xs text-muted">
          <span className="col-span-3">{footer}</span>
        </li>
      ) : null}
    </ul>
  );
}
