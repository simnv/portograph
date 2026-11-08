import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel, validateLanes } from '../../src/internal.js';
import type { Course, Lane, LayoutLink, LayoutModel } from '../../src/index.js';
import type { Side } from '../../src/model/geometry.js';
import { validateCourseLane, validateCourses } from '../../src/layout/courses.js';
import { findPort } from '../../src/layout/row-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 15 (outside lanes and route-led port sides), phase 1: the data shapes, and the acceptance sheets with
 * pending tests. A test under `it.fails` states the hand-solve outcome of the design (Section 7) and fails today on purpose;
 * the phase that reaches the case turns it into `it`. A test under `it.todo` names a case that no phase of ticket 15 reaches yet.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string): Promise<LayoutModel> => layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

/** The same with no course round: the baseline that the phase-1 shape tests hand-build their courses on. */
const runPlain = (name: string): Promise<LayoutModel> => layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [] });

/** `link-<n>` is the n-th link of the document. */
const link = (model: LayoutModel, n: number): LayoutLink => model.links.find(item => item.id === `link-${n}`)!;
const sideOf = (model: LayoutModel, n: number, end: 'from' | 'to'): Side => findPort(model, link(model, n).attachments![end])!.side!;
/** The corners of a routed or overlay path: where the direction changes between two segments. */
const turns = (model: LayoutModel, n: number): number => {
  const segments = link(model, n).path!.segments;
  const horizontal = (s: { from: { y: number }; to: { y: number } }): boolean => Math.abs(s.from.y - s.to.y) < 1e-6;
  return segments.slice(1).filter((s, i) => horizontal(s) !== horizontal(segments[i]!)).length;
};
const gatesHold = (model: LayoutModel): boolean => Object.values(score(model).snapshot.gates).every(gate => gate.passed);
const counts = (model: LayoutModel) => score(model).snapshot.counts;

const SHEETS = {
  ring: 'a-ring-link-between-the-ends-of-a-row-goes-round-the-outside',
  chord: 'a-sync-chord-through-the-middle-tier-leaves-the-gateway-clear',
  k22: 'a-crossing-pair-across-two-tiers-keeps-its-course',
  mesh: 'a-mesh-across-a-tier-goes-round-the-outside',
  across: 'a-flank-link-across-a-neighbour-enters-a-bundle-envelope',
  rankedFlank: 'a-flank-bundle-into-a-ranked-group-stays-beside-the-frame',
  lowerRank: 'a-lower-rank-under-the-chord-takes-side-faces',
  canton: 'a-link-past-a-canton-runs-in-the-margin',
  around: 'a-flank-link-around-a-neighbour-runs-along-the-core-edge',
  grid: 'a-bundle-in-a-grid-stands-as-a-grid',
  port: 'a-port-with-two-peers-in-two-directions-takes-a-side-per-link',
  buses: 'a-cross-link-with-another-label-keeps-two-buses',
} as const;

describe('the acceptance sheets of ticket 15 lay out and name their links', () => {
  // Every pending test below reads link numbers and port sides; this live test proves that the helpers resolve them today.
  it.each(Object.entries(SHEETS))('%s', async (_key, name) => {
    const model = await run(name);
    expect(model.links.length).toBeGreaterThan(3);
    for (const item of model.links.filter(entry => entry.path !== undefined)) {
      expect(['top', 'right', 'bottom', 'left']).toContain(sideOf(model, Number(item.id.slice(5)), 'from'));
      expect(turns(model, Number(item.id.slice(5)))).toBeGreaterThanOrEqual(0);
    }
  }, 60000);

  // Hand solve 03 has nothing to change: the course plan must leave it alone (Section 7).
  it('03: the K2,2 sheet keeps its one routed crossing', async () => {
    expect(counts(await run(SHEETS.k22)).routed.crossings).toBe(1);
  }, 60000);
});

