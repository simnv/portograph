import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { score } from '../../src/score/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

type Segment = { from: { x: number; y: number }; to: { x: number; y: number } };

describe('a piece whose ends stand under a run clearance apart holds no row (ranked-groups ticket 42)', () => {
  it('routes the near-vertical link with no run of its own, removes nothing and passes every gate', async () => {
    const text = readFileSync(new URL('../../goldens/synthetic/a-near-vertical-piece-holds-no-row.yaml', import.meta.url), 'utf8');
    // On main this input fails with PIPELINE_FAILED (a routed path retraces itself): the piece held a row 1.1 px wide.
    const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
    for (const [id, gate] of Object.entries(score(model).snapshot.gates)) expect(gate.passed, id).toBe(true);

    const near = model.links.find(link => link.id === 'link-5')!;
    const segments = near.path!.segments as Segment[];
    const ends = [segments[0]!.from.x, segments[segments.length - 1]!.to.x];
    expect(Math.abs(ends[0]! - ends[1]!)).toBeGreaterThan(0.5);
    expect(Math.abs(ends[0]! - ends[1]!)).toBeLessThan(11.5);
    // It holds no row: no horizontal of the path is wider than the offset between its ends.
    for (const segment of segments) {
      if (Math.abs(segment.from.y - segment.to.y) < 1e-6) expect(Math.abs(segment.from.x - segment.to.x)).toBeLessThan(2);
    }
    const grown = model.diagnostics.filter(diagnostic => diagnostic.code === 'TIER_GAP_GROWN');
    expect(grown).toHaveLength(1);
    // Ticket 50: H = 99.5, 39.5 above the 60 px band gap (main: 77.25 at the 17.5 px pitch). Link-7 is the last of the gap's rows,
    // 303.5, 55.5 px below the low boundary 248; its run crosses the nested lower leg of link-6 (32.5 px deep), so it needs k + 32.5 = 44 px
    // of gap below the row: 55.5 + 44 = 99.5. Link-5, the near-vertical part, is a drop with a 1.1 px jog and takes no row.
    expect(Number(/grew ([\d.]+) px/.exec(grown[0]!.message)![1])).toBeCloseTo(39.5, 6);
  }, 60000);
});
