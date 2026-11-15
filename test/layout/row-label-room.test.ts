import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
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
