/** Concurrent LQ→HQ thumbnail loader with memory cache and batched React updates. */

import { getMediaThumbnail, thumbnailDisplayUrl, type ThumbQuality } from "./sdCard";

export type ThumbQualityLevel = ThumbQuality;

export type ThumbState = {
  url: string;
  quality: ThumbQualityLevel;
};

type QueueItem = {
  path: string;
  quality: ThumbQualityLevel;
  /** Higher = sooner (visible tiles). */
  priority: number;
  retries: number;
};

const CONCURRENCY = 3;
const ICA_CONCURRENCY = 1;
const HQ_DELAY_MS = 450;
const FLUSH_MS = 80;
/** MTP retry backoff: 400, 800, 1600, 3200 ms (device busy / session warming up). */
const ICA_RETRY_BASE_MS = 400;
const ICA_MAX_RETRIES = 4;

function isMtpVirtualPath(path: string): boolean {
  return (
    path.includes("aero_tandem_ica") || path.includes("aero_tandem_mtp")
  );
}

/** Process-wide memory cache (survives dialog close). */
const memoryCache = new Map<string, ThumbState>();

function cacheKey(path: string, quality: ThumbQualityLevel): string {
  return `${quality}:${path}`;
}

function bestCached(path: string): ThumbState | undefined {
  return memoryCache.get(cacheKey(path, "hq")) ?? memoryCache.get(cacheKey(path, "lq"));
}

/** Loaders with mounted tiles — notified when cached thumbs are dropped. */
const activeLoaders = new Set<SdThumbnailLoader>();

/** Drop cached thumbs whose path matches; mounted tiles fall back to the placeholder. */
export function forgetThumbs(match: (path: string) => boolean): void {
  const paths = new Set<string>();
  for (const key of [...memoryCache.keys()]) {
    const path = key.slice(key.indexOf(":") + 1);
    if (!match(path)) continue;
    memoryCache.delete(key);
    paths.add(path);
  }
  if (paths.size === 0) return;
  for (const loader of activeLoaders) loader.handleForgotten(paths);
}

/**
 * Unplug / eject wipes the backend MTP cache dir (`.thumbs`); replug reuses the
 * same virtual paths, so cached URLs would point at deleted files.
 */
export function forgetMtpSourceThumbs(sourceId: string): void {
  const safe = sourceId.replace(/[^A-Za-z0-9_-]/g, "_");
  forgetThumbs(
    (path) => isMtpVirtualPath(path) && path.split(/[\\/]/).includes(safe),
  );
}

/** Reloads per path after an `<img>` error before giving up (corrupt cache file). */
const MAX_BROKEN_RELOADS = 2;

type Listener = (batch: Map<string, ThumbState>) => void;

/**
 * Shared loader: IntersectionObserver feeds priorities; a small pool fetches
 * LQ first, then HQ once the tile stays visible.
 */
export class SdThumbnailLoader {
  private pending = new Map<string, QueueItem>();
  private inFlight = new Set<string>();
  private visible = new Set<string>();
  private hqTimers = new Map<string, number>();
  private flushBuffer = new Map<string, ThumbState>();
  private flushTimer: number | null = null;
  private active = 0;
  private stopped = false;
  private listener: Listener | null = null;
  private pathListeners = new Map<string, Set<() => void>>();
  private brokenReloads = new Map<string, number>();
  private generation = 0;

  setListener(fn: Listener | null) {
    this.listener = fn;
  }

  /** Per-path subscription for `useSyncExternalStore` (avoids parent thumb state). */
  subscribe(path: string, onStoreChange: () => void): () => void {
    let set = this.pathListeners.get(path);
    if (!set) {
      set = new Set();
      this.pathListeners.set(path, set);
    }
    set.add(onStoreChange);
    activeLoaders.add(this);
    return () => {
      set!.delete(onStoreChange);
      if (set!.size === 0) this.pathListeners.delete(path);
      if (this.pathListeners.size === 0) activeLoaders.delete(this);
    };
  }

  /** Displayed thumb failed to load (file gone / corrupt): drop it and refetch. */
  invalidate(path: string) {
    const n = this.brokenReloads.get(path) ?? 0;
    this.brokenReloads.set(path, n + 1);
    forgetThumbs((p) => p === path);
    if (n >= MAX_BROKEN_RELOADS) return;
    if (this.stopped || !this.visible.has(path)) return;
    this.enqueue(path, isMtpVirtualPath(path) ? "hq" : "lq", 10);
    this.pump();
  }

  /** Called by {@link forgetThumbs}: clear buffered results and repaint tiles. */
  handleForgotten(paths: Set<string>) {
    for (const path of paths) {
      this.flushBuffer.delete(path);
      const subs = this.pathListeners.get(path);
      if (!subs) continue;
      for (const cb of subs) cb();
    }
  }

  getBest(path: string): ThumbState | undefined {
    return bestCached(path);
  }

  /** Snapshot of best-known thumbs for initial React state. */
  snapshotFor(paths: string[]): Record<string, ThumbState> {
    const out: Record<string, ThumbState> = {};
    for (const p of paths) {
      const hit = bestCached(p);
      if (hit) out[p] = hit;
    }
    return out;
  }

  start() {
    this.stopped = false;
    this.brokenReloads.clear();
  }

