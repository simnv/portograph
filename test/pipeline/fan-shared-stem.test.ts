import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score } from '../../src/index.js';
import { MIN_STEM, edgeMargin, fanPitch, priorSideRows, sideRowBudget } from '../../src/layout/bundle-geometry.js';
import { DEFAULT_STROKE_WIDTHS, routedStrokeWidth } from '../../src/theme/geometry.js';
import type { LayoutModel, Owner } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** Every link of the fan leaves the parent anchor on one identical first stem, and no two paths overlap. */
function sharedStem(model: LayoutModel, parent: string): void {
  const fans = model.links.filter(link => link.attachments!.from.node === parent);
  const stems = fans.map(link => link.sharedRuns!.from![0]!);
  for (const stem of stems) expect(stem).toEqual(stems[0]);
  expect(stems[0]!.from).toEqual(model.nodes[parent]!.ports[0]!.anchor);
  expect(model.junctions.length).toBeGreaterThanOrEqual(1);
  expect(model.junctions[0]!.links).toEqual(fans.map(link => link.id));
  for (const link of fans) expect(link.path!.segments[0]).toMatchObject({ from: stems[0]!.from, to: stems[0]!.to });
}

it('ticket 20: a plain fan from one parent port passes every gate through one reserved shared stem', async () => {
  const model = await run(fixture('parent-two-children'));
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(report.metrics.crossings.count).toBe(0);
  sharedStem(model, 'parent');
  // The first child by x keeps the vertical link; the second fans off the stem.
  const [first, second] = model.links;
  expect(first!.path!.segments.every(s => s.from.x === s.to.x)).toBe(true);
  expect(second!.path!.segments.some(s => s.from.y === s.to.y)).toBe(true);
}, 60000);

it('ticket 20: a one-port transit fan owns lanes in the children\'s order and passes every gate', async () => {
  for (const children of [2, 3]) {
    const yaml = children === 3 ? fixture('transit-fan')
      : fixture('transit-fan').replace('  c3: { group: bottom, ports: [{ name: p, side: top }] }\n', '').replace('  - [a.p#1, c3.p]\n', '');
    const model = await run(yaml);
    const report = score(model).snapshot;
    expect(report.passed, `${children} children`).toBe(true);
    expect(report.metrics.crossings.count).toBe(0);
    sharedStem(model, 'a');
    // Lane x in the transit tier ascends with the children's x: sorted by child, the lanes are ascending.
    const byLink = new Map(model.lanes.map(lane => [lane.owner.kind === 'link' ? lane.owner.id : lane.owner.kind, lane.x]));
    const lanesByChild = model.links.map(link => ({ lane: byLink.get(link.id)!, child: model.nodes[link.attachments!.to.node]!.bounds!.x }))
      .sort((a, b) => a.child - b.child).map(item => item.lane);
    expect(lanesByChild).toEqual([...lanesByChild].sort((a, b) => a - b));
    expect(new Set(lanesByChild).size).toBe(children);
    // Every leaf ends on its lane's x, so the gap to the lane is a straight head-on join.
    for (const link of model.links) expect(link.sharedRuns!.from!.at(-1)!.to.x).toBe(byLink.get(link.id));
  }
}, 120000);

it('ticket 20: stage 7e reserves the depth a plain transit fan needs before its lanes, bundle or not', async () => {
  const model = await run(fixture('transit-fan'));
  expect(model.bundles).toEqual([]);
  const anchor = model.nodes['a']!.ports[0]!.anchor!.y;
  const lanes = model.lanes.filter(lane => lane.tier === 1);
  const stroke = Math.max(...model.links.map(link => link.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path));
  const q = Math.max(17.5, 16 + stroke);
  // Rows for three members and their normal continuation, each row free to move one edge margin.
  const required = 2 * MIN_STEM + q * (model.links.length + 1) + 2 * edgeMargin(routedStrokeWidth(model));
  // Measured to the adjacent tier band's top, the same entry point 7e reserves against.
  const entry = model.tierBands.find(band => band.tier === 1)!.bounds!.y - 10.75;
  expect(entry - anchor).toBeGreaterThanOrEqual(required - 1e-6);
  // The deepest leaf still ends before the lane entry, so the join is a straight head-on gap.
  for (const link of model.links) expect(link.sharedRuns!.from!.at(-1)!.to.y).toBeLessThan(Math.min(...lanes.map(lane => lane.bounds.y)));
}, 60000);

