import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { findPort } from '../../src/layout/row-paths.js';

/**
 * Architecture 2, ticket 80: links between two nodes that leave facing faces keep one side order at both ends, whatever their family and authored direction (R3).
 * The fixtures are a pair: the cable and the overlay are written in opposite directions, and the same sheet with both directions reversed. Neither crosses.
 * Which of the two links stands first is not tested: the stage-4 draft mirrors it with the authored direction of a reversed edge, and stage 5 only makes both ends agree.
 */
const run = async (name: string) => {
  const text = readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
  return layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
};
const FIRST = 'a-cable-and-an-overlay-between-two-nodes-keep-one-side-order';
const SECOND = `${FIRST}-written-the-other-way`;
/** The ids of the links of the pair (`link-N`, N the 1-based place in `links`: the cable is `link-3`, the overlay `link-6`), in engine order along the face of `node` that they leave. */
const faceOrder = (model: Awaited<ReturnType<typeof run>>, node: string, ids: string[]): string[] => {
  const mine = model.links.filter(link => ids.includes(link.id)).map(link => {
    const end = link.attachments!.from.node === node ? link.attachments!.from : link.attachments!.to;
    const port = findPort(model, end)!;
    return { id: link.id, side: port.side, order: port.engineOrder! };
  });
  expect(new Set(mine.map(item => item.side)).size).toBe(1);
  return mine.sort((a, b) => a.order - b.order).map(item => item.id);
};

it.each([FIRST, SECOND])('%s: the cable and the overlay keep one side order at both ends', async name => {
  const model = await run(name);
  const ids = ['link-3', 'link-6'];
  expect(faceOrder(model, 'rtr', ids)).toEqual(faceOrder(model, 'peer', ids));
}, 60000);
