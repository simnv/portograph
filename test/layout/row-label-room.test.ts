import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { reserveLinkLabelRoom, topUpBandClearance, type LinkLabelShortfall } from '../../src/layout/bands.js';
import { LINK_LABEL_GEOMETRY, labelBorders, labelGrowth, labelWindowDeficit } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt, placed } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { PLACEMENT_EPS } from '../../src/layout/tolerance.js';
import { freezeChords } from '../../src/layout/frame-paths.js';
import type { AlignmentTarget, LayoutModel } from '../../src/model/layout.js';
import { fitRegionGroup } from '../../src/layout/regions.js';
import * as guards from '../../src/layout/label-room-guard.js';
import * as targets from '../../src/layout/alignment-targets.js';
import { rowRoomHolds, rowRoomKeptByStep, rowRoomShortNow } from '../../src/layout/label-room-guard.js';
import { deriveFrames } from '../../src/layout/frames.js';

const right = (box: { x: number; width: number }): number => box.x + box.width;

const fixture = readFileSync(new URL('../../goldens/synthetic/a-same-row-link-label-keeps-a-straight-overlay-straight.yaml', import.meta.url), 'utf8');
const required = (text: string): number => measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width
  + 2 * LINK_LABEL_GEOMETRY.shortenMargin;

it('reserves a long row label before the freeze and keeps the overlay straight', async () => {
  const staged = await placed(fixture);
  const a = staged.nodes.hub!, b = staged.nodes.target!;
  const p = a.ports.find(port => port.ref.name === 'peer')!, q = b.ports.find(port => port.ref.name === 'nic')!;
  const room = b.bounds!.x - a.bounds!.x - a.bounds!.width - Math.max(p.pill!.bounds.width, q.pill!.bounds.width);
  expect(room).toBeGreaterThanOrEqual(required('1G access trunk') - PLACEMENT_EPS);
  const frozen = structuredClone(bundles(bars(centre(flanks(lanes(rows(staged)))))));
  freezeChords(frozen);
  topUpBandClearance(frozen);
  const x = Object.values(frozen.nodes).map(node => node.bounds!.x);
  const shortfalls: LinkLabelShortfall[] = [];
  reserveLinkLabelRoom(frozen, shortfalls);
  const peer = frozen.links.find(link => frozen.document.links[link.sourceIndex]?.label === '1G access trunk')!;
  expect(shortfalls.filter(item => item.link === peer.id && item.axis === 'row')).toEqual([]);
  expect(Object.values(frozen.nodes).map(node => node.bounds!.x)).toEqual(x);
});

it('grows a held row chord window on x instead of lengthening its tier gap', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-held-row-chord-reserves-label-room-without-detour-stems.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const link = model.links[0]!, line = link.path!.segments[0]!, boxes = labelBorders(model);
  const growth = labelGrowth(model, link);
  expect(growth.axis).toBe('x');
  expect(growth.farEndMoves).toBe(false);
  const extent = 400, across = 15;
  const horizontal = labelWindowDeficit(boxes, line, extent, growth.split, growth.farEndMoves, { across, axis: growth.axis });
  expect(horizontal).toBeGreaterThan(0);
  expect(horizontal).toBeLessThan(labelWindowDeficit(boxes, line, extent, Infinity, true, { across, axis: 'y' })!);
});

it('keeps the long-label overlay straight through the complete pipeline', async () => {
  const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const peer = model.links.find(link => model.document.links[link.sourceIndex]?.label === '1G access trunk')!;
  expect(pathBends(peer)).toBe(0);
  expect(pathBends(model.links.find(link => link.layer === 'overlay')!)).toBe(0);
  expect(model.nodes.gateway!.ports.find(port => port.ref.name === 'down')!.anchor!.x)
    .toBeCloseTo(model.nodes.hub!.ports.find(port => port.ref.name === 'feed')!.anchor!.x, 9);
  expect(model.labels.find(label => label.owner.kind === 'link' && label.owner.id === peer.id && label.role === 'link')!.text).toBe('1G access trunk');
  expect(score(model).snapshot.passed).toBe(true);
  expect(model.removedLinks ?? []).toEqual([]);
});

it('reserves a non-adjacent orthogonal label span during rows', async () => {
  const yaml = `portograph: 2
groups: {row: {tier: 0}}
nodes:
  left: {group: row, ports: [{name: out, side: right}]}
  middle: {group: row}
  right: {group: row, ports: [{name: in, side: left}]}
links:
  - {from: left.out, to: right.in, route: orthogonal, label: "a very long labelled connection across the intervening member"}`;
  const model = rows(await placed(yaml));
  const copy = structuredClone(model), shortfalls: LinkLabelShortfall[] = [];
  reserveLinkLabelRoom(copy, shortfalls);
  expect(shortfalls.filter(item => item.axis === 'row')).toEqual([]);
});

