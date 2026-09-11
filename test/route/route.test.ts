import { describe, expect, it } from 'vitest';
import { bands, bars, bundles, centre, flanks, lanes, restoreLayoutModel, route, routeRemainders, rows, score } from '../../src/index.js';
import type { GateId, LayoutModel, PathSegment, Point, Rect } from '../../src/index.js';
import type { RouteBatch, RoutedConnector } from '../../src/route/types.js';
import { completedRouteObstacles } from '../../src/route/obstacles.js';
import { planRoute } from '../../src/route/plan.js';
import { stubCandidate } from '../../src/route/paths.js';
import { reservationConflicts } from '../../src/route/validate.js';
import { RouteDeadlineError, type CreateRouteAttempt, type RouteWorker } from '../../src/route/worker.js';
import { segmentDistance } from '../../src/score/geometry.js';
import { placed } from '../layout/phase-two-fixture.js';
import { avoidAssets, createAvoidAttempt, spawnAvoidWorker } from './fixture.js';

const GATES: GateId[] = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'];
const length = (segment: PathSegment): number => Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
const throughBands = async (yaml: string): Promise<LayoutModel> => bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
const routed = (yaml: string, options = {}): Promise<LayoutModel> =>
  throughBands(yaml).then(model => route(model, { createAttempt: createAvoidAttempt, ...options }));
function expectAllGates(model: LayoutModel): void {
  const report = score(model, { golden: true }).snapshot;
  for (const id of GATES) expect([id, report.gates[id].violations]).toEqual([id, []]);
  expect(report.passed).toBe(true);
  expect(report.metrics.crossings.count).toBe(0);
  expect(report.counters.overlaps).toBe(0);
}
function expectStems(model: LayoutModel, ids: string[]): void {
  for (const id of ids) {
    const segments = model.links.find(link => link.id === id)!.path!.segments;
    expect([id, length(segments[0]!) >= 15, length(segments.at(-1)!) >= 15]).toEqual([id, true, true]);
  }
}

/** Tier 0 to tier 2 through a reserved lane, beside a fixed two-member bundle. */
const irregular = `portograph: 2
groups: {top-group: {tier: 0}, mid: {tier: 1}, low: {tier: 2}}
nodes:
  a: {group: top-group, ports: [{name: p, side: bottom}]}
  m: {group: mid, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  b: {group: low, ports: [{name: p, side: top}]}
  c: {group: low, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], [m.p, c.p], [m.q, c.q]]`;

