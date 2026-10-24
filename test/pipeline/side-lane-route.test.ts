import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { validateLanes } from '../../src/internal.js';
import type { Lane, LayoutLink, LayoutModel } from '../../src/index.js';
import { BUS_RUN_CLEARANCE } from '../../src/layout/bus-room.js';
import { holdsMove } from '../../src/layout/move-reservations.js';
import { laneSidesHold, laneWidth, reserveRisers, sideLaneFindings, sideLanesHold } from '../../src/layout/lanes.js';
import { routedStrokeWidth } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 122 (docs/design/side-faces.md, Sections 10, 11 and 13, Q109): a side lane joins the tier-gap plan, the route, 7c and 7f, and the riser. */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string): Promise<LayoutModel> => layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const thaw = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
const sideLane = (model: LayoutModel): Lane => model.lanes.find(lane => lane.kind === 'side')!;
const ownerOf = (model: LayoutModel, lane: Lane): LayoutLink => model.links.find(link => link.id === (lane.owner as { id: string }).id)!;
const CROSS = 'a-far-end-between-the-anchor-and-a-side-lane';
const failed = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const NEW = 'a-link-drops-beside-a-frame-into-a-lateral-side', HELD = 'a-held-lane-stays-on-its-frames-side-of-a-foreign-frame';
const CENTRED = 'a-far-port-is-centred-under-a-side-lane', RISER = 'a-riser-keeps-out-of-a-side-lane';
const nodeTierOf = (model: LayoutModel, node: string): number => model.groups[model.document.nodes[node]!.group]!.tier!;
const findFar = (model: LayoutModel, link: LayoutLink, lane: Lane) => {
  const ends = link.attachments!, ref = ends.from.node === lane.port!.node ? ends.to : ends.from;
  return model.nodes[ref.node]!.ports.find(port => port.ref.ordinal === ref.ordinal && port.ref.name === ref.name)!.anchor!;
};
/** The bends of a path: the turns between two segments that run on different axes. */
const bends = (link: LayoutLink): number => {
  const axes = link.path!.segments.filter(s => Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) > 1e-6).map(s => Math.abs(s.to.x - s.from.x) < 1e-6 ? 'v' : 'h');
  return axes.filter((axis, i) => i > 0 && axis !== axes[i - 1]).length;
};

