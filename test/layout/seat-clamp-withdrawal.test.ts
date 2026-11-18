import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 47 (ruling of 2026-11-18, review 1): with `layout.moveBeforeGrow` a seat that survives the step window stands; a seat that
// the clamp of the step carries off its feeds is withdrawn alone (`ALIGNMENT_SEAT_REFUSED`), and the main move of the step stands. Before, the
// step was declined whole, main move included, on every pass, and the group stood at its stage-6 x with no seat or target of its own.
const NAME = 'a-seat-the-clamp-carries-off-its-feed-is-withdrawn-alone';
const yaml = readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8');
const lay = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
/** The turns of the routed links and of the overlay links (the score's counts, `pathBends`), the canvas width, the seats and the seat notes. */
const read = (model: LayoutModel) => {
  const { routed, overlay } = score(model).snapshot.counts;
  return { routed: routed.turns, overlay: overlay.turns, width: Math.round(model.canvas!.width), seats: Object.keys(model.alignmentSeats ?? {}).sort(),
    refused: model.diagnostics.filter(note => note.code === 'ALIGNMENT_SEAT_REFUSED').map(note => note.message) };
};

it('a seat the clamp carries off its feed is withdrawn alone: the main move stands', async () => {
  const model = await lay(yaml);
  expect(model.document.layout?.moveBeforeGrow).toBe(true);
  expect(read(model)).toEqual({ routed: 2, overlay: 0, width: 370, seats: [],
    refused: ['node-b keeps its place and width: the clamp into the step window carries its seat off its feeds; link-3 keeps a jog and routing completes it.'] });
  expect(Math.round(model.groups['row-b']!.bounds!.x)).toBe(202);
  expect(Math.round(model.nodes['node-b']!.bounds!.width)).toBe(55);
}, 120000);

it('a seat that survives the step window stands (the nodes block reversed): every link straight', async () => {
  expect(read(await lay(reversed(yaml, 'nodes')))).toEqual({ routed: 0, overlay: 0, width: 524, seats: ['node-b'], refused: [] });
}, 120000);

// Four nodes and four links (review 1): with `node-b` first its seat survives the clamp and holds the routed link and the overlay straight; with
// the nodes block reversed the clamp carries it off, and only the seat is withdrawn: the routed link stays straight on the main move.
const FOUR = `portograph: 2
layout: { moveBeforeGrow: true }
groups:
  core: { tier: 0 }
  row-a: { tier: 1 }
  row-b: { tier: 1 }
nodes:
  node-b: { group: row-b, ports: [{ name: uplink-3 }] }
  node-a: { group: row-a, ports: [{ name: uplink-1 }, { name: eth2_102 }] }
  relay-3: { group: core }
  hub: { group: core }
links:
  - [node-a.uplink-1, hub, { id: link-1 }]
  - [node-a.eth2_102, hub, { id: link-2 }]
  - [node-b.uplink-3, hub, { id: link-3 }]
  - [node-b, relay-3, { id: ov-3, route: overlay }]
`;

it('four nodes: the seat that survives stands, the one the clamp carries off is withdrawn alone', async () => {
  expect(read(await lay(FOUR))).toEqual({ routed: 0, overlay: 0, width: 334, seats: ['node-b'], refused: [] });
  const back = read(await lay(reversed(FOUR, 'nodes')));
  expect(back).toMatchObject({ routed: 0, overlay: 2, width: 276, seats: [] });
  expect(back.refused).toHaveLength(1);
}, 120000);
