import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, restoreLayoutModel, score } from '../../src/index.js';
import type { Course, LayoutLink, LayoutModel } from '../../src/index.js';
import { overlayChordAdmitted } from '../../src/layout/frame-paths.js';
import { judgeOverlayTrial, measureOverlayCourses } from '../../src/layout/course-measure.js';
import { overlayEndpoint } from '../../src/layout/overlay-paths.js';
import { findPort } from '../../src/layout/row-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 15, phase 7 (the user's ruling Q1): an overlay link is a straight chord only where a routed chord would be; every other overlay between two
 * sub-tiers gets a planned course on side faces, reserved in placement (a perimeter lane of the overlay layer, padding rows) and drawn from the lane.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const SHEETS = {
  chord: 'a-sync-chord-through-the-middle-tier-leaves-the-gateway-clear',
  rank: 'a-lower-rank-under-the-chord-takes-side-faces',
  straight: 'an-overlay-chord-that-a-routed-chord-would-take-stays-straight',
  port: 'a-port-with-two-peers-in-two-directions-takes-a-side-per-link',
} as const;
const run = (name: string, extra: Parameters<typeof layout>[1] = {}): Promise<LayoutModel> =>
  layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...extra });
/** The same sheet with the overlay round off: the layout that main made before the rule of Q1. */
const before = (name: string): Promise<LayoutModel> => run(name, { testOverlayCourses: false });
const link = (model: LayoutModel, n: number): LayoutLink => model.links.find(item => item.id === `link-${n}`)!;
const overlays = (model: LayoutModel): LayoutLink[] => model.links.filter(item => item.layer === 'overlay');
const turnsOf = (item: LayoutLink): number => {
  const segments = item.path!.segments, horizontal = (s: { from: { y: number }; to: { y: number } }): boolean => Math.abs(s.from.y - s.to.y) < 1e-6;
  return segments.slice(1).filter((s, i) => horizontal(s) !== horizontal(segments[i]!)).length;
};
const pure = (model: LayoutModel): string => { const copy: Partial<LayoutModel> = { ...model }; delete copy.runtime; return JSON.stringify(copy); };

describe('the admission rule of Q1', () => {
  it('refuses the chords that cross a foreign frame or a rank cell, and admits the chord with nothing on it', async () => {
    const chord = await before(SHEETS.chord), rank = await before(SHEETS.rank), straight = await before(SHEETS.straight);
    expect(overlays(chord).map(item => overlayChordAdmitted(chord, item))).toEqual([false, false]);
    // 07: three of the four chords are straight on main, and each one crosses the load balancers' rank cell.
    expect(overlays(rank).filter(item => item.path!.segments.length === 1)).toHaveLength(3);
    expect(overlays(rank).map(item => overlayChordAdmitted(rank, item))).toEqual([false, false, false, false]);
    expect(overlays(straight).map(item => overlayChordAdmitted(straight, item))).toEqual([true]);
  }, 60000);

  it('leaves an admitted chord straight, with no course, no lane and no re-run for it', async () => {
    const model = await run(SHEETS.straight);
    expect(link(model, 2).path!.segments).toHaveLength(1);
    expect(model.courses).toBeUndefined();
    expect(model.lanes.filter(lane => lane.kind === 'perimeter')).toEqual([]);
    expect(pure(model)).toBe(pure(await before(SHEETS.straight)));
  }, 60000);
});

describe('the offer', () => {
  it('offers a course only to a refused overlay that the baseline bent and the course unbends', async () => {
    const base = await before(SHEETS.rank);
    const offer = measureOverlayCourses(base, base);
    // 07: link 7 has 4 turns on main and gains; links 8, 9 and 10 are straight, so no course can gain by the unified order and none is offered.
    expect([...offer.promised].map(([id, item]) => [id, item.turns, item.base])).toEqual([['link-7', 2, 4]]);
    expect(offer.courses).toMatchObject([{ link: 'link-7', kind: 'overlay', side: 'left', from: { face: 'left' }, to: { face: 'left' }, runs: ['perimeter'] }]);
    const chord = await before(SHEETS.chord);
    expect([...measureOverlayCourses(chord, chord).promised.values()]).toEqual([{ turns: 2, base: 4 }, { turns: 2, base: 4 }]);
  }, 60000);

  it('offers nothing for an overlay that no routed chord would refuse', async () => {
    const base = await before(SHEETS.straight);
    expect(measureOverlayCourses(base, base).courses).toEqual([]);
  }, 60000);
});

