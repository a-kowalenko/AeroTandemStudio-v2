import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  text: string;
  className?: string;
};

const OPEN_DELAY_MS = 120;

type TipPos = { top: number; left: number; place: "above" | "below" };

/** Info icon with a fast custom tooltip (not native `title`). */
export function SettingsHintIcon({ text, className }: Props) {
  const tip = text.trim();
  const tipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<TipPos | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current != null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const updatePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    const preferAbove = r.top > 72;
    const place: TipPos["place"] = preferAbove ? "above" : "below";
    setPos({
      place,
      top: place === "above" ? r.top - gap : r.bottom + gap,
      left: Math.min(
        Math.max(8, r.left + r.width / 2),
        window.innerWidth - 8,
      ),
    });
  }, []);

  const show = useCallback(() => {
    clearOpenTimer();
    updatePos();
    setOpen(true);
  }, [clearOpenTimer, updatePos]);

  const hide = useCallback(() => {
    clearOpenTimer();
    setOpen(false);
  }, [clearOpenTimer]);

  const scheduleShow = useCallback(() => {
    clearOpenTimer();
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      updatePos();
      setOpen(true);
    }, OPEN_DELAY_MS);
  }, [clearOpenTimer, updatePos]);

  useEffect(() => () => clearOpenTimer(), [clearOpenTimer]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onReposition = () => updatePos();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open, hide, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t) || tipRef.current?.contains(t)) {
        return;
      }
      hide();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, hide]);

  if (!tip) return null;

  const style: CSSProperties | undefined = pos
    ? {
        top: pos.top,
        left: pos.left,
        transform:
          pos.place === "above"
            ? "translate(-50%, -100%)"
            : "translate(-50%, 0)",
      }
    : undefined;

  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "inline-flex rounded-sm text-muted transition-colors",
          "hover:text-foreground focus-visible:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
        aria-label={tip}
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        onMouseEnter={scheduleShow}
        onMouseLeave={hide}
        onFocus={(e) => {
          // Keyboard only — mouse focus + click would open then immediately close.
          if (e.currentTarget.matches(":focus-visible")) show();
        }}
        onBlur={hide}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) hide();
          else show();
        }}
      >
        <Info className="size-3.5" strokeWidth={2} aria-hidden />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={tipRef}
              id={tipId}
              role="tooltip"
              style={style}
              className={cn(
                "pointer-events-none fixed z-[200] max-w-[min(24rem,calc(100vw-1rem))]",
                "rounded-md border border-border/80 bg-card px-3 py-2",
                "text-sm leading-snug whitespace-pre-line text-foreground shadow-lg",
              )}
              onMouseEnter={show}
              onMouseLeave={hide}
            >
              {tip}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
