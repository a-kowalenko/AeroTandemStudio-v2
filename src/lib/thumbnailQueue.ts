/** Staggered preview-thumbnail queue (OPT-10): max 2 concurrent FFmpeg poster jobs. */

import { videoEdgeScanPaths } from "@/store/qrScanStore";
import {
  getCachedMediaThumbnail,
  getMediaThumbnail,
  thumbnailDisplayUrl,
  type ThumbQuality,
} from "./sdCard";

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

/** First and last clip. Stays above `active` so a later request cannot cut in. */
const QR_EDGE_OUTER = THUMB_PRIORITY.active + 20;
/** Second and penultimate clip. Runs only after the outer pair has finished. */
const QR_EDGE_INNER = THUMB_PRIORITY.active + 10;

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

function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Poster priority inside one edge list (list order).
 * Rank 0 is the outer pair: first and last. Rank 1 is second and penultimate.
 */
export function qrEdgeThumbPriority(index: number, count: number): number {
  if (index < 0 || count <= 0) return THUMB_PRIORITY.active;
  const rank = Math.min(index, count - 1 - index);
  return THUMB_PRIORITY.active + 20 - rank * 10;
}

export function qrEdgeThumbPriorityForPath(
  path: string,
  ordered: readonly string[],
): number {
  const key = pathKey(path);
  const index = ordered.findIndex((item) => pathKey(item) === key);
  return qrEdgeThumbPriority(index, ordered.length);
}

function pathFromMemKey(key: string): string {
  return key.split("\0")[1] ?? "";
}

