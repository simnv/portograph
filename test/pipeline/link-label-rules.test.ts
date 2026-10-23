import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { LABEL_BORDER_REACH, LABEL_WINDOW_GRAIN, LINK_LABEL_GEOMETRY, labelRunWindows, labelWindowDeficit, produceLinkLabels, windowHolds } from '../../src/layout/link-labels.js';
import { groupBoxes, labelArea, labelCrossesBorder } from '../../src/score/model.js';
import { DEFAULT_STROKE_WIDTHS } from '../../src/theme/geometry.js';
import { reserveLinkLabelRoom } from '../../src/layout/bands.js';
import { bench } from '../layout/link-label-fixture.js';
import { measureText } from '../../src/text/index.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const width = (text: string) => measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width;
const linkLabel = (model: LayoutModel) => model.labels.find(label => label.role === 'link')!;

it('ADR-0014: a label on a vertical run is rotated to read bottom-to-top and its box lies along the run', async () => {
  const model = await run(fixture('fitting-link-label'));
  const label = linkLabel(model), segment = model.links[0]!.path!.segments[0]!;
  expect(segment.from.x).toBe(segment.to.x);
  expect(label.textRotation).toBe(-90);
  expect(label.omitted).toBeUndefined();
  // The stored box is the rotated one: text width along y, text height along x.
  expect(label.bounds!.height).toBeCloseTo(width('uplink'), 9);
  expect(label.bounds!.width).toBeCloseTo(measureText('uplink', { fontSize: 9, weight: 400 }).height, 9);
  expect(label.bounds!.y + label.bounds!.height / 2).toBeCloseTo((segment.from.y + segment.to.y) / 2, 9);
  expect(label.bounds!.x).toBeCloseTo(segment.from.x + LINK_LABEL_GEOMETRY.normalGap + 0.75, 9);
  expect(score(model).snapshot.gates.G3.passed).toBe(true);
}, 60000);

it('ADR-0014: a long description lengthens the run it will follow, vertically and horizontally', async () => {
  const text = 'a considerably longer description of this uplink';
  const vertical = await run(`portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes:
  source: {group: upper, ports: [{name: p, side: bottom}]}
  target: {group: lower, ports: [{name: p, side: top}]}
links: [[source.p, target.p, {label: ${text}, route: orthogonal}]]`);
  const drop = vertical.links[0]!.path!.segments, label = linkLabel(vertical);
  expect(drop).toHaveLength(1);
  const source = vertical.nodes.source!, target = vertical.nodes.target!;
  const pill = (node: typeof source) => node.ports[0]!.pill!.bounds;
  // Room between the two pill faces holds the label plus both shortening margins.
  expect(pill(target).y - (pill(source).y + pill(source).height)).toBeGreaterThanOrEqual(width(text) + 2 * LINK_LABEL_GEOMETRY.shortenMargin - 1e-6);
  expect(label.omitted).toBeUndefined();
  expect(label.text).toBe(text);
  expect(label.textRotation).toBe(-90);
  expect(vertical.diagnostics.some(d => d.code.startsWith('LINK_LABEL'))).toBe(false);

  const peering = 'a considerably longer description of this peering';
  const horizontal = await run(`portograph: 2
groups: {tier-group: {tier: 0}, flank-group: {align: left, of: tier-group}}
nodes:
  peer: {group: tier-group, ports: [{name: p, side: left}]}
  flank: {group: flank-group, ports: [{name: p, side: right}]}
links: [[flank.p, peer.p, {label: ${peering}}]]`);
  const flankPill = horizontal.nodes.flank!.ports[0]!.pill!.bounds, peerPill = horizontal.nodes.peer!.ports[0]!.pill!.bounds;
  expect(peerPill.x - (flankPill.x + flankPill.width)).toBeGreaterThanOrEqual(width(peering) + 2 * LINK_LABEL_GEOMETRY.shortenMargin - 1e-6);
  const across = linkLabel(horizontal);
  expect(across.textRotation).toBe(0);
  expect(across.text).toBe(peering);
  expect(across.omitted).toBeUndefined();
  expect(score(horizontal).snapshot.passed).toBe(true);

  // Publication and restore re-run the reservation on a copy: a published model asks for nothing more,
  // and a model whose run was shortened afterwards would be changed by it, which the validator rejects.
  expect(reserveLinkLabelRoom(JSON.parse(JSON.stringify(vertical)) as LayoutModel)).toBe(false);
  const shortened = JSON.parse(JSON.stringify(vertical)) as LayoutModel;
  for (const group of Object.values(shortened.groups)) if (group.tier === 1) group.bounds!.y -= 60;
  const t = shortened.nodes.target!; t.bounds!.y -= 60; for (const p of t.ports) { p.anchor!.y -= 60; if (p.pill) p.pill.bounds.y -= 60; }
  expect(reserveLinkLabelRoom(shortened)).toBe(true);
}, 60000);

