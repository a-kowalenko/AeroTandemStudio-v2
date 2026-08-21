import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownToLine,
  Copy,
  Eraser,
  FolderOpen,
  Terminal,
  X,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { clearLogBuffer, getAppInfo, getLogMinLevel, setLogMinLevel } from "@/lib/tauri";
import type { LogEntry } from "@/lib/tauri";
import { buildOffsets, sliceVirtualRange } from "@/lib/virtualList";
import { cn } from "@/lib/utils";
import {
  filterLogEntries,
  parseLogLevelFilter,
  useLogStore,
} from "@/store/logStore";
import { useConfigStore } from "@/store/configStore";

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 560;
const DEFAULT_HEIGHT = 280;
const LINE_HEIGHT = 20;
const OVERSCAN_ROWS = 12;
/** Fixed columns + gaps in px (timestamp, level, source, flex gaps, horizontal padding). */
const FIXED_ROW_PX = 24 + 56 + 48 + 40 + 24;
const MONO_CHAR_PX = 6.5;

function levelClass(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "text-destructive";
    case "WARN":
      return "text-warning";
    case "DEBUG":
      return "text-muted";
    default:
      return "text-foreground";
  }
}

function estimateLineCount(entry: LogEntry, listWidth: number): number {
  const messageWidth = Math.max(64, listWidth - FIXED_ROW_PX);
  const charsPerLine = Math.max(16, Math.floor(messageWidth / MONO_CHAR_PX));
  let lines = 0;
  for (const segment of entry.message.split("\n")) {
    lines += Math.max(1, Math.ceil(segment.length / charsPerLine));
  }
  return Math.max(lines, 1);
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div
      className={cn(
        "flex gap-2 whitespace-pre-wrap break-all",
        levelClass(entry.level),
      )}
    >
      <span className="shrink-0 text-muted tabular-nums">{entry.ts}</span>
      <span
        className={cn(
          "w-12 shrink-0 font-semibold uppercase",
          levelClass(entry.level),
        )}
      >
        {entry.level}
      </span>
      <span className="w-10 shrink-0 truncate text-muted" title={entry.source}>
        {entry.source}
      </span>
      <span className="min-w-0 flex-1">{entry.message}</span>
    </div>
  );
}

type Props = {
  className?: string;
};

