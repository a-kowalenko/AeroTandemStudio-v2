import { useEffect, useState } from "react";
import { Spinner } from "./Spinner";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  status: string;
  version?: string;
  error?: string | null;
  className?: string;
};

export function SplashScreen({ open, status, version, error, className }: Props) {
  const [visible, setVisible] = useState(open);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (open) {
      setVisible(true);
      setFading(false);
      return;
    }
    if (!visible) return;
    setFading(true);
    const t = window.setTimeout(() => {
      setVisible(false);
      setFading(false);
    }, 280);
    return () => window.clearTimeout(t);
  }, [open, visible]);

  if (!visible) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[100] flex items-center justify-center transition-opacity duration-300",
        fading ? "opacity-0" : "opacity-100",
        className,
      )}
      style={{
        background:
          "radial-gradient(ellipse 70% 50% at 50% 30%, var(--ats-bg-glow-1), transparent 60%), var(--ats-bg)",
      }}
      role="status"
      aria-live="polite"
      aria-busy={open}
    >
      <div className="flex w-[min(400px,90vw)] flex-col items-center px-6 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-primary-soft ring-1 ring-primary/25">
          <img
            src="/logo.png"
            alt=""
            width={64}
            height={64}
            className="h-16 w-16 object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-primary">
          Aero Tandem Studio
        </h1>
        <p className="mt-1 text-xs tracking-wide text-muted uppercase">Video-Produktion</p>
        <div className="mt-7">
          <Spinner size={44} />
        </div>
        <p className="mt-4 text-sm text-muted">{status || "Wird geladen…"}</p>
        {error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {version ? (
          <p className="mt-3 text-xs text-muted/80">Version {version}</p>
        ) : null}
      </div>
    </div>
  );
}
