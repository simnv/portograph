import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel, PathSegment } from '../../src/model/layout.js';
import { reservedSegments, tierGapPlans } from '../../src/layout/gap-plan.js';
import { nudgingDistance } from '../../src/layout/bands.js';
import { planRoute } from '../../src/route/plan.js';
import { preRoute } from '../../src/route/validate.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

type Point = { x: number; y: number };
type Run = Pick<PathSegment, 'from' | 'to'>;
const TOLERANCE = 1e-3;

/** Whether `run` lies on the union of the collinear `cover` runs, end to end. A point run lies on any run through it. */
function covered(run: Run, cover: readonly Run[]): boolean {
  const dx = run.to.x - run.from.x, dy = run.to.y - run.from.y, span = Math.hypot(dx, dy);
  const offset = (point: Point): number => span === 0 ? Math.hypot(point.x - run.from.x, point.y - run.from.y)
    : Math.abs(dx * (point.y - run.from.y) - dy * (point.x - run.from.x)) / span;
  const along = (point: Point): number => span === 0 ? 0 : ((point.x - run.from.x) * dx + (point.y - run.from.y) * dy) / span;
  const intervals = cover.flatMap(item => {
    if (span === 0) {
      const ex = item.to.x - item.from.x, ey = item.to.y - item.from.y, length = Math.hypot(ex, ey) || 1;
      const t = ((run.from.x - item.from.x) * ex + (run.from.y - item.from.y) * ey) / length;
      const distance = Math.abs(ex * (run.from.y - item.from.y) - ey * (run.from.x - item.from.x)) / length;
      return distance < TOLERANCE && t > -TOLERANCE && t < length + TOLERANCE ? [[0, 0] as const] : [];
    }
    if (offset(item.from) > TOLERANCE || offset(item.to) > TOLERANCE) return [];
    const a = along(item.from), b = along(item.to);
    return [[Math.min(a, b), Math.max(a, b)] as const];
  }).sort((a, b) => a[0] - b[0]);
  let reach = 0;
  if (span === 0) return intervals.length > 0;
  for (const [low, high] of intervals) {
    if (low > reach + TOLERANCE) return false;
    reach = Math.max(reach, high);
    if (reach >= span - TOLERANCE) return true;
  }
  return false;
}

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/${name}.yaml`, import.meta.url), 'utf8');

/** What stage 8 keeps of placement, read from the plan it stitches: every piece but a routed gap and a straight claim, every stem and lane
 *  approach the router passes head-on, and every stored path. */
function stitched(view: LayoutModel): { link: string; segment: Run }[] {
  const plan = planRoute(view), result: { link: string; segment: Run }[] = [];
  for (const item of plan.links) for (const piece of item.pieces) {
    if (piece.kind === 'gap') continue;
    // A straight claim is stage 8's own run; what placement reserved on it is what it passes head-on.
    for (const segment of piece.kind === 'straight' ? piece.passes : piece.segments) result.push({ link: item.link, segment });
  }
  for (const item of [...plan.stems, ...plan.approaches]) result.push({ link: item.link, segment: item.segment });
  for (const link of view.links) if (link.path) for (const segment of link.path.segments) result.push({ link: link.id, segment });
  return result;
}

/**
 * The sheets the test reads: the synthetics whose plans hold junction (shared) runs, lanes and their mouths, U and Z parts and held chords, and ten
 * others. With any one producer left out of `reservedRunsOf` (a stored path, a shared run, a lane, a mouth, a stem), at least one of them fails;
 * the last test checks that they still hold every kind.
 */
const SHEETS = [
  // Junctions: shared runs at both ends, a stem kept after a branch release.
  'synthetic/bar-fan', 'synthetic/a-claimed-run-clears-a-shared-run', 'synthetic/a-link-leaves-its-group-through-a-door',
  'synthetic/a-reserved-approach-cannot-be-hemmed', 'synthetic/a-fan-track-keeps-the-group-edge-margin',
  // Lanes and their mouths.
  'synthetic/a-held-lane-is-reserved-before-a-foreign-lane', 'synthetic/a-held-lane-stays-on-its-frames-side-of-a-foreign-frame',
  'synthetic/two-runs-share-a-tier-gap', 'synthetic/a-facing-pair-nests-its-lanes-in-the-face-order', 'synthetic/a-chord-and-a-lane-share-a-middle-tier',
  // U and Z parts.
  'synthetic/two-skirts-from-one-face-nest', 'synthetic/a-link-listed-from-the-lateral-end-takes-the-column-gap-course',
  'synthetic/a-row-cycle-leaves-a-part-to-the-router', 'synthetic/an-allocated-run-starts-beyond-the-stem',
  // Held chords.
  'synthetic/a-chord-under-a-stem-is-no-crossing', 'synthetic/a-chord-spans-a-gap-the-solve-grows', 'synthetic/a-stem-tip-stands-beyond-its-pill-text',
  // Ten others.
  'real/small-office', 'real/private-datacenter-spine-leaf', 'synthetic/a-row-steps-past-a-group-edge', 'synthetic/a-far-port-is-centred-under-a-side-lane',
  'synthetic/two-sibling-frames-mirror-a-linked-pair', 'synthetic/a-flank-link-around-a-neighbour-runs-along-the-core-edge',
  'synthetic/a-three-port-side-shares-the-room-beyond-its-stems', 'synthetic/a-span-corridor-passes-a-lane-beside-a-unit-it-does-not-move',
  'synthetic/two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row', 'synthetic/a-title-over-a-ports-leg-is-nudged-aside',
];

describe('reservedSegments reads every segment reserved before routing, and nothing else (dense-16x9 ticket 14, review 5)', () => {
  // The published layout, seen as stage 8 received it (`preRoute`). Two directions, per tier gap and within `keep` of it:
  //   - every segment of a final path that stage 8 did not make (`stitched`: what `planRoute` stitches, and what it passes head-on) is on the
  //     collinear union of `reservedSegments` entries of its link; a producer of reserved geometry that the reader does not read fails here;
  //   - every `reservedSegments` entry lies on the final path of its link; an entry no path keeps (a guessed stem, a wrong mouth) fails here.
  const seen = new Set<string>();
  for (const sheet of SHEETS) it(sheet, async () => {
    const model = await layout(parse(fixture(sheet)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const view = preRoute(model), keep = nudgingDistance(view), kept = stitched(view);
    const missing: unknown[] = [], stray: unknown[] = [];
    for (const { gap, plan } of tierGapPlans(view)) {
      const reserved = reservedSegments(view, gap, plan);
      for (const entry of reserved) seen.add(entry.kind);
      for (const part of plan.parts) seen.add(`shape:${part.shape}`);
      const near = (run: Run): boolean => Math.max(run.from.y, run.to.y) >= gap.low - keep - TOLERANCE && Math.min(run.from.y, run.to.y) <= gap.high + keep + TOLERANCE;
      for (const item of kept) {
        if (near(item.segment) && !covered(item.segment, reserved.filter(entry => entry.link === item.link).map(entry => entry.segment))) missing.push({ gap: [gap.low, gap.high], ...item });
      }
      for (const entry of reserved) {
        const link = model.links.find(candidate => candidate.id === entry.link)!;
        if (link.removed || link.path === undefined) continue;
        if (!covered(entry.segment, link.path.segments)) stray.push({ gap: [gap.low, gap.high], link: entry.link, kind: entry.kind, segment: entry.segment });
      }
    }
    expect({ missing, stray }).toEqual({ missing: [], stray: [] });
  }, 60000);

  it('reads every kind of reserved geometry and every shape of planned part on these sheets', () => {
    expect([...seen].sort()).toEqual(['lane', 'mouth', 'path', 'planned', 'shape:drop', 'shape:stepped', 'shape:u', 'shape:z', 'shared', 'stem']);
  });
});
