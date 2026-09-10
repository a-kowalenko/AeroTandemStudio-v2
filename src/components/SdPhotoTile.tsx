import { memo, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Film } from "lucide-react";
import { Checkbox } from "./ui/checkbox";
import { SdTilePreview } from "./SdTilePreview";
import { useSdThumb } from "../hooks/useSdThumb";
import type { SdThumbnailLoader } from "../lib/sdThumbnailLoader";
import type { Density } from "../lib/sdFileSelectorModel";
import { cn } from "../lib/utils";

const statusBadgeBase =
  "rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide shadow-md shadow-black/35";

export function FileStatusBadge({
  alreadyProcessed,
  showNewBadge,
  className,
}: {
  alreadyProcessed: boolean;
  showNewBadge: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (alreadyProcessed) {
    return (
      <span
        className={cn(
          statusBadgeBase,
          "border border-amber-400/80 bg-amber-500 text-amber-950",
          className,
        )}
      >
        {t("sd.selector.known")}
      </span>
    );
  }
  if (showNewBadge) {
    return (
      <span
        className={cn(
          statusBadgeBase,
          "border border-sky-300/90 bg-sky-500 text-sky-950",
          className,
        )}
      >
        {t("sd.selector.new")}
      </span>
    );
  }
  return null;
}

type PhotoTileProps = {
  path: string;
  filename: string;
  sizeLabel: string;
  captureLabel: string;
  isVideo: boolean;
  selected: boolean;
  alreadyProcessed: boolean;
  showNewBadge: boolean;
  density: Density;
  loader: SdThumbnailLoader;
  onSelect: (path: string, shiftKey: boolean) => void;
  onCheckboxPointerDown: (path: string, e: React.PointerEvent) => void;
  onCheckboxCheckedChange: (path: string) => void;
  registerEl: (path: string, el: HTMLElement | null) => void;
};

export const SdPhotoTile = memo(function SdPhotoTile({
  path,
  filename,
  sizeLabel,
  captureLabel,
  isVideo,
  selected,
  alreadyProcessed,
  showNewBadge,
  density,
  loader,
  onSelect,
  onCheckboxPointerDown,
  onCheckboxCheckedChange,
  registerEl,
}: PhotoTileProps) {
  const { t } = useTranslation();
  const thumb = useSdThumb(loader, path);
  const compact = density === "compact";

  const setRef = useCallback(
    (el: HTMLElement | null) => registerEl(path, el),
    [path, registerEl],
  );

  return (
    <div
      data-tile
      data-thumb-path={path}
      data-marquee-ok=""
      ref={setRef}
      className={cn(
        "relative flex h-full flex-col overflow-hidden rounded-md text-left transition",
        selected
          ? "border-2 border-primary bg-primary-soft/50 ring-[3px] ring-primary/55"
          : "border border-border/70",
      )}
    >
      <SdTilePreview
        thumbUrl={thumb?.url}
        thumbQuality={thumb?.quality}
        placeholder="pulse"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-no-marquee]")) return;
          onSelect(path, e.shiftKey);
        }}
      >
        <div
          className="absolute top-1.5 left-1.5 z-10"
          data-no-marquee=""
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onPointerDown={(e) => onCheckboxPointerDown(path, e)}
            onCheckedChange={() => onCheckboxCheckedChange(path)}
            aria-label={t("common.actions.selectNamed", { name: filename })}
            className="h-5 w-5 border-2 border-white/90 bg-black/50 shadow-sm data-[state=checked]:border-primary data-[state=checked]:bg-primary"
          />
        </div>
        <FileStatusBadge
          alreadyProcessed={alreadyProcessed}
          showNewBadge={showNewBadge}
          className="absolute top-1.5 right-1.5 z-10"
        />
        {isVideo ? (
          <Film
            className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 h-3.5 w-3.5 text-white/90 drop-shadow"
            aria-hidden
          />
        ) : null}
      </SdTilePreview>
      <button
        type="button"
        data-marquee-ok=""
        className={cn(
          "truncate px-2 text-left hover:bg-black/5",
          compact ? "py-0.5 text-[10px]" : "py-1 text-[11px]",
        )}
        onClick={(e) => onSelect(path, e.shiftKey)}
      >
        {filename}
      </button>
      {!compact ? (
        <button
          type="button"
          data-marquee-ok=""
          className="flex w-full items-baseline justify-between gap-2 px-2 pb-1 text-left text-[10px] text-muted hover:bg-black/5"
          onClick={(e) => onSelect(path, e.shiftKey)}
        >
          <span className="min-w-0 truncate">{sizeLabel}</span>
          {captureLabel ? (
            <span className="shrink-0 tabular-nums">{captureLabel}</span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
});

type DetailsRowProps = {
  path: string;
  filename: string;
  sizeLabel: string;
  dateLabel: string;
  typeLabel: string;
  selected: boolean;
  alreadyProcessed: boolean;
  showNewBadge: boolean;
  density: Density;
  loader: SdThumbnailLoader;
  onSelect: (path: string, shiftKey: boolean) => void;
  onCheckboxPointerDown: (path: string, e: React.PointerEvent) => void;
  onCheckboxCheckedChange: (path: string) => void;
  registerEl: (path: string, el: HTMLElement | null) => void;
};

export const SdDetailsRow = memo(function SdDetailsRow({
  path,
  filename,
  sizeLabel,
  dateLabel,
  typeLabel,
  selected,
  alreadyProcessed,
  showNewBadge,
  density,
  loader,
  onSelect,
  onCheckboxPointerDown,
  onCheckboxCheckedChange,
  registerEl,
}: DetailsRowProps) {
  const { t } = useTranslation();
  const thumb = useSdThumb(loader, path);
  const compact = density === "compact";

  const setRef = useCallback(
    (el: HTMLDivElement | null) => registerEl(path, el),
    [path, registerEl],
  );

  return (
    <div
      ref={setRef}
      data-thumb-path={path}
      role="row"
      className={cn(
        "grid h-full cursor-pointer items-center gap-2 border-b border-border/40 px-2 hover:bg-black/5",
        selected && "bg-primary-soft",
        compact ? "text-[11px]" : "text-xs",
      )}
      style={{
        gridTemplateColumns: compact
          ? "28px minmax(0,1fr) 64px 72px 120px"
          : "32px 56px minmax(0,1fr) 72px 80px 140px",
      }}
      onClick={(e) => onSelect(path, e.shiftKey)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={selected}
          onPointerDown={(e) => onCheckboxPointerDown(path, e)}
          onCheckedChange={() => onCheckboxCheckedChange(path)}
          aria-label={t("common.actions.selectNamed", { name: filename })}
        />
      </div>
      {!compact ? (
        <SdTilePreview
          thumbPath={path}
          thumbUrl={thumb?.url}
          thumbQuality={thumb?.quality}
          placeholder="pulse"
          suppressLqEnhance
          layout="inline"
          className="h-9 w-14 shrink-0 rounded"
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{filename}</span>
        <FileStatusBadge
          alreadyProcessed={alreadyProcessed}
          showNewBadge={showNewBadge}
          className="shrink-0 shadow-sm"
        />
      </div>
      <span className="truncate text-muted">{typeLabel}</span>
      <span className="tabular-nums text-muted">{sizeLabel}</span>
      <span className="truncate tabular-nums text-muted">{dateLabel}</span>
    </div>
  );
});

export function DateGroupHeader({
  label,
  count,
  allSelected,
  onSelectGroup,
  style,
  trailing,
}: {
  label: string;
  count: number;
  allSelected: boolean;
  onSelectGroup: () => void;
  style?: React.CSSProperties;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-marquee-ok=""
      className="flex items-center gap-2 border-b border-border/50 bg-card-elevated/95 px-2 backdrop-blur-sm"
      style={style}
    >
      <span className="pointer-events-none text-xs font-semibold tracking-tight text-foreground">
        {label}
      </span>
      <span className="pointer-events-none text-[11px] tabular-nums text-muted">
        {t("sd.selector.groupCount", { count })}
      </span>
      <button
        type="button"
        data-no-marquee=""
        data-controls=""
        className={cn(
          "ml-auto rounded-md px-2 py-0.5 text-[11px] font-medium transition",
          allSelected
            ? "bg-primary-soft text-primary"
            : "text-muted hover:bg-black/5 hover:text-foreground",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onSelectGroup();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {allSelected
          ? t("sd.selector.deselectDay")
          : t("sd.selector.selectDay")}
      </button>
      {trailing}
    </div>
  );
}
