import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import type { Course, LayoutLink, LayoutModel, PathSegment } from '../../src/index.js';
import { CourseRefusal, uTurnFacesGap, validateCourses } from '../../src/layout/courses.js';
import { PlacementRefusal } from '../../src/layout/placement-refusal.js';
import { open } from '../../src/pipeline/round.js';
import { course as courseRound } from '../../src/pipeline/rounds.js';
import type { Env } from '../../src/pipeline/env.js';
import type { State } from '../../src/pipeline/state.js';
import { findPort } from '../../src/layout/row-paths.js';
import { endMode, movesPort } from '../../src/layout/course-rows.js';
import { courseOf, tierGapUTurn } from '../../src/layout/course-lanes.js';
import { plannedSegments, tierGapPlans } from '../../src/layout/gap-plan.js';
import { plannedTurns } from '../../src/layout/turn-order.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import { routedStroke } from '../../src/layout/bands.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 06, slice A: the `u-turn` course. A link whose two ports leave one horizontal face is planned as a U part of the tier gap that face looks at
 * (`runs: ['u']`): stage 5 sets both faces, the plan seats the row once into `H` (a low U part hangs from the low boundary, a high one rises from the high boundary),
 * and stage 8 stitches the part tip to tip. Nothing yet offers the course; the tests give it through `testCourses`.
 */
const golden = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const HIGH = 'a-u-turn-course-hangs-a-high-u-part-above-two-top-ports';
const LOW = 'a-u-turn-course-hangs-a-low-u-part-below-two-bottom-ports';
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const uTurn = (link: string, face: 'top' | 'bottom'): Course => ({ link, kind: 'u-turn', from: { face }, to: { face }, runs: ['u'] });
const lay = (text: string, courses: readonly Course[]): Promise<LayoutModel> => layout(parse(text), { ...options, testCourses: courses });
const between = (model: LayoutModel, from: string, to: string): LayoutLink =>
  model.links.find(link => link.attachments !== undefined && [link.attachments.from.node, link.attachments.to.node].sort().join() === [from, to].sort().join())!;
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).flatMap(([id, gate]) => gate.violations.map(item => `${id}:${item.code}`));
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);
const anchorOf = (model: LayoutModel, link: LayoutLink, which: 'from' | 'to') => findPort(model, link.attachments![which])!.anchor!;

/** The published path holds the reserved part: the row and the x of both legs are the plan's, and the legs run from the port to the row (the stem is part of the leg). */
function expectReserved(reserved: readonly PathSegment[], published: readonly PathSegment[]): void {
  expect(published).toHaveLength(reserved.length);
  const xy = (segment: PathSegment): number[] => [segment.from.x, segment.from.y, segment.to.x, segment.to.y];
  expect(xy(published[1]!)).toEqual(xy(reserved[1]!));
  for (const at of [0, 2] as const) expect([published[at]!.from.x, published[at]!.to.x]).toEqual([reserved[at]!.from.x, reserved[at]!.to.x]);
}

/** The plan of the routed model's gap that holds the part of one link, read with the link undrawn again (the plan reads placement). */
function plannedPart(model: LayoutModel, link: LayoutLink) {
  const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
  const own = copy.links.find(item => item.id === link.id)!;
  delete own.path;
  delete own.fixedSegments;
  for (const { gap, plan } of tierGapPlans(copy)) {
    const part = plan.parts.find(item => item.link === link.id);
    if (part !== undefined) return { gap, plan, part };
  }
  return undefined;
}

