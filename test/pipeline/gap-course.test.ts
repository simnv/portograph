import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, restoreLayoutModel, score, validateLanes } from '../../src/index.js';
import type { Course, LayoutLink, LayoutModel } from '../../src/index.js';
import type { Side } from '../../src/model/geometry.js';
import { gapEnds, isGapCourse } from '../../src/layout/course-gap.js';
import { beats, gainOf } from '../../src/layout/course-measure.js';
import { probeGapLane } from '../../src/layout/lanes.js';
import { endMode, movesPort } from '../../src/layout/course-rows.js';
import { isGapRun, laneRunKind } from '../../src/layout/lane-kind.js';
import { findPort } from '../../src/layout/row-paths.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 15, phase 5: the column-gap course, the U part of the tier gap, and the side-lane alias. The target is hand-solve 09 (and the 12 C
 * fixture, the same sheet): the flank link round the neighbour leaves the flank by its bottom face, runs a U part of the tier gap under the row, rises in the
 * free column beside the core and enters the core's left face by a side run, in 3 turns.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const AROUND = 'a-flank-link-around-a-neighbour-runs-along-the-core-edge';
const LISTED = 'a-link-listed-from-the-lateral-end-takes-the-column-gap-course';
const ACROSS = 'a-flank-link-across-a-neighbour-enters-a-bundle-envelope';
const link = (model: LayoutModel, n: number): LayoutLink => model.links.find(item => item.id === `link-${n}`)!;
const sideOf = (model: LayoutModel, n: number, end: 'from' | 'to'): Side => findPort(model, link(model, n).attachments![end])!.side!;
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);
const gates = (model: LayoutModel): boolean => Object.values(score(model).snapshot.gates).every(gate => gate.passed);

describe('the column-gap course on hand-solve 09 (ticket 15, phase 5)', () => {
  it.each([[AROUND, 'from'], [LISTED, 'to']] as const)('%s: the link takes the gap course in 3 turns and every gate holds', async (name, uEnd) => {
    const model = await layout(parse(source(name)), options);
    const lateral = uEnd === 'from' ? 'to' : 'from';
    expect(sideOf(model, 6, uEnd)).toBe('bottom');
    expect(sideOf(model, 6, lateral)).toBe('left');
    expect(pathBends(link(model, 6))).toBe(3);
    expect(gates(model)).toBe(true);
    expect(model.courses!.find(course => course.link === 'link-6')).toEqual({ link: 'link-6', kind: 'skirt', from: { face: uEnd === 'from' ? 'bottom' : 'left' }, to: { face: uEnd === 'from' ? 'left' : 'bottom' },
      runs: uEnd === 'from' ? ['u', 'gap'] : ['gap', 'u'] });
    expect(codes(model)).toContain('COURSE_TAKEN');
    expect(codes(model)).not.toContain('COURSE_SHAPE_LOST');
    // Link 5 takes a gap course as well: 6 turns and 1 crossing in all, against the hand solve's 7 and 2.
    expect([sideOf(model, 5, 'from'), sideOf(model, 5, 'to'), pathBends(link(model, 5))]).toEqual(['bottom', 'left', 3]);
    expect(score(model).snapshot.counts.routed.turns).toBe(6);
  }, 60000);

  it('owns one column-gap lane in the free column beside the core, and the path is the reserved geometry', async () => {
    const model = await layout(parse(source(AROUND)), options);
    const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === 'link-6');
    expect(lanes.map(lane => [lane.id, lane.kind, lane.side, lane.span])).toEqual([['gap-lane:link-6:0', 'gap', 'left', { top: 1, bottom: 1 }]]);
    const lane = lanes[0]!, core = model.groups['core']!.bounds!, branch = model.groups['neighbour']!.bounds!;
    // The lane stands between the neighbour and the core, clear of both.
    expect(lane.bounds.x).toBeGreaterThanOrEqual(branch.x + branch.width);
    expect(lane.bounds.x + lane.bounds.width).toBeLessThanOrEqual(core.x);
    // Its run and the side run are in the path as reserved; the U row stands in the tier gap below band 1, under both bodies.
    const segments = link(model, 6).path!.segments;
    expect(link(model, 6).fixedSegments!.every(run => segments.some(segment => JSON.stringify(segment.from) === JSON.stringify(run.from) && JSON.stringify(segment.to) === JSON.stringify(run.to)))).toBe(true);
    const band = model.tierBands.find(item => item.tier === 1)!.bounds!, below = model.tierBands.find(item => item.tier === 2)!.bounds!;
    const rows = segments.filter(segment => segment.from.y === segment.to.y && segment.from.x !== segment.to.x && segment.from.y > band.y + band.height);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from.y).toBeLessThan(below.y);
    // The lane's vertical run reaches the gap's low boundary (the lane bottom), where the U part takes it.
    expect(lane.bounds.y + lane.bounds.height).toBeGreaterThan(band.y + band.height);
  }, 60000);

  it('restores: the course, its lane and its fixed segments are invariants of the published model', async () => {
    const model = await layout(parse(source(AROUND)), options);
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(restored.courses).toEqual(model.courses);
    expect(restored.lanes.map(lane => lane.id)).toEqual(model.lanes.map(lane => lane.id));
    expect(() => validateLanes(restored)).not.toThrow();
    // A lane that serves another port, or stands in a box, is refused.
    const moved = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const lane = moved.lanes.find(item => item.kind === 'gap')!;
    lane.port = { ...lane.port!, ordinal: lane.port!.ordinal + 1 };
    expect(() => restoreLayoutModel(JSON.stringify(moved))).toThrow();
    const inside = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const box = inside.groups['core']!.bounds!, laneIn = inside.lanes.find(item => item.kind === 'gap')!;
    laneIn.x = box.x + 5; laneIn.bounds.x = laneIn.x - laneIn.bounds.width / 2;
    expect(() => restoreLayoutModel(JSON.stringify(inside))).toThrow();
  }, 60000);

  it('takes no gap course where no skirt stands', async () => {
    // The 12 D sheet has no same-band skirt with a finding: its flank link is the perimeter course's (phase 4), and no gap course is taken anywhere in it.
    const model = await layout(parse(source(ACROSS)), options);
    expect((model.courses ?? []).filter(course => isGapCourse(course))).toEqual([]);
  }, 60000);
});

