import type { LayoutModel } from './layout.js';

/**
 * The check of the read-only caches (architecture-2 ticket 60). A cache keyed by the identity of what it reads is right only while no code
 * writes those objects in place. While a check runs (`LayoutOptions.checkCaches`), every cache hit computes its answer again and throws on
 * a difference, so one corpus run under the check shows the keys hold on every sheet. Off, a hit costs one counter step.
 */
export interface ReadCacheTally {
  hits: number;
  misses: number;
  checked: number;
  skipped: number;
}

let checkingAll = 0;
let checkingSampled = 0;
const counts = new Map<string, ReadCacheTally>();
const resetters: (() => void)[] = [];
const DEFAULT_KEY = {};

/**
 * Runs `run` with cache checking enabled (`'all'` verifies every hit; `'sampled'` verifies hits 1, 2, 4, 8, ... per cache and model).
 * Nested and concurrent runs count up: if any active run requested `'all'`, full checking stays on until that run ends.
 */
export async function checkReadCaches<T>(run: () => Promise<T>, mode: 'all' | 'sampled' = 'all'): Promise<T> {
  if (mode === 'all') checkingAll++;
  else checkingSampled++;
  try { return await run(); } finally {
    if (mode === 'all') checkingAll--;
    else checkingSampled--;
  }
}

/** Hits, misses, checked and skipped hits per cache since the process started (or last reset); a probe for measurements, never read by the layout. */
export function readCacheCounts(): Record<string, ReadCacheTally> {
  return Object.fromEntries([...counts].map(([name, value]) => [name, { ...value }]));
}

/** Resets every registered cache's counters and sampled hit-stride tracking; for tests and canary runs. */
export function resetReadCacheCounts(): void {
  for (const reset of resetters) reset();
}

export interface ReadCache {
  /** Records a miss. */
  miss(): void;
  /**
   * Records a hit and returns `cached`. Under the check it computes the answer again (on every hit in `'all'` mode, or on power-of-two hits
   * `1, 2, 4, 8, ...` per model in `'sampled'` mode) and throws when the two differ, with the cache name, the model hash and the first
   * different item.
   */
  hit<T>(model: LayoutModel, cached: T, compute: () => T): T;
}

/** The counters and the check of one named cache. */
export function readCache(name: string): ReadCache {
  const tally: ReadCacheTally = { hits: 0, misses: 0, checked: 0, skipped: 0 };
  counts.set(name, tally);
  let hitCounts = new WeakMap<object, number>();
  resetters.push(() => {
    tally.hits = 0;
    tally.misses = 0;
    tally.checked = 0;
    tally.skipped = 0;
    hitCounts = new WeakMap<object, number>();
  });
  return {
    miss: () => { tally.misses++; },
    hit: (model, cached, compute) => {
      tally.hits++;
      if (checkingAll === 0 && checkingSampled === 0) return cached;
      if (checkingAll === 0) {
        const key = typeof model === 'object' && model !== null ? model : DEFAULT_KEY;
        const n = (hitCounts.get(key) ?? 0) + 1;
        hitCounts.set(key, n);
        if ((n & (n - 1)) !== 0) {
          tally.skipped++;
          return cached;
        }
      }
      tally.checked++;
      const difference = firstDifference(cached, compute());
      if (difference !== undefined) throw new Error(`Stale read cache ${name} on model ${modelHash(model)}: ${difference}`);
      return cached;
    },
  };
}

/** Recursively converts Sets and Maps into arrays of plain items so nested collections do not serialize as `{}`. */
const plain = (value: unknown): unknown => {
  if (value instanceof Set) return [...value].map(plain);
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => [plain(k), plain(v)]);
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
};
function firstDifference(cachedValue: unknown, freshValue: unknown): string | undefined {
  if (Object.is(cachedValue, freshValue) && (typeof cachedValue !== 'object' || cachedValue === null)) return undefined;
  const cached = plain(cachedValue), fresh = plain(freshValue);
  const a = JSON.stringify(cached), b = JSON.stringify(fresh);
  if (a === b) return undefined;
  if (Array.isArray(cached) && Array.isArray(fresh)) {
    const length = Math.max(cached.length, fresh.length);
    for (let index = 0; index < length; index++) {
      if (JSON.stringify(cached[index]) !== JSON.stringify(fresh[index])) return `item ${index}: cached ${JSON.stringify(cached[index])}, fresh ${JSON.stringify(fresh[index])}`;
    }
  }
  return `cached ${a}, fresh ${b}`;
}

/** FNV-1a over the model's JSON text, 8 hex digits: enough to name a model in an error. */
function modelHash(model: LayoutModel): string {
  const text = JSON.stringify(model);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
