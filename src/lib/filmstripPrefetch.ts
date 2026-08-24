/** Filmstrip + keyframe prefetch for VideoCutter (OPT-7). */

import { getVideoFilmstrip, listVideoKeyframes } from "./tauri";

export const FILMSTRIP_FRAME_COUNT = 14;
export const FILMSTRIP_FRAME_HEIGHT = 56;
export const PREFETCH_DEBOUNCE_MS = 450;

export type FilmstripPrefetchResult = {
  frames: string[];
  keyframesSecs: number[];
};

/** Incremental update while filmstrip / keyframes load independently. */
export type FilmstripPrefetchPartial = {
  frames?: string[];
  keyframesSecs?: number[];
};

export type FilmstripPrefetchClip = {
  path: string;
  durationSecs: number | null;
  revision: number;
};

type CacheEntry = {
  frames: string[] | null;
  keyframesSecs: number[] | null;
};

function memKey(path: string, revision: number): string {
  return `${path}\0${revision}`;
}

function isComplete(entry: CacheEntry): entry is FilmstripPrefetchResult {
  return entry.frames != null && entry.keyframesSecs != null;
}

function toResult(entry: CacheEntry): FilmstripPrefetchResult | null {
  if (!isComplete(entry)) return null;
  return { frames: entry.frames, keyframesSecs: entry.keyframesSecs };
}

const CONCURRENCY = 1;

type PendingItem = FilmstripPrefetchClip & { priority: number; force: boolean };

type Waiter = {
  resolve: (value: FilmstripPrefetchResult) => void;
  reject: (reason: unknown) => void;
};

type PartialListener = (partial: FilmstripPrefetchPartial) => void;

class FilmstripPrefetchQueue {
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, PendingItem>();
  private inFlight = new Set<string>();
  private waiters = new Map<string, Waiter[]>();
  private partialListeners = new Map<string, PartialListener[]>();
  private active = 0;
  private paused = false;
  private debounceTimer: number | null = null;
  private scheduled: Array<FilmstripPrefetchClip & { priority: number }> = [];
  private generation = 0;

  /** Full cache hit only (both filmstrip + keyframes). */
  getCached(path: string, revision: number): FilmstripPrefetchResult | null {
    const entry = this.cache.get(memKey(path, revision));
    return entry ? toResult(entry) : null;
  }

  /** Partial or full cache (either side may still be null). */
  getPartial(path: string, revision: number): CacheEntry | null {
    return this.cache.get(memKey(path, revision)) ?? null;
  }

  isComplete(path: string, revision: number): boolean {
    const entry = this.cache.get(memKey(path, revision));
    return entry != null && isComplete(entry);
  }

  /** Block background prefetch during import/encode/QR (workflow busy). */
  setPaused(paused: boolean) {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!paused) {
      this.pump();
      return;
    }
    this.generation += 1;
    if (this.debounceTimer != null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.scheduled = [];
    for (const [key, item] of this.pending) {
      if (item.force) continue;
      this.pending.delete(key);
      this.rejectWaiters(key, new Error("filmstrip prefetch paused"));
    }
  }

