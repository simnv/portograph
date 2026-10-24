import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { LayoutLink, LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { chordKind, frameLinkCandidate, isRoutedChord } from '../../src/layout/frame-paths.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const swap = 'overlay-links-reorder-two-canton-groups';
const refused = 'a-canton-group-swap-is-refused-for-routed-crossings';
const between = 'a-foreign-unit-between-two-canton-groups';
const adversarial = 'a-foreign-unit-with-routed-links-to-two-canton-groups';
const routedOnly = 'a-foreign-unit-between-two-canton-groups-routed-only';
const members = 'overlay-links-reorder-two-members-of-a-canton-group';
const membersRefused = 'a-member-order-is-refused-for-routed-crossings';
const transit = 'a-transit-inside-a-canton';
const across = 'a-link-between-two-members-of-a-canton-group';
/** The same input with the three links between the members orthogonal: the row plan of the gap between two members reads no chord. */
const acrossOrthogonal = (): string => fixture(across).replace(/^( {2}- \[s\d, l\d)\]/gm, '$1, { route: orthogonal }]');

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const lay = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const run = (name: string): Promise<LayoutModel> => lay(fixture(name));
/** The same layout with the order of frames switched off: what ELK and the packing leave. */
async function runWithoutRule(text: string): Promise<LayoutModel> {
  vi.resetModules();
  vi.doMock('../../src/layout/overlay-order.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/layout/overlay-order.js')>(), orderFramesByOverlay: () => false,
  }));
  try {
    const api = await import('../../src/internal.js');
    return await api.layout(api.parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  } finally {
    vi.doUnmock('../../src/layout/overlay-order.js');
    vi.resetModules();
  }
}
const right = (box: Rect): number => box.x + box.width;
const frame = (model: LayoutModel, id: string): Rect => model.frames!.find(item => item.id === id)!.box;
const errors = (model: LayoutModel) => model.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
const refusals = (model: LayoutModel) => model.diagnostics.filter(diagnostic => diagnostic.code === 'OVERLAY_ORDER_REFUSED');
const holds = (outer: Rect, inner: Rect): boolean => outer.x <= inner.x + 1e-6 && right(outer) >= right(inner) - 1e-6;
const overlay = (model: LayoutModel): LayoutLink[] => model.links.filter(link => link.layer === 'overlay');
const geometry = (model: LayoutModel): unknown => ({
  groups: Object.values(model.groups).map(group => [group.id, group.bounds, group.rowOrder]),
  frames: model.frames,
  nodes: Object.values(model.nodes).map(node => [node.id, node.bounds, node.ports.map(port => port.anchor)]),
  paths: model.links.map(link => [link.id, link.path]),
  codes: model.diagnostics.map(diagnostic => diagnostic.code),
});
/** The canton frames are disjoint columns, every member stands inside its canton, and the sheet passes G9. */
function expectColumns(model: LayoutModel): void {
  const cantons = model.frames!.filter(item => item.kind === 'canton');
  for (const [i, one] of cantons.entries()) for (const other of cantons.slice(i + 1)) {
    expect(one.box.x < right(other.box) - 1e-6 && other.box.x < right(one.box) - 1e-6, `${one.id} and ${other.id} share an x range`).toBe(false);
  }
  for (const item of model.frames!.filter(candidate => candidate.parent !== undefined && model.frames!.find(parent => parent.id === candidate.parent)?.kind === 'canton')) {
    expect(holds(frame(model, item.parent!), item.box), `${item.id} inside ${item.parent}`).toBe(true);
  }
  const report = score(model);
  expect(report.snapshot.gates.G9.violations).toEqual([]);
  expect(report.snapshot.gates.G9.passed).toBe(true);
}

