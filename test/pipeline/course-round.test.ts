import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import type { Course, LayoutLink, LayoutModel } from '../../src/index.js';
import type { Side } from '../../src/model/geometry.js';
import { naturalPolyline, polylineCrossings, polylineTurns, simplify } from '../../src/layout/course-plan.js';
import { judgeCourseTrial, poorRoute } from '../../src/layout/course-measure.js';
import { constraintFindings } from '../../src/layout/trial-findings.js';
import { findPort } from '../../src/layout/row-paths.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 15, phase 4: the course round (`measureCourses`, the stage-5 course input, the trial judge) and the perimeter lane. The stop rule of
 * the redesign of 2026-10-05: (a) the in-scope links match the faces and the turns of the `solve` page, (b) every kept course publishes the turns it
 * promised (`COURSE_SHAPE_LOST` is 0), (c) nothing else gets worse.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const link = (model: LayoutModel, n: number): LayoutLink => model.links.find(item => item.id === `link-${n}`)!;
const side = (model: LayoutModel, n: number, end: 'from' | 'to'): Side => findPort(model, link(model, n).attachments![end])!.side!;
const turns = (model: LayoutModel, n: number): number | undefined => pathBends(link(model, n));
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);

const MESH = 'a-mesh-across-a-tier-goes-round-the-outside';
const ACROSS = 'a-flank-link-across-a-neighbour-enters-a-bundle-envelope';
const CANTON = 'a-link-past-a-canton-runs-in-the-margin';
const AROUND = 'a-flank-link-around-a-neighbour-runs-along-the-core-edge';

describe('the polyline readers', () => {
  it('simplify drops repeated points and collinear middles, and keeps a reversal', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 9 }])).toEqual([{ x: 0, y: 0 }, { x: 0, y: 9 }]);
    expect(polylineTurns([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 0 }])).toBe(2);
    expect(polylineTurns([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 2 }])).toBe(1);
  });

  it.each<[string, { x: number; y: number }, Side, { x: number; y: number }, Side, number]>([
    ['a straight drop', { x: 0, y: 0 }, 'bottom', { x: 0, y: 100 }, 'top', 0],
    ['a step in a gap', { x: 0, y: 0 }, 'bottom', { x: 40, y: 100 }, 'top', 2],
    ['an L into a lateral face', { x: 0, y: 0 }, 'bottom', { x: 60, y: 100 }, 'left', 1],
    ['a U under two nodes', { x: 0, y: 0 }, 'bottom', { x: 80, y: 0 }, 'bottom', 2],
  ])('naturalPolyline: %s', (_name, a, from, b, into, expected) => {
    const points = naturalPolyline(a, from, b, into);
    expect(polylineTurns(points)).toBe(expected);
    expect(points[0]).toEqual(a);
    expect(points.at(-1)).toEqual(b);
  });

  it('counts proper crossings only', () => {
    const across = [{ x: 0, y: 5 }, { x: 10, y: 5 }];
    expect(polylineCrossings(across, [{ x: 5, y: 0 }, { x: 5, y: 10 }])).toBe(1);
    expect(polylineCrossings(across, [{ x: 10, y: 0 }, { x: 10, y: 10 }])).toBe(0);
    expect(polylineCrossings(across, [{ x: 0, y: 5 }, { x: 0, y: 10 }])).toBe(0);
  });
});

describe('which routes the round looks at', () => {
  it.each<[number | undefined, number, boolean]>([
    [undefined, 0, true], [4, 0, true], [2, 3, true], [2, 2, false], [1, 9, false], [0, 9, false],
  ])('a route of %s turns and %s crossings: %s', (bends, crossings, poor) => {
    expect(poorRoute(bends, crossings)).toBe(poor);
  });
});

