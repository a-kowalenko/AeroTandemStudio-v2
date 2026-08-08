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
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type ComboboxProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
  /** Inline validation message; also styles the input as invalid. */
  error?: string;
  id?: string;
  /** Portal list z-index (raise above modals, default 80). */
  listZIndex?: number;
};

type ListPos = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

/**
 * Text input with filtered suggestion list. Free text always allowed.
 * List is portaled so it can overlay scroll parents and the sidebar footer.
 */
export function Combobox({
  label,
  value,
  onChange,
  options,
  disabled,
  placeholder,
  hint,
  error,
  id: idProp,
  listZIndex = 80,
}: ComboboxProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const listId = `${id}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** null = show all options (open via focus/chevron); string = filter while typing */
  const [filterQuery, setFilterQuery] = useState<string | null>(null);
  const [listPos, setListPos] = useState<ListPos | null>(null);

  const filtered = useMemo(() => {
    const unique = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
    if (filterQuery === null) return unique;
    const q = filterQuery.trim().toLowerCase();
    if (!q) return unique;
    return unique.filter((o) => o.toLowerCase().includes(q));
  }, [options, filterQuery]);

  useEffect(() => {
    setHighlight(0);
  }, [filtered, filterQuery]);

  useLayoutEffect(() => {
    if (!open || disabled || filtered.length === 0) {
      setListPos(null);
      return;
    }

    function updatePos() {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const gap = 4;
      const preferredMax = 192; // max-h-48
      const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
      const spaceAbove = rect.top - gap - 8;
      const openUp = spaceBelow < 120 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(
        80,
        Math.min(preferredMax, openUp ? spaceAbove : spaceBelow),
      );
      setListPos(
        openUp
          ? {
              bottom: window.innerHeight - rect.top + gap,
              left: rect.left,
              width: rect.width,
              maxHeight,
            }
          : {
              top: rect.bottom + gap,
              left: rect.left,
              width: rect.width,
              maxHeight,
            },
      );
    }

    updatePos();
    window.addEventListener("resize", updatePos);
    // Capture scroll from any ancestor (sidebar overflow-y-auto).
    window.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [open, disabled, filtered.length, value]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
      setFilterQuery(null);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function openList() {
    setFilterQuery(null);
    setOpen(true);
  }

  function select(option: string) {
    onChange(option);
    setFilterQuery(null);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) openList();
      setHighlight((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openList();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && filtered[highlight]) {
      e.preventDefault();
      select(filtered[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setFilterQuery(null);
    }
  }

  const listStyle: CSSProperties | undefined = listPos
    ? {
        position: "fixed",
        top: listPos.top,
        bottom: listPos.bottom,
        left: listPos.left,
        width: listPos.width,
        maxHeight: listPos.maxHeight,
        zIndex: listZIndex,
      }
    : undefined;

  const list =
    open && !disabled && filtered.length > 0 && listPos
      ? createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            style={listStyle}
            className="overflow-auto rounded-md border border-border bg-card py-1 shadow-md"
          >
            {filtered.map((option, i) => (
              <li key={option} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full px-3 py-1.5 text-left text-sm",
                    i === highlight
                      ? "bg-primary-soft text-foreground"
                      : "text-foreground hover:bg-card-elevated",
                  )}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(option)}
                >
                  {option}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )
      : null;

  return (
    <div className="space-y-1.5" ref={rootRef}>
      <Label htmlFor={id} className="text-xs text-muted">
        {label}
      </Label>
      <div className="relative" ref={triggerRef}>
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            const next = e.target.value;
            onChange(next);
            setFilterQuery(next);
            setOpen(true);
          }}
          onFocus={() => openList()}
          onKeyDown={onKeyDown}
          className={cn(
            "pr-9",
            disabled && "bg-card-elevated",
            error &&
              "border-destructive focus-visible:ring-destructive/40",
          )}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Vorschläge anzeigen"
          className="absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-primary-soft hover:text-foreground disabled:pointer-events-none"
          onClick={() => {
            if (open) {
              setOpen(false);
              setFilterQuery(null);
            } else {
              openList();
            }
          }}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {list}
      {error ? (
        <p className="text-[11px] leading-snug text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[10px] leading-snug text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