describe('the overlay order of canton groups (canton-groups ticket 57)', () => {
  // Section 2 rule 9, the swap: a canton is one unit over its whole span, as a frame is in ticket 06b.
  it('swaps a canton as one unit over both its tiers, so the two cantons that share the dense sync links stand side by side', async () => {
    const off = await runWithoutRule(fixture(swap));
    // ELK and the pack leave cb between ca and cc.
    const [offA, offB, offC] = ['ca', 'cb', 'cc'].map(id => frame(off, id));
    expect(offA!.x < offB!.x && offB!.x < offC!.x).toBe(true);
    const model = await run(swap);
    expect(errors(model)).toEqual([]);
    const [a, b, c] = ['ca', 'cb', 'cc'].map(id => frame(model, id));
    expect(b!.x).toBeLessThan(a!.x);
    expect(a!.x).toBeLessThan(c!.x);
    // The order is the same on both tiers of the span: every member of cb stands left of every member of ca, and ca left of cc.
    for (const [left, farther] of [['b-site', 'a-site'], ['b-lab', 'a-lab'], ['a-site', 'c-site'], ['a-lab', 'c-lab']] as const) {
      expect(right(frame(model, left)), `${left} left of ${farther}`).toBeLessThanOrEqual(frame(model, farther).x);
    }
    // ca and cc are neighbours a band gap apart: nothing stands between them.
    expect(c!.x - right(a!)).toBeCloseTo(bandGap(model), 6);
    // The two sync links between the labs of ca and cc are one straight segment each, which ELK's order had blocked by cb.
    const syncs = overlay(model).filter(link => [link.attachments!.from.node, link.attachments!.to.node].sort().join() === 'a-sync,c-sync');
    expect(syncs).toHaveLength(2);
    for (const link of syncs) expect(link.path!.segments, link.id).toHaveLength(1);
    expect(refusals(model)).toEqual([]);
    expectColumns(model);
  }, 120000);

  // Section 2 rule 9, the refusal: ADR-0019's three conditions apply to a canton as to a frame.
  it('refuses the swap of cantons that would raise the routed crossings, with one warning', async () => {
    const model = await run(refused);
    expect(errors(model)).toEqual([]);
    const [a, b, c] = ['ca', 'cb', 'cc'].map(id => frame(model, id));
    expect(a!.x).toBeLessThan(b!.x);
    expect(b!.x).toBeLessThan(c!.x);
    const warned = refusals(model);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.severity).toBe('warning');
    expect(warned[0]!.message).toContain('routed crossings would rise from 0 to 1');
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
    expectColumns(model);
  }, 60000);

  // Section 2 rule 9, the inner order: members of one canton on one tier, the canton column as the walls.
  it('orders the members of a canton on one tier by the key, inside the canton column, and the canton does not move', async () => {
    const model = await run(members);
    expect(errors(model)).toEqual([]);
    const [alpha, beta, gamma] = ['alpha', 'beta', 'gamma'].map(id => frame(model, id));
    // Declaration order is alpha, beta, gamma; beta has the smallest key (the probe at the left end) and goes left.
    expect(right(beta!)).toBeLessThanOrEqual(alpha!.x);
    expect(right(alpha!)).toBeLessThanOrEqual(gamma!.x);
    // The members are 40 px apart (2 x group padding), as the pack leaves them.
    expect(alpha!.x - right(beta!)).toBeCloseTo(40, 6);
    expect(gamma!.x - right(alpha!)).toBeCloseTo(40, 6);
    // The row keeps its ends: the canton frame is the one the declaration order had.
    const west = frame(model, 'west'), off = frame(await runWithoutRule(fixture(members)), 'west');
    expect(west.x).toBeCloseTo(off.x, 6);
    expect(west.width).toBeCloseTo(off.width, 6);
    expect(holds(west, beta!) && holds(west, gamma!)).toBe(true);
    // The two links between alpha and gamma were blocked by beta and are one straight segment now.
    for (const link of overlay(model)) expect(link.path!.segments, link.id).toHaveLength(1);
    expect(refusals(model)).toEqual([]);
    expectColumns(model);
  }, 120000);

  it('refuses the inner order that would raise the routed crossings, names the members, and keeps the declaration order', async () => {
    const model = await run(membersRefused);
    expect(errors(model)).toEqual([]);
    const [alpha, beta] = ['alpha', 'beta'].map(id => frame(model, id));
    expect(right(alpha!)).toBeLessThanOrEqual(beta!.x);
    const warned = refusals(model);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain('the members of the canton west');
    expect(warned[0]!.message).toContain('routed crossings would rise from 0 to 1');
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
    expectColumns(model);
  }, 60000);

  // Section 2 rule 7: a foreign unit between two cantons goes before or after the run.
  it('moves a foreign unit that ELK left between two cantons after the run, on the side that holds more of its partners', async () => {
    const off = await runWithoutRule(fixture(between));
    // The start: ELK stands `mid` between the two cantons.
    expect(frame(off, 'ca').x).toBeLessThan(off.groups['mid']!.bounds!.x);
    expect(off.groups['mid']!.bounds!.x).toBeLessThan(frame(off, 'cb').x);
    const model = await run(between);
    expect(errors(model)).toEqual([]);
    const mid = model.groups['mid']!.bounds!, a = frame(model, 'ca'), b = frame(model, 'cb');
    // Two of its three overlay links end in cb: after the run.
    expect(mid.x).toBeGreaterThanOrEqual(right(b));
    // No empty room between the cantons: they are a band gap apart, on every tier of the span.
    expect(b.x - right(a)).toBeCloseTo(bandGap(model), 6);
    expect(refusals(model)).toEqual([]);
    expectColumns(model);
  }, 120000);

  // Review fix B1: the move is judged, and a unit with routed links into two cantons never leaves the run.
  it('refuses to move the foreign unit when the move would raise the routed crossings, and keeps ELK\'s order with one warning', async () => {
    // A routed feed from the middle of the anchor row: to either side of the run the feed would cross the feed of a canton.
    const text = fixture(between).replace('  - [core2, a-gw]\n', '  - [core2, a-gw]\n  - [core3, m-sw]\n');
    const model = await lay(text);
    expect(errors(model)).toEqual([]);
    const mid = model.groups['mid']!.bounds!, a = frame(model, 'ca'), b = frame(model, 'cb');
    expect(a.x).toBeLessThan(mid.x);
    expect(right(mid)).toBeLessThanOrEqual(b.x);
    const warned = refusals(model);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain('the foreign mid beside the cantons ca, cb');
    expect(warned[0]!.message).toContain('routed crossings would rise from 0 to 1');
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
  }, 120000);

  it('keeps a foreign unit with routed links into both cantons between them: no route passes through a canton, and every gate passes', async () => {
    const off = await runWithoutRule(fixture(adversarial));
    const model = await run(adversarial);
    expect(errors(model)).toEqual([]);
    const mid = model.groups['mid']!.bounds!, a = frame(model, 'ca'), b = frame(model, 'cb');
    expect(a.x).toBeLessThan(mid.x);
    expect(right(mid)).toBeLessThanOrEqual(b.x);
    const warned = refusals(model);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain('the foreign mid beside the cantons ca, cb');
    expect(warned[0]!.message).toContain('more than one canton');
    const report = score(model).snapshot;
    expect(Object.entries(report.gates).filter(([, gate]) => !gate.passed).map(([name]) => name)).toEqual([]);
    expect(report.metrics.crossings.count).toBe(0);
    // ELK's order stands: the layout is the one of the rule switched off.
    expect(frame(off, 'ca').x).toBeCloseTo(a.x, 6);
    expect(off.groups['mid']!.bounds!.x).toBeCloseTo(mid.x, 6);
  }, 120000);

  // Review fix B2: rule 7 needs no overlay link; the routed partners are the side key.
  it('moves a foreign unit out of the run with no overlay link in the sheet, on the side of its feed', async () => {
    const off = await runWithoutRule(fixture(routedOnly));
    expect(frame(off, 'ca').x).toBeLessThan(off.groups['mid']!.bounds!.x);
    expect(off.groups['mid']!.bounds!.x).toBeLessThan(frame(off, 'cb').x);
    const model = await run(routedOnly);
    expect(errors(model)).toEqual([]);
    expect(overlay(model)).toEqual([]);
    const mid = model.groups['mid']!.bounds!, a = frame(model, 'ca'), b = frame(model, 'cb');
    expect(mid.x).toBeGreaterThanOrEqual(right(b));
    expect(b.x - right(a)).toBeCloseTo(bandGap(model), 6);
    // No 180 px case: the cantons keep no jog beyond the few px a band gap costs (the rule off leaves 137 px).
    for (const item of model.diagnostics.filter(diagnostic => diagnostic.code === 'COLUMN_AXIS_HELD')) expect(Number(/jog of ([\d.]+) px/.exec(item.message)![1])).toBeLessThan(10);
    expect(model.diagnostics.map(item => item.code)).not.toContain('CENTRE_TIER_PACK_INFEASIBLE');
    expect(refusals(model)).toEqual([]);
    const report = score(model).snapshot;
    expect(Object.entries(report.gates).filter(([, gate]) => !gate.passed).map(([name]) => name)).toEqual([]);
    expectColumns(model);
  }, 120000);

  // Section 4 rule 1: lanes, one level up.
  it('holds an intra-canton lane inside the canton frame and stands a foreign lane outside it at one x for the whole span', async () => {
    const model = await run(transit);
    expect(errors(model)).toEqual([]);
    const west = frame(model, 'west');
    const own = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === 'link-4');
    const foreign = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === 'link-5');
    // The link from gate-a to deep-a skips the tier of `mid`: its lane stands inside the canton frame.
    expect(own).toHaveLength(1);
    expect(holds(west, own[0]!.bounds)).toBe(true);
    // The link from `top` to `sink` is foreign to the canton: one lane per tier of the span, all at one x, outside the frame.
    expect(foreign).toHaveLength(3);
    expect(new Set(foreign.map(lane => lane.bounds.x)).size).toBe(1);
    expect(right(foreign[0]!.bounds)).toBeLessThanOrEqual(west.x + 1e-6);
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  // Q108 (ticket 99) supersedes Section 4 rule 2: members are sibling frames, so a link between two members on consecutive tiers is a cross-frame
  // candidate and takes its chord where it is clear. Rule 4 stands: the tier-gap plan does not read the canton.
  it('gives a chord to a link between two members where it is clear, and every gate passes', async () => {
    const model = await run(across);
    expect(errors(model)).toEqual([]);
    const crossing = model.links.filter(link => ['link-4', 'link-5', 'link-6'].includes(link.id));
    expect(crossing).toHaveLength(3);
    for (const link of crossing) {
      expect(chordKind(model, link), link.id).toBe('cross');
      expect(isRoutedChord(model, link), link.id).toBe(true);
      expect(link.technique, link.id).toBe('straight');
    }
    const report = score(model).snapshot;
    for (const [id, gate] of Object.entries(report.gates)) expect([id, gate.violations]).toEqual([id, []]);
  }, 60000);

  it('keeps the planned row of a link between two members that stays orthogonal', async () => {
    const model = await lay(acrossOrthogonal());
    expect(errors(model)).toEqual([]);
    const crossing = model.links.filter(link => ['link-4', 'link-5', 'link-6'].includes(link.id));
    expect(crossing).toHaveLength(3);
    for (const link of crossing) {
      expect(frameLinkCandidate(model, link), link.id).toBe(false);
      expect(isRoutedChord(model, link), link.id).toBe(false);
      expect(link.technique, link.id).not.toBe('straight');
    }
    // The plan of the gap between the two tiers, read where the placement leaves it, seats each link on its rows; the published path keeps them.
    const stage = bands(bundles(bars(centre(flanks(lanes(rows(await placed(acrossOrthogonal()))))))));
    const gap = tierGapPlans(stage).find(item => item.gap.above === 1 && item.gap.below === 2)!;
    expect(gap.plan.parts).toHaveLength(3);
    for (const part of gap.plan.parts) {
      const link = model.links.find(item => item.id === part.link)!;
      const ys = link.path!.segments.filter(segment => Math.abs(segment.from.y - segment.to.y) < 1e-6).map(segment => segment.from.y);
      for (const row of part.rows) expect(ys.some(y => Math.abs(y - row) < 1e-6), `${part.link} keeps its row ${row}`).toBe(true);
    }
  }, 60000);

  it('plans the gap between two members as the same gap without the canton', async () => {
    const stage = bands(bundles(bars(centre(flanks(lanes(rows(await placed(acrossOrthogonal()))))))));
    const plan = (model: LayoutModel) => tierGapPlans(model).map(({ gap, plan: one }) => ({ gap, growth: one.growth, parts: one.parts }));
    const withCanton = plan(stage);
    expect(withCanton.find(item => item.gap.above === 1)!.parts).toHaveLength(3);
    // The same boxes and ports with the canton taken out of the document: the members are top-level frames.
    const copy = structuredClone(stage);
    const frames = copy.document.frames!;
    for (const id of Object.keys(frames)) {
      if (frames[id]!.kind === 'canton') delete frames[id];
      else delete frames[id]!.parent;
    }
    expect(Object.values(frames).some(item => item.kind === 'canton')).toBe(false);
    expect(plan(copy)).toEqual(withCanton);
  }, 60000);

  it.each([swap, refused, between, adversarial, routedOnly, members, membersRefused, transit, across])('is deterministic on %s', async name => {
    const one = await run(name), two = await run(name);
    expect(geometry(two)).toEqual(geometry(one));
  }, 120000);
});
