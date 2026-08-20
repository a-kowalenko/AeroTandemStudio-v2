/**
 * Staggered photo-thumbnail queue (OPT-11 + EXIF-fast):
 * - LQ/HQ strip/grid may run during Auto-QR (cheap EXIF thumbs; HQ = larger EXIF resize).
 * - Heavy qualities (`preview`) stay paused while `qrScanBusy`.
 * - Optional short prefetch of the visible window before QR starts.
 */

import { getMediaThumbnail, thumbnailDisplayUrl, type ThumbQuality } from "./sdCard";
import { useQrScanStore } from "../store/qrScanStore";

export const PHOTO_THUMB_PRIORITY = {
  /** Emergency / explicit boost — runs even while QR is busy */
  active: 100,
  /** Strip/grid tile in (or near) viewport — LQ first paint */
  visible: 60,
  /** Visible-tile HQ upgrade after LQ (still EXIF-fast, below LQ) */
  hqUpgrade: 45,
  /** Main-stage preview upgrade (after strip visible; file src already shown) */
  stageUpgrade: 35,
  /** Background warm after import / after QR */
  warm: 30,
} as const;

export type PhotoThumbPriority =
  (typeof PHOTO_THUMB_PRIORITY)[keyof typeof PHOTO_THUMB_PRIORITY];

const CONCURRENCY = 4;
/** Leave headroom for QR JPEG decode while strip LQ/HQ runs in parallel. */
const CONCURRENCY_DURING_QR = 2;
const POST_IMPORT_DELAY_MS = 100;
const POST_QR_DELAY_MS = 0;
/** Visible / near-current tiles to warm (IO loads the rest). */
export const PHOTO_THUMB_WARM_WINDOW = 12;
/** Brief wait before Auto-QR so the strip can paint EXIF thumbs first. */
export const PHOTO_THUMB_PREFETCH_BEFORE_QR_MS = 250;
/** Delay before LQ→HQ upgrade on a settled visible tile (matches SD loader idea). */
export const PHOTO_THUMB_HQ_DELAY_MS = 350;

type Waiter = {
  resolve: (url: string) => void;
  reject: (reason: unknown) => void;
};

type QueueItem = {
  path: string;
  quality: ThumbQuality;
  cacheKey: string;
  priority: number;
  resolvers: Waiter[];
};

function memKey(path: string, quality: ThumbQuality, cacheKey: string): string {
  return `${quality}\0${path}\0${cacheKey}`;
}

function warmWindowPaths(paths: string[], firstPath?: string): string[] {
  if (paths.length === 0) return [];
  const lead = firstPath ?? paths[0]!;
  const leadIdx = Math.max(0, paths.indexOf(lead));
  return paths.slice(leadIdx, leadIdx + PHOTO_THUMB_WARM_WINDOW);
}

class PhotoThumbnailQueue {
  private pending = new Map<string, QueueItem>();
  private inFlight = new Set<string>();
  private inFlightWaiters = new Map<string, Waiter[]>();
  private cache = new Map<string, string>();
  private active = 0;
  /**
   * When true, only LQ (strip) and active-priority jobs may start.
   * Preview / other heavy qualities wait until QR ends.
   */
  private pausedForQr = false;
  private warmTimer: number | null = null;
  private resumeTimer: number | null = null;
  private delayedWarm: Array<{
    path: string;
    quality: ThumbQuality;
    priority: number;
    bustKey?: string | number | null;
  }> = [];
  private generation = 0;

  getCached(
    path: string,
    quality: ThumbQuality,
    bustKey?: string | number | null,
  ): string | null {
    return this.cache.get(memKey(path, quality, String(bustKey ?? ""))) ?? null;
  }

  /**
   * During QR: keep EXIF-fast LQ/HQ flowing; block heavy preview work.
   * On unpause: flush any deferred warm and pump preview upgrades.
   */
  setQrBusy(busy: boolean) {
    if (busy) {
      this.pausedForQr = true;
      if (this.resumeTimer != null) {
        window.clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
      }
      // LQ warm may run during QR — do not hold the window until scan ends.
      this.flushDelayedWarm();
      this.pump();
      return;
    }
    if (this.resumeTimer != null) {
      window.clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    const gen = this.generation;
    const resume = () => {
      if (gen !== this.generation) return;
      this.pausedForQr = false;
      this.flushDelayedWarm();
      this.pump();
    };
    if (POST_QR_DELAY_MS <= 0) {
      resume();
      return;
    }
    this.resumeTimer = window.setTimeout(() => {
      this.resumeTimer = null;
      resume();
    }, POST_QR_DELAY_MS);
  }

  /** Request thumb; dedupes in-flight work and serves memory cache. */
  request(
    path: string,
    quality: ThumbQuality,
    priority: number = PHOTO_THUMB_PRIORITY.visible,
    bustKey?: string | number | null,
  ): Promise<string> {
    const cacheKey = String(bustKey ?? "");
    const key = memKey(path, quality, cacheKey);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);

    if (this.inFlight.has(key)) {
      return new Promise((resolve, reject) => {
        const list = this.inFlightWaiters.get(key) ?? [];
        list.push({ resolve, reject });
        this.inFlightWaiters.set(key, list);
      });
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      return new Promise((resolve, reject) => {
        existing.resolvers.push({ resolve, reject });
      });
    }

    return new Promise((resolve, reject) => {
      this.pending.set(key, {
        path,
        quality,
        cacheKey,
        priority,
        resolvers: [{ resolve, reject }],
      });
      this.pump();
    });
  }

