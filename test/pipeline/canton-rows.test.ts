import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string): Promise<LayoutModel> => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const frame = (model: LayoutModel, id: string): Rect => model.frames!.find(item => item.id === id)!.box;
const right = (box: Rect): number => box.x + box.width;
const centreX = (box: Rect): number => box.x + box.width / 2;

// Canton-groups tickets 61 and 63: the rows of a canton's members, read on the placed model.
describe('rows of canton members', () => {
  it('members of two tiers stand as two beside rows, not one row of four (ticket 63)', async () => {
    const model = await run('members-of-two-tiers-stand-as-two-rows');
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const [na, nb, sa, sb, west] = ['north-a', 'north-b', 'south-a', 'south-b', 'west'].map(id => frame(model, id))  as [Rect, Rect, Rect, Rect, Rect];
    const row = (a: Rect, b: Rect): number => Math.max(right(a), right(b)) - Math.min(a.x, b.x);
    const widest = Math.max(row(na, nb), row(sa, sb));
    expect(west.width).toBeLessThanOrEqual(widest + 40 + 1e-6);
    // Each tier-2 member stands under its tier-1 partner, and each row is 40 px apart.
    expect(Math.abs(centreX(sa) - centreX(na))).toBeLessThan(5);
    expect(Math.abs(centreX(sb) - centreX(nb))).toBeLessThan(5);
    expect(Math.abs(nb.x - right(na) - 40)).toBeLessThan(1);
    expect(Math.abs(sb.x - right(sa) - 40)).toBeLessThan(1);
    // The canton is judged once, both rows together: no turn of one row alone is refused for the crossings it would raise.
    expect(model.diagnostics.filter(item => item.code === 'OVERLAY_ORDER_REFUSED')).toEqual([]);
  }, 60000);
});
