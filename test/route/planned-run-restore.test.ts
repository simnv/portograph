import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreFinalLayout } from '../../src/internal.js';
import type { LayoutModel, PathSegment } from '../../src/model/layout.js';
import { placementRuns, plannedRunsOf, type PlannedRun } from '../../src/route/plan.js';
import { stubCandidate } from '../../src/route/paths.js';
import { lostPlannedRun, preRoute } from '../../src/route/validate.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { orthogonalLinks } from '../orthogonal-links.js';
import { withoutJointOrder } from '../layout/joint-off.js';
import { createAvoidAttempt } from './fixture.js';

/**
 * Decision D-Q2 (decision-review ticket 10): full restore keeps every run placement planned, a tier-gap part (`allocateGapRuns`) or a
 * row-gap leg (`legReservation`), with its owner and traversal. The validator asks the one producer (`placementRuns`) of the restored
 * placement and requires each planned segment inside a straight same-owner piece of the path. Audit P-05 F2: a planned row moved
 * four pixels with its joins passed restore with every gate green.
 */
const synthetic = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const restore = (model: LayoutModel): LayoutModel => restoreFinalLayout(JSON.stringify(model));
const FIXTURE = 'a-restored-route-keeps-its-planned-row-and-leg';

const memo = new Map<string, Promise<LayoutModel>>();
function built(key: string, text: string, options: object = {}): Promise<LayoutModel> {
  if (!memo.has(key)) memo.set(key, layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...options }));
  return memo.get(key)!;
}

const vertical = (segment: PathSegment): boolean => Math.abs(segment.from.x - segment.to.x) <= 1e-7;
/** Whether the path segment `drawn` holds the planned segment `planned`: one line, and its span covers the planned span. */
function holds(drawn: PathSegment, planned: PathSegment): boolean {
  if (vertical(drawn) !== vertical(planned)) return false;
  const axis = vertical(planned) ? 'y' : 'x', cross = vertical(planned) ? 'x' : 'y';
  return Math.abs(drawn.from[cross] - planned.from[cross]) <= 1e-7 && Math.abs(drawn.to[cross] - planned.from[cross]) <= 1e-7
    && Math.min(drawn.from[axis], drawn.to[axis]) <= Math.min(planned.from[axis], planned.to[axis]) + 1e-7
    && Math.max(drawn.from[axis], drawn.to[axis]) >= Math.max(planned.from[axis], planned.to[axis]) - 1e-7;
}

const planned = (model: LayoutModel, link: string): PlannedRun[] => plannedRunsOf(placementRuns(preRoute(model)), link);

/**
 * A copy of `model` with the interior path segment of `link` that holds a segment of its planned run of `kind` moved `by` pixels
 * across its line, with the two joins beside it (the P-05 F2 move). Boxes, records and freeze stay as they are; the stub mark
 * follows the moved path, as a forger would keep it.
 */
function moved(model: LayoutModel, link: string, kind: PlannedRun['kind'], by: number): LayoutModel {
  const segments = model.links.find(item => item.id === link)!.path!.segments;
  for (const run of planned(model, link).filter(item => item.kind === kind)) {
    for (let at = 1; at < segments.length - 1; at++) {
      if (!run.segments.some(segment => holds(segments[at]!, segment))) continue;
      if (vertical(segments[at - 1]!) === vertical(segments[at]!) || vertical(segments[at + 1]!) === vertical(segments[at]!)) continue;
      const copy = clone(model), target = copy.links.find(item => item.id === link)!, path = target.path!.segments;
      const across = vertical(path[at]!) ? 'x' : 'y';
      path[at - 1]!.to[across] += by; path[at]!.from[across] += by; path[at]!.to[across] += by; path[at + 1]!.from[across] += by;
      if (stubCandidate(copy, target)) target.stubCandidate = true; else delete target.stubCandidate;
      return copy;
    }
  }
  throw new Error(`${link} has no interior ${kind} segment between two turns`);
}

describe('restore keeps the runs placement planned (D-Q2)', () => {
  const fixture = (): Promise<LayoutModel> => built(FIXTURE, synthetic(FIXTURE));

  it('plans a leg for link-2 and a tier-gap part for link-5 in the fixture', async () => {
    const model = await fixture();
    expect(planned(model, 'link-2').map(run => run.kind)).toEqual(['leg']);
    expect(planned(model, 'link-5').map(run => run.kind)).toEqual(['tier-gap']);
  }, 120000);

  it('accepts the fixture as published', async () => {
    const model = clone(await fixture());
    expect(() => restore(model)).not.toThrow();
  }, 120000);

  it('refuses a planned row moved four pixels with its joins', async () => {
    const copy = moved(await fixture(), 'link-5', 'tier-gap', 4);
    expect(() => restore(copy))
      .toThrow('Routed path on link-5 does not keep the run placement planned for link-5 in its tier gap (part 0)');
  }, 120000);

  it('refuses a planned leg moved four pixels with its joins', async () => {
    const copy = moved(await fixture(), 'link-2', 'leg', -4);
    expect(() => restore(copy))
      .toThrow('Routed path on link-2 does not keep the leg placement planned for link-2 in its row gap');
  }, 120000);

  it('accepts a planned segment split in two by a collinear same-owner joint', async () => {
    const model = await fixture(), copy = clone(model), path = copy.links.find(item => item.id === 'link-5')!.path!.segments;
    const at = path.findIndex(segment => holds(segment, planned(model, 'link-5')[0]!.segments[1]!));
    const whole = path[at]!, middle = { x: (whole.from.x + whole.to.x) / 2, y: (whole.from.y + whole.to.y) / 2 };
    path.splice(at, 1, { ...whole, from: { ...whole.from }, to: middle }, { ...whole, from: { ...middle }, to: { ...whole.to } });
    expect(() => restore(copy)).not.toThrow();
  }, 120000);
});