describe('a side lane joins the tier-gap plan and the route (ticket 122)', () => {
  it('publishes the drop, the lane vertical and the side run as one path with one bend, and removes nothing', async () => {
    const model = await run(NEW);
    const lane = sideLane(model), link = ownerOf(model, lane);
    expect(link.removed).toBeUndefined();
    expect(model.diagnostics.filter(item => item.code === 'ROUTE_CHECKPOINT_SKIPPED')).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'TIER_GAP_PART_RESIDUAL' && item.message.includes(link.id))).toEqual([]);
    for (const run of link.fixedSegments!) expect(link.path!.segments.some(segment => JSON.stringify(segment) === JSON.stringify(run))).toBe(true);
    expect(lane.aligned).toBe(true);
    expect(bends(link)).toBe(1);
    // The path is the drop at the lane x from the load balancer's stem, then the side run to the port's face.
    const segments = link.path!.segments, last = segments.at(-1)!;
    expect(segments.slice(0, -1).every(segment => Math.abs(segment.from.x - lane.x) < 1e-6 && Math.abs(segment.to.x - lane.x) < 1e-6)).toBe(true);
    expect(last.to).toEqual(model.nodes['outlet']!.ports.find(port => port.ref.name === 'feed')!.anchor);
    expect(failed(model)).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'SIDE_SHAPE_LOST' || item.code === 'SIDE_LANE_INSIDE_FRAME')).toEqual([]);
  }, 120000);

  it('a side lane that is not source-aligned gives a stepped part to its mouth, and the path still validates', async () => {
    const model = await run(HELD);
    const lane = sideLane(model), link = ownerOf(model, lane);
    expect(link.removed).toBeUndefined();
    expect(model.diagnostics.filter(item => item.code === 'ROUTE_CHECKPOINT_SKIPPED')).toEqual([]);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    for (const run of link.fixedSegments!) expect(link.path!.segments.some(segment => JSON.stringify(segment) === JSON.stringify(run))).toBe(true);
    // The far port stands off the lane: the part is stepped (more than one bend).
    const far = findFar(model, link, lane);
    expect(Math.abs(far.x - lane.x)).toBeGreaterThan(1);
    expect(bends(link)).toBeGreaterThan(1);
  }, 120000);

  it('7c holds the far port under the lane x when the far end tier is centred after the lane', async () => {
    const model = await run(CENTRED);
    const lane = sideLane(model), link = ownerOf(model, lane);
    const far = model.nodes['lb']!.ports.find(port => port.ref.ordinal === link.attachments!.from.ordinal)!.anchor!;
    expect(model.anchorTier).not.toBe(nodeTierOf(model, 'lb'));
    // 7a did not seat the lane on the far port's x; centring did, and recorded it.
    expect(lane.aligned).toBeUndefined();
    expect(model.diagnostics.filter(item => item.code === 'SIDE_LANE_SEATED')).toEqual([expect.objectContaining({ severity: 'info', owners: [{ kind: 'link', id: link.id }] })]);
    expect(model.diagnostics.some(item => item.code === 'SIDE_SHAPE_LOST')).toBe(false);
    expect(far.x).toBeCloseTo(lane.x, 6);
    expect(bends(link)).toBe(1);
    expect(link.removed).toBeUndefined();
  }, 120000);

  it('7c holds the far port on the lane when the far end stands between the anchor and the lateral end', async () => {
    const model = await run(CROSS);
    const lane = sideLane(model), link = ownerOf(model, lane);
    expect(nodeTierOf(model, 'lb')).toBeLessThan(nodeTierOf(model, 'outlet'));
    expect(model.anchorTier).toBeLessThan(nodeTierOf(model, 'lb'));
    expect(findFar(model, link, lane).x).toBeCloseTo(lane.x, 6);
    expect(bends(link)).toBe(1);
    expect(model.diagnostics.some(item => item.code === 'SIDE_SHAPE_LOST')).toBe(false);
  }, 120000);

  it('a lane the far port never stood on gives no SIDE_SHAPE_LOST (held lane and riser fixtures)', async () => {
    for (const name of [HELD, RISER]) {
      const model = await run(name);
      expect(model.diagnostics.filter(item => item.code === 'SIDE_SHAPE_LOST'), name).toEqual([]);
    }
    const riser = await run(RISER);
    expect(Math.abs(findFar(riser, ownerOf(riser, sideLane(riser)), sideLane(riser)).x - sideLane(riser).x)).toBeLessThan(1e-6);
  }, 120000);

  it('a 7f column move of the far end group off the lane x is refused (SIDE_LANE_HELD); without the guard the part turns stepped and SIDE_SHAPE_LOST fires', async () => {
    const model = thaw(await run(NEW));
    const lane = sideLane(model), link = ownerOf(model, lane);
    const group = model.groups[model.document.nodes['lb']!.group]!;
    const proposed = [{ group, bounds: { ...group.bounds!, x: group.bounds!.x + 12 } }];
    expect(sideLanesHold(model, proposed, false)).toBe(false);
    expect(holdsMove(model, proposed, false)).toBe(false);
    expect(model.diagnostics.some(item => item.code === 'SIDE_LANE_HELD')).toBe(false);
    expect(holdsMove(model, proposed)).toBe(false);
    expect(model.diagnostics.filter(item => item.code === 'SIDE_LANE_HELD')).toEqual([expect.objectContaining({ severity: 'info', owners: [{ kind: 'link', id: link.id }] })]);
    // A move that keeps the x is no business of the guard.
    expect(sideLanesHold(model, [{ group, bounds: { ...group.bounds! } }])).toBe(true);
    // The move made anyway (a widening 7f cannot refuse): the far port leaves the lane and the finding names the link.
    expect(sideLaneFindings(model)).toEqual([]);
    for (const id of group.nodes) {
      const node = model.nodes[id]!;
      node.bounds!.x += 12;
      for (const port of node.ports) port.anchor!.x += 12;
    }
    expect(sideLaneFindings(model)).toEqual([expect.objectContaining({ code: 'SIDE_SHAPE_LOST', severity: 'warning', owners: [{ kind: 'link', id: link.id }] })]);
  }, 120000);

  it('warns when a frame box crosses the side lane, without throwing', async () => {
    const model = thaw(await run(NEW));
    const link = ownerOf(model, sideLane(model));
    const frame = model.frames![0]!;
    frame.box = { ...frame.box, width: frame.box.width + 60 };
    expect(sideLaneFindings(model)).toEqual([expect.objectContaining({ code: 'SIDE_LANE_INSIDE_FRAME', severity: 'warning', owners: [{ kind: 'link', id: link.id }] })]);
  }, 120000);
});

