import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { attemptTimings, resetAttemptTimings, type TimingHooks } from '../../src/layout/attempt-timings.js';
import { replayRegions } from '../../src/layout/placement-attempt.js';
import { rebuildRegionGeometry } from '../../src/layout/region-rebuild.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture 2, ticket 05, phase 0: the measurement of what a settled trial of the chord step costs per sub-step, how much of the sheet a
 * move reaches, and whether a replay is bit-idempotent. A measurement tool, not a regression test: it runs only when `A2_05_MODE` is set
 * (`time`, `dirty` or `idem`) and writes its result as JSON to `A2_05_OUT`. Nothing here is read by a decision of the pipeline.
 *
 *   A2_05_MODE=time  A2_05_SHEET=<yaml path> A2_05_OUT=<json>   per-trial, per-step times (hooks off)
 *   A2_05_MODE=dirty A2_05_SHEET=<yaml path> A2_05_OUT=<json>   per-trial seed, changed set and closure estimate
 *   A2_05_MODE=idem  A2_05_SHEETS_FILE=<file holding a comma list of paths> A2_05_OUT=<json>   bit-idempotence of replayRegions and rebuildRegionGeometry
 */
const MODE = process.env.A2_05_MODE, OUT = process.env.A2_05_OUT ?? '/tmp/a2-05/out.json';
const run = async (path: string): Promise<LayoutModel | undefined> => {
  const result = await layout(parse(readFileSync(path, 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  return result as unknown as LayoutModel | undefined;
};

// ---- digests ----------------------------------------------------------------------------------------------------------------------------
const groupDigest = (m: LayoutModel, id: string): string => JSON.stringify([m.groups[id]!.bounds, m.groups[id]!.nodes.map(n => [m.nodes[n]!.bounds, m.nodes[n]!.ports.map(p => (p as { anchor?: unknown }).anchor)])]);
const maxDelta = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? 0 : Infinity;
  let max = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) max = Math.max(max, maxDelta((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  return max;
};
interface Diff { path: string; a: unknown; b: unknown; delta: number }
function diffTree(a: unknown, b: unknown, path: string, out: Diff[], limit = 100000): void {
  if (out.length >= limit) return;
  if (typeof a === 'number' && typeof b === 'number') { if (!Object.is(a, b)) out.push({ path, a, b, delta: Math.abs(a - b) }); return; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b) out.push({ path, a, b, delta: Infinity }); return; }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && a.length !== (b as unknown[]).length)) { out.push({ path: `${path}#shape`, a: ka.length, b: kb.length, delta: Infinity }); return; }
  if (ka.join(',') !== kb.join(',')) out.push({ path: `${path}#keys`, a: ka.join(','), b: kb.join(','), delta: Infinity });
  for (const key of new Set([...ka, ...kb])) diffTree((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, out, limit);
}
const clone = (m: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(m)) as LayoutModel;

// ---- mode: time --------------------------------------------------------------------------------------------------------------------------
async function timeMode(sheet: string): Promise<void> {
  resetAttemptTimings(); attemptTimings.on = true;
  const started = Date.now();
  await run(sheet);
  const wall = Date.now() - started;
  attemptTimings.on = false;
  writeFileSync(OUT, JSON.stringify({ wall, trials: attemptTimings.trials.map(t => ({ total: t.total, steps: Object.fromEntries(t.steps) })) }));
}

// ---- mode: dirty -------------------------------------------------------------------------------------------------------------------------
interface Base { digests: Map<string, string>; bounds: Map<string, unknown>; linkPaths: Map<string, string>; labels: Map<string, string>; model: LayoutModel }
const snapshot = (m: LayoutModel): Base => ({
  model: clone(m),
  digests: new Map(Object.keys(m.groups).map(id => [id, groupDigest(m, id)])),
  bounds: new Map(Object.keys(m.groups).map(id => [id, JSON.parse(groupDigest(m, id)) as unknown])),
  linkPaths: new Map(m.links.map(l => [l.id, JSON.stringify(l.path ?? null)])),
  labels: new Map(m.labels.map(l => [l.id, JSON.stringify(l)])),
});

/**
 * An over-approximation of the read-closure (edges 1, 2, 4, 5, 6, 8 of the ticket; edge 3 perimeter lanes, edge 7 grid pairs and edge 9
 * vertical growth are not walked: the vertical growth is read from the groups that actually moved in y). Seeds spread by the rules below until
 * nothing is added.
 */
function closure(m: LayoutModel, seed: Set<string>): Set<string> {
  const groups = Object.values(m.groups), tierOf = (id: string): number => m.groups[id]!.tier ?? 0, anchor = m.anchorTier ?? 0;
  const rootOf = (frameId: string | undefined): string | undefined => {
    let id = frameId; const frames = new Map((m.frames ?? []).map(f => [f.id, f]));
    while (id !== undefined && frames.get(id)?.parent !== undefined) id = frames.get(id)!.parent;
    return id;
  };
  const endGroup = (e: LayoutModel['links'][number]['from']): string => e.group ?? m.document.nodes[e.node!]!.group;
  const ends = m.links.map(l => [endGroup(l.from), endGroup(l.to)] as const).filter(([a, b]) => m.groups[a] !== undefined && m.groups[b] !== undefined && a !== b);
  const overlay = new Set(m.links.filter(l => l.technique === 'overlay' || l.layer === 'overlay').map(l => l.id));
  const overlayEnds = m.links.filter(l => overlay.has(l.id)).map(l => [endGroup(l.from), endGroup(l.to)] as const).filter(([a, b]) => m.groups[a] !== undefined && m.groups[b] !== undefined);
  const frozen = new Set(m.frozenChords ?? []);
  const frozenEnds = m.links.filter(l => frozen.has(l.id)).map(l => [endGroup(l.from), endGroup(l.to)] as const).filter(([a, b]) => m.groups[a] !== undefined && m.groups[b] !== undefined);
  const dirty = new Set(seed);
  for (let changed = true; changed;) {
    changed = false;
    const add = (id: string): void => { if (!dirty.has(id)) { dirty.add(id); changed = true; } };
    const dirtyTiers = new Set([...dirty].map(tierOf));
    for (const g of groups) if (dirtyTiers.has(tierOf(g.id))) add(g.id); // edge 1: the tier
    for (const [a, b] of ends) { // edge 2: feeds outward from the anchor
      for (const [from, to] of [[a, b], [b, a]] as const) {
        if (dirty.has(from) && Math.abs(tierOf(to) - anchor) > Math.abs(tierOf(from) - anchor)) add(to);
      }
    }
    const dirtyRoots = new Set([...dirty].map(id => rootOf(m.groups[id]!.frame)).filter((x): x is string => x !== undefined));
    const frameTiers = new Set<number>();
    for (const g of groups) if (dirtyRoots.has(rootOf(g.frame) ?? '')) { add(g.id); frameTiers.add(tierOf(g.id)); } // edges 4 and 8: the frame / canton
    for (const g of groups) if (frameTiers.has(tierOf(g.id))) add(g.id);
    for (const [a, b] of overlayEnds) { // edge 5: an overlay chord, its ends and the tiers it crosses
      if (dirty.has(a) || dirty.has(b)) {
        add(a); add(b);
        const lo = Math.min(tierOf(a), tierOf(b)), hi = Math.max(tierOf(a), tierOf(b));
        for (const g of groups) if (tierOf(g.id) > lo && tierOf(g.id) < hi) add(g.id);
      }
    }
    for (const [a, b] of frozenEnds) if (dirty.has(a) || dirty.has(b)) { add(a); add(b); } // edge 6
  }
  return dirty;
}

async function dirtyMode(sheet: string): Promise<void> {
  resetAttemptTimings(); attemptTimings.on = true;
  let base: Base | undefined, enter: Base | undefined;
  const rows: unknown[] = [];
  const hooks: TimingHooks = {
    base: draft => { base = snapshot(draft); },
    enter: probe => { enter = snapshot(probe); },
    exit: probe => {
      if (base === undefined || enter === undefined) return;
      const ids = Object.keys(probe.groups), after = snapshot(probe);
      const seed = new Set(ids.filter(id => enter!.digests.get(id) !== base!.digests.get(id)));
      const changedBit = new Set(ids.filter(id => after.digests.get(id) !== base!.digests.get(id)));
      const changedEps = new Set(ids.filter(id => maxDelta(after.bounds.get(id), base!.bounds.get(id)) > 0.5));
      const closed = closure(base.model, seed);
      const closedPlus = new Set([...closed, ...changedBit]);
      const movedY = ids.filter(id => Math.abs(((after.bounds.get(id) as [{ y: number }])[0]?.y ?? 0) - ((base!.bounds.get(id) as [{ y: number }])[0]?.y ?? 0)) > 0.5);
      const tiers = new Map<number, { total: number; changed: number }>();
      for (const id of ids) { const t = probe.groups[id]!.tier ?? 0, e = tiers.get(t) ?? { total: 0, changed: 0 }; e.total++; if (changedBit.has(id)) e.changed++; tiers.set(t, e); }
      const linksChanged = probe.links.filter(l => after.linkPaths.get(l.id) !== base!.linkPaths.get(l.id)).length;
      const linkEnds = (l: LayoutModel['links'][number]): string[] => [l.from.group ?? probe.document.nodes[l.from.node!]!.group, l.to.group ?? probe.document.nodes[l.to.node!]!.group];
      const linksInClosure = probe.links.filter(l => linkEnds(l).some(g => closedPlus.has(g))).length;
      const titleLabels = probe.labels.filter(l => l.role === 'group');
      const titlesChanged = titleLabels.filter(l => after.labels.get(l.id) !== base!.labels.get(l.id)).length;
      rows.push({
        groups: ids.length, links: probe.links.length, titles: titleLabels.length,
        seed: seed.size, changedBit: changedBit.size, changedEps: changedEps.size, closure: closed.size, closurePlusChanged: closedPlus.size, movedY: movedY.length,
        linksChanged, linksInClosure, titlesChanged, titlesInClosure: titleLabels.filter(l => l.owner.kind === 'group' && closedPlus.has(l.owner.id)).length,
        tiers: [...tiers].sort((a, b) => a[0] - b[0]),
        converged: !base.model.diagnostics.some(d => ['PLACEMENT_NON_CONVERGENCE', 'CENTRE_INVARIANT_UNVERIFIED', 'GROUP_GRID_NON_CONVERGENCE'].includes(d.code)),
      });
    },
  };
  attemptTimings.hooks = hooks;
  await run(sheet);
  attemptTimings.on = false;
  writeFileSync(OUT, JSON.stringify(rows));
}

// ---- mode: idem --------------------------------------------------------------------------------------------------------------------------
const shape = (path: string): string => path.replace(/\.(groups|nodes)\.[^.]+/g, '.$1.*').replace(/\.\d+/g, '.#').replace(/\.links\.#/, '.links.#');
function summarise(diffs: Diff[]): { count: number; byPath: Record<string, { count: number; maxDelta: number; example: { path: string; a: unknown; b: unknown } }> } {
  const byPath: Record<string, { count: number; maxDelta: number; example: { path: string; a: unknown; b: unknown } }> = {};
  for (const d of diffs) {
    const key = shape(d.path).split('.').slice(0, 4).join('.'), e = byPath[key];
    if (e === undefined) byPath[key] = { count: 1, maxDelta: d.delta, example: { path: d.path, a: d.a, b: d.b } };
    else { e.count++; e.maxDelta = Math.max(e.maxDelta, d.delta); }
  }
  return { count: diffs.length, byPath };
}
async function idemMode(sheets: string[]): Promise<void> {
  const results: Record<string, unknown[]> = {};
  for (const sheet of sheets) {
    resetAttemptTimings(); attemptTimings.on = true;
    const rounds: unknown[] = [];
    attemptTimings.hooks = {
      round: draft => {
        const converged = !draft.diagnostics.some(d => ['PLACEMENT_NON_CONVERGENCE', 'CENTRE_INVARIANT_UNVERIFIED', 'GROUP_GRID_NON_CONVERGENCE'].includes(d.code));
        const entry: Record<string, unknown> = { converged };
        for (const [name, replay] of [['replayRegions', (m: LayoutModel) => replayRegions(m)], ['rebuildRegionGeometry', (m: LayoutModel) => rebuildRegionGeometry(m, undefined, undefined, true)]] as const) {
          const start = clone(draft), one = clone(start);
          replay(one);
          const two = clone(one);
          replay(two);
          const d1: Diff[] = [], d2: Diff[] = [];
          diffTree(JSON.parse(JSON.stringify(start)), JSON.parse(JSON.stringify(one)), '', d1);
          diffTree(JSON.parse(JSON.stringify(one)), JSON.parse(JSON.stringify(two)), '', d2);
          entry[name] = { firstReplay: summarise(d1), secondReplay: summarise(d2), sameBytes1: JSON.stringify(start) === JSON.stringify(one), sameBytes2: JSON.stringify(one) === JSON.stringify(two) };
        }
        rounds.push(entry);
      },
    };
    try { await run(sheet); } catch (error) { rounds.push({ error: String(error) }); }
    attemptTimings.on = false;
    results[sheet] = rounds;
    writeFileSync(OUT, JSON.stringify(results));
  }
}

describe.skipIf(MODE === undefined)('ticket 05 phase 0 measurement', () => {
  it('measures', async () => {
    if (MODE === 'time') await timeMode(process.env.A2_05_SHEET!);
    else if (MODE === 'dirty') await dirtyMode(process.env.A2_05_SHEET!);
    else if (MODE === 'idem') await idemMode(readFileSync(process.env.A2_05_SHEETS_FILE!, 'utf8').trim().split(','));
    expect(true).toBe(true);
  }, 3_600_000);
});
