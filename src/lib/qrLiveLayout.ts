/** Place QR live thumbs: list start on the left, list end on the right. */

export type QrLiveLayoutItem = {
  key: string;
};

export type PlacedQrLive<T> = {
  item: T;
  /** 0-based index in `scanOrder`, or -1 when the path is not in the list. */
  index: number;
};

export type QrLiveLayout<T> = {
  start: PlacedQrLive<T>[];
  /** Original follow-up hit, centered between the two sides. */
  hit: PlacedQrLive<T> | null;
  end: PlacedQrLive<T>[];
  total: number;
};

function normalizeMediaKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Split live frames by media-list side.
 *
 * Without `anchorKey`, the cut is the middle of `scanOrder` (first half left,
 * second half right). With `anchorKey` (photo follow-up), neighbors before
 * that file stay left, the file itself is the center hit, neighbors after
 * stay right. Input order does not move a thumb between sides.
 */
export function placeQrLiveFrames<T extends QrLiveLayoutItem>(
  frames: readonly T[],
  scanOrder: readonly string[],
  anchorKey: string | null = null,
): QrLiveLayout<T> {
  const order = scanOrder.map(normalizeMediaKey);
  const indexOf = new Map<string, number>();
  order.forEach((key, index) => {
    if (!indexOf.has(key)) indexOf.set(key, index);
  });
  const total = order.length;

  const placed = frames.map((item) => ({
    item,
    index: indexOf.get(normalizeMediaKey(item.key)) ?? -1,
  }));

  const anchorIndex =
    anchorKey != null && anchorKey.trim()
      ? (indexOf.get(normalizeMediaKey(anchorKey)) ?? -1)
      : -1;

  if (anchorIndex >= 0) {
    const start: PlacedQrLive<T>[] = [];
    const end: PlacedQrLive<T>[] = [];
    let hit: PlacedQrLive<T> | null = null;
    for (const entry of placed) {
      if (entry.index === anchorIndex) {
        hit = entry;
      } else if (entry.index >= 0 && entry.index < anchorIndex) {
        start.push(entry);
      } else if (entry.index > anchorIndex) {
        end.push(entry);
      } else {
        start.push(entry);
      }
    }
    start.sort(byIndex);
    end.sort(byIndex);
    return { start, hit, end, total };
  }

  const mid = total / 2;
  const start: PlacedQrLive<T>[] = [];
  const end: PlacedQrLive<T>[] = [];
  for (const entry of placed) {
    if (entry.index >= 0 && entry.index >= mid) end.push(entry);
    else start.push(entry);
  }
  start.sort(byIndex);
  end.sort(byIndex);
  return { start, hit: null, end, total };
}

function byIndex<T>(a: PlacedQrLive<T>, b: PlacedQrLive<T>): number {
  if (a.index < 0 && b.index < 0) return 0;
  if (a.index < 0) return 1;
  if (b.index < 0) return -1;
  return a.index - b.index;
}

/** Video edge scan keeps at most two clips from each list end. */
export const VIDEO_LIVE_ALIGN_MAX = 4;

/** Small video batches: draw each live thumb in the column of its progress bar. */
export function alignVideoLiveThumbs(
  stage: string,
  segmentCount: number,
): boolean {
  return (
    stage === "scanning_videos" &&
    segmentCount > 0 &&
    segmentCount <= VIDEO_LIVE_ALIGN_MAX
  );
}
