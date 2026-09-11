import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bars, bundles, centre, flanks, lanes, layout, parse, rows, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const anchorOf = (model: LayoutModel, ref: { node: string; name?: string }) =>
  model.nodes[ref.node]!.ports.find(port => port.ref.name === ref.name)!.anchor!;

/** One straight vertical line from anchor to anchor: every segment vertical at one x, contiguous. */
function expectStraightDrop(model: LayoutModel, id: string): void {
  const link = model.links.find(link => link.id === id)!;
  const from = anchorOf(model, link.attachments!.from), to = anchorOf(model, link.attachments!.to);
  expect([id, to.x]).toEqual([id, from.x]);
  const segments = link.path!.segments;
  expect(segments.length, id).toBeGreaterThanOrEqual(1);
  expect(segments[0]!.from, id).toEqual(from);
  expect(segments.at(-1)!.to, id).toEqual(to);
  for (const [index, segment] of segments.entries()) {
    expect([id, index, segment.from.x, segment.to.x]).toEqual([id, index, from.x, from.x]);
    if (index) expect([id, index, segment.from]).toEqual([id, index, segments[index - 1]!.to]);
  }
}

// Ticket 19: a link that transits the tier above its target is a feed of that target (stage 7c).
// The child port sits under the owned lane x, so the whole drop is one vertical segment.
const synthetic = new URL('../../goldens/synthetic/both-margins-full.yaml', import.meta.url);

it('aligns both transit targets under their lanes so the full-pipeline feeds are straight', async () => {
  const model = await run(readFileSync(synthetic, 'utf8'));
  for (const id of ['link-1', 'link-2']) {
    const link = model.links.find(link => link.id === id)!;
    const lane = model.lanes.find(lane => lane.owner.kind === 'link' && lane.owner.id === id)!;
    expect([id, lane.x]).toEqual([id, anchorOf(model, link.attachments!.from).x]);
    expectStraightDrop(model, id);
  }
  expect(model.diagnostics.filter(d => d.code === 'PLACEMENT_NON_CONVERGENCE' || d.code === 'CENTRE_ALIGNMENT_INFEASIBLE')).toEqual([]);
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(report.Q).toBeGreaterThan(0.64);
}, 60000);

