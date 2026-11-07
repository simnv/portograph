import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { blockReservationsFault } from '../../src/layout/block-checks.js';
import { admitFanFamilies } from '../../src/layout/fan-admission.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const baseline = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../src/resolve/solid-blocks.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/resolve/solid-blocks.js')>();
  return { ...original, detectSolidBlocks: (...args: Parameters<typeof original.detectSolidBlocks>): void => {
    if (!baseline.enabled) original.detectSolidBlocks(...args);
  } };
});
const geometry = (model: Awaited<ReturnType<typeof layout>>): unknown => {
  const copy = structuredClone(model);
  delete copy.declinedSolidBlocks;
  // Revisions count the discarded placement probe, not drawing geometry.
  if (copy.reservations) copy.reservations = copy.reservations.map(entry => ({ ...entry, revision: 0 }));
  return { ...copy, diagnostics: [], runtime: { stages: [] } };
};
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const regular = fixture('a-solid-block-prototype-keeps-all-members-straight');
const canton = fixture('a-two-by-two-solid-block-prototype-inside-a-canton');
const lay = (source: string) => layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('ticket 83 under-cap solid blocks', () => {
  it('declines an over-cap block before freeze and restores the main drawing and restore contract', async () => {
    const source = fixture('a-capped-solid-block-prototype-keeps-foreign-boxes');
    const model = await lay(source);
    expect(model.fanFamilies?.some(family => family.kind === 'solid') ?? false).toBe(false);
    expect(model.declinedSolidBlocks?.some(item => item.reason.startsWith('gap-cap:'))).toBe(true);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    baseline.enabled = true;
    try { expect(geometry(model)).toEqual(geometry(await lay(source))); } finally { baseline.enabled = false; }
  });
  it('keeps interacting blocks under their previous owners', async () => {
    const source = fixture('solid-blocks-that-share-nodes-keep-their-owners');
    const model = await lay(source);
    expect(model.diagnostics.filter(item => item.code === 'SOLID_BLOCK_DECLINED')).toHaveLength(2);
    expect(model.groupLinks).toHaveLength(2);
    baseline.enabled = true;
    try { expect(geometry(model)).toEqual(geometry(await lay(source))); } finally { baseline.enabled = false; }
  });
  it('adds no height when the settled block already meets the angle and top entry', async () => {
    const source = fixture('a-solid-block-keeps-a-gap-that-already-fits');
    const model = await lay(source);
    expect(model.blockReservations![0]!.chosen).toBe(60);
    expect(model.blockReservations![0]!.target).toBeLessThanOrEqual(60);
    baseline.enabled = true;
    try { expect(model.canvas!.height).toBe((await lay(source)).canvas!.height); } finally { baseline.enabled = false; }
  });
  it.each(['h0-ebgp', 'h0-ibgp', 'h1-ebgp', 'h1-ibgp'])('reserves the complete 4×8 block and its hosts, %s', async name => {
    const source = readFileSync(new URL('../../.scratch/stress/fabric/s04-l08-' + name + '.yaml', import.meta.url), 'utf8');
    const model = await lay(source), snapshot = score(model).snapshot;
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(32);
    expect(snapshot.counts.routed.turns).toBe(0);
    expect(snapshot.gates.G4.violations).toEqual([]);
    expect(snapshot.gates.G6.violations).toEqual([]);
    expect(model.blockReservations!.every(item => item.target <= 600)).toBe(true);
    for (const link of model.links.filter(item => item.solidBlock)) {
      const run = link.path!.segments[0]!;
      expect(Math.abs(run.to.y - run.from.y) + 1e-6).toBeGreaterThanOrEqual(Math.abs(run.to.x - run.from.x) * Math.tan(34 * Math.PI / 180));
    }
  });
  it('counts nodes within a canton and supersedes inferred aggregation', () => {
    const model = resolve(parse(canton));
    expect(model.fanFamilies).toHaveLength(1);
    expect(model.fanFamilies![0]!.kind).toBe('solid');
    expect(model.fanFamilies![0]!.members).toHaveLength(4);
    expect(model.groupLinks).toHaveLength(0);
  });
  it('does not extract a biclique from an incomplete cohort or override explicit group-links', () => {
    expect(resolve(parse(canton.replace('  - { from: hub0, to: leaf0 }\n', ''))).fanFamilies).toBeUndefined();
    expect(resolve(parse(canton.replace('from: hub0, to: leaf0', 'from: hub0, to: leaf0, route: orthogonal'))).fanFamilies).toBeUndefined();
  });
  it('keeps all terminal followers straight after block pitch widens their parents', async () => {
    const model = await lay(fixture('a-solid-block-prototype-keeps-terminal-followers-straight'));
    expect(model.blockFollowers).toHaveLength(8);
    expect(score(model).snapshot.counts.routed.turns).toBe(0);
  });
  it('keeps the 4 by 8 block straight at full crossing weight and validates the recorded floor', async () => {
    const model = await lay(regular);
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(32);
    const snapshot = score(model).snapshot;
    expect(snapshot.counts.routed.turns).toBe(0);
    expect(snapshot.metrics.crossings.faint ?? 0).toBe(0);
    expect(snapshot.metrics.crossings.count).toBeGreaterThan(0);
    expect(Object.values(snapshot.gates).filter(gate => gate.severity === 'error' && gate.violations.length)).toEqual([]);
    expect(blockReservationsFault(model)).toBeUndefined();
    expect(blockReservationsFault(restoreLayoutModel(JSON.stringify(model)))).toBeUndefined();
    const offered = structuredClone(model);
    delete offered.frozenChords; delete offered.fanAdmissions;
    admitFanFamilies(offered, offered.links.filter(link => link.solidBlock), 1);
    expect(offered.links.filter(link => link.solidBlock && link.path?.segments.length === 1)).toHaveLength(32);
    const copy = structuredClone(model);
    delete copy.blockReservations;
    expect(blockReservationsFault(copy)).toContain('missing');
    copy.blockReservations = [];
    expect(blockReservationsFault(copy)).toContain('missing');
  }, 120000);
});
