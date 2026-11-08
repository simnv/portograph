import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import type { Course, Lane, LayoutLink, LayoutModel } from '../../src/index.js';
import type { Side } from '../../src/model/geometry.js';
import { naturalPolyline, polylineCrossings, polylineTurns, simplify } from '../../src/layout/course-plan.js';
import { drawnCrossings, judgeCourseTrial, measureCourses, placedExtent, poorRoute, stepGain, stepRoute } from '../../src/layout/course-measure.js';
import { COURSE_VISITS, course as courseRound } from '../../src/pipeline/rounds.js';
import type { Env } from '../../src/pipeline/env.js';
import type { State } from '../../src/pipeline/state.js';
import type { LinkFacts } from '../../src/layout/read/courses.js';
import { constraintFindings } from '../../src/layout/trial-findings.js';
import { findPort } from '../../src/layout/row-paths.js';
import { pathBends } from '../../src/layout/objective.js';
import { laneSidesHold } from '../../src/layout/lanes.js';
import { right } from '../../src/geometry/planar.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from '../layout/joint-off.js';

/**
 * Architecture ticket 15, phase 4: the course round (`measureCourses`, the stage-5 course input, the trial judge) and the perimeter lane. The stop rule of
 * the redesign of 2026-10-05: (a) the in-scope links match the faces and the turns of the `solve` page, (b) every kept course publishes the turns it
 * promised (`COURSE_SHAPE_LOST` is 0), (c) nothing else gets worse.
 */
const source = (name: string): string => withoutJointOrder(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
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

  // A step: two neighbouring tiers, no tier between them, two turns and no crossing. It is offered only the course that is shorter and crosses nothing.
  const facts = (fromTier: number, toTier: number, crossed: number[]): LinkFacts => ({ from: { tier: fromTier }, to: { tier: toTier }, crossed } as unknown as LinkFacts);
  it.each<[string, LinkFacts, number | undefined, number, boolean]>([
    ['a step between neighbouring tiers', facts(1, 2, []), 2, 0, true],
    ['a step that crosses a link', facts(1, 2, []), 2, 1, false],
    ['a route with one turn', facts(1, 2, []), 1, 0, false],
    ['a route with three turns', facts(1, 2, []), 3, 0, false],
    ['a removed link', facts(1, 2, []), undefined, 0, false],
    ['a link across a tier', facts(0, 2, [1]), 2, 0, false],
    ['a link in one tier', facts(1, 1, []), 2, 0, false],
  ])('stepRoute: %s', (_name, found, bends, crossings, step) => {
    expect(stepRoute(found, bends, crossings)).toBe(step);
  });
  it.each<[number, number, boolean]>([[1, 0, true], [0, 0, true], [1, 1, false], [2, 0, false]])('stepGain: a course of %s turns and %s crossings: %s', (bends, crossings, gain) => {
    expect(stepGain(bends, crossings)).toBe(gain);
  });
});