describe('pending: the hand-solve outcomes (ticket 15, Section 7)', () => {
  // The named phase turns the test on by changing `it.fails` to `it`.
  it('01 (architecture ticket 24, phase 5): the ring closes round the outside with no crossing', async () => {
    expect(counts(await run(SHEETS.ring)).routed.crossings).toBe(0);
  }, 60000);

  // Phase 7 (the user's ruling Q1): an overlay is a straight chord only where a routed chord would be. The chord of S1-T1 would cross the Gateways frame, so it
  // takes a course: each sync link is a bracket in the outer margin, on lateral faces, with 2 turns and no crossing, as the solve.
  it('02 (phase 7): S1-T1 left/left, S2-T2 right/right; overlay turns 8 -> 4', async () => {
    const model = await run(SHEETS.chord);
    expect([sideOf(model, 5, 'from'), sideOf(model, 5, 'to'), sideOf(model, 6, 'from'), sideOf(model, 6, 'to')]).toEqual(['left', 'left', 'right', 'right']);
    expect([turns(model, 5), turns(model, 6)]).toEqual([2, 2]);
    expect(counts(model).overlay.turns).toBe(4);
    expect(counts(model).overlay.crossings.pairs).toBe(0);
    expect(counts(model).routed.crossings).toBe(0);
    expect(model.diagnostics.filter(item => item.code === 'COURSE_SHAPE_LOST')).toEqual([]);
  }, 60000);

  // Architecture ticket 22: the nine mesh links draw as spanning chords, which leaves N2-C1 and C1-S2 poor routes, and the course round takes the two courses of the solve.
  it('04 (phase 4, after the span round): N2-C1 leaves N2 by the top face, C1-S2 enters S2 from the bottom; crossings 19 -> 9, bent 8 -> 2, turns 16 -> 4', async () => {
    const model = await run(SHEETS.mesh);
    expect(sideOf(model, 1, 'from')).toBe('top');
    expect(sideOf(model, 2, 'to')).toBe('bottom');
    expect(counts(model).routed.crossings).toBeLessThanOrEqual(9);
    expect(counts(model).routed.bent).toBe(2);
    expect(counts(model).routed.turns).toBe(4);
    expect(gatesHold(model)).toBe(true);
  }, 60000);

  // Ticket 09 (architecture-2): the flank port keeps its place after the bundle block, so the link is not removed and steps into the top face (2 turns).
  // The step course of the ticket 09 follow-up (`stepRoute`) takes the L into the right face with 1 turn.
  it('05 / 12 D (phase 4): the flank link into the canton member is drawn, not removed, into its right face, with 1 turn', async () => {
    const model = await run(SHEETS.across);
    expect(model.links.filter(item => item.removed === true).map(item => item.id)).toEqual([]);
    expect(sideOf(model, 6, 'to')).toBe('right');
    expect(turns(model, 6)).toBe(1);
  }, 60000);

  it.fails('06 (render ticket, not reached): the flank stands beside the frame and every gate holds', async () => {
    expect(gatesHold(await run(SHEETS.rankedFlank))).toBe(true);
  }, 60000);

  // The user's decision (Q1 is an offer): a course is kept only when the published result is not worse by `unified`. Link 7 (4 turns on main) takes the bracket on
  // lateral faces (2 turns); the three straight chords cannot gain by bent links over both layers, so they stay straight, where the solve brackets all four (overlay
  // bent 1 -> 4, turns 7). The library is better by `unified` than the solve (overlay bent 1, turns 2, crossings 0) and does not draw its faces for links 8 to 10.
  it('07 (phase 7): TS1-C1 takes the left/left bracket (2 turns); the three straight chords stay; overlay bent 1, turns 2, no crossing', async () => {
    const model = await run(SHEETS.lowerRank);
    expect([sideOf(model, 7, 'from'), sideOf(model, 7, 'to'), turns(model, 7)]).toEqual(['left', 'left', 2]);
    for (const n of [8, 9, 10]) expect(turns(model, n)).toBe(0);
    expect(counts(model).overlay.bent).toBe(1);
    expect(counts(model).overlay.turns).toBe(2);
    expect(counts(model).overlay.crossings.pairs).toBe(0);
    expect(counts(model).routed.crossings).toBe(1);
    expect(model.diagnostics.filter(item => item.code === 'COURSE_SHAPE_LOST')).toEqual([]);
  }, 60000);

  it('08 (phase 4): OOB top -> left margin -> SRV 1 left (3 turns)', async () => {
    const model = await run(SHEETS.canton);
    expect([sideOf(model, 6, 'from'), sideOf(model, 6, 'to'), turns(model, 6)]).toEqual(['top', 'left', 3]);
    expect([sideOf(model, 7, 'from'), sideOf(model, 7, 'to')]).toEqual(['right', 'top']);
  }, 60000);

  // The solve drops the link straight into SRV 2 (1 turn). The aligned perimeter lane is a feed of 7c (`centringFeeds`), so SRV 2 is seated under it.
  it('08 (phase 4): OOB right -> drop -> SRV 2 top (1 turn), and no course loses its shape', async () => {
    const model = await run(SHEETS.canton);
    expect(turns(model, 7)).toBe(1);
    expect(model.diagnostics.filter(item => item.code === 'COURSE_SHAPE_LOST')).toEqual([]);
  }, 60000);

  // The solve keeps Mgmt-Dist at 4 turns (right/left). The library takes a column-gap course for both links (6 turns, 1 crossing, against the solve's 7 and 2) and beats the solve.
  it('09 / 12 C (phase 5): Mgmt-Core leaves the bottom face and enters Core left in 3 turns; Mgmt-Dist does the same in 3; G6 holds; the solve is beaten', async () => {
    const model = await run(SHEETS.around);
    expect([sideOf(model, 6, 'from'), sideOf(model, 6, 'to'), turns(model, 6)]).toEqual(['bottom', 'left', 3]);
    expect([sideOf(model, 5, 'from'), sideOf(model, 5, 'to'), turns(model, 5)]).toEqual(['bottom', 'left', 3]);
    expect(counts(model).routed.turns).toBe(6);
    // Ticket 24: the turn round orders the two skirts of the face by their planned first turn, so the self crossing of the far-end order is gone (it was 1).
    expect(counts(model).routed.crossings).toBe(0);
    expect(score(model).snapshot.gates['G6']!.violations).toEqual([]);
  }, 60000);

  it('10 (architecture ticket 23): the farm stands as a 3 x 2 grid, S3 under S2, and the bundle turns to bottom/top and runs straight', async () => {
    const model = await run(SHEETS.grid);
    const boxes = ['s1', 's2', 's3', 's4', 's5', 's6'].map(id => model.nodes[id]!.bounds!);
    expect(new Set(boxes.map(box => Math.round(box.x))).size).toBe(3);
    expect(new Set(boxes.map(box => Math.round(box.y))).size).toBe(2);
    expect(model.nodes.s3!.bounds!.x).toBe(model.nodes.s2!.bounds!.x);
    expect(model.nodes.s3!.bounds!.y).toBeGreaterThan(model.nodes.s2!.bounds!.y);
    expect([3, 4].map(n => [sideOf(model, n, 'from'), sideOf(model, n, 'to')])).toEqual([['bottom', 'top'], ['bottom', 'top']]);
    expect(counts(model).routed).toMatchObject({ links: 4, bent: 0, turns: 0, crossings: 0 });
    expect(model.diagnostics.filter(item => item.code === 'GRID_BUNDLE_STACKED')).toHaveLength(1);
    expect(model.diagnostics.filter(item => item.code === 'GROUP_SHAPE_DECLINED')).toEqual([]);
    expect(gatesHold(model)).toBe(true);
  }, 60000);

  it('11 (mesh-bus ticket 21): one trunk in the margin joins the three row buses; no plain overlay link, no crossing', async () => {
    const model = await run('a-sync-mesh-on-three-rows-has-one-trunk-in-the-margin');
    const head = model.meshBuses!.find(bus => bus.trunk !== undefined)!;
    expect(head.trunk!.buses).toHaveLength(3);
    expect(head.cross).toHaveLength(27);
    expect(counts(model).overlay.links).toBe(0);
    expect(counts(model).overlay.crossings).toEqual({ pairs: 0, points: 0 });
    expect(counts(model).overlay.turns).toBe(0);
    expect(gatesHold(model)).toBe(true);
  }, 60000);

  it('12 (phase 6): the uplink meets the trunk pill from above; it has 2 turns, and the port keeps one side', async () => {
    const model = await run(SHEETS.port);
    expect(link(model, 1).approach).toEqual({ to: 'top' });
    expect(turns(model, 1)).toBe(2);
    expect(sideOf(model, 1, 'to')).toBe(sideOf(model, 2, 'to'));
    expect(model.diagnostics.some(item => item.code === 'SHARED_PORT')).toBe(true);
  }, 60000);

  // Known to fail since snack-theme ticket 157: with the Verdana metrics the sheet publishes 6 bent overlays, not 4. Ticket 160
  // (.scratch/snack-theme/issues/160-a-chord-move-is-judged-on-the-nested-ports.md) owns the cause. `it.fails` keeps the suite green and
  // reports this test once 160 brings the count back to 4; then make it a plain `it` again.
  it.fails('ticket 14 note, phase 3b: a-cross-link-with-another-label-keeps-two-buses publishes 4 bent overlays', async () => {
    const model = await run(SHEETS.buses);
    // 5 with the side hint on b2 before architecture-2 ticket 23. The overlay ports of a face now nest at the end of 7f (with their
    // direct links), and the baseline has the 4 bent overlays without the hint, so the side round takes none.
    expect(counts(model).overlay.bent).toBe(4);
    expect(model.diagnostics.some(item => item.code === 'SIDE_HINT_TAKEN')).toBe(false);
  }, 60000);
});

