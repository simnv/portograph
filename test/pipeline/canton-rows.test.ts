import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { deriveFrames } from '../../src/layout/frames.js';
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

  // Ticket 61: a title that widens a member after 7f neither leaves the frame narrower than its cell nor opens the beside gap.
  it.each([
    ['a-member-title-widens-a-beside-row', ['alpha', 'beta', 'gamma']],
    ['a-canton-holds-three-members-on-one-tier', ['alpha', 'beta', 'gamma']],
    ['a-leaf-child-beside-its-parent-inside-a-canton', ['loc', 'wing']],
  ])('%s: every frame is its derived box and the beside gaps are 40 px after the whole layout (ticket 61)', async (name, members) => {
    const model = await run(name);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const derived = deriveFrames(model)!;
    for (const item of model.frames!) {
      const box = derived.find(other => other.id === item.id)!.box;
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(item.box[key], `${item.id}.${key}`).toBeCloseTo(box[key], 6);
      // The frame holds every cell box it owns, the widened one included.
      for (const cell of item.cells) {
        const cellBox = model.groups[cell]!.bounds!;
        expect(cellBox.x).toBeGreaterThanOrEqual(item.box.x - 1e-6);
        expect(right(cellBox)).toBeLessThanOrEqual(right(item.box) + 1e-6);
      }
    }
    for (const [i, id] of members.entries()) if (i) expect(frame(model, id).x - right(frame(model, members[i - 1]!)), `${members[i - 1]} to ${id}`).toBeCloseTo(40, 3);
  }, 60000);
});
