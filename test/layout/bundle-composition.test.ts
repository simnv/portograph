import { expect, it } from 'vitest';
import { score } from '../../src/index.js';
import { bars, bundles, centre, flanks, lanes, restoreLayoutModel, rows } from '../../src/internal.js';
import type { LayoutModel } from '../../src/model/index.js';
import { validateLanes } from '../../src/layout/lanes.js';
import { placed } from './phase-two-fixture.js';

const throughBars = async (yaml: string): Promise<LayoutModel> => bars(centre(flanks(lanes(rows(await placed(yaml))))));
function exactLanes(model: LayoutModel): void {
  for (const lane of model.lanes) {
    const member = model.links.find(link => lane.owner.kind === 'link' && link.id === lane.owner.id)!;
    const downward = model.groups[model.document.nodes[member.attachments!.from.node]!.group]!.tier!
      < model.groups[model.document.nodes[member.attachments!.to.node]!.group]!.tier!;
    const top = { x: lane.x, y: lane.bounds.y }, bottom = { x: lane.x, y: lane.bounds.y + lane.bounds.height };
    expect(member.path!.segments).toContainEqual({ from: downward ? top : bottom, to: downward ? bottom : top, owner: member.owner, lane: lane.id });
  }
  validateLanes(model);
  // These top/bottom fixtures admit monotone routes; reservations must never force a retreat.
  for (const member of model.links) {
    const segments = member.path!.segments, direction = Math.sign(segments.at(-1)!.to.y - segments[0]!.from.y);
    expect(segments.every(segment => direction * (segment.to.y - segment.from.y) >= 0)).toBe(true);
  }
}
function gates(model: LayoutModel): void {
  const result = score(model).snapshot;
  for (const id of ['G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const) expect(result.gates[id], id).toMatchObject({ passed: true });
}

it.each([false, true])('preserves every exact collinear transit reservation, reversed member %s', async reversed => {
  const before = await throughBars(`portograph: 2
groups: {ga: {tier: 0}, gm: {tier: 1}, gn: {tier: 2}, gb: {tier: 3}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  m: {group: gm}
  n: {group: gn}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], ${reversed ? '[b.q, a.q]' : '[a.q, b.q]'}]`);
  const model = bundles(before);
  expect(model.lanes.map(lane => [lane.id, lane.x, lane.owner, lane.bounds.width])).toEqual(before.lanes.map(lane => [lane.id, lane.x, lane.owner, lane.bounds.width]));
  expect(new Set(model.lanes.map(lane => lane.x)).size).toBe(2);
  exactLanes(model); gates(model);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  const corrupt = structuredClone(model), member = corrupt.links[0]!;
  const exact = member.path!.segments.find(segment => corrupt.lanes.some(lane => segment.lane === lane.id && Math.min(segment.from.y, segment.to.y) === lane.bounds.y && Math.max(segment.from.y, segment.to.y) === lane.bounds.y + lane.bounds.height))!;
  delete exact.lane;
  expect(() => validateLanes(corrupt)).toThrow('immutable reserved segment');
  expect(() => restoreLayoutModel(JSON.stringify(corrupt))).toThrow('immutable reserved segment');
});

it.each([false, true])('consumes global shared runs when just one bundle member uses that port, reversed %s', async reversed => {
  const before = await throughBars(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
  c: {group: gb, ports: [{name: p, side: top}]}
links: [${reversed ? '[b.p, a.p]' : '[a.p, b.p]'}, [a.q, b.q], ${reversed ? '[a.p, c.p]' : '[c.p, a.p]'}]`);
  const model = bundles(before), member = model.links[0]!, remainder = model.links[2]!;
  expect(model.junctions).toHaveLength(1);
  const outward = member.sharedRuns![reversed ? 'to' : 'from']!;
  const prefix = reversed ? [...member.path!.segments].reverse().map(s => ({ ...s, from: s.to, to: s.from })) : member.path!.segments;
  expect(prefix.slice(0, outward.length)).toEqual(outward);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  const corrupt = structuredClone(model), invalid = corrupt.links[0]!;
  invalid.path!.segments[reversed ? invalid.path!.segments.length - 1 : 0]!.owner = invalid.owner;
  expect(() => restoreLayoutModel(JSON.stringify(corrupt))).toThrow();
  const complete = structuredClone(model), link = complete.links[2]!, handoff = remainder.sharedRuns![reversed ? 'from' : 'to']!;
  const terminal = complete.nodes.c!.ports[0]!.anchor!;
  const run = { from: handoff.at(-1)!.to, to: terminal, owner: link.owner };
  const segments = [...handoff, run];
  link.path = { owner: link.owner, layer: 'routed', fixed: false, segments: reversed ? segments : [...segments].reverse().map(s => ({ ...s, from: s.to, to: s.from })) };
  gates(complete);
});

it.each([{ target: false, reversed: false }, { target: false, reversed: true }, { target: true, reversed: false }, { target: true, reversed: true }])('composes a shared endpoint with two exact transit reservations, %j', async ({ target, reversed }) => {
  const before = await throughBars(`portograph: 2
groups: {ga: {tier: 0}, gm: {tier: 1}, gn: {tier: 2}, gb: {tier: 3}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}${target ? ', {name: q, side: bottom}' : ''}]}
  m: {group: gm}
  n: {group: gn}
  b: {group: gb, ports: [{name: p, side: top}${target ? '' : ', {name: q, side: top}'}]}
links: [[a.p, b.p], ${target ? reversed ? '[b.p, a.q]' : '[a.q, b.p]' : reversed ? '[b.q, a.p]' : '[a.p, b.q]'}]`);
  const model = bundles(before);
  expect(model.junctions).toHaveLength(1);
  exactLanes(model); gates(model);
  expect(model.lanes.map(l => [l.id, l.x, l.owner])).toEqual(before.lanes.map(l => [l.id, l.x, l.owner]));
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
});

it.each([false, true])('composes a shared fan with lane/bar hints and actual crossed-bar annotations, reversed %s', async reversed => {
  const before = await throughBars(`portograph: 2
groups: {ga: {tier: 0}, gm: {tier: 1}, gb: {tier: 2, shape: bar}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}, {name: u, side: bottom}]}
  m: {group: gm}
  upper: {group: gb, label: I, ports: [{name: up, side: top}], size: {width: 400, height: 35}}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], ${reversed ? '[b.q, a.p]' : '[a.p, b.q]'}, [a.u, upper.up]]`);
  const model = bundles(before);
  expect(model.junctions).toHaveLength(1);
  exactLanes(model); gates(model);
  for (const drop of model.barDrops.filter(drop => model.links.find(link => link.id === drop.link)!.bundle)) {
    const member = model.links.find(link => link.id === drop.link)!;
    const port = model.nodes.b!.ports.find(p => [member.attachments!.from, member.attachments!.to].some(ref => ref.node === p.ref.node && ref.name === p.ref.name && ref.ordinal === p.ref.ordinal))!;
    expect(port.anchor!.x).toBe(drop.slotX);
    expect(drop.barCross).toContain('upper');
    expect(member.path!.segments.some(segment => segment.barCross?.includes('upper') && segment.from.x === drop.slotX && segment.to.x === drop.slotX)).toBe(true);
  }
  expect(model.barDrops.map(drop => [drop.id, drop.owner])).toEqual(before.barDrops.map(drop => [drop.id, drop.owner]));
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
});

it.each([{ transit: false, reversed: false }, { transit: false, reversed: true }, { transit: true, reversed: false }, { transit: true, reversed: true }])('composes the target bar shared tree with %j', async ({ transit, reversed }) => {
  const before = await throughBars(`portograph: 2