describe('the course shapes restore and round-trip (ticket 15, phase 1)', () => {
  // The shared-port sheet: link 2 (fw -> sw.trunk) meets a port that link 1 also uses.
  const stored = async (): Promise<{ json: LayoutModel; course: Course; link: LayoutLink }> => {
    const model = await runPlain(SHEETS.port);
    const json = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const side = sideOf(model, 1, 'from');
    const course: Course = { link: 'link-1', kind: 'shared-port', from: { face: side }, to: { face: sideOf(model, 1, 'to'), approach: 'top' }, runs: ['tier-gap'] };
    return { json, course, link: json.links.find(item => item.id === 'link-1')! };
  };
  const withCourses = (model: LayoutModel, courses: Course[], links: Record<string, LayoutLink['approach']>): string => {
    const copy = structuredClone(model) as LayoutModel;
    copy.courses = courses; copy.freeze!.courses = structuredClone(courses);
    for (const item of copy.links) { const approach = links[item.id]; if (approach !== undefined) item.approach = approach; }
    return JSON.stringify(copy);
  };

  it('a layout without courses restores unchanged and carries no courses', async () => {
    const { json } = await stored();
    expect(json.courses).toBeUndefined();
    expect(json.freeze!.courses).toBeUndefined();
    const restored = restoreLayoutModel(JSON.stringify(json));
    expect(restored.courses).toBeUndefined();
    expect(restored.links.every(item => item.approach === undefined)).toBe(true);
  }, 60000);

  it('a course with an approach on a shared named port restores and survives a second round trip', async () => {
    // The layout itself takes the course (phase 6), so its junctions, stems and path already agree with the approach.
    const taken = JSON.parse(JSON.stringify(await run(SHEETS.port))) as LayoutModel;
    const course = taken.courses!.find(item => item.link === 'link-1')!;
    expect(course.to.approach).toBe('top');
    const restored = restoreLayoutModel(JSON.stringify(taken));
    expect(restored.courses).toEqual(taken.courses);
    expect(restored.freeze!.courses).toEqual(taken.courses);
    expect(restored.links.find(item => item.id === 'link-1')!.approach).toEqual({ to: 'top' });
    expect(restoreLayoutModel(JSON.stringify(restored)).courses).toEqual(taken.courses);
  }, 60000);

  it.each<[string, (course: Course) => Course | undefined, Record<string, LayoutLink['approach']>]>([
    ['a face that is not the port side', course => ({ ...course, to: { ...course.to, face: course.to.face === 'left' ? 'right' : 'left' } }), { 'link-1': { to: 'top' } }],
    ['an approach on the port axis', course => ({ ...course, to: { ...course.to, approach: course.to.face } }), { 'link-1': { to: 'top' } }],
    ['an approach on an anonymous port', course => ({ ...course, from: { ...course.from, approach: 'top' } }), { 'link-1': { to: 'top', from: 'top' } }],
    ['an approach the link does not repeat', course => course, {}],
    ['a course for an unknown link', course => ({ ...course, link: 'link-99' }), { 'link-1': { to: 'top' } }],
    ['an overlay course on a routed link', course => ({ ...course, kind: 'overlay' }), { 'link-1': { to: 'top' } }],
    ['a course with no runs', course => ({ ...course, runs: [] }), { 'link-1': { to: 'top' } }],
  ])('refuses %s', async (_name, change, approaches) => {
    const { json, course } = await stored();
    const bad = change(course)!;
    expect(() => restoreLayoutModel(withCourses(json, [bad], approaches))).toThrow();
  }, 60000);

  it('refuses an approach on a named port that no other link shares', async () => {
    const { json, course } = await stored();
    // Move link 2 off the trunk port: link 1 is then the only link at a named port, so the check on shared ports is the one that fires.
    const alone = structuredClone(json) as LayoutModel;
    alone.links.find(item => item.id === 'link-2')!.attachments!.to = { ...alone.links.find(item => item.id === 'link-2')!.attachments!.to, ordinal: 99 };
    expect(() => validateCourses(alone)).not.toThrow();
    alone.courses = [course];
    alone.links.find(item => item.id === 'link-1')!.approach = { to: 'top' };
    expect(() => validateCourses(alone)).toThrow(/no other link shares/);
  }, 60000);

  it('refuses an approach on a link with no course, and courses that differ from the frozen ones', async () => {
    const { json, course } = await stored();
    const loose = structuredClone(json) as LayoutModel;
    loose.links.find(item => item.id === 'link-1')!.approach = { to: 'top' };
    expect(() => restoreLayoutModel(JSON.stringify(loose))).toThrow(/approach/);
    const drift = structuredClone(json) as LayoutModel;
    drift.courses = [course];
    expect(() => restoreLayoutModel(JSON.stringify(drift))).toThrow(/Frozen courses/);
  }, 60000);

  it('refuses two courses for one link', async () => {
    const { json, course } = await stored();
    expect(() => restoreLayoutModel(withCourses(json, [course, course], { 'link-1': { to: 'top' } }))).toThrow(/two courses/);
  }, 60000);
});

