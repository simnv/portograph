import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { chordKind, documentTierGap, spanCandidate } from '../../src/layout/frame-paths.js';
import { measureSpans, spanVerdict, type SpanOffer } from '../../src/layout/span-measure.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 22, spanning chords (docs/design/routed-chords.md, Section 14). Phase 1: the shapes, the corridor reader and the shadow offer, which
 * changes no diagram. A test under `it.fails` states the outcome of a later phase and fails today on purpose; the phase that reaches it makes it live.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const SHEETS = {
  mesh: 'a-mesh-across-a-middle-tier-draws-straight-chords-beside-its-frame',
  three: 'a-chord-over-three-tier-gaps-passes-two-middle-tiers',
  wide: 'a-link-over-a-wide-middle-frame-keeps-its-lane',
  share: 'a-chord-and-a-lane-share-a-middle-tier',
  label: 'a-labelled-chord-across-a-middle-tier-keeps-its-label-on-the-line',
};
interface Run { model: LayoutModel; offer: SpanOffer | undefined; base: LayoutModel | undefined }
const run = async (name: string): Promise<Run> => {
  let offer: SpanOffer | undefined, base: LayoutModel | undefined;
  const model = await layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    testSideTrace: event => { if (event.ev === 'spans') { offer = event.offer as SpanOffer; base = event.base as LayoutModel; } } });
  return { model, offer, base };
};
const link = (model: LayoutModel, n: number): LayoutLink => model.links.find(item => item.id === `link-${n}`)!;
const hinted = (item: LayoutLink): LayoutLink => ({ ...item, spanHint: true });

describe('chordKind of a hinted link', () => {
  it('reads a hinted link on tiers 0 and 2 as a cross-frame chord, and an unhinted one as none', async () => {
    const { model } = await run(SHEETS.mesh);
    const mesh = link(model, 3);
    expect(documentTierGap(model, mesh)).toBe(2);
    expect(chordKind(model, mesh)).toBeUndefined();
    expect(chordKind(model, hinted(mesh))).toBe('cross');
    expect(spanCandidate(model, mesh)).toBe(true);
  }, 60000);

  it('is no candidate on consecutive tiers, and a hint there changes nothing', async () => {
    const { model } = await run(SHEETS.mesh);
    const near = link(model, 1);
    expect(documentTierGap(model, near)).toBeUndefined();
    expect(spanCandidate(model, near)).toBe(false);
    expect(chordKind(model, hinted(near))).toBe(chordKind(model, near));
  }, 60000);
});