  /** Raise priority for a path already queued (e.g. scrolled into view). */
  boost(
    path: string,
    quality: ThumbQuality,
    priority: number = PHOTO_THUMB_PRIORITY.visible,
    bustKey?: string | number | null,
  ) {
    const key = memKey(path, quality, String(bustKey ?? ""));
    const item = this.pending.get(key);
    if (item) {
      item.priority = Math.max(item.priority, priority);
      this.pump();
      return;
    }
    if (!this.cache.has(key) && !this.inFlight.has(key)) {
      void this.request(path, quality, priority, bustKey).catch(() => undefined);
    }
  }

  /**
   * Enqueue LQ warm window after import. Flushes even during QR (LQ is allowed).
   */
  scheduleWarmAfterImport(paths: string[], firstPath?: string) {
    if (paths.length === 0) return;
    const lead = firstPath ?? paths[0]!;
    for (const path of warmWindowPaths(paths, firstPath)) {
      const priority =
        path === lead
          ? Math.max(PHOTO_THUMB_PRIORITY.visible, PHOTO_THUMB_PRIORITY.warm + 1)
          : PHOTO_THUMB_PRIORITY.warm;
      this.delayedWarm.push({
        path,
        quality: "lq",
        priority,
      });
    }
    if (this.warmTimer != null) {
      window.clearTimeout(this.warmTimer);
    }
    const gen = this.generation;
    this.warmTimer = window.setTimeout(() => {
      this.warmTimer = null;
      if (gen !== this.generation) return;
      this.flushDelayedWarm();
    }, POST_IMPORT_DELAY_MS);
  }

  /**
   * Kick the visible LQ window and wait up to `timeoutMs` (best-effort).
   * Used before Auto-QR so the strip can paint EXIF thumbs first.
   */
  prefetchWarmWindow(
    paths: string[],
    firstPath?: string,
    timeoutMs: number = PHOTO_THUMB_PREFETCH_BEFORE_QR_MS,
  ): Promise<void> {
    const windowPaths = warmWindowPaths(paths, firstPath);
    if (windowPaths.length === 0) return Promise.resolve();

    if (this.warmTimer != null) {
      window.clearTimeout(this.warmTimer);
      this.warmTimer = null;
    }
    // Drop delayed duplicates for the same window; we request immediately.
    this.delayedWarm = this.delayedWarm.filter(
      (d) => !windowPaths.some((p) => p === d.path && d.quality === "lq"),
    );

    const lead = firstPath ?? windowPaths[0]!;
    const jobs = windowPaths.map((path) => {
      const priority =
        path === lead
          ? PHOTO_THUMB_PRIORITY.visible
          : PHOTO_THUMB_PRIORITY.warm;
      return this.request(path, "lq", priority).catch(() => "");
    });

    if (timeoutMs <= 0) {
      void Promise.all(jobs);
      return Promise.resolve();
    }

    return Promise.race([
      Promise.all(jobs).then(() => undefined),
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, timeoutMs);
      }),
    ]);
  }

  private flushDelayedWarm() {
    if (this.delayedWarm.length === 0) return;
    const batch = this.delayedWarm.splice(0);
    for (const { path, quality, priority, bustKey } of batch) {
      void this.request(path, quality, priority, bustKey).catch(() => undefined);
    }
  }

  private canStart(item: QueueItem): boolean {
    if (!this.pausedForQr) return true;
    // EXIF-fast strip/grid thumbs may run alongside QR (LQ + HQ resize of embedded).
    if (item.quality === "lq" || item.quality === "hq") return true;
    return item.priority >= PHOTO_THUMB_PRIORITY.active;
  }

  private concurrencyLimit(): number {
    return this.pausedForQr ? CONCURRENCY_DURING_QR : CONCURRENCY;
  }

  private pump() {
    while (this.pending.size > 0 && this.active < this.concurrencyLimit()) {
      let bestKey: string | null = null;
      let best: QueueItem | null = null;
      for (const [k, item] of this.pending) {
        if (!this.canStart(item)) continue;
        if (!best || item.priority > best.priority) {
          best = item;
          bestKey = k;
        }
      }
      if (!best || !bestKey) break;
      this.pending.delete(bestKey);
      void this.runOne(bestKey, best);
    }
  }

  private async runOne(flightKey: string, item: QueueItem) {
    this.inFlight.add(flightKey);
    this.active += 1;
    const extra = this.inFlightWaiters.get(flightKey) ?? [];
    this.inFlightWaiters.delete(flightKey);
    try {
      const res = await getMediaThumbnail(item.path, item.quality);
      const displayUrl = thumbnailDisplayUrl(res);
      this.cache.set(flightKey, displayUrl);
      for (const w of item.resolvers) w.resolve(displayUrl);
      for (const w of extra) w.resolve(displayUrl);
    } catch (e) {
      for (const w of item.resolvers) w.reject(e);
      for (const w of extra) w.reject(e);
    } finally {
      this.inFlight.delete(flightKey);
      this.active -= 1;
      this.pump();
    }
  }
}

export const photoThumbnailQueue = new PhotoThumbnailQueue();

/** Heavy `preview` thumbs pause during QR; LQ/HQ EXIF strip continues. */
if (typeof window !== "undefined") {
  let wasBusy = useQrScanStore.getState().busy;
  photoThumbnailQueue.setQrBusy(wasBusy);
  useQrScanStore.subscribe((state) => {
    if (state.busy === wasBusy) return;
    wasBusy = state.busy;
    photoThumbnailQueue.setQrBusy(state.busy);
  });
}
