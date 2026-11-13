import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/model/layout.js';
import { checkReadCaches, readCache, readCacheCounts, resetReadCacheCounts } from '../../src/model/read-cache.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Counts `new WeakMap`, module-scope `new Map`, and `readCache('...')` registrations in a TypeScript file. */
function scanSource(source: string) {
  const weakMaps = [...source.matchAll(/\bnew WeakMap\b/g)].length;
  const readCaches = [...source.matchAll(/\breadCache\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]!);
  // Module-scope `new Map`: top-level declarations (not indented) outside functions/classes.
  const moduleMaps = source
    .split('\n')
    .filter(line => /^(?:export )?(?:const|let|var)\s+[^=]*=\s*new Map\b/.test(line))
    .length;
  return { weakMaps, readCaches, moduleMaps };
}

/** Exact registry of `(file, cacheName)` pairs in `src/`. Adding a read cache requires registering it with `readCache('<name>')`. */
const EXPECTED_READ_CACHES: ReadonlyArray<readonly [string, string]> = [
  ['src/layout/alignment-targets.ts', 'alignmentLinkIndex'],
  ['src/layout/bands.ts', 'bandsRoutedStroke'],
  ['src/layout/centre.ts', 'centreCarry'],
  ['src/layout/centre.ts', 'centreCheckAnswer'],
  ['src/layout/gap-plan.ts', 'gapPlan'],
  ['src/layout/lanes.ts', 'facingRoutedPorts'],
  ['src/layout/overlay-paths.ts', 'overlayDocumentPrints'],
  ['src/layout/overlay-paths.ts', 'overlaySharedBlockers'],
  ['src/layout/overlay-paths.ts', 'overlaySharedTracks'],
  ['src/layout/overlay-paths.ts', 'overlayTracks'],
  ['src/layout/parent-stand.ts', 'parentFeedReads'],
  ['src/layout/peers.ts', 'allPeers'],
  ['src/layout/peers.ts', 'linkByEnds'],
  ['src/layout/peers.ts', 'linkById'],
  ['src/layout/peers.ts', 'routedLinksAt'],
  ['src/layout/peers.ts', 'unreservedPeers'],
  ['src/layout/regions.ts', 'cellPadding'],
  ['src/score/model.ts', 'groupConsumers'],
  ['src/theme/geometry.ts', 'themeRoutedStroke'],
];

/**
 * Every `new WeakMap` occurrence in `src/`:
 * - Either the backing map of a registered `readCache(...)` above,
 * - Or an explicit allowlisted non-read-cache `WeakMap` (ownership / provenance / counter / self-verifying hint).
 */
const EXPECTED_WEAKMAPS: Readonly<Record<string, { count: number; reason: string }>> = {
  // Backing WeakMaps for registered `readCache(...)` caches:
  'src/layout/alignment-targets.ts': { count: 1, reason: 'alignmentLinkIndex readCache' },
  'src/layout/bands.ts': { count: 1, reason: 'bandsRoutedStroke readCache' },
  'src/layout/centre.ts': { count: 1, reason: 'centreCheckAnswer readCache' },
  'src/layout/lanes.ts': { count: 1, reason: 'facingRoutedPorts readCache' },
  'src/layout/overlay-paths.ts': { count: 3, reason: 'overlaySharedBlockers, overlayTracks, overlayDocumentPrints readCaches' },
  'src/layout/peers.ts': { count: 5, reason: 'linkById, linkByEnds, unreservedPeers, routedLinksAt, allPeers readCaches' },
  'src/layout/regions.ts': { count: 1, reason: 'cellPadding readCache' },
  'src/score/model.ts': { count: 1, reason: 'groupConsumers readCache' },
  'src/theme/geometry.ts': { count: 1, reason: 'themeRoutedStroke readCache' },
  // Explicit allowlist of non-read-cache WeakMaps:
  'src/model/read-cache.ts': { count: 2, reason: 'per-cache sampled hit counter WeakMap (init + reset)' },
  'src/layout/mutation.ts': { count: 1, reason: 'frozenDocumentText on deeply frozen baseline documents' },
  'src/layout/placement-attempt.ts': { count: 1, reason: 'replaysOn per-model replay counter state' },
  'src/pipeline/env.ts': { count: 1, reason: 'stage3Sizes Stage 3 baseline size snapshot for R1 validator' },
  'src/layout/decide.ts': { count: 2, reason: 'spent slide-growth budget state + call-local copies Verdict map' },
  'src/layout/approach.ts': { count: 1, reason: 'approachReach virtual port stem-reach metadata handoff' },
  'src/parse/validation.ts': { count: 1, reason: 'known AST source-location provenance map' },
  'src/layout/row-paths.ts': { count: 2, reason: 'portPlaces self-verifying port index hint (validated on every hit)' },
};

/** Every module-scope `new Map` in `src/`. */
const EXPECTED_MODULE_MAPS: Readonly<Record<string, { count: number; reason: string }>> = {
  'src/layout/corridor-order.ts': { count: 1, reason: 'IDENTITY empty constant map' },
  'src/layout/gap-plan.ts': { count: 1, reason: 'gapPlanMemo registered with gapPlan readCache' },
  'src/layout/side-hints.ts': { count: 1, reason: 'NO_SIDE_HINTS empty constant map' },
  'src/model/read-cache.ts': { count: 1, reason: 'counts telemetry map' },
  'src/render/author-css.ts': { count: 1, reason: 'NAMED immutable CSS color table' },
  'src/text/index.ts': { count: 1, reason: 'measured bounded 8192-entry pure text measurement cache' },
};

