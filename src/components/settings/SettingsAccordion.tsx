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
};

export function SettingsAccordion({
  title,
  children,
  defaultOpen = false,
  forceOpen = false,
  className,
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
        className="flex h-auto w-full items-center justify-between rounded-lg px-3 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase hover:bg-muted/30"
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
        <div className="space-y-4 border-t border-border px-3 pt-3 pb-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}