describe('a u-turn course on top ports: a high U part (dense-16x9 ticket 06)', () => {
  it('draws the link as two legs and one row above the stems, inside the tier gap, and every gate holds', async () => {
    const model = await lay(golden(HIGH), [uTurn('link-3', 'top')]);
    const link = between(model, 'a', 'b'), segments = link.path!.segments;
    expect(link.id).toBe('link-3');
    expect(gates(model)).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
    expect(codes(model).filter(code => code.startsWith('TIER_GAP_PART'))).toEqual([]);
    const [from, to] = [anchorOf(model, link, 'from'), anchorOf(model, link, 'to')];
    expect(segments).toHaveLength(3);
    // Leg, row, leg: the legs stand on the port x, rise from the stems and stop at one row.
    expect([segments[0]!.from.x, segments[0]!.to.x]).toEqual([from.x, from.x]);
    expect([segments[2]!.from.x, segments[2]!.to.x]).toEqual([to.x, to.x]);
    const rowY = segments[1]!.from.y;
    expect(segments[1]!.to.y).toBe(rowY);
    expect(rowY).toBeLessThan(Math.min(from.y, to.y));
    // The row stands in the tier gap: under the band above and above the group box of `row`.
    const src = model.groups['src']!.bounds!, box = model.groups['row']!.bounds!;
    expect(rowY).toBeGreaterThan(src.y + src.height);
    expect(rowY).toBeLessThan(box.y);
    expect(model.courses!.map(item => item.link)).toEqual(['link-3']);
  }, 60000);

  it('is the geometry the plan reserved, a high U part with its row hung above the stems', async () => {
    const model = await lay(golden(HIGH), [uTurn('link-3', 'top')]);
    const link = between(model, 'a', 'b'), found = plannedPart(model, link)!;
    expect([found.part.shape, found.part.boundary]).toEqual(['u', 'high']);
    expectReserved(plannedSegments(found.part, found.gap), link.path!.segments);
    expect(found.plan.crossings).toEqual([]);
    expect(found.plan.residual).toEqual([]);
    expect(found.plan.growth).toBe(0);
    // The part hangs just above the group box that holds its stems, not at the top of the gap: its row keeps the group-edge margin off the box of `row`
    // (the stems stand inside the box, so the margin is the nearer limit, not the clearance above the tips).
    const margin = GROUP_EDGE_LINK_CLEARANCE + routedStroke(model) / 2;
    expect(found.part.rows[0]!).toBeCloseTo(model.groups['row']!.bounds!.y - margin, 6);
  }, 60000);

  it('sets both faces to the course face and owns no lane', async () => {
    const model = await lay(golden(HIGH), [uTurn('link-3', 'top')]);
    const link = between(model, 'a', 'b');
    expect(['from', 'to'].map(which => findPort(model, link.attachments![which as 'from' | 'to'])!.side)).toEqual(['top', 'top']);
    expect(model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id)).toEqual([]);
    expect(courseOf(model, link.id)).toBeUndefined();
    expect(tierGapUTurn(model, link.id)).toBeDefined();
    expect([endMode(uTurn('x', 'top'), 'from'), endMode(uTurn('x', 'top'), 'to'), movesPort(uTurn('x', 'top'), 'from')]).toEqual(['u', 'u', true]);
  }, 60000);

  it('is no routed chord: the link is not drawn as a level segment between the pills', async () => {
    const plain = await layout(parse(golden(HIGH)), options);
    expect(between(plain, 'a', 'b').path!.segments).toHaveLength(1);
    const model = await lay(golden(HIGH), [uTurn('link-3', 'top')]);
    expect(between(model, 'a', 'b').technique).not.toBe('straight');
  }, 60000);

  it('restores, and refuses a forged course', async () => {
    const model = await lay(golden(HIGH), [uTurn('link-3', 'top')]);
    expect(restoreLayoutModel(JSON.stringify(model)).courses).toEqual(model.courses);
    const forge = (change: (course: Course) => void): string => {
      const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
      for (const list of [copy.courses!, copy.freeze!.courses!]) change(list[0]!);
      return JSON.stringify(copy);
    };
    // Two faces that differ, a lateral face, a second run, a run that names a lane or a margin, and an approach each refuse the restore.
    expect(() => restoreLayoutModel(forge(course => { course.to = { face: 'bottom' }; }))).toThrow();
    expect(() => restoreLayoutModel(forge(course => { course.from = { face: 'left' }; course.to = { face: 'left' }; }))).toThrow();
    expect(() => restoreLayoutModel(forge(course => { course.runs = ['u', 'gap']; }))).toThrow(/one run/);
    expect(() => restoreLayoutModel(forge(course => { course.runs = ['perimeter']; }))).toThrow();
    expect(() => restoreLayoutModel(forge(course => { course.runs = ['tier-gap']; }))).toThrow(/one run/);
    // A padding row of the outer edge is not built: the course is refused, not left to the router.
    expect(() => restoreLayoutModel(forge(course => { course.runs = ['padding']; }))).toThrow(/one run/);
  }, 60000);

  it('is the same layout with the links reversed in the document (R3)', async () => {
    const text = golden(HIGH);
    const one = await lay(text, [uTurn('link-3', 'top')]), two = await lay(reversed(text, 'links'), [uTurn('link-3', 'top')]);
    expect(between(two, 'a', 'b').id).toBe('link-3');
    expect(between(two, 'a', 'b').path!.segments.map(item => [item.from.x, item.from.y, item.to.x, item.to.y]))
      .toEqual(between(one, 'a', 'b').path!.segments.map(item => [item.from.x, item.from.y, item.to.x, item.to.y]));
  }, 60000);

  it('plans the first turn of each end toward the other: the left end high, the right end low, both returning', async () => {
    const model = await lay(golden(HIGH), [uTurn('link-3', 'top')]);
    const link = between(model, 'a', 'b'), turns = plannedTurns(model, true);
    const [left, right] = anchorOf(model, link, 'from').x < anchorOf(model, link, 'to').x ? (['from', 'to'] as const) : (['to', 'from'] as const);
    expect(turns.get(portId(link.attachments![left]))).toMatchObject({ turn: 'high', shape: 'return' });
    expect(turns.get(portId(link.attachments![right]))).toMatchObject({ turn: 'low', shape: 'return' });
  }, 60000);
});