function findUnregisteredInFiles(entries: ReadonlyArray<{ file: string; source: string }>) {
  const unknownWeakMaps: string[] = [];
  const unknownModuleMaps: string[] = [];
  const foundCaches: Array<[string, string]> = [];
  for (const { file, source } of entries) {
    const scanned = scanSource(source);
    for (const name of scanned.readCaches) foundCaches.push([file, name]);
    const expectedWeak = EXPECTED_WEAKMAPS[file]?.count ?? 0;
    if (scanned.weakMaps !== expectedWeak) {
      unknownWeakMaps.push(`${file}: found ${scanned.weakMaps} new WeakMap, expected ${expectedWeak}`);
    }
    const expectedMap = EXPECTED_MODULE_MAPS[file]?.count ?? 0;
    if (scanned.moduleMaps !== expectedMap) {
      unknownModuleMaps.push(`${file}: found ${scanned.moduleMaps} module-scope new Map, expected ${expectedMap}`);
    }
  }
  return { unknownWeakMaps, unknownModuleMaps, foundCaches };
}

describe('read-cache static allowlist guard', () => {
  it('registers every readCache and accounts for every WeakMap and module-scope Map in src/', () => {
    const entries = walkTs(SRC).map(full => ({
      file: relative(ROOT, full).replaceAll('\\', '/'),
      source: readFileSync(full, 'utf8'),
    }));
    const { unknownWeakMaps, unknownModuleMaps, foundCaches } = findUnregisteredInFiles(entries);
    expect(unknownWeakMaps).toEqual([]);
    expect(unknownModuleMaps).toEqual([]);
    expect(foundCaches.sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`))).toEqual(
      [...EXPECTED_READ_CACHES].sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)),
    );
  });

  it('rejects a synthetic source snippet with an unregistered new WeakMap or module-scope new Map', () => {
    const synthetic = findUnregisteredInFiles([
      {
        file: 'src/layout/unregistered-probe.ts',
        source: [
          'const cache = new WeakMap<object, number>();',
          'const memo = new Map<string, number>();',
          "export const read = (o: object) => cache.get(o) ?? memo.get('a');",
        ].join('\n'),
      },
    ]);
    expect(synthetic.unknownWeakMaps).toEqual(['src/layout/unregistered-probe.ts: found 1 new WeakMap, expected 0']);
    expect(synthetic.unknownModuleMaps).toEqual(['src/layout/unregistered-probe.ts: found 1 module-scope new Map, expected 0']);
  });
});

describe('checkReadCaches modes and firstDifference', () => {
  const model = { document: { nodes: {}, links: [], groups: {} } } as unknown as LayoutModel;

  it('catches stale primitive, Set/Map, nested Set/Map, and object entries under checkCaches all', async () => {
    const primCache = readCache('testPrim');
    let primFresh = 10;
    await expect(checkReadCaches(async () => {
      expect(primCache.hit(model, 10, () => primFresh)).toBe(10);
      primFresh = 12;
      primCache.hit(model, 10, () => primFresh);
    })).rejects.toThrow(/Stale read cache testPrim on model [0-9a-f]{8}: cached 10, fresh 12/);

    const setCache = readCache('testSet');
    await expect(checkReadCaches(async () => {
      setCache.hit(model, new Set(['a']), () => new Set(['b']));
    })).rejects.toThrow(/Stale read cache testSet/);

    const nestedCache = readCache('testNestedMapSet');
    const cachedObj = { links: new Map([['l1', { id: 'l1' }]]), direct: new Set(['a']) };
    const sameObj = { links: new Map([['l1', { id: 'l1' }]]), direct: new Set(['a']) };
    const staleObj = { links: new Map([['l1', { id: 'l1' }]]), direct: new Set(['b']) };
    await expect(checkReadCaches(async () => {
      nestedCache.hit(model, cachedObj, () => sameObj);
      nestedCache.hit(model, cachedObj, () => staleObj);
    })).rejects.toThrow(/Stale read cache testNestedMapSet/);
  });

  it('checks power-of-two hits (1, 2, 4, 8, 16) deterministically in sampled mode', async () => {
    const sampled = readCache('testSampledStride');
    resetReadCacheCounts();
    let computes = 0;
    await checkReadCaches(async () => {
      for (let i = 0; i < 16; i++) {
        sampled.hit(model, 42, () => {
          computes++;
          return 42;
        });
      }
    }, 'sampled');
    const counts = readCacheCounts().testSampledStride!;
    expect(counts).toEqual({ hits: 16, misses: 0, checked: 5, skipped: 11 });
    expect(computes).toBe(5);
  });

  it('keeps full checking active when an all-mode check is nested inside sampled mode', async () => {
    const nested = readCache('testNestedMode');
    resetReadCacheCounts();
    await checkReadCaches(async () => {
      // Hits 1, 2, 3 under outer sampled: 1 & 2 checked, 3 skipped.
      nested.hit(model, 1, () => 1);
      nested.hit(model, 1, () => 1);
      nested.hit(model, 1, () => 1);
      await checkReadCaches(async () => {
        // Every hit under inner 'all' is checked.
        nested.hit(model, 1, () => 1);
        nested.hit(model, 1, () => 1);
      }, 'all');
      // Hit 4 under outer sampled: 4 is a power of two -> checked.
      nested.hit(model, 1, () => 1);
    }, 'sampled');
    const counts = readCacheCounts().testNestedMode!;
    expect(counts).toEqual({ hits: 6, misses: 0, checked: 5, skipped: 1 });
  });
});
