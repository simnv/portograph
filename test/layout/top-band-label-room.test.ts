import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { reserveLinkLabelRoom, topUpBandClearance, type LinkLabelShortfall } from '../../src/layout/bands.js';
import { expectedFramePath, isRoutedChord } from '../../src/layout/frame-paths.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { fitRegionGroup } from '../../src/layout/regions.js';
import { LINK_LABEL_GEOMETRY } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
import { placed } from './phase-two-fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/a-top-band-push-syncs-pills-before-label-room.yaml', import.meta.url), 'utf8');
const throughBundles = async (yaml: string): Promise<LayoutModel> => bundles(bars(centre(flanks(lanes(rows(await placed(yaml)))))));

it('a top-band push synchronises pills and text before the first label-room consumer', async () => {
  const model = structuredClone(await throughBundles(fixture));
  const before = structuredClone(model);
  expect(topUpBandClearance(model)).toBe(true);
  for (const id of ['source', 'target']) {
    const node = model.nodes[id]!, prior = before.nodes[id]!;
    const down = node.bounds!.y - prior.bounds!.y;
    // The source moves inside its title band; the target follows the taller tier above it.
    expect(down).toBeGreaterThan(0);
    for (const [i, port] of node.ports.entries()) {
      expect(port.anchor!.y - prior.ports[i]!.anchor!.y).toBeCloseTo(down, 9);
      expect(port.pill!.bounds.y - prior.ports[i]!.pill!.bounds.y).toBeCloseTo(down, 9);
    }
    for (const label of model.labels.filter(label => label.owner.kind === 'node' && label.owner.id === id)) {
      const was = before.labels.find(item => item.id === label.id)!;
      expect(label.bounds!.y - was.bounds!.y).toBeCloseTo(down, 9);
    }
  }
  // Rebuilding from the authoritative anchors must now be a no-op for every consumer.
  const synced = structuredClone(model);
  rebuildNodeGeometry(synced, Object.keys(synced.nodes), 'current');
  expect(synced.nodes).toEqual(model.nodes);
  expect(synced.labels).toEqual(model.labels);
  const room = reserveLinkLabelRoom(model);
  expect(reserveLinkLabelRoom(synced)).toBe(room);
  expect(synced).toEqual(model);
  const settled = structuredClone(model);
  expect(topUpBandClearance(model)).toBe(false);
  expect(model).toEqual(settled);
});

it('a same-tier held chord owes label room without detour stems, even with a small slope', async () => {
  const model = structuredClone(await throughBundles(`portograph: 2
groups: {row: {tier: 0, shape: row}}
nodes:
  left: {group: row, ports: [{name: p, side: right}]}
  right: {group: row, ports: [{name: p, side: left}]}
links: [[left.p, right.p, {label: Feed}]]`));
  const link = model.links[0]!, left = model.nodes.left!, right = model.nodes.right!;
  // Pin a slanted frame chord, then make its stored coordinates stale by one pixel.
  right.bounds!.y += 1;
  for (const port of right.ports) port.anchor!.y += 1;
  rebuildNodeGeometry(model, ['right'], 'current');
  fitRegionGroup(model, model.groups.row!);
  const chord = expectedFramePath(model, link);
  expect(chord).toBeDefined();
  link.path = chord!;
  link.technique = 'straight';
  expect(isRoutedChord(model, link)).toBe(true);
  model.frozenChords = [link.id];
  link.path!.segments[0]!.to.y -= 1;
  const before = right.bounds!.x;
  const leftPill = left.ports[0]!.pill!.bounds, rightPill = right.ports[0]!.pill!.bounds;
  const room = 2 * Math.min((left.ports[0]!.anchor!.x + right.ports[0]!.anchor!.x) / 2 - leftPill.x - leftPill.width,
    rightPill.x - (left.ports[0]!.anchor!.x + right.ports[0]!.anchor!.x) / 2);
  const required = measureText('Feed', { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width
    + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
  const shortfalls: LinkLabelShortfall[] = [];
  expect(reserveLinkLabelRoom(model, shortfalls)).toBe(true);
  expect(right.bounds!.x - before).toBeCloseTo(required - room, 6);
  expect(shortfalls).toEqual([{ link: link.id, axis: 'row', required, room }]);
  expect(model.labelYields).toEqual({ [link.id]: [] });
  expect(reserveLinkLabelRoom(model)).toBe(false);
  // A border beside the chord clears its baseline but cuts the turned label's height.
  // This deliberately shortened box tests the reservation replay before publication rejects it.
  const borderCut = structuredClone(model);
  borderCut.groups.row!.bounds!.y = left.ports[0]!.anchor!.y + 3;
  expect(reserveLinkLabelRoom(borderCut)).toBe(false);
  expect(borderCut.diagnostics.filter(item => item.code === 'LINK_LABEL_ROOM_UNRESERVED').map(item => item.owners))
    .toEqual([[{ kind: 'link', id: link.id }]]);
  // An unheld orthogonal link still owes its detour stems.
  const detour = structuredClone(model);
  detour.frozenChords = [];
  detour.links[0]!.technique = 'orthogonal';
  delete detour.links[0]!.path;
  expect(reserveLinkLabelRoom(detour)).toBe(true);
  expect(detour.nodes.right!.bounds!.x).toBeGreaterThan(right.bounds!.x);
});