describe('the shadow offer (measureSpans)', () => {
  it('offers the nine mesh links of case 04 and none of the two tier-gap links', async () => {
    const { offer } = await run(SHEETS.mesh);
    expect(offer!.candidates).toEqual(['link-3', 'link-4', 'link-5', 'link-6', 'link-7', 'link-8', 'link-9', 'link-10', 'link-11']);
    expect(offer!.links).toEqual(offer!.candidates);
    expect([...offer!.refused]).toEqual([]);
  }, 60000);

  it('offers the one bent link over three tier gaps', async () => {
    const { offer } = await run(SHEETS.three);
    expect(offer!.links).toEqual(['link-4']);
  }, 60000);

  it('refuses a link over a wide middle frame with the frame wall, and offers nothing', async () => {
    const { offer } = await run(SHEETS.wide);
    expect(offer!.links).toEqual([]);
    expect([...offer!.refused]).toEqual([['link-1', 'frame']]);
  }, 60000);

  it('offers the link with a clear corridor and refuses the one that would cross a middle frame', async () => {
    const { offer } = await run(SHEETS.share);
    expect(offer!.links).toHaveLength(1);
    expect(offer!.refused.size).toBe(1);
    expect([...offer!.refused.values()]).toEqual(['frame']);
  }, 60000);

  it('is empty when no candidate is bent today', async () => {
    const { base, model } = await run(SHEETS.mesh);
    // The same sheet with every candidate drawn straight reads as an empty offer: nothing a chord could lower.
    const straight = { ...model, links: model.links.map(item => item.layer === 'routed' ? { ...item, path: { ...item.path!, segments: [item.path!.segments[0]!] } } : item) };
    expect(measureSpans(base!, straight).links).toEqual([]);
    expect(measureSpans(base!, model).links).toHaveLength(9);
  }, 60000);

  it('removes the lanes of the offered links on its own copy, and leaves the baseline alone', async () => {
    const { base, model } = await run(SHEETS.mesh);
    const lanes = base!.lanes.length;
    measureSpans(base!, model);
    expect(base!.lanes).toHaveLength(lanes);
    expect(lanes).toBe(9);
  }, 60000);

  it('changes no diagram: the lanes stay and the result is the baseline', async () => {
    const { model } = await run(SHEETS.mesh);
    expect(model.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toHaveLength(9);
    expect(model.links.some(item => item.spanHint !== undefined)).toBe(false);
    expect(model.freeze?.spans).toBeUndefined();
  }, 60000);
});

describe('the corridor reader (spanVerdict)', () => {
  it('refuses a chord whose corridor is closed', async () => {
    const { base } = await run(SHEETS.wide);
    // On the baseline itself the lane of the link is still a wall; the offer reads the copy without it, and names the frame (above).
    expect('reason' in spanVerdict(base!, link(base!, 1))).toBe(true);
  }, 60000);

  it('passes a chord whose corridor is clear, and reads overlay geometry as no wall', async () => {
    const { base } = await run(SHEETS.three);
    expect('segment' in spanVerdict(base!, link(base!, 4))).toBe(true);
  }, 60000);

  it('lets two chords that cross strictly stand, and refuses two that run side by side under the clearance', async () => {
    const { base, model } = await run(SHEETS.mesh);
    const offer = measureSpans(base!, model);
    // Held chords never refuse each other when they cross strictly; whatever they keep apart is recorded as crowded, to be decided by the trial.
    expect(offer.links).toHaveLength(9);
    expect([...offer.crowded.values()].every(reason => reason === 'chord' || reason === 'leg')).toBe(true);
  }, 60000);
});

describe('restore', () => {
  it('refuses a span hint that the freeze does not list', async () => {
    const { model } = await run(SHEETS.mesh);
    const tampered = JSON.parse(JSON.stringify(model)) as LayoutModel;
    tampered.links.find(item => item.id === 'link-3')!.spanHint = true;
    expect(() => restoreFinalLayout(JSON.stringify(tampered))).toThrow(/span hints/i);
  }, 60000);

  it('refuses a span hint on a link that is no candidate', async () => {
    const { model } = await run(SHEETS.mesh);
    const tampered = JSON.parse(JSON.stringify(model)) as LayoutModel;
    tampered.links.find(item => item.id === 'link-1')!.spanHint = true;
    tampered.freeze!.spans = ['link-1'];
    expect(() => restoreFinalLayout(JSON.stringify(tampered))).toThrow(/no spanning-chord candidate/);
  }, 60000);

  it('refuses a frozen span list that names a link without the hint', async () => {
    const { model } = await run(SHEETS.mesh);
    const tampered = JSON.parse(JSON.stringify(model)) as LayoutModel;
    tampered.freeze!.spans = ['link-3'];
    expect(() => restoreFinalLayout(JSON.stringify(tampered))).toThrow(/span hints/i);
  }, 60000);

  it('restores a published layout that carries no span hint', async () => {
    const { model } = await run(SHEETS.three);
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 60000);
});

describe('what the later phases reach (pending)', () => {
  it.fails('04 copy: nine spanning chords, no transit lane, SPAN_CHORD_TAKEN nine times, bent 2, turns 4', async () => {
    const { model } = await run(SHEETS.mesh);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN')).toHaveLength(9);
    expect(model.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toEqual([]);
    expect(model.links.filter(item => item.layer === 'routed' && (pathBends(item) ?? 0) > 0)).toHaveLength(2);
    expect(score(model).snapshot.metrics.bends.total).toBe(4);
  }, 60000);

  it.fails('three tier gaps: one chord, two span corridors', async () => {
    const { model } = await run(SHEETS.three);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN')).toHaveLength(1);
    expect(model.lanes.filter(lane => lane.kind === 'span')).toHaveLength(2);
  }, 60000);

  it('wide middle frame: no offer, no hint, the sheet keeps its lane', async () => {
    const { model } = await run(SHEETS.wide);
    expect(model.links.some(item => item.spanHint !== undefined)).toBe(false);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN')).toEqual([]);
    expect(model.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toHaveLength(1);
  }, 60000);

  it.fails('a chord and a lane share a middle tier: one chord, one lane outside the corridor', async () => {
    const { model } = await run(SHEETS.share);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN')).toHaveLength(1);
    expect(model.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toHaveLength(1);
  }, 60000);

  it.fails('a labelled chord keeps its label on the line, G3 passes, and the corridor is widened by the label', async () => {
    const { model } = await run(SHEETS.label);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN')).toHaveLength(1);
    expect(score(model).snapshot.gates.G3!.passed).toBe(true);
    expect(model.lanes.filter(lane => lane.kind === 'span').every(lane => lane.bounds.width > 0)).toBe(true);
  }, 60000);
});