it('stress ticket 18: a corridor at or beyond the split decides whether the room is reserved at all', async () => {
  // The reservation declines a row link whose room lies beyond a reserved lane, because lane
  // geometry cannot move. So the answer this pass gives depends on where the corridors are — and
  // 7f's last step moves one (ticket 02). A corridor that crosses a split turns a link the
  // production pass diagnosed into a link the publication replay reserves, and the replay throws
  // `A labelled link is shorter than the run its label reserved` on a model nothing else touched.
  // The move is refused for that reason in `mutation.ts`, beside the two contradictions it was
  // already refused for. This is the premise of that refusal, stated directly: one corridor, two
  // positions, two answers.
  const text = 'a considerably longer description of this peering';
  const model = await run(`portograph: 2
groups: {tier-group: {tier: 0}, flank-group: {align: left, of: tier-group}}
nodes:
  peer: {group: tier-group, ports: [{name: p, side: left}]}
  flank: {group: flank-group, ports: [{name: p, side: right}]}
links: [[flank.p, peer.p, {label: ${text}}]]`);
  const copy = (value: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(value)) as LayoutModel;
  // Pull the tier peer back over its own run: the reservation now owes the label room again.
  const short = copy(model);
  for (const group of Object.values(short.groups)) if (!group.flank) group.bounds!.x -= 60;
  const peer = short.nodes.peer!;
  peer.bounds!.x -= 60;
  for (const port of peer.ports) { port.anchor!.x -= 60; if (port.pill) port.pill.bounds.x -= 60; }
  expect(reserveLinkLabelRoom(copy(short))).toBe(true);

  const flankPill = short.nodes.flank!.ports[0]!.pill!.bounds, peerPill = peer.ports[0]!.pill!.bounds;
  const split = (Math.max(short.nodes.flank!.bounds!.x + short.nodes.flank!.bounds!.width, flankPill.x + flankPill.width)
    + Math.min(peer.bounds!.x, peerPill.x)) / 2;
  const corridor = (x: number) => ({ id: 'lane:"transit":9', owner: { kind: 'link' as const, id: 'transit' },
    layer: 'routed' as const, group: 'tier-group', tier: 9, side: 'right' as const, x,
    bounds: { x: x - 17, y: 0, width: 34, height: 10 } });

  // A corridor at the split: the room lies beyond geometry that cannot move, so nothing is reserved.
  const beyond = copy(short);
  beyond.lanes.push(corridor(split));
  expect(reserveLinkLabelRoom(beyond)).toBe(false);
  expect(beyond.diagnostics.filter(d => d.code === 'LINK_LABEL_ROOM_UNRESERVED').map(d => d.message))
    .toEqual([expect.stringMatching(/beyond a reserved lane/)]);
  // The same corridor one pixel to the left of the split, which is where the move takes it: reserved.
  const before = copy(short);
  before.lanes.push(corridor(split - 1));
  expect(reserveLinkLabelRoom(before)).toBe(true);
}, 60000);

it('ADR-0014: a described link that must detour over a neighbour carries its full label on the longest run', async () => {
  // The band under the title reserves room for the label, and the run is reserved with both detour
  // stems, so the whole text sits above the long top segment instead of a stub on a stem.
  const model = await run(fixture('unfittable-link-label'));
  const label = linkLabel(model), full = 'This link label must survive in its tooltip even when every visible placement collides';
  expect(label.omitted).toBeUndefined();
  expect(label.text).toBe(full);
  expect(label.tooltip).toBeUndefined();
  const segments = model.links[0]!.path!.segments;
  const longest = segments.reduce((best, s) => Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) > Math.hypot(best.to.x - best.from.x, best.to.y - best.from.y) ? s : best, segments[0]!);
  expect(longest.from.y).toBe(longest.to.y);
  expect(label.textRotation).toBe(0);
  expect(label.bounds!.y + label.bounds!.height).toBeLessThan(longest.from.y);
  expect(label.bounds!.width).toBeLessThanOrEqual(Math.abs(longest.to.x - longest.from.x) - 2 * LINK_LABEL_GEOMETRY.shortenMargin + 1e-6);
  const title = model.labels.find(item => item.id === 'label:group:row-group')!.bounds!;
  expect(label.bounds!.y).toBeGreaterThanOrEqual(title.y + title.height + 8 - 1e-6);
  expect(score(model).snapshot.gates.G3.passed).toBe(true);
}, 60000);

it('ADR-0014: room is symmetric about the anchor midpoint, so unequal pills cannot swallow a reserved label', async () => {
  const text = 'a considerably longer description of this uplink';
  const model = await run(`portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes:
  source: {group: upper, ports: [{name: a-very-very-long-port-name, side: bottom}]}
  target: {group: lower, ports: [{name: p, side: top}]}
links: [[source.a-very-very-long-port-name, target.p, {label: ${text}}]]`);
  const label = linkLabel(model);
  expect(label.omitted).toBeUndefined();
  expect(label.text).toBe(text);
  expect(model.diagnostics.some(d => d.code.startsWith('LINK_LABEL'))).toBe(false);
}, 60000);

it('ADR-0014: bar-ended and unsuppressed overlay links reserve room too; two labelled links do not double it', async () => {
  const text = 'a considerably longer description of this uplink';
  const bar = await run(`portograph: 2
groups: {upper: {tier: 0}, bars: {tier: 1, shape: bar}}
nodes:
  source: {group: upper, ports: [{name: p, side: bottom}]}
  bar: {group: bars, ports: [{name: p, side: top}]}
links: [[source.p, bar.p, {label: ${text}}]]`);
  expect(linkLabel(bar).omitted).toBeUndefined();
  expect(linkLabel(bar).text).toBe(text);

  const overlay = await run(`portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes:
  source: {group: upper, ports: [{name: p, side: bottom}]}
  target: {group: lower, ports: [{name: p, side: top}]}
  spare: {group: lower}
links: [{from: source.p, to: target.p, route: overlay, label: ${text}}]`);
  expect(linkLabel(overlay).omitted).toBeUndefined();
  expect(linkLabel(overlay).text).toBe(text);

  const two = await run(`portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes:
  a: {group: upper, ports: [{name: p, side: bottom}]}
  b: {group: upper, ports: [{name: p, side: bottom}]}
  c: {group: lower, ports: [{name: p, side: top}]}
  d: {group: lower, ports: [{name: p, side: top}]}
links: [[a.p, c.p, {label: ${text}}], [b.p, d.p, {label: ${text}}]]`);
  const a = two.nodes.a!, c = two.nodes.c!;
  const gap = c.ports[0]!.pill!.bounds.y - (a.ports[0]!.pill!.bounds.y + a.ports[0]!.pill!.bounds.height);
  // Exactly the room one label needs (within the tier gap already there), not that room twice.
  expect(gap).toBeGreaterThanOrEqual(width(text) + 2 * LINK_LABEL_GEOMETRY.shortenMargin - 1e-6);
  expect(gap).toBeLessThan(2 * (width(text) + 2 * LINK_LABEL_GEOMETRY.shortenMargin));
  for (const label of two.labels.filter(item => item.role === 'link')) expect(label.omitted).toBeUndefined();
}, 60000);