describe('the offer and 7a share one admission test', () => {
  it('admits the lane the published layout holds, at the same x, and refuses a column that a lane or a body closes', async () => {
    const model = await layout(parse(source(AROUND)), options);
    const lane = model.lanes.find(item => item.id === 'gap-lane:link-6:0')!, course = model.courses!.find(item => item.link === 'link-6')!;
    const admitted = probeGapLane(model, link(model, 6), course);
    expect('lane' in admitted && Math.abs(admitted.lane.x - lane.x) < 1e-6).toBe(true);
    // A lane already reserved in the column leaves no room (reserved lanes count, as in 7a).
    const blocker = { ...lane, id: 'gap-lane:other:0', owner: { kind: 'link' as const, id: 'other' }, bounds: { ...lane.bounds } };
    const closed = probeGapLane(model, link(model, 6), course, [blocker]);
    expect('why' in closed).toBe(true);
    // A course whose ends stand in two bands is refused by the same test.
    const across = probeGapLane(model, link(model, 1), { ...course, link: 'link-1' });
    expect('why' in across && /two bands/.test(across.why)).toBe(true);
  }, 60000);
});

describe('a restored link outranks any bend or turn gain (the budget tie-break)', () => {
  it('ranks restored links first, then bent links, then turns', () => {
    const restoring = gainOf([[undefined, 3]]), bending = gainOf([[9, 0], [8, 0]]);
    expect(restoring).toEqual([1, 0, 0]);
    expect(beats(restoring, bending)).toBe(true);
    expect(beats(bending, restoring)).toBe(false);
    expect(beats(gainOf([[4, 1]]), gainOf([[4, 3]]))).toBe(true);
    expect(beats(gainOf([[4, 0]]), gainOf([[9, 3]]))).toBe(true);
    expect(beats(gainOf([[4, 1]]), gainOf([[4, 1]]))).toBe(false);
  });
});

describe('the end modes of a gap course', () => {
  const course: Course = { link: 'link-6', kind: 'skirt', from: { face: 'bottom' }, to: { face: 'left' }, runs: ['u', 'gap'] };
  it('holds the lateral face and moves the U end', () => {
    expect([endMode(course, 'from'), endMode(course, 'to')]).toEqual(['u', 'hold']);
    expect([movesPort(course, 'from'), movesPort(course, 'to')]).toEqual([true, false]);
    expect(gapEnds(course)).toEqual({ lateral: 'to', u: 'from', down: true });
    expect(gapEnds({ ...course, from: { face: 'left' }, to: { face: 'bottom' }, runs: ['gap', 'u'] })).toEqual({ lateral: 'from', u: 'to', down: true });
  });
  it('leaves a perimeter course as it was', () => {
    const perimeter: Course = { link: 'link-6', kind: 'transit', side: 'left', from: { face: 'top' }, to: { face: 'left' }, runs: ['padding', 'perimeter'] };
    expect([endMode(perimeter, 'from'), endMode(perimeter, 'to')]).toEqual(['padding', 'side']);
    expect(isGapCourse(perimeter)).toBe(false);
    expect(gapEnds(perimeter)).toBeUndefined();
  });
});

describe('the side lane reads as a column-gap run (the alias of ticket 15, phase 5)', () => {
  it('maps the stored kinds to the run kinds', () => {
    expect(laneRunKind({})).toBe('transit');
    expect(laneRunKind({ kind: 'transit' })).toBe('transit');
    expect(laneRunKind({ kind: 'side' })).toBe('gap');
    expect(laneRunKind({ kind: 'gap' })).toBe('gap');
    expect(laneRunKind({ kind: 'perimeter' })).toBe('perimeter');
    expect(isGapRun({ kind: 'side' })).toBe(true);
    expect(isGapRun({ kind: 'transit' })).toBe(false);
  });
});

describe('the placement run refuses a gap course it cannot reserve', () => {
  it('a course whose ends stand in two bands', async () => {
    const bad: Course[] = [{ link: 'link-1', kind: 'skirt', from: { face: 'bottom' }, to: { face: 'left' }, runs: ['u', 'gap'] }];
    await expect(layout(parse(source(AROUND)), { ...options, testCourses: bad })).rejects.toThrow();
  }, 60000);
});