describe('the course round on the hand-solve sheets (ticket 15, phase 4)', () => {
  // Case 05 and the 12 D fixture. Ticket 09 (architecture-2): the flank port keeps its stage 7b place after the bundle block, so the link is no longer removed
  // and no course is offered (`poorRoute` skips a 2-turn route with no crossing); it enters the top face of the canton member with 2 turns. The 1-turn course
  // into the right face is lost; a narrower course rule to win it back is the follow-up recorded on ticket 09. The course round itself stays covered by the
  // sheets below (08, 04, the flank links around a neighbour).
  it('05 / 12 D: the flank link is drawn, not removed, and enters the top face with 2 turns (ticket 09)', async () => {
    const model = await layout(parse(source(ACROSS)), options);
    expect(model.links.filter(item => item.removed === true)).toEqual([]);
    expect(side(model, 6, 'to')).toBe('top');
    expect(side(model, 6, 'from')).toBe('bottom');
    expect(turns(model, 6)).toBe(2);
    expect(model.courses).toBeUndefined();
    expect(codes(model)).not.toContain('COURSE_SHAPE_LOST');
  }, 60000);

  it('a flank course keeps its lane and its faces when the published model is restored', async () => {
    const model = await layout(parse(source(AROUND)), options);
    expect(model.courses!.map(course => course.link)).toEqual(['link-5', 'link-6']);
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(restored.courses).toEqual(model.courses);
  }, 60000);

  // Case 08: OOB leaves its top face, runs under the title of WAN into the left margin and enters SRV 1 from the left in 3 turns.
  it('08: OOB to SRV 1 leaves the top face, runs in the left margin and enters the left face in 3 turns', async () => {
    const model = await layout(parse(source(CANTON)), options);
    expect([side(model, 6, 'from'), side(model, 6, 'to'), turns(model, 6)]).toEqual(['top', 'left', 3]);
    expect(side(model, 7, 'from')).toBe('right');
    expect(side(model, 7, 'to')).toBe('top');
    // Link 7 drops straight into SRV 2: the aligned lane is a feed of 7c, so the promise holds (1 turn) and nothing is lost.
    expect(turns(model, 7)).toBe(1);
    expect(codes(model)).not.toContain('COURSE_SHAPE_LOST');
    expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
    // No link goes round the canton and comes back under it: both OOB links and the Core jogs are shorter than the 18 turns of the baseline.
    expect(score(model).snapshot.counts.routed.turns).toBeLessThanOrEqual(8);
    expect(model.canvas!.x).toBeLessThan(0);
  }, 60000);

  // Case 04: the two courses of the solve are reserved when forced, and publish what the lane geometry reserved. The round itself refuses them, because
  // the other mesh links gain two turns (one bottom port fewer on N2 re-spaces the rest): 16 turns become 18 against 19 crossings becoming 9.
  it('04: forced, N2-C1 leaves N2 by the top face and C1-S2 enters S2 from the bottom, 2 turns each', async () => {
    const courses: Course[] = [
      { link: 'link-1', kind: 'skirt', side: 'right', from: { face: 'top' }, to: { face: 'top' }, runs: ['padding', 'perimeter', 'tier-gap'] },
      { link: 'link-2', kind: 'skirt', side: 'right', from: { face: 'bottom' }, to: { face: 'bottom' }, runs: ['tier-gap', 'perimeter', 'padding'] },
    ];
    const model = await layout(parse(source(MESH)), { ...options, testCourses: courses });
    expect([side(model, 1, 'from'), side(model, 1, 'to'), turns(model, 1)]).toEqual(['top', 'top', 2]);
    expect([side(model, 2, 'from'), side(model, 2, 'to'), turns(model, 2)]).toEqual(['bottom', 'bottom', 2]);
    expect(score(model).snapshot.counts.routed.crossings).toBeLessThanOrEqual(9);
    expect(Object.values(score(model).snapshot.gates).filter(gate => !gate.passed).length).toBeLessThanOrEqual(1);
  }, 60000);

  it('04: with no spanning chord, the round refuses the courses and the sheet is as it was', async () => {
    // `testSpanHints: []` leaves the span round out (architecture ticket 22): the nine mesh links keep their lanes, as on main.
    const model = await layout(parse(source(MESH)), { ...options, testSpanHints: [] });
    expect(model.courses).toBeUndefined();
    expect(model.lanes.some(lane => lane.kind === 'perimeter')).toBe(false);
    expect(side(model, 1, 'from')).toBe('bottom');
  }, 60000);

  it('04: after the span round the nine mesh links are chords, and the round takes the two courses (architecture ticket 22)', async () => {
    const model = await layout(parse(source(MESH)), options);
    expect(model.courses?.map(course => course.link)).toEqual(['link-1', 'link-2']);
    expect(model.lanes.filter(lane => lane.kind === 'span')).toHaveLength(9);
    expect([turns(model, 1), turns(model, 2)]).toEqual([2, 2]);
    expect(score(model).snapshot.counts.routed.crossings).toBeLessThanOrEqual(9);
    expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
  }, 60000);

  it('a sheet with no poor route keeps its layout and takes no course', async () => {
    const model = await layout(parse(source('a-crossing-pair-across-two-tiers-keeps-its-course')), options);
    expect(model.courses).toBeUndefined();
    expect(codes(model).filter(code => code.startsWith('COURSE'))).toEqual([]);
  }, 60000);

  // Moved from the 05 / 12 D sheet to a sheet that still takes a course (ticket 09): the budget sharing is the same.
  it('the round shares the re-runs of the side round: with none left it takes no course', async () => {
    const model = await layout(parse(source(AROUND)), { ...options, testMaxReruns: 0 });
    expect(model.courses).toBeUndefined();
    expect(model.links.filter(item => item.removed === true)).toEqual([]);
  }, 60000);

  // Phase 5: every eligible skirt is offered a column-gap course and the judge keeps what wins by the unified order. Both flank links take one here (6 turns, 1
  // crossing against the solve's 7 and 2): the library beats the hand solve on this sheet.
  it('both flank links take a column-gap course', async () => {
    const model = await layout(parse(source(AROUND)), options);
    expect(model.courses?.map(course => [course.link, course.runs])).toEqual([['link-5', ['u', 'gap']], ['link-6', ['u', 'gap']]]);
    expect(model.lanes.filter(lane => lane.kind === 'gap').map(lane => lane.id)).toEqual(['gap-lane:link-5:0', 'gap-lane:link-6:0']);
    expect(codes(model)).toContain('COURSE_TAKEN');
    expect(codes(model)).not.toContain('COURSE_SHAPE_LOST');
  }, 60000);
});

