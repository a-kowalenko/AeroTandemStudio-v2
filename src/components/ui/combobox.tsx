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
import { tr } from "@/i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type ComboboxPinnedOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

/** Pinned row or an in-list divider (e.g. between keep-modes and „Ich“). */
export type ComboboxPinnedEntry =
  | ComboboxPinnedOption
  | { kind: "separator" };

function isPinnedOption(
  entry: ComboboxPinnedEntry,
): entry is ComboboxPinnedOption {
  return !("kind" in entry && entry.kind === "separator");
}

type ComboboxProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  /** Always listed at the top of the dropdown (e.g. mode choices / self pin). */
  pinnedOptions?: readonly ComboboxPinnedEntry[];
  /**
   * Values that appear in the list but cannot be chosen (case-insensitive).
   * Also disables matching pinned options unless they set `disabled` explicitly.
   */
  disabledValues?: readonly string[];
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
  /** Inline validation message; also styles the input as invalid. */
  error?: string;
  /**
   * Soft attention (e.g. missing crew after QR/AMS); ignored when `error` is set.
   * Pass `true` for border-only, or a string for border + message.
   */
  warning?: boolean | string;
  id?: string;
  /** Portal list z-index (raise above modals, default 80). */
  listZIndex?: number;
  /** Visually hide the label (keeps it for screen readers). */
  hideLabel?: boolean;
  /** Extra classes for the text input. */
  inputClassName?: string;
  /** Fired when a list suggestion is chosen (not on free-text typing). */
  onSelectOption?: (value: string) => void;
  /** Blur the input after choosing a suggestion (ends focus so the list cannot reopen). */
  blurOnSelect?: boolean;
};

