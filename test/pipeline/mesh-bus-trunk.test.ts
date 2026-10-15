import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, render, score } from '../../src/index.js';
import { validateRoutedPaths } from '../../src/route/validate.js';
import type { Lane, LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { foreignOverExtensions, reportTrunkCrossings, trunkRing, trunkXAfter } from '../../src/layout/trunk.js';
import { holdsMove } from '../../src/layout/move-reservations.js';
import { EDGE_MARGIN, RING_PITCH } from '../../src/layout/course-rows.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const codes = (model: LayoutModel, code: string) => model.diagnostics.filter(item => item.code === code);
const caseEleven = (): string => readFileSync(new URL('../../ref/hand-solves/11-sync-mesh-on-three-rows.yaml', import.meta.url), 'utf8');

/** A mesh of `ids` rows, one group per row on tiers 0, 1, 2 ..., a full `sync` mesh, and a routed spine from the first node of each row to the next. */
function mesh(rows: string[][], extraGroups = '', extraNodes = '', extraLinks = ''): string {
  const groups = rows.map((_, index) => `  r${index}: { tier: ${index} }`).join('\n');
  const nodes = rows.flatMap((ids, index) => ids.map(id => `  ${id}: { group: r${index} }`)).join('\n');
  const all = rows.flat();
  const links = all.flatMap((a, i) => all.slice(i + 1).map(b => `  - { from: ${a}, to: ${b}, class: sync }`));
  const spine = rows.slice(1).map((ids, index) => `  - [${rows[index]![0]}, ${ids[0]}]`);
  return `portograph: 2\ngroups:\n${groups}\n${extraGroups}nodes:\n${nodes}\n${extraNodes}links:\n${[...spine, ...links].join('\n')}\n${extraLinks}`;
}
const trunkOf = (model: LayoutModel) => model.meshBuses!.find(bus => bus.trunk !== undefined)!;
const laneOf = (model: LayoutModel) => model.lanes.find(lane => lane.id === trunkOf(model).trunk!.lane)!;

describe('a mesh over three rows: the trunk in placement (architecture ticket 21, phase 2)', () => {
  it('puts the trunk of case 11 on the right, with no routed leg crossed, one report and every gate passing', async () => {
    const model = await run(caseEleven());
    const head = trunkOf(model);
    expect(head.trunk!.side).toBe('right');
    expect(head.trunk!.buses).toHaveLength(3);
    expect(codes(model, 'MESH_BUS_TRUNK')).toHaveLength(1);
    expect(codes(model, 'MESH_BUS_TRUNK')[0]!.message).toContain('0 legs crossed');
    expect(model.links.filter(link => link.technique === 'mesh-bus')).toHaveLength(36);
    expect(gates(model)).toEqual([]);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
  });

  it('reserves one perimeter lane owned by the head bus, beyond every box, with the bars running to it and the canvas holding it', async () => {
    const model = await run(caseEleven());
    const head = trunkOf(model), lane = laneOf(model);
    expect(model.lanes.filter(item => item.owner.kind === 'mesh-bus')).toHaveLength(1);
    expect([lane.kind, lane.owner, lane.layer, lane.side, lane.ring, lane.span]).toEqual(['perimeter', { kind: 'mesh-bus', id: head.id }, 'overlay', 'right', 0, { top: 0, bottom: 2 }]);
    expect(head.trunk!.x).toBe(lane.x);
    const edge = Math.max(...Object.values(model.groups).map(group => group.bounds!.x + group.bounds!.width));
    expect(lane.x).toBeCloseTo(edge + EDGE_MARGIN, 6);
    expect(lane.bounds.width).toBe(RING_PITCH);
    const bars = model.meshBuses!.map(bus => bus.bar!);
    for (const bar of bars) expect(Math.max(bar.from.x, bar.to.x)).toBeCloseTo(lane.x, 6);
    // The lane runs from the uppermost bar to the lowermost.
    expect(lane.bounds.y).toBeCloseTo(Math.min(...bars.map(bar => bar.from.y)), 6);
    expect(lane.bounds.y + lane.bounds.height).toBeCloseTo(Math.max(...bars.map(bar => bar.from.y)), 6);
    const canvas = model.canvas!;
    expect(canvas.x + canvas.width).toBeGreaterThanOrEqual(lane.bounds.x + lane.bounds.width + 12 - 1e-6);
  });

  it('carries the one label on the bar with the most members, and none on the others', async () => {
    const model = await run(mesh([['a1', 'a2', 'a3'], ['b1', 'b2', 'b3'], ['c1', 'c2', 'c3', 'c4']]));
    expect(model.meshBuses!.map(bus => bus.labelled)).toEqual([false, false, undefined]);
    expect(model.meshBuses!.filter(bus => bus.labelRoom !== undefined).map(bus => bus.id)).toEqual(['mesh-bus-3']);
  });

  it('restores as a fixed point, and refuses a trunk lane that is not where its boxes derive it', async () => {
    const model = await run(caseEleven());
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    const moved = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const lane = moved.lanes.find(item => item.owner.kind === 'mesh-bus')!;
    lane.x += 5; lane.bounds.x += 5;
    expect(() => restoreLayoutModel(JSON.stringify(moved))).toThrow();
    const wrong = JSON.parse(JSON.stringify(model)) as LayoutModel;
    wrong.lanes.find(item => item.owner.kind === 'mesh-bus')!.id = 'trunk:other';
    expect(() => restoreLayoutModel(JSON.stringify(wrong))).toThrow();
  });
});

describe('a mesh over three rows: the side of the trunk (stage 5)', () => {
  const rows = [['a1', 'a2', 'a3'], ['b1', 'b2', 'b3'], ['c1', 'c2', 'c3']];
  const foreign = (tier: number): string => mesh(rows, '  f: { tier: ' + tier + ' }\n', '  f1: { group: f }\n');
  it('takes the side that no foreign group stands on, whichever the skeleton gives it', async () => {
    const model = await run(foreign(1));
    const head = trunkOf(model), group = model.groups['f']!.bounds!, middle = model.groups['r1']!.bounds!;
    const foreignRight = group.x > middle.x;
    expect(head.trunk!.side).toBe(foreignRight ? 'left' : 'right');
    expect(codes(model, 'MESH_BUS_JOIN_DECLINED')).toHaveLength(0);
    expect(gates(model)).toEqual([]);
  });

  it('takes the left on a tie: no routed leg, no frame, equal extensions', async () => {
    const model = await run(mesh(rows).replace(/ {2}- \[(a1, {1}b1|b1, {1}c1)\]\n/g, ''));
    expect(trunkOf(model).trunk!.side).toBe('left');
    expect(codes(model, 'MESH_BUS_TRUNK')[0]!.message).toContain('0 legs crossed');
  });

  it('declines the join by one re-run when a foreign group stands on both sides of a member row', async () => {
    // One foreign group is fed from the first node of the top row and one from its last, so the skeleton seats them one on each side of the row.
    const both = mesh(rows, '  f: { tier: 1 }\n  g: { tier: 1 }\n', '  f1: { group: f }\n  g1: { group: g }\n', '  - [a1, f1]\n  - [a3, g1]\n');
    const model = await run(both);
    const left = model.groups['f']!.bounds!.x < model.groups['r1']!.bounds!.x, other = model.groups['g']!.bounds!.x < model.groups['r1']!.bounds!.x;
    expect(left).not.toBe(other);
    expect(model.meshBuses!.every(bus => bus.mesh === undefined && bus.trunk === undefined)).toBe(true);
    expect(model.lanes.filter(item => item.owner.kind === 'mesh-bus')).toHaveLength(0);
    const found = codes(model, 'MESH_BUS_JOIN_DECLINED').filter(item => item.message.includes('trunk-blocked'));
    expect(found).toHaveLength(3);
    expect(model.declinedTrunks).toHaveLength(1);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    expect(gates(model)).toEqual([]);
  });
});

describe('a mesh over three rows: paths, score and SVG (architecture ticket 21, phase 3)', () => {
  it('publishes each cross path as stub, bar run, trunk, bar run, stub, five orthogonal segments, and validates them again', async () => {
    const model = await run(caseEleven());
    const head = trunkOf(model), x = head.trunk!.x!;
    expect(head.cross).toHaveLength(27);
    for (const id of head.cross!) {
      const link = model.links.find(item => item.id === id)!;
      expect(link.technique).toBe('mesh-bus');
      const segments = link.path!.segments;
      expect(segments).toHaveLength(5);
      for (const [index, segment] of segments.entries()) {
        expect(segment.from.x === segment.to.x || segment.from.y === segment.to.y).toBe(true);
        if (index > 0) expect(segment.from).toEqual(segments[index - 1]!.to);
      }
      // The three middle segments stand on the trunk: the run to it, the vertical on it, the run back.
      expect(segments[1]!.to.x).toBeCloseTo(x, 6);
      expect(segments[2]).toMatchObject({ from: { x }, to: { x } });
    }
    expect(() => validateRoutedPaths(model)).not.toThrow();
  });

  it('publishes the joins of the trunk on the bars, top first, and counts no routed crossing', async () => {
    const model = await run(caseEleven());
    const head = trunkOf(model);
    expect(head.trunk!.joins).toHaveLength(3);
    head.trunk!.buses.forEach((id, index) => {
      const bar = model.meshBuses!.find(bus => bus.id === id)!.bar!;
      expect(head.trunk!.joins![index]).toEqual({ x: head.trunk!.x, y: bar.from.y });
    });
    const report = score(model).snapshot;
    expect(report.counters.meshBusTrunks).toBe(1);
    expect(report.counters.trunkCrossings).toBe(0);
    expect(report.counts.overlay.crossings).toEqual({ pairs: 0, points: 0 });
    expect(report.counts.overlay.links).toBe(0);
  });

  it('keeps the one label of the mesh, centred on the member span of its bar', async () => {
    const model = await run(caseEleven());
    const labels = model.labels.filter(label => label.role === 'mesh-bus');
    expect(labels).toHaveLength(1);
    expect(labels[0]!.text).toBe('sync mesh (9 nodes)');
    const bar = model.meshBuses!.find(bus => bus.id === (labels[0]!.owner as { id: string }).id)!;
    const stubs = bar.stubs!.map(stub => stub.from.x), centre = (Math.min(...stubs) + Math.max(...stubs)) / 2;
    expect(labels[0]!.bounds!.x + labels[0]!.bounds!.width / 2).toBeCloseTo(centre, 3);
  });

  it('draws the trunk as one path per pair of bars in the head group, and every group of the join names the head', async () => {
    const model = await run(caseEleven());
    const svg = render(model);
    const head = trunkOf(model);
    expect(svg.match(/<g [^>]*data-mesh="mesh-bus-1"/g) ?? []).toHaveLength(3);
    const group = svg.split('<g ').find(chunk => chunk.includes(`data-id="${head.id}"`) && chunk.includes('mesh-bus'))!;
    expect(group.match(/class="[^"]*\btrunk\b[^"]*"/g) ?? []).toHaveLength(2);
  });
});

describe('a mesh over three rows: fixtures and draw.io (architecture ticket 21, phase 4)', () => {
  const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

  it('joins three rows of 3, 4 and 3 nodes by one trunk with one label, 45 mesh-bus links and every gate passing', async () => {
    const model = await run(fixture('a-mesh-over-three-rows-joins-its-bars-with-one-trunk'));
    expect(trunkOf(model).trunk!.buses).toHaveLength(3);
    expect(model.links.filter(link => link.meshBus !== undefined && link.technique === 'mesh-bus')).toHaveLength(45);
    expect(model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined)).toHaveLength(0);
    expect(model.labels.filter(label => label.role === 'mesh-bus').map(label => label.text)).toEqual(['sync mesh (10 nodes)']);
    expect(score(model).snapshot.counters.trunkCrossings).toBe(0);
    expect(gates(model)).toEqual([]);
  });

  it('puts the trunk beside a tier without members, EDGE_MARGIN from its frame, spanning tiers 0 to 3', async () => {
    const model = await run(fixture('a-trunk-passes-a-row-without-members'));
    const lane = laneOf(model), edge = Math.max(...Object.values(model.groups).map(group => group.bounds!.x + group.bounds!.width));
    expect(lane.span).toEqual({ top: 0, bottom: 3 });
    expect(lane.x).toBeCloseTo(edge + EDGE_MARGIN, 6);
    expect(gates(model)).toEqual([]);
  });

  it('keeps the trunk off the side where a foreign group stands', async () => {
    const model = await run(fixture('a-trunk-takes-the-side-with-no-foreign-group'));
    const foreign = model.groups['foreign']!.bounds!, middle = model.groups['r1']!.bounds!;
    expect(trunkOf(model).trunk!.side).toBe(foreign.x > middle.x ? 'left' : 'right');
    expect(gates(model)).toEqual([]);
  });

  it('keeps three buses and plain cross links when one pair of rows is not complete', async () => {
    const model = await run(fixture('a-three-row-mesh-with-one-pair-missing-keeps-three-buses'));
    expect(model.meshBuses).toHaveLength(3);
    expect(model.meshBuses!.every(bus => bus.mesh === undefined && bus.trunk === undefined)).toBe(true);
    const reasons = codes(model, 'MESH_BUS_JOIN_DECLINED').map(item => item.message);
    expect(reasons.filter(message => message.includes('partial-mesh'))).toHaveLength(2);
    expect(reasons.filter(message => message.includes('incomplete'))).toHaveLength(1);
    expect(gates(model)).toEqual([]);
  });

  it('sends the trunk to the side that fewer passing routed links cross', async () => {
    const model = await run(fixture('a-routed-links-past-a-member-row-send-the-trunk-to-the-side-they-cross-less'));
    const head = trunkOf(model);
    // Without the passing links the right reads no leg and wins; with them it reads two, the left one.
    expect(head.trunk!.side).toBe('left');
    expect(codes(model, 'MESH_BUS_TRUNK')[0]!.message).toContain('1 legs crossed');
    expect(codes(model, 'MESH_BUS_TRUNK')[0]!.message).toContain('the other side crosses 2 legs');
    expect(score(model).snapshot.counters.trunkCrossings).toBe(0);
    expect(gates(model)).toEqual([]);
  });

  it('exports the trunk as N - 1 pieces pinned to the joints of the bars, at the published coordinates', async () => {
    const model = await run(caseEleven());
    const xml = drawio(model);
    const head = trunkOf(model);
    const pieces = [...xml.matchAll(/<mxCell id="pg-busTrunk~mesh-bus-1~(\d+)"[^>]*source="([^"]+)" target="([^"]+)"/g)];
    expect(pieces).toHaveLength(head.trunk!.buses.length - 1);
    expect(pieces[0]![3]).toBe(pieces[1]![2]);
    for (const piece of pieces) {
      expect(piece[2]).toMatch(/^pg-busJoint~mesh-bus-\d~\d+$/);
      expect(xml).toContain(`id="${piece[2]}"`);
      expect(xml).toContain(`id="${piece[3]}"`);
    }
    expect(xml).toMatch(/pg-busTrunk~mesh-bus-1~0"[^>]*style="[^"]*edgeStyle=none/);
  });
});

describe('a mesh over three rows: the guards (architecture ticket 21, review fixes)', () => {
  const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
  const box = (model: LayoutModel, id: string) => model.groups[id]!.bounds!;

  it('refuses a move that puts a foreign unit across a bar extension, and lets a member row carry the trunk outward', async () => {
    const model = await run(fixture('a-trunk-takes-the-side-with-no-foreign-group'));
    const head = trunkOf(model), lane = laneOf(model), foreign = model.groups['foreign']!;
    const y = head.bar!.from.y, middle = box(model, 'r1');
    const across = { group: foreign, bounds: { x: lane.x - 60, y: y - 10, width: 40, height: 20 } };
    expect(holdsMove(model, [across], false, ['trunkExtension'])).toBe(false);
    expect(foreignOverExtensions(model, head, [across])).toEqual([{ group: 'foreign', bus: head.id }]);
    // The foreign group moved clear of every extension, and the member row moved outward: both hold.
    expect(holdsMove(model, [{ group: foreign, bounds: { ...across.bounds, y: y + 4000 } }], false, ['trunkExtension'])).toBe(true);
    const row = model.groups['r1']!;
    expect(holdsMove(model, [{ group: row, bounds: { ...middle, x: middle.x + 30 } }], false, ['trunkExtension'])).toBe(true);
    // A foreign group that moves past the old trunk x: the extension does not reach it now, but the trunk moves out with the group and its extension would run through it.
    const past = lane.side === 'right' ? lane.x + 20 : lane.x - 60;
    expect(holdsMove(model, [{ group: foreign, bounds: { x: past, y: y - 10, width: 40, height: 20 } }], false, ['trunkExtension'])).toBe(false);
    expect(foreignOverExtensions(model, head, [{ group: foreign, bounds: { x: past, y: y - 10, width: 40, height: 20 } }])).toEqual([]);
    // The trunk x is read after the move: a member row that moves outward carries it.
    expect(trunkXAfter(model, head, [{ group: row, bounds: { ...middle, x: middle.x + 30 } }])).toBeGreaterThan(lane.x);
  });

  it('reports MESH_BUS_TRUNK_CROSSED for a forced move that leaves a foreign unit across an extension', async () => {
    const model = await run(fixture('a-trunk-takes-the-side-with-no-foreign-group'));
    expect(codes(model, 'MESH_BUS_TRUNK_CROSSED')).toHaveLength(0);
    const forced = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const head = trunkOf(forced), lane = forced.lanes.find(item => item.id === head.trunk!.lane)!;
    forced.groups['foreign']!.bounds = { x: lane.x - 60, y: head.bar!.from.y - 10, width: 40, height: 20 };
    reportTrunkCrossings(forced);
    const found = codes(forced, 'MESH_BUS_TRUNK_CROSSED');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('warning');
  });

  it('puts a trunk one ring beyond the highest ring it meets, not a count of the lanes', () => {
    const lane = (ring: number, y = 0, height = 100): Lane => ({ id: `lane-${ring}`, kind: 'perimeter', owner: { kind: 'link', id: `l${ring}` }, layer: 'overlay', group: 'g', tier: 0, side: 'right', ring, x: 0, bounds: { x: 0, y, width: 11.5, height } });
    const span = { x: 0, y: 10, width: 11.5, height: 50 };
    expect(trunkRing([], 'right', span)).toBe(0);
    expect(trunkRing([lane(0)], 'right', span)).toBe(1);
    // A course on ring 1 and none on ring 0 (the ring-0 lane stands apart): a count would give 1 and collide.
    expect(trunkRing([lane(1), lane(0, 500, 20)], 'right', span)).toBe(2);
    expect(trunkRing([lane(0), lane(1)], 'right', span)).toBe(2);
    expect(trunkRing([lane(3)], 'left', span)).toBe(0);
  });

  it('declines a blocked join by one re-run: two placement runs', async () => {
    const rows = [['a1', 'a2', 'a3'], ['b1', 'b2', 'b3'], ['c1', 'c2', 'c3']];
    const yaml = mesh(rows, '  f: { tier: 1 }\n  g: { tier: 1 }\n', '  f1: { group: f }\n  g1: { group: g }\n', '  - [a1, f1]\n  - [a3, g1]\n');
    const labels: string[] = [];
    const events: Record<string, unknown>[] = [];
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testMaxReruns: 3,
      testSideTrace: event => { if (event['ev'] === 'trunk-blocked') events.push(event); }, onProgress: progress => { labels.push(progress.stage); } });
    expect(model.declinedTrunks).toHaveLength(1);
    expect(labels.filter(label => label === 'resolve')).toHaveLength(2);
    // The re-run is drawn from the shared MAX_RERUNS budget: one used, the rest left for the later rounds.
    expect(events).toEqual([expect.objectContaining({ reruns: 1, left: 2 })]);
  });

  it('declines every trunk on the last run the budget allows, and publishes with no run past the cap', async () => {
    const rows = [['a1', 'a2', 'a3'], ['b1', 'b2', 'b3'], ['c1', 'c2', 'c3']];
    const yaml = mesh(rows, '  f: { tier: 1 }\n  g: { tier: 1 }\n', '  f1: { group: f }\n  g1: { group: g }\n', '  - [a1, f1]\n  - [a3, g1]\n');
    for (const budget of [0, 1, 4]) {
      const labels: string[] = [];
      const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testMaxReruns: budget, onProgress: progress => { labels.push(progress.stage); } });
      expect(model.declinedTrunks).toHaveLength(1);
      expect(model.meshBuses!.every(bus => bus.trunk === undefined)).toBe(true);
      // Budget 0: the one run declines the trunk at once. Budget 1 or more: the first run is blocked and the second declines it.
      expect(labels.filter(label => label === 'resolve')).toHaveLength(budget === 0 ? 1 : 2);
    }
  }, 120000);
});
