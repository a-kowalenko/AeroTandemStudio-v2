import { useLayoutEffect, useState, type RefObject } from "react";

export type AnchoredFixedPosition = {
  top: number;
  left: number;
  width: number;
};

/**
 * Fixed coords just below an anchor (for portaled popovers outside
 * backdrop-filter ancestors like the titlebar).
 */
export function useAnchoredFixedPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null> | undefined,
  gapPx = 6,
): AnchoredFixedPosition | null {
  const [pos, setPos] = useState<AnchoredFixedPosition | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef?.current) {
      setPos(null);
      return;
    }

    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = Math.min(r.width, window.innerWidth - 24);
      let left = r.left;
      const maxLeft = window.innerWidth - width - 12;
      if (left > maxLeft) left = Math.max(12, maxLeft);
      if (left < 12) left = 12;
      setPos({ top: r.bottom + gapPx, left, width: r.width });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef, gapPx]);

  return pos;
}
