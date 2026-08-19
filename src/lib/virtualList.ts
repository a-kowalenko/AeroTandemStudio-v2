/** Prefix offsets: `offsets[i]` = top edge of row `i`; length = `heights.length + 1`. */
export function buildOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i++) {
    offsets[i + 1] = offsets[i]! + heights[i]!;
  }
  return offsets;
}

/** Smallest row index whose bottom edge is below `scrollTop`. */
export function firstVisibleIndex(
  offsets: readonly number[],
  scrollTop: number,
): number {
  const lastRow = offsets.length - 2;
  if (lastRow < 0) return 0;
  let lo = 0;
  let hi = lastRow;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Largest row index whose top edge is above `scrollBottom`. */
export function lastVisibleIndex(
  offsets: readonly number[],
  scrollBottom: number,
): number {
  const lastRow = offsets.length - 2;
  if (lastRow < 0) return 0;
  let lo = 0;
  let hi = lastRow;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! < scrollBottom) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export type VirtualSlice = {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  totalHeight: number;
};

export function sliceVirtualRange(
  count: number,
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualSlice {
  const totalHeight = offsets[count] ?? 0;
  if (count === 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 };
  }

  const first = firstVisibleIndex(offsets, scrollTop);
  const last = lastVisibleIndex(offsets, scrollTop + viewportHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, last + 1 + overscan);
  const padTop = offsets[start] ?? 0;
  const padBottom = totalHeight - (offsets[end] ?? totalHeight);

  return { start, end, padTop, padBottom, totalHeight };
}
