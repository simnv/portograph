import { goldenWithRemainders as remaindersText } from '../golden-remainders.js';
import { GROUP_PADDING } from '../../src/layout/regions.js';
import { GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as api from '../../src/internal.js';
import type { LayoutModel, Rect } from '../../src/model/index.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { laneSidesHold, lanes, transitTiers, validateLanes } from '../../src/layout/lanes.js';
import { alignLinkedGroupGrid, bandEntryConflicts, GROUP_GRID_MAX_GROWTH, GROUP_LABEL_GEOMETRY, groupLabelObstacles, type LinkLabelShortfall, produceGroupLabelBands, replanGroupLabels, reserveLinkLabelRoom, routerEntryPoints } from '../../src/layout/bands.js';
import { growTierGaps } from '../../src/layout/gap-room.js';
import { rebuildRegionGeometry } from '../../src/layout/region-rebuild.js';
import { restoreLayoutModel, withLayoutMutation } from '../../src/layout/mutation.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { rows } from '../../src/layout/rows.js';
import { moveGroup, rebuildBands, union, validateSkeletonBands } from '../../src/layout/skeleton-geometry.js';
import { score } from '../../src/score/index.js';
import { FONT_FAMILY, measurePortPill, measureText } from '../../src/text/index.js';
import { orderedGroupIds } from '../../src/model/model.js';
import { generateScaleYaml } from '../../scripts/scale-input.mjs';
import { placed } from './phase-two-fixture.js';

const golden = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
// Q108 (ticket 100) gives the two provider links their chord; the tests of the two remainders read them on the variant that keeps them orthogonal.
const goldenWithRemainders = remaindersText();
/** Stress ticket 05's fixture: one tier gap owes four rows, so 7f's third step really runs. */
const rowsOwed = readFileSync(new URL('../../goldens/synthetic/a-tier-gap-grows-to-its-rows.yaml', import.meta.url), 'utf8');
/** Stress ticket 13's fixture: a tier band whose rightmost group starts 1 624.76 px from its x. */
const bandEdgeResidue = readFileSync(new URL('../../goldens/synthetic/a-band-holds-the-group-that-set-its-edge.yaml', import.meta.url), 'utf8');
/** Stress ticket 19's fixture: the one shape whose label plan answers from the `firstFree` walk. */
const grownLabel = readFileSync(new URL('../../goldens/synthetic/a-grown-label-lands-inside-its-inset.yaml', import.meta.url), 'utf8');
/**
 * Stress ticket 18's fixture: a corridor would follow its child across a labelled row link's split. The claim needs the declared
 * row order, so the sheet is read with `layout: { corridorRowOrder: false }` (architecture-2 ticket 17 turns two rows by default).
 */
const corridorCrossesSplit = readFileSync(new URL('../../goldens/synthetic/a-corridor-crosses-a-labelled-rows-split.yaml', import.meta.url), 'utf8')
  .replace('portograph: 2\n', 'portograph: 2\nlayout: { corridorRowOrder: false }\n');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
/** 12 px visible padding beyond a default top pill and its half stroke. */
const ORDINARY_CLEARANCE = GROUP_PADDING + 12.5;
/** Three transits fan around the single mid-tier group, leaving it no room to widen. */
const enclosedByLanes = `portograph: 2
groups:
  top-group: {tier: 0}
  mid: {tier: 1}
  low: {tier: 2, label: A moderately long label for the lower group}
nodes:
  a: {group: top-group, ports: [{name: p, side: bottom}]}
  m: {group: mid, ports: [{name: p, side: top}]}
  b: {group: low, ports: [{name: p, side: top}, {name: q, side: top}]}
  c: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [a.p, b.q], [a.p, c.p], [a.p, m.p]]`;
/** The same fan, plus a named side port whose pill needs extra right padding. */
const pillPastThePadding = `portograph: 2
groups:
  top-group: {tier: 0}
  mid: {tier: 1}
  low: {tier: 2, label: A moderately long label for the lower group}
nodes:
  a: {group: top-group, ports: [{name: p, side: bottom}]}
  m: {group: mid, ports: [{name: p, side: top}, {name: a-very-long-side-port-name, side: right}]}
  b: {group: low, ports: [{name: p, side: top}, {name: q, side: top}]}
  c: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [a.p, b.q], [a.p, c.p], [a.p, m.p]]`;

async function throughBundles(yaml: string): Promise<LayoutModel> {
  return bundles(bars(centre(flanks(lanes(rows(await placed(yaml)))))));
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < right(b) - 1e-6 && b.x < right(a) - 1e-6 && a.y < bottom(b) - 1e-6 && b.y < bottom(a) - 1e-6;
}

/** Independent expectation: a top-side routed port needs its outward reach plus stroke and tolerance. */
function expectedClearance(model: LayoutModel, groupId: string, side: 'top' | 'bottom' = 'top'): number {
  const members = new Set(model.groups[groupId]!.nodes);
  const reach = Math.max(0, ...routerEntryPoints(model)
    .filter(entry => entry.side === side && members.has(entry.node)).map(entry => entry.outward));
  const padding = Math.max(GROUP_PADDING, ...[...members].flatMap(id => model.nodes[id]!.ports
    .filter(port => port.side === side && port.ref.name !== undefined)
    .map(port => GROUP_PADDING + measurePortPill(port.ref.name!).width / 2 + 0.5)));
  return Math.max(padding, reach + (reach > 0 ? 1 : 0));
}
/** The title takes the horizontal edge with fewer incident link ports; ties keep the top. */
function expectedSide(model: LayoutModel, groupId: string): 'top' | 'bottom' {
  const members = new Set(model.groups[groupId]!.nodes), counts = { top: 0, bottom: 0 };
  for (const link of model.links) for (const ref of [link.attachments!.from, link.attachments!.to]) {
    if (!members.has(ref.node)) continue;
    const side = model.nodes[ref.node]!.ports.find(port => port.ref.name === ref.name && port.ref.ordinal === ref.ordinal)!.side;
    if (side === 'top' || side === 'bottom') counts[side]++;
  }
  return counts.top > counts.bottom ? 'bottom' : 'top';
}

function run(model: LayoutModel): LayoutModel {
  expect('bands' in api).toBe(true);
  return (api as typeof api & { bands: (input: LayoutModel) => LayoutModel }).bands(model);
}

describe('group label bands', () => {
  it('places all six real golden labels in clear measured bands', async () => {
    const before = await throughBundles(goldenWithRemainders), model = run(before);
    const groupIds = Object.keys(model.document.groups);

    expect(model.stage).toBe('bands');
    expect(model.obstacles).toEqual([]);
    expect(model.labelBands.map(band => band.id)).toEqual(groupIds.map(id => `label-band:${id}`));
    expect(model.labels.filter(label => label.role === 'group').map(label => label.id))
      .toEqual(groupIds.map(id => `label:group:${id}`));
    for (const id of groupIds) {
      const group = model.groups[id]!, band = model.labelBands.find(item => item.group === id)!;
      const label = model.labels.find(item => item.id === `label:group:${id}`)!;
      const measured = measureText(model.document.groups[id]!.label, { fontSize: 12, weight: 700 });
      const side = expectedSide(model, id), height = measured.height + 8;
      expect(band).toEqual({ id: `label-band:${id}`, group: id, owner: group.owner, layer: 'routed', side,
        bounds: { x: group.bounds!.x, y: side === 'top' ? group.bounds!.y : bottom(group.bounds!) - height, width: group.bounds!.width, height },
        clearance: expectedClearance(model, id, side) });
      expect(label).toMatchObject({ owner: group.owner, layer: 'routed', role: 'group', text: model.document.groups[id]!.label,
        fontFamily: FONT_FAMILY, fontSize: 12, fontWeight: 700, lineHeight: measured.lineHeight,
        lines: measured.lines, textRotation: 0 });
      expect(label.bounds!.y).toBe(band.bounds.y + 4);
      expect(label.bounds!.x).toBeGreaterThanOrEqual(group.bounds!.x + 8);
      expect(right(label.bounds!)).toBeLessThanOrEqual(right(group.bounds!) - 8 + 1e-6);
      // The nearest node on the band's side sits exactly one clearance away from it.
      const gaps = group.nodes.map(nodeId => side === 'top' ? model.nodes[nodeId]!.bounds!.y - bottom(band.bounds)
        : band.bounds.y - bottom(model.nodes[nodeId]!.bounds!));
      // At least one clearance; the linked-group grid (ticket 24) may have granted the box more.
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(band.clearance - 1e-6);
    }
    // Backbone is fed from above, so its title moves to the bottom edge, where no pill needs room.
    expect(Object.fromEntries(model.labelBands.map(band => [band.group, band.side])))
      .toEqual({ providers: 'top', datacenter: 'top', 'tbr-left': 'top', 'tbr-right': 'top', 'route-reflector': 'top', backbone: 'bottom' });
    // Datacenter keeps a top title with named top pills, so it reserves space beyond the complete pill.
    expect(Object.fromEntries(model.labelBands.map(band => [band.group, band.clearance])))
      .toEqual({ providers: GROUP_PADDING, datacenter: GROUP_PADDING + 15, 'tbr-left': GROUP_PADDING, 'tbr-right': GROUP_PADDING,
        'route-reflector': GROUP_PADDING, backbone: GROUP_PADDING });

    const produced = { ...model, links: model.links.filter(link => link.path !== undefined) };
    const snapshot = score(produced).snapshot;
    expect(produced.links).toHaveLength(24);
    expect(model.links.filter(link => link.path === undefined).map(link => link.id)).toEqual(['link-1', 'link-2']);
    expect(model.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]))
      .toEqual(before.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]));
    expect(model.lanes.some((lane, index) => lane.bounds.y !== before.lanes[index]!.bounds.y)).toBe(true);
    expect(model.barDrops.map(drop => [drop.id, drop.owner, drop.barCross]))
      .toEqual(before.barDrops.map(drop => [drop.id, drop.owner, drop.barCross]));
    expect(model.bundles.map(bundle => [bundle.id, bundle.owner, bundle.members, bundle.mergeRuns?.map(run => run.id)]))
      .toEqual(before.bundles.map(bundle => [bundle.id, bundle.owner, bundle.members, bundle.mergeRuns?.map(run => run.id)]));
    expect(model.links.some((link, index) => link.path && JSON.stringify(link.path) !== JSON.stringify(before.links[index]!.path))).toBe(true);
    // Backbone is fed from above, so its title band is at the bottom, one clearance below the last bar.
    const barBand = model.labelBands.find(item => item.group === 'backbone')!;
    expect(barBand.side).toBe('bottom');
    expect(bottom(model.nodes['EBB-02']!.bounds!)).toBe(barBand.bounds.y - barBand.clearance);
    expect(snapshot.counters.labelHits).toBe(0);
    expect(snapshot.gates.G3.passed).toBe(true);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('keeps every required router entry point outside the stroke-aware label band obstacles', async () => {
    const model = run(await throughBundles(goldenWithRemainders));
    const remainders = model.links.filter(link => !link.path).map(link => link.id);
    expect(remainders).toEqual(['link-1', 'link-2']);

    // The proven conflict: EAC-01/EAC-02 top anchors need a 15 px outward checkpoint.
    const datacenter = model.labelBands.find(band => band.group === 'datacenter')!;
    const entries = routerEntryPoints(model).filter(entry => remainders.includes(entry.link) && entry.side === 'top');
    expect(entries.map(entry => [entry.node, entry.kind, entry.point.y]))
      .toEqual([['EAC-01', 'stem', bottom(datacenter.bounds) + datacenter.clearance - 15], ['EAC-02', 'stem', bottom(datacenter.bounds) + datacenter.clearance - 15]]);
    expect(entries.every(entry => entry.point.y > bottom(datacenter.bounds) + 0.75)).toBe(true);
    expect(bandEntryConflicts(model)).toEqual([]);

    // Publication and restore certify the same reservation, and a route stage cannot relax it.
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(bandEntryConflicts(restored)).toEqual([]);
    const routed = withLayoutMutation(model, 'route', draft => {
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'info', code: 'ROUTE_INFO', message: 'legal' });
    });
    expect(routed.labelBands).toEqual(model.labelBands);
    expect(bandEntryConflicts(routed)).toEqual([]);
  });

  it('widens a blocked group, pushes its neighbour, and recentres the neighbour child through one replay', async () => {
    const yaml = `portograph: 2
groups:
  parents: {tier: 0}
  blocked: {tier: 1, label: A deliberately long reserved group label that cannot fit the initial band}
  neighbour: {tier: 1}
  child-group: {tier: 2}
  sink-group: {tier: 2}
nodes:
  parent: {group: parents, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  blocked-node: {group: blocked, ports: [{name: p, side: top}, {name: q, side: top}, {name: r, side: bottom}, {name: s, side: bottom}]}
  neighbour-node: {group: neighbour, ports: [{name: p, side: bottom}]}
  child: {group: child-group, ports: [{name: p, side: top}]}
  sink: {group: sink-group, ports: [{name: p, side: top}, {name: q, side: top}]}
links:
  - [parent.p, blocked-node.p]
  - [parent.q, blocked-node.q]
  - [neighbour-node.p, child.p, {route: orthogonal}]
  - [blocked-node.r, sink.p, {route: orthogonal}]
  - [blocked-node.s, sink.q, {route: orthogonal}]`;
    // `blocked` feeds `sink` with as many bottom ports as it has top ports, so its title stays on top
    // and the bundle from `parent` still enters beside that title (ADR-0011 tie rule).
    const before = await throughBundles(yaml);
    const blockedWidth = before.groups.blocked!.bounds!.width;
    const neighbourX = before.groups.neighbour!.bounds!.x;
    const childX = before.groups['child-group']!.bounds!.x;
    const laneIdentity = before.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]);
    const bundleIds = before.bundles.map(bundle => bundle.id);
    const model = run(before), label = model.labels.find(item => item.id === 'label:group:blocked')!;

    expect(model.groups.blocked!.bounds!.width).toBeGreaterThan(blockedWidth);
    expect(model.groups.neighbour!.bounds!.x).toBeGreaterThan(neighbourX);
    expect(model.groups['child-group']!.bounds!.x).toBeGreaterThan(childX);
    expect(model.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width])).toEqual(laneIdentity);
    expect(model.bundles.map(bundle => bundle.id)).toEqual(bundleIds);
    expect(model.links.filter(link => link.bundle).every(link => link.path?.segments.length)).toBe(true);
    expect(label.bounds!.x).toBeGreaterThan(model.groups.blocked!.bounds!.x + 8);
    const rightmostBlockingPath = Math.max(...model.links.filter(link => link.bundle)
      .flatMap(link => link.path!.segments).filter(segment => segment.from.x === segment.to.x
        && Math.min(segment.from.y, segment.to.y) <= label.bounds!.y
        && Math.max(segment.from.y, segment.to.y) >= bottom(label.bounds!)).map(segment => segment.from.x));
    expect(label.bounds!.x).toBeCloseTo(rightmostBlockingPath + 0.75 + GROUP_LABEL_LINK_CLEARANCE + 2e-6, 8);
    expect(model.groups.blocked!.bounds!.width).toBeGreaterThan(label.bounds!.width + 16);
    expect(right(label.bounds!)).toBeLessThanOrEqual(right(model.groups.blocked!.bounds!) - 8 + 1e-6);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('treats the reserved shared runs of a pathless remainder as label obstacles', async () => {
    const yaml = `portograph: 2
groups: {ga: {tier: 1, label: A moderately long label for the shared group}, gb: {tier: 0}, gc: {tier: 2}}
nodes:
  a: {group: ga, size: {width: 500, height: 50}, ports: [{name: p, side: top}, {name: q, side: bottom}, {name: r, side: bottom}, {name: s, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  c: {group: gb, ports: [{name: p, side: bottom}]}
  d: {group: gc, ports: [{name: p, side: top}, {name: q, side: top}, {name: r, side: top}]}
links: [[a.p, b.p], [a.p, b.q], [a.p, c.p], [a.q, d.p], [a.r, d.q], [a.s, d.r]]`;
    // Three bottom links keep `ga`'s title on top (tie rule), where the fan from above must clear it.
    const model = run(await throughBundles(yaml));
    const remainder = model.links.find(link => link.id === 'link-3')!;
    const member = model.links.find(link => link.id === 'link-1')!;
    expect(remainder.path).toBeUndefined();
    // Three runs of the fan and the exit that takes the remainder out of its own group (architecture ticket 13).
    expect(remainder.sharedRuns!.from).toHaveLength(4);
    expect(member.path!.segments.slice(0, 3)).toEqual(member.sharedRuns!.from);

    // Every reserved run of the pathless remainder is an obstacle with its own stable ID, while the
    // member's identical copies inside its complete path collapse to the path entries.
    const obstacles = groupLabelObstacles(model);
    expect(obstacles.filter(item => item.id.startsWith('link-3:')).map(item => item.id))
      .toEqual(['link-3:shared:from:0', 'link-3:shared:from:1', 'link-3:shared:from:2', 'link-3:shared:from:3']);
    expect(obstacles.filter(item => item.id.startsWith('link-1:')).map(item => item.id))
      .toEqual(['link-1:path:0', 'link-1:path:1', 'link-1:path:2', 'link-1:path:3']);
    for (const [index, segment] of remainder.sharedRuns!.from!.entries()) {
      expect(obstacles.find(item => item.id === `link-3:shared:from:${index}`)!.bounds).toEqual({
        x: Math.min(segment.from.x, segment.to.x) - 0.75, y: Math.min(segment.from.y, segment.to.y) - 0.75,
        width: Math.abs(segment.to.x - segment.from.x) + 1.5, height: Math.abs(segment.to.y - segment.from.y) + 1.5 });
    }
    const label = model.labels.find(item => item.id === 'label:group:ga')!;
    for (const item of obstacles) expect([item.id, overlaps(label.bounds!, item.bounds)]).toEqual([item.id, false]);

    // The three-link fan reaches 67.5 px outward, so the band reserves that plus stroke and tolerance.
    // Before the band existed, the fan's second row sat on ga's edge and moved out by the 10 px edge
    // margin (ADR-0013); the initial reservation was measured against that longer fan, so the node
    // keeps those 10 px beyond the final clearance rather than moving back up.
    const band = model.labelBands.find(item => item.group === 'ga')!;
    expect(band.clearance).toBe(68.5);
    expect(model.nodes.a!.bounds!.y).toBeGreaterThanOrEqual(bottom(band.bounds) + 68.5);
    expect(model.nodes.a!.bounds!.y).toBeLessThanOrEqual(bottom(band.bounds) + 68.5 + GROUP_EDGE_LINK_CLEARANCE + 0.75 + 1e-6);
    expect(bandEntryConflicts(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);

    // A forged smaller reservation, even one consistent with the frozen projection, is rejected.
    const shrunk = copy(model);
    for (const bands of [shrunk.labelBands, shrunk.freeze!.placement!.labelBands]) {
      bands.find(item => item.group === 'ga')!.clearance = 12;
    }
    expect(() => restoreLayoutModel(JSON.stringify(shrunk)))
      .toThrow(/Group label bands contradict final group geometry/);

    // The reservation cannot be retired by dropping the runs it was derived from.
    const dropped = copy(model);
    delete dropped.links.find(link => link.id === 'link-3')!.sharedRuns;
    dropped.freeze!.placement!.sharedRuns = dropped.freeze!.placement!.sharedRuns.filter(item => item.link !== 'link-3');
    expect(() => restoreLayoutModel(JSON.stringify(dropped))).toThrow(/Shared runs contradict port incidence/);

    // Deduplication keys ownership by its semantic fields, not by JSON property order.
    const reordered = copy(model);
    for (const link of reordered.links) for (const end of ['from', 'to'] as const) {
      for (const segment of link.sharedRuns?.[end] ?? []) {
        const owner = segment.owner;
        if (owner.kind !== 'barCross') segment.owner = { id: owner.id, kind: owner.kind };
      }
    }
    expect(restoreLayoutModel(JSON.stringify(reordered))).toEqual(model);
    expect(groupLabelObstacles(reordered).map(item => item.id)).toEqual(obstacles.map(item => item.id));
  });

  it('lengthens the reserved checkpoint when a wide node stroke expands its routing obstacle', async () => {
    const yaml = `portograph: 2
groups: {up: {tier: 0}, low: {tier: 1, label: Lower}, lower: {tier: 2}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: low, ports: [{name: p, side: top}, {name: q, side: bottom}]}
  c: {group: lower, ports: [{name: p, side: top}]}
links: [[a.p, b.p], [b.q, c.p]]`;
    // The bottom link keeps `low`'s title on top (tie rule), above the wide-stroke top port.
    const draft = copy(await placed(yaml));
    draft.nodes.b!.strokeWidth = 44;
    rebuildBands(draft);
    rebuildNodeGeometry(draft, Object.keys(draft.nodes), 'current');
    draft.canvas = union([draft.canvas!, ...Object.values(draft.groups).map(group => group.bounds!)]);
    const model = run(bundles(bars(centre(flanks(lanes(rows(restoreLayoutModel(JSON.stringify(draft)))))))));

    // A 44 px node stroke needs a 33 px checkpoint, beyond the stem and the 20 px pill padding.
    const band = model.labelBands.find(item => item.group === 'low')!;
    expect(band.clearance).toBe(34);
    expect(model.labelBands.find(item => item.group === 'up')!.clearance).toBe(GROUP_PADDING);
    expect(model.nodes.b!.bounds!.y).toBe(bottom(band.bounds) + 34);
    const stem = routerEntryPoints(model).find(entry => entry.node === 'b' && entry.kind === 'stem')!;
    expect(stem.outward).toBe(33);
    expect(stem.point.y).toBe(bottom(band.bounds) + 1);
    expect(bandEntryConflicts(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);

    // The ordinary pill padding is too short here and must not survive restore.
    const short = copy(model);
    for (const bands of [short.labelBands, short.freeze!.placement!.labelBands]) {
      bands.find(item => item.group === 'low')!.clearance = ORDINARY_CLEARANCE;
    }
    expect(() => restoreLayoutModel(JSON.stringify(short)))
      .toThrow(/Group label bands contradict final group geometry/);
  });

  it('widens every group fed from above in the initial reservation without spending a growth pass', async () => {
    const pairs = [0, 1, 2, 3, 4];
    const yaml = `portograph: 2
groups:
${pairs.map(i => `  parents-${i}: {tier: 0}\n  blocked-${i}: {tier: 1, label: A deliberately long reserved group label ${i} that cannot fit the initial band}`).join('\n')}
nodes:
${pairs.map(i => `  parent-${i}: {group: parents-${i}, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}\n  child-${i}: {group: blocked-${i}, ports: [{name: p, side: top}, {name: q, side: top}]}`).join('\n')}
links:
${pairs.flatMap(i => [`  - [parent-${i}.p, child-${i}.p]`, `  - [parent-${i}.q, child-${i}.q]`]).join('\n')}`;
    const before = await throughBundles(yaml);
    expect(before.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(0);
    const model = run(before);

    // Every blocked group is fed from above, so its title takes the bottom edge (ADR-0011): the
    // long label meets no link there, the initial reservation widens each group to the label in one
    // pass, and no collision-growth replay spends the shared budget. The tied-title collision path is
    // covered by the widening test above; budget exhaustion by the lane-blocked test below.
    for (const i of pairs) {
      const group = model.groups[`blocked-${i}`]!, label = model.labels.find(item => item.id === `label:group:blocked-${i}`)!;
      expect(model.labelBands.find(item => item.group === `blocked-${i}`)!.side).toBe('bottom');
      expect(group.bounds!.width).toBeCloseTo(label.bounds!.width + 16, 9);
      expect(label.bounds!.x).toBe(group.bounds!.x + 8);
      expect(groupLabelObstacles(model).some(item => overlaps(label.bounds!, item.bounds))).toBe(false);
    }
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toEqual([]);

    // The diagnosed state still carries one coherent claim set and survives restore.
    expect(model.labelBands.map(band => band.group)).toEqual(Object.keys(model.document.groups));
    expect(model.labels.filter(item => item.role === 'group')).toHaveLength(pairs.length * 2);
    for (const band of model.labelBands) {
      // Parents keep top titles above portless tops; blocked groups carry bottom titles below plain bottoms.
      expect(band.side).toBe(band.group.startsWith('blocked') ? 'bottom' : 'top');
      expect(band.clearance).toBe(GROUP_PADDING);
      for (const nodeId of model.groups[band.group]!.nodes) {
        const box = model.nodes[nodeId]!.bounds!;
        if (band.side === 'top') expect(box.y).toBeGreaterThanOrEqual(bottom(band.bounds) + band.clearance - 1e-6);
        else expect(bottom(box)).toBeLessThanOrEqual(band.bounds.y - band.clearance + 1e-6);
      }
    }
    expect(model.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]))
      .toEqual(before.lanes.map(lane => [lane.id, lane.owner, lane.x, lane.bounds.width]));
    expect(model.bundles.map(bundle => bundle.id)).toEqual(before.bundles.map(bundle => bundle.id));
    expect(bandEntryConflicts(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('refuses a label widening that would push a group across an immutable transit lane', async () => {
    const before = await throughBundles(enclosedByLanes);
    const laneIdentity = before.lanes.map(lane => [lane.id, lane.owner, lane.group, lane.side, lane.x, lane.bounds.width]);
    const midBox = { ...before.groups.mid!.bounds! }, lowWidth = before.groups.low!.bounds!.width;
    // link-3 is the only non-bundle transit; its lane aligns toward c in the anchor tier (ticket 19).
    expect(before.lanes.map(lane => [lane.id, lane.side])).toEqual([['lane:"link-1":1', 'left'],
      ['lane:"link-2":1', 'right'], ['lane:"link-3":1', 'right']]);

    const model = run(before);
    expect(model.lanes.map(lane => [lane.id, lane.owner, lane.group, lane.side, lane.x, lane.bounds.width]))
      .toEqual(laneIdentity);

    // Feasibility evidence: the two nearest reserved corridors touch mid's own edges, so the only
    // widening that would reach the first free gap crosses the corridor mid's right lane owns.
    const leftLane = model.lanes.find(item => item.id === 'lane:"link-1":1')!;
    const rightLane = model.lanes.find(item => item.id === 'lane:"link-2":1')!;
    const mid = model.groups.mid!;
    expect(right(leftLane.bounds)).toBe(mid.bounds!.x);
    expect(rightLane.bounds.x).toBe(right(mid.bounds!));
    expect([mid.bounds!.x, mid.bounds!.width]).toEqual([midBox.x, midBox.width]);

    // The retained label is the ordinary left-first start. Its width was never the obstruction.
    const label = model.labels.find(item => item.id === 'label:group:mid')!;
    expect(label.bounds!.x).toBe(mid.bounds!.x + 8);
    expect(right(label.bounds!)).toBeLessThanOrEqual(right(mid.bounds!) - 8 + 1e-6);
    expect(groupLabelObstacles(model).some(item => overlaps(label.bounds!, item.bounds))).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'GROUP_LABEL_GAP_INFEASIBLE')).toEqual([{
      stage: 'placement', severity: 'warning', code: 'GROUP_LABEL_GAP_INFEASIBLE',
      message: 'Group mid has no free label gap between the reserved lanes of its tier; final gates decide the retained geometry.',
      owners: [{ kind: 'group', id: 'mid' }],
    }]);
    // The refusal costs no centring pass: a budget-exhaustion diagnosis would be a different defect.
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(0);

    // `low` is fed from above, so its title moved to the bottom edge (ADR-0011): nothing collides
    // there, the label centres, and the group needs no widening at all.
    expect(model.lanes.some(lane => lane.tier === model.groups.low!.tier)).toBe(false);
    const lowBand = model.labelBands.find(item => item.group === 'low')!, lowLabel = model.labels.find(item => item.id === 'label:group:low')!;
    expect(lowBand.side).toBe('bottom');
    // Its box only changed through the linked-group grid: it shares the x-extent of top-group, which
    // feeds it through the lanes (ticket 24); the label centres in that shared box.
    const lowBox = model.groups.low!.bounds!, topBox = model.groups['top-group']!.bounds!;
    expect(lowBox.width).toBeGreaterThanOrEqual(lowWidth);
    expect([lowBox.x, lowBox.width]).toEqual([topBox.x, topBox.width]);
    expect(lowLabel.bounds!.x).toBeCloseTo(lowBox.x + (lowBox.width - lowLabel.bounds!.width) / 2, 9);
    expect(model.diagnostics.filter(item => item.code === 'GROUP_LABEL_GAP_INFEASIBLE').map(item => item.owners)).toEqual([[{ kind: 'group', id: 'mid' }]]);

    // The stroke-aware reservation and the mandatory shared prefix both survive the refusal.
    const band = model.labelBands.find(item => item.group === 'mid')!;
    // `mid` is fed from above, so its band is the bottom edge with the plain bottom padding below m.
    expect(band.side).toBe('bottom');
    expect(band.bounds).toEqual({ x: mid.bounds!.x, y: bottom(mid.bounds!) - 22, width: mid.bounds!.width, height: 22 });
    expect(band.clearance).toBe(GROUP_PADDING);
    expect(bottom(model.nodes.m!.bounds!)).toBe(band.bounds.y - GROUP_PADDING);
    const member = model.links.find(link => link.id === 'link-1')!;
    expect(member.sharedRuns!.from!.length).toBeGreaterThan(0);
    expect(member.path!.segments.slice(0, member.sharedRuns!.from!.length)).toEqual(member.sharedRuns!.from);
    expect(bandEntryConflicts(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('still rejects a group that has been widened across its own reserved lane', async () => {
    const model = run(await throughBundles(enclosedByLanes));
    const lane = model.lanes.find(item => item.id === 'lane:"link-2":1')!;
    expect(() => validateLanes(copy(model))).not.toThrow();

    const crossed = copy(model);
    crossed.groups.mid!.bounds!.width = lane.x - crossed.groups.mid!.bounds!.x;
    expect(() => validateLanes(crossed)).toThrow(/Lane side contradicts its group/);

    // One pixel into the reserved corridor is still rejected, by the crossing rule.
    const touching = copy(model);
    touching.groups.mid!.bounds!.width = lane.bounds.x + 1 - touching.groups.mid!.bounds!.x;
    expect(() => validateLanes(touching)).toThrow(/Lane lane:"link-2":1 crosses occupied group mid/);

    expect(() => withLayoutMutation(model, 'route', draft => { draft.groups.mid!.bounds!.width += 20; }))
      .toThrow(/cannot change placement/);
  });

  it('measures widening feasibility from the occupied box a lane was reserved against', async () => {
    const before = await throughBundles(pillPastThePadding);
    const mid = before.groups.mid!, lane = before.lanes.find(item => item.id === 'lane:"link-2":1')!;
    const pill = before.nodes.m!.ports.find(port => port.side === 'right')!.pill!;
    const box = mid.bounds!;

    // Normal output includes the complete pill; lane guards must also inspect overhanging
    // geometry in a proposed group box, rather than trusting its container alone.
    expect(right(box) - right(pill.bounds)).toBeGreaterThanOrEqual(12);
    const exposed = copy(before);
    exposed.groups.mid!.bounds!.width = right(pill.bounds) - box.x - 5;
    const exposedBox = exposed.groups.mid!.bounds!;
    expect(lane.bounds.x).toBeGreaterThan(right(exposedBox) + 1e-6);

    // A widening leaves that pill where it is, so it may reach the corridor edge; a translation
    // carries the pill with it and may not. Reading the padded box alone confuses the two.
    const widened = { ...box, width: lane.bounds.x - box.x };
    expect(laneSidesHold(exposed, [{ group: exposed.groups.mid!, bounds: widened }])).toBe(true);
    expect(laneSidesHold(exposed, [{ group: exposed.groups.mid!, bounds: { ...widened, width: widened.width + 1 } }])).toBe(false);
    expect(laneSidesHold(exposed, [{ group: exposed.groups.mid!, bounds: { ...exposedBox, x: exposedBox.x + lane.bounds.x - right(pill.bounds) + 1 } }])).toBe(false);
    const crossed = copy(before);
    crossed.groups.mid!.bounds!.width = widened.width + 1;
    expect(() => validateLanes(crossed)).toThrow(/Lane lane:"link-2":1 crosses occupied group mid/);

    const model = run(before);
    expect(model.groups.mid!.bounds!.width).toBe(mid.bounds!.width);
    expect(model.lanes.map(item => [item.id, item.owner, item.group, item.side, item.x, item.bounds.width]))
      .toEqual(before.lanes.map(item => [item.id, item.owner, item.group, item.side, item.x, item.bounds.width]));
    expect(model.labels.find(item => item.id === 'label:group:mid')!.bounds!.x).toBe(model.groups.mid!.bounds!.x + 8);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('measures each consecutive initial reservation against the pills the previous push moved', async () => {
    // Three tier-1 groups left of one corridor. Two of them reserve their label width in turn, and
    // both pushes land on `third`, whose box includes its complete named pill.
    const yaml = `portograph: 2
groups:
  top: {tier: 0}
  first: {tier: 1, label: WWWWWWWW}
  second: {tier: 1, label: WWWWWWWW}
  third: {tier: 1}
  low: {tier: 2}
nodes:
  a: {group: top, ports: [{name: p, side: bottom}]}
  f: {group: first}
  s: {group: second}
  t: {group: third, ports: [{name: long-right-port, side: right}]}
  z: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, z.p]]`;
    // A checked rows transaction places the three groups; every later stage runs normally.
    const rowed = withLayoutMutation(await placed(yaml), 'rows', draft => {
      // With 20 px padding a 50 px node makes a 90 px group, so an eight-W label (90.609375 px) needs a
      // 16.609375 px widening. Groups keep the 60 px band gap, and the corridor sits where exactly one
      // such widening fits.
      for (const [id, x] of Object.entries({ top: 413.5, first: 0, second: 150, third: 300, low: 413.5 })) {
        moveGroup(draft, draft.groups[id]!, x - draft.groups[id]!.bounds!.x, 0);
      }
    });
    const before = bundles(bars(centre(flanks(lanes(rowed)))));

    const lane = before.lanes.find(item => item.id === 'lane:"link-1":1')!;
    const pill = before.nodes.t!.ports[0]!.pill!;
    expect(lane.side).toBe('right');
    expect([pill.bounds.x, right(pill.bounds)]).toEqual([338.5, 401.5]);
    // The headroom allows one 16.609375 px reservation, but not two.
    expect(lane.bounds.x - right(before.groups.third!.bounds!)).toBeGreaterThan(16.609375);
    expect(lane.bounds.x - right(before.groups.third!.bounds!)).toBeLessThan(33.21875);

    const model = run(before);
    expect(model.groups.first!.bounds!.width).toBeGreaterThan(before.groups.first!.bounds!.width);
    expect(model.groups.second!.bounds!.width).toBe(before.groups.second!.bounds!.width);
    expect(right(model.nodes.t!.ports[0]!.pill!.bounds) + 1.25).toBeLessThanOrEqual(lane.bounds.x + 1e-6);
    expect(model.lanes.map(item => [item.id, item.owner, item.group, item.side, item.x, item.bounds.width]))
      .toEqual(before.lanes.map(item => [item.id, item.owner, item.group, item.side, item.x, item.bounds.width]));
    expect(model.diagnostics.filter(item => item.code === 'GROUP_LABEL_GAP_INFEASIBLE')
      .map(item => item.owners)).toEqual([[{ kind: 'group', id: 'second' }]]);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('diagnoses every lane-blocked group even when the shared budget is exhausted first', async () => {
    const pairs = [0, 1, 2, 3, 4];
    const yaml = `portograph: 2
groups:
${pairs.map(i => `  parents-${i}: {tier: 0}\n  blocked-${i}: {tier: 1, label: A deliberately long reserved group label ${i} that cannot fit the initial band}`).join('\n')}
  top-group: {tier: 2}
  mid: {tier: 3}
  low: {tier: 4, label: A moderately long label for the lower group}
nodes:
${pairs.map(i => `  parent-${i}: {group: parents-${i}, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}\n  child-${i}: {group: blocked-${i}, ports: [{name: p, side: top}, {name: q, side: top}]}`).join('\n')}
  a: {group: top-group, ports: [{name: p, side: bottom}]}
  m: {group: mid, ports: [{name: p, side: top}]}
  b: {group: low, ports: [{name: p, side: top}, {name: q, side: top}]}
  c: {group: low, ports: [{name: p, side: top}]}
links:
${pairs.flatMap(i => [`  - [parent-${i}.p, child-${i}.p]`, `  - [parent-${i}.q, child-${i}.q]`]).join('\n')}
  - [a.p, b.p]
  - [a.p, b.q]
  - [a.p, c.p]
  - [a.p, m.p]`;
    const model = run(await throughBundles(yaml));

    // The budget runs out on the five repairable pairs, but `mid` is boxed in by its tier's
    // corridors: no budget could have repaired it, so it is still classified.
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(1);
    expect(model.diagnostics.filter(item => item.code === 'GROUP_LABEL_GAP_INFEASIBLE')
      .map(item => item.owners)).toEqual([[{ kind: 'group', id: 'mid' }]]);
    const mid = model.groups.mid!;
    expect(model.labels.find(item => item.id === 'label:group:mid')!.bounds!.x).toBe(mid.bounds!.x + 8);
    for (const lane of model.lanes.filter(item => item.tier === mid.tier)) {
      expect(lane.side === 'left' ? lane.x < mid.bounds!.x : lane.x > right(mid.bounds!)).toBe(true);
    }
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('bounds label growth for node-free input even when centring has no anchor tier', async () => {
    const model = run(await throughBundles(`portograph: 2
groups: {empty: {tier: 0, label: A node-free group label wider than its initial group}}
nodes: {}
links: []`));
    const label = model.labels.find(item => item.role === 'group')!;
    expect(model.groups.empty!.bounds!.width).toBeGreaterThanOrEqual(label.bounds!.width + 16);
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE')).toHaveLength(0);
  });

  it('rejects stale or forged group claims on restore and freezes placement before route output', async () => {
    const model = run(await throughBundles(`portograph: 2
groups: {g: {tier: 0, label: Group}}
nodes: {a: {group: g}}
links: []`));
    for (const corrupt of [
      (draft: LayoutModel) => { draft.labelBands[0]!.bounds.width++; },
      (draft: LayoutModel) => { draft.labels.find(label => label.role === 'group')!.bounds!.x++; },
      (draft: LayoutModel) => { draft.labels.find(label => label.role === 'group')!.fontWeight = 400; },
      (draft: LayoutModel) => { draft.labelBands.push(copy(draft.labelBands[0]!)); },
      (draft: LayoutModel) => {
        for (const bands of [draft.labelBands, draft.freeze!.placement!.labelBands]) bands[0]!.clearance = 8;
      },
    ]) {
      const draft = copy(model); corrupt(draft);
      expect(() => restoreLayoutModel(JSON.stringify(draft))).toThrow();
    }

    const routed = withLayoutMutation(model, 'route', draft => {
      draft.runtime.totalMs = 12;
      draft.diagnostics.push({ stage: 'final-geometry', severity: 'info', code: 'ROUTE_INFO', message: 'legal' });
    });
    expect(routed.runtime.totalMs).toBe(12);
    expect(() => withLayoutMutation(model, 'route', draft => { draft.groups.g!.bounds!.x++; })).toThrow(/cannot change placement/);
  });

  it('rejects callback-authored group claims instead of replacing them silently', async () => {
    const before = await throughBundles(`portograph: 2
groups: {g: {tier: 0, label: Group}}
nodes: {a: {group: g}}
links: []`);
    expect(() => withLayoutMutation(before, 'bands', draft => {
      draft.labelBands.push({ id: 'forged', group: 'g', owner: draft.groups.g!.owner,
        layer: 'routed', side: 'top', bounds: { ...draft.groups.g!.bounds! }, clearance: 12 });
    })).toThrow(/claim validator/);
    expect(before.labelBands).toEqual([]);
    const legal = withLayoutMutation(before, 'bands', draft => {
      draft.runtime.totalMs = 4;
      draft.diagnostics.push({ stage: 'placement', severity: 'info', code: 'BANDS_INFO', message: 'legal' });
    });
    expect(legal.runtime.totalMs).toBe(4);
    expect(legal.diagnostics.some(item => item.code === 'BANDS_INFO')).toBe(true);
  });

  it('restores structurally equal claims regardless of JSON object key order', async () => {
    const model = run(await throughBundles(`portograph: 2
groups: {g: {tier: 0, label: Group}}
nodes: {a: {group: g}}
links: []`));
    const draft = copy(model), band = draft.labelBands[0]!, label = draft.labels.find(item => item.role === 'group')!;
    draft.labelBands[0] = { clearance: band.clearance, side: band.side, layer: band.layer, bounds: { height: band.bounds.height,
      width: band.bounds.width, y: band.bounds.y, x: band.bounds.x }, owner: band.owner, group: band.group, id: band.id };
    const index = draft.labels.indexOf(label);
    draft.labels[index] = { bounds: label.bounds!, textRotation: label.textRotation!, lines: label.lines!,
      lineHeight: label.lineHeight!, fontWeight: label.fontWeight!, fontSize: label.fontSize!,
      fontFamily: label.fontFamily!, text: label.text, role: label.role!, layer: label.layer,
      owner: label.owner, id: label.id };
    expect(() => restoreLayoutModel(JSON.stringify(draft))).not.toThrow();
  });
});

describe('derived containing-box tolerance', () => {
  const yaml = `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1, shape: bar}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom}]}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], [b.q, a.p]]`;

  it('keeps exact adjacent-tier bounds when lane allocation only adds its region', async () => {
    const before = rows(await placed(yaml)), after = lanes(before);
    expect(after.stage).toBe('lanes');
    expect(after.links.every(link => transitTiers(after, link).length === 0)).toBe(true);
    expect(after.lanes).toEqual([]);
    expect(after.links.every(link => link.fixedSegments === undefined)).toBe(true);
    // The lane stage refits a group from its bodies, and the rows rule fitted it by another sum: a box may differ by one unit of the last place (the fit does not
    // keep a width a bar's own label floor made), which the placement tolerance (`PLACEMENT_EPS`) is for. Nothing may move by more.
    for (const id of Object.keys(before.groups)) for (const key of ['x', 'y', 'width', 'height'] as const) expect(after.groups[id]!.bounds![key], `${id}.${key}`).toBeCloseTo(before.groups[id]!.bounds![key], 9);
    expect(Object.fromEntries(Object.entries(after.nodes).map(([id, node]) => [id, node.bounds])))
      .toEqual(Object.fromEntries(Object.entries(before.nodes).map(([id, node]) => [id, node.bounds])));
    expect(after.regions.map(region => region.id)).toContain('tiers:0:1');
  });

  it('still rejects a one-pixel lane-stage translation on a tier with no transit', async () => {
    const before = rows(await placed(yaml));
    expect(() => withLayoutMutation(before, 'lanes', draft => {
      draft.groups.gb!.bounds!.x += 1;
      draft.nodes.b!.bounds!.x += 1;
      for (const port of draft.nodes.b!.ports) port.anchor!.x += 1;
    })).toThrow(/Lanes may expand only occupied intermediate tiers/);
  });
});

it('reserves a group label band once, however often 7f places its labels', async () => {
  // Stress ticket 06. 7f places its group labels, measures the tier gaps and places them again.
  // `reserveInitialSpace` measured the band against the ordinary padding instead of against the
  // room the group already holds, so a repeated call reserved the whole band a second time: every
  // node moved down by it and every box grew by it, without bound.
  for (const source of [golden, enclosedByLanes]) {
    const model = copy(await throughBundles(source));
    const vertical = (): string => JSON.stringify([
      Object.entries(model.groups).map(([id, group]) => [id, group.bounds!.y, group.bounds!.height]),
      Object.entries(model.nodes).map(([id, node]) => [id, node.bounds!.y, node.ports.map(port => port.anchor!.y)]),
      model.labelBands.map(band => [band.group, band.side, band.bounds.y, band.bounds.height, band.clearance]),
    ]);
    produceGroupLabelBands(model);
    const once = vertical();
    produceGroupLabelBands(model);
    expect(vertical()).toEqual(once);
    produceGroupLabelBands(model);
    expect(vertical()).toEqual(once);
  }
}, 120000);

it('plans a group label again where the tier gap room moved its band, and reserves nothing', async () => {
  // The third step of 7f plans and does not reserve: the measurement that grew the gaps was taken
  // against the reservation the first step made, so nothing it moved may move again. A model that
  // owes no row never reaches the step, so this one owes four (stress ticket 05's fixture).
  const model = copy(await throughBundles(rowsOwed));
  produceGroupLabelBands(model);
  const bandY = new Map(model.labelBands.map(band => [band.group, band.bounds.y]));
  const labelY = new Map(model.labels.filter(label => label.role === 'group').map(label => [label.id, label.bounds!.y]));

  expect(growTierGaps(model)).toBe(true);
  // Exactly what 7f does between the two. The replay may move a group horizontally; this fixture's
  // does not, so the move is made here as well — a carried label keeps the x of the box it left.
  rebuildRegionGeometry(model, undefined, undefined, true);
  const shifted = model.groups[orderedGroupIds(model.document)[0]!]!;
  moveGroup(model, shifted, 40, 0);
  rebuildNodeGeometry(model, shifted.nodes, 'current');
  const carried = new Map(model.labels.filter(label => label.role === 'group').map(label => [label.id, { ...label.bounds! }]));
  replanGroupLabels(model);

  // At least one band really moved, or the step would be trivially satisfied.
  expect(model.labelBands.some(band => Math.abs(band.bounds.y - bandY.get(band.group)!) > 1e-6)).toBe(true);
  const labels = model.labels.filter(label => label.role === 'group');
  expect(labels.length).toBe(model.labelBands.length);
  expect(labels.some(label => Math.abs(label.bounds!.y - labelY.get(label.id)!) > 1e-6)).toBe(true);
  // Every label sits its own inset inside the band the move left it in, and inside its group's box.
  for (const label of labels) {
    const group = label.id.slice('label:group:'.length);
    const band = model.labelBands.find(item => item.group === group)!;
    expect(label.bounds!.y).toBeCloseTo(band.bounds.y + GROUP_LABEL_GEOMETRY.verticalInset, 9);
    expect(label.bounds!.x).toBeGreaterThanOrEqual(model.groups[group]!.bounds!.x + GROUP_LABEL_GEOMETRY.horizontalInset - 1e-6);
    expect(right(label.bounds!)).toBeLessThanOrEqual(right(model.groups[group]!.bounds!) - GROUP_LABEL_GEOMETRY.horizontalInset + 1e-6);
  }

  // The label of the moved group was left behind by the move and is planned again inside its box;
  // every other label is where it was, because the replan reserves nothing and moves nothing else.
  const movedLabel = `label:group:${shifted.id}`;
  expect(model.labels.find(label => label.id === movedLabel)!.bounds!.x)
    .not.toBeCloseTo(carried.get(movedLabel)!.x, 9);
  for (const label of labels) {
    if (label.id === movedLabel) continue;
    expect(label.bounds!.x).toBeCloseTo(carried.get(label.id)!.x, 9);
  }

  // And the step is a fixed point: a second one reserves nothing and moves nothing.
  const shape = (): string => JSON.stringify([
    Object.entries(model.groups).map(([id, group]) => [id, group.bounds]),
    Object.entries(model.nodes).map(([id, node]) => [id, node.bounds, node.ports.map(port => port.anchor)]),
    model.labelBands, model.labels.filter(label => label.role === 'group'),
  ]);
  const settled = shape();
  replanGroupLabels(model);
  expect(shape()).toEqual(settled);
}, 120000);

it('settles the linked-group grid again after the tier gap room replay', async () => {
  // Stress ticket 06. The growth replay refits every group box to its content, so a pair of linked
  // groups that shared one x-extent (ADR-0012) holds two extents again. 7f's third step plans and
  // reserves nothing, so it cannot close that itself and the replay settles the grid. Without it
  // this fan fails publication on `Linked groups do not share the grid their links require`, and so
  // does the 40-node one of `bundle-scale`, where the refit leaves `access` at 1975 px beside the
  // 1976.81 of `hubs` and `sinks` at 2730.5 beside the 2731.80 of `sources`. Twenty-four nodes is
  // the smallest fan of this generator that shows it.
  const model = run(await throughBundles(generateScaleYaml({ nodes: 24, multiplicity: 3 }).yaml));
  // The published model is the grid's own fixed point, and every linked pair really shares an
  // extent: an empty pair list would satisfy the first expectation by itself.
  expect(alignLinkedGroupGrid(copy(model))).toBe(false);
  const width = (id: string): number => model.groups[id]!.bounds!.width;
  expect(width('access')).toBeCloseTo(width('hubs'), 9);
  // Ticket 29: `sources` is no longer widened across the tier to seat its feeds, so it and `sinks`
  // are too far apart in width for one extent — the grid declines them by its own
  // `GROUP_GRID_MAX_GROWTH` rather than inflating the smaller box to the larger (ADR-0012). That
  // is the rule holding, which is what this test is about; before the allowance both boxes were
  // widened past 2 730 px and the union cost nothing.
  const box = (id: string) => model.groups[id]!.bounds!;
  const extent = Math.max(right(box('sinks')), right(box('sources'))) - Math.min(box('sinks').x, box('sources').x);
  expect((extent - Math.min(width('sinks'), width('sources'))) / extent).toBeGreaterThan(GROUP_GRID_MAX_GROWTH);
}, 120000);

it('holds the group that set a band edge exactly after the growth replay', async () => {
  // Stress ticket 13. A band kept `x` and `width = max(right) - x`; reading its right edge back as
  // `x + width` loses up to one ULP, so the group that set that edge was reported outside the band
  // it is part of. Ticket 13 answered in the predicate: `contains` here is now the tolerant
  // comparator the published gates already used, and the last expectation is that invariant.
  //
  // Stress ticket 14 removed the residue at the producer: `union` no longer emits a width whose
  // right edge falls short of the edge it was built from, so the residue is zero or negative by
  // design. Ticket 25 then grows this fixture's last tier gap, and the growth replay refits every
  // box, so the coordinates that once carried the ULP residue no longer stand (none of two dozen
  // variants of the input carries it after the replay). This test therefore pins the outcome, not
  // the artifact: the band the producer emits contains its own rightmost group exactly, with no
  // tolerance spent. The tolerance itself is pinned by the next test.
  const model = run(await throughBundles(bandEdgeResidue));
  const band = model.tierBands.find(tier => tier.tier === 3)!;
  const group = model.groups['edge-far']!.bounds!, box = band.bounds!;
  const residue = right(group) - right(box);
  expect(residue).toBeLessThanOrEqual(0);
  expect(residue).toBeGreaterThan(-1e-9);
  expect(validateSkeletonBands(model)).toEqual([]);
}, 120000);

it('keeps the tolerance on the band comparators that the producer repair no longer exercises', () => {
  // Stress ticket 13 put `EPS` on `contains` and `overlaps` here; stress ticket 14 then removed the
  // residue at the producer, so the fixture above passes with exact comparators too and the
  // tolerance became unguarded — a later edit could delete it and the suite would stay green. Five
  // group-box producers still recover a width from an absolute edge (`fitRegionGroup`,
  // `fitGroupBox`, `bars`, `rebuildBoxes`, and the region boxes), so the tolerance is still the
  // contract and this is its own guard, stated directly rather than through a fixture.
  const band = (bounds: Rect) => ({ tier: 0, groups: ['a', 'b'], bounds });
  const model = (a: Rect, b: Rect, bounds: Rect) => ({
    groups: { a: { id: 'a', tier: 0, nodes: [], bounds: a }, b: { id: 'b', tier: 0, nodes: [], bounds: b } },
    tierBands: [band(bounds)],
  } as unknown as LayoutModel);
  const box = { x: 0, y: 0, width: 500, height: 100 }, beside = { x: 500, y: 0, width: 500, height: 100 };
  const span = { x: 0, y: 0, width: 1000, height: 100 };
  // A residue no placement rule could have produced is inside the band and clear of its neighbour.
  expect(validateSkeletonBands(model({ ...box, x: -1e-9, width: 500 + 1e-9 }, beside, span))).toEqual([]);
  expect(validateSkeletonBands(model(box, { ...beside, x: 500 - 1e-9 }, span))).toEqual([]);
  // A placement distance is not, and neither guard may pass one: 1e-3 px is four orders under the
  // smallest distance any rule names and still fails.
  expect(validateSkeletonBands(model({ ...box, x: -1e-3, width: 500 + 1e-3 }, beside, span)))
    .toEqual(['Group a is outside its tier band']);
  expect(validateSkeletonBands(model(box, { ...beside, x: 500 - 1e-3, width: 500 + 1e-3 }, span)))
    .toEqual(['Groups a and b overlap']);
});

it('stress ticket 19: a grown group label lands inside the inset the growth asked for', async () => {
  // `planLabels` has two producers of a label's x: the candidate list, which steps `2 * EPS` clear
  // of a forbidden range, and the `firstFree` walk, which stepped one. The walk is what sets the
  // width a blocked group asks to grow to, and the candidate list is what places the label in the
  // box that growth produced, so a group that goes down both paths asked for a box one tolerance
  // narrower than the x it then emitted needs — and the label came to rest that far outside its own
  // 8 px inset. Both now take `LABEL_CLEARANCE_STEP`.
  //
  // This fixture is the one shape that reaches the walk: the downward feed corridor of `middle`
  // covers the whole window, so every candidate — centre, start, limit and both edges of the one
  // merged range — is filtered and the list is empty.
  const model = run(await throughBundles(grownLabel));
  const group = model.groups['lower']!.bounds!;
  const label = model.labels.find(item => item.id === 'label:group:lower')!.bounds!;
  // The growth really happened: the box is wider than the label and its two insets.
  expect(group.width).toBeGreaterThan(label.width + 2 * GROUP_LABEL_GEOMETRY.horizontalInset);
  // And the label rests exactly on the inset, with no tolerance spent either way.
  expect(right(group) - GROUP_LABEL_GEOMETRY.horizontalInset - right(label)).toBe(0);
  expect(label.x).toBeGreaterThan(group.x + GROUP_LABEL_GEOMETRY.horizontalInset);
}, 120000);

it('stress ticket 18: a corridor that would cross a labelled row link\'s split does not move', async () => {
  // The corridor `link-16` owns across tier 2 stands at x 231, beyond `link-17`'s split. Label room wins over the lane (architecture-2
  // ticket 23): 7f inserts the row's room at the split and the corridor moves out with it, by the same 197.61279296875 px, so it keeps
  // its distance to what it serves (R2). 7f's last step would take that corridor to its child's port, on the far side of the split, and
  // the publication replay would reserve room the published model does not have; the corridors are fixed by then, so that move is
  // still refused.
  const model = run(await throughBundles(corridorCrossesSplit));
  expect(model.diagnostics.some(item => item.code === 'LANE_FOLLOWS_ITS_CHILD')).toBe(false);
  expect(model.lanes.map(lane => lane.x)).toEqual([95.5, 428.61279296875]);
  // The claim itself: the replay asks for nothing more.
  const shortfalls: LinkLabelShortfall[] = [];
  expect(reserveLinkLabelRoom(copy(model), shortfalls)).toBe(false);
  expect(shortfalls).toEqual([]);
  // And the link is reserved, not diagnosed.
  expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ROOM_UNRESERVED')).toEqual([]);
}, 180000);
