import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { Lane, LayoutLink, LayoutModel } from '../../src/index.js';
import { BUS_RUN_CLEARANCE } from '../../src/layout/bus-room.js';
import { laneWidth, optionalMoveHolds, reserveRisers, sideLaneFindings, sideLanesHold } from '../../src/layout/lanes.js';
import { routedStrokeWidth } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 122 (docs/design/side-faces.md, Sections 10, 11 and 13, Q109): a side lane joins the tier-gap plan, the route, 7c and 7f, and the riser. */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string): Promise<LayoutModel> => layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const thaw = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
const sideLane = (model: LayoutModel): Lane => model.lanes.find(lane => lane.kind === 'side')!;
const ownerOf = (model: LayoutModel, lane: Lane): LayoutLink => model.links.find(link => link.id === (lane.owner as { id: string }).id)!;
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
    expect(model.diagnostics.filter(item => item.code === 'SIDE_SHAPE_LOST' || item.code === 'SIDE_LANE_FRAME_CROSSED')).toEqual([]);
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
    expect(lane.aligned).toBe(true);
    expect(far.x).toBeCloseTo(lane.x, 6);
    expect(bends(link)).toBe(1);
    expect(link.removed).toBeUndefined();
  }, 120000);

  it('a 7f column move of the far end group off the lane x is refused (SIDE_LANE_HELD); without the guard the part turns stepped and SIDE_SHAPE_LOST fires', async () => {
    const model = thaw(await run(NEW));
    const lane = sideLane(model), link = ownerOf(model, lane);
    const group = model.groups[model.document.nodes['lb']!.group]!;
    const proposed = [{ group, bounds: { ...group.bounds!, x: group.bounds!.x + 12 } }];
    expect(sideLanesHold(model, proposed, false)).toBe(false);
    expect(optionalMoveHolds(model, proposed, false)).toBe(false);
    expect(model.diagnostics.some(item => item.code === 'SIDE_LANE_HELD')).toBe(false);
    expect(optionalMoveHolds(model, proposed)).toBe(false);
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
    expect(sideLaneFindings(model)).toEqual([expect.objectContaining({ code: 'SIDE_LANE_FRAME_CROSSED', severity: 'warning', owners: [{ kind: 'link', id: link.id }] })]);
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