function fileBase(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** Same illegal-character fold as the working-copy filename. */
function safePosterName(pathOrName: string): string {
  const base =
    pathOrName.includes("/") || pathOrName.includes("\\")
      ? fileBase(pathOrName)
      : pathOrName;
  return base.replace(/[<>:"/\\|?*]/g, "_").toLowerCase();
}

type NaturalPart = string | number;

function naturalSortKey(text: string): NaturalPart[] {
  const key: NaturalPart[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c >= "0" && c <= "9") {
      let num = "";
      while (i < text.length && text[i]! >= "0" && text[i]! <= "9") {
        num += text[i];
        i += 1;
      }
      key.push(Number(num));
    } else {
      let s = "";
      while (i < text.length && (text[i]! < "0" || text[i]! > "9")) {
        s += text[i];
        i += 1;
      }
      key.push(s.toLowerCase());
    }
  }
  return key;
}

function compareNatural(a: string, b: string): number {
  const ka = naturalSortKey(a);
  const kb = naturalSortKey(b);
  const n = Math.max(ka.length, kb.length);
  for (let i = 0; i < n; i += 1) {
    const pa = ka[i];
    const pb = kb[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (typeof pa === "number" && typeof pb === "number") {
      if (pa !== pb) return pa - pb;
    } else if (typeof pa === "string" && typeof pb === "string") {
      if (pa !== pb) return pa < pb ? -1 : 1;
    } else {
      return typeof pa === "number" ? -1 : 1;
    }
  }
  return 0;
}

function sortPathsByBasename(paths: string[]): string[] {
  return [...paths].sort((a, b) => compareNatural(fileBase(a), fileBase(b)));
}

function preloadPoster(url: string): Promise<void> {
  if (typeof Image === "undefined" || !url) return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

type PosterAdopt = {
  fromPath: string;
  toPath: string;
  toKey: string;
};

class PreviewThumbnailQueue {
  private pending = new Map<string, QueueItem>();
  private inFlight = new Set<string>();
  private inFlightWaiters = new Map<string, Waiter[]>();
  private cache = new Map<string, string>();
  private active = 0;
  private listeners = new Set<() => void>();
  private delayTimer: number | null = null;
  private delayedWarm: Array<{
    path: string;
    bustKey: string;
    priority: number;
  }> = [];
  private generation = 0;
  /** safe filename → source paths whose poster was started early. */
  private byName = new Map<string, string[]>();
  /** Copy a finished poster onto the working-copy cache key. */
  private adopts: PosterAdopt[] = [];
  /** Edge-clip priority, keyed by normalized path. */
  private primedPriority = new Map<string, number>();
  private inFlightPriority = new Map<string, number>();
  private pumpScheduled = false;

  getCached(
    path: string,
    bustKey?: string | number | null,
    quality: ThumbQuality = "preview",
  ): string | null {
    return this.cache.get(memKey(path, String(bustKey ?? ""), quality)) ?? null;
  }

  /** Fires after a poster URL is stored. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Start posters for the clips the QR panel will show.
   * Call this before the import copy so the frames are decoded when the panel opens.
   */
  primeImmediate(paths: string[]) {
    paths.forEach((path, index) => {
      if (!path) return;
      const priority = qrEdgeThumbPriority(index, paths.length);
      this.primedPriority.set(pathKey(path), priority);
      const name = safePosterName(path);
      const existing = this.byName.get(name) ?? [];
      const prior = existing.find((p) => p !== path);
      if (
        prior &&
        (this.byPathUrl(prior) || this.flightKeyForPath(prior, "preview"))
      ) {
        return;
      }
      if (!existing.includes(path)) {
        this.byName.set(name, [...existing, path]);
      }
      void this.request(path, priority, "").catch(() => undefined);
    });
  }

  /**
   * Point the working-copy clip at a poster started from the source file.
   * Does not wait. A still-running extract is copied onto `bust` when it finishes.
   */
  bindImportedPoster(destPath: string, bust: string, fileName: string) {
    const quality: ThumbQuality = "preview";
    const key = memKey(destPath, bust, quality);
    if (this.cache.has(key)) return;

    const source = this.matchPrimed(fileName, destPath);
    if (source) {
      const url = this.byPathUrl(source);
      if (url) {
        this.remember(key, destPath, url);
        this.notify();
        return;
      }
      if (this.flightKeyForPath(source, quality)) {
        this.adopts.push({ fromPath: source, toPath: destPath, toKey: key });
        return;
      }
    }
    const priority = source
      ? (this.primedPriority.get(pathKey(source)) ?? THUMB_PRIORITY.active)
      : (this.primedPriority.get(pathKey(destPath)) ?? THUMB_PRIORITY.active);
    this.primedPriority.set(pathKey(destPath), priority);
    void this.request(destPath, priority, bust).catch(() => undefined);
  }

  /**
   * Poster already in memory, already queued, or already on disk.
   * Does not start a new FFmpeg job.
   */
  async attachExisting(
    path: string,
    bustKey?: string | number | null,
    quality: ThumbQuality = "preview",
  ): Promise<string | null> {
    const key = memKey(path, String(bustKey ?? ""), quality);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const joined = this.joinExisting(key);
    if (joined) {
      try {
        const url = await joined;
        return url || this.cache.get(key) || null;
      } catch {
        return this.cache.get(key) ?? null;
      }
    }

    try {
      const res = await getCachedMediaThumbnail(path, quality);
      if (!res) return this.cache.get(key) ?? null;
      const displayUrl = thumbnailDisplayUrl(res);
      if (!displayUrl) return this.cache.get(key) ?? null;
      if (!this.cache.has(key)) {
        this.cache.set(key, displayUrl);
        this.notify();
      }
      return this.cache.get(key) ?? displayUrl;
    } catch {
      return this.cache.get(key) ?? null;
    }
  }

  private joinExisting(key: string): Promise<string> | null {
    if (this.inFlight.has(key)) {
      return new Promise((resolve, reject) => {
        const list = this.inFlightWaiters.get(key) ?? [];
        list.push({ resolve, reject });
        this.inFlightWaiters.set(key, list);
      });
    }
    const existing = this.pending.get(key);
    if (!existing) return null;
    return new Promise((resolve, reject) => {
      existing.resolvers.push({ resolve, reject });
    });
  }

  private byPath = new Map<string, string>();

  private byPathUrl(path: string): string | null {
    return this.byPath.get(path) ?? null;
  }

  private flightKeyForPath(path: string, quality: ThumbQuality): string | null {
    const prefix = `${quality}\0${path}\0`;
    for (const key of this.inFlight) {
      if (key.startsWith(prefix)) return key;
    }
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) return key;
    }
    return null;
  }

  private remember(key: string, path: string, url: string) {
    this.cache.set(key, url);
    this.byPath.set(path, url);
  }

  private matchPrimed(fileName: string, destPath: string): string | null {
    const want = safePosterName(fileName || destPath);
    const list = this.byName.get(want) ?? [];
    const same = list.find(
      (p) => p.replace(/\\/g, "/").toLowerCase() === destPath.replace(/\\/g, "/").toLowerCase(),
    );
    if (same) return same;
    if (list.length === 1) return list[0]!;
    const stem = want.replace(/_(\d+)(\.[^.]+)$/, "$2");
    if (stem !== want) {
      const stems = this.byName.get(stem) ?? [];
      if (stems.length === 1) return stems[0]!;
    }
    return null;
  }

  private flushAdopts(path: string, url: string) {
    const keep: PosterAdopt[] = [];
    for (const adopt of this.adopts) {
      if (adopt.fromPath === path) this.remember(adopt.toKey, adopt.toPath, url);
      else keep.push(adopt);
    }
    this.adopts = keep;
  }

  private failAdopts(path: string) {
    const dropped = this.adopts.filter((a) => a.fromPath === path);
    this.adopts = this.adopts.filter((a) => a.fromPath !== path);
    for (const adopt of dropped) {
      if (adopt.toPath === path) continue;
      const bust = adopt.toKey.split("\0")[2] ?? "";
      const priority =
        this.primedPriority.get(pathKey(adopt.fromPath)) ??
        this.primedPriority.get(pathKey(adopt.toPath)) ??
        THUMB_PRIORITY.active;
      void this.request(adopt.toPath, priority, bust).catch(() => undefined);
    }
  }

  private joinFlight(key: string): Promise<string> | null {
    const joined = this.joinExisting(key);
    if (joined) return joined;
    const path = pathFromMemKey(key);
    const url = this.byPath.get(path);
    return url ? Promise.resolve(url) : null;
  }

  private notify() {
    for (const listener of this.listeners) listener();
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

    // Same file, different bust (import prime uses ""). Join that extract.
    const other = this.flightKeyForPath(path, quality);
    if (other && other !== key) {
      this.adopts.push({ fromPath: path, toPath: path, toKey: key });
      const joined = this.joinFlight(other);
      if (joined) {
        return joined.then((url) => {
          this.adopts = this.adopts.filter((a) => a.toKey !== key);
          this.remember(key, path, url);
          return url;
        });
      }
    }

    const adopt = this.adopts.find((a) => a.toKey === key);
    if (adopt) {
      const fromKey = this.flightKeyForPath(adopt.fromPath, quality);
      const joined = fromKey ? this.joinFlight(fromKey) : null;
      if (joined) {
        return joined.then((url) => this.cache.get(key) ?? url);
      }
      const ready = this.byPath.get(adopt.fromPath);
      if (ready) {
        this.remember(key, path, ready);
        this.notify();
        return Promise.resolve(ready);
      }
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
      // Let every request in this turn land before a slot is taken,
      // so first+last are both queued ahead of second+penultimate.
      this.pumpSoon();
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

  private pumpSoon() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    const kick = () => {
      this.pumpScheduled = false;
      this.pump();
    };
    if (typeof queueMicrotask === "function") queueMicrotask(kick);
    else void Promise.resolve().then(kick);
  }

  /** Inner edge clips wait until both outer clips have left the queue. */
  private outerEdgeStillGoing(): boolean {
    for (const priority of this.inFlightPriority.values()) {
      if (priority >= QR_EDGE_OUTER) return true;
    }
    for (const item of this.pending.values()) {
      if (!item.background && item.priority >= QR_EDGE_OUTER) return true;
    }
    return false;
  }

  private pump() {
    while (this.active < CONCURRENCY) {
      const foreground = this.pickBest(false);
      if (foreground) {
        const [key, item] = foreground;
        if (item.priority <= QR_EDGE_INNER && this.outerEdgeStillGoing()) break;
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
    this.inFlightPriority.set(flightKey, item.priority);
    this.active += 1;
    try {
      const res = await getMediaThumbnail(item.path, item.quality);
      const displayUrl = thumbnailDisplayUrl(res);
      if (displayUrl) await preloadPoster(displayUrl);
      this.remember(flightKey, item.path, displayUrl);
      this.flushAdopts(item.path, displayUrl);
      this.notify();
      // Drain waiters that joined while FFmpeg was running (e.g. strip + player).
      const waiters = [
        ...item.resolvers,
        ...(this.inFlightWaiters.get(flightKey) ?? []),
      ];
      this.inFlightWaiters.delete(flightKey);
      for (const w of waiters) w.resolve(displayUrl);
    } catch (e) {
      this.failAdopts(item.path);
      const waiters = [
        ...item.resolvers,
        ...(this.inFlightWaiters.get(flightKey) ?? []),
      ];
      this.inFlightWaiters.delete(flightKey);
      for (const w of waiters) w.reject(e);
    } finally {
      this.inFlight.delete(flightKey);
      this.inFlightPriority.delete(flightKey);
      this.active -= 1;
      this.pump();
    }
  }
}

export const previewThumbnailQueue = new PreviewThumbnailQueue();

/**
 * Posters for the clips the video QR panel shows (head + tail).
 * First and last start together; second and penultimate follow.
 */
export function primeQrEdgePosters(paths: string[]) {
  const cleaned = paths.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) return;
  const edge = videoEdgeScanPaths(sortPathsByBasename(cleaned)).paths;
  previewThumbnailQueue.primeImmediate(edge);
}