describe('the riser keeps out of a side lane (ticket 122, Section 13)', () => {
  it('a mesh over two rows with a side lane in the band of a member row publishes, and the riser keeps the run clearance from the lane', async () => {
    const model = await run(RISER);
    const lane = sideLane(model), upper = model.meshBuses![0]!, half = laneWidth(model) / 2;
    expect(lane.tier).toBeGreaterThanOrEqual(upper.row);
    expect(ownerOf(model, lane).removed).toBeUndefined();
    const gap = Math.abs(upper.riser!.x - lane.x) - lane.bounds.width / 2 - half;
    expect(gap).toBeGreaterThanOrEqual(BUS_RUN_CLEARANCE + routedStrokeWidth(model) / 2 - 1e-6);
    expect(failed(model)).toEqual([]);
  }, 120000);

  it('reserveRisers reads a pending side lane of a member row as a fixed-x leg: the riser moves off the x it would take', async () => {
    const model = thaw(await run('a-mesh-over-two-rows-joins-its-bars-with-one-riser'));
    const [upper] = model.meshBuses!, x0 = upper!.riser!.x;
    model.lanes = model.lanes.filter(lane => lane.owner.kind !== 'mesh-bus');
    delete upper!.riser;
    const host = Object.values(model.groups).find(group => group.tier === upper!.row)!;
    const lane: Lane = { id: 'side-lane:probe', owner: { kind: 'link', id: 'probe' }, layer: 'routed', group: host.id, tier: upper!.row, side: 'right', kind: 'side',
      x: x0, bounds: { x: x0 - 17, width: 34, y: 0, height: 10 } };
    const pending: Lane[] = [lane];
    reserveRisers(model, pending, group => group.bounds!);
    const half = laneWidth(model) / 2;
    expect(Math.abs(upper!.riser!.x - x0)).toBeGreaterThanOrEqual(17 + half + BUS_RUN_CLEARANCE + routedStrokeWidth(model) / 2 - 1e-6);
  }, 120000);
});