describe('the course round on the hand-solve sheets (ticket 15, phase 4)', () => {
  // Case 05 and the 12 D fixture. Since ticket 09 (architecture-2) the flank port keeps its stage 7b place after the bundle block, so the link is no longer removed:
  // its baseline route is a step into the top face of the canton member (2 turns, no crossing). The follow-up of ticket 09 offers a step the L that crosses
  // nothing (`stepRoute`), and the round takes it: the link enters the right face with 1 turn.
  it('05 / 12 D: the flank link steps on the baseline and takes the L into the right face, with the turn it promised (ticket 09 follow-up)', async () => {
    const model = await layout(parse(source(ACROSS)), options);
    expect(model.links.filter(item => item.removed === true)).toEqual([]);
    expect(side(model, 7, 'to')).toBe('right');
    expect(side(model, 7, 'from')).toBe('bottom');
    expect(turns(model, 7)).toBe(1);
    expect(model.courses!.map(course => course.link)).toEqual(['link-7']);
    expect(model.lanes.some(lane => lane.kind === 'perimeter' && lane.owner.kind === 'link' && lane.owner.id === 'link-7')).toBe(true);
    expect(codes(model)).toContain('COURSE_TAKEN');
    expect(codes(model)).not.toContain('COURSE_SHAPE_LOST');
    // The kept layout restores: the course, its port faces and its lane are invariants of the published model.
    expect(restoreLayoutModel(JSON.stringify(model)).courses).toEqual(model.courses);
  }, 60000);

  it('a flank course keeps its lane and its faces when the published model is restored', async () => {
    const model = await layout(parse(source(AROUND)), options);
    expect(model.courses!.map(course => course.link)).toEqual(['link-4', 'link-6']);
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(restored.courses).toEqual(model.courses);
  }, 60000);

  // Case 08: OOB leaves its top face, runs under the title of WAN into the left margin and enters SRV 1 from the left in 3 turns.
  it('08: OOB to SRV 1 leaves the top face, runs in the left margin and enters the left face in 3 turns', async () => {
    const model = await layout(parse(source(CANTON)), options);
    expect([side(model, 2, 'from'), side(model, 2, 'to'), turns(model, 2)]).toEqual(['top', 'left', 3]);
    expect(side(model, 3, 'from')).toBe('right');
    expect(side(model, 3, 'to')).toBe('top');
    // Link 3 drops straight into SRV 2: the aligned lane is a feed of 7c, so the promise holds (1 turn) and nothing is lost.
    expect(turns(model, 3)).toBe(1);
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
      { link: 'link-4', kind: 'skirt', side: 'right', from: { face: 'top' }, to: { face: 'top' }, runs: ['padding', 'perimeter', 'tier-gap'] },
      { link: 'link-11', kind: 'skirt', side: 'right', from: { face: 'bottom' }, to: { face: 'bottom' }, runs: ['tier-gap', 'perimeter', 'padding'] },
    ];
    const model = await layout(parse(source(MESH)), { ...options, testCourses: courses });
    expect([side(model, 4, 'from'), side(model, 4, 'to'), turns(model, 4)]).toEqual(['top', 'top', 2]);
    expect([side(model, 11, 'from'), side(model, 11, 'to'), turns(model, 11)]).toEqual(['bottom', 'bottom', 2]);
    expect(score(model).snapshot.counts.routed.crossings).toBeLessThanOrEqual(9);
    expect(Object.values(score(model).snapshot.gates).filter(gate => !gate.passed).length).toBeLessThanOrEqual(1);
  }, 60000);

  it('04: with no spanning chord, the round refuses the courses and the sheet is as it was', async () => {
    // `testSpanHints: []` leaves the span round out (architecture ticket 22): the nine mesh links keep their lanes, as on main.
    const model = await layout(parse(source(MESH)), { ...options, testSpanHints: [] });
    expect(model.courses).toBeUndefined();
    expect(model.lanes.some(lane => lane.kind === 'perimeter')).toBe(false);
    expect(side(model, 4, 'from')).toBe('bottom');
  }, 60000);

  it('04: after the span round the nine mesh links are chords, and the round takes the two courses (architecture ticket 22)', async () => {
    const model = await layout(parse(source(MESH)), options);
    expect(model.courses?.map(course => course.link)).toEqual(['link-4', 'link-11']);
    expect(model.lanes.filter(lane => lane.kind === 'span')).toHaveLength(9);
    expect([turns(model, 4), turns(model, 11)]).toEqual([2, 2]);
    expect(score(model).snapshot.counts.routed.crossings).toBeLessThanOrEqual(9);
    expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
  }, 60000);

  // The Core title (Verdana) does not fit beside the drop of N2-C1 into C1, so 7f widens Core past it. The perimeter lane of C1-S2 has Core as its
  // upper end's group but stands beside South: it must not refuse that widening, or the title falls on the drop and the trial loses the course.
  it('04: a perimeter lane walls the groups of its span when aligned, and gives way when its x is derived', async () => {
    const model = await layout(parse(source(MESH)), options);
    const lane = model.lanes.find(item => item.id === 'perimeter:link-11')!, core = model.groups.core!, south = model.groups.south!;
    expect([lane.tier, lane.span, lane.aligned]).toEqual([core.tier, { top: south.tier, bottom: south.tier }, true]);
    expect(core.bounds!.x).toBeLessThan(lane.x);
    expect(right(core.bounds!)).toBeGreaterThan(right(lane.bounds));
    expect(laneSidesHold(model, [{ group: core, bounds: { ...core.bounds!, width: core.bounds!.width + 20 } }], false)).toBe(true);
    expect(laneSidesHold(model, [{ group: south, bounds: { ...south.bounds!, width: lane.bounds.x - south.bounds!.x + 1 } }], false)).toBe(false);
    // The same lane unaligned derives its x from the boxes on its span: the replay moves it out with the widened box.
    const unaligned: Lane = { ...lane };
    delete unaligned.aligned;
    const derived = { ...model, lanes: model.lanes.map(item => item === lane ? unaligned : item) };
    expect(laneSidesHold(derived, [{ group: south, bounds: { ...south.bounds!, width: lane.bounds.x - south.bounds!.x + 1 } }], false)).toBe(true);
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
    expect(model.courses?.map(course => [course.link, course.runs])).toEqual([['link-4', ['u', 'gap']], ['link-6', ['u', 'gap']]]);
    expect(model.lanes.filter(lane => lane.kind === 'gap').map(lane => lane.id)).toEqual(['gap-lane:link-4:0', 'gap-lane:link-6:0']);
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

  // The course of link-10 here once left two root groups 58.9 px apart (the band gap is 60): no gate measured it, the hard entry of the x catalogue does. The linked-group
  // grid no longer widens a box into the band gap of its neighbour (architecture ticket 19), so the baseline holds the gap and the course is taken without breaking it.
  it('keeps every hard separation the baseline holds, the course of link-10 included', async () => {
    const model = await layout(parse(source('a-group-shift-leaves-a-chord-clear-of-a-lane')), options);
    expect(model.courses?.some(course => course.link === 'link-10') ?? false).toBe(true);
    expect([...constraintFindings(model)]).toEqual([]);
  }, 60000);

  it('keeps no course that publishes more turns than it promised', async () => {
    for (const name of [CANTON, ACROSS, MESH, AROUND]) {
      const model = await layout(parse(source(name)), options);
      expect(codes(model), name).not.toContain('COURSE_SHAPE_LOST');
    }
  }, 120000);
});

describe('a step course never costs the course of a poor route (ticket 09 follow-up)', () => {
  // With no re-run left the flank link keeps its baseline route: the step (2 turns, no crossing) that the round would offer the L.
  const stepped = async (): Promise<LayoutModel> => layout(parse(source(ACROSS)), { ...options, testMaxReruns: 0 });

  it('records the step links of an offer, and leaves them out on request', async () => {
    const model = await stepped();
    expect(turns(model, 7)).toBe(2);
    const offer = measureCourses(model, model);
    expect(offer.courses.map(item => item.link)).toEqual(['link-7']);
    expect(offer.steps).toEqual(['link-7']);
    expect(measureCourses(model, model, new Set(), false).courses).toEqual([]);
  }, 60000);

  it('a refused trial with a step course beside a poor-route course gets one more trial without the step; any other refused trial gets none', async () => {
    expect(courseRound.budget.visits).toBe(COURSE_VISITS);
    expect(COURSE_VISITS).toBe(2);
    expect(courseRound.budget.retries).toContain('verdict');
    const model = await stepped();
    const env = { options: {} } as unknown as Env;
    const fresh = (): State => ({ base: model, routedBase: model, sideNotes: [] }) as unknown as State;
    const refusal = { at: 'verdict' as const, why: 'no gain' };
    // A mixed offer: the step of link-7 and a poor-route course of another link.
    let s = fresh();
    const first = (await courseRound.measure(env, s))!;
    const poor: Course = { link: 'link-1', kind: 'skirt', side: 'left', from: { face: 'left' }, to: { face: 'top' }, runs: ['perimeter', 'tier-gap'] };
    courseRound.refuse(env, s, { ...first, courses: [...first.courses, poor] }, refusal);
    expect(s.courseRetry).toBe('without-steps');
    // The second measure leaves the step out (on this sheet nothing else is offered).
    expect(await courseRound.measure(env, s)).toBeUndefined();
    // A refused offer of step courses alone, or of poor routes alone, is not tried again: a second trial would repeat the first.
    s = fresh();
    courseRound.refuse(env, s, first, refusal);
    expect(s.courseRetry).toBe('none');
    expect(await courseRound.measure(env, s)).toBeUndefined();
    s = fresh();
    courseRound.refuse(env, s, { ...first, courses: [poor], steps: [] }, refusal);
    expect(s.courseRetry).toBe('none');
    // The second trial refused as well: no third.
    s = fresh();
    s.courseRetry = 'without-steps';
    courseRound.refuse(env, s, { ...first, courses: [...first.courses, poor] }, refusal);
    expect(s.courseRetry).toBe('none');
  }, 60000);

  it('the judge refuses a step course that publishes a crossing', async () => {
    const base = await stepped();
    const published = await layout(parse(source(ACROSS)), options);
    expect(published.courses!.map(item => item.link)).toEqual(['link-7']);
    // The trial: the published model with one more routed path across the middle of the first straight piece of link-7.
    const trial = structuredClone(published) as LayoutModel;
    const piece = link(trial, 7).path!.segments.find(segment => Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y) > 20)!;
    const mid = { x: (piece.from.x + piece.to.x) / 2, y: (piece.from.y + piece.to.y) / 2 }, level = piece.from.y === piece.to.y;
    const across = level ? { from: { x: mid.x, y: mid.y - 10 }, to: { x: mid.x, y: mid.y + 10 } } : { from: { x: mid.x - 10, y: mid.y }, to: { x: mid.x + 10, y: mid.y } };
    trial.links.push({ ...link(trial, 1), id: 'probe', path: { ...link(trial, 1).path!, segments: [{ ...piece, ...across }] } });
    const promised = new Map([['link-7', 1]]);
    expect(judgeCourseTrial(base, trial, promised, new Set(['link-7'])).reason).toMatch(/a step course publishes a crossing \(link-7\)/);
    expect(judgeCourseTrial(base, trial, promised).reason).not.toMatch(/step course/);
  }, 60000);

  it('the offer and the judge count the same crossings: every drawn link, overlay included, and no removed link', async () => {
    const model = await layout(parse(source(ACROSS)), options);
    const own = link(model, 7), points = [own.path!.segments[0]!.from, ...own.path!.segments.map(segment => segment.to)];
    expect(drawnCrossings(model, 'link-7', points)).toBe(0);
    const piece = own.path!.segments.find(segment => Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y) > 20)!;
    const mid = { x: (piece.from.x + piece.to.x) / 2, y: (piece.from.y + piece.to.y) / 2 }, level = piece.from.y === piece.to.y;
    const across = level ? { from: { x: mid.x, y: mid.y - 10 }, to: { x: mid.x, y: mid.y + 10 } } : { from: { x: mid.x - 10, y: mid.y }, to: { x: mid.x + 10, y: mid.y } };
    const other = { ...link(model, 1), id: 'probe', path: { ...link(model, 1).path!, segments: [{ ...piece, ...across }] } };
    expect(drawnCrossings({ ...model, links: [...model.links, { ...other, layer: 'overlay' as const }] }, 'link-7', points)).toBe(1);
    expect(drawnCrossings({ ...model, links: [...model.links, { ...other, removed: true }] }, 'link-7', points)).toBe(0);
  }, 60000);
});

