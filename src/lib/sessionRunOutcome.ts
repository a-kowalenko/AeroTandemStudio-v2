import type { DialogActionStatus } from "@/store/uiStore";

/** Informational end-of-run report shown on the session progress panel. */
export type SessionRunOutcome = {
  id: number;
  title: string;
  highlight?: string;
  actions: DialogActionStatus[];
  tone: "success" | "warning";
  queuedNext?: boolean;
};

export const SESSION_OUTCOME_HIDE_MS = 8000;
export const SESSION_OUTCOME_HIDE_WARNING_MS = 10000;
export const SESSION_OUTCOME_HIDE_QUEUED_MS = 3000;
/** Exit fade/slide before store clear. */
export const SESSION_OUTCOME_EXIT_MS = 280;

let nextSessionRunId = 1;

export function sessionRunOutcomeTone(
  actions: DialogActionStatus[],
): "success" | "warning" {
  return actions.some((a) => a.tone === "error" || a.tone === "warning")
    ? "warning"
    : "success";
}

export function sessionOutcomeHideMs(opts: {
  queuedNext?: boolean;
  tone?: "success" | "warning";
}): number {
  if (opts.queuedNext) return SESSION_OUTCOME_HIDE_QUEUED_MS;
  if (opts.tone === "warning") return SESSION_OUTCOME_HIDE_WARNING_MS;
  return SESSION_OUTCOME_HIDE_MS;
}

export function buildSessionRunOutcome(opts: {
  title: string;
  highlight?: string;
  actions: DialogActionStatus[];
  queuedNext?: boolean;
}): SessionRunOutcome {
  const highlight = opts.highlight?.trim() ?? "";
  return {
    id: nextSessionRunId++,
    title: opts.title.trim(),
    highlight: highlight || undefined,
    actions: [...opts.actions],
    tone: sessionRunOutcomeTone(opts.actions),
    queuedNext: Boolean(opts.queuedNext),
  };
}
