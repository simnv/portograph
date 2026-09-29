import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutLink } from '../../src/index.js';
import { score } from '../../src/score/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const EPS = 1e-6;
type Segment = { from: { x: number; y: number }; to: { x: number; y: number } };
const segments = (link: LayoutLink): Segment[] => link.path!.segments as Segment[];

/** The interior crossings of two routed paths: a point strictly inside a segment of each. */
function strictCrossings(a: LayoutLink, b: LayoutLink): { x: number; y: number }[] {
  const inside = (value: number, one: number, other: number): boolean => value > Math.min(one, other) + EPS && value < Math.max(one, other) - EPS;
  const points: { x: number; y: number }[] = [];
  for (const one of segments(a)) {
    for (const other of segments(b)) {
      const oneVertical = Math.abs(one.from.x - one.to.x) < EPS, otherVertical = Math.abs(other.from.x - other.to.x) < EPS;
      if (oneVertical === otherVertical) continue;
      const [vertical, horizontal] = oneVertical ? [one, other] : [other, one];
      if (inside(vertical.from.x, horizontal.from.x, horizontal.to.x) && inside(horizontal.from.y, vertical.from.y, vertical.to.y)) {
        points.push({ x: vertical.from.x, y: horizontal.from.y });
      }
    }
  }
  return points;
}

describe('the held rows of a tier gap are owed, not probed (ranked-groups ticket 42)', () => {
  it('grows a gap shared by three locations to the rows owed, not to the opening of the probe', async () => {
    const text = readFileSync(new URL('../../goldens/synthetic/held-rows-are-owed-not-probed.yaml', import.meta.url), 'utf8');
    const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
    const report = score(model).snapshot;
    for (const [id, gate] of Object.entries(report.gates)) expect(gate.passed, id).toBe(true);

    // Owed: the lowest legal row of the deepest pair plus the headroom above the lower boundary, 33.50 px in all.
    // Main grew this gap 63.00 px.
    const grown = model.diagnostics.filter(diagnostic => diagnostic.code === 'TIER_GAP_GROWN');
    expect(grown).toHaveLength(1);
    expect(Number(/grew ([\d.]+) px/.exec(grown[0]!.message)![1])).toBeCloseTo(33.5, 6);

    // Every strict crossing of a pair lies on a held row: a long horizontal of one of the two links.
    const links = model.links.filter(link => link.path);
    let crossings = 0;
    for (const [index, one] of links.entries()) {
      for (const two of links.slice(index + 1)) {
        for (const point of strictCrossings(one, two)) {
          crossings++;
          const rows = [one, two].flatMap(link => segments(link).filter(segment => Math.abs(segment.from.y - segment.to.y) < EPS
            && Math.abs(segment.from.x - segment.to.x) > 1).map(segment => segment.from.y));
          expect(rows.some(row => Math.abs(row - point.y) < EPS), `${one.id} x ${two.id}`).toBe(true);
        }
      }
    }
    expect(crossings).toBeGreaterThanOrEqual(3);
  }, 60000);
});