describe('the course, reserved and drawn', () => {
  it('02: a lane of the overlay layer stands in each margin, and the path is the lane\'s geometry from face to face', async () => {
    const model = await run(SHEETS.chord);
    const lanes = model.lanes.filter(lane => lane.kind === 'perimeter');
    expect(lanes.map(lane => [lane.id, lane.layer, lane.side, lane.ring])).toEqual([['perimeter:link-5', 'overlay', 'left', 0], ['perimeter:link-6', 'overlay', 'right', 0]]);
    for (const item of overlays(model)) {
      const lane = lanes.find(entry => entry.owner.kind === 'link' && entry.owner.id === item.id)!, segments = item.path!.segments;
      // The router never sees an overlay: it reserves no fixed segment, and the path is derived from the lane.
      expect(item.fixedSegments).toBeUndefined();
      expect(segments).toHaveLength(3);
      expect(segments[1]!.from.x).toBe(lane.x);
      for (const [ref, point] of [[item.attachments!.from, segments[0]!.from], [item.attachments!.to, segments.at(-1)!.to]] as const) {
        const end = overlayEndpoint(model.nodes[ref.node], findPort(model, ref));
        expect(point).toEqual(end);
      }
    }
    expect(model.courses!.every(course => course.kind === 'overlay')).toBe(true);
    expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);

  // The user's decision keeps the three straight chords of 07, so the four brackets of the solve are forced here to test the nesting.
  it('07, forced: the brackets of one margin nest, the outer one leaves the upper slot of the face, and no run crosses another', async () => {
    const courses: Course[] = [
      { link: 'link-9', kind: 'overlay', side: 'right', from: { face: 'right' }, to: { face: 'top' }, runs: ['perimeter', 'tier-gap'] },
      { link: 'link-10', kind: 'overlay', side: 'right', from: { face: 'right' }, to: { face: 'right' }, runs: ['perimeter'] },
      { link: 'link-7', kind: 'overlay', side: 'left', from: { face: 'left' }, to: { face: 'left' }, runs: ['perimeter'] },
      { link: 'link-8', kind: 'overlay', side: 'left', from: { face: 'left' }, to: { face: 'bottom' }, runs: ['perimeter', 'padding'] },
    ];
    const model = await run(SHEETS.rank, { testCourses: courses });
    const ring = (id: string): number => model.lanes.find(lane => lane.id === `perimeter:${id}`)!.ring!;
    expect(ring('link-8')).toBeGreaterThan(ring('link-7'));
    const y = (n: number): number => link(model, n).path!.segments[0]!.from.y;
    expect(y(8)).toBeLessThan(y(7));
    expect(score(model).snapshot.counts.overlay.crossings.pairs).toBe(0);
  }, 60000);

  it('restores from its JSON with the overlay courses and the lanes of the overlay layer', async () => {
    const model = await run(SHEETS.chord);
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(restored.courses).toEqual(model.courses);
    expect(restored.lanes.filter(lane => lane.kind === 'perimeter').map(lane => [lane.id, lane.layer, lane.x])).toEqual(model.lanes.filter(lane => lane.kind === 'perimeter').map(lane => [lane.id, lane.layer, lane.x]));
    for (const item of overlays(restored)) expect(item.path!.segments).toEqual(link(model, Number(item.id.slice(5))).path!.segments);
  }, 60000);
});

describe('the round', () => {
  it('shares the re-runs: with none left it takes no course, and an admitted chord stays', async () => {
    const none = await run(SHEETS.chord, { testMaxReruns: 0 });
    expect(turnsOf(link(none, 5))).toBe(4);
    expect(turnsOf(link(await run(SHEETS.chord), 5))).toBe(2);
    const straight = await run(SHEETS.straight);
    expect(pure(straight)).toBe(pure(await before(SHEETS.straight)));
  }, 60000);

  it('names each course it takes, and loses no promise', async () => {
    const model = await run(SHEETS.chord);
    expect(model.diagnostics.filter(item => item.code === 'COURSE_TAKEN').map(item => (item.owners![0] as { id: string }).id).sort()).toEqual(['link-5', 'link-6']);
    expect(model.diagnostics.filter(item => item.code === 'COURSE_SHAPE_LOST')).toEqual([]);
  }, 60000);
});

describe('the judge of the overlay trial', () => {
  it('keeps the trial that gives the promised turns and costs the routed layer nothing', async () => {
    const base = await before(SHEETS.chord), trial = await run(SHEETS.chord), offer = measureOverlayCourses(base, base);
    expect(judgeOverlayTrial(base, trial, offer)).toMatchObject({ kept: true });
  }, 60000);

  it('refuses a trial whose course publishes more turns than it promised', async () => {
    const base = await before(SHEETS.chord), trial = await run(SHEETS.chord), offer = measureOverlayCourses(base, base);
    const greedy = { ...offer, promised: new Map([...offer.promised].map(([id, item]) => [id, { ...item, turns: 1 }] as const)) };
    const verdict = judgeOverlayTrial(base, trial, greedy);
    expect(verdict.kept).toBe(false);
    expect(verdict.reason).toContain('more turns than it promised');
  }, 60000);

  it('refuses a trial that bends, or crosses, more routed links than the baseline, whatever the overlay layer gains', async () => {
    // Sheet 12: the baseline keeps the approach (2 turns); the trial is the same sheet with no course (3 turns).
    const kept = await run(SHEETS.port), plain = await run(SHEETS.port, { testCourses: [] });
    const verdict = judgeOverlayTrial(kept, plain, { courses: [], promised: new Map() });
    expect(verdict.kept).toBe(false);
    expect(verdict.reason).toContain('routed layer is worse');
  }, 60000);
});