groups: {ga: {tier: 0}, ${transit ? 'gm: {tier: 1}, ' : ''}gb: {tier: ${transit ? 2 : 1}, shape: bar}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
${transit ? '  m: {group: gm}\n' : ''}  b: {group: gb, ports: [{name: p, side: top}]}
links: [[a.p, b.p], ${reversed ? '[b.p, a.q]' : '[a.q, b.p]'}]`);
  const model = bundles(before);
  expect(model.lanes).toHaveLength(transit ? 2 : 0);
  expect(model.junctions).toHaveLength(1);
  const root = model.junctions[0]!;
  for (const member of model.links) {
    const toBar = member.attachments!.to.node === 'b';
    const run = member.path!.segments[toBar ? member.path!.segments.length - 1 : 0]!;
    expect(toBar ? { ...run, from: run.to, to: run.from } : run).toEqual(root.stem);
  }
  exactLanes(model); gates(model);
  for (const drop of model.barDrops) expect(drop.slotX).toBe(model.nodes.b!.ports[0]!.anchor!.x);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
});

it('retains the adjacent-tier shared-source bar mirror', async () => {
  const before = await throughBars(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1, shape: bar}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], [a.p, b.q]]`);
  const model = bundles(before), root = model.junctions[0]!;
  expect(model.lanes).toHaveLength(0);
  expect(model.junctions).toHaveLength(1);
  for (const member of model.links) {
    const fromShared = member.attachments!.from.node === 'a';
    const segment = member.path!.segments[fromShared ? 0 : member.path!.segments.length - 1]!;
    expect(fromShared ? segment : { ...segment, from: segment.to, to: segment.from }).toEqual(root.stem);
    const barRef = fromShared ? member.attachments!.to : member.attachments!.from;
    const barPort = model.nodes.b!.ports.find(port => port.ref.name === barRef.name)!;
    expect(model.barDrops.find(drop => drop.link === member.id)!.slotX).toBe(barPort.anchor!.x);
  }
  exactLanes(model); gates(model);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
});
