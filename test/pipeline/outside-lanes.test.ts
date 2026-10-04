import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, restoreLayoutModel, score, validateLanes } from '../../src/index.js';
import type { Course, Lane, LayoutLink, LayoutModel } from '../../src/index.js';
import type { Side } from '../../src/model/geometry.js';
import { validateCourseLane } from '../../src/layout/courses.js';
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
  it.fails('01 (follow-up ticket, not phase 4): the ring closes round the outside with no crossing', async () => {
    expect(counts(await run(SHEETS.ring)).routed.crossings).toBe(0);
  }, 60000);

  it.fails('02 (phase 7): S1-T1 left/left, S2-T2 right/right; overlay turns 8 -> 4, crossings 1 -> 0', async () => {
    const model = await run(SHEETS.chord);
    expect([sideOf(model, 5, 'from'), sideOf(model, 5, 'to'), sideOf(model, 6, 'from'), sideOf(model, 6, 'to')]).toEqual(['left', 'left', 'right', 'right']);
    expect(counts(model).overlay.turns).toBe(4);
    expect(counts(model).overlay.crossings.pairs).toBe(0);
  }, 60000);

  it.fails('04 (phase 4): N2-C1 leaves N2 by the top face, C1-S2 enters S2 from the bottom, N1-S2 keeps its lane; crossings 19 -> 9 at most', async () => {
    const model = await run(SHEETS.mesh);
    expect(sideOf(model, 1, 'from')).toBe('top');
    expect(sideOf(model, 2, 'to')).toBe('bottom');
    expect(counts(model).routed.crossings).toBeLessThanOrEqual(9);
    expect(counts(model).routed.bent).toBe(8);
    expect(counts(model).routed.turns).toBe(16);
  }, 60000);

  it.fails('05 / 12 D (phase 4): the flank link into the canton member is drawn, into its right face, with 1 turn', async () => {
    const model = await run(SHEETS.across);
    expect(model.links.filter(item => item.removed === true).map(item => item.id)).toEqual([]);
    expect(sideOf(model, 6, 'to')).toBe('right');
    expect(turns(model, 6)).toBe(1);
  }, 60000);

  it.fails('06 (render ticket, not reached): the flank stands beside the frame and every gate holds', async () => {
    expect(gatesHold(await run(SHEETS.rankedFlank))).toBe(true);
  }, 60000);

  it.fails('07 (phase 7): TS1-C1 left/left, TS1-C2 left/bottom, TS2-C3 right/top', async () => {
    const model = await run(SHEETS.lowerRank);
    expect([sideOf(model, 7, 'from'), sideOf(model, 7, 'to')]).toEqual(['left', 'left']);
    expect([sideOf(model, 8, 'from'), sideOf(model, 8, 'to')]).toEqual(['left', 'bottom']);
    expect([sideOf(model, 10, 'from'), sideOf(model, 10, 'to')]).toEqual(['right', 'top']);
  }, 60000);

  it.fails('08 (phase 4): OOB top -> left margin -> SRV 1 left (3 turns); OOB right -> drop -> SRV 2 top (1 turn)', async () => {
    const model = await run(SHEETS.canton);
    expect([sideOf(model, 6, 'from'), sideOf(model, 6, 'to'), turns(model, 6)]).toEqual(['top', 'left', 3]);
    expect([sideOf(model, 7, 'from'), sideOf(model, 7, 'to'), turns(model, 7)]).toEqual(['right', 'top', 1]);
  }, 60000);

  it.fails('09 / 12 C (phase 5): Mgmt-Core leaves the bottom face and enters Core left in 3 turns; Mgmt-Dist runs the Core-Campus gap in 4; G6 holds', async () => {
    const model = await run(SHEETS.around);
    expect([sideOf(model, 6, 'from'), sideOf(model, 6, 'to'), turns(model, 6)]).toEqual(['bottom', 'left', 3]);
    expect([sideOf(model, 5, 'from'), sideOf(model, 5, 'to'), turns(model, 5)]).toEqual(['right', 'left', 4]);
    expect(score(model).snapshot.gates['G6']!.violations).toEqual([]);
  }, 60000);

  it.fails('10 (grid ticket, not reached): the farm stands as a 3 x 2 grid', async () => {
    const model = await run(SHEETS.grid);
    const boxes = ['s1', 's2', 's3', 's4', 's5', 's6'].map(id => model.nodes[id]!.bounds!);
    expect(new Set(boxes.map(box => Math.round(box.x))).size).toBe(3);
    expect(new Set(boxes.map(box => Math.round(box.y))).size).toBe(2);
  }, 60000);

  it.todo('11 (mesh-bus ticket, after phase 4): one trunk in the left margin joins the three row buses');

  it.fails('12 (phase 6): the uplink meets the trunk pill from above; it has 2 turns, and the port keeps one side', async () => {
    const model = await run(SHEETS.port);
    expect(link(model, 1).approach).toEqual({ to: 'top' });
    expect(turns(model, 1)).toBe(2);
    expect(sideOf(model, 1, 'to')).toBe(sideOf(model, 2, 'to'));
    expect(model.diagnostics.some(item => item.code === 'SHARED_PORT')).toBe(true);
  }, 60000);

  it.fails('ticket 14 note, phase 3b: a-cross-link-with-another-label-keeps-two-buses publishes 5 bent overlays with the side hint on b2', async () => {
    const model = await run(SHEETS.buses);
    expect(counts(model).overlay.bent).toBe(5);
    expect(model.diagnostics.some(item => item.code === 'SIDE_HINT_TAKEN')).toBe(true);
  }, 60000);
});

