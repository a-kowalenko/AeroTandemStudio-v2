import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
};

/** Title left, control right. Long hints stay on `title`, not as a body paragraph. */
export function SettingsRow({
  label,
  hint,
  htmlFor,
  children,
  className,
}: Props) {
  return (
    <div
      className={cn("flex items-center justify-between gap-4", className)}
      title={hint}
    >
      <Label htmlFor={htmlFor} className="min-w-0 flex-1 text-sm font-normal">
        {label}
      </Label>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
