import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Props = {
  title: string;
  description?: string;
  /** Optional top-right slot (e.g. media preview). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function SettingsSection({
  title,
  description,
  aside,
  children,
  className,
}: Props) {
  const header = (
    <div>
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        {title}
      </p>
      {description ? (
        <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
      ) : null}
    </div>
  );

  if (aside) {
    // Keep title + body in one column so controls sit under the title,
    // not below the full height of a tall aside (preview).
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border border-border bg-background/60 p-3",
          className,
        )}
      >
        <div className="min-w-0 flex-1 space-y-3">
          {header}
          {children}
        </div>
        <div className="shrink-0">{aside}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border border-border bg-background/60 p-3",
        className,
      )}
    >
      {header}
      {children}
    </div>
  );
}