describe('the judge reads what the trial publishes (review of phase 4)', () => {
  // A course that must shift a group toward its neighbour is refused when the two stand exactly a band gap apart: the hard separation of the baseline would break
  // (architecture ticket 19). The trial is the routed baseline with one group moved 1.5 px toward the other, so every other reading of the judge is unchanged.
  it('refuses a trial that shifts a root group toward a neighbour exactly a band gap away', async () => {
    const base = await layout(parse(source('two-root-groups-stand-exactly-a-band-gap-apart')), options);
    const left = base.groups['left']!.bounds!, right = base.groups['right']!.bounds!;
    expect(right.x - (left.x + left.width), 'the sheet stands exactly a band gap apart').toBeCloseTo(60, 6);
    const trial = structuredClone(base) as LayoutModel;
    const shifted = trial.groups['right']!;
    shifted.bounds = { ...shifted.bounds!, x: shifted.bounds!.x - 1.5 };
    for (const id of shifted.nodes) {
      const node = trial.nodes[id]!;
      node.bounds = { ...node.bounds!, x: node.bounds!.x - 1.5 };
      for (const port of node.ports) if (port.anchor) port.anchor = { ...port.anchor, x: port.anchor.x - 1.5 };
    }
    const verdict = judgeCourseTrial(base, trial, new Map());
    expect(verdict.kept).toBe(false);
    expect(verdict.reason).toMatch(/min-separation|minimum separation|hard constraint/);
    // The same trial unshifted is not refused for a separation (it gives no gain, which is another reason).
    expect(judgeCourseTrial(base, structuredClone(base) as LayoutModel, new Map()).reason).not.toMatch(/min-separation|minimum separation|hard constraint/);
  }, 60000);

  // The course of link-13 here once left two root groups 58.9 px apart (the band gap is 60): no gate measured it, the hard entry of the x catalogue does. The linked-group
  // grid no longer widens a box into the band gap of its neighbour (architecture ticket 19), so the baseline holds the gap and the course is taken without breaking it.
  it('keeps every hard separation the baseline holds, the course of link-13 included', async () => {
    const model = await layout(parse(source('a-group-shift-leaves-a-chord-clear-of-a-lane')), options);
    expect(model.courses?.some(course => course.link === 'link-13') ?? false).toBe(true);
    expect([...constraintFindings(model)]).toEqual([]);
  }, 60000);

  it('keeps no course that publishes more turns than it promised', async () => {
    for (const name of [CANTON, ACROSS, MESH, AROUND]) {
      const model = await layout(parse(source(name)), options);
      expect(codes(model), name).not.toContain('COURSE_SHAPE_LOST');
    }
  }, 120000);
});

describe('the courses a placement run reserves', () => {
  it('refuses a course whose faces cannot join one lane', async () => {
    const bad: Course[] = [{ link: 'link-6', kind: 'skirt', side: 'right', from: { face: 'left' }, to: { face: 'top' }, runs: ['perimeter', 'tier-gap'] }];
    await expect(layout(parse(source(ACROSS)), { ...options, testCourses: bad })).rejects.toThrow();
  }, 60000);
});
