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
import { laneFaceOrder, orderPortsByLanes } from '../../src/layout/turn-order.js';
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

  const faces = (model: LayoutModel): { node: string; side: 'top' | 'right' | 'bottom' | 'left' }[] => Object.values(model.nodes).flatMap(node =>
    (['top', 'right', 'bottom', 'left'] as const).filter(side => node.ports.some(port => port.side === side)).map(side => ({ node: node.id, side })));
  const clone = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

  it('leaves a face whose port position is reserved by a span chord or a course alone in 7a (finding 4)', async () => {
    const after = withLayoutMutation(await atRows(true), 'lanes', allocateLanes);
    const changed = (after.freeze!.turnOrder ?? [])[0]!;
    const plain = clone(after);
    expect(laneFaceOrder(plain, changed.node, changed.side)).toBeDefined();
    const link = plain.links.find(item => [item.attachments?.from, item.attachments?.to].some(ref => ref?.node === changed.node && plain.nodes[changed.node]!.ports.find(port => port.ref.ordinal === ref.ordinal)?.side === changed.side))!;
    const spanned = clone(after);
    spanned.links.find(item => item.id === link.id)!.spanHint = true;
    expect(laneFaceOrder(spanned, changed.node, changed.side)).toBeUndefined();
    const approached = clone(after);
    approached.courses = [{ link: link.id, kind: 'shared-port', from: { face: 'top' }, to: { face: 'top' }, runs: ['tier-gap'] }];
    expect(laneFaceOrder(approached, changed.node, changed.side)).toBeUndefined();
  }, 60000);

  it('keeps an order that no face would change again, or none at all (finding 5)', async () => {
    const start = clone(withLayoutMutation(await atRows(false), 'lanes', allocateLanes));
    const bounded = clone(start), settled = clone(start);
    bounded.turnOrder = true; settled.turnOrder = true;
    const orders = (model: LayoutModel): string => JSON.stringify(Object.values(model.nodes).map(node => node.ports.map(port => [port.engineOrder, port.anchor])));
    // No round to settle in: the orders stand as stage 5 gave them, nothing is recorded.
    orderPortsByLanes(bounded, 0);
    expect(orders(bounded)).toBe(orders(start));
    expect(bounded.freeze!.turnOrder).toBeUndefined();
    // The default bound settles, and then no face changes again.
    orderPortsByLanes(settled);
    expect(orders(settled)).not.toBe(orders(start));
    for (const face of faces(settled)) {
      const order = laneFaceOrder(settled, face.node, face.side);
      if (order !== undefined) expect(order.map(port => port.engineOrder)).toEqual([...order].map(port => port.engineOrder).sort((a, b) => a! - b!));
    }
  }, 60000);
});
