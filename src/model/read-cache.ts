import type { LayoutModel } from './layout.js';

/**
 * The check of the read-only caches (architecture-2 ticket 60). A cache keyed by the identity of what it reads is right only while no code
 * writes those objects in place. While a check runs (`LayoutOptions.checkCaches`), every cache hit computes its answer again and throws on
 * a difference, so one corpus run under the check shows the keys hold on every sheet. Off, a hit costs one counter step.
 */
let checking = 0;
const counts = new Map<string, { hits: number; misses: number; checked: number }>();

/** Runs `run` with every cache hit checked. Nested and concurrent runs count up, so the check stays on until the last one ends. */
export async function checkReadCaches<T>(run: () => Promise<T>): Promise<T> {
  checking++;
  try { return await run(); } finally { checking--; }
}

/** Hits, misses and checked hits per cache since the process started; a probe for measurements, never read by the layout. */
export function readCacheCounts(): Record<string, { hits: number; misses: number; checked: number }> {
  return Object.fromEntries([...counts].map(([name, value]) => [name, { ...value }]));
}

export interface ReadCache {
  /** Records a miss. */
  miss(): void;
  /**
   * Records a hit and returns `cached`. Under the check it first computes the answer again and throws when the two differ, with the cache
   * name, the model hash and the first different item.
   */
  hit<T>(model: LayoutModel, cached: T, compute: () => T): T;
}

/** The counters and the check of one named cache. */
export function readCache(name: string): ReadCache {
  const tally = { hits: 0, misses: 0, checked: 0 };
  counts.set(name, tally);
  return {
    miss: () => { tally.misses++; },
    hit: (model, cached, compute) => {
      tally.hits++;
      if (checking === 0) return cached;
      tally.checked++;
      const difference = firstDifference(cached, compute());
      if (difference !== undefined) throw new Error(`Stale read cache ${name} on model ${modelHash(model)}: ${difference}`);
      return cached;
    },
  };
}

/** A set or a map compares as the list of its items in insertion order; JSON would print both as `{}`. */
const plain = (value: unknown): unknown => value instanceof Set || value instanceof Map ? [...value] : value;
function firstDifference(cachedValue: unknown, freshValue: unknown): string | undefined {
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