it('ADR-0014: a pair facing away across two flanks is diagnosed, as are self-links and vertical same-tier links', async () => {
  // Flank placement keeps both flanks outside their cores; here the right-tier flank lands leftmost,
  // so lf.q (right) and rf.q (left) face away from each other. The link wraps both nodes and the
  // router places the wrapping leg freely, so no anchor distance bounds its run: the link is
  // diagnosed and the ladder decides on its own (a facing flank pair is the detour test above).
  const away = await run(`portograph: 2
groups: {left-tier: {tier: 0}, right-tier: {tier: 0}, left-flank: {align: left, of: left-tier}, right-flank: {align: left, of: right-tier}}
nodes:
  lp: {group: left-tier, ports: [{name: p, side: left}]}
  rp: {group: right-tier, ports: [{name: p, side: left}]}
  lf: {group: left-flank, ports: [{name: p, side: right}, {name: q, side: right}]}
  rf: {group: right-flank, ports: [{name: p, side: right}, {name: q, side: left}]}
links: [[lf.p, lp.p], [rf.p, rp.p], [lf.q, rf.q, {label: a considerably longer description of this cross link}]]`);
  expect(away.stage).toBe('link-labels');
  expect(away.nodes.rf!.bounds!.x).toBeLessThan(away.nodes.lf!.bounds!.x);
  expect(away.diagnostics.filter(d => d.code === 'LINK_LABEL_ROOM_UNRESERVED').map(d => d.message)).toEqual([expect.stringMatching(/does not face/)]);
  expect(score(away).snapshot.passed).toBe(true);
  // Self-links and same-tier vertical links are diagnosed the same way instead of failing publication.
  const self = await run(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: left, side: left}, {name: right, side: right}]}
links: [[a.left, a.right, {label: labelled self link}]]`);
  expect(self.diagnostics.filter(d => d.code === 'LINK_LABEL_ROOM_UNRESERVED').map(d => d.message)).toEqual([expect.stringMatching(/own node/)]);
  const stacked = await run(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: bottom}]}
  b: {group: g, ports: [{name: p, side: top}]}
links: [{from: a.p, to: b.p, route: overlay, label: This is a very long unsuppressed overlay description that stage seven should reserve in full}]`);
  expect(stacked.stage).toBe('link-labels');
  expect(stacked.diagnostics.filter(d => d.code === 'LINK_LABEL_ROOM_UNRESERVED').map(d => d.message)).toEqual([expect.stringMatching(/top or bottom ports/)]);
}, 60000);

it('ADR-0014: the detour reservation uses each end\'s stroke-aware stem reach', async () => {
  // A heavy stroke lengthens the router stem; the reserved run grows with it, so the label still fits.
  const heavy = fixture('unfittable-link-label').replace('{ label: This link label', '{ weight: 50, label: This link label');
  const model = await run(heavy);
  const label = linkLabel(model);
  expect(label.omitted).toBeUndefined();
  expect(label.text).toBe('This link label must survive in its tooltip even when every visible placement collides');
  const segments = model.links[0]!.path!.segments;
  const longest = Math.max(...segments.map(s => Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y)));
  expect(longest).toBeGreaterThanOrEqual(label.bounds!.width + 2 * LINK_LABEL_GEOMETRY.shortenMargin - 1e-6);
}, 60000);

it('ADR-0014: among shortened placements the one keeping the most characters wins, not the first clear one', () => {
  // A long horizontal run whose first (upper) side is blocked, then a short vertical run that is free on
  // its first side. The full text fits nowhere. First-clear ladder order would take the short run's
  // stub; the rule takes the long run's second side and keeps more of the text.
  const text = 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
  const model = bench(
    [{ id: 'source', bounds: { x: 0, y: 100, width: 40, height: 40 } }, { id: 'target', bounds: { x: 400, y: 300, width: 40, height: 40 } }],
    [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'top'], label: text,
      points: [{ x: 40, y: 120 }, { x: 420, y: 120 }, { x: 420, y: 300 }] }],
    [{ id: 'label:node:blocker', owner: { kind: 'node', id: 'source' }, layer: 'routed', role: 'node', text: 'blocker',
      bounds: { x: 60, y: 96, width: 340, height: 20 } }]);
  produceLinkLabels(model);
  const label = model.labels.find(item => item.role === 'link')!;
  expect(label.omitted).toBeUndefined();
  expect(label.support).toEqual({ kind: 'link-segment', link: 'link-1', segment: 0 });
  expect(label.textRotation).toBe(0);
  expect(label.bounds!.y).toBeGreaterThan(120);
  expect(label.text.length).toBeGreaterThan(20);
});

