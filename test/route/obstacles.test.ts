import { GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth } from '../../src/theme/geometry.js';
import { GROUP_LABEL_GEOMETRY, routedStroke } from '../../src/layout/bands.js';
import { describe, expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { batchRequest, disjointShapes, pendingStemObstacles, planRoute, stemCheckpoint } from '../../src/route/plan.js';
import { nodeClearance, routeObstacles, trimChain, TERMINAL_TRIM } from '../../src/route/obstacles.js';
import { checkpointsHonoured, simplify } from '../../src/route/paths.js';
import { retraces } from '../../src/route/validate.js';
import type { Point, Rect } from '../../src/model/index.js';
import type { LayoutModel } from '../../src/model/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { rebuildBands, union } from '../../src/layout/skeleton-geometry.js';
import { findPort } from '../../src/layout/row-paths.js';
import { segmentRect } from '../../src/score/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const contains = (outer: Rect, inner: Rect): boolean => inner.x >= outer.x - 1e-9 && inner.y >= outer.y - 1e-9
  && right(inner) <= right(outer) + 1e-9 && bottom(inner) <= bottom(outer) + 1e-9;
const throughBands = async (yaml: string): Promise<LayoutModel> => bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));

const twoTier = `portograph: 2
groups: {up: {tier: 0}, low: {tier: 1, label: Lower}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, b.p]]`;

/**
 * The same two tiers with one gap the router really has to answer. Stage 8 claims a gap whose two
 * ends stand on one line and whose corridor is clear, so the facing pair above reaches no batch at
 * all; a right port feeding a top port has to turn.
 */
const twoTierBend = `portograph: 2
groups: {up: {tier: 0}, low: {tier: 1, label: Lower}}
nodes:
  a: {group: up, ports: [{name: p, side: right}]}
  z: {group: up}
  b: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, b.p]]`;