it.each([
  'synthetic/a-centre-replay-keeps-a-cross-group-label-window.yaml',
  'bgplab/policy-a-locpref-route-map.yaml',
])('a centring replay keeps a cross-group label window: %s', async name => {
  const yaml = readFileSync(new URL(`../../goldens/${name}`, import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.stage).toBe('link-labels');
  expect(reserveLinkLabelRoom(structuredClone(model))).toBe(false);
  expect(score(model).snapshot.passed).toBe(true);
  expect(model.removedLinks ?? []).toEqual([]);
});

const crossGroup = (): string => readFileSync(new URL('../../goldens/synthetic/a-centre-replay-keeps-a-cross-group-label-window.yaml', import.meta.url), 'utf8');
const rowShortfalls = (model: LayoutModel): LinkLabelShortfall[] => {
  const shortfalls: LinkLabelShortfall[] = [];
  reserveLinkLabelRoom(structuredClone(model), shortfalls);
  return shortfalls.filter(item => item.axis === 'row' || item.axis === 'row window');
};

it('refuses a step whose unlabelled sibling grows a border into a cross-group label window (review 10b F1)', async () => {
  // Both ends of the labelled zone-4 -> zone-5 link stand still. An unlabelled grid sibling below the end body, inside the group's box,
  // widens past the end body, and the region fit moves zone-4's right border into the window the label rides.
  const model = structuredClone(await layout(parse(crossGroup()), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }));
  const group = model.groups['zone-4']!;
  const sibling = { ...structuredClone(model.nodes['unit-4']!), id: 'spare', ports: [], bounds: { x: 48, y: 278, width: 27, height: 17 } };
  delete sibling.icon;
  model.nodes.spare = sibling;
  model.document.nodes.spare = { ...structuredClone(model.document.nodes['unit-4']!), label: 'spare', ports: [] };
  model.document.groups['zone-4']!.shape = 'grid';
  group.nodes.push('spare'); group.rowOrder!.push('spare');
  fitRegionGroup(model, group);
  const before = structuredClone({ group, nodes: group.nodes.map(id => model.nodes[id]!) });
  expect(rowShortfalls(model)).toEqual([]);
  sibling.bounds.width += 10;
  fitRegionGroup(model, group);
  expect(right(group.bounds!)).toBeGreaterThan(right(before.group.bounds!));
  expect(rowShortfalls(model).map(item => item.axis)).toEqual(['row window']);
  expect(rowRoomKeptByStep(model, before, false)).toBe(false);
});

it('a refused centring step leaves no growth of its own in the alignment record (review 10b F2)', async () => {
  // The whole-step guard restores the group and its nodes. The record must then keep what accepted steps wrote: the refused step's growth
  // is gone with its geometry (R1, R5).
  const originalGuard = guards.rowRoomKeptByStep, originalWrite = targets.writeAlignmentTargets;
  let prior: Record<string, AlignmentTarget[]> | undefined, refusals = 0;
  const found: unknown[] = [];
  const guard = vi.spyOn(guards, 'rowRoomKeptByStep').mockImplementation((...args) => {
    const holds = originalGuard(...args);
    // The record as the step found it: the step writes its targets only after this verdict.
    prior = holds ? undefined : structuredClone(args[0].alignmentTargets);
    if (!holds) refusals++;
    return holds;
  });
  const writer = vi.spyOn(targets, 'writeAlignmentTargets').mockImplementation((model, nodes, notes, pass) => {
    originalWrite(model, nodes, notes, pass);
    if (prior !== undefined) for (const key of notes.wanted.keys()) {
      const entry = Object.values(model.alignmentTargets ?? {}).flat().find(item => item.port === key);
      const was = Object.values(prior).flat().find(item => item.port === key);
      if (entry?.state !== 'grown') continue;
      // A grown entry after a refused step is the one an accepted step wrote, or the room at the step's start for a target that stood.
      const allowed = was?.state === 'grown' ? was.extent : was?.state === 'kept' ? notes.start.get(key) : undefined;
      if (allowed === undefined || allowed.low !== entry.extent!.low || allowed.high !== entry.extent!.high) found.push({ key, entry, was });
    }
    prior = undefined;
  });
  try {
    await layout(parse(crossGroup()), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  } finally { guard.mockRestore(); writer.mockRestore(); }
  expect(refusals).toBeGreaterThan(0);
  expect(found).toEqual([]);
});

it('refuses a step or a move whose cell on another tier grows a frame into the label window (review 10b-2)', async () => {
  // zone-2 (tier 0) and zone-4 (tier 1) become cells of one frame. The labelled zone-4 -> zone-5 link keeps both ends; zone-2 widens on
  // tier 0, the frame's right edge follows it, and the frame border cuts the tier-1 window. Both guard entry points must read it.
  const model = structuredClone(await layout(parse(crossGroup()), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }));
  const cell = model.nodes['unit-2']!, group = model.groups['zone-2']!;
  group.frame = 'west-frame';
  model.groups['zone-4']!.frame = 'west-frame';
  model.document.frames = { 'west-frame': { label: 'West', cells: ['zone-2', 'zone-4'] } };
  model.frames = deriveFrames(model) ?? [];
  reserveLinkLabelRoom(model);
  expect(rowShortfalls(model)).toEqual([]);
  const before = structuredClone({ group, nodes: [cell] }), found = structuredClone(model);
  const proposed = [{ group: found.groups['zone-2']!, bounds: { ...found.groups['zone-2']!.bounds!, width: found.groups['zone-2']!.bounds!.width + 10 }, dx: 0 }];
  cell.bounds!.width += 10; group.bounds!.width += 10;
  expect(rowShortfalls(model).map(item => item.axis)).toEqual(['row window']);
  expect(rowRoomKeptByStep(model, before, false)).toBe(false);
  const short = rowRoomShortNow(found, proposed);
  expect(short).toEqual([]);
  expect(rowRoomHolds(found, proposed, short!)).toBe(false);
});
