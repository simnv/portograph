import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { chordsHold, edgeLeavers } from '../../src/layout/frame-paths.js';
import { blockReservationsFault } from '../../src/layout/block-checks.js';
import { admitFanFamilies } from '../../src/layout/fan-admission.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
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
  it.each(['a-solid-block-keeps-the-box-corner-margin', 'a-solid-block-enters-beside-a-foreign-group', 'a-solid-block-spans-two-far-groups'])('reserves top entry and canonical ownership: %s', async name => {
    const model = await lay(fixture(name));
    const families = model.fanFamilies?.filter(family => family.kind === 'solid');
    expect(families).toHaveLength(1);
    expect(families![0]!.members).toHaveLength(name.includes('two-far') ? 8 : 4);
    expect(edgeLeavers(model).filter(id => model.links.find(link => link.id === id)?.solidBlock)).toEqual([]);
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(families![0]!.members.length);
    expect(blockReservationsFault(model)).toBeUndefined();
    expect(model.diagnostics.filter(item => ['STRAIGHT_LINK_EDGE', 'STRAIGHT_LINK_BLOCKED'].includes(item.code))).toEqual([]);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  });
  it('keeps blocks when the unrelated rerun budget is zero', async () => {
    const model = await layout(parse(canton), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testMaxReruns: 0 });
    expect(model.fanFamilies?.filter(family => family.kind === 'solid')).toHaveLength(1);
  });
  it('rejects a provably capped block at stage 5 before region placement', async () => {
    await expect(placed(fixture('a-solid-block-proves-the-cap-before-region-placement'))).rejects.toThrow(/gap-cap: stage-5 lower bound/);
  });
  it('keeps widening distinct from moving a frozen follower and rejects forged entry', async () => {
    const model = await lay(fixture('a-crossing-pair-across-two-tiers-keeps-its-course'));
    const hosts = model.groups.hosts!;
    expect(model.frozenBlockFollowers).toHaveLength(2);
    expect(chordsHold(model, [{ group: hosts, bounds: { ...hosts.bounds!, x: hosts.bounds!.x - 6, width: hosts.bounds!.width + 12 }, dx: 0 }], false)).toBe(true);
    expect(chordsHold(model, [{ group: hosts, bounds: { ...hosts.bounds!, x: hosts.bounds!.x - 6 } }], false)).toBe(false);
    expect(model.groups.hosts!.bounds!.x).toBe(model.groups.lower!.bounds!.x);
    expect(model.groups.hosts!.bounds!.width).toBe(model.groups.lower!.bounds!.width);
    const copy = structuredClone(model);
    copy.groups.lower!.bounds!.x += 60;
    expect(blockReservationsFault(copy)).toContain('box clearance');
    expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow();
    const foreign = await lay(fixture('a-solid-block-enters-beside-a-foreign-group'));
    const forged = structuredClone(foreign), ray = forged.links.find(link => link.solidBlock)!.path!.segments[0]!;
    forged.groups.x!.bounds = { x: (ray.from.x + ray.to.x) / 2 - 10, y: (ray.from.y + ray.to.y) / 2 - 10, width: 20, height: 20 };
    expect(blockReservationsFault(forged)).toContain('box clearance (frame)');
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow();
  });
  it('declines an over-cap block before freeze and restores the main drawing and restore contract', async () => {
    const source = fixture('a-capped-solid-block-prototype-keeps-foreign-boxes');
    const model = await lay(source);
    expect(model.fanFamilies?.some(family => family.kind === 'solid') ?? false).toBe(false);
    expect(model.declinedSolidBlocks?.some(item => item.reason.startsWith('gap-cap:'))).toBe(true);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    baseline.enabled = true;
    try { expect(geometry(model)).toEqual(geometry(await lay(source))); } finally { baseline.enabled = false; }
  });
  it('declines authored lateral faces without granting solid side entry', async () => {
    const source = fixture('a-solid-block-keeps-authored-lateral-faces');
    const model = await lay(source);
    expect(model.declinedSolidBlocks?.map(item => item.reason)).toContain('non-facing-ports');
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
  it('derives frame walls where a proposed whole-canton translation puts them', async () => {
    const model = await lay(canton);
    expect(chordsHold(model, Object.values(model.groups).map(group => ({ group, bounds: { ...group.bounds!, x: group.bounds!.x + 40 } })), false)).toBe(true);
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
