import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ImageIcon } from "lucide-react";
import { buildOffsets, sliceVirtualRange } from "../../lib/virtualList";
import type { PhotoItem } from "../../store/photoStore";
import { PhotoThumbTile } from "./PhotoThumbTile";

const GAP = 8;
const MIN_CELL = 96;
const OVERSCAN_ROWS = 2;

type Props = {
  photos: PhotoItem[];
  currentIndex: number;
  selected: Set<number>;
  explicitlySelected: boolean;
  watermarkIndices: Set<number>;
  fotoWmNeeded: boolean;
  getEditMark: (path: string) => "crop" | "rotate" | null;
  getMediaRevision: (path: string) => number;
  onThumbClick: (index: number, e: MouseEvent) => void;
  onContextMenu: (path: string) => (e: MouseEvent<HTMLButtonElement>) => void;
};

function computeColumns(width: number): number {
  if (width <= 0) return 4;
  return Math.max(2, Math.floor((width + GAP) / (MIN_CELL + GAP)));
}

export function PhotoOverviewGrid({
  photos,
  currentIndex,
  selected,
  explicitlySelected,
  watermarkIndices,
  fotoWmNeeded,
  getEditMark,
  getMediaRevision,
  onThumbClick,
  onContextMenu,
}: Props) {
  const { t } = useTranslation();
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState({ scrollTop: 0, height: 0, width: 0 });

  const attachRef = useCallback((el: HTMLDivElement | null) => {
    scrollRootRef.current = el;
    setListEl((prev) => (prev === el ? prev : el));
  }, []);

  useEffect(() => {
    if (!listEl) return;
    const sync = () => {
      const style = getComputedStyle(listEl);
      const padX =
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0);
      setMetrics({
        scrollTop: listEl.scrollTop,
        height: listEl.clientHeight,
        width: Math.max(0, listEl.clientWidth - padX),
      });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(listEl);
    listEl.addEventListener("scroll", sync, { passive: true });
    return () => {
      ro.disconnect();
      listEl.removeEventListener("scroll", sync);
    };
  }, [listEl]);

  const columns = useMemo(
    () => computeColumns(metrics.width),
    [metrics.width],
  );
  const cellSize = useMemo(() => {
    if (metrics.width <= 0 || columns <= 0) return MIN_CELL;
    return Math.floor((metrics.width - GAP * (columns - 1)) / columns);
  }, [metrics.width, columns]);
  const rowHeight = cellSize + GAP;
  const rowCount = Math.ceil(photos.length / columns) || 0;

  const rowHeights = useMemo(
    () => Array.from({ length: rowCount }, () => rowHeight),
    [rowCount, rowHeight],
  );
  const rowOffsets = useMemo(() => buildOffsets(rowHeights), [rowHeights]);

  const virtualSlice = useMemo(
    () =>
      sliceVirtualRange(
        rowCount,
        rowOffsets,
        metrics.scrollTop,
        metrics.height,
        OVERSCAN_ROWS,
      ),
    [rowCount, rowOffsets, metrics.scrollTop, metrics.height],
  );

  useEffect(() => {
    if (currentIndex < 0 || !listEl || rowCount === 0) return;
    const row = Math.floor(currentIndex / columns);
    const top = rowOffsets[row] ?? 0;
    const bottom = top + rowHeight;
    const viewTop = listEl.scrollTop;
    const viewBottom = viewTop + listEl.clientHeight;
    if (top < viewTop) {
      listEl.scrollTop = top;
    } else if (bottom > viewBottom) {
      listEl.scrollTop = Math.max(0, bottom - listEl.clientHeight);
    }
  }, [currentIndex, columns, listEl, rowCount, rowOffsets, rowHeight]);

  if (photos.length === 0) {
    return (
      <div className="flex min-h-[14rem] flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted">
        <ImageIcon className="h-8 w-8 opacity-50" aria-hidden />
        <p>{t("photo.preview.empty")}</p>
      </div>
    );
  }

  const rows: number[] = [];
  for (let r = virtualSlice.start; r < virtualSlice.end; r++) rows.push(r);

  return (
    <div
      ref={attachRef}
      className="min-h-[14rem] flex-1 overflow-auto py-0.5 pl-0.5 pr-[calc(var(--ats-scrollbar-size)+8px)] [scrollbar-gutter:stable]"
      role="listbox"
      aria-label={t("photo.preview.overviewAria")}
    >
      <div
        className="relative w-full"
        style={{ height: virtualSlice.totalHeight }}
      >
        <div
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${virtualSlice.padTop}px)` }}
        >
          {rows.map((row) => {
            const startIdx = row * columns;
            const cells: ReactNode[] = [];
            for (let c = 0; c < columns; c++) {
              const i = startIdx + c;
              if (i >= photos.length) break;
              const p = photos[i]!;
              const isCurrent = i === currentIndex;
              const isSelected = explicitlySelected && selected.has(i);
              const isWm = fotoWmNeeded && watermarkIndices.has(i);
              cells.push(
                <PhotoThumbTile
                  key={p.path}
                  path={p.path}
                  filename={p.filename}
                  revision={getMediaRevision(p.path)}
                  isCurrent={isCurrent}
                  isSelected={isSelected}
                  isWm={isWm}
                  editMark={getEditMark(p.path)}
                  scrollRootRef={scrollRootRef}
                  forceLoad
                  className="aspect-square w-full shrink-0"
                  onClick={(e) => onThumbClick(i, e)}
                  onContextMenu={onContextMenu(p.path)}
                />,
              );
            }
            return (
              <div
                key={row}
                className="grid"
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  gap: GAP,
                  height: rowHeight,
                  paddingBottom: GAP,
                  boxSizing: "border-box",
                }}
              >
                {cells}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
