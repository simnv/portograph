import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ranked-groups ticket 90: a gap row seated from its own end node's stem tip and the group margin ran 10.75 px under a taller
 * neighbour's body. The plan seats a row from the lowest body edge of every node it passes under or beside.
 */
const yaml = readFileSync(new URL('../../goldens/synthetic/a-gap-row-under-a-row-of-unequal-heights-clears-the-taller-body.yaml', import.meta.url), 'utf8');
const run = () => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a gap row clears the lowest body of its row', () => {
  it('publishes the fixture with no G6 violation and no removed link', async () => {
    const model = await run();
    expect(score(model).snapshot.gates.G6.violations).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  });

  it('runs the bent link row 10 px plus both half strokes below the taller body', async () => {
    const model = await run();
    const link = model.links.find(item => item.attachments!.from.node === 'n2' && item.attachments!.to.node === 'n5')!;
    expect(link.technique).toBe('orthogonal');
    const row = link.path!.segments.find(segment => segment.from.y === segment.to.y)!;
    const tall = model.nodes['n3']!.bounds!;
    const half = ((link.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path) + (model.nodes['n3']!.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2;
    expect(row.from.y - (tall.y + tall.height)).toBeGreaterThanOrEqual(10 + half - 1e-6);
  });
});