describe('the courses a placement run reserves', () => {
  it('refuses a course whose faces cannot join one lane', async () => {
    const bad: Course[] = [{ link: 'link-7', kind: 'skirt', side: 'right', from: { face: 'left' }, to: { face: 'top' }, runs: ['perimeter', 'tier-gap'] }];
    await expect(layout(parse(source(ACROSS)), { ...options, testCourses: bad })).rejects.toThrow();
  }, 60000);
});

describe('a perimeter lane is read beside the box 7a stands it by (architecture-2 ticket 22)', () => {
  it('a row order that lets the grid widen the upper group keeps the course into the natural face, with two turns', async () => {
    const model = await layout(parse(source('a-course-lane-stands-beside-the-box-before-the-grid-widens-it')), options);
    // link-2 is f1 to s1: it leaves f1 by a padding row, runs right over the row and drops into s1's top face.
    expect(side(model, 2, 'to')).toBe('top');
    expect(turns(model, 2)).toBe(2);
    expect(model.diagnostics.find(item => item.code === 'COURSE_TAKEN')?.message).toContain('2 turns promised');
    // The extent the measure reads: never past the box, and never short of the nodes.
    for (const group of Object.values(model.groups)) {
      const box = group.bounds!, extent = placedExtent(model, group);
      expect(extent.x).toBeGreaterThanOrEqual(box.x - 1e-6);
      expect(extent.x + extent.width).toBeLessThanOrEqual(box.x + box.width + 1e-6);
      for (const id of group.nodes) {
        const node = model.nodes[id]!.bounds!;
        expect(extent.x).toBeLessThanOrEqual(node.x);
        expect(extent.x + extent.width).toBeGreaterThanOrEqual(node.x + node.width);
      }
    }
  }, 60000);
});