describe('the P-05 F2 cases', () => {
  // Audit P-05 F2 found them on saved P-04 models; they are laid out here again from the same YAML.
  const cases = [
    { name: 'two-skirts-from-one-face-nest', link: 'link-5', options: { testTurnOrder: true } },
    { name: 'a-fan-track-keeps-the-group-edge-margin', link: 'link-4', options: {} },
  ] as const;
  it.each(cases)('$name: refuses the planned row of $link moved four pixels', async ({ name, link, options }) => {
    const model = await built(name, synthetic(name), options);
    expect(() => restore(clone(model))).not.toThrow();
    const copy = moved(model, link, 'tier-gap', 4);
    expect(() => restore(copy))
      .toThrow(new RegExp(`^Routed path on ${link} does not keep the run placement planned for ${link} in its tier gap`));
  }, 120000);
});

describe('the four live controls of audit P-05 stay accepted', () => {
  const lateral = 'portograph: 2\ngroups: {g: {tier: 0}}\nnodes:\n  a: {group: g, ports: [{name: p, side: right}, {name: q, side: right}]}\n'
    + '  b: {group: g, ports: [{name: p, side: right}, {name: q, side: left}]}\nlinks: [[a.p, b.p], [a.q, b.q]]\n';
  // The audit ran the stages one by one; the whole pipeline claims every run of `a-claimed-run-clears-a-shared-run` straight, so it plans none there.
  const live = [
    { name: 'two-runs-share-a-tier-gap', runs: true },
    { name: 'a-claimed-run-clears-a-shared-run', runs: false },
    { name: 'a-routed-link-between-frames-keeps-orthogonal-past-a-foreign-frame', runs: true },
  ];
  it.each(live)('$name, every link orthogonal, as published', async ({ name, runs }) => {
    const model = await built(`live:${name}`, orthogonalLinks(withoutJointOrder(synthetic(name))));
    expect(model.links.some(link => planned(model, link.id).length)).toBe(runs);
    expect(() => restore(clone(model))).not.toThrow();
  }, 120000);
  it('two lateral legs in one row gap, as published', async () => {
    const model = await built('live:lateral', lateral);
    expect(model.links.flatMap(link => planned(model, link.id).map(run => run.kind))).toEqual(['leg', 'leg']);
    expect(() => restore(clone(model))).not.toThrow();
  }, 120000);
});

describe('lostPlannedRun', () => {
  const owner = { kind: 'link' as const, id: 'a' };
  const run: PlannedRun = { kind: 'tier-gap', index: 0, segments: [{ from: { x: 0, y: 0 }, to: { x: 0, y: 10 }, owner }, { from: { x: 0, y: 10 }, to: { x: 20, y: 10 }, owner }] };
  const forward: PathSegment[] = [{ from: { x: 0, y: -5 }, to: { x: 0, y: 10 }, owner }, { from: { x: 0, y: 10 }, to: { x: 30, y: 10 }, owner }];
  it('passes a collinear merge with the same owner', () => expect(lostPlannedRun(forward, [run])).toBeUndefined());
  it('passes when placement planned no run (an empty list)', () => expect(lostPlannedRun(forward, [])).toBeUndefined());
  it('refuses a run moved off its line', () => {
    const shifted: PathSegment[] = [{ from: { x: 0, y: -5 }, to: { x: 0, y: 14 }, owner }, { from: { x: 0, y: 14 }, to: { x: 30, y: 14 }, owner }];
    expect(lostPlannedRun(shifted, [run])).toBe(run);
  });
  it('refuses a run held by another owner', () => {
    expect(lostPlannedRun(forward.map(segment => ({ ...segment, owner: { kind: 'link' as const, id: 'b' } })), [run])).toBe(run);
  });
  it('refuses a reversed traversal', () => {
    const reversed: PathSegment[] = [{ from: { x: 20, y: 10 }, to: { x: 0, y: 10 }, owner }, { from: { x: 0, y: 10 }, to: { x: 0, y: 0 }, owner }];
    expect(lostPlannedRun(reversed, [run])).toBe(run);
  });
  it('refuses runs met out of the planned order', () => {
    expect(lostPlannedRun([forward[1]!, forward[0]!], [run])).toBe(run);
  });
});
