import { Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

type Props = {
  state: "preparing" | "ready";
  className?: string;
};

/**
 * Compact speculative-create status next to „Vorgang“.
 * Loader2 keeps spinning on its own node; wrappers only opacity/scale for morph.
 */
export function SpeculativeStatusIcon({ state, className }: Props) {
  const { t } = useTranslation();
  const ready = state === "ready";

  return (
    <span
      className={cn(
        "ats-speculative-icon relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center",
        className,
      )}
      title={
        ready ? t("create.speculative.ready") : t("create.speculative.preparing")
      }
      aria-label={
        ready ? t("create.speculative.ready") : t("create.speculative.preparing")
      }
      aria-live="polite"
      data-state={state}
    >
      <span
        className={cn(
          "ats-speculative-morph absolute inset-0 flex items-center justify-center",
          ready
            ? "ats-speculative-morph--spinner-out"
            : "ats-speculative-morph--spinner-in",
        )}
        aria-hidden
      >
        <Loader2
          className="h-3.5 w-3.5 animate-spin text-primary [animation-duration:700ms]"
          strokeWidth={2.5}
        />
      </span>
      <span
        className={cn(
          "ats-speculative-morph absolute inset-0 flex items-center justify-center",
          ready
            ? "ats-speculative-morph--check-in"
            : "ats-speculative-morph--check-out",
        )}
        aria-hidden
      >
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary/15 text-primary shadow-[inset_0_0_0_1px] shadow-primary/40">
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      </span>
    </span>
  );
}
