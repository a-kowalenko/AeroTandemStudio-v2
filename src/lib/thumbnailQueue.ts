/** Staggered preview-thumbnail queue (OPT-10): max 2 concurrent FFmpeg poster jobs. */

import { getMediaThumbnail, thumbnailDisplayUrl, type ThumbQuality } from "./sdCard";

export const THUMB_PRIORITY = {
  /** Active clip in player — jump the queue */
  active: 100,
  /** On-demand from VideoPlayer */
  onDemand: 60,
  /** First clip after import */
  first: 80,
  /** Background warm after import */
  warm: 30,
} as const;

export type ThumbPriority = (typeof THUMB_PRIORITY)[keyof typeof THUMB_PRIORITY];

const CONCURRENCY = 2;
const POST_IMPORT_DELAY_MS = 500;

type Waiter = {
  resolve: (url: string) => void;
  reject: (reason: unknown) => void;
};

type QueueItem = {
  path: string;
  cacheKey: string;
  quality: ThumbQuality;
  /** Tile warm-ups: at most one, and only while no foreground poster is running. */
  background: boolean;
  priority: number;
  resolvers: Waiter[];
};

function memKey(path: string, cacheKey: string, quality: ThumbQuality): string {
  return `${quality}\0${path}\0${cacheKey}`;
}

class PreviewThumbnailQueue {
  private pending = new Map<string, QueueItem>();
  private inFlight = new Set<string>();
  private inFlightWaiters = new Map<string, Waiter[]>();
  private cache = new Map<string, string>();
  private active = 0;
  private delayTimer: number | null = null;
  private delayedWarm: Array<{
    path: string;
    bustKey: string;
    priority: number;
  }> = [];
  private generation = 0;

  getCached(
    path: string,
    bustKey?: string | number | null,
    quality: ThumbQuality = "preview",
  ): string | null {
    return this.cache.get(memKey(path, String(bustKey ?? ""), quality)) ?? null;
  }

  /**
   * Request a thumb; dedupes in-flight work and serves memory cache.
   * `background` jobs stay serialized and wait until foreground posters finish,
   * so opening a viewer does not run a tile extract next to playback.
   */
  request(
    path: string,
    priority: number = THUMB_PRIORITY.onDemand,
    bustKey?: string | number | null,
    quality: ThumbQuality = "preview",
    opts?: { background?: boolean },
  ): Promise<string> {
    const cacheKey = String(bustKey ?? "");
    const background = opts?.background === true;
    const key = memKey(path, cacheKey, quality);
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
      if (!background) existing.background = false;
      return new Promise((resolve, reject) => {
        existing.resolvers.push({ resolve, reject });
      });
    }

    return new Promise((resolve, reject) => {
      this.pending.set(key, {
        path,
        cacheKey,
        quality,
        background,
        priority,
        resolvers: [{ resolve, reject }],
      });
      this.pump();
    });
  }

  /** Raise priority for a path already queued or not yet warmed. */
  boost(path: string, bustKey?: string | number | null, quality: ThumbQuality = "preview") {
    const key = memKey(path, String(bustKey ?? ""), quality);
    const item = this.pending.get(key);
    if (item) {
      item.priority = Math.max(item.priority, THUMB_PRIORITY.active);
      item.background = false;
      this.pump();
      return;
    }
    if (!this.cache.has(key) && !this.inFlight.has(key)) {
      void this.request(path, THUMB_PRIORITY.active, bustKey, quality).catch(
        () => undefined,
      );
    }
  }

  /**
   * Enqueue background warming after import ends.
   * `firstPath` (or first entry) gets higher priority; starts after a short delay.
   * Pass `bustKey` so warm hits match VideoPlayer / strip cache keys.
   */
  scheduleWarmAfterImport(
    paths: string[],
    firstPath?: string,
    bustKeyFor?: (path: string) => string | number | null | undefined,
  ) {
    if (paths.length === 0) return;
    const lead = firstPath ?? paths[0]!;
    for (const path of paths) {
      const priority =
        path === lead ? THUMB_PRIORITY.first : THUMB_PRIORITY.warm;
      this.delayedWarm.push({
        path,
        bustKey: String(bustKeyFor?.(path) ?? ""),
        priority,
      });
    }
    if (this.delayTimer != null) {
      window.clearTimeout(this.delayTimer);
    }
    const gen = this.generation;
    this.delayTimer = window.setTimeout(() => {
      this.delayTimer = null;
      if (gen !== this.generation) return;
      const batch = this.delayedWarm.splice(0);
      for (const { path, bustKey, priority } of batch) {
        void this.request(path, priority, bustKey).catch(() => undefined);
      }
    }, POST_IMPORT_DELAY_MS);
  }

  private pickBest(background: boolean): [string, QueueItem] | null {
    let bestKey: string | null = null;
    let best: QueueItem | null = null;
    for (const [k, item] of this.pending) {
      if (item.background !== background) continue;
      if (!best || item.priority > best.priority) {
        best = item;
        bestKey = k;
      }
    }
    if (!best || !bestKey) return null;
    return [bestKey, best];
  }

  private pump() {
    while (this.active < CONCURRENCY) {
      const foreground = this.pickBest(false);
      if (foreground) {
        const [key, item] = foreground;
        this.pending.delete(key);
        void this.runOne(key, item);
        continue;
      }
      // One background extract at a time, and never beside a foreground poster.
      if (this.active >= 1) break;
      const background = this.pickBest(true);
      if (!background) break;
      const [key, item] = background;
      this.pending.delete(key);
      void this.runOne(key, item);
    }
  }

  private async runOne(flightKey: string, item: QueueItem) {
    this.inFlight.add(flightKey);
    this.active += 1;
    try {
      const res = await getMediaThumbnail(item.path, item.quality);
      const displayUrl = thumbnailDisplayUrl(res);
      this.cache.set(flightKey, displayUrl);
      // Drain waiters that joined while FFmpeg was running (e.g. strip + player).
      const waiters = [
        ...item.resolvers,
        ...(this.inFlightWaiters.get(flightKey) ?? []),
      ];
      this.inFlightWaiters.delete(flightKey);
      for (const w of waiters) w.resolve(displayUrl);
    } catch (e) {
      const waiters = [
        ...item.resolvers,
        ...(this.inFlightWaiters.get(flightKey) ?? []),
      ];
      this.inFlightWaiters.delete(flightKey);
      for (const w of waiters) w.reject(e);
    } finally {
      this.inFlight.delete(flightKey);
      this.active -= 1;
      this.pump();
    }
  }
}

export const previewThumbnailQueue = new PreviewThumbnailQueue();