describe('stage 8 obstacles', () => {
  it('expands each node by its own stroke-aware clearance and swallows its pills', async () => {
    const model = await throughBands(twoTier);
    const obstacles = routeObstacles(model);
    // 10 px gate clearance plus half the node stroke (1.5) plus half the widest routed stroke (1.5).
    expect(nodeClearance(model, 'a')).toBe(11.5);
    const box = model.nodes.a!.bounds!, pill = model.nodes.a!.ports[0]!.pill!.bounds;
    const obstacle = obstacles.find(item => item.id === 'node:a')!.bounds;
    // The bottom pill protrudes 12 px past the boundary, further than the 11.5 px node clearance.
    expect(bottom(pill) - bottom(box)).toBe(12);
    expect(obstacle).toEqual({ x: box.x - 11.5, y: box.y - 11.5,
      width: box.width + 23, height: box.height + 11.5 + 12 + 1.25 });
    expect(contains(obstacle, { x: pill.x - 1.25, y: pill.y - 1.25, width: pill.width + 2.5, height: pill.height + 2.5 })).toBe(true);
    expect(model.nodes.a!.bounds).toEqual(box);
    // One obstacle per node keeps the set identical for every connector: no link needs a pill
    // exemption, because a connector may always leave the shape its pin belongs to.
    expect(obstacles.filter(item => item.id.startsWith('node:')).every(item => item.consumers.length === 0)).toBe(true);
    expect(obstacles.some(item => item.id.startsWith('pill:'))).toBe(false);
  });

  it('measures an unequal custom node stroke and lengthens the required stem with it', async () => {
    const draft = copy(await placed(twoTier));
    draft.nodes.b!.strokeWidth = 20;
    rebuildBands(draft);
    rebuildNodeGeometry(draft, Object.keys(draft.nodes), 'current');
    draft.canvas = union([draft.canvas!, ...Object.values(draft.groups).map(group => group.bounds!)]);
    const model = bands(bundles(bars(centre(flanks(lanes(rows(restoreLayoutModel(JSON.stringify(draft)))))))));
    expect(nodeClearance(model, 'a')).toBe(11.5);
    expect(nodeClearance(model, 'b')).toBe(20.75);
    const anchor = findPort(model, model.links[0]!.attachments!.to)!;
    expect(stemCheckpoint(model, anchor)).toEqual({ x: anchor.anchor!.x, y: anchor.anchor!.y - 21 });
    const thin = findPort(model, model.links[0]!.attachments!.from)!;
    expect(stemCheckpoint(model, thin)).toEqual({ x: thin.anchor!.x, y: thin.anchor!.y + 15 });
    expect(model.nodes.b!.strokeWidth).toBe(20);
  });

  it('trims 18 px of arc length once per whole chain and keeps interior bends covered', () => {
    const chain: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 90 }];
    const trimmed = trimChain(chain, TERMINAL_TRIM, TERMINAL_TRIM);
    expect(trimmed).toEqual([{ x: 0, y: 18 }, { x: 0, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 72 }]);
    // A terminal segment shorter than the trim consumes the following one; the bend survives.
    const shortTerminal = trimChain([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 60 }], TERMINAL_TRIM, 0);
    expect(shortTerminal).toEqual([{ x: 10, y: 8 }, { x: 10, y: 60 }]);
    // Nothing is protected when the whole chain is inside the two trims.
    expect(trimChain([{ x: 0, y: 0 }, { x: 36, y: 0 }], TERMINAL_TRIM, TERMINAL_TRIM)).toEqual([]);
    expect(trimChain([{ x: 0, y: 0 }, { x: 36.5, y: 0 }], TERMINAL_TRIM, TERMINAL_TRIM)).toEqual([{ x: 18, y: 0 }, { x: 18.5, y: 0 }]);
    // One trimmed end only: the run keeps its far terminal.
    expect(trimChain([{ x: 0, y: 0 }, { x: 40, y: 0 }], 0, TERMINAL_TRIM)).toEqual([{ x: 0, y: 0 }, { x: 22, y: 0 }]);
  });

  it('covers a fixed path with butt caps at its link terminals and square corners between', async () => {
    const model = await throughBands(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], [a.p, b.q]]`);
    const path = model.links[0]!.path!;
    expect(path.fixed).toBe(true);
    expect(path.segments.length).toBeGreaterThan(2);
    const covers = routeObstacles(model).filter(item => item.id.startsWith('link-1:path:'));
    const points: Point[] = [path.segments[0]!.from, ...path.segments.map(segment => segment.to)];
    const trimmed = trimChain(points, TERMINAL_TRIM, TERMINAL_TRIM);
    expect(covers).toHaveLength(trimmed.length - 1);
    for (const [index, cover] of covers.entries()) {
      const a = trimmed[index]!, b = trimmed[index + 1]!;
      // 10 px parallel clearance plus the two half strokes on the perpendicular axis.
      expect(a.x === b.x ? cover.bounds.width : cover.bounds.height).toBeCloseTo(23, 9);
      expect(contains(cover.bounds, { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) })).toBe(true);
      expect(cover.consumers).toEqual(['link-1']);
    }
    // Butt caps: this path runs downward, so neither trimmed terminal is extended and a link
    // sharing that port can still reach it.
    expect(covers[0]!.bounds.y).toBe(trimmed[0]!.y);
    expect(bottom(covers.at(-1)!.bounds)).toBe(trimmed.at(-1)!.y);
    // Square corners: every interior bend is inside both of its covers.
    for (let index = 1; index + 1 < trimmed.length; index++) {
      const bend = trimmed[index]!;
      for (const cover of [covers[index - 1]!, covers[index]!]) {
        expect(bend.x).toBeGreaterThan(cover.bounds.x - 1e-9);
        expect(bend.x).toBeLessThan(right(cover.bounds) + 1e-9);
        expect(bend.y).toBeGreaterThan(cover.bounds.y - 1e-9);
        expect(bend.y).toBeLessThan(bottom(cover.bounds) + 1e-9);
      }
      expect(covers[index - 1]!.bounds).not.toEqual(covers[index]!.bounds);
    }
  });

  it('protects the measured group label for every link while leaving unused band space open', async () => {
    const model = await throughBands(twoTier);
    const band = model.labelBands.find(item => item.group === 'low')!;
    const label = model.labels.find(item => item.role === 'group' && item.owner.kind === 'group' && item.owner.id === 'low')!;
    const obstacle = routeObstacles(model).find(item => item.id === `label:${label.id}`)!;
    // Half the routed stroke plus the title's link-free margin, on every side.
    const by = 0.75 + GROUP_LABEL_LINK_CLEARANCE;
    expect(obstacle.bounds).toEqual({ x: label.bounds!.x - by, y: label.bounds!.y - by,
      width: label.bounds!.width + 2 * by, height: label.bounds!.height + 2 * by });
    expect(routeObstacles(model).some(item => item.id === band.id)).toBe(false);
    expect(obstacle.consumers).toEqual([]);
  });

  it('drops an obstacle that lies wholly inside another and keeps the union identical', async () => {
    const model = await throughBands(twoTierBend);
    const plan = planRoute(model);
    const request = batchRequest(plan, plan.batches[0]!, []);
    for (const shape of request.shapes) {
      expect(request.shapes.filter(other => other !== shape && contains(other.bounds, shape.bounds))).toEqual([]);
    }
    // Every dropped rectangle is still covered by a kept one, so the obstacle region is unchanged.
    const excluded = new Set(plan.links[0]!.exclusions);
    for (const obstacle of plan.obstacles.filter(item => !excluded.has(item.id))) {
      expect(request.shapes.some(shape => contains(shape.bounds, obstacle.bounds))).toBe(true);
    }
    // The pill and its label are inside the node obstacle; the group label remains separate.
    const kept = new Set(request.shapes.map(shape => shape.id));
    expect(kept.has('label:label:group:low')).toBe(true);
    expect(kept.has('label-band:low')).toBe(false);
  });

  it('never drops an attachment shape and reports a container that would swallow one', () => {
    const pinned = { id: 'node:a', bounds: { x: 0, y: 0, width: 10, height: 10 },
      pins: [{ classId: 1, x: 0, y: 5, directions: 4, exclusive: true }] };
    expect(() => disjointShapes([{ id: 'big', bounds: { x: -5, y: -5, width: 30, height: 30 } }, pinned]))
      .toThrow(/contains the attachment shape node:a/);
    expect(disjointShapes([pinned, { id: 'inner', bounds: { x: 1, y: 1, width: 2, height: 2 } }])).toEqual([pinned]);
  });

  it('gives each reserved lane and shared run its exact owners, and batches links by them', async () => {
    // Both sources leave sideways, so neither gap is the straight run stage 8 would claim and both
    // links really reach the router.
    const model = await throughBands(`portograph: 2
groups: {top-group: {tier: 0}, mid: {tier: 1}, low: {tier: 2}}
nodes:
  a: {group: top-group, ports: [{name: p, side: right}]}
  az: {group: top-group}
  m: {group: mid, ports: [{name: q, side: right}]}
  mz: {group: mid}
  b: {group: low, ports: [{name: p, side: top}]}
  c: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [m.q, c.p]]`);
    const plan = planRoute(model);
    expect(plan.remainders).toEqual(['link-1', 'link-2']);
    const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-1')!;
    // A corridor admits its owner's collinear run and nothing else, so it obstructs the owner too.
    // The owner's exemption is that run, which the stitcher keeps exactly.
    expect(routeObstacles(model).find(item => item.id === lane.id)!.consumers).toEqual([]);
    expect(plan.links.find(item => item.link === 'link-1')!.exclusions).not.toContain(lane.id);
    expect(plan.links.find(item => item.link === 'link-1')!.exclusions).toContain('link-1:fixed:0:0');
    expect(plan.links.find(item => item.link === 'link-2')!.exclusions).not.toContain(lane.id);
    // Different exclusion sets cannot share one router, so they become ordered ownership batches.
    expect(plan.batches).toEqual([{ id: 'batch-0', links: ['link-1'] }, { id: 'batch-1', links: ['link-2'] }]);
    for (const batch of plan.batches) {
      expect([batch.id, batchRequest(plan, batch, []).shapes.some(shape => shape.id === lane.id)]).toEqual([batch.id, true]);
    }
    // The lane run is the one reserved piece of the path, not a connector, and the router still
    // answers for the pieces around it.
    const pieces = plan.links.find(item => item.link === 'link-1')!.pieces;
    const reserved = pieces.filter(piece => piece.kind === 'reserved');
    expect(reserved).toHaveLength(1);
    expect((reserved[0] as { segments: unknown }).segments).toEqual(model.links[0]!.fixedSegments);
    expect(pieces.some(piece => piece.kind === 'gap')).toBe(true);
  });

  it('protects the reserved stem of every link a batch has not routed yet', async () => {
    // Every end leaves sideways or arrives sideways, so no gap here is the straight run stage 8
    // claims and each of the four attachments reserves a stem of its own.
    const model = await throughBands(`portograph: 2
