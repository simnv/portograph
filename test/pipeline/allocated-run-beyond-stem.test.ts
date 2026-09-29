import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { bands } from '../../src/layout/bands.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { findPort } from '../../src/layout/row-paths.js';
import { rows } from '../../src/layout/rows.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { resolve } from '../../src/resolve/index.js';
import { planRoute, stemCheckpoint } from '../../src/route/plan.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

type Point = { x: number; y: number };

/** Whether a point lies on a segment. */
function onSegment(from: Point, to: Point, at: Point): boolean {
  const cross = (to.x - from.x) * (at.y - from.y) - (to.y - from.y) * (at.x - from.x);
  const along = (at.x - from.x) * (to.x - from.x) + (at.y - from.y) * (to.y - from.y);
  const span = (to.x - from.x) ** 2 + (to.y - from.y) ** 2;
  return Math.abs(cross) < 1e-3 * Math.sqrt(span || 1) && along > -1e-6 && along < span + 1e-6;
}

describe('an allocated run in a tier gap', () => {
  it('starts no closer to its port than the port stem, so the stem checkpoint lies on the path', async () => {
    const model = await layout(parse(fixture('an-allocated-run-starts-beyond-the-stem')),
      { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
    for (const link of model.links) {
      expect(link.path, link.id).toBeDefined();
      for (const end of ['from', 'to'] as const) {
        const port = findPort(model, link.attachments![end]);
        if (!port?.anchor || port.side === undefined) continue;
        const tip = stemCheckpoint(model, port);
        expect(link.path!.segments.some(segment => onSegment(segment.from, segment.to, tip)), `${link.id} ${end}`).toBe(true);
      }
    }
  }, 60000);

  it('ends each allocated run at the stem tip of the port it leads to, never between the port and the tip', async () => {
    const model = sizeNodes(sidesOne(resolve(parse(fixture('an-allocated-run-starts-beyond-the-stem')))));
    await skeleton(model, { createAttempt });
    const placed = [rows, lanes, flanks, centre, bars, bundles, bands].reduce((current, stage) => stage(current), sidesTwo(model));
    const plan = planRoute(placed);
    const near = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
    let ends = 0;
    for (const item of plan.links) {
      const link = placed.links.find(entry => entry.id === item.link)!;
      for (const end of ['from', 'to'] as const) {
        const port = findPort(placed, link.attachments![end]);
        if (!port?.anchor || port.side === undefined) continue;
        const tip = stemCheckpoint(placed, port);
        for (const piece of item.pieces) {
          if (piece.kind !== 'allocated') continue;
          for (const segment of piece.segments) {
            for (const point of [segment.from, segment.to]) {
              if (Math.abs(point.x - port.anchor.x) > 1e-6) continue;
              const lo = Math.min(port.anchor.y, tip.y), hi = Math.max(port.anchor.y, tip.y);
              // No end of a run lies strictly between the port and its stem tip.
              expect(point.y > lo + 1e-6 && point.y < hi - 1e-6, `${item.link} ${end}`).toBe(false);
              if (near(point, tip)) ends++;
            }
          }
        }
      }
    }
    // The fixture holds a port row closer than one stem to the gap, so at least one run ends on a tip.
    expect(ends).toBeGreaterThan(0);
  }, 60000);
});