  /**
   * Prefetch the active clip immediately; debounce only the next neighbor.
   */
  schedule(clips: FilmstripPrefetchClip[], debounceMs = PREFETCH_DEBOUNCE_MS) {
    if (this.paused || clips.length === 0) return;
    const [active, next] = clips.slice(0, 2);
    this.enqueue(active.path, active.durationSecs, active.revision, 100, undefined, undefined, false);
    if (!next) {
      if (this.debounceTimer != null) {
        window.clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.scheduled = [];
      return;
    }
    this.scheduled = [{ ...next, priority: 60 }];
    if (this.debounceTimer != null) {
      window.clearTimeout(this.debounceTimer);
    }
    const gen = this.generation;
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      if (gen !== this.generation || this.paused) return;
      const batch = this.scheduled.splice(0);
      for (const item of batch) {
        this.enqueue(
          item.path,
          item.durationSecs,
          item.revision,
          item.priority,
          undefined,
          undefined,
          false,
        );
      }
    }, debounceMs);
  }

  /**
   * Immediate prefetch (cutter open on cache miss).
   * `onPartial` fires as soon as filmstrip or keyframes arrive (progressive UI).
   */
  prefetch(
    path: string,
    durationSecs: number | null,
    revision: number,
    priority = 90,
    onPartial?: PartialListener,
  ): Promise<FilmstripPrefetchResult> {
    const key = memKey(path, revision);
    const hit = toResult(this.cache.get(key) ?? { frames: null, keyframesSecs: null });
    if (hit) {
      onPartial?.({ frames: hit.frames, keyframesSecs: hit.keyframesSecs });
      return Promise.resolve(hit);
    }

    const partial = this.cache.get(key);
    if (partial) {
      if (partial.frames) onPartial?.({ frames: partial.frames });
      if (partial.keyframesSecs) onPartial?.({ keyframesSecs: partial.keyframesSecs });
    }

    return new Promise((resolve, reject) => {
      this.enqueue(
        path,
        durationSecs,
        revision,
        priority,
        [{ resolve, reject }],
        onPartial ? [onPartial] : undefined,
        true,
      );
    });
  }

  private enqueue(
    path: string,
    durationSecs: number | null,
    revision: number,
    priority: number,
    resolvers?: Waiter[],
    partials?: PartialListener[],
    force = false,
  ) {
    const key = memKey(path, revision);
    const complete = toResult(this.cache.get(key) ?? { frames: null, keyframesSecs: null });
    if (complete) {
      for (const w of resolvers ?? []) w.resolve(complete);
      if (partials?.length) {
        const payload = {
          frames: complete.frames,
          keyframesSecs: complete.keyframesSecs,
        };
        for (const p of partials) p(payload);
      }
      return;
    }

    if (resolvers?.length) {
      const list = this.waiters.get(key) ?? [];
      list.push(...resolvers);
      this.waiters.set(key, list);
    }
    if (partials?.length) {
      const list = this.partialListeners.get(key) ?? [];
      list.push(...partials);
      this.partialListeners.set(key, list);
    }

    if (this.inFlight.has(key)) {
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      existing.force = existing.force || force;
      this.pump();
      return;
    }

    this.pending.set(key, { path, durationSecs, revision, priority, force });
    this.pump();
  }

  private notifyPartial(key: string, partial: FilmstripPrefetchPartial) {
    const listeners = this.partialListeners.get(key);
    if (!listeners?.length) return;
    for (const listener of listeners) listener(partial);
  }

  private rejectWaiters(key: string, error: unknown) {
    const ws = this.waiters.get(key) ?? [];
    this.waiters.delete(key);
    this.partialListeners.delete(key);
    for (const w of ws) w.reject(error);
  }

  private resolveWaiters(key: string, result: FilmstripPrefetchResult) {
    const ws = this.waiters.get(key) ?? [];
    this.waiters.delete(key);
    this.partialListeners.delete(key);
    for (const w of ws) w.resolve(result);
  }

  private pump() {
    while (this.pending.size > 0 && this.active < CONCURRENCY) {
      let bestKey: string | null = null;
      let best: PendingItem | null = null;
      for (const [k, item] of this.pending) {
        if (this.paused && !item.force) continue;
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

  private ensureEntry(key: string): CacheEntry {
    let entry = this.cache.get(key);
    if (!entry) {
      entry = { frames: null, keyframesSecs: null };
      this.cache.set(key, entry);
    }
    return entry;
  }

  private async runOne(key: string, item: FilmstripPrefetchClip) {
    this.inFlight.add(key);
    this.active += 1;
    const entry = this.ensureEntry(key);

    try {
      const tasks: Promise<void>[] = [];

      if (entry.frames == null) {
        tasks.push(
          getVideoFilmstrip(
            item.path,
            FILMSTRIP_FRAME_COUNT,
            FILMSTRIP_FRAME_HEIGHT,
            item.durationSecs,
          ).then((frames) => {
            entry.frames = frames;
            this.notifyPartial(key, { frames });
          }),
        );
      }

      if (entry.keyframesSecs == null) {
        tasks.push(
          listVideoKeyframes(item.path, item.durationSecs).then((keyframesSecs) => {
            entry.keyframesSecs = keyframesSecs;
            this.notifyPartial(key, { keyframesSecs });
          }),
        );
      }

      const settled = await Promise.allSettled(tasks);
      const result = toResult(entry);
      if (result) {
        this.resolveWaiters(key, result);
        return;
      }

      const firstError = settled.find((s) => s.status === "rejected");
      const reason =
        firstError && firstError.status === "rejected"
          ? firstError.reason
          : new Error("filmstrip prefetch failed");
      this.rejectWaiters(key, reason);
    } catch (e) {
      this.rejectWaiters(key, e);
    } finally {
      this.inFlight.delete(key);
      this.active -= 1;
      this.pump();
    }
  }
}

export const filmstripPrefetch = new FilmstripPrefetchQueue();