it('ticket 20: a five-child fan into the adjacent tier reserves its depth against that tier band', async () => {
  const yaml = `portograph: 2
groups: {parents: {tier: 0}, children: {tier: 1}}
nodes:
  parent: {group: parents, ports: [{name: p, side: bottom}]}
${[1, 2, 3, 4, 5].map(i => `  c${i}: {group: children, ports: [{name: p, side: top}]}`).join('\n')}
links:
${[1, 2, 3, 4, 5].map(i => `  - [parent.p#1, c${i}.p]`).join('\n')}`;
  const model = await run(yaml);
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  sharedStem(model, 'parent');
  // No link owns a lane, so the next tier band is the boundary: every leaf ends before its entry.
  expect(model.lanes).toEqual([]);
  const band = model.tierBands.find(item => item.tier === 1)!.bounds!;
  for (const link of model.links) expect(link.sharedRuns!.from!.at(-1)!.to.y).toBeLessThan(band.y - 10.75);
}, 60000);

it('ticket 20: a plain-fan tree survives the final-layout round trip and a forged run is rejected', async () => {
  const model = await run(fixture('parent-two-children'));
  const restored = restoreFinalLayout(JSON.stringify(model));
  expect(restored.junctions).toEqual(model.junctions);
  expect(restored.links.map(link => link.sharedRuns)).toEqual(model.links.map(link => link.sharedRuns));
  const forged = JSON.parse(JSON.stringify(model)) as LayoutModel;
  forged.links[1]!.sharedRuns!.from![0]!.to.y += 5;
  expect(() => restoreFinalLayout(JSON.stringify(forged))).toThrow();
  const dropped = JSON.parse(JSON.stringify(model)) as LayoutModel;
  delete dropped.links[1]!.sharedRuns;
  expect(() => restoreFinalLayout(JSON.stringify(dropped))).toThrow();
}, 60000);

it('ticket 41: a tree shared by a bundle member and an outside link peels each at its own row', async () => {
  const yaml = `portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right, order: 0}, {name: r, side: right, order: 1}]}
  b: {group: g, ports: [{name: s, side: left, order: 0}, {name: t, side: left, order: 1}]}
  c: {group: g, ports: [{name: p, side: left, order: 0}]}
links: [[a.p, b.t], [a.r, b.s], [a.r, c.p]]`;
  const model = await run(yaml);
  // The two members share one stem out of a.r and no longer run up the same line (ticket 41).
  expect(score(model).snapshot.gates.G4!.violations).toEqual([]);
  const anchor = model.nodes['a']!.ports.find(p => p.ref.name === 'r')!.anchor!;
  const tree = model.junctions.filter(j => j.port.name === 'r');
  expect(tree).toHaveLength(1);
  expect(tree[0]!.links).toEqual(expect.arrayContaining(['link-2', 'link-3']));
  // Each member turns off the shared normal at a row of its own: 15 px out, then one pitch further.
  const q = fanPitch(model.links);
  const turn = (id: string): number => {
    const path = model.links.find(link => link.id === id)!.path!.segments;
    return path.find(s => s.from.x === s.to.x && s.from.y !== s.to.y)!.from.x - anchor.x;
  };
  expect([turn('link-3'), turn('link-2')]).toEqual([MIN_STEM, MIN_STEM + q]);
  // link-2 reaches its row by keeping the shared normal past the junction point. That extension
  // leaves the point, so it claims the junction like every other branch there; owned by the link it
  // would abut link-3's stem as a zero-clearance pair.
  const extension = model.links.find(link => link.id === 'link-2')!.path!.segments[1]!;
  expect(extension.owner).toEqual({ kind: 'shared-stem', id: tree[0]!.id });
  expect(extension.from).toEqual(tree[0]!.point);
  // G6 still fails here for a reason of its own: a.p's row and c.p's row are 10 px apart, so the
  // links leaving them cannot clear each other whatever the fan does (ticket 42).
  expect(model.nodes['c']!.ports[0]!.anchor!.y - model.nodes['a']!.ports[0]!.anchor!.y).toBe(-10);
}, 60000);

it('ticket 41: a two-member tree peeling to opposite sides takes no row of its own', async () => {
  // Branches that leave the junction point opposite ways never run along one line, so the member
  // left over turns at the point itself. An extra segment here would only cost segment uniformity.
  const model = await run(`portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 0}, gc: {tier: 0}}
nodes:
  a: {group: ga, ports: [{name: q, side: right, order: 0}, {name: p, side: right, order: 1}, {name: r, side: right, order: 2}]}
  b: {group: gb, ports: [{name: top, side: left, order: 0}, {name: mid, side: left, order: 1}, {name: bot, side: left, order: 2}]}
  c: {group: gc, ports: [{name: top, side: left, order: 0}, {name: mid, side: left, order: 1}, {name: bot, side: left, order: 2}]}
links: [[a.p, b.top], [a.p, c.bot]]`);
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(report.metrics.crossings.count).toBe(0);
  const junction = model.junctions.find(j => j.port.name === 'p')!;
  const branch = model.links.find(link => link.id === 'link-2')!.path!.segments[1]!;
  expect(branch.from).toEqual(junction.point);
  expect(branch.owner).toEqual({ kind: 'shared-stem', id: junction.id });
  // It turns at the point: the segment crosses the normal instead of continuing along it.
  expect(branch.from.x).toBe(branch.to.x);
}, 60000);

it('ticket 44: two fans on one node side take separate rows (ADR-0018 rule 1)', async () => {
  // Rows run parallel to the side, so two fans that both start at MIN_STEM draw their peel runs on
  // the same lines. The side allocates them as one sequence instead: the fan nearer the top takes
  // the first rows and the one below it starts beyond them.
  const model = await run(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right, order: 0}, {name: r, side: right, order: 1}]}
  b: {group: g, ports: [{name: s, side: left, order: 0}, {name: t, side: left, order: 1}, {name: u, side: left, order: 2}]}
  c: {group: g, ports: [{name: p, side: left, order: 0}]}
links: [[a.p, b.u], [a.p, b.t], [a.r, b.s], [a.r, c.p]]`);
  expect(score(model).snapshot.passed).toBe(true);
  const ports = model.nodes['a']!.ports;
  const upper = ports.find(port => port.ref.name === 'p')!, lower = ports.find(port => port.ref.name === 'r')!;
  // The upper fan takes no rows before it; the lower one starts beyond the two the upper one took.
  expect(priorSideRows(model, upper)).toBe(0);
  expect(priorSideRows(model, lower)).toBe(2);
  expect(sideRowBudget(model, 'a', 'right')).toBe(4);
  // Every peel run on this side lies on its own line.
  const legs = model.links.flatMap(link => link.path!.segments
    .filter(segment => segment.from.x === segment.to.x && segment.from.x < model.nodes['b']!.bounds!.x)
    .map(segment => segment.from.x));
  expect(new Set(legs).size).toBe(legs.length);
}, 60000);

it('ticket 42: a fan track steps over a sibling port row (ADR-0018 rule 2)', async () => {
  // `a.p` sends its own link out along y = 81.5. The tree at `a.r` used to lay a track 7.5 px from
  // it; the pitch pass now steps over every other row on the side, to the nearer free side so the
  // track is not pushed across a sibling and into the envelope that sibling's bundle reserves.
  const model = await run(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right, order: 0}, {name: r, side: right, order: 1}]}
  b: {group: g, ports: [{name: s, side: left, order: 0}, {name: t, side: left, order: 1}]}
  c: {group: g, ports: [{name: p, side: left, order: 0}]}
links: [[a.p, b.t], [a.r, b.s], [a.r, c.p]]`);
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(report.gates.G6!.violations).toEqual([]);
  // Each member's own track — the first run it draws after leaving the tree — keeps the fan pitch
  // from `a.p`'s row, and the two step to opposite sides of it rather than both pushing outward.
  const q = fanPitch(model.links);
  const row = model.nodes['a']!.ports.find(port => port.ref.name === 'p')!.anchor!.y;
  const track = (id: string): number => model.links.find(link => link.id === id)!.path!.segments
    .find(segment => segment.owner.kind === 'link' && segment.from.y === segment.to.y)!.from.y;
  expect(track('link-3')).toBe(row - q);
  expect(track('link-2')).toBe(row + q);
}, 60000);

