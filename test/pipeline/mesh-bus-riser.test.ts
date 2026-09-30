import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bars, bundles, centre, flanks, lanes, layout, parse, rows, score } from '../../src/index.js';
import { placed as placedModel } from '../layout/phase-two-fixture.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { laneSidesHold, optionalMoveHolds, riserKeepOutBreaches, riserNoDeeper, riserPenetrations } from '../../src/layout/lanes.js';
import { routedStrokeWidth } from '../../src/theme/geometry.js';
import { BUS_RUN_CLEARANCE } from '../../src/layout/bus-room.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const riserLanes = (model: LayoutModel) => model.lanes.filter(lane => lane.owner.kind === 'mesh-bus');
const EXPECTED_CROSSINGS = 2;
const JOINED_NAMES = ['a-mesh-over-two-rows-joins-its-bars-with-one-riser', 'a-riser-joins-two-bars-in-one-gap', 'a-riser-between-cantons-crosses-no-canton-edge'];
const bottom = (box: { y: number; height: number }) => box.y + box.height;

describe('the riser in placement (ticket 96)', () => {
  it('reserves one riser lane in the sub-tier between the rows, outside every body, and both bars reach the riser', async () => {
    const model = await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser'));
    const [upper, lower] = model.meshBuses!;
    expect(upper!.riser!.lanes).toEqual(['riser:mesh-bus-1:2']);
    const lanes = riserLanes(model);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ id: 'riser:mesh-bus-1:2', layer: 'overlay', tier: 2, x: upper!.riser!.x, owner: { kind: 'mesh-bus', id: 'mesh-bus-1' } });
    // The lane keeps out of every body of its sub-tier.
    for (const node of Object.values(model.nodes)) {
      const box = node.bounds!;
      if (box.y >= lanes[0]!.bounds.y + lanes[0]!.bounds.height || bottom(box) <= lanes[0]!.bounds.y) continue;
      expect(box.x + box.width <= lanes[0]!.bounds.x + 1e-6 || box.x >= lanes[0]!.bounds.x + lanes[0]!.bounds.width - 1e-6).toBe(true);
    }
    for (const bus of [upper!, lower!]) {
      expect(Math.min(bus.bar!.from.x, bus.bar!.to.x)).toBeLessThanOrEqual(upper!.riser!.x + 1e-6);
      expect(Math.max(bus.bar!.from.x, bus.bar!.to.x)).toBeGreaterThanOrEqual(upper!.riser!.x - 1e-6);
    }
    expect(upper!.riser!.from).toEqual({ x: upper!.riser!.x, y: upper!.bar!.from.y });
    expect(upper!.riser!.to).toEqual({ x: upper!.riser!.x, y: lower!.bar!.from.y });
    expect(upper!.side).toBe('bottom');
    expect(lower!.side).toBe('top');
    expect(model.diagnostics.filter(d => d.code === 'MESH_BUS_RISER')).toHaveLength(1);
    expect(gates(model)).toEqual([]);
  });

  it('keeps the riser clear of every routed port on the facing edges (the keep-out)', async () => {
    const model = await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser'));
    const upper = model.meshBuses![0]!, lower = model.meshBuses![1]!, x = upper.riser!.x;
    const used = new Set(model.links.filter(link => link.layer === 'routed' && link.technique !== 'stub' && link.attachments)
      .flatMap(link => [link.attachments!.from, link.attachments!.to]).map(ref => `${ref.node}:${ref.ordinal}`));
    for (const [bus, side] of [[upper, 'bottom'], [lower, 'top']] as const) {
      for (const node of Object.values(model.nodes).filter(item => model.groups[model.document.nodes[item.id]!.group]!.tier === bus.row)) {
        for (const port of node.ports) if (port.side === side && used.has(`${node.id}:${port.ref.ordinal}`)) {
          expect(Math.abs(port.anchor!.x - x)).toBeGreaterThanOrEqual(BUS_RUN_CLEARANCE + routedStrokeWidth(model) / 2 - 1e-6);
        }
      }
    }
  });

  it('keeps the riser as far as the keep-out from every stub of both facing edges', async () => {
    for (const name of JOINED_NAMES) {
      const model = await run(fixture(name));
      const upper = model.meshBuses!.find(bus => bus.cross !== undefined)!, keep = BUS_RUN_CLEARANCE + routedStrokeWidth(model) / 2 - 1e-6;
      for (const bus of model.meshBuses!) for (const stub of bus.stubs!) {
        expect(Math.abs(stub.from.x - upper.riser!.x), `${name}: stub of ${stub.node}`).toBeGreaterThanOrEqual(keep);
      }
    }
  });

  it('puts the one label on the bar with more members, and none on the other bar', async () => {
    const model = await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser'));
    const [upper, lower] = model.meshBuses!;
    expect(upper!.label).toBeUndefined();
    expect(upper!.labelRoom).toBeUndefined();
    expect(lower!.label).toBe('label:bus:mesh-bus-2');
    const label = model.labels.find(item => item.id === 'label:bus:mesh-bus-2')!;
    expect(label.text).toBe('sync mesh (8 nodes)');
    expect(model.labels.filter(item => item.role === 'mesh-bus')).toHaveLength(1);
    // The riser stands outside the label room.
    const room = lower!.labelRoom!;
    expect(upper!.riser!.x <= room.from || upper!.riser!.x >= room.to).toBe(true);
  });

  it('reserves no lane between adjacent rows, holds both bands in the one gap and still fixes the riser x', async () => {
    const model = await run(fixture('a-riser-joins-two-bars-in-one-gap'));
    const [upper, lower] = model.meshBuses!;
    expect(upper!.riser!.lanes).toEqual([]);
    expect(riserLanes(model)).toHaveLength(0);
    expect(Number.isFinite(upper!.riser!.x)).toBe(true);
    expect(upper!.bar!.from.y).toBeLessThan(lower!.bar!.from.y);
    // The lower bus stands in one group, so its band is inside the group box; the gap holds the frame margins and the upper band.
    const upperBand = model.busBands!.find(band => band.bus === upper!.id)!;
    const gap = model.tierBands.find(band => band.tier === 2)!.bounds!.y - bottom(model.tierBands.find(band => band.tier === 1)!.bounds!);
    expect(gap).toBeGreaterThanOrEqual(20 + upperBand.bounds.height - 1e-6);
    expect(gates(model)).toEqual([]);
  });

  it('adds the two bands of facing across-frames bars in one gap: 20 + upper band + lower band + 20', async () => {
    const yaml = fixture('a-riser-joins-two-bars-in-one-gap').replace('  low: { tier: 2, label: Low }\n', ['b1', 'b2', 'b3', 'b4'].map(id => `  ${id}g: { tier: 2 }\n`).join(''))
      .replace(/group: low/g, 'group: LOWG');
    const model = await run(yaml.replace(/ {2}(b\d): \{ group: LOWG/g, '  $1: { group: $1g'));
    const [upper, lower] = model.meshBuses!;
    expect(upper!.riser!.lanes).toEqual([]);
    const upperBand = model.busBands!.find(band => band.bus === upper!.id)!, lowerBand = model.busBands!.find(band => band.bus === lower!.id)!;
    const gap = model.tierBands.find(band => band.tier === 2)!.bounds!.y - bottom(model.tierBands.find(band => band.tier === 1)!.bounds!);
    expect(gap).toBeGreaterThanOrEqual(20 + upperBand.bounds.height + lowerBand.bounds.height + 20 - 1e-6);
    expect(upperBand.bounds.y + upperBand.bounds.height).toBeLessThanOrEqual(lowerBand.bounds.y + 1e-6);
  });

  it('joins two cantons with one riser, finds no gate finding and restores as a fixed point', async () => {
    const model = await run(fixture('a-riser-between-cantons-crosses-no-canton-edge'));
    expect(model.meshBuses).toHaveLength(2);
    const upper = model.meshBuses![0]!;
    expect(upper.cross).toHaveLength(16);
    expect(upper.riser!.lanes).toHaveLength(1);
    expect(gates(model)).toEqual([]);
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(JSON.stringify(restored)).toBe(JSON.stringify(model));
  });

  it('restores the three fixtures as fixed points', async () => {
    for (const name of ['a-mesh-over-two-rows-joins-its-bars-with-one-riser', 'a-riser-joins-two-bars-in-one-gap', 'a-riser-between-cantons-crosses-no-canton-edge']) {
      const model = await run(fixture(name));
      expect(JSON.stringify(restoreLayoutModel(JSON.stringify(model)))).toBe(JSON.stringify(model));
    }
  });

  it('refuses a restored riser moved off its x', async () => {
    const model = JSON.parse(JSON.stringify(await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser')))) as LayoutModel;
    model.meshBuses![0]!.riser!.x += 5;
    expect(() => restoreLayoutModel(JSON.stringify(model))).toThrow();
  });

  it('crosses no body and no frame edge beyond the ones it counts, on all three fixtures', async () => {
    for (const name of ['a-mesh-over-two-rows-joins-its-bars-with-one-riser', 'a-riser-joins-two-bars-in-one-gap', 'a-riser-between-cantons-crosses-no-canton-edge']) {
      const model = await run(fixture(name));
      const upper = model.meshBuses!.find(bus => bus.cross !== undefined)!, riser = upper.riser!;
      const y0 = riser.from!.y, y1 = riser.to!.y, x = riser.x;
      for (const node of Object.values(model.nodes)) {
        const box = node.bounds!;
        const crosses = x > box.x + 1e-6 && x < box.x + box.width - 1e-6 && box.y < y1 - 1e-6 && bottom(box) > y0 + 1e-6;
        expect(crosses, `${name}: ${node.id}`).toBe(false);
      }
      let edges = 0;
      for (const frame of model.frames ?? []) {
        if (x <= frame.box.x + 1e-6 || x >= frame.box.x + frame.box.width - 1e-6) continue;
        for (const y of [frame.box.y, bottom(frame.box)]) if (y > y0 + 1e-6 && y < y1 - 1e-6) edges++;
      }
      const counted = Number(/crossing \d+ sub-tiers and (\d+) frame edges/.exec(model.diagnostics.find(d => d.code === 'MESH_BUS_RISER')!.message)![1]);
      expect(edges, name).toBeLessThanOrEqual(counted);
    }
  });

  it('counts the routed segments that cross the riser', async () => {
    const model = await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser'));
    const riser = model.meshBuses![0]!.riser!, y0 = riser.from!.y, y1 = riser.to!.y;
    // An independent count: the routed segments that pass the riser x strictly, between the two bars.
    let expected = 0;
    for (const link of model.links) {
      if (link.layer !== 'routed' || link.technique === 'stub' || link.path === undefined) continue;
      for (const { from, to } of link.path.segments) {
        if (!(Math.min(from.x, to.x) < riser.x - 1e-6 && Math.max(from.x, to.x) > riser.x + 1e-6)) continue;
        const y = to.x === from.x ? from.y : from.y + (to.y - from.y) * (riser.x - from.x) / (to.x - from.x);
        if (y > y0 + 1e-6 && y < y1 - 1e-6) expected++;
      }
    }
    expect(score(model).snapshot.counters.riserCrossings).toBe(expected);
    expect(expected).toBe(EXPECTED_CROSSINGS);
  });

  it('refuses a move of a member row that puts a routed port within the riser keep-out', async () => {
    const model = await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser'));
    const upper = model.meshBuses![0]!, x = upper.riser!.x;
    const used = new Set(model.links.filter(link => link.layer === 'routed' && link.technique !== 'stub' && link.attachments)
      .flatMap(link => [link.attachments!.from, link.attachments!.to]).map(ref => `${ref.node}:${ref.ordinal}`));
    const found = Object.values(model.groups).flatMap(group => group.tier === upper.row ? group.nodes.flatMap(id => model.nodes[id]!.ports
      .filter(port => port.side === 'bottom' && used.has(`${id}:${port.ref.ordinal}`)).map(port => ({ group, port }))) : [])[0];
    if (found === undefined) return;
    const bounds = found.group.bounds!, dx = x - found.port.anchor!.x + 2;
    expect(optionalMoveHolds(model, [{ group: found.group, bounds: { ...bounds, x: bounds.x + dx } }], false)).toBe(false);
    // A move that must be made is never vetoed by the keep-out (`packClear` uses `laneSidesHold` alone).
    expect(laneSidesHold(model, [{ group: found.group, bounds: { ...bounds, x: bounds.x + dx } }], false)).toBe(true);
  });

  it('leaves no routed port within k of the riser after 7c, and none at publication', async () => {
    for (const name of JOINED_NAMES) {
      const placed = centre(flanks(lanes(rows(await placedModel(fixture(name))))));
      expect(riserKeepOutBreaches(placed), `${name} after 7c`).toEqual([]);
      const model = await run(fixture(name));
      expect(riserKeepOutBreaches(model), `${name} published`).toEqual([]);
      expect(model.diagnostics.filter(d => d.code === 'MESH_BUS_RISER_KEEP_OUT')).toEqual([]);
    }
  });

  it('lets no optional mover put a routed port deeper into the riser keep-out, stage by stage (7a to 7e)', async () => {
    const depths = (model: LayoutModel): Map<string, number> => {
      const all = new Map<string, number>();
      for (const group of Object.values(model.groups)) for (const [key, depth] of riserPenetrations(model, group)) all.set(key, depth);
      return all;
    };
    for (const name of JOINED_NAMES) {
      const afterLanes = lanes(rows(await placedModel(fixture(name))));
      const afterFlanks = flanks(afterLanes), afterCentre = centre(afterFlanks), afterBars = bars(afterCentre), afterBundles = bundles(afterBars);
      let previous = depths(afterLanes);
      for (const [stage, model] of [['flanks', afterFlanks], ['centre', afterCentre], ['bars', afterBars], ['bundles', afterBundles]] as const) {
        const now = depths(model);
        expect(riserNoDeeper(previous, now), `${name} at ${stage}`).toBe(true);
        previous = now;
      }
    }
  });
});
