/** Filmstrip + keyframe prefetch for VideoCutter (OPT-7). */

import { getVideoFilmstrip, listVideoKeyframes } from "./tauri";

export const FILMSTRIP_FRAME_COUNT = 14;
export const FILMSTRIP_FRAME_HEIGHT = 56;
export const PREFETCH_DEBOUNCE_MS = 450;

export type FilmstripPrefetchResult = {
  frames: string[];
  keyframesSecs: number[];
};

export type FilmstripPrefetchClip = {
  path: string;
  durationSecs: number | null;
  revision: number;
};

function memKey(path: string, revision: number): string {
  return `${path}\0${revision}`;
}

const CONCURRENCY = 1;

type PendingItem = FilmstripPrefetchClip & { priority: number; force: boolean };

class FilmstripPrefetchQueue {
  private cache = new Map<string, FilmstripPrefetchResult>();
  private pending = new Map<string, PendingItem>();
  private inFlight = new Set<string>();
  private waiters = new Map<
    string,
    Array<{
      resolve: (value: FilmstripPrefetchResult) => void;
      reject: (reason: unknown) => void;
    }>
  >();
  private active = 0;
  private paused = false;
  private debounceTimer: number | null = null;
  private scheduled: Array<FilmstripPrefetchClip & { priority: number }> = [];
  private generation = 0;

  getCached(path: string, revision: number): FilmstripPrefetchResult | null {
    return this.cache.get(memKey(path, revision)) ?? null;
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
      const ws = this.waiters.get(key) ?? [];
      this.waiters.delete(key);
      for (const w of ws) w.reject(new Error("filmstrip prefetch paused"));
    }
  }

  /**
   * Prefetch the active clip immediately; debounce only the next neighbor.
   */
  schedule(clips: FilmstripPrefetchClip[], debounceMs = PREFETCH_DEBOUNCE_MS) {
    if (this.paused || clips.length === 0) return;
    const [active, next] = clips.slice(0, 2);
    this.enqueue(active.path, active.durationSecs, active.revision, 100, undefined, false);
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
        this.enqueue(item.path, item.durationSecs, item.revision, item.priority, undefined, false);
      }
    }, debounceMs);
  }

  /** Immediate prefetch (cutter open on cache miss). */
  prefetch(
    path: string,
    durationSecs: number | null,
    revision: number,
    priority = 90,
  ): Promise<FilmstripPrefetchResult> {
    const key = memKey(path, revision);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);

    if (this.inFlight.has(key)) {
      return new Promise((resolve, reject) => {
        const hit = this.cache.get(key);
        if (hit) {
          resolve(hit);
          return;
        }
        const list = this.waiters.get(key) ?? [];
        list.push({ resolve, reject });
        this.waiters.set(key, list);
      });
    }

    return new Promise((resolve, reject) => {
      this.enqueue(path, durationSecs, revision, priority, [{ resolve, reject }], true);
    });
  }

  private enqueue(
    path: string,
    durationSecs: number | null,
    revision: number,
    priority: number,
    resolvers?: Array<{
      resolve: (value: FilmstripPrefetchResult) => void;
      reject: (reason: unknown) => void;
    }>,
    force = false,
  ) {
    const key = memKey(path, revision);
    if (this.cache.has(key)) {
      const hit = this.cache.get(key)!;
      for (const w of resolvers ?? []) w.resolve(hit);
      return;
    }

    if (this.inFlight.has(key)) {
      if (resolvers?.length) {
        const list = this.waiters.get(key) ?? [];
        list.push(...resolvers);
        this.waiters.set(key, list);
      }
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      existing.force = existing.force || force;
      if (resolvers?.length) {
        const list = this.waiters.get(key) ?? [];
        list.push(...resolvers);
        this.waiters.set(key, list);
      }
      this.pump();
      return;
    }

    this.pending.set(key, { path, durationSecs, revision, priority, force });
    if (resolvers?.length) {
      const list = this.waiters.get(key) ?? [];
      list.push(...resolvers);
      this.waiters.set(key, list);
    }
    this.pump();
  }

  private flushWaiters(key: string, result: FilmstripPrefetchResult | null, error?: unknown) {
    const ws = this.waiters.get(key) ?? [];
    this.waiters.delete(key);
    for (const w of ws) {
      if (result) w.resolve(result);
      else w.reject(error ?? new Error("filmstrip prefetch failed"));
    }
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

  private async runOne(key: string, item: FilmstripPrefetchClip) {
    this.inFlight.add(key);
    this.active += 1;
    try {
      const result = await this.load(item.path, item.durationSecs);
      this.cache.set(key, result);
      this.flushWaiters(key, result);
    } catch (e) {
      this.flushWaiters(key, null, e);
    } finally {
      this.inFlight.delete(key);
      this.active -= 1;
      this.pump();
    }
  }

  private async load(
    path: string,
    durationSecs: number | null,
  ): Promise<FilmstripPrefetchResult> {
    const [frames, keyframesSecs] = await Promise.all([
      getVideoFilmstrip(
        path,
        FILMSTRIP_FRAME_COUNT,
        FILMSTRIP_FRAME_HEIGHT,
        durationSecs,
      ),
      listVideoKeyframes(path, durationSecs),
    ]);
    return { frames, keyframesSecs };
  }
}

export const filmstripPrefetch = new FilmstripPrefetchQueue();