type ListPos = {
  mode: "fixed" | "absolute";
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

type ListEntry =
  | { kind: "pinned"; value: string; label: string; disabled: boolean }
  | { kind: "option"; value: string; label: string; disabled: boolean }
  | { kind: "separator" };

const EMPTY_PINNED: readonly ComboboxPinnedEntry[] = [];
const EMPTY_DISABLED: readonly string[] = [];

function normKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Text input with filtered suggestion list. Free text always allowed.
 * List is portaled — into the nearest dialog when inside one (Radix modal
 * marks body siblings as inert, so a body portal would not receive clicks).
 */
export function Combobox({
  label,
  value,
  onChange,
  options,
  pinnedOptions = EMPTY_PINNED,
  disabledValues = EMPTY_DISABLED,
  disabled,
  placeholder,
  hint,
  error,
  warning,
  id: idProp,
  listZIndex = 80,
  hideLabel = false,
  inputClassName,
  onSelectOption,
  blurOnSelect = false,
}: ComboboxProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const listId = `${id}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Avoid reopen when focus briefly returns after select / blur. */
  const skipOpenOnFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** null = show all options (open via focus/chevron); string = filter while typing */
  const [filterQuery, setFilterQuery] = useState<string | null>(null);
  const [listPos, setListPos] = useState<ListPos | null>(null);
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);

  const disabledKeys = useMemo(() => {
    const set = new Set<string>();
    for (const v of disabledValues) {
      const k = normKey(v);
      if (k) set.add(k);
    }
    return set;
  }, [disabledValues]);

  const isDisabledValue = (v: string) => disabledKeys.has(normKey(v));

  const pinnedLabel = useMemo(() => {
    const hit = pinnedOptions.find(
      (p): p is ComboboxPinnedOption =>
        isPinnedOption(p) && p.value === value,
    );
    return hit?.label ?? null;
  }, [pinnedOptions, value]);

  /** What the text field shows (pinned sentinels → human label). */
  const inputDisplay = pinnedLabel ?? value;

  const entries = useMemo((): ListEntry[] => {
    const q =
      filterQuery === null ? "" : filterQuery.trim().toLowerCase();
    const pinnedOnly = pinnedOptions.filter(isPinnedOption);
    const pinnedKeys = new Set(
      pinnedOnly.map((p) => normKey(p.value)).filter(Boolean),
    );
    const unique = [
      ...new Set(options.map((o) => o.trim()).filter(Boolean)),
    ].filter((o) => !pinnedKeys.has(normKey(o)));
    const regular = q
      ? unique.filter((o) => o.toLowerCase().includes(q))
      : unique;

    const out: ListEntry[] = [];
    let pendingSeparator = false;
    for (const entry of pinnedOptions) {
      if (!isPinnedOption(entry)) {
        if (out.length > 0) pendingSeparator = true;
        continue;
      }
      if (
        q &&
        !entry.label.toLowerCase().includes(q) &&
        !entry.value.toLowerCase().includes(q)
      ) {
        continue;
      }
      if (pendingSeparator) {
        out.push({ kind: "separator" });
        pendingSeparator = false;
      }
      out.push({
        kind: "pinned",
        value: entry.value,
        label: entry.label,
        disabled: entry.disabled === true || isDisabledValue(entry.value),
      });
    }
    if (out.length > 0 && regular.length > 0) {
      const last = out[out.length - 1];
      if (last?.kind !== "separator") {
        out.push({ kind: "separator" });
      }
    }
    for (const o of regular) {
      out.push({
        kind: "option",
        value: o,
        label: o,
        disabled: isDisabledValue(o),
      });
    }
    return out;
  }, [options, pinnedOptions, filterQuery, disabledKeys]);

  /** Keyboard / Enter targets — skip separators and disabled rows. */
  const selectable = useMemo(
    () =>
      entries.filter(
        (e): e is Exclude<ListEntry, { kind: "separator" }> =>
          e.kind !== "separator" && !e.disabled,
      ),
    [entries],
  );

  /** All non-separator rows (for highlight mapping including disabled). */
  const listRows = useMemo(
    () => entries.filter((e) => e.kind !== "separator"),
    [entries],
  );

  useEffect(() => {
    setHighlight(0);
  }, [entries, filterQuery]);

  useLayoutEffect(() => {
    if (!open || disabled || listRows.length === 0) {
      setListPos(null);
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
      const preferredMax = 240;
      const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
      const spaceAbove = rect.top - gap - 8;
      const openUp = spaceBelow < 120 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(
        80,
        Math.min(preferredMax, openUp ? spaceAbove : spaceBelow),
      );

      if (dialog instanceof HTMLElement) {
        // Dialog uses transform → fixed is relative to dialog; use absolute + dialog coords.
        const d = dialog.getBoundingClientRect();
        setListPos(
          openUp
            ? {
                mode: "absolute",
                bottom: d.bottom - rect.top + gap,
                left: rect.left - d.left,
                width: rect.width,
                maxHeight,
              }
            : {
                mode: "absolute",
                top: rect.bottom - d.top + gap,
                left: rect.left - d.left,
                width: rect.width,
                maxHeight,
              },
        );
      } else {
        setListPos(
          openUp
            ? {
                mode: "fixed",
                bottom: window.innerHeight - rect.top + gap,
                left: rect.left,
                width: rect.width,
                maxHeight,
              }
            : {
                mode: "fixed",
                top: rect.bottom + gap,
                left: rect.left,
                width: rect.width,
                maxHeight,
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
  }, [open, disabled, listRows.length, value]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (rootRef.current?.contains(t)) return;
      if (t.closest?.("[data-ats-combobox-list]")) return;
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

  function select(optionValue: string) {
    if (isDisabledValue(optionValue)) return;
    const pinned = pinnedOptions.find(
      (p): p is ComboboxPinnedOption =>
        isPinnedOption(p) && p.value === optionValue,
    );
    if (pinned?.disabled) return;
    skipOpenOnFocusRef.current = true;
    onChange(optionValue);
    onSelectOption?.(optionValue);
    setFilterQuery(null);
    setOpen(false);
    if (blurOnSelect) {
      inputRef.current?.blur();
    }
    window.setTimeout(() => {
      skipOpenOnFocusRef.current = false;
    }, 120);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) openList();
      setHighlight((i) =>
        Math.min(i + 1, Math.max(selectable.length - 1, 0)),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openList();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && selectable[highlight]) {
      e.preventDefault();
      select(selectable[highlight].value);
    } else if (e.key === "Escape") {
      setOpen(false);
      setFilterQuery(null);
    }
  }

  const listStyle: CSSProperties | undefined = listPos
    ? {
        position: listPos.mode,
        top: listPos.top,
        bottom: listPos.bottom,
        left: listPos.left,
        width: listPos.width,
        maxHeight: listPos.maxHeight,
        zIndex: listZIndex,
        pointerEvents: "auto",
      }
    : undefined;

  const warningActive = Boolean(warning);
  const warningText =
    typeof warning === "string" && warning.trim() ? warning.trim() : undefined;
  const attention = error
    ? ("error" as const)
    : warningActive
      ? ("warning" as const)
      : null;
  const attentionMsg = error || warningText || undefined;
  const msgId = attentionMsg ? `${id}-msg` : undefined;

  /** Map highlight (into selectable) → row index among non-separator entries for aria. */
  const highlightedValue = selectable[highlight]?.value;

  const list =
    open && !disabled && listRows.length > 0 && listPos && portalEl
      ? createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            data-ats-combobox-list=""
            style={listStyle}
            className="overflow-auto rounded-md border border-border bg-card py-1 shadow-md"
          >
            {entries.map((entry, i) => {
              if (entry.kind === "separator") {
                return (
                  <li
                    key={`sep-${i}`}
                    role="presentation"
                    className="my-1 border-t border-border"
                  />
                );
              }
              const selected = value === entry.value;
              const isHighlighted = highlightedValue === entry.value;
              const rowDisabled = entry.disabled;
              return (
                <li
                  key={`${entry.kind}-${entry.value}`}
                  role="option"
                  aria-selected={isHighlighted}
                  aria-disabled={rowDisabled || undefined}
                >
                  <button
                    type="button"
                    disabled={rowDisabled}
                    className={cn(
                      "flex w-full px-3 py-1.5 text-left text-sm",
                      rowDisabled
                        ? "cursor-not-allowed text-muted/50"
                        : isHighlighted
                          ? "bg-primary-soft text-foreground"
                          : "text-foreground hover:bg-card-elevated",
                      entry.kind === "pinned" && !rowDisabled && "font-medium",
                      selected && !rowDisabled && "text-primary",
                    )}
                    onMouseEnter={() => {
                      if (rowDisabled) return;
                      const idx = selectable.findIndex(
                        (s) => s.value === entry.value,
                      );
                      if (idx >= 0) setHighlight(idx);
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (rowDisabled) return;
                      select(entry.value);
                    }}
                  >
                    {entry.label}
                  </button>
                </li>
              );
            })}
          </ul>,
          portalEl,
        )
      : null;

  return (
    <div className={cn(!hideLabel && "space-y-1.5")} ref={rootRef}>
      <Label
        htmlFor={id}
        className={cn("text-xs text-muted", hideLabel && "sr-only")}
      >
        {label}
      </Label>
      <div className="relative" ref={triggerRef}>
        <Input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={attention === "error" ? true : undefined}
          aria-describedby={msgId}
          autoComplete="off"
          value={filterQuery !== null ? filterQuery : inputDisplay}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            let next = e.target.value;
            // First keystroke while showing a pinned label: don't keep the label text.
            if (pinnedLabel && filterQuery === null) {
              const prev = pinnedLabel;
              if (next.startsWith(prev)) next = next.slice(prev.length);
              else if (next.endsWith(prev)) next = next.slice(0, -prev.length);
              else if (next.includes(prev)) next = next.replace(prev, "");
            }
            setFilterQuery(next);
            onChange(next);
            setOpen(true);
          }}
          onFocus={() => {
            if (skipOpenOnFocusRef.current) return;
            openList();
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "pr-9",
            disabled && "bg-card-elevated",
            attention === "error" &&
              "border-destructive focus-visible:ring-destructive/40",
            attention === "warning" &&
              "border-warning/70 bg-warning/5 focus-visible:ring-warning/35",
            inputClassName,
          )}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label={tr("common.actions.showSuggestions")}
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
      {attention === "error" ? (
        <p
          id={msgId}
          className="text-[11px] leading-snug text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : attention === "warning" && warningText ? (
        <p
          id={msgId}
          className="text-[11px] leading-snug text-warning"
          role="status"
        >
          {warningText}
        </p>
      ) : hint ? (
        <p className="text-[10px] leading-snug text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