describe('the lane shapes of a course (ticket 15, phase 1)', () => {
  type Over = { [K in keyof Lane]?: Lane[K] | undefined };
  const lane = (model: LayoutModel, over: Over): Lane => ({
    id: 'perimeter:link-1', kind: 'perimeter', owner: { kind: 'link', id: 'link-1' }, layer: 'routed', group: Object.keys(model.groups)[0]!, tier: 0, side: 'left',
    span: { top: 0, bottom: 2 }, ring: 0, x: 0, bounds: { x: 0, y: 0, width: 11.5, height: 10 }, ...over,
  } as Lane);
  const planned = async (): Promise<LayoutModel> => {
    const model = structuredClone(await runPlain(SHEETS.port)) as LayoutModel;
    model.courses = [{ link: 'link-1', kind: 'transit', from: { face: sideOf(model, 1, 'from') }, to: { face: sideOf(model, 1, 'to') }, runs: ['perimeter'] }];
    return model;
  };

  it('accepts a perimeter lane and a column-gap lane with their fields', async () => {
    const model = await planned();
    expect(() => validateCourseLane(model, lane(model, {}))).not.toThrow();
    expect(() => validateCourseLane(model, lane(model, { id: 'gap-lane:link-1:0', kind: 'gap', ring: undefined }))).not.toThrow();
  }, 60000);

  it.each<[string, Over]>([
    ['a perimeter id of another link', { id: 'perimeter:link-4' }],
    ['a gap id with no ordinal', { id: 'gap-lane:link-1:', kind: 'gap', ring: undefined }],
    ['a span that is not ordered', { span: { top: 2, bottom: 0 } }],
    ['no span', { span: undefined }],
    ['a perimeter lane with no ring', { ring: undefined }],
    ['a gap lane with a ring', { id: 'gap-lane:link-1:0', kind: 'gap' }],
    ['an owner with no course', { owner: { kind: 'link', id: 'link-6' }, id: 'perimeter:link-6' }],
  ])('refuses %s', async (_name, over) => {
    const model = await planned();
    expect(() => validateCourseLane(model, lane(model, over))).toThrow();
  }, 60000);

  it('validateLanes checks the shape of a course lane and leaves the transit reservations as they were', async () => {
    const model = await planned();
    const before = model.lanes.length;
    expect(() => validateLanes(model)).not.toThrow();
    model.lanes.push(lane(model, { span: { top: 2, bottom: 0 } }));
    expect(() => validateLanes(model)).toThrow(/span/);
    model.lanes.pop();
    expect(model.lanes).toHaveLength(before);
  }, 60000);
});