it('keeps the drops straight when the lower tier is the anchor, so the lane follows the fixed target', async () => {
  // Codex reproducer 1: an extra lower node makes tier 2 the anchor; the upper sources must move.
  const model = await run(readFileSync(synthetic, 'utf8').replace('nodes:\n', 'nodes:\n  anchor-extra: { group: lower }\n'));
  expect(model.anchorTier).toBe(2);
  for (const id of ['link-1', 'link-2']) {
    const link = model.links.find(link => link.id === id)!;
    const lane = model.lanes.find(lane => lane.owner.kind === 'link' && lane.owner.id === id)!;
    expect([id, lane.x]).toEqual([id, anchorOf(model, link.attachments!.to).x]);
    expectStraightDrop(model, id);
  }
  expect(model.diagnostics.filter(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toEqual([]);
}, 60000);

it('keeps the drops straight when the authored source is the movable lower end', async () => {
  // Codex reproducer 2: reversed declarations; the lane still aligns to the fixed upper end.
  const yaml = readFileSync(synthetic, 'utf8')
    .replace('[source-left.p, target-left.p]', '[target-left.p, source-left.p]')
    .replace('[source-right.p, target-right.p]', '[target-right.p, source-right.p]');
  const model = await run(yaml);
  expect(model.anchorTier).toBe(0);
  for (const id of ['link-1', 'link-2']) {
    const link = model.links.find(link => link.id === id)!;
    expect(link.attachments!.from.node.startsWith('target')).toBe(true);
    const lane = model.lanes.find(lane => lane.owner.kind === 'link' && lane.owner.id === id)!;
    expect([id, lane.x]).toEqual([id, anchorOf(model, link.attachments!.to).x]);
    expectStraightDrop(model, id);
  }
}, 60000);

it('makes one child of a one-port fan vertical under its lane and reports the rest as fan remainders', async () => {
  // Codex finding 3 asked for a one-port fan through distinct non-bundle lanes. Lanes pack at lane
  // width, so two default-width children cannot both sit under their lanes: the first child by x
  // is vertical, the other is a fan remainder, and centring converges instead of exhausting itself.
  const model = await run(`portograph: 2
groups: {up: {tier: 0}, mid: {tier: 1}, low: {tier: 2}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  s1: {group: up}
  s2: {group: up}
  m: {group: mid}
  c1: {group: low, ports: [{name: p, side: top}]}
  c2: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, c1.p], [a.p, c2.p]]`);
  expect(model.anchorTier).toBe(0);
  expect(model.lanes.map(lane => [lane.owner.kind === 'link' ? lane.owner.id : null, lane.tier])).toEqual([['link-1', 1], ['link-2', 1]]);
  const [first, second] = model.lanes;
  expect(first!.x).toBe(anchorOf(model, { node: 'a', name: 'p' }).x);
  expect(second!.x).toBeGreaterThan(first!.x);
  expectStraightDrop(model, 'link-1');
  expect(anchorOf(model, { node: 'c2', name: 'p' }).x).not.toBe(second!.x);
  const codes = model.diagnostics.filter(d => d.stage === 'placement').map(d => d.code);
  expect(codes).toContain('CENTRE_FAN_REMAINDER');
  expect(codes).not.toContain('PLACEMENT_NON_CONVERGENCE');
  expect(codes).not.toContain('CENTRE_ALIGNMENT_INFEASIBLE');
  // Gates and crossings are not asserted here: the shared stem of a non-bundle fan fails G4/G6 on
  // every fan fixture, adjacent or transit (ticket 20). This test owns placement, not that stem.
}, 60000);

it('lets a transit yield to the adjacent feed of a shared child port instead of exhausting the budget', async () => {
  // The lower tier is the anchor, so the mirror step centres the top group over its children: one
  // adjacent feed (m.p) and three transit lanes all reach a.p at different x.
  const yaml = `portograph: 2
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
  // Links 1 and 2 are bundle members, which stage 7e owns, so only link-3 is a transit feed here
  // and it yields to the adjacent feed. Stage 7e may later move a.p for its members; that is its call.
  const model = centre(flanks(lanes(rows(await placed(yaml)))));
  expect(model.anchorTier).toBe(2);
  expect(model.links.map(link => link.bundle ?? null)).toEqual(['bundle-1', 'bundle-1', null, null]);
  expect(model.nodes.a!.ports[0]!.anchor!.x).toBe(model.nodes.m!.ports[0]!.anchor!.x);
  expect(model.diagnostics.filter(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toEqual([]);
  const yielded = model.diagnostics.filter(d => d.code === 'CENTRE_FAN_REMAINDER' && /shares its child port/.test(d.message));
  expect(yielded.map(d => d.owners?.map(owner => 'id' in owner ? owner.id : owner.kind))).toEqual([['link-3']]);
  // The full placement still converges once bundles have claimed their members.
  expect(bundles(bars(model)).diagnostics.filter(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toEqual([]);
}, 60000);

it('reserves a clear aligned feed corridor before placing the group label (label-no-gap)', async () => {
  // Maintainer critique: the child-group label sat on the future straight route and the router
  // detoured around it. Stage 7f now reserves the corridor; the label moves aside and the group widens.
  const model = await run(readFileSync(new URL('../../goldens/synthetic/label-no-gap.yaml', import.meta.url), 'utf8'));
  const link = model.links.find(link => link.id === 'link-2')!;
  expectStraightDrop(model, 'link-2');
  expect(link.path!.segments).toHaveLength(1);
  const label = model.labels.find(label => label.id === 'label:group:child-group')!.bounds!;
  const x = anchorOf(model, link.attachments!.from).x;
  expect(label.x > x + 0.75 || label.x + label.width < x - 0.75).toBe(true);
  const group = model.groups['child-group']!.bounds!;
  expect(label.x).toBeGreaterThanOrEqual(group.x + 8 - 1e-6);
  expect(label.x + label.width).toBeLessThanOrEqual(group.x + group.width - 8 + 1e-6);
  expect(model.diagnostics.filter(d => d.code === 'GROUP_LABEL_GAP_INFEASIBLE')).toEqual([]);
  const report = score(model).snapshot;
  expect(report.passed).toBe(true);
  expect(report.Q).toBeGreaterThan(0.7);
}, 60000);