it('ticket 37: a pinned row path joins its port\'s fan tree as the straight-through leaf', async () => {
  // Stages 6 and 7b pin a straight path at a port. Until ticket 37 that path stayed outside the
  // tree, so its own first 15 px lay on the tree's root and G4 reported the overlap. The producers
  // now offer their candidates to `treeCohorts`, and the pinned path becomes the straight leaf.
  const model = await run(fixture('pinned-path-joins-its-fan'));
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(report.gates.G4!.violations).toEqual([]);
  const port = model.nodes['hub']!.ports[0]!;
  expect(model.junctions).toHaveLength(1);
  expect(model.junctions[0]!.links).toEqual(['link-1', 'link-2']);
  // Both members leave the anchor on the one reserved root stem, and only then part.
  const stems = model.links.map(link => link.sharedRuns!.from![0]!);
  expect(stems[0]).toEqual(stems[1]);
  expect(stems[0]!.from).toEqual(port.anchor);
  // The pinned path keeps the port's own track; the remainder takes one of its own.
  expect(model.links[0]!.path!.segments.every(segment => segment.from.y === port.anchor!.y)).toBe(true);
  expect(model.links[1]!.sharedRuns!.from!.at(-1)!.to.y).not.toBe(port.anchor!.y);
}, 60000);

