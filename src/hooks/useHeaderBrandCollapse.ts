import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Title row: full name → ATS (+ version) → ATS only → hidden. */
export type HeaderTitleLevel = 0 | 1 | 2 | 3;

/** Subtitle row: full → compact (no encoder label / backup filename) → hidden. */
export type HeaderSubtitleLevel = 0 | 1 | 2;

export type HeaderBrandCollapse = {
  title: HeaderTitleLevel;
  subtitle: HeaderSubtitleLevel;
};

/** Least → most collapsed; first fitting step wins. */
export const HEADER_BRAND_COLLAPSE_STEPS: HeaderBrandCollapse[] = [
  { title: 0, subtitle: 0 },
  { title: 1, subtitle: 0 },
  { title: 1, subtitle: 1 },
  { title: 2, subtitle: 1 },
  { title: 1, subtitle: 2 },
  { title: 2, subtitle: 2 },
  { title: 3, subtitle: 2 },
];

const HYSTERESIS_PX = 12;

function rowOverflows(el: HTMLElement | null, slackPx: number): boolean {
  if (!el || el.clientWidth <= 0) return false;
  return el.scrollWidth > el.clientWidth + slackPx;
}

function stepFits(
  row1El: HTMLElement | null,
  row2El: HTMLElement | null,
  subtitleLevel: HeaderSubtitleLevel,
  slackPx: number,
): boolean {
  if (rowOverflows(row1El, slackPx)) return false;
  if (subtitleLevel >= 2) return true;
  if (!row2El || row2El.hidden) return true;
  return !rowOverflows(row2El, slackPx);
}

type Options = {
  measureKey: string;
  measureRef: RefObject<HTMLDivElement | null>;
  probeRow1Ref: RefObject<HTMLDivElement | null>;
  probeRow2Ref: RefObject<HTMLParagraphElement | null>;
  applyProbeStep: (step: HeaderBrandCollapse) => void;
};

/**
 * Picks the least-collapsed header brand step that fits the available width.
 * Uses hidden nowrap probes — no flushSync re-render loop.
 */
export function useHeaderBrandCollapse({
  measureKey,
  measureRef,
  probeRow1Ref,
  probeRow2Ref,
  applyProbeStep,
}: Options): {
  collapse: HeaderBrandCollapse;
} {
  const [stepIndex, setStepIndex] = useState(0);
  const stepIndexRef = useRef(0);
  stepIndexRef.current = stepIndex;

  const applyProbeStepRef = useRef(applyProbeStep);
  applyProbeStepRef.current = applyProbeStep;
  const rafRef = useRef<number | null>(null);

  const findFirstFit = useCallback(
    (slackPx: number): number => {
      const probeRow1 = probeRow1Ref.current;
      const probeRow2 = probeRow2Ref.current;
      if (!probeRow1) return HEADER_BRAND_COLLAPSE_STEPS.length - 1;

      for (let i = 0; i < HEADER_BRAND_COLLAPSE_STEPS.length; i++) {
        const step = HEADER_BRAND_COLLAPSE_STEPS[i]!;
        applyProbeStepRef.current(step);
        if (stepFits(probeRow1, probeRow2, step.subtitle, slackPx)) return i;
      }
      return HEADER_BRAND_COLLAPSE_STEPS.length - 1;
    },
    [probeRow1Ref, probeRow2Ref],
  );

  const measure = useCallback(() => {
    if ((measureRef.current?.clientWidth ?? 0) <= 0) return;

    const prev = stepIndexRef.current;
    const tightest = findFirstFit(0);

    if (tightest > prev) {
      setStepIndex(tightest);
      return;
    }

    if (tightest < prev) {
      const withSlack = findFirstFit(HYSTERESIS_PX);
      setStepIndex(Math.min(prev, withSlack));
      return;
    }

    setStepIndex(tightest);
  }, [findFirstFit]);

  const scheduleMeasure = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      measure();
    });
  }, [measure]);

  useLayoutEffect(() => {
    measure();
  }, [measureKey, measure]);

  useEffect(() => {
    const root = measureRef.current;
    if (!root) return;

    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(root);

    return () => {
      ro.disconnect();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [measureRef, scheduleMeasure]);

  return {
    collapse:
      HEADER_BRAND_COLLAPSE_STEPS[stepIndex] ??
      HEADER_BRAND_COLLAPSE_STEPS[HEADER_BRAND_COLLAPSE_STEPS.length - 1]!,
  };
}

export { resolveHeaderSubtitleText, type HeaderSubtitleSource } from "./headerBrandText";
