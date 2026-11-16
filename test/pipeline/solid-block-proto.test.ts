import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { chordsHold, edgeLeavers, fixedPointRefusal } from '../../src/layout/frame-paths.js';
import { blockReservationsFault } from '../../src/layout/block-checks.js';
import { admitFanFamilies } from '../../src/layout/fan-admission.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

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
const generator = fileURLToPath(new URL('../../scripts/gen-fabric.mjs', import.meta.url));
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
// These five review probes use one-line records; node declaration order is meaningful for block ties.
const reviewFixtures = [
  'a-solid-block-keeps-the-box-corner-margin',
  'a-solid-block-enters-beside-a-foreign-group',
  'a-solid-block-spans-two-far-groups',
  'a-solid-block-proves-the-cap-before-region-placement',
  'a-solid-block-keeps-authored-lateral-faces',
];
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
  it.each(reviewFixtures)('keeps the review contract with links and nodes reversed: %s', async name => {
    const source = fixture(name), original = score(await lay(source)).snapshot;
    for (const key of ['links', 'nodes'] as const) {
      const input = reversed(source, key), model = await lay(input);
      expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
      if (name.includes('lateral-faces')) {
        expect(model.declinedSolidBlocks?.some(item => item.reason.startsWith('non-facing-ports'))).toBe(true);
        baseline.enabled = true;
        try { expect(geometry(model)).toEqual(geometry(await lay(input))); } finally { baseline.enabled = false; }
      } else {
        expect(model.fanFamilies?.filter(item => item.kind === 'solid')).toHaveLength(1);
        expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(name.includes('two-far') ? 8 : name.includes('proves-the-cap') ? 12 : 4);
        expect(blockReservationsFault(model)).toBeUndefined();
        const snapshot = score(model).snapshot;
        expect(snapshot.metrics.crossings.count).toBe(original.metrics.crossings.count);
        expect(snapshot.counts.routed.turns).toBe(original.counts.routed.turns);
        expect(Object.values(snapshot.gates).filter(gate => gate.severity === 'error' && gate.violations.length)).toEqual([]);
      }
    }
  });
  it('declines a follower seat before it occupies a sibling box', async () => {
    const model = await placed(fixture('a-solid-block-follower-seat-keeps-its-siblings'));
    expect(model.diagnostics.some(item => item.code === 'BLOCK_FOLLOWER_SEAT_DECLINED' && item.message.includes('sibling-spacing'))).toBe(true);
    const a = model.groups.ha!.bounds!, b = model.groups.hb!.bounds!;
    expect(Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width)).toBeGreaterThanOrEqual(60 - 1e-6);
    expect(model.blockFollowers).toEqual([]);
  });
  it('declines conflicting follower rows together instead of accepting the first', async () => {
    const source = fixture('a-solid-block-spans-two-far-groups')
      .replace('host-one-with-a-long-name', 'host-one').replace('host-two-with-a-long-name', 'host-two')
      .replace('from: l2, to: h2', 'from: l3, to: h2').replace('from: l3, to: h3', 'from: l2, to: h3');
    for (const input of [source, reversed(source, 'links')]) {
      const model = await placed(input);
      const declined = model.diagnostics.filter(item => item.code === 'BLOCK_FOLLOWER_SEAT_DECLINED' && item.message.includes('sibling-spacing'));
      expect(declined.flatMap(item => item.owners?.map(owner => 'id' in owner ? owner.id : undefined) ?? []).sort()).toEqual(['ha', 'hb']);
      expect(model.blockFollowers).toEqual([]);
    }
  });
  it('keeps blocks when the unrelated rerun budget is zero', async () => {
    const model = await layout(parse(canton), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testMaxReruns: 0 });
    expect(model.fanFamilies?.filter(family => family.kind === 'solid')).toHaveLength(1);
  });
  it('keeps a block past the cap straight and flatter, its gap set by the aspect aim (dense-16x9 ticket 04, slice 3)', async () => {
    // Stage 5 no longer proves the cap: past it the block stays, and 7e reserves the floor and the aspect choice.
    const model = await lay(fixture('a-solid-block-proves-the-cap-before-region-placement'));
    const record = model.blockReservations?.[0];
    expect(model.declinedSolidBlocks).toBeUndefined();
    expect(record?.mode).toBe('flat');
    expect(record!.target).toBeGreaterThan(record!.cap);
    expect(record!.floor!).toBeLessThan(record!.target);
    // The sheet stays wider than the aim at the 34 degree gap, so the aim takes the whole 34 degree demand.
    expect(record!.chosen).toBeCloseTo(record!.target, 6);
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(12);
    expect(score(model).snapshot.counts.routed.bent).toBe(0);
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
  it('keeps a 2x7 block past the cap straight, and two blocks that share the gap on one chosen gap (dense-16x9 ticket 04, slice 3)', async () => {
    const one = await lay(fixture('a-two-by-seven-block-past-the-cap-stays-straight'));
    expect(one.blockReservations?.map(item => item.mode)).toEqual(['flat']);
    expect(one.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(14);
    expect(score(one).snapshot.counts.routed.bent).toBe(0);
    const two = await lay(fixture('two-blocks-share-one-gap-past-the-cap'));
    const records = two.blockReservations ?? [];
    expect(records.map(item => item.mode ?? 'steep').sort()).toEqual(['flat', 'steep']);
    // One tier gap, one chosen height: the steep block holds the flat block's gap too (by max).
    expect(new Set(records.map(item => item.chosen)).size).toBe(1);
    expect(blockReservationsFault(two)).toBeUndefined();
    expect(Object.values(score(two).snapshot.gates).filter(gate => gate.severity === 'error' && gate.violations.length)).toEqual([]);
  });
  it('lets a flat member fall back alone when the aspect gap is below its box entry (dense-16x9 ticket 04, slice 3)', async () => {
    const model = await lay(fixture('a-flat-block-member-that-leaves-its-box-by-a-side-falls-back'));
    const record = model.blockReservations![0]!;
    expect(record.mode).toBe('flat');
    expect(record.chosen).toBeGreaterThan(record.floor! + 1);
    expect(record.chosen).toBeLessThan(record.target - 1);
    const reasons = (model.fanAdmissions ?? []).filter(item => item.mode !== 'straight').map(item => item.reason);
    expect(reasons).toContain('edge');
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight').length).toBeGreaterThan(0);
    expect(blockReservationsFault(model)).toBeUndefined();
    // Every straight member keeps the 15 degree floor.
    for (const link of model.links.filter(item => item.solidBlock && model.frozenChords?.includes(item.id))) {
      const segment = link.path!.segments[0]!;
      expect(Math.abs(segment.to.y - segment.from.y)).toBeGreaterThanOrEqual(Math.abs(segment.to.x - segment.from.x) * Math.tan(15 * Math.PI / 180) - 1e-6);
    }
  });
  it('keeps an over-cap block flat and straight beside foreign boxes, and the restore contract (dense-16x9 ticket 04, slice 3)', async () => {
    const source = fixture('a-capped-solid-block-prototype-keeps-foreign-boxes');
    const model = await lay(source);
    expect(model.declinedSolidBlocks).toBeUndefined();
    expect(model.blockReservations?.map(item => item.mode)).toEqual(['flat']);
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(36);
    expect(blockReservationsFault(model)).toBeUndefined();
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  });
  it('declines authored lateral faces without granting solid side entry', async () => {
    const source = fixture('a-solid-block-keeps-authored-lateral-faces');
    const model = await lay(source);
    expect(model.declinedSolidBlocks?.map(item => item.reason)).toContain('non-facing-ports');
    baseline.enabled = true;
    try { expect(geometry(model)).toEqual(geometry(await lay(source))); } finally { baseline.enabled = false; }
  });
  it('reserves blocks that share nodes together (dense-16x9 ticket 04, slice 2)', async () => {
    const model = await lay(fixture('solid-blocks-that-share-nodes-are-reserved-together'));
    expect(model.diagnostics.filter(item => item.code === 'SOLID_BLOCK_DECLINED')).toEqual([]);
    expect(model.fanFamilies?.filter(family => family.kind === 'solid').map(family => family.id).sort()).toEqual(['block:middle:2:', 'block:upper:1:']);
    expect(model.blockReservations?.map(item => item.family).sort()).toEqual(['block:middle:2:', 'block:upper:1:']);
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(8);
    expect(blockReservationsFault(model)).toBeUndefined();
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  });
  it('finds a block between adjacent ranks of one group (dense-16x9 ticket 04, slice 2)', async () => {
    const source = fixture('a-solid-block-between-two-ranks-of-one-group');
    for (const input of [source, reversed(source, 'links'), reversed(source, 'nodes')]) {
      const model = await lay(input);
      const families = model.fanFamilies?.filter(family => family.kind === 'solid') ?? [];
      expect(families.map(family => [family.id, [...family.hubs].sort(), family.members.length])).toEqual([['block:stack#0:stack#1:', ['x1', 'x2'], 6]]);
      expect(model.blockReservations?.map(item => item.family)).toEqual(['block:stack#0:stack#1:']);
      expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(6);
      expect(score(model).snapshot.counts.routed.bent).toBe(0);
    }
  });
  it('finds a block complete at the far-group level, and asks for every far node with one far group (slice 2)', async () => {
    const model = await lay(fixture('a-solid-block-reaches-every-far-group'));
    const family = model.fanFamilies?.find(item => item.kind === 'solid');
    expect(family?.members.map(member => member.unit).sort()).toEqual(['la', 'la', 'lb', 'lb']);
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(4);
    // One far group: s1 and s2 each reach one of its two nodes, which is no complete block.
    const one = `portograph: 2
groups: { spines: { tier: 0 }, la: { tier: 1 } }
nodes: { s1: { group: spines }, s2: { group: spines }, l1: { group: la }, l2: { group: la } }
links: [[s1, l1], [s2, l2]]
`;
    expect((await lay(one)).fanFamilies?.some(item => item.kind === 'solid') ?? false).toBe(false);
  });
  it('lets a block chord cross a fallback leg beyond its stem only (the stem rule, slice 2)', async () => {
    const source = fixture('a-step-keeps-the-vertical-it-reached');
    const model = await lay(source);
    const members = model.links.filter(link => link.solidBlock);
    // Main refused block members by the whole fallback legs of a neighbouring block's members (the leg cascade); the stem rule keeps all straight.
    expect(members).toHaveLength(12);
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(12);
    // A forged fallback of one member: each other member chord that spans its leg is held exactly when it crosses the leg beyond the stem
    // (with a fan record), and the same chord without the record keeps the whole-leg clearance.
    let seen = 0;
    for (const other of members) for (const link of members) {
      if (link === other) continue;
      const copy = JSON.parse(JSON.stringify(model)) as typeof model;
      const fallback = copy.links.find(item => item.id === other.id)!;
      fallback.technique = 'orthogonal';
      delete fallback.path;
      const chord = copy.links.find(item => item.id === link.id)!, segment = chord.path!.segments[0]!;
      const held = fixedPointRefusal(copy, chord, segment);
      delete chord.fanFamily;
      const plain = fixedPointRefusal(copy, chord, segment);
      if (held === undefined && plain === 'leg') seen++;
      expect(held === undefined || plain !== undefined).toBe(true);
    }
    expect(seen).toBeGreaterThan(0);
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
    const [hosts, mode] = name.split('-') as [string, string];
    const source = execFileSync(process.execPath, [generator, '--spines', '4', '--leafs', '8', '--hostsPerLeaf', hosts.slice(1), '--mode', mode], { encoding: 'utf8' });
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
