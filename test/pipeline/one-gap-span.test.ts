import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { chordSegment, isRoutedChord, rankBandBetween, spanCandidate } from '../../src/layout/frame-paths.js';
import { measureSpans, type SpanOffer } from '../../src/layout/span-measure.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
// The group lift (ticket 08) is off in these tests: with it, `exits` (it links to no lower tier) rises one band beside `ranked#1`, so no
// rank band stands between the ends of the two chords. `lift.test.ts` tests the lift.

/**
 * Architecture-2 ticket 35, part 1 (docs/design/routed-chords.md, Section 14.1). A link across one document tier gap whose ends stand on sub-tiers
 * that are not adjacent is a spanning-chord candidate; the rank band between its ends refuses it only where a wall stands in its corridor.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const ONE_GAP = 'a-link-across-one-document-tier-gap-is-straight-when-nothing-stands-on-it';
const STILL = 'a-span-corridor-passes-a-lane-beside-a-unit-it-does-not-move';
// Since architecture-2 ticket 65 the shared-end sheet offers no span link; this sheet offers link-1, and one re-run is kept.
const KEPT = 'own-lane-is-an-obstacle';
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true };
interface Run { model: LayoutModel; offer: SpanOffer | undefined; base: LayoutModel | undefined; routedBase: LayoutModel | undefined }
const run = async (name: string, extra: Record<string, unknown> = {}): Promise<Run> => {
  let offer: SpanOffer | undefined, base: LayoutModel | undefined, routedBase: LayoutModel | undefined;
  const model = await layout(parse(source(name)), { ...options, ...extra,
    testSideTrace: event => { if (event.ev === 'spans') { offer = event.offer as SpanOffer; base = event.base as LayoutModel; routedBase = event.routedBase as LayoutModel; } } });
  return { model, offer, base, routedBase };
};
const link = (model: LayoutModel, id: string): LayoutLink => model.links.find(item => item.id === id)!;
const refusals = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'ROUTED_CHORD_REFUSED')
  .map(item => `${item.owners?.map(owner => 'id' in owner ? owner.id : owner.kind).join(',')}:${item.message.replace(/^.*: /, '').replace('.', '')}`);
const gates = (model: LayoutModel): void => {
  for (const [id, gate] of Object.entries(score(model).snapshot.gates)) expect([id, gate.violations]).toEqual([id, []]);
};
/** The links of `branch` to the exit row: m1 and m2 of `b-main`. */
const SPANS = ['link-5', 'link-6'];
/** The same two links on `STILL`, where the canonical order numbers them 8 and 9. */
const STILL_SPANS = ['link-8', 'link-9'];

