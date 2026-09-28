import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { findPort } from '../../src/layout/row-paths.js';
import { stemCheckpoint } from '../../src/route/plan.js';
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
});