export function LogConsole({ className }: Props) {
  const { t } = useTranslation();
  const open = useLogStore((s) => s.open);
  const setOpen = useLogStore((s) => s.setOpen);
  const entries = useLogStore((s) => s.entries);
  const search = useLogStore((s) => s.search);
  const setSearch = useLogStore((s) => s.setSearch);
  const levelFilter = useLogStore((s) => s.levelFilter);
  const setLevelFilter = useLogStore((s) => s.setLevelFilter);
  const autoScroll = useLogStore((s) => s.autoScroll);
  const setAutoScroll = useLogStore((s) => s.setAutoScroll);
  const clearEntries = useLogStore((s) => s.clearEntries);

  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const [listMetrics, setListMetrics] = useState({
    scrollTop: 0,
    height: 0,
    width: 0,
  });
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const attachListRef = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    setListEl((prev) => (prev === el ? prev : el));
  }, []);

  const filtered = useMemo(
    () => filterLogEntries(entries, search, levelFilter),
    [entries, search, levelFilter],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const level = parseLogLevelFilter(await getLogMinLevel());
        if (!cancelled) setLevelFilter(level);
      } catch {
        // Browser preview / backend not ready
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setLevelFilter]);

  const handleLevelChange = useCallback(
    async (value: string) => {
      const next = parseLogLevelFilter(value);
      setLevelFilter(next);
      try {
        const saved = parseLogLevelFilter(await setLogMinLevel(next));
        setLevelFilter(saved);
        const cfg = useConfigStore.getState().config;
        if (cfg) {
          useConfigStore.getState().updateLocal({ log_min_level: saved });
        }
      } catch {
        // keep UI selection; backend may be unavailable in preview
      }
    },
    [setLevelFilter],
  );

  const rowHeights = useMemo(
    () =>
      filtered.map(
        (entry) => estimateLineCount(entry, listMetrics.width) * LINE_HEIGHT,
      ),
    [filtered, listMetrics.width],
  );

  const rowOffsets = useMemo(() => buildOffsets(rowHeights), [rowHeights]);

  const virtualSlice = useMemo(
    () =>
      sliceVirtualRange(
        filtered.length,
        rowOffsets,
        listMetrics.scrollTop,
        listMetrics.height,
        OVERSCAN_ROWS,
      ),
    [filtered.length, rowOffsets, listMetrics.scrollTop, listMetrics.height],
  );

  const visibleEntries = useMemo(
    () => filtered.slice(virtualSlice.start, virtualSlice.end),
    [filtered, virtualSlice.start, virtualSlice.end],
  );

  useEffect(() => {
    if (!open) return;
    void getAppInfo()
      .then((info) => setLogPath(info.log_path))
      .catch(() => setLogPath(null));
  }, [open]);

  useEffect(() => {
    if (!listEl) return;
    let raf = 0;
    const measure = () => {
      setListMetrics({
        scrollTop: listEl.scrollTop,
        height: listEl.clientHeight,
        width: listEl.clientWidth,
      });
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    measure();
    const ro = new ResizeObserver(onScroll);
    ro.observe(listEl);
    listEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      ro.disconnect();
      listEl.removeEventListener("scroll", onScroll);
    };
  }, [listEl]);

  useEffect(() => {
    if (!open || !autoScroll) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered, open, autoScroll, virtualSlice.totalHeight]);

  useEffect(() => {
    const root = document.documentElement;
    if (!open) {
      root.style.setProperty("--log-console-height", "0px");
      return;
    }
    root.style.setProperty("--log-console-height", `${height}px`);
    return () => {
      root.style.setProperty("--log-console-height", "0px");
    };
  }, [open, height]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - e.clientY;
      const next = Math.min(
        MAX_HEIGHT,
        Math.max(MIN_HEIGHT, dragRef.current.startH + delta),
      );
      setHeight(next);
    }
    function onUp() {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (!open) return null;

  function onListScroll() {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  }

  async function handleCopy() {
    const text = filtered
      .map((e) => `[${e.ts}] [${e.level}] [${e.source}] ${e.message}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1200);
    } catch {
      // ignore
    }
  }

  async function handleClear() {
    clearEntries();
    try {
      await clearLogBuffer();
    } catch {
      // ignore
    }
  }

  async function handleOpenLogFile() {
    if (!logPath) return;
    try {
      await revealItemInDir(logPath);
    } catch {
      // ignore
    }
  }

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col border-t border-border bg-card/95 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] backdrop-blur-md",
        className,
      )}
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("logConsole.resizeAria")}
        className="group flex h-2 cursor-ns-resize items-center justify-center"
        onMouseDown={(e) => {
          dragRef.current = { startY: e.clientY, startH: height };
          document.body.style.cursor = "ns-resize";
          document.body.style.userSelect = "none";
        }}
      >
        <span className="h-0.5 w-10 rounded-full bg-border group-hover:bg-muted" />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border/80 px-3 pb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Terminal className="h-3.5 w-3.5 text-primary" />
          {t("logConsole.title")}
          <span className="tabular-nums text-muted">
            ({filtered.length}/{entries.length})
          </span>
        </div>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("history.searchMedia")}
          className="h-8 max-w-xs flex-1 text-xs"
          aria-label={t("logConsole.searchAria")}
        />

        <Select
          value={levelFilter}
          onValueChange={(v) => void handleLevelChange(v)}
        >
          <SelectTrigger className="h-8 w-[7.5rem] text-xs" aria-label={t("logConsole.levelFilterAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="debug">{t("logConsole.level.debug")}</SelectItem>
            <SelectItem value="info">{t("logConsole.level.info")}</SelectItem>
            <SelectItem value="warn">{t("logConsole.level.warn")}</SelectItem>
            <SelectItem value="error">{t("logConsole.level.error")}</SelectItem>
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant={autoScroll ? "default" : "secondary"}
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => setAutoScroll(!autoScroll)}
          title={t("logConsole.autoScrollTitle")}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
          Auto
        </Button>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void handleCopy()}
          title={t("logConsole.copyVisibleTitle")}
        >
          <Copy className="h-3.5 w-3.5" />
          {copyFlash ? t("logConsole.copied") : t("logConsole.copy")}
        </Button>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void handleClear()}
          title={t("logConsole.clearTitle")}
        >
          <Eraser className="h-3.5 w-3.5" />
          {t("app.job.clear")}
        </Button>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void handleOpenLogFile()}
          disabled={!logPath}
          title={logPath ? t("logConsole.logFileWithPath", { path: logPath }) : t("logConsole.noLogPath")}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t("logConsole.logFile")}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto h-8 w-8"
          onClick={() => setOpen(false)}
          aria-label={t("logConsole.closeAria")}
          title={t("logConsole.closeTitle")}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div
        ref={attachListRef}
        onScroll={onListScroll}
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-5"
      >
        {filtered.length === 0 ? (
          <p className="text-xs text-muted">{t("logConsole.empty")}</p>
        ) : (
          <div
            className="relative"
            style={{ height: Math.max(virtualSlice.totalHeight, 1) }}
          >
            <div
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${virtualSlice.padTop}px)` }}
            >
              {visibleEntries.map((entry) => (
                <LogLine key={entry.id} entry={entry} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function LogConsoleToggleButton({
  className,
  disabled,
}: {
  className?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const open = useLogStore((s) => s.open);
  const toggleOpen = useLogStore((s) => s.toggleOpen);
  const unreadErrors = useLogStore((s) => s.unreadErrors);

  return (
    <Button
      type="button"
      variant={open ? "default" : "secondary"}
      size="icon"
      className={cn("relative", className)}
      onClick={toggleOpen}
      disabled={disabled}
      aria-label={t("logConsole.title")}
      aria-pressed={open}
      title={t("logConsole.toggleTitle")}
    >
      <Terminal className="h-4 w-4" />
      {unreadErrors > 0 && !open ? (
        <span
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-card"
          aria-hidden
        />
      ) : null}
    </Button>
  );
}