describe('part 1: a link across one document tier gap with a rank band between its ends', () => {
  it('is a spanning-chord candidate; a link between adjacent sub-tiers is not', async () => {
    const { model } = await run(ONE_GAP, { testSpanHints: [] });
    for (const id of SPANS) {
      expect(rankBandBetween(model, link(model, id)), id).toBe(true);
      expect(spanCandidate(model, link(model, id)), id).toBe(true);
    }
    // r-tail (sub-tier 2) to x-tail (sub-tier 3), and the entry to the branch: adjacent sub-tiers.
    for (const id of ['link-4', 'link-2']) {
      expect(rankBandBetween(model, link(model, id)), id).toBe(false);
      expect(spanCandidate(model, link(model, id)), id).toBe(false);
    }
  }, 60000);

  it('without the span round keeps both links on their transit lanes, named transit', async () => {
    const { model } = await run(ONE_GAP, { testSpanHints: [] });
    for (const id of SPANS) expect(isRoutedChord(model, link(model, id)), id).toBe(false);
    expect(refusals(model).filter(item => SPANS.some(id => item.startsWith(`${id}:`)))).toEqual(['link-5:transit', 'link-6:transit']);
  }, 60000);

  it('takes both chords: SPAN_CHORD_TAKEN twice, a span corridor and no transit lane in sub-tier 2, routed bent 0, every gate passes', async () => {
    const { model, offer } = await run(ONE_GAP);
    expect(offer!.links).toEqual(SPANS);
    for (const id of SPANS) {
      const item = link(model, id);
      expect(item.spanHint, id).toBe(true);
      expect(isRoutedChord(model, item), id).toBe(true);
      expect(pathBends(item), id).toBe(0);
      expect(model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === id).map(lane => [lane.kind, lane.tier])).toEqual([['span', 2]]);
    }
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN').map(item => item.owners)).toEqual(SPANS.map(id => [{ kind: 'link', id }]));
    expect(refusals(model)).toEqual([]);
    expect(score(model).snapshot.counts.routed.bent).toBe(0);
    gates(model);
  }, 60000);

  it('reads the walls, not the band: the band clear of the corridor offers the chord, a body moved into it refuses', async () => {
    const { base, routedBase, offer } = await run(ONE_GAP);
    expect(offer!.refused.size).toBe(0);
    // Move `r-tail` (the one unit of the rank band of sub-tier 2) onto the chord of link-5 in that band.
    const moved = structuredClone(base!), band = moved.tierBands.find(item => item.tier === 2)!.bounds!;
    const chord = chordSegment(moved, link(moved, 'link-5'))!, y = band.y + band.height / 2;
    const at = chord.from.x + (chord.to.x - chord.from.x) * (y - chord.from.y) / (chord.to.y - chord.from.y);
    const node = moved.nodes['r-tail']!, dx = at - (node.bounds!.x + node.bounds!.width / 2);
    node.bounds!.x += dx;
    for (const port of node.ports) { if (port.anchor) port.anchor.x += dx; if (port.pill) port.pill.bounds.x += dx; }
    moved.groups['ranked#1']!.bounds!.x += dx;
    const walled = measureSpans(moved, routedBase!);
    expect(['body', 'pill', 'frame', 'corridor', 'lane']).toContain(walled.refused.get('link-5'));
    expect(walled.links).not.toContain('link-5');
  }, 60000);

  it('when the re-runs are spent: no hint, both links keep transit, one SPAN_ROUND_SKIPPED names them', async () => {
    const { model } = await run(ONE_GAP, { testMaxReruns: 0 });
    expect(model.links.some(item => item.spanHint !== undefined)).toBe(false);
    expect(model.lanes.some(lane => lane.kind === 'span')).toBe(false);
    expect(refusals(model).filter(item => SPANS.some(id => item.startsWith(`${id}:`)))).toEqual(['link-5:transit', 'link-6:transit']);
    const skipped = model.diagnostics.filter(item => item.code === 'SPAN_ROUND_SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.severity).toBe('info');
    expect(skipped[0]!.owners).toEqual(SPANS.map(id => ({ kind: 'link', id })));
    expect(skipped[0]!.message).toMatch(/0 placement re-runs|made its 0 placement re-runs/);
  }, 60000);

  it('when re-runs are left but kept for the later rounds: the skip says so and names the offered link', async () => {
    // The sheet offers link-1; with one re-run, its course, side and turn rounds hold the re-run that is left.
    const { model } = await run(KEPT, { testMaxReruns: 1 });
    expect(model.links.some(item => item.spanHint !== undefined)).toBe(false);
    const skipped = model.diagnostics.filter(item => item.code === 'SPAN_ROUND_SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.severity).toBe('info');
    expect(skipped[0]!.owners).toEqual([{ kind: 'link', id: 'link-1' }]);
    expect(skipped[0]!.message).toMatch(/the [12] placement re-runs? left (is|are) kept for the course, side and turn rounds\. The link link-1 keeps its lane\./);
  }, 60000);

  it('opens a corridor beside a unit it does not move, though an earlier lane reaches into that unit\'s wall: both chords taken, every gate passes', async () => {
    // Before the fix 7a judged the unmoved `ranked#1` against the lane of link-5 and refused the corridor (span-refused, placement).
    const { model, base } = await run(STILL);
    for (const id of STILL_SPANS) {
      const item = link(model, id);
      expect(item.spanHint, id).toBe(true);
      expect(isRoutedChord(model, item), id).toBe(true);
      expect(pathBends(item), id).toBe(0);
      expect(model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === id).map(lane => [lane.kind, lane.tier])).toEqual([['span', 2]]);
    }
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN').map(item => item.owners)).toEqual(STILL_SPANS.map(id => [{ kind: 'link', id }]));
    // The premise, read where the span round measures: the two links into one port hold transit lanes in sub-tier 2. Snack-theme ticket 159 (an engine
    // fix, not the card: it holds with stacked nodes): the course round, after the span round, takes link-5 round the outside (the node floor of a
    // moved end now holds its content, `movedFloor`), so the published model keeps the transit lane of link-6 only; before, the course trial was
    // refused and both lanes published.
    const transit = (model: LayoutModel, id: string): boolean => model.lanes.some(lane => lane.owner.kind === 'link' && lane.owner.id === id && lane.tier === 2 && lane.kind !== 'span');
    for (const id of ['link-5', 'link-6']) expect(transit(base!, id), id).toBe(true);
    expect(transit(model, 'link-6')).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'COURSE_TAKEN').map(item => item.owners)).toEqual([[{ kind: 'link', id: 'link-5' }]]);
    gates(model);
  }, 60000);
});
