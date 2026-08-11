import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

const MONTHS_DE = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
] as const;

type PanelPos = {
  mode: "fixed" | "absolute";
  top?: number;
  bottom?: number;
  left: number;
  width: number;
};

/** Parse stored DE `dd.mm.yyyy` or ISO `yyyy-mm-dd` → local Date (noon). */
export function parseDatum(datum: string): Date | null {
  const raw = datum.trim();
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
  if (!de) return null;
  const d = Number(de[1]);
  const m = Number(de[2]);
  const y = Number(de[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt;
}

/** Local Date → DE `dd.mm.yyyy`. */
export function formatDatum(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getFullYear()}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 12, 0, 0, 0);
}

function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1, 12, 0, 0, 0);
}

/** Monday-first weekday index (0 = Mo … 6 = So). */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

type DateFieldProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Portal panel z-index (raise above modals, default 80). */
  panelZIndex?: number;
  /** Visually hide the label (keeps it for screen readers). */
  hideLabel?: boolean;
  /** Extra classes for the text input. */
  inputClassName?: string;
};

/**
 * DE date field with Lucide calendar trigger and custom month grid.
 * Avoids native `<input type="date">` (broken/invisible picker chrome on macOS WKWebView).
 */
export function DateField({
  label,
  value,
  onChange,
  disabled,
  panelZIndex = 80,
  hideLabel = false,
  inputClassName,
}: DateFieldProps) {
  const autoId = useId();
  const panelId = `${autoId}-panel`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [panelPos, setPanelPos] = useState<PanelPos | null>(null);
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);

  const selected = useMemo(() => parseDatum(value), [value]);
  const [viewMonth, setViewMonth] = useState(() =>
    startOfMonth(selected ?? new Date()),
  );

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (open) {
      setViewMonth(startOfMonth(selected ?? new Date()));
    }
  }, [open, selected]);

  useLayoutEffect(() => {
    if (!open || disabled) {
      setPanelPos(null);
      setPortalEl(null);
      return;
    }

    function updatePos() {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dialog = el.closest('[role="dialog"]');
      const portal =
        dialog instanceof HTMLElement ? dialog : document.body;
      setPortalEl(portal);

      const gap = 4;
      const panelW = Math.max(rect.width, 288);
      const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
      const spaceAbove = rect.top - gap - 8;
      const openUp = spaceBelow < 280 && spaceAbove > spaceBelow;
      const leftOffset = Math.min(
        0,
        window.innerWidth - 8 - (rect.left + panelW),
      );

      if (dialog instanceof HTMLElement) {
        const d = dialog.getBoundingClientRect();
        setPanelPos(
          openUp
            ? {
                mode: "absolute",
                bottom: d.bottom - rect.top + gap,
                left: rect.left - d.left + leftOffset,
                width: panelW,
              }
            : {
                mode: "absolute",
                top: rect.bottom - d.top + gap,
                left: rect.left - d.left + leftOffset,
                width: panelW,
              },
        );
      } else {
        setPanelPos(
          openUp
            ? {
                mode: "fixed",
                bottom: window.innerHeight - rect.top + gap,
                left: Math.max(8, rect.left + leftOffset),
                width: panelW,
              }
            : {
                mode: "fixed",
                top: rect.bottom + gap,
                left: Math.max(8, rect.left + leftOffset),
                width: panelW,
              },
        );
      }
    }

    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [open, disabled]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (rootRef.current?.contains(t)) return;
      if (t.closest?.("[data-ats-date-panel]")) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function commitDraft(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      onChange("");
      setDraft("");
      return;
    }
    const parsed = parseDatum(trimmed);
    if (parsed) {
      const next = formatDatum(parsed);
      onChange(next);
      setDraft(next);
    } else {
      setDraft(value);
    }
  }

  function pickDay(day: Date) {
    const next = formatDatum(day);
    onChange(next);
    setDraft(next);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === "Escape") {
      setOpen(false);
      setDraft(value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitDraft(draft);
      setOpen(false);
    } else if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    }
  }

  const days = useMemo(() => {
    const first = startOfMonth(viewMonth);
    const startOffset = mondayIndex(first);
    const gridStart = new Date(
      first.getFullYear(),
      first.getMonth(),
      1 - startOffset,
      12,
      0,
      0,
      0,
    );
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + i,
        12,
        0,
        0,
        0,
      );
      return d;
    });
  }, [viewMonth]);

  const today = useMemo(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12, 0, 0, 0);
  }, [open]);

  const panelStyle: CSSProperties | undefined = panelPos
    ? {
        position: panelPos.mode,
        top: panelPos.top,
        bottom: panelPos.bottom,
        left: panelPos.left,
        width: panelPos.width,
        zIndex: panelZIndex,
        pointerEvents: "auto",
      }
    : undefined;

  const panel =
    open && !disabled && panelPos && portalEl
      ? createPortal(
          <div
            id={panelId}
            aria-label="Datum wählen"
            data-ats-date-panel=""
            style={panelStyle}
            className="rounded-md border border-border bg-card p-3 shadow-md"
          >
            <div className="mb-2 flex items-center justify-between gap-1">
              <button
                type="button"
                aria-label="Vorheriger Monat"
                className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-primary-soft hover:text-foreground"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setViewMonth((m) => addMonths(m, -1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <p className="text-sm font-medium text-foreground tabular-nums">
                {MONTHS_DE[viewMonth.getMonth()]} {viewMonth.getFullYear()}
              </p>
              <button
                type="button"
                aria-label="Nächster Monat"
                className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-primary-soft hover:text-foreground"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setViewMonth((m) => addMonths(m, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="mb-1 grid grid-cols-7 gap-0.5">
              {WEEKDAYS.map((w) => (
                <div
                  key={w}
                  className="py-1 text-center text-[10px] font-semibold tracking-wide text-muted uppercase"
                >
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {days.map((day) => {
                const inMonth = day.getMonth() === viewMonth.getMonth();
                const isSelected = selected ? sameDay(day, selected) : false;
                const isToday = sameDay(day, today);
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    aria-label={formatDatum(day)}
                    aria-pressed={isSelected}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickDay(day)}
                    className={cn(
                      "flex h-8 items-center justify-center rounded-md text-sm tabular-nums transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      !inMonth && "text-muted/55",
                      inMonth && !isSelected && "text-foreground hover:bg-card-elevated",
                      isToday && !isSelected && "ring-1 ring-border",
                      isSelected &&
                        "bg-primary font-semibold text-primary-foreground shadow-sm hover:brightness-110",
                    )}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex justify-between gap-2 border-t border-border pt-2">
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-muted hover:bg-card-elevated hover:text-foreground"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickDay(today)}
              >
                Heute
              </button>
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-muted hover:bg-card-elevated hover:text-foreground"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange("");
                  setDraft("");
                  setOpen(false);
                }}
              >
                Leeren
              </button>
            </div>
          </div>,
          portalEl,
        )
      : null;

  return (
    <div className={cn(!hideLabel && "space-y-1.5")} ref={rootRef}>
      <Label
        htmlFor={autoId}
        className={cn("text-xs text-muted", hideLabel && "sr-only")}
      >
        {label}
      </Label>
      <div className="relative" ref={triggerRef}>
        <Input
          id={autoId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="TT.MM.JJJJ"
          value={draft}
          disabled={disabled}
          aria-expanded={open}
          aria-controls={panelId}
          aria-haspopup="true"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commitDraft(draft)}
          onKeyDown={onKeyDown}
          className={cn(
            "pr-9",
            disabled && "bg-card-elevated",
            inputClassName,
          )}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Kalender öffnen"
          aria-expanded={open}
          className="absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-primary-soft hover:text-foreground disabled:pointer-events-none"
          onClick={() => setOpen((v) => !v)}
        >
          <CalendarIcon className="h-4 w-4" />
        </button>
      </div>
      {panel}
    </div>
  );
}
