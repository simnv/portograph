import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, render, score } from '../../src/index.js';
import { validateRoutedPaths } from '../../src/route/validate.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
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
