import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { centreCheckTrace } from '../../src/layout/centre.js';
import { findPort } from '../../src/layout/row-paths.js';
import { portId } from '../../src/layout/skeleton-graph.js';
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
    refused: ['node-b keeps its place and width: the clamp into the step window carries its seat off the feeds of link-3.'] });
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

// Review 2: a recorded seat the step aligns again and the withdrawal undoes is retired with the rest (clause 4). Nine nodes; `b2` is seated in an
// earlier pass, aligned again by the step, and carried off by the clamp. The next group and the replay read the model the step leaves.
const RETIRED = `portograph: 2
layout:
  moveBeforeGrow: true
groups:
  core:
    tier: 0
  row-a:
    tier: 1
  row-b:
    tier: 1
  bot:
    tier: 2
nodes:
  hub:
    group: core
    size:
      width: 255
      height: 45
  relay-1:
    group: core
  relay-2:
    group: core
  relay-3:
    group: core
  node-a:
    group: row-a
    ports:
      - name: uplink-1
      - name: eth2_102
  node-b:
    group: row-b
    ports:
      - name: uplink-3
    size:
      width: 65
      height: 46
  b2:
    group: row-b
    size:
      width: 104
      height: 50
  a2:
    group: row-a
    size:
      width: 104
      height: 50
  lower:
    group: bot
links:
  - - node-a.uplink-1
    - hub
    - id: link-1
  - - node-a.eth2_102
    - hub
    - id: link-2
  - - node-b.uplink-3
    - hub
    - id: link-3
      label: fibre 120M
  - - node-a
    - node-b
    - id: tunnel
  - - node-a
    - relay-2
    - id: ov-1
      route: overlay
  - - node-a
    - relay-1
    - id: ov-2
      route: overlay
  - - node-b
    - relay-3
    - id: ov-3
      route: overlay
  - - b2
    - hub
    - {}
  - - b2
    - node-a
    - route: overlay
  - - a2
    - hub
    - {}
  - - node-b
    - lower
    - route: orthogonal
  - - node-a
    - lower
    - route: orthogonal
`;
// Review 2: after the withdrawal the misses are read again on the geometry the second settle leaves. Eight nodes; `b2` ends on its feed.
const REREAD = `portograph: 2
layout:
  moveBeforeGrow: true
groups:
  core:
    tier: 0
  row-a:
    tier: 1
  row-b:
    tier: 1
nodes:
  hub:
    group: core
  relay-1:
    group: core
  relay-2:
    group: core
  relay-3:
    group: core
  node-a:
    group: row-a
    ports:
      - name: uplink-1
      - name: eth2_102
  node-b:
    group: row-b
    ports:
      - name: uplink-3
  b2:
    group: row-b
    size:
      width: 35
      height: 50
  a2:
    group: row-a
    size:
      width: 35
      height: 50
links:
  - - node-a.uplink-1
    - hub
    - id: link-1
  - - node-a.eth2_102
    - hub
    - id: link-2
  - - node-b.uplink-3
    - hub
    - id: link-3
      label: fibre 120M
  - - node-a
    - node-b
    - id: tunnel
  - - node-a
    - relay-2
    - id: ov-1
      route: overlay
  - - node-a
    - relay-1
    - id: ov-2
      route: overlay
  - - node-b
    - relay-3
    - id: ov-3
      route: overlay
  - - b2
    - hub
    - {}
  - - b2
    - relay-3
    - route: overlay
  - - a2
    - hub
    - {}
`;

/** The feed x of a wanted port, read where the target record reads it: the far port, or the lane of a transit feed (`feedFar`). */
function feedX(model: LayoutModel, nodeId: string, key: string): number | undefined {
  const port = model.nodes[nodeId]!.ports.find(item => portId(item.ref) === key)!;
  const far = model.alignmentTargets?.[`${nodeId}|${port.side}`]?.find(entry => entry.port === key)?.far;
  if (far === undefined) return undefined;
  if (far.startsWith('lane:')) return model.lanes.find(item => item.id === far.slice('lane:'.length))?.x;
  return model.links.flatMap(link => link.attachments ? [link.attachments.from, link.attachments.to] : []).map(end => findPort(model, end))
    .find(item => item !== undefined && portId(item.ref) === far)?.anchor?.x;
}
const stands = (model: LayoutModel, nodeId: string, key: string): boolean => {
  const x = feedX(model, nodeId, key), port = model.nodes[nodeId]!.ports.find(item => portId(item.ref) === key)!;
  return x !== undefined && Math.abs(port.anchor!.x - x) <= 0.5;
};
/**
 * Each producer step of `group`, read on the model it leaves: the seats whose kept ports stand off their feed (or have no target), the wanted ports
 * that stand on their feed, and the ports the step leaves unresolved.
 */