describe('stage 8 routing', () => {
  it('routes the three-tier irregular cross-link through libavoid and passes every gate', async () => {
    const before = await throughBands(irregular);
    expect(routeRemainders(before)).toEqual(['link-1']);
    const fixed = before.links.filter(link => link.path).map(link => link.path!.segments);
    expect(fixed).toHaveLength(2);
    const model = await route(before, { createAttempt: createAvoidAttempt });

    const path = model.links[0]!.path!;
    expect(path.fixed).toBe(false);
    expect(path.segments.length).toBeGreaterThan(1);
    expectAllGates(model);
    expectStems(model, ['link-1']);
    // The reserved transit lane is stitched in unchanged, with its owner and lane annotation.
    for (const run of before.links[0]!.fixedSegments!) expect(path.segments).toContainEqual(run);
    // A lane admits only its owner's collinear run, so the head-on approach and exit name it too.
    const lane = before.lanes[0]!;
    const occupying = path.segments.filter(segment => segment.lane !== undefined);
    expect(occupying.length).toBeGreaterThanOrEqual(2);
    for (const segment of occupying) {
      expect([segment.lane, segment.from.x, segment.to.x]).toEqual([lane.id, lane.x, lane.x]);
    }
    // Nothing routed here may come nearer a fixed path than the 10 px parallel clearance.
    for (const segments of fixed) for (const other of segments) {
      for (const segment of path.segments) expect(segmentDistance(segment, other)).toBeGreaterThanOrEqual(11.5 - 1e-9);
    }
    expect(reservationConflicts(model)).toEqual([]);
    expect(model.links.slice(1).map(link => link.path)).toEqual(before.links.slice(1).map(link => link.path));
    expect(model.freeze!.placement).toEqual(before.freeze!.placement);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it.each([false, true])('consumes a declared shared run at a top and bottom port, reversed %s', async reversed => {
    const before = await throughBands(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
  c: {group: gb, ports: [{name: p, side: top}]}
links: [${reversed ? '[b.p, a.p]' : '[a.p, b.p]'}, [a.q, b.q], ${reversed ? '[a.p, c.p]' : '[c.p, a.p]'}]`);
    expect(routeRemainders(before)).toEqual(['link-3']);
    const remainder = before.links[2]!;
    const end = reversed ? 'from' : 'to';
    const runs = remainder.sharedRuns![end]!;
    expect(runs.length).toBeGreaterThan(0);
    // Mixed incidence at one port: the bundle member and the remainder meet a.p from opposite ends.
    const junction = before.junctions[0]!;
    expect(junction.links).toEqual(['link-1', 'link-3']);
    const ends = before.links.filter(link => junction.links.includes(link.id))
      .map(link => link.attachments!.from.node === 'a' && link.attachments!.from.name === 'p' ? 'from' : 'to');
    expect(new Set(ends).size).toBe(2);
    const model = await route(before, { createAttempt: createAvoidAttempt });

    const segments = model.links[2]!.path!.segments;
    // An outward target prefix is traversed backwards at the end of the source-to-target path.
    const expected = reversed ? runs : [...runs].reverse().map(run => ({ ...run, from: run.to, to: run.from }));
    expect(reversed ? segments.slice(0, runs.length) : segments.slice(segments.length - runs.length)).toEqual(expected);
    expect(model.junctions).toEqual(before.junctions);
    expectAllGates(model);
    expectStems(model, ['link-1', 'link-2', 'link-3']);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('routes between a right and a left port that no rule claimed', async () => {
    // Two groups of one tier: the rows rule declines the pin because the anchors are not aligned,
    // and the reserved gap between the groups leaves room for both 15 px stems.
    const before = await throughBands(`portograph: 2
groups: {g1: {tier: 0}, g2: {tier: 0}}
nodes:
  a: {group: g1, class: router, description: a taller node, ports: [{name: p, side: right}]}
  b: {group: g2, ports: [{name: p, side: left}]}
links: [[a.p, b.p]]`);
    expect(routeRemainders(before)).toEqual(['link-1']);
    expect([before.nodes.a!.ports[0]!.side, before.nodes.b!.ports[0]!.side]).toEqual(['right', 'left']);
    expect(before.nodes.a!.ports[0]!.anchor!.y).not.toBe(before.nodes.b!.ports[0]!.anchor!.y);
    const model = await route(before, { createAttempt: createAvoidAttempt });
    const segments = model.links[0]!.path!.segments;
    // Both stems leave their side horizontally; G5 and the route validator check the direction.
    expect(Math.abs(segments[0]!.to.x - segments[0]!.from.x)).toBeGreaterThanOrEqual(15);
    expect(Math.abs(segments.at(-1)!.from.x - segments.at(-1)!.to.x)).toBeGreaterThanOrEqual(15);
    expect(segments[0]!.from.y).toBe(segments[0]!.to.y);
    expectAllGates(model);
    expectStems(model, ['link-1']);
    expect(reservationConflicts(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('accepts two connectors on one shared pin and reports the unreserved overlap as a gate failure', async () => {
    const before = await throughBands(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}]}
  c: {group: gb, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [a.p, c.p]]`);
    expect(before.junctions).toEqual([]);
    expect(routeRemainders(before)).toEqual(['link-1', 'link-2']);
    const model = await route(before, { createAttempt: createAvoidAttempt });
    // The non-exclusive pin accepts both connectors, and both reach their anchors with real stems.
    for (const link of model.links) {
      expect(link.path!.segments[0]!.from).toEqual(before.nodes.a!.ports[0]!.anchor);
    }
    expectStems(model, ['link-1', 'link-2']);
    // Stage 11 declares no junction here, so the common stem is an ordinary overlap: only a
    // declared shared run is exempt, and G4 says so instead of stage 8 inventing a junction.
    const report = score(model).snapshot;
    expect(report.gates.G4.passed).toBe(false);
    expect(report.gates.G4.violations[0]!.code).toBe('collinear-overlap');
    expect(model.junctions).toEqual([]);
  });

  it('draws an overlay link straight and never initializes the router', async () => {
    const before = await throughBands(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}]}
links: [[a.p, b.p, {route: overlay}]]`);
    expect(routeRemainders(before)).toEqual([]);
    const refuse: CreateRouteAttempt = () => { throw new Error('The router must not start without a routed remainder'); };
    const model = await route(before, { createAttempt: refuse });
    const path = model.links[0]!.path!;
    expect(path).toEqual({ owner: { kind: 'link', id: 'link-1' }, layer: 'overlay', fixed: false,
      segments: [{ from: before.nodes.a!.ports[0]!.anchor, to: before.nodes.b!.ports[0]!.anchor,
        owner: { kind: 'link', id: 'link-1' } }] });
    expect(model.links[0]!.technique).toBe('overlay');
    expect(model.links[0]!.stubCandidate).toBeUndefined();
    expect(score(model).snapshot.gates.G7.passed).toBe(true);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('marks a stub candidate that crosses more than two tiers and keeps its routed path', async () => {
    const before = await throughBands(`portograph: 2
groups: {t0: {tier: 0}, t1: {tier: 1}, t2: {tier: 2}, t3: {tier: 3}, t4: {tier: 4}}
nodes:
  a: {group: t0, ports: [{name: p, side: bottom}]}
  m1: {group: t1}
  m2: {group: t2}
  m3: {group: t3}
  b: {group: t4, ports: [{name: p, side: top}]}
links: [[a.p, b.p]]`);
    expect(before.lanes).toHaveLength(3);
    const model = await route(before, { createAttempt: createAvoidAttempt });
    const link = model.links[0]!;
    expect(link.stubCandidate).toBe(true);
    // M1 marks and warns; the technique and the full path stay exactly as routed.
    expect(link.technique).toEqual(before.links[0]!.technique);
    expect(link.technique).not.toBe('stub');
    expect(link.path!.segments.length).toBeGreaterThan(3);
    for (const run of before.links[0]!.fixedSegments!) expect(link.path!.segments).toContainEqual(run);
    expect(model.diagnostics.filter(item => item.code === 'ROUTE_STUB_CANDIDATE'))
      .toEqual([{ stage: 'final-geometry', severity: 'warning', code: 'ROUTE_STUB_CANDIDATE',
        message: expect.stringContaining('link-1') as unknown as string, owners: [{ kind: 'link', id: 'link-1' }] }]);
    expectStems(model, ['link-1']);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('marks a detour longer than three times the direct distance, at the exact boundary', async () => {
    const model = await routed(irregular);
    const link = JSON.parse(JSON.stringify(model.links[0]!)) as LayoutModel['links'][number];
    const measure = { ...model, links: [link] } as LayoutModel;
    expect(stubCandidate(measure, link)).toBe(false);
    const anchors = [link.path!.segments[0]!.from, link.path!.segments.at(-1)!.to];
    const direct = Math.hypot(anchors[1]!.x - anchors[0]!.x, anchors[1]!.y - anchors[0]!.y);
    const arc = link.path!.segments.reduce((sum, segment) => sum + length(segment), 0);
    // Out and back by half the shortfall each, so the arc length is exactly three times direct.
    const extra = (3 * direct - arc) / 2, turn = { x: anchors[0]!.x, y: anchors[0]!.y + extra };
    link.path!.segments.unshift({ from: { ...anchors[0]! }, to: { ...turn }, owner: { ...link.owner } },
      { from: { ...turn }, to: { ...anchors[0]! }, owner: { ...link.owner } });
    // Exactly three times the direct distance is not a detour; one pixel more is.
    expect(stubCandidate(measure, link)).toBe(false);
    link.path!.segments[0]!.to.y += 1;
    link.path!.segments[1]!.from.y += 1;
    expect(stubCandidate(measure, link)).toBe(true);
  });

  it('protects a completed ownership batch from the next one', async () => {
    const before = await throughBands(`portograph: 2
groups: {top-group: {tier: 0}, mid: {tier: 1}, low: {tier: 2}, low2: {tier: 2}}
nodes:
  a: {group: top-group, ports: [{name: p, side: bottom}]}
  m: {group: mid, ports: [{name: p, side: bottom}, {name: q, side: bottom}, {name: r, side: bottom}]}
  b: {group: low, ports: [{name: p, side: top}]}
  c: {group: low, ports: [{name: p, side: top}, {name: q, side: top}]}
  b2: {group: low2, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [m.p, c.p], [m.q, c.q], [m.r, b2.p]]`);
    const plan = planRoute(before);
    // link-1 owns a transit lane and link-4 does not, so they cannot share one obstacle set.
    expect(plan.batches.map(batch => batch.links)).toEqual([['link-1'], ['link-4']]);
    const exchange: { sent: RouteBatch[]; received: RoutedConnector[] } = { sent: [], received: [] };
    const model = await route(before, { createAttempt: recordingAttempt(exchange) });
    expect(exchange.sent.map(batch => batch.id)).toEqual(['batch-0', 'batch-1']);

    // The second batch receives the first batch's routes as trimmed protective obstacles. These
    // two links do not compete for space in this layout, so the assertion is on what batch-1 was
    // given: without the hand-off its request would carry no `routed:` shape at all.
    const first = model.links[0]!;
    const expected = exchange.received.filter(item => item.connector.startsWith('link-1#'))
      .flatMap(item => completedRouteObstacles(before, first, item.connector, item.points));
    expect(expected.length).toBeGreaterThan(1);
    const covers = exchange.sent[1]!.shapes.filter(shape => shape.id.startsWith('routed:'));
    expect(covers).toEqual(expected.map(item => ({ id: item.id, bounds: item.bounds })));
    expect(exchange.sent[0]!.shapes.some(shape => shape.id.startsWith('routed:'))).toBe(false);
    // The covers protect the route's interior and leave its two terminals reachable.
    const holds = (box: Rect, point: Point): boolean => point.x >= box.x && point.x <= box.x + box.width
      && point.y >= box.y && point.y <= box.y + box.height;
    const routedPoints = exchange.received.filter(item => item.connector.startsWith('link-1#')).flatMap(item => item.points);
    const middles = routedPoints.slice(1).map((point, index) => ({ x: (routedPoints[index]!.x + point.x) / 2, y: (routedPoints[index]!.y + point.y) / 2 }));
    expect(middles.filter(point => covers.some(cover => holds(cover.bounds, point))).length).toBeGreaterThan(1);
    for (const anchor of [first.path!.segments[0]!.from, first.path!.segments.at(-1)!.to]) {
      expect(covers.some(cover => holds(cover.bounds, anchor))).toBe(false);
    }

    const second = model.links[3]!.path!.segments;
    for (const a of first.path!.segments) for (const b of second) expect(segmentDistance(a, b)).toBeGreaterThanOrEqual(11.5 - 1e-9);
    expect(reservationConflicts(model)).toEqual([]);
    expectStems(model, ['link-1', 'link-4']);
    expectAllGates(model);
  });

  it('routes repeatedly without changing the input model or its frozen placement', async () => {
    const before = await throughBands(irregular);
    const snapshot = JSON.stringify(before);
    const first = await route(before, { createAttempt: createAvoidAttempt });
    const second = await route(before, { createAttempt: createAvoidAttempt });
    expect(JSON.stringify(before)).toBe(snapshot);
    // Only the measured stage duration may differ between two runs of the same input.
    const geometry = (model: LayoutModel): string => JSON.stringify({ ...model, runtime: null });
    expect(geometry(second)).toBe(geometry(first));
    expect(first.freeze!.placement).toEqual(before.freeze!.placement);
    expect(() => (first.links[0]!.path!.segments as PathSegment[]).push({ from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, owner: first.links[0]!.owner })).toThrow();
  });

  it('rejects router output that misses a checkpoint or stops short, and keeps the input model', async () => {
    const before = await throughBands(irregular);
    const snapshot = JSON.stringify(before);
    const truncate = (points: Point[]): Point[] => points.slice(0, -1);
    await expect(route(before, { createAttempt: forgingAttempt(truncate) })).rejects.toThrow(/does not meet its reserved endpoints|checkpoint/);
    expect(JSON.stringify(before)).toBe(snapshot);
    // A detour that misses the required outward checkpoint is rejected before anything is published.
    const skipCheckpoint = (points: Point[]): Point[] => {
      const first = points[0]!, last = points.at(-1)!;
      return [first, { x: first.x + 40, y: first.y }, { x: first.x + 40, y: last.y }, last];
    };
    await expect(route(before, { createAttempt: forgingAttempt(skipCheckpoint) })).rejects.toThrow(/skipped a required checkpoint/);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('rejects a published route through its own endpoint group label', async () => {
    const model = await routed(`portograph: 2
groups: {up: {tier: 0}, low: {tier: 1}}
nodes: {a: {group: up}, b: {group: low}}
links: [[a, b]]`);
    const forged = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const label = model.labels.find(item => item.role === 'group' && item.owner.kind === 'group' && item.owner.id === 'low')!;
    const link = forged.links[0]!, segments = link.path!.segments;
    const from = segments[0]!.from, to = segments.at(-1)!.to;
    const x = label.bounds!.x + label.bounds!.width / 3;
    const y = label.bounds!.y + label.bounds!.height / 2;
    const points = [from, { x: from.x, y }, { x, y }, { x, y: to.y - 15 },
      { x: to.x, y: to.y - 15 }, to];
    link.path!.segments = points.slice(1).map((point, i) => ({ from: points[i]!, to: point, owner: { ...link.owner } }));
    expect(reservationConflicts(forged).map(item => item.reservation)).toContain(label.id);
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/enters reserved/);
    link.stubCandidate = true;
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/enters reserved/);
  });

  it('rejects forged route geometry that no producer could have emitted', async () => {
    const model = await routed(irregular);
    const forge = (edit: (model: LayoutModel) => void): (() => LayoutModel) => {
      const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
      edit(copy);
      return () => restoreLayoutModel(JSON.stringify(copy));
    };
    // `fixed` would otherwise skip the whole stage-8 contract, reservation avoidance included —
    // and a restored value that merely looks true must not be enough either.
    expect(forge(copy => { copy.links[0]!.path!.fixed = true; })).toThrow(/claims a region rule fixed it/);
    for (const value of ['true', 1, {}]) {
      expect(forge(copy => { copy.links[0]!.path!.fixed = value as unknown as boolean; })).toThrow(/no boolean fixed flag/);
    }
    // A reserved run drawn twice, reached by retracing the corridor: Codex's exact repro.
    expect(forge(copy => {
      const segments = copy.links[0]!.path!.segments;
      const reserved = JSON.stringify(copy.links[0]!.fixedSegments![0]);
      const at = segments.findIndex(segment => JSON.stringify(segment) === reserved);
      const run = segments[at]!, middle = { x: run.from.x, y: (run.from.y + run.to.y) / 2 };
      segments.splice(at + 1, 0, { ...run, from: { ...run.to }, to: middle },
        { ...run, from: middle, to: { ...run.from } }, JSON.parse(JSON.stringify(run)) as PathSegment);
    })).toThrow(/repeats a reserved run/);
    // A gap that walks back along geometry it already drew is not a path, exact reversal or not.
    expect(forge(copy => {
      const segments = copy.links[0]!.path!.segments, last = segments.at(-1)!;
      const middle = { x: (last.from.x + last.to.x) / 2, y: (last.from.y + last.to.y) / 2 };
      segments.splice(segments.length - 1, 0, { ...last, to: middle }, { ...last, from: middle, to: { ...last.from } });
    })).toThrow(/retraces itself/);
    for (const drift of [0, 4e-8]) {
      expect(forge(copy => {
        // Overshoot the turn, come part of the way back, then finish: no pair is an exact reversal,
        // and `drift` puts the return leg a fraction off the line it retraces.
        const segments = copy.links[0]!.path!.segments;
        const at = 0; // The first gap is now straight and may already carry its approach lane tag.
        const gap = segments[at]!, vertical = gap.from.x === gap.to.x;
        const along = vertical ? 'y' : 'x', across = vertical ? 'x' : 'y';
        const step = Math.sign(gap.to[along] - gap.from[along]) * 10;
        const over = { ...gap.to, [along]: gap.to[along] + step, [across]: gap.to[across] + drift };
        const back = { ...gap.from, [along]: gap.from[along] + step / 2, [across]: gap.to[across] + 2 * drift };
        segments.splice(at, 1, { ...gap, to: over }, { ...gap, from: over, to: back }, { ...gap, from: back });
      })).toThrow(/retraces itself/);
    }

    const overlay = await routed(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}]}
links: [[a.p, b.p, {route: overlay}]]`);
    const broken = JSON.parse(JSON.stringify(overlay)) as LayoutModel;
    const path = broken.links[0]!.path!;
    path.segments = [{ ...path.segments[0]!, to: { x: 999, y: 999 } },
      { ...path.segments[0]!, from: { x: -999, y: -999 } }];
    expect(() => restoreLayoutModel(JSON.stringify(broken))).toThrow(/single straight segment/);
  });

  it('terminates a real worker that never replies when the budget expires', async () => {
    const before = await throughBands(irregular);
    let terminated = 0;
    const stall: CreateRouteAttempt = () => {
      const worker = spawnAvoidWorker('data:text/javascript,while(true){}');
      const stop = worker.terminate.bind(worker);
      worker.terminate = (): void => { terminated++; stop(); };
      return { worker, assets: avoidAssets };
    };
    const started = Date.now();
    await expect(route(before, { createAttempt: stall, routeBudgetMs: 150 })).rejects.toBeInstanceOf(RouteDeadlineError);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(terminated).toBeGreaterThanOrEqual(1);
  });

  it('reports a missing WASM asset instead of waiting for the deadline', async () => {
    const before = await throughBands(irregular);
    const missing: CreateRouteAttempt = () => ({ worker: spawnAvoidWorker(avoidAssets.workerUrl),
      assets: { ...avoidAssets, wasmUrl: `${avoidAssets.wasmUrl}.missing` } });
    await expect(route(before, { createAttempt: missing, routeBudgetMs: 20000 })).rejects.not.toBeInstanceOf(RouteDeadlineError);
  });

  it('refuses to route a remainder without a worker factory and rejects an invalid budget', async () => {
    const before = await throughBands(irregular);
    await expect(route(before)).rejects.toThrow(/requires a libavoid worker factory/);
    await expect(route(before, { createAttempt: createAvoidAttempt, routeBudgetMs: 0 })).rejects.toThrow(/budget must be positive/);
  });
});

