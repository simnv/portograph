import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { centre, seatCandidates } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { rows } from '../../src/layout/rows.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { trimBodies } from '../../src/layout/end-trim.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { rebuildRegions } from '../../src/layout/regions.js';
import { targetTap } from '../../src/layout/alignment-targets.js';
import type { Course } from '../../src/model/layout.js';
import { findPort } from '../../src/layout/row-paths.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import type { LayoutModel, LayoutNode } from '../../src/model/layout.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt, placed } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from './joint-off.js';

// ADR-0027, the seat owns the body (dense-16x9 ticket 02, design note of 2026-11-15): a seat decides the feeds a body stands on, its x and its
// width; `alignmentSeats` holds that one decision, and every later pass, the replay and the publication check read it. While a seat stands, the
// main move of its group reads only the feeds of the kept ports, and a seat is decided again only for more owed verticals or more targets.
const read = (path: string): string => readFileSync(new URL(`../../goldens/${path}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const bends = (model: LayoutModel): number => { const { routed, overlay } = score(model).snapshot.counts; return routed.turns + overlay.turns; };
const failed = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const spent = (model: LayoutModel): boolean => model.diagnostics.some(item => item.code === 'PLACEMENT_NON_CONVERGENCE');
/** The links whose two ports stand on one x. */
const vertical = (model: LayoutModel): string[] => model.links.filter(link => {
  const from = findPort(model, link.attachments!.from), to = findPort(model, link.attachments!.to);
  return from?.anchor !== undefined && to?.anchor !== undefined && Math.abs(from.anchor.x - to.anchor.x) <= 0.5;
}).map(link => link.id);

describe('the seat owns the body (ADR-0027)', () => {
  it('a-face feedOrder:false: snk0 is seated once over three feeds and is not dragged off them; 613x484, 7 bends', async () => {
    // Before: the main move pulled snk0 toward its fourth feed every pass, and the body grew again in place each time until the cap
    // left it standing none (1076x514, 14 bends).
    const model = await run(withoutJointOrder(read('synthetic/a-face-aligns-one-port-and-leaves-a-chord-port-in-place-middle-tier-first')));
    expect(spent(model)).toBe(false);
    expect(model.alignmentSeats!.snk0!.ports).toHaveLength(3);
    for (const port of model.alignmentSeats!.snk0!.ports) {
      const link = model.links.find(item => [item.attachments!.from, item.attachments!.to].some(end => portId(findPort(model, end)!.ref) === port));
      expect(link, port).toBeDefined();
      expect(vertical(model), port).toContain(link!.id);
    }
    expect(Math.round(model.canvas!.width)).toBe(613);
    expect(Math.round(model.canvas!.height)).toBe(484);
    expect(bends(model)).toBe(7);
  }, 120000);

  it('a-step-keeps-the-vertical-it-reached keeps its 13 verticals with no gate failed and settles', async () => {
    const model = await run(read('synthetic/a-step-keeps-the-vertical-it-reached'));
    expect(vertical(model)).toHaveLength(13);
    expect(failed(model)).toEqual([]);
    expect(spent(model)).toBe(false);
  }, 120000);

  it('private-datacenter-spine-leaf settles with at most 10 bends', async () => {
    const model = await run(read('real/private-datacenter-spine-leaf'));
    expect(bends(model)).toBeLessThanOrEqual(10);
    expect(spent(model)).toBe(false);
  }, 120000);

  it('a-corridor-moves-after-the-grid-settles publishes, and its seat record equals its replay', async () => {
    const model = await run(read('synthetic/a-corridor-moves-after-the-grid-settles'));
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.alignmentSeats).toBeDefined();
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  }, 300000);

  it('the two-parent model of ADR-0010 settles, and a forged 5 px slide either way is refused', async () => {
    const model = centre(flanks(lanes(rows(await placed(withoutJointOrder(`portograph: 2
groups: {up: {tier: 0}, low: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: up, ports: [{name: p, side: bottom}]}
  spare: {group: up}
  c:
    group: low
    ports:
      - {name: p, side: top, order: 0}
      - {name: q, side: top, order: 1}
links: [[a.p, c.q, {route: orthogonal}], [b.p, c.p, {route: orthogonal}]]`))))));
    expect(spent(model)).toBe(false);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    for (const dx of [5, -5]) {
      const slid = structuredClone(model);
      slid.nodes.c!.bounds!.x += dx;
      for (const port of slid.nodes.c!.ports) { port.anchor!.x += dx; if (port.pill) port.pill.bounds.x += dx; }
      for (const label of slid.labels) if (label.owner.kind === 'node' && label.owner.id === 'c' && label.bounds) label.bounds.x += dx;
      expect(() => restoreLayoutModel(JSON.stringify(slid)), `slide ${dx}`).toThrow(/Centring invariant violated/);
    }
  }, 60000);

  it('the feedOrder:false copy of a-group-shift-leaves-a-chord-clear-of-a-lane-middle-tier-first settles, and each seated body keeps one width', async () => {
    const model = await run(withoutJointOrder(read('synthetic/a-group-shift-leaves-a-chord-clear-of-a-lane-middle-tier-first')));
    expect(spent(model)).toBe(false);
    for (const [id, seat] of Object.entries(model.alignmentSeats!)) expect(model.nodes[id]!.bounds!.width, id).toBeLessThanOrEqual(seat.width + 1e-6);
  }, 120000);

  it('replays its record: restore is a fixed point, and the reversed links give the same seats (R1, R3)', async () => {
    const text = withoutJointOrder(read('synthetic/a-face-aligns-one-port-and-leaves-a-chord-port-in-place-middle-tier-first'));
    const model = await run(text);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    const links = await run(reversed(text, 'links'));
    expect(links.alignmentSeats).toEqual(model.alignmentSeats);
    // A record that names a port its body does not stand over is refused, not replayed into place (R5).
    const forged = structuredClone(model);
    const seat = forged.alignmentSeats!.snk0!;
    forged.nodes.snk0!.bounds!.x += 40;
    for (const port of forged.nodes.snk0!.ports) { port.anchor!.x += 40; if (port.pill) port.pill.bounds.x += 40; }
    for (const label of forged.labels) if (label.owner.kind === 'node' && label.owner.id === 'snk0' && label.bounds) label.bounds.x += 40;
    expect(seat.ports.length).toBeGreaterThan(0);
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow();
  }, 180000);

  it('ranks the recorded seat first among the seats that stand as many owed verticals and targets', () => {
    const node = { id: 'n', bounds: { x: 300, y: 0, width: 60, height: 40 }, sidePitch: { top: 16, bottom: 16 }, contentInsets: { top: 10, right: 10, bottom: 10, left: 10 },
      ports: [0, 1].map(index => ({ ref: { node: 'n', anonymous: true, index: index + 1 }, side: 'top', engineOrder: index, anchor: { x: 320 + 16 * index, y: 0 } })) } as unknown as LayoutNode;
    const open = { low: -Infinity, high: Infinity };
    const target = (index: number, x: number) => ({ key: `t${index}`, side: 'top' as const, index, x, owes: true });
    // Two single-target seats: t0 is reached by the shorter slide, but the record keeps t1, so t1 comes first.
    // The cap here admits no growth, so each seat is a slide.
    const slides = (_window: unknown, width: number): boolean => width <= 60;
    const targets = [target(0, 330), target(1, 600)];
    expect(seatCandidates(node, targets, { siblings: open, window: open, stops: open }, true, slides)[0]!.keys).toEqual(['t0']);
    expect(seatCandidates(node, targets, { siblings: open, window: open, stops: open, kept: new Set(['t1']) }, true, slides)[0]!.keys).toEqual(['t1']);
    // A window with more targets is decided again over the record.
    const both = [target(0, 330), target(1, 346)];
    expect(seatCandidates(node, both, { siblings: open, window: open, stops: open, kept: new Set(['t1']) }, true, slides)[0]!.keys).toEqual(['t0', 't1']);
  });

  describe('the feedOrder:false group-shift copy with the courses of link-12 and link-13 forced (the course trial of its course round)', () => {
    // link-12 (src0 -> snk1) runs round the left of the sheet, link-13 (src1 -> snk0) down a perimeter lane right of `access` into the top of snk0,
    // with one turn. The courses are the ones the course round offers on this sheet.
    const courses = [
      { link: 'link-12', kind: 'transit', side: 'left', from: { face: 'left' }, to: { face: 'left' }, runs: ['perimeter'] },
      { link: 'link-13', kind: 'transit', side: 'right', from: { face: 'right' }, to: { face: 'top' }, runs: ['perimeter', 'tier-gap'] },
    ] as unknown as Course[];
    /** The x of the top port of snk0 on link-13, and the x of link-13's perimeter lane. */
    const underLane = (model: LayoutModel): [number, number] => {
      const link = model.links.find(item => item.id === 'link-13')!, end = [link.attachments!.from, link.attachments!.to].find(ref => ref.node === 'snk0')!;
      const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-13' && item.kind === 'perimeter')!;
      return [findPort(model, end)!.anchor!.x, lane.x];
    };
    const drafts: LayoutModel[] = [];
    beforeAll(async () => {
      const sink = targetTap.sink;
      targetTap.sink = (tap, value) => { if (tap === 'beforeEndTrim') drafts.push(JSON.parse(value) as LayoutModel); };
      try {
        await layout(parse(withoutJointOrder(read('synthetic/a-group-shift-leaves-a-chord-clear-of-a-lane-middle-tier-first'))),
          { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: courses });
      } finally { if (sink === undefined) delete targetTap.sink; else targetTap.sink = sink; }
    }, 120000);

    it('the close-up after the trim does not take snk0 off the lane of link-13 it enters straight', () => {
      // The trim frees width beside edge-near, and the close-up would move edge-near toward edge-far. The perimeter lane of link-13 does not
      // follow a group, so before the guard the port left the lane it enters straight and link-13 took two turns its course had not promised.
      // The draft before the trim, with edge-near moved so that snk0 stands under the lane, as the course of link-13 asks.
      const draft = structuredClone(drafts.at(-1)!);
      const [port, lane] = underLane(draft);
      moveGroup(draft, draft.groups['edge-near']!, lane - port, 0);
      // snk0 as a growth in place left it: 100 px wider on its left, its ports where they stand; the group box grows with it.
      const body = draft.nodes['snk0']!.bounds!, box = draft.groups['edge-near']!.bounds!;
      draft.nodes['snk0']!.bounds = { ...body, x: body.x - 100, width: body.width + 100 };
      draft.nodes['snk0']!.size = { width: body.width + 100, height: body.height };
      draft.groups['edge-near']!.bounds = { ...box, x: box.x - 100, width: box.width + 100 };
      rebuildNodeGeometry(draft, ['snk0'], 'current');
      rebuildRegions(draft);
      trimBodies(draft);
      expect(draft.bodyTrims?.nodes['snk0']).toBeDefined();
      const [after, laneAfter] = underLane(draft);
      expect(Math.abs(after - laneAfter)).toBeLessThanOrEqual(0.5);
      expect(draft.diagnostics.some(item => item.code === 'CLOSE_UP_DECLINED' && item.message.includes('edge-near') && item.message.includes('link-13'))).toBe(true);
    });
  });

});