describe('review fixes of ticket 118 (placement against the frames as the transit lanes leave them)', () => {
  // The review repro: the transit lanes of a canton member grow its frame past a side lane placed against the frame boxes of before them.
  const CANTON = `portograph: 2
groups:
  west: { label: West }
  top: { tier: 0, label: Top }
  gate: { tier: 1, canton: west, label: Gate }
  mid: { tier: 2, canton: west, label: Middle }
  deep: { tier: 3, canton: west, label: Deep }
nodes:
  lb: { group: top, class: router, label: LB }
  g1: { group: gate, class: router, label: G1 }
  g2: { group: gate, class: router, label: G2, ports: [{ name: feed, side: right }] }
  m1: { group: mid, class: switch, label: M1 }
  m2: { group: mid, class: switch, label: M2 }
  m3: { group: mid, class: switch, label: M3 }
  m4: { group: mid, class: switch, label: M4 }
  d1: { group: deep, class: server, label: D1 }
links:
  - [lb, g1]
  - [g1, d1]
  - [g2, d1]
  - [lb, g2.feed]
`;
  it('a side lane stands beyond the frame that a transit lane of the same canton grows', async () => {
    const model = await layout(parse(CANTON), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const lane = sideLane(model), west = model.frames!.find(frame => frame.id === 'west')!;
    expect(lane.bounds.x).toBeGreaterThanOrEqual(west.box.x + west.box.width - 1e-6);
    expect(model.diagnostics.filter(item => item.code === 'SIDE_LANE_INSIDE_FRAME')).toEqual([]);
    expect(ownerOf(model, lane).removed).toBeUndefined();
  }, 120000);

  it('a move that would widen the frame across the side lane is refused, and a move away is not', async () => {
    const model = thaw(await run(NEW));
    const lane = sideLane(model), cell = model.groups[model.document.nodes['outlet']!.group]!;
    // Inside the slack of the group box (the lane stands a frame margin beyond it), so the group check passes and the frame box decides.
    const frame = model.frames!.find(item => item.id === model.groups[cell.id]!.frame) ?? model.frames![0]!;
    const slack = lane.bounds.x - (frame.box.x + frame.box.width), dx = slack + 2;
    expect(slack).toBeGreaterThan(0);
    const towards = [{ group: cell, bounds: { ...cell.bounds!, x: cell.bounds!.x + dx } }], away = [{ group: cell, bounds: { ...cell.bounds!, x: cell.bounds!.x - 8 } }];
    expect(laneSidesHold(model, towards, false)).toBe(false);
    expect(laneSidesHold(model, away, false)).toBe(true);
    expect(lane.tier).toBe(cell.tier);
  }, 120000);

  it('a node beyond the port in its row after 7a is a warning, not a reason to refuse the publication', async () => {
    const model = thaw(await run(NEW));
    expect(sideLaneFindings(model)).toEqual([]);
    const spare = model.nodes['spare']!, outlet = model.nodes['outlet']!;
    spare.bounds!.x = outlet.bounds!.x + outlet.bounds!.width + 6;
    spare.bounds!.width = 12;
    expect(() => validateLanes(model)).not.toThrow();
    expect(sideLaneFindings(model).map(item => item.code)).toEqual(['SIDE_LANE_NOT_OUTERMOST']);
  }, 120000);
});

describe('the corridor candidates of 7a (review fix 5 of ticket 118)', () => {
  it('a lane takes the gap between the frame and a wide group beyond it when the far port stands over that group', async () => {
    const yaml = source(NEW).replace('  bank: { tier: 1, label: Bank }\n', '  bank: { tier: 1, label: Bank }\n  wing: { tier: 1, label: Wing }\n')
      .replace('  tail: {', '  wing-a: { group: wing, class: server, label: Wing of the building with a very long name for a wide body }\n  tail: {')
      .replace('  fe4:', '  fe5: { group: front, class: router, label: FE5 }\n  fe4:').replace('links:\n', 'links:\n  - [lb, wing-a]\n  - [fe5, spare]\n');
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const lane = sideLane(model), frame = model.frames![0]!, wing = model.nodes['wing-a']!.bounds!;
    expect(model.diagnostics.filter(item => item.code === 'SIDE_LANE_REFUSED')).toEqual([]);
    expect(lane.bounds.x).toBeGreaterThanOrEqual(frame.box.x + frame.box.width - 1e-6);
    expect(lane.bounds.x + lane.bounds.width).toBeLessThanOrEqual(wing.x + 1e-6);
    expect(ownerOf(model, lane).removed).toBeUndefined();
  }, 120000);
});