/** A real worker whose requests and answers are recorded, to inspect what each batch was given. */
function recordingAttempt(exchange: { sent: RouteBatch[]; received: RoutedConnector[] }): CreateRouteAttempt {
  return () => {
    const created = createAvoidAttempt();
    const post = created.worker.postMessage.bind(created.worker);
    created.worker.postMessage = (message: unknown): void => {
      exchange.sent.push((message as { batch: RouteBatch }).batch);
      post(message);
    };
    const add = created.worker.addEventListener.bind(created.worker);
    created.worker.addEventListener = (type, listener): void => {
      if (type !== 'message') return add(type, listener);
      add(type, event => {
        const data = event.data as { routes?: RoutedConnector[] } | undefined;
        if (data?.routes) exchange.received.push(...data.routes);
        listener(event);
      });
    };
    return created;
  };
}

/** A real worker whose answers are rewritten, to exercise the adapter's rejection paths. */
function forgingAttempt(edit: (points: Point[]) => Point[]): CreateRouteAttempt {
  return () => {
    const worker = spawnAvoidWorker(avoidAssets.workerUrl);
    const listeners = new Set<(event: { data?: unknown }) => void>();
    const wrapped: RouteWorker = {
      postMessage: message => worker.postMessage(message),
      terminate: () => worker.terminate(),
      addEventListener: (type, listener) => {
        if (type !== 'message') return worker.addEventListener(type, listener);
        const relay = (event: { data?: unknown }): void => {
          const data = event.data as { routes?: { connector: string; points: Point[] }[] } | undefined;
          listener({ ...event, data: data?.routes ? { ...data, routes: data.routes.map(item => ({ ...item, points: edit(item.points) })) } : data });
        };
        listeners.add(relay);
        worker.addEventListener(type, relay);
      },
      removeEventListener: (type, listener) => {
        if (type !== 'message') return worker.removeEventListener(type, listener);
        for (const relay of listeners) worker.removeEventListener(type, relay);
        listeners.clear();
      },
    };
    return { worker: wrapped, assets: avoidAssets };
  };
}