describe('the course shapes restore and round-trip (ticket 15, phase 1)', () => {
  // The shared-port sheet: link 2 (fw -> sw.trunk) meets a port that link 1 also uses.
  const stored = async (): Promise<{ json: LayoutModel; course: Course; link: LayoutLink }> => {
    const model = await run(SHEETS.port);
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
    const { json, course } = await stored();
    const text = withCourses(json, [course], { 'link-1': { to: 'top' } });
    const restored = restoreLayoutModel(text);
    expect(restored.courses).toEqual([course]);
    expect(restored.freeze!.courses).toEqual([course]);
    expect(restored.links.find(item => item.id === 'link-1')!.approach).toEqual({ to: 'top' });
    expect(restoreLayoutModel(JSON.stringify(restored)).courses).toEqual([course]);
  }, 60000);

  it.each<[string, (course: Course) => Course | undefined, Record<string, LayoutLink['approach']>]>([
    ['a face that is not the port side', course => ({ ...course, to: { ...course.to, face: course.to.face === 'left' ? 'right' : 'left' } }), { 'link-1': { to: 'top' } }],
    ['an approach on the port axis', course => ({ ...course, to: { ...course.to, approach: course.to.face } }), { 'link-1': { to: 'top' } }],
    ['an approach on a port no other link shares', course => ({ ...course, from: { ...course.from, approach: 'top' } }), { 'link-1': { to: 'top', from: 'top' } }],
    ['an approach the link does not repeat', course => course, {}],
    ['a course for an unknown link', course => ({ ...course, link: 'link-99' }), { 'link-1': { to: 'top' } }],
    ['an overlay course on a routed link', course => ({ ...course, kind: 'overlay' }), { 'link-1': { to: 'top' } }],
    ['a course with no runs', course => ({ ...course, runs: [] }), { 'link-1': { to: 'top' } }],
  ])('refuses %s', async (_name, change, approaches) => {
    const { json, course } = await stored();
    const bad = change(course)!;
    expect(() => restoreLayoutModel(withCourses(json, [bad], approaches))).toThrow();
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
    const model = structuredClone(await run(SHEETS.port)) as LayoutModel;
    model.courses = [{ link: 'link-1', kind: 'transit', from: { face: sideOf(model, 1, 'from') }, to: { face: sideOf(model, 1, 'to') }, runs: ['perimeter'] }];
    return model;
  };

  it('accepts a perimeter lane and a column-gap lane with their fields', async () => {
    const model = await planned();
    expect(() => validateCourseLane(model, lane(model, {}))).not.toThrow();
    expect(() => validateCourseLane(model, lane(model, { id: 'gap-lane:link-1:0', kind: 'gap', ring: undefined }))).not.toThrow();
  }, 60000);

  it.each<[string, Over]>([
    ['a perimeter id of another link', { id: 'perimeter:link-2' }],
    ['a gap id with no ordinal', { id: 'gap-lane:link-1:', kind: 'gap', ring: undefined }],
    ['a span that is not ordered', { span: { top: 2, bottom: 0 } }],
    ['no span', { span: undefined }],
    ['a perimeter lane with no ring', { ring: undefined }],
    ['a gap lane with a ring', { id: 'gap-lane:link-1:0', kind: 'gap' }],
    ['an owner with no course', { owner: { kind: 'link', id: 'link-3' }, id: 'perimeter:link-3' }],
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
