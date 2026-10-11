import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { rows } from '../../src/layout/rows.js';
import { allocateLanes } from '../../src/layout/lanes.js';
import { withLayoutMutation } from '../../src/layout/mutation.js';
import { createAttempt } from './phase-two-fixture.js';

/**
 * Architecture ticket 24, phase 4: stage 7a re-reads the turn order for transit lanes (docs/design/turn-order.md, Sections 4 and 5). The mutation check allows a `lanes`
 * reorder only to the order the comparator gives, and a run without the turn order never reorders in 7a.
 */
const SHEET = 'a-held-lane-stays-on-its-frames-side-of-a-foreign-frame';
const yaml = (): string => readFileSync(new URL(`../../goldens/synthetic/${SHEET}.yaml`, import.meta.url), 'utf8');

async function atRows(turnOrder: boolean): Promise<LayoutModel> {
  const resolved = resolve(parse(yaml()));
  if (turnOrder) resolved.turnOrder = true;
  const model = sizeNodes(sidesOne(resolved));
  await skeleton(model, { createAttempt });
  return rows(sidesTwo(model));
}
const orders = (model: LayoutModel): string[] => Object.values(model.nodes).flatMap(node =>
  (['top', 'right', 'bottom', 'left'] as const).map(side => `${node.id}${side}:${node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => port.ref.ordinal).join(',')}`));

describe('stage 7a and the turn order', () => {
  it('reorders a face to the comparator, records it, and the checked transaction passes', async () => {
    const before = await atRows(true);
    const after = withLayoutMutation(before, 'lanes', allocateLanes);
    expect(orders(after)).not.toEqual(orders(before));
    expect((after.freeze!.turnOrder ?? []).length).toBeGreaterThan((before.freeze!.turnOrder ?? []).length);
  }, 60000);

  it('refuses any other reorder in 7a', async () => {
    const before = await atRows(true);
    const swap = (model: LayoutModel): void => {
      allocateLanes(model);
      const face = Object.values(model.nodes).flatMap(node => (['top', 'right', 'bottom', 'left'] as const).map(side => node.ports.filter(port => port.side === side))).find(ports => ports.length > 1)!;
      const [a, b] = [face[0]!, face[1]!];
      const order = a.engineOrder!, anchor = a.anchor!;
      a.engineOrder = b.engineOrder!; a.anchor = b.anchor!;
      b.engineOrder = order; b.anchor = anchor;
    };
    expect(() => withLayoutMutation(before, 'lanes', swap)).toThrow();
  }, 60000);

  it('never reorders in 7a when the run does not carry the turn order', async () => {
    const before = await atRows(false);
    const after = withLayoutMutation(before, 'lanes', allocateLanes);
    expect(orders(after)).toEqual(orders(before));
    expect(after.freeze!.turnOrder).toBeUndefined();
  }, 60000);
});