async function steps(text: string, group: string): Promise<{ off: string[]; standing: string[]; unresolved: string[] }[]> {
  const found: { off: string[]; standing: string[]; unresolved: string[] }[] = [];
  const hook = centreCheckTrace.step;
  centreCheckTrace.step = (model, id, warn, unresolved) => {
    if (!warn || id !== group) return;
    const off: string[] = [], standing: string[] = [];
    for (const nodeId of model.groups[id]!.nodes) {
      for (const key of model.alignmentSeats?.[nodeId]?.ports ?? []) if (!stands(model, nodeId, key)) off.push(`${nodeId} ${key}`);
      for (const port of model.nodes[nodeId]!.ports) if (feedX(model, nodeId, portId(port.ref)) !== undefined && stands(model, nodeId, portId(port.ref))) standing.push(portId(port.ref));
    }
    found.push({ off, standing: standing.sort(), unresolved: [...unresolved].sort() });
  };
  try { await lay(text); } finally { if (hook === undefined) delete centreCheckTrace.step; else centreCheckTrace.step = hook; }
  return found;
}

it('a recorded seat the withdrawal undoes gives its growth back: no group step leaves a seat off its feed for the next group', async () => {
  const found = await steps(RETIRED, 'row-b');
  expect(found.length).toBeGreaterThan(0);
  expect(found.flatMap(item => item.off)).toEqual([]);
  const model = await lay(RETIRED);
  expect(model.nodes['b2']!.bounds!.width).toBeLessThan(105);
}, 120000);

it('the misses after a withdrawal are read on the geometry the step leaves: a port on its feed is not unresolved', async () => {
  const found = await steps(REREAD, 'row-b');
  expect(found.some(item => item.standing.some(key => key.includes('"b2"')))).toBe(true);
  expect(found.flatMap(item => item.standing.filter(key => item.unresolved.includes(key)))).toEqual([]);
}, 120000);

// Review 2, P2b (ruling of 2026-11-18: the trade is accepted and recorded). Eight nodes. Main (4b891688) draws a2 -> hub (link-3) and the tunnel
// node-a -> node-b (link-10) straight: 825 px wide, routed turns 8, overlay turns 2. With the withdrawal (de91aa8e) row-b keeps its main move:
// 682 px wide, routed turns 14, overlay turns 0. The step's own measure is a tie; the two links are lost by later decisions (the course round's
// comparison and the overlay order of tier 1), which no step rule reads. Pinned so that a change of the course round shows here.
const TRADE = `portograph: 2
layout:
  moveBeforeGrow: true
groups:
  core:
    tier: 0
  row-a:
    tier: 1
  row-b:
    tier: 1
nodes:
  hub:
    group: core
    size:
      width: 60
      height: 45
  relay-1:
    group: core
  relay-2:
    group: core
  relay-3:
    group: core
    size:
      width: 100
      height: 60
  node-a:
    group: row-a
    ports:
      - name: uplink-1
      - name: eth2_102
    size:
      width: 140
      height: 50
  node-b:
    group: row-b
    ports:
      - name: uplink-3
    size:
      width: 75
      height: 46
  b2:
    group: row-b
    size:
      width: 127
      height: 50
  a2:
    group: row-a
    size:
      width: 127
      height: 50
links:
  - - node-a.uplink-1
    - hub
    - id: link-1
  - - node-a.eth2_102
    - hub
    - id: link-2
  - - node-b.uplink-3
    - hub
    - id: link-3
      label: fibre 120M
  - - node-a
    - node-b
    - id: tunnel
  - - node-a
    - relay-2
    - id: ov-1
      route: overlay
  - - node-a
    - relay-1
    - id: ov-2
      route: overlay
  - - node-b
    - relay-3
    - id: ov-3
      route: overlay
  - - b2
    - hub
    - {}
  - - b2
    - relay-3
    - route: overlay
  - - a2
    - hub
    - {}
`;

it('the accepted trade of review 2: the withdrawal keeps the main move, and two links outside the step bend', async () => {
  const model = await lay(TRADE);
  const { routed, overlay } = score(model).snapshot.counts;
  expect({ width: Math.round(model.canvas!.width), routed: routed.turns, overlay: overlay.turns }).toEqual({ width: 682, routed: 14, overlay: 0 });
}, 120000);
