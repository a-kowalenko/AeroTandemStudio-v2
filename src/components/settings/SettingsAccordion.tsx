import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  className?: string;
  /** Keep title casing (e.g. version tags) instead of section uppercase. */
  plainTitle?: boolean;
};

export function SettingsAccordion({
  title,
  children,
  defaultOpen = false,
  forceOpen = false,
  className,
  plainTitle = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = forceOpen || open;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-background/60",
        className,
      )}
    >
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "flex h-auto w-full items-center justify-between rounded-lg px-3 py-2.5 text-xs font-semibold text-muted hover:bg-muted/30",
          plainTitle ? "tracking-normal" : "tracking-wide uppercase",
        )}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={shown}
      >
        {title}
        <ChevronDown
          className={cn("h-4 w-4 transition-transform", shown && "rotate-180")}
          aria-hidden
        />
      </Button>
      {shown ? (
        <div
          className={cn(
            "border-t border-border px-3 pt-3 pb-3",
            plainTitle ? "space-y-2" : "space-y-4",
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