it('ADR-0014: a same-row overlay link stands between neighbours (ticket 78), stays straight and reserves its label in the gap between its ports', async () => {
  const yaml = (label: string) => `portograph: 2
groups: {g: {tier: 0}}
nodes:
  source: {group: g, ports: [{name: p, side: right}]}
  target: {group: g, ports: [{name: p, side: left}]}
  above: {group: g}
  below: {group: g}
links: [{from: source.p, to: target.p, route: overlay${label}}]`;
  const gap = (model: LayoutModel) => model.nodes.target!.ports[0]!.pill!.bounds.x - (model.nodes.source!.ports[0]!.pill!.bounds.x + model.nodes.source!.ports[0]!.pill!.bounds.width);
  const plain = await run(yaml('')), labelled = await run(yaml(', label: mid label'));
  // The row is ordered by its partners: source and target stand next to each other, so the link is one straight
  // segment between facing side ports and no body lies over it. The gap holds the label, reserved in placement.
  expect(plain.links[0]!.path!.segments).toHaveLength(1);
  expect(labelled.links[0]!.path!.segments).toHaveLength(1);
  // Exactly the room the label needs, symmetric about the run's midpoint: a straight link reserves no detour stem
  // (review of ticket 78; the gap was 9 px before the label and is the label room after it).
  expect(gap(labelled)).toBeCloseTo(width('mid label') + 2 * LINK_LABEL_GEOMETRY.shortenMargin, 6);
}, 60000);

it('ADR-0014: a routed link between two flanks detouring around the core group reserves both stems', async () => {
  const text = 'This is an extremely long routed description that must remain complete on the detour run across both outer flanks without shortening';
  const model = await run(`portograph: 2
groups: {core: {tier: 0}, lf: {align: left, of: core}, rf: {align: right, of: core}}
nodes:
  peer: {group: core, ports: [{name: l, side: left}, {name: r, side: right}]}
  source: {group: lf, ports: [{name: q, side: right}]}
  target: {group: rf, ports: [{name: q, side: left}]}
links: [[source.q, peer.l], [peer.r, target.q], [source, target, {route: orthogonal, label: ${text}}]]`);
  const label = linkLabel(model);
  expect(label.omitted).toBeUndefined();
  expect(label.text).toBe(text);
  const link = model.links.find(item => model.document.links[item.sourceIndex]?.label === text)!;
  const longest = Math.max(...link.path!.segments.map(s => Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y)));
  expect(longest).toBeGreaterThanOrEqual(label.bounds!.width + 2 * LINK_LABEL_GEOMETRY.shortenMargin - 1e-6);
  expect(score(model).snapshot.gates.G3.passed).toBe(true);
}, 60000);

it('ADR-0014: a same-tier label ending on a bar moves the row end, never the bar, and replays the bar', async () => {
  const text = 'A very long same tier description attached to a bar should remain complete without shortening';
  const model = await run(`portograph: 2
groups: {upper: {tier: 0}, row: {tier: 1}, bars: {tier: 1, shape: bar}}
nodes:
  up: {group: upper, ports: [{name: p, side: bottom}]}
  left: {group: row, ports: [{name: p, side: right}]}
  bus: {group: bars, ports: [{name: top, side: top}, {name: side, side: left}]}
links: [[up.p, bus.top], [left.p, bus.side, {label: ${text}}]]`);
  const label = model.labels.find(item => item.role === 'link')!;
  expect(label.omitted).toBeUndefined();
  expect(label.text).toBe(text);
  expect(model.diagnostics.some(d => d.code.startsWith('LINK_LABEL'))).toBe(false);
  expect(score(model).snapshot.passed).toBe(true);
  // The bar's top port still sits under its source: 7d shaped it after the row moved.
  expect(model.nodes.bus!.ports.find(p => p.ref.name === 'top')!.anchor!.x).toBeCloseTo(model.nodes.up!.ports[0]!.anchor!.x, 9);
}, 60000);