describe('a u-turn course on bottom ports: a low U part', () => {
  it('draws the link as two legs and one row below the stems, inside the tier gap, and every gate holds', async () => {
    const model = await lay(golden(LOW), [uTurn('link-1', 'bottom')]);
    const link = between(model, 'a', 'b'), segments = link.path!.segments;
    expect(link.id).toBe('link-1');
    expect(gates(model)).toEqual([]);
    expect(segments).toHaveLength(3);
    const rowY = segments[1]!.from.y, [from, to] = [anchorOf(model, link, 'from'), anchorOf(model, link, 'to')];
    expect(rowY).toBeGreaterThan(Math.max(from.y, to.y));
    const row = model.groups['row']!.bounds!, dst = model.groups['dst']!.bounds!;
    expect(rowY).toBeGreaterThan(row.y + row.height);
    expect(rowY).toBeLessThan(dst.y);
    const found = plannedPart(model, link)!;
    expect([found.part.shape, found.part.boundary]).toEqual(['u', 'low']);
    expectReserved(plannedSegments(found.part, found.gap), segments);
  }, 60000);
});

describe('two u-turn courses on one face row', () => {
  // The members of one row in the order the layout seats them are read from the anchors, so the test does not depend on the order of the declaration.
  const sheet = (links: string): string => `portograph: 2
groups:
  src: { tier: 0 }
  row: { tier: 1 }
nodes:
  s0: { group: src, class: router, ports: [] }
  s1: { group: src, class: router, ports: [] }
  a: { group: row, class: switch, ports: [{ name: p, side: top }] }
  b: { group: row, class: switch, ports: [{ name: p, side: top }] }
  c: { group: row, class: switch, ports: [{ name: p, side: top }] }
  d: { group: row, class: switch, ports: [{ name: p, side: top }] }
  e: { group: row, class: switch, ports: [] }
links:
  - [s0, e]
  - [s1, e]
${links}
`;
  const rowOf = (link: LayoutLink): number => link.path!.segments[1]!.from.y;

  it('let two disjoint U parts share one row, and draw no crossing between them', async () => {
    const text = sheet('  - [a.p, b.p]\n  - [c.p, d.p]');
    const probe = await layout(parse(text), options);
    const ids = ['a-b', 'c-d'].map(pair => between(probe, pair[0]!, pair[2]!).id);
    const model = await lay(text, ids.map(id => uTurn(id, 'top')));
    const [first, second] = [between(model, 'a', 'b'), between(model, 'c', 'd')];
    expect(gates(model)).toEqual([]);
    expect(rowOf(first)).toBeCloseTo(rowOf(second), 6);
    expect(score(model).snapshot.counts.routed.crossings).toBe(0);
  }, 60000);

  it('seat two interleaved U parts on two rows, publish them and remove nothing', async () => {
    const text = sheet('  - [a.p, d.p]\n  - [b.p, c.p]');
    const probe = await layout(parse(text), options);
    const [x, y] = [between(probe, 'a', 'd'), between(probe, 'b', 'c')];
    const model = await lay(text, [uTurn(x.id, 'top'), uTurn(y.id, 'top')]);
    const [one, two] = [between(model, 'a', 'd'), between(model, 'b', 'c')];
    expect(Math.abs(rowOf(one) - rowOf(two))).toBeGreaterThan(11);
    expect(gates(model)).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);
});

describe('the face of a u-turn end keeps the order of the turn (dense-16x9 ticket 06, review 1)', () => {
  // `a` carries a feed from above and the U end of its link to `b` on one top face. In a turn-ordered run the U end turns toward `b`, so it stands on the side of `b`
  // and no leg of the U stands across the feed. The links are named by their ends, so the test does not depend on the order of the declaration.
  const text = `portograph: 2
groups:
  src: { tier: 0 }
  row: { tier: 1 }
nodes:
  s0: { group: src, class: router, ports: [] }
  s1: { group: src, class: router, ports: [] }
  a: { group: row, class: switch, ports: [{ name: p, side: top }] }
  b: { group: row, class: switch, ports: [{ name: p, side: top }] }
  c: { group: row, class: switch, ports: [] }
links:
  - [s0, a]
  - [s0, b]
  - [s1, c]
  - [a.p, b.p]
`;
  it('stands the U end on the side of its far end, whichever way the row seats `b`, with no crossing and every gate holding', async () => {
    const probe = await layout(parse(text), options);
    const id = between(probe, 'a', 'b').id;
    const model = await layout(parse(text), { ...options, testCourses: [uTurn(id, 'top')], testTurnOrder: true });
    const link = between(model, 'a', 'b');
    const own = anchorOf(model, link, link.attachments!.from.node === 'a' ? 'from' : 'to'), other = anchorOf(model, link, link.attachments!.from.node === 'a' ? 'to' : 'from');
    const feed = model.nodes['a']!.ports.find(port => port.ref.name !== 'p')!.anchor!;
    expect(model.turnOrder).toBe(true);
    // The U end of `a` stands on the side of `b`: right of the feed when `b` is on the right, else left.
    expect(Math.sign(own.x - feed.x)).toBe(Math.sign(other.x - own.x));
    expect(gates(model)).toEqual([]);
    expect(score(model).snapshot.counts.routed.crossings).toBe(0);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);
});

describe('a u-turn course on the outer edge of the sheet (review 1)', () => {
  const one = (side: 'top' | 'bottom'): string => `portograph: 2
groups:
  row: { tier: 0 }
nodes:
  a: { group: row, class: switch, ports: [{ name: p, side: ${side} }] }
  b: { group: row, class: switch, ports: [{ name: p, side: ${side} }] }
links:
  - [a.p, b.p]
`;
  it.each(['top', 'bottom'] as const)('is refused on the %s face of the only sub-tier, where no tier gap stands: the router never discovers the row', async side => {
    await expect(lay(one(side), [uTurn('link-1', side)])).rejects.toThrow(/no tier gap/);
  }, 60000);

  it.each(['top', 'bottom'] as const)('is the typed course refusal on the %s face, raised before the first publication, and the course round drops the offer', async side => {
    const error = await lay(one(side), [uTurn('link-1', side)]).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(CourseRefusal);
    expect(error).toBeInstanceOf(PlacementRefusal);
    expect((error as CourseRefusal).code).toBe('course');
    expect((error as CourseRefusal).owners).toEqual([{ kind: 'link', id: 'link-1' }]);
    // The round answers it: `tolerates` withdraws the trial, and `open` returns a refusal at `place` instead of throwing, so the offer is dropped and the run goes on.
    expect(courseRound.tolerates(error, 'place')).toBe(true);
    let trials = 0;
    const env = { reruns: 0, options: {}, timed: <T,>(_label: string, run: () => T): T => run(), place: async (): Promise<never> => { trials++; throw error; } } as unknown as Env;
    const s = { kept: [] } as unknown as State;
    const offer = { courses: [uTurn('link-1', side)], steps: [], promised: new Map() } as unknown as Parameters<typeof courseRound.skip>[2];
    const opened = await open(env, s, { ...courseRound, reserve: () => [] }, offer);
    expect(trials).toBe(1);
    expect(opened).toMatchObject({ at: 'place' });
    expect(s.courseRetry).toBe('none');
  }, 60000);

  it('is refused on the outermost face of a sheet that has a gap on its other side', async () => {
    // The high-U sheet: its `row` has a gap above (a U part there is planned) and none below.
    await expect(lay(golden(HIGH), [uTurn('link-3', 'bottom')])).rejects.toThrow();
  }, 60000);

  it('is refused at the restore when a forged model stands on the outer edge, and a padding row is refused too', async () => {
    const model = await lay(golden(LOW), [uTurn('link-1', 'bottom')]);
    const forge = (change: (copy: LayoutModel) => void): string => { const copy = JSON.parse(JSON.stringify(model)) as LayoutModel; change(copy); return JSON.stringify(copy); };
    // No band below the ends: the face looks at no gap (the model is read by `validateCourses` itself, since a restore also checks the bands).
    const bare = JSON.parse(forge(copy => { copy.tierBands = copy.tierBands.filter(band => band.tier <= model.groups['row']!.tier!); })) as LayoutModel;
    expect(uTurnFacesGap(model, 'link-1', 'bottom')).toBe(true);
    expect(uTurnFacesGap(bare, 'link-1', 'bottom')).toBe(false);
    expect(() => validateCourses(bare)).toThrow(CourseRefusal);
    expect(() => restoreLayoutModel(forge(copy => { for (const list of [copy.courses!, copy.freeze!.courses!]) list[0]!.runs = ['padding']; }))).toThrow(/one run/);
  }, 60000);
});

describe('a forged u-turn course is refused (review 1)', () => {
  const forged = async (change: (copy: LayoutModel) => void): Promise<string> => {
    const model = await lay(golden(HIGH), [uTurn('link-3', 'top')]);
    const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
    change(copy);
    return JSON.stringify(copy);
  };
  it('on two sub-tiers', async () => {
    const text = await forged(copy => { const tiers = copy.groups['src']!.tier!; copy.groups['row']!.tier = tiers; });
    expect(() => restoreLayoutModel(text)).toThrow();
  }, 60000);
  it('on a port that another link shares', async () => {
    const text = await forged(copy => { const own = copy.links.find(link => link.id === 'link-3')!; copy.links.push({ ...JSON.parse(JSON.stringify(own)), id: 'link-9' }); });
    expect(() => restoreLayoutModel(text)).toThrow();
  }, 60000);
  it('with an approach', async () => {
    const text = await forged(copy => { for (const list of [copy.courses!, copy.freeze!.courses!]) list[0]!.from = { face: 'top', approach: 'left' }; });
    expect(() => restoreLayoutModel(text)).toThrow();
  }, 60000);
});