groups: {top-group: {tier: 0}, mid: {tier: 1}, low: {tier: 2}}
nodes:
  a: {group: top-group, ports: [{name: p, side: right}]}
  m: {group: mid, ports: [{name: q, side: right}]}
  mz: {group: mid}
  b: {group: low, ports: [{name: p, side: left}]}
  c: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [m.q, c.p]]`);
    const plan = planRoute(model);
    expect(plan.batches).toEqual([{ id: 'batch-0', links: ['link-1'] }, { id: 'batch-1', links: ['link-2'] }]);
    // Each remainder reserves one stem at each of its two ports. `link-1` crosses the middle tier in
    // a lane, and each gap that joins the lane reserves its approach (ticket 18).
    expect(plan.approaches.map(item => [item.link, item.lane])).toEqual([['link-1', 'lane:"link-1":1'], ['link-1', 'lane:"link-1":1']]);
    expect(plan.stems.map(item => [item.link, item.node]))
      .toEqual([['link-1', 'a'], ['link-1', 'b'], ['link-2', 'm'], ['link-2', 'c']]);
    // A stem covers its reserved reach, and one router stem beyond its checkpoint (ticket 18), with
    // the clearance a reserved run carries.
    const port = findPort(model, model.links[1]!.attachments!.to)!;
    const tip = stemCheckpoint(model, port), beyond = GROUP_LABEL_GEOMETRY.routerStem;
    const clearance = GROUP_LABEL_GEOMETRY.nodeClearance + (linkStrokeWidth(model.links[1]!) + routedStroke(model)) / 2;
    expect(plan.stems[3]!.bounds).toEqual({ x: port.anchor!.x - clearance, y: tip.y - beyond - clearance,
      width: 2 * clearance, height: port.anchor!.y - tip.y + beyond + 2 * clearance });
    // The first batch avoids the stems of the link it has not routed; the second has none left.
    const pending = new Set(['link-2']);
    expect(pendingStemObstacles(plan, plan.batches[0]!, pending).map(item => item.id))
      .toEqual(['stem:2:link-2', 'stem:3:link-2']);
    expect(pendingStemObstacles(plan, plan.batches[1]!, new Set<string>())).toEqual([]);
    // The batch uses both ports, so both stems on those ports are left out.
    expect(pendingStemObstacles(plan, { links: ['link-1', 'link-2'] }, pending)).toEqual([]);
  });

  it('protects a future sibling port on a flat side while sharing an owned port', async () => {
    const model = await throughBands(`portograph: 2\ngroups: {ga: {tier: 0}, gb: {tier: 1}}\nnodes:\n  a: {group: ga, ports: [{name: p, side: right}, {name: q, side: right}]}\n  b: {group: gb, ports: [{name: p, side: left}]}\n  c: {group: gb, ports: [{name: p, side: left}]}\nlinks: [[a.p, b.p], [a.q, c.p]]`);
    const plan = planRoute(model);
    const sibling = plan.stems.findIndex(stem => stem.link === 'link-2' && stem.node === 'a');
    expect(sibling).toBeGreaterThanOrEqual(0);
    plan.stems[sibling]!.nested = false;
    const pending = new Set(['link-2']);
    const obstacles = pendingStemObstacles(plan, { links: ['link-1'] }, pending);
    expect(obstacles.map(item => item.id)).toContain(`stem:${sibling}:link-2`);
    expect(pendingStemObstacles(plan, { links: ['link-2'] }, pending).map(item => item.id))
      .not.toContain(`stem:${sibling}:link-2`);
    // Control: when two links actually use one port, its pending stem remains shared.
    plan.stems[sibling]!.port = plan.links.find(item => item.link === 'link-1')!.ports[0]!;
    expect(pendingStemObstacles(plan, { links: ['link-1'] }, pending).map(item => item.id))
      .not.toContain(`stem:${sibling}:link-2`);
  });

  it('protects a future sibling stem even when the batch consumes a shared run', async () => {
    const model = await throughBands(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: left}]}
  c: {group: gb, ports: [{name: p, side: right}]}
  d: {group: gb, ports: [{name: p, side: left}]}
links: [[a.p, b.p], [a.p, c.p], [a.q, d.p]]`);
    const plan = planRoute(model);
    // The two links on `a.p` consume a shared run, so neither reserves a stem at `a`.
    expect(plan.stems.filter(stem => stem.node === 'a').map(stem => stem.link)).toEqual(['link-3']);
    const shared = plan.links.find(item => item.link === 'link-1')!;
    expect(shared.nodes).toEqual(['a', 'b']);
    // The batch uses a.p through the shared run. The future a.q stem remains protected.
    const batch = plan.batches.find(item => item.links.includes('link-1'))!;
    const index = (node: string) => plan.stems.findIndex(stem => stem.link === 'link-3' && stem.node === node);
    expect(pendingStemObstacles(plan, batch, new Set(['link-3'])).map(item => item.id))
      .toEqual([`stem:${index('a')}:link-3`, `stem:${index('d')}:link-3`]);
  });

  it('marks a shared port non-exclusive and counts link ends already fixed by a rule', async () => {
    const model = await throughBands(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
  c: {group: gb, ports: [{name: p, side: right}]}
  cz: {group: gb}
links: [[a.p, b.p], [a.q, b.q], [c.p, a.p]]`);
    const plan = planRoute(model);
    expect(plan.remainders).toEqual(['link-3']);
    const shapes = batchRequest(plan, plan.batches[0]!, []).shapes;
    // link-3 consumes a shared prefix at a.p, so it attaches at c.p only; that pin carries one end.
    // The port leaves sideways, so the gap is not the straight run stage 8 would claim.
    const pins = shapes.flatMap(shape => (shape.pins ?? []).map(pin => ({ shape: shape.id, ...pin })));
    expect(pins).toEqual([{ shape: 'node:c', classId: 1, x: model.nodes.c!.ports[0]!.anchor!.x,
      y: model.nodes.c!.ports[0]!.anchor!.y, directions: 8, exclusive: true }]);
    // `[c.p, a.p]` shares the target port, so the reserved prefix is traversed last.
    expect(plan.links[0]!.pieces.map(piece => piece.kind)).toEqual(['gap', 'reserved']);
  });

  it('starts both remainders of a plain fan at their junction leaves instead of sharing one pin', async () => {
    const model = await throughBands(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  bz: {group: gb}
  b: {group: gb, ports: [{name: p, side: left}]}
  c: {group: gb, ports: [{name: p, side: right}]}
  cz: {group: gb}
links: [[a.p, b.p], [a.p, c.p]]`);
    // Ticket 20: the shared port owns a junction tree, so neither remainder needs a pin on `a`.
    expect(model.junctions).toHaveLength(1);
    const plan = planRoute(model);
    expect(plan.remainders).toEqual(['link-1', 'link-2']);
    const shapes = batchRequest(plan, plan.batches[0]!, []).shapes;
    expect(shapes.find(shape => shape.id === 'node:a')?.pins ?? []).toEqual([]);
    for (const link of model.links) {
      const leaf = link.sharedRuns!.from!.at(-1)!.to;
      expect(plan.links.find(item => item.link === link.id)!.connectors[0]!.from).toEqual({ kind: 'point', x: leaf.x, y: leaf.y });
    }
    // Each link owns its own leaf run as an obstacle, so the two remainders route in separate batches.
    expect(plan.batches.flatMap(batch => batch.links)).toEqual(['link-1', 'link-2']);
    expect(plan.batches.map(batch => batch.links.length)).toEqual([1, 1]);
  });

  it('pins and constrains an attachment on each of the four sides', async () => {
    const model = await throughBands(`portograph: 2
groups: {t0: {tier: 0}, t1: {tier: 1}, t2: {tier: 2}, t3: {tier: 3}, t4: {tier: 4}}
nodes:
  hz: {group: t2}
  hub: {group: t2, ports: [{name: n, side: top}, {name: s, side: bottom}, {name: w, side: left}, {name: e, side: right}]}
  hy: {group: t2}
  a: {group: t0, ports: [{name: p, side: bottom}]}
  b: {group: t4, ports: [{name: p, side: top}]}
  c: {group: t1, ports: [{name: p, side: bottom}]}
  d: {group: t3, ports: [{name: p, side: top}]}
links: [[a.p, hub.n], [hub.s, b.p], [c.p, hub.w], [hub.e, d.p]]`);
    const plan = planRoute(model);
    expect(plan.remainders).toEqual(['link-1', 'link-2', 'link-3', 'link-4']);
    const pins = plan.obstacles.find(item => item.id === 'node:hub')!.pins!;
    const ports = model.nodes.hub!.ports;
    // libavoid direction bits: top 1, bottom 2, left 4, right 8 — the port's own outward side.
    expect(pins.map(pin => [pin.classId, pin.x, pin.y, pin.directions]))
      .toEqual(ports.map((port, index) => [index + 1, port.anchor!.x, port.anchor!.y,
        { top: 1, bottom: 2, left: 4, right: 8 }[port.side!]]));
    // Each hub end holds its outward reach 15 px along its normal: as a checkpoint entered or left
    // head-on where the router answers the gap, and as the claimed run itself where stage 8 found
    // the gap is one straight line and asked for no route at all.
    const outward: Record<string, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
    for (const [index, port] of ports.entries()) {
      const link = model.links.find(item => [item.attachments!.from, item.attachments!.to]
        .some(ref => ref.name === port.ref.name && ref.node === 'hub'))!;
      const source = link.attachments!.from.node === 'hub';
      const [dx, dy] = outward[port.side!]!;
      const tip = { x: port.anchor!.x + 15 * dx, y: port.anchor!.y + 15 * dy };
      const item = plan.links.find(entry => entry.link === link.id)!;
      const own = item.connectors.flatMap(entry => entry.checkpoints)
        .find(point => point.x === tip.x && point.y === tip.y);
      if (own) {
        const inward = { top: 2, bottom: 1, left: 8, right: 4 }[port.side!];
        expect([index, source ? own.arrival : own.departure]).toEqual([index, inward]);
        expect(source ? own.departure : own.arrival).toBe(15);
        continue;
      }
      const runs = item.pieces.flatMap(piece => piece.kind === 'straight' ? piece.segments : []);
      expect([index, runs.some(run => segmentRect(run, { x: tip.x, y: tip.y, width: 0, height: 0 }))]).toEqual([index, true]);
    }
  });

  it('orders checkpoints by distance along the route, not by the segment they fall on', () => {
    const line: Point[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const at = (x: number) => ({ x, y: 0, arrival: 15, departure: 15 });
    expect(checkpointsHonoured(line, [at(20), at(80)])).toBe(true);
    expect(checkpointsHonoured(line, [at(80), at(20)])).toBe(false);
    expect(checkpointsHonoured(line, [{ x: 20, y: 40, arrival: 15, departure: 15 }])).toBe(false);
    // A point the route reaches twice is honoured at the visit that keeps the order: (50,0) comes
    // first at distance 50, which is too early, and again at 250, which is not.
    const twice: Point[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 },
      { x: 20, y: 20 }, { x: 20, y: 0 }, { x: 70, y: 0 }];
    expect(checkpointsHonoured(twice, [at(90), at(50)])).toBe(true);
    // (80,0) is only ever reached at distance 80, so after (90,0) the order cannot be kept.
    expect(checkpointsHonoured(twice, [at(90), at(80)])).toBe(false);
  });

  it('removes exact containment without rounding cell boundaries or obstacle edges', () => {
    const outer = { id: 'outer', bounds: { x: 127.99999999999999, y: 0, width: 200, height: 100 } };
    const inner = { id: 'inner', bounds: { x: 150, y: 10, width: 10, height: 10 } };
    expect(disjointShapes([outer, inner])).toEqual([outer]);
    expect(disjointShapes([inner, outer])).toEqual([outer]);
    const pinned = { ...inner, pins: [{ classId: 1, x: 150, y: 10, directions: 4, exclusive: true }] };
    expect(() => disjointShapes([outer, pinned])).toThrow(/contains the attachment shape inner/);
    // Collision tolerance must not erase a real sliver of the obstacle union.
    const edge = { id: 'edge', bounds: { x: 256, y: 0, width: 64, height: 64 } };
    const slack = { id: 'slack', bounds: { x: 256 - 1e-9, y: 0, width: 32, height: 32 } };
    expect(disjointShapes([edge, slack])).toEqual([edge, slack]);
    const thin = { id: 'thin', bounds: { x: 128, y: 0, width: 1, height: 100 } };
    const fatter = { id: 'fatter', bounds: { x: 127.9999999, y: 0.000001, width: 1.0000002, height: 99.999998 } };
    expect(disjointShapes([thin, fatter])).toEqual([thin, fatter]);
    const partialPin = { ...fatter, pins: [{ classId: 1, x: 128, y: 1, directions: 4, exclusive: true }] };
    expect(disjointShapes([thin, partialPin])).toEqual([thin, partialPin]);
  });

  it('preserves the exact union in every order of the tolerance cycle and chain', () => {
    const box = (id: string, x: number, y: number, r: number, b: number) =>
      ({ id, bounds: { x, y, width: r - x, height: b - y } });
    const cycle = [box('a', 0, 0, 10, 10), box('b', -1.6e-7, 8e-8, 9.99999992, 10), box('c', -8e-8, -8e-8, 9.99999984, 10)];
    const chain = [box('a', 0, 0, 10, 10), box('b', -8e-8, 1, 9.5, 9), box('c', -1.6e-7, 2, 9, 8)];
    for (const shapes of [cycle, chain]) {
      for (const [i, j, k] of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
        const order = [shapes[i!]!, shapes[j!]!, shapes[k!]!];
        expect(disjointShapes(order)).toEqual(order);
      }
    }
  });

  it('matches exact maximal rectangles for nested, duplicate, and scattered inputs', () => {
    const exact = (outer: Rect, inner: Rect): boolean => outer.x <= inner.x && outer.y <= inner.y
      && right(outer) >= right(inner) && bottom(outer) >= bottom(inner);
    let seed = 1777;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let trial = 0; trial < 40; trial++) {
      const shapes = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, bounds: {
        x: Math.floor(random() * 20) - 10, y: Math.floor(random() * 20) - 10,
        width: 1 + Math.floor(random() * 30), height: 1 + Math.floor(random() * 30),
      } }));
      shapes.push({ id: 'duplicate', bounds: { ...shapes[0]!.bounds } });
      const before = copy(shapes);
      const expected = shapes.filter((shape, i) => !shapes.some((other, j) => i !== j
        && exact(other.bounds, shape.bounds) && (!exact(shape.bounds, other.bounds) || j < i)));
      expect(disjointShapes(shapes)).toEqual(expected);
      expect(shapes).toEqual(before);
    }
  });

  it('compares only runs whose lines are within the tolerance, however they chain', () => {
    const owner = { kind: 'link' as const, id: 'x' };
    const run = (y: number, from: number, to: number) => ({ from: { x: from, y }, to: { x: to, y }, owner });
    // 0, 8e-8 and 1.6e-7 are each within EPS of the next, but the outer two are 1.6e-7 apart and
    // are not the same line: only their intervals overlap, which is not a retrace.
    expect(() => retraces('x', [run(0, 0, 100), run(8e-8, 200, 300), run(1.6e-7, 50, 150)])).not.toThrow();
    // Two lines that really are within the tolerance, with overlapping intervals, are one line.
    expect(() => retraces('x', [run(0, 0, 100), run(8e-8, 50, 150)])).toThrow(/retraces itself/);
    // Runs that only meet at a bend are how every ordinary path is built.
    expect(() => retraces('x', [run(0, 0, 100), run(0, 100, 200)])).not.toThrow();
    expect(() => retraces('x', [run(0, 0, 100), run(0, 99, 200)])).toThrow(/retraces itself/);
  });

  it('collapses repeated and collinear router vertices without inventing a turn', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }, { x: 10, y: 20 }]))
      .toEqual([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }]);
    expect(simplify([{ x: 5, y: 5 }])).toEqual([{ x: 5, y: 5 }]);
  });
});