it('ADR-0014: room is inserted at the gap, so a preceding group is never overlapped and a centred feed never oscillates', async () => {
  const prior = await run(`portograph: 2
groups: {upper: {tier: 0}, prior: {tier: 1}, row: {tier: 1}, bars: {tier: 1, shape: bar}}
nodes:
  up: {group: upper, ports: [{name: p, side: bottom}]}
  spare: {group: prior}
  peer: {group: row, ports: [{name: bar, side: right}]}
  bus: {group: bars, ports: [{name: top, side: top}, {name: side, side: left}]}
links: [[up.p, bus.top], [peer.bar, bus.side, {label: long long long long long long long long long long}]]`);
  expect(prior.stage).toBe('link-labels');
  expect(linkLabel(prior).omitted).toBeUndefined();
  expect(score(prior).snapshot.gates.G1.passed).toBe(true);

  const fed = await run(`portograph: 2
groups: {upper: {tier: 0}, row: {tier: 1}, bars: {tier: 1, shape: bar}}
nodes:
  feed: {group: upper, ports: [{name: p, side: bottom}]}
  up: {group: upper, ports: [{name: p, side: bottom}]}
  peer: {group: row, ports: [{name: top, side: top}, {name: bar, side: right}]}
  bus: {group: bars, ports: [{name: top, side: top}, {name: side, side: left}]}
links: [[feed.p, peer.top], [up.p, bus.top], [peer.bar, bus.side, {label: A very very very very very very very very very very very very very very very long label forcing repeated reservation}]]`);
  expect(fed.stage).toBe('link-labels');
  expect(fed.diagnostics.some(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toBe(false);
  expect(linkLabel(fed).omitted).toBeUndefined();
  // Both vertical feeds stay straight: their two ends moved together.
  for (const id of ['link-1', 'link-2']) {
    const link = fed.links.find(item => item.id === id)!;
    expect(link.path!.segments.every(sgm => sgm.from.x === sgm.to.x), id).toBe(true);
  }
  expect(score(fed).snapshot.passed).toBe(true);
}, 60000);

it('ADR-0014: a wide node straddling the split moves with the bar slotted under it', async () => {
  const model = await run(`portograph: 2
groups: {upper: {tier: 0}, row: {tier: 1}, bars: {tier: 1, shape: bar}}
nodes:
  up: {group: upper, size: {width: 200, height: 35}, ports: [{name: p, side: bottom}]}
  peer: {group: row, ports: [{name: bar, side: right}]}
  bus: {group: bars, ports: [{name: top, side: top}, {name: side, side: left}]}
links: [[up.p, bus.top], [peer.bar, bus.side, {label: A very very very very very very very very very very very very very very very long label forcing the cut}]]`);
  expect(model.stage).toBe('link-labels');
  expect(model.diagnostics.some(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toBe(false);
  expect(model.nodes.bus!.ports.find(p => p.ref.name === 'top')!.anchor!.x).toBeCloseTo(model.nodes.up!.ports[0]!.anchor!.x, 9);
  expect(linkLabel(model).omitted).toBeUndefined();
  expect(score(model).snapshot.passed).toBe(true);
}, 60000);

it('ADR-0014: a foreign group box within the edge margin of the run counts as a detour and reserves the stems', async () => {
  // Same placed model twice; the second copy gets a foreign group whose box stops 5 px short of the run.
  // The raw box never touches the run, yet the stroke-aware corridor is closed (ADR-0013), so the
  // router will detour and the reservation must add the stems.
  const text = 'a considerably longer description that has to travel around a foreign box';
  const placedModel = bundles(bars(centre(flanks(lanes(rows(await placed(`portograph: 2
groups: {left: {tier: 0}, right: {tier: 0}}
nodes:
  a: {group: left, size: {width: 60, height: 120}, ports: [{name: p, side: right}]}
  b: {group: right, size: {width: 60, height: 120}, ports: [{name: p, side: left}]}
links: [[a.p, b.p, {label: ${text}}]]`)))))));
  const plain = JSON.parse(JSON.stringify(placedModel)) as LayoutModel;
  const blocked = JSON.parse(JSON.stringify(placedModel)) as LayoutModel;
  const run = blocked.nodes.a!.ports[0]!.anchor!, left = blocked.nodes.a!.bounds!, right = blocked.nodes.b!.bounds!;
  const box = { x: left.x + left.width + 30, y: run.y - 5 - 40, width: 40, height: 40 };
  expect(box.x + box.width).toBeLessThan(right.x);
  blocked.document.groups['foreign'] = { label: 'foreign', shape: 'row', tier: 0 };
  blocked.document.nodes['f'] = { group: 'foreign', label: 'f', ports: [] };
  blocked.nodes['f'] = { id: 'f', owner: { kind: 'node', id: 'f' }, layer: 'routed', ports: [], bounds: { x: box.x + 10, y: box.y + 10, width: 20, height: 20 }, size: { width: 20, height: 20 } };
  blocked.groups['foreign'] = { id: 'foreign', owner: { kind: 'group', id: 'foreign' }, layer: 'routed', nodes: ['f'], tier: 0, bounds: box };
  const distance = (model: LayoutModel) => model.nodes.b!.ports[0]!.anchor!.x - model.nodes.a!.ports[0]!.anchor!.x;
  const before = distance(plain);
  const pillA = plain.nodes.a!.ports[0]!.pill!.bounds, pillB = plain.nodes.b!.ports[0]!.pill!.bounds;
  const room = pillB.x - (pillA.x + pillA.width);
  reserveLinkLabelRoom(plain); reserveLinkLabelRoom(blocked);
  // Both reserve the label; only the blocked copy also reserves the coming detour: both 15 px stems
  // and twice the pill protrusion (half the 24 px pill) on the anchor side. The plain copy's straight
  // run crosses both group borders, so it reserves the window between them (ticket 19), not the stems.
  expect(distance(plain)).toBeGreaterThanOrEqual(before);
  const required = width(text) + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
  expect(distance(blocked) - before).toBeCloseTo(required + 2 * 15 + 2 * (pillA.width / 2) - room, 6);
});

it('ADR-0014: ports on one side are diagnosed; two bars are moved with everything beyond the gap', async () => {
  // Right-to-right across two groups: the route wraps the right node with its leg mid-gap.
  const sameSide = await run(`portograph: 2
groups: {l: {tier: 0}, r: {tier: 0}}
nodes:
  a: {group: l, ports: [{name: p, side: right}]}
  b: {group: r, ports: [{name: p, side: right}]}
links: [[a.p, b.p, {label: This same side label is deliberately long enough to require reserved detour room}]]`);
  expect(sameSide.stage).toBe('link-labels');
  expect(sameSide.diagnostics.filter(d => d.code === 'LINK_LABEL_ROOM_UNRESERVED').map(d => d.message)).toEqual([expect.stringMatching(/does not face/)]);
  const plain = await run(`portograph: 2
groups: {l: {tier: 0}, r: {tier: 0}}
nodes:
  a: {group: l, ports: [{name: p, side: right}]}
  b: {group: r, ports: [{name: p, side: right}]}
links: [[a.p, b.p]]`);
  expect(sameSide.nodes.b!.bounds!.x).toBe(plain.nodes.b!.bounds!.x);
  // ...and a same-side pair over a third node moves nothing either: the title band asks the same
  // eligibility question as the reservation, so no clearance grows for a link that is diagnosed.
  const over = (label: string) => `portograph: 2
groups: {core: {tier: 0}, lf: {align: left, of: core}, rf: {align: right, of: core}}
nodes:
  peer: {group: core, ports: [{name: l, side: left}, {name: r, side: right}]}
  source: {group: lf, ports: [{name: p, side: right}, {name: q, side: right}]}
  target: {group: rf, ports: [{name: p, side: left}, {name: q, side: right}]}
links: [[source.p, peer.l], [peer.r, target.p], [source.q, target.q${label}]]`;
  const labelled = await run(over(', {label: This same side label is deliberately long enough to require reserved detour room}'));
  const unlabelled = await run(over(''));
  expect(labelled.diagnostics.filter(d => d.code === 'LINK_LABEL_ROOM_UNRESERVED').map(d => d.message)).toEqual([expect.stringMatching(/does not face/)]);
  const geometry = (model: LayoutModel) => ({
    nodes: Object.fromEntries(Object.values(model.nodes).map(node => [node.id, node.bounds])),
    groups: Object.fromEntries(Object.values(model.groups).map(group => [group.id, group.bounds])),
    bands: model.labelBands.map(band => [band.group, band.clearance, band.bounds]),
  });
  expect(geometry(labelled)).toEqual(geometry(unlabelled));

  // Two bars: nothing is moved by hand; the right bar moves with everything beyond the split, so
  // the run between the bars is long enough and every gate still passes.
  const text = 'A very long same tier description between two bars that is reserved by moving the right bar and all beyond it';
  const bars = await run(`portograph: 2
groups: {left: {tier: 0, shape: bar}, right: {tier: 0, shape: bar}}
nodes:
  a: {group: left, ports: [{name: p, side: right}]}
  b: {group: right, ports: [{name: p, side: left}]}
links: [[a.p, b.p, {label: ${text}}]]`);
  expect(bars.stage).toBe('link-labels');
  expect(bars.diagnostics.some(d => d.code === 'LINK_LABEL_ROOM_UNRESERVED')).toBe(false);
  const room = bars.nodes.b!.ports[0]!.pill!.bounds.x - (bars.nodes.a!.ports[0]!.pill!.bounds.x + bars.nodes.a!.ports[0]!.pill!.bounds.width);
  expect(room).toBeGreaterThanOrEqual(width(text) + 2 * LINK_LABEL_GEOMETRY.shortenMargin - 1e-6);
  expect(linkLabel(bars).omitted).toBeUndefined();
  expect(linkLabel(bars).text).toBe(text);
  expect(score(bars).snapshot.passed).toBe(true);
}, 60000);

it('ticket 30: a full text longer than its segment is shortened instead of overhanging both ends', async () => {
  // Unreservable (right → right across two groups): the ladder decides, and the longest run is
  // shorter than the text, so no placement may carry the full text. The label is shortened, drawn
  // within its supporting segment, and keeps the full text as a tooltip.
  const text = 'a very long link description that cannot possibly fit on the short wrapping leg';
  const model = await run(`portograph: 2
groups: {l: {tier: 0}, r: {tier: 0}}
nodes:
  a: {group: l, ports: [{name: p, side: right}]}
  b: {group: r, ports: [{name: p, side: right}]}
links: [[a.p, b.p, {label: "${text}"}]]`);
  const label = linkLabel(model);
  expect(label.omitted).toBeUndefined();
  expect(label.text).not.toBe(text);
  expect(label.text!.endsWith(LINK_LABEL_GEOMETRY.ellipsis)).toBe(true);
  expect(label.tooltip).toBe(text);
  const segment = model.links[0]!.path!.segments[(label.support as { segment: number }).segment]!;
  const along = Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
  // A shortened text fits `length - shortenMargin` (ADR-0014); a full text needs the margin at both ends.
  const extent = label.textRotation === -90 ? label.bounds!.height : label.bounds!.width;
  expect(extent).toBeLessThanOrEqual(along - LINK_LABEL_GEOMETRY.shortenMargin + 1e-6);
  // Every placed full label of the label fixtures sits inside its run with the margin at both ends.
  for (const model of [await run(fixture('unfittable-link-label')), await run(fixture('fitting-link-label'))]) {
    for (const item of model.labels.filter(l => l.role === 'link' && !l.omitted && l.support?.kind === 'link-segment')) {
      const owner = item.owner.kind === 'barCross' ? item.owner.link : item.owner.id;
      const s = model.links.find(l => l.id === owner)!.path!.segments[(item.support as { segment: number }).segment]!;
      const run = Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
      const margins = item.tooltip === undefined ? 2 : 1;
      expect(item.textRotation === -90 ? item.bounds!.height : item.bounds!.width).toBeLessThanOrEqual(run - margins * LINK_LABEL_GEOMETRY.shortenMargin + 1e-6);
    }
  }
}, 60000);

it('ticket 30: the full text still takes a segment exactly long enough for it plus both margins', () => {
  const text = 'WWWWWWWW';
  const need = width(text) + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
  const place = (length: number) => {
    const model = bench(
      [{ id: 'source', bounds: { x: 0, y: 100, width: 40, height: 40 } }, { id: 'target', bounds: { x: 40 + length, y: 100, width: 40, height: 40 } }],
      [{ id: 'link-1', from: 'source', to: 'target', sides: ['right', 'left'], label: text, points: [{ x: 40, y: 120 }, { x: 40 + length, y: 120 }] }], []);
    produceLinkLabels(model);
    return linkLabel(model);
  };
  expect(place(need).text).toBe(text);
  // One pixel short: the full text no longer fits, the shortened pass takes over on the same run.
  const short = place(need - 1);
  expect(short.text).not.toBe(text);
  expect(short.text!.endsWith(LINK_LABEL_GEOMETRY.ellipsis)).toBe(true);
});

it('a link label stays in one region: it slides off a group border into the window placement reserved', async () => {
  const model = await run(fixture('a-link-label-stays-clear-of-a-group-border'));
  const label = linkLabel(model);
  expect(label.omitted).toBeUndefined();
  expect(label.text).toBe('fibre 100M');
  expect(label.textRotation).toBe(-90);
  const boxes = groupBoxes(model);
  expect(boxes.filter(box => labelCrossesBorder(label.bounds!, box.bounds)).map(box => box.id)).toEqual([]);
  // Wholly in the tier gap, the border margin clear of both borders.
  const upper = model.groups.upper!.bounds!, lower = model.groups.lower!.bounds!;
  expect(label.bounds!.y).toBeGreaterThanOrEqual(upper.y + upper.height + LABEL_BORDER_REACH - 1e-6);
  expect(label.bounds!.y + label.bounds!.height).toBeLessThanOrEqual(lower.y - LABEL_BORDER_REACH + 1e-6);
  expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ON_BORDER' || item.code === 'LINK_LABEL_ROOM_UNRESERVED')).toEqual([]);
  const report = score(model).snapshot;
  expect(Object.values(report.gates).every(gate => gate.passed)).toBe(true);
  expect(report.counters.labelBorderCrossings).toBeUndefined();
  // The scorer counts a label put back across the border.
  const forged = structuredClone(model);
  linkLabel(forged).bounds!.y = upper.y + upper.height - 4;
  expect(score(forged).snapshot.counters.labelBorderCrossings).toBe(1);
}, 60000);

it('labelRunWindows cuts a run at the border margin of every drawn box it crosses, and along a side edge it runs by', () => {
  const owner = { kind: 'link' as const, id: 'link-1' };
  const boxes = [{ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 160, width: 100, height: 100 }];
  const reach = LINK_LABEL_GEOMETRY.borderMargin + DEFAULT_STROKE_WIDTHS.group / 2;
  const down = labelRunWindows(boxes, { from: { x: 50, y: 60 }, to: { x: 50, y: 200 }, owner })!;
  expect(down).toEqual([{ from: 68, to: 100 - reach }, { from: 100 + reach, to: 160 - reach }, { from: 160 + reach, to: 192 }]);
  // A run 3 px beside a side edge loses the edge's whole length, margins included.
  const beside = labelRunWindows(boxes, { from: { x: 103, y: -50 }, to: { x: 103, y: 300 }, owner })!;
  expect(beside).toEqual([{ from: -42, to: -reach }, { from: 100 + reach, to: 160 - reach }, { from: 260 + reach, to: 292 }]);
  // A diagonal has no axis.
  expect(labelRunWindows(boxes, { from: { x: 0, y: 0 }, to: { x: 50, y: 60 }, owner })).toBeUndefined();
});

it('a label with no window clear of a border keeps the midpoint and says so (LINK_LABEL_ON_BORDER)', () => {
  const model = bench(
    [{ id: 'source', bounds: { x: 0, y: 0, width: 40, height: 40 } }, { id: 'target', bounds: { x: 0, y: 140, width: 40, height: 40 } }],
    [{ id: 'link-1', from: 'source', to: 'target', label: 'a longer uplink', points: [{ x: 20, y: 40 }, { x: 20, y: 140 }] }], []);
  // A foreign box whose border lies across the run's middle, too close to either end for a window to hold the label.
  model.document.groups.wall = { label: 'wall', shape: 'row', tier: 0 };
  model.groups.wall = { id: 'wall', owner: { kind: 'group', id: 'wall' }, layer: 'routed', nodes: ['source'], tier: 0, rowOrder: ['source'],
    bounds: { x: -100, y: 90, width: 400, height: 400 } };
  produceLinkLabels(model);
  const label = linkLabel(model);
  expect(label.omitted).toBeUndefined();
  expect(label.text).toBe('a longer uplink');
  expect(label.bounds!.y + label.bounds!.height / 2).toBeCloseTo(90, 9);
  expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ON_BORDER').map(item => item.owners)).toEqual([[{ kind: 'link', id: 'link-1' }]]);
});

it('labelWindowDeficit: the growth at the split after which one window of the run holds the label (ticket 19)', () => {
  const owner = { kind: 'link' as const, id: 'link-1' };
  const reach = LABEL_BORDER_REACH, margin = LINK_LABEL_GEOMETRY.shortenMargin;
  // A run down out of the upper box into the lower one: the window between the two borders is 60 - 2 × reach long.
  const boxes = [{ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 160, width: 100, height: 100 }];
  const run = { from: { x: 50, y: 60 }, to: { x: 50, y: 200 }, owner };
  expect(labelWindowDeficit(boxes, run, 30, 130)).toBe(0);
  expect(labelWindowDeficit(boxes, run, 60, 130)).toBeCloseTo(60 - (60 - 2 * reach), 9);
  // Everything beyond the split moves: the lower box and the run's lower end. A split before the upper border moves that border
  // too, so no window between the two borders grows.
  expect(labelWindowDeficit(boxes, run, 60, 50)).toBeUndefined();
  // A run along a row (x axis) behaves alike; the run's own end bounds a window the same way.
  const row = { from: { x: 60, y: 50 }, to: { x: 140, y: 50 }, owner };
  expect(labelWindowDeficit([{ x: 0, y: 0, width: 100, height: 100 }], row, 50, 120)).toBeCloseTo(50 - (140 - margin - (100 + reach)), 9);
  // A diagonal has no axis: stage 9 decides.
  expect(labelWindowDeficit(boxes, { from: { x: 0, y: 0 }, to: { x: 50, y: 60 }, owner }, 60, 30)).toBe(0);
  // The run's lower end on a pill that stands out above the lower box (y 150 < 160): with `farEndMoves` the split stays at the box
  // top, so the upper box (bottom 100) is not taken as moved, and the end still moves with its node. The window [100 + reach, 150 - 8]
  // grows by exactly the growth.
  const pill = { from: { x: 50, y: 60 }, to: { x: 50, y: 150 }, owner };
  const open = 150 - margin - (100 + reach);
  expect(labelWindowDeficit(boxes, pill, 60, 160, true)).toBeCloseTo(60 - open, 9);
  // Without it the end stays where it is and no window grows.
  expect(labelWindowDeficit(boxes, pill, 60, 160)).toBeUndefined();
});

for (const name of ['a-row-link-label-keeps-clear-of-both-group-borders', 'an-overlay-row-label-keeps-clear-of-both-group-borders',
  'a-side-lane-label-spans-the-collinear-pieces', 'a-link-drops-beside-a-frame-into-a-lateral-side']) {
  it(`placement reserves the label window on every run a label rides: ${name} (ticket 19)`, async () => {
    const model = await run(fixture(name));
    const label = linkLabel(model);
    expect(label.omitted).toBeUndefined();
    const owner = label.owner.kind === 'link' ? label.owner.id : undefined;
    expect(label.text).toBe(model.document.links[model.links.find(link => link.id === owner)!.sourceIndex]!.label);
    expect(groupBoxes(model).filter(box => labelCrossesBorder(label.bounds!, box.bounds)).map(box => box.id)).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ON_BORDER' || item.code === 'LINK_LABEL_ROOM_UNRESERVED')).toEqual([]);
    const report = score(model).snapshot;
    expect(report.counters.labelBorderCrossings).toBeUndefined();
    expect(Object.values(report.gates).filter(gate => gate.severity === 'error' && !gate.passed)).toEqual([]);
    // The reservation is at its fixed point: a replay on the published model reserves nothing more (R1).
    expect(reserveLinkLabelRoom(structuredClone(model))).toBe(false);
  }, 120000);
}

// Open (ticket 19): room across a run. An overlay detour over the row runs 4 px above the bodies in the top padding; the label
// beside it needs 20.25 px of padding and `GROUP_PADDING` is 20, so it touches the top border's stroke by 0.25 px.
it.fails('a label beside an overlay detour in a group padding stays clear of the border (ticket 19, open)', async () => {
  const model = await run(fixture('a-row-mesh-with-another-label-draws-plain-links'));
  expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ON_BORDER')).toEqual([]);
  expect(score(model).snapshot.counters.labelBorderCrossings).toBeUndefined();
}, 120000);

// Ticket 20: a turned label is tested by its turned rectangle, and placement reserves a window along the diagonal it lies on, clear
// of the borders and of the routed drop the line crosses.
it('a diagonal label rising past a third group stays clear of every border (ticket 20)', async () => {
  const model = await run(fixture('a-diagonal-label-rises-past-a-third-group'));
  expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ON_BORDER' || item.code === 'LINK_LABEL_ROOM_UNRESERVED')).toEqual([]);
  const report = score(model).snapshot;
  expect(report.counters.labelBorderCrossings).toBeUndefined();
  expect(Object.values(report.gates).filter(gate => gate.severity === 'error' && !gate.passed)).toEqual([]);
  const first = model.labels.find(label => label.id === 'label:link:link-2')!;
  expect(first.omitted).toBeUndefined();
  expect(first.onLine).toBe(true);
  expect(first.turnedSize).toBeDefined();
  // Its upright box still reaches a border; its turned rectangle does not.
  expect(groupBoxes(model).filter(box => labelCrossesBorder(labelArea(first), box.bounds))).toEqual([]);
  // The reservation is at its fixed point (R1).
  expect(reserveLinkLabelRoom(structuredClone(model))).toBe(false);
}, 120000);

it('labelRunWindows on a diagonal: the windows of a label on the line, clear of every border by the margin along the run (ticket 20)', () => {
  const owner = { kind: 'link' as const, id: 'link-1' };
  const boxes = [{ x: 0, y: 0, width: 100, height: 100 }, { x: 60, y: 200, width: 300, height: 100 }];
  const run = { from: { x: 50, y: 50 }, to: { x: 250, y: 250 }, owner }, across = 15, length = Math.hypot(200, 200);
  // With no height the diagonal still has no windows.
  expect(labelRunWindows(boxes, run)).toBeUndefined();
  const windows = labelRunWindows(boxes, run, across)!;
  // Inside the upper box, between the two boxes, inside the lower box.
  expect(windows.length).toBe(3);
  const window = windows[1]!;
  const halo = LINK_LABEL_GEOMETRY.halo, margin = LINK_LABEL_GEOMETRY.borderMargin;
  const box = (from: number, to: number) => ({ centre: { x: 50 + (from + to) / 2 / Math.SQRT2, y: 50 + (from + to) / 2 / Math.SQRT2 },
    width: to - from + 2 * halo, height: across, degrees: 45 });
  // Text wholly in the window: its turned box (with the halo) crosses no border; moved past the margin, it does.
  expect(boxes.some(item => labelCrossesBorder(box(window.from, window.to), item))).toBe(false);
  expect(boxes.some(item => labelCrossesBorder(box(window.from - margin - 0.5, window.from), item))).toBe(true);
  expect(boxes.some(item => labelCrossesBorder(box(window.to, window.to + margin + 0.5), item))).toBe(true);
  expect(window.to).toBeLessThan(length - LINK_LABEL_GEOMETRY.shortenMargin);
});

it('labelWindowDeficit on a diagonal: the least growth after which a window holds the label (ticket 20)', () => {
  const owner = { kind: 'link' as const, id: 'link-1' };
  const boxes = [{ x: 0, y: 0, width: 100, height: 100 }, { x: 60, y: 160, width: 300, height: 100 }];
  const run = { from: { x: 60, y: 60 }, to: { x: 200, y: 200 }, owner }, across = 15, extent = 100, split = 130;
  const turned = { across, axis: 'y' as const };
  // Without the label's height a diagonal is left to stage 9, as before.
  expect(labelWindowDeficit(boxes, run, extent, split, true)).toBe(0);
  const growth = labelWindowDeficit(boxes, run, extent, split, true, turned)!;
  expect(growth).toBeGreaterThan(0);
  const holds = (g: number) => labelRunWindows(boxes.map(box => box.y >= split ? { ...box, y: box.y + g } : box),
    { ...run, to: { ...run.to, y: run.to.y + g } }, across)!.some(window => windowHolds(window, extent));
  expect(holds(growth)).toBe(true);
  // Rounded up to the grain, and no more: a growth one grain and a hair less does not hold.
  expect(holds(growth - 2 * LABEL_WINDOW_GRAIN)).toBe(false);
});