  stop() {
    this.stopped = true;
    this.pending.clear();
    this.generation += 1;
    for (const t of this.hqTimers.values()) window.clearTimeout(t);
    this.hqTimers.clear();
    this.visible.clear();
    if (this.flushTimer != null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Flush any completed thumbs so a mid-flight cancel still paints what we have.
    this.flush();
  }

  /**
   * Mark a path as in/out of viewport. When `upgradeToHq` is false (details rows),
   * only LQ is requested — enough for small list thumbs and cheaper while scrolling.
   */
  setVisible(
    path: string,
    visible: boolean,
    opts?: { upgradeToHq?: boolean },
  ) {
    if (this.stopped) return;
    const upgradeToHq = opts?.upgradeToHq !== false;
    if (visible) {
      this.visible.add(path);
      // MTP: one device round-trip per tile — fetch the camera thumb once at HQ.
      if (isMtpVirtualPath(path)) {
        this.enqueue(path, "hq", 10);
      } else {
        this.enqueue(path, "lq", 10);
        if (upgradeToHq) this.scheduleHq(path);
      }
    } else {
      this.visible.delete(path);
      const t = this.hqTimers.get(path);
      if (t != null) {
        window.clearTimeout(t);
        this.hqTimers.delete(path);
      }
      // Drop pending HQ for offscreen tiles; keep LQ pending if already queued at low prio.
      const hqKey = flightKey(path, "hq");
      this.pending.delete(hqKey);
    }
    this.pump();
  }

  /** Clear viewport tracking (e.g. when switching thumbnail ↔ details). */
  releaseAllVisible() {
    for (const path of [...this.visible]) {
      this.setVisible(path, false);
    }
  }

  private scheduleHq(path: string) {
    if (this.hqTimers.has(path)) return;
    const gen = this.generation;
    const timer = window.setTimeout(() => {
      this.hqTimers.delete(path);
      if (this.stopped || gen !== this.generation) return;
      if (!this.visible.has(path)) return;
      const existing = bestCached(path);
      if (existing?.quality === "hq") return;
      this.enqueue(path, "hq", 5);
      this.pump();
    }, HQ_DELAY_MS);
    this.hqTimers.set(path, timer);
  }

  private enqueue(path: string, quality: ThumbQualityLevel, priority: number) {
    const key = flightKey(path, quality);
    if (quality === "lq") {
      const best = bestCached(path);
      if (best) {
        this.publish(path, best);
        return;
      }
    } else if (memoryCache.has(cacheKey(path, "hq"))) {
      this.publish(path, memoryCache.get(cacheKey(path, "hq"))!);
      return;
    }
    if (this.inFlight.has(key)) return;
    const prev = this.pending.get(key);
    if (prev) {
      prev.priority = Math.max(prev.priority, priority);
      return;
    }
    this.pending.set(key, { path, quality, priority, retries: 0 });
  }

  private pump() {
    while (this.pending.size > 0 && !this.stopped) {
      let bestKey: string | null = null;
      let best: QueueItem | null = null;
      for (const [k, item] of this.pending) {
        if (!best || item.priority > best.priority) {
          best = item;
          bestKey = k;
        }
      }
      if (!best || !bestKey) break;
      const ica = isMtpVirtualPath(best.path);
      const limit = ica ? ICA_CONCURRENCY : CONCURRENCY;
      if (this.active >= limit) break;
      this.pending.delete(bestKey);
      // Skip HQ if tile left viewport
      if (best.quality === "hq" && !this.visible.has(best.path)) continue;
      void this.runOne(best);
    }
  }

  private async runOne(item: QueueItem) {
    const key = flightKey(item.path, item.quality);
    this.inFlight.add(key);
    this.active += 1;
    const gen = this.generation;
    try {
      const res = await getMediaThumbnail(item.path, item.quality);
      if (this.stopped || gen !== this.generation) return;
      const state: ThumbState = {
        url: thumbnailDisplayUrl(res),
        quality: item.quality,
      };
      memoryCache.set(cacheKey(item.path, item.quality), state);
      // Don't downgrade displayed HQ with a late LQ response.
      const current = bestCached(item.path);
      if (current?.quality === "hq" && item.quality === "lq") {
        this.publish(item.path, current);
      } else {
        this.publish(item.path, state);
      }
    } catch {
      // Missing SD/MTP thumbs are expected (icons stay); retry while the
      // catalog session / WPD device is still coming up.
      if (
        isMtpVirtualPath(item.path) &&
        item.retries < ICA_MAX_RETRIES &&
        !this.stopped &&
        gen === this.generation
      ) {
        window.setTimeout(() => {
          if (this.stopped || gen !== this.generation) return;
          if (!this.visible.has(item.path)) return;
          const key = flightKey(item.path, item.quality);
          if (this.inFlight.has(key) || this.pending.has(key)) return;
          this.pending.set(key, {
            ...item,
            retries: item.retries + 1,
            priority: Math.max(1, item.priority - 1),
          });
          this.pump();
        }, ICA_RETRY_BASE_MS * 2 ** item.retries);
      }
    } finally {
      this.inFlight.delete(key);
      this.active -= 1;
      this.pump();
    }
  }

  private publish(path: string, state: ThumbState) {
    const existing = this.flushBuffer.get(path);
    if (existing?.quality === "hq" && state.quality === "lq") return;
    this.flushBuffer.set(path, state);
    if (this.flushTimer == null) {
      this.flushTimer = window.setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  private flush() {
    this.flushTimer = null;
    if (this.flushBuffer.size === 0) return;
    const batch = new Map(this.flushBuffer);
    this.flushBuffer.clear();
    this.listener?.(batch);
    for (const path of batch.keys()) {
      const subs = this.pathListeners.get(path);
      if (!subs) continue;
      for (const cb of subs) cb();
    }
  }
}

function flightKey(path: string, quality: ThumbQualityLevel): string {
  return `${quality}:${path}`;
}

export function createSdThumbnailLoader(): SdThumbnailLoader {
  return new SdThumbnailLoader();
}