it('ticket 45: a fan branch reserves the run it takes, clear of the nodes beside the side (ADR-0018 rule 3)', async () => {
  // The remainder's far port faces up from the tier below, so its anchor stands on its own node's
  // top edge. A branch that turned there ran along that edge — G2 `through-node` — and the router
  // then looped back to enter the port. The branch now turns at that port's outward checkpoint and
  // stops where the port's normal stands, so nothing it takes was discovered during routing.
  const model = await run(fixture('a-fan-branch-reserves-its-descent'));
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  for (const gate of ['G2', 'G3', 'G4', 'G6'] as const) expect(report.gates[gate]!.violations).toEqual([]);
  const target = model.nodes['sub']!, port = target.ports[0]!;
  const branch = model.links[1]!;
  // The reserved run ends on the far port's own x, one router stem short of it, and stage 8 has only
  // that stem left to draw.
  const terminal = branch.sharedRuns!.from!.at(-1)!.to;
  expect(terminal.x).toBe(port.anchor!.x);
  expect(port.anchor!.y - terminal.y).toBe(15);
  expect(branch.path!.segments.at(-1)).toMatchObject({ from: terminal, to: port.anchor });
  // Nothing the fan reserved touches the node it is travelling to.
  for (const run of branch.sharedRuns!.from!) {
    expect(Math.min(run.from.y, run.to.y)).toBeLessThan(target.bounds!.y);
    expect(Math.max(run.from.y, run.to.y)).toBeLessThanOrEqual(target.bounds!.y - 15);
  }
}, 60000);

it('ticket 37: a pinned path between two fans gives each tree its own half of the run', async () => {
  // Both of the path's ports carry a fan, so both trees split the one path, from opposite ends. The
  // row gap reserves the two continuations rather than one of them and the far side's stem; with one
  // stem's room the second split re-owned the stems the first wrote, and the first tree then claimed
  // a run its own member no longer drew.
  const model = await run(fixture('a-pinned-path-between-two-fans'));
  expect(score(model).snapshot.gates.G4!.violations).toEqual([]);
  const pinned = model.links[0]!;
  const roots = ['hub', 'peer'].map(node => model.junctions.find(junction => junction.port.node === node)!);
  expect(roots.every(root => root.links.includes(pinned.id))).toBe(true);
  // Every reserved run of each tree is a stretch the pinned path really draws, under that tree's own
  // name. `to` records its runs outward from its port, so the ends are compared unordered.
  const span = (run: { from: { x: number }; to: { x: number } }): string =>
    `${Math.min(run.from.x, run.to.x)}:${Math.max(run.from.x, run.to.x)}`;
  const name = (owner: Owner): string => 'id' in owner ? owner.id : owner.kind;
  const drawn = pinned.path!.segments.map(segment => `${name(segment.owner)}@${span(segment)}`);
  for (const end of ['from', 'to'] as const) {
    for (const reserved of pinned.sharedRuns![end]!) expect(drawn).toContain(`${name(reserved.owner)}@${span(reserved)}`);
  }
  // The two halves meet in the middle, and no stretch is claimed by both junctions.
  const owners = pinned.path!.segments.map(segment => name(segment.owner));
  expect(new Set(owners).size).toBe(3);
  expect(owners[0]).toBe(roots[0]!.id);
  expect(owners.at(-1)).toBe(roots[1]!.id);
}, 60000);
