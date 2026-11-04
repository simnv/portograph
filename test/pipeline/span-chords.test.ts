import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { chordKind, documentTierGap, spanCandidate } from '../../src/layout/frame-paths.js';
import { measureSpans, spanVerdict, type SpanOffer } from '../../src/layout/span-measure.js';
import { judgeSpanTrial } from '../../src/layout/span-judge.js';
import { judgeCourseTrial } from '../../src/layout/course-measure.js';
import { spanBlockedNew } from '../../src/layout/trial-findings.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from '../layout/joint-off.js';

/**
 * Architecture ticket 22, spanning chords (docs/design/routed-chords.md, Section 14). Phase 1: the shapes and the corridor reader; phase 3: the offer, the
 * judge and the round. A test under `it.fails` states the outcome of a later phase (or a sheet the round does not reach) and fails today on purpose.
 */
const source = (name: string): string => withoutJointOrder(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
const SHEETS = {
  mesh: 'a-mesh-across-a-middle-tier-draws-straight-chords-beside-its-frame',
  three: 'a-chord-over-three-tier-gaps-passes-two-middle-tiers',
  wide: 'a-link-over-a-wide-middle-frame-keeps-its-lane',
  // Since architecture-2 ticket 65 the link of `wide` stands straight on its transit lane, so no offer reads it; this sheet's transit is refused by its frame.
  walled: 'a-link-transits-a-child-frame',
  share: 'a-chord-and-a-lane-share-a-middle-tier',
  label: 'a-labelled-chord-across-a-middle-tier-keeps-its-label-on-the-line',
};
interface Run { model: LayoutModel; offer: SpanOffer | undefined; base: LayoutModel | undefined; routedBase: LayoutModel | undefined }
const run = async (name: string): Promise<Run> => {
  let offer: SpanOffer | undefined, base: LayoutModel | undefined, routedBase: LayoutModel | undefined;
  const model = await layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    testSideTrace: event => { if (event.ev === 'spans') { offer = event.offer as SpanOffer; base = event.base as LayoutModel; routedBase = event.routedBase as LayoutModel; } } });
  return { model, offer, base, routedBase };
};
/** The sheet with no span round: the baseline as main publishes it (a forced, empty hint list skips the round). */
const runPlain = (name: string): Promise<LayoutModel> => layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testSpanHints: [] });
const link = (model: LayoutModel, n: number): LayoutLink => model.links.find(item => item.id === `link-${n}`)!;
const hinted = (item: LayoutLink): LayoutLink => ({ ...item, spanHint: true });

describe('chordKind of a hinted link', () => {
  it('reads a hinted link on tiers 0 and 2 as a cross-frame chord, and an unhinted one as none', async () => {
    const model = await runPlain(SHEETS.mesh);
    const mesh = link(model, 3);
    expect(documentTierGap(model, mesh)).toBe(2);
    expect(chordKind(model, mesh)).toBeUndefined();
    expect(chordKind(model, hinted(mesh))).toBe('cross');
    expect(spanCandidate(model, mesh)).toBe(true);
  }, 60000);

  it('is no candidate on consecutive tiers, and a hint there changes nothing', async () => {
    const model = await runPlain(SHEETS.mesh);
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

  it('refuses a link over a middle frame with the frame wall, and offers nothing', async () => {
    const { offer } = await run(SHEETS.walled);
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
    const { base, routedBase } = await run(SHEETS.mesh);
    // The same sheet with every candidate drawn straight reads as an empty offer: nothing a chord could lower.
    const straight = { ...routedBase!, links: routedBase!.links.map(item => item.layer === 'routed' ? { ...item, path: { ...item.path!, segments: [item.path!.segments[0]!] } } : item) };
    expect(measureSpans(base!, straight).links).toEqual([]);
    expect(measureSpans(base!, routedBase!).links).toHaveLength(9);
  }, 60000);

  it('removes the lanes of the offered links on its own copy, and leaves the baseline alone', async () => {
    const { base, routedBase } = await run(SHEETS.mesh);
    const lanes = base!.lanes.length;
    measureSpans(base!, routedBase!);
    expect(base!.lanes).toHaveLength(lanes);
    expect(lanes).toBe(9);
  }, 60000);
});

describe('the corridor reader (spanVerdict)', () => {
  it('refuses a chord whose corridor is closed', async () => {
    const { base } = await run(SHEETS.walled);
    // On the baseline itself the frame the link transits is a wall; the offer names the frame (above).
    expect('reason' in spanVerdict(base!, link(base!, 1))).toBe(true);
  }, 60000);

  it('passes a chord whose corridor is clear, and reads overlay geometry as no wall', async () => {
    const { base } = await run(SHEETS.three);
    expect('segment' in spanVerdict(base!, link(base!, 4))).toBe(true);
  }, 60000);

  it('lets two chords that cross strictly stand, and refuses two that run side by side under the clearance', async () => {
    const { base, routedBase } = await run(SHEETS.mesh);
    const offer = measureSpans(base!, routedBase!);
    // Held chords never refuse each other when they cross strictly; whatever they keep apart is recorded as crowded, to be decided by the trial.
    expect(offer.links).toHaveLength(9);
    expect([...offer.crowded.values()].every(reason => reason === 'chord' || reason === 'leg')).toBe(true);
  }, 60000);
});

describe('restore', () => {
  it('refuses a span hint that the freeze does not list', async () => {
    const model = await runPlain(SHEETS.mesh);
    const tampered = JSON.parse(JSON.stringify(model)) as LayoutModel;
    tampered.links.find(item => item.id === 'link-3')!.spanHint = true;
    expect(() => restoreFinalLayout(JSON.stringify(tampered))).toThrow(/span hints/i);
  }, 60000);

  it('refuses a span hint on a link that is no candidate', async () => {
    const model = await runPlain(SHEETS.mesh);
    const tampered = JSON.parse(JSON.stringify(model)) as LayoutModel;
    tampered.links.find(item => item.id === 'link-1')!.spanHint = true;
    tampered.freeze!.spans = ['link-1'];
    expect(() => restoreFinalLayout(JSON.stringify(tampered))).toThrow(/no spanning-chord candidate/);
  }, 60000);

  it('refuses a frozen span list that names a link without the hint', async () => {
    const model = await runPlain(SHEETS.mesh);
    const tampered = JSON.parse(JSON.stringify(model)) as LayoutModel;
    tampered.freeze!.spans = ['link-3'];
    expect(() => restoreFinalLayout(JSON.stringify(tampered))).toThrow(/span hints/i);
  }, 60000);

  it('restores a published layout that carries no span hint, and one that carries them', async () => {
    const unhinted = await runPlain(SHEETS.three);
    expect(() => restoreFinalLayout(JSON.stringify(unhinted))).not.toThrow();
    const { model } = await run(SHEETS.three);
    expect(model.freeze?.spans).toEqual(['link-4']);
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 60000);
});

describe('the span round on the sheets', () => {
  it('04 copy: nine spanning chords, no transit lane, SPAN_CHORD_TAKEN nine times, bent 2, turns 4', async () => {
    const { model } = await run(SHEETS.mesh);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN')).toHaveLength(9);
    expect(model.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toEqual([]);
    expect(model.links.filter(item => item.layer === 'routed' && (pathBends(item) ?? 0) > 0)).toHaveLength(2);
    expect(score(model).snapshot.metrics.bends.total).toBe(4);
    expect(model.freeze?.spans).toEqual(['link-3', 'link-4', 'link-5', 'link-6', 'link-7', 'link-8', 'link-9', 'link-10', 'link-11']);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_BLOCKED')).toEqual([]);
  }, 60000);

  it('04 copy: the same sheet as the forced hints give, and every gate passes', async () => {
    const { model } = await run(SHEETS.mesh);
    const forcedModel = await layout(parse(source(SHEETS.mesh)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testSpanHints: [...model.freeze!.spans!] });
    expect(model.canvas).toEqual(forcedModel.canvas);
    expect(score(model).snapshot.Q).toBeCloseTo(score(forcedModel).snapshot.Q, 9);
    expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
  }, 60000);

  it('three tier gaps: one chord, two span corridors', async () => {
    const { model } = await run(SHEETS.three);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN')).toHaveLength(1);
    expect(model.lanes.filter(lane => lane.kind === 'span')).toHaveLength(2);
    expect(model.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toEqual([]);
  }, 60000);

  it('wide middle frame: no offer, no hint, the sheet keeps its lane', async () => {
    const { model } = await run(SHEETS.wide);
    expect(model.links.some(item => item.spanHint !== undefined)).toBe(false);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN')).toEqual([]);
    expect(model.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toHaveLength(1);
  }, 60000);

  // The trial of this sheet loses its chord at the freeze (`leg`: the chord passes through the leg of a neighbour that leaves the same node). The round refuses it
  // before 7f and the route (`promise`), and the sheet is as before the round. The placement is spent and nothing is given back (Q111): with one re-run (`testMaxReruns: 1`)
  // the course is lost, with the default budget it is kept. Follow-up: reserve the leg pitch in stage 5, so that the chord and the lane of this sheet are both taken.
  it('a chord and a lane share a middle tier: a trial that loses its chord is refused before 7f', async () => {
    const refused: string[] = [];
    const model = await layout(parse(source(SHEETS.share)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
      testSideTrace: event => { if (event.ev === 'span-refused') refused.push(`${String(event.why)}`); } });
    const plain = await layout(parse(source(SHEETS.share)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testSpanHints: [] });
    const count = (m: LayoutModel, code: string): number => m.diagnostics.filter(item => item.code === code).length;
    expect(refused).toEqual(['promise']);
    expect(count(model, 'SPAN_CHORD_TAKEN')).toBe(0);
    expect(count(model, 'COURSE_TAKEN')).toBe(count(plain, 'COURSE_TAKEN'));
    expect(model.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toHaveLength(plain.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit').length);
  }, 60000);

  it('a chord and a lane share a middle tier: with one re-run the course keeps it (the span round leaves a re-run to the round after it)', async () => {
    const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testMaxReruns: 1 };
    const model = await layout(parse(source(SHEETS.share)), options);
    const plain = await layout(parse(source(SHEETS.share)), { ...options, testSpanHints: [] });
    const count = (m: LayoutModel, code: string): number => m.diagnostics.filter(item => item.code === code).length;
    expect(count(plain, 'COURSE_TAKEN')).toBe(1);
    expect(count(model, 'COURSE_TAKEN')).toBe(1);
  }, 60000);

  // A refused span trial spends placements and fan re-runs; it must not starve the course round that main runs (a-tier-gap-plan-orders-every-part: Q 0.6466 -> 0.4481, G5 failing).
  it('a refused span trial does not starve the course round', async () => {
    const text = withoutJointOrder(readFileSync(new URL('../../goldens/synthetic/a-tier-gap-plan-orders-every-part.yaml', import.meta.url), 'utf8'));
    const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
    const model = await layout(parse(text), options);
    const plain = await layout(parse(text), { ...options, testSpanHints: [] });
    expect(model.lanes.filter(lane => lane.kind === 'perimeter')).toHaveLength(plain.lanes.filter(lane => lane.kind === 'perimeter').length);
    expect(model.lanes.some(lane => lane.kind === 'perimeter')).toBe(true);
    expect(score(model).snapshot.gates.G5!.passed).toBe(true);
  }, 120000);

  it('a labelled chord is taken and G3 passes', async () => {
    const { model } = await run(SHEETS.label);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_TAKEN')).toHaveLength(1);
    expect(score(model).snapshot.gates.G3!.passed).toBe(true);
  }, 60000);

  it('a labelled chord widens the corridor of every band its label meets, and the label lies inside it', async () => {
    const { model } = await run(SHEETS.label);
    const plainWidth = (await run(SHEETS.three)).model.lanes.filter(lane => lane.kind === 'span').map(lane => lane.bounds.width);
    const corridors = model.lanes.filter(lane => lane.kind === 'span');
    expect(corridors.length).toBeGreaterThan(0);
    expect(corridors.every(lane => lane.bounds.width > Math.max(...plainWidth) + 5)).toBe(true);
    const label = model.labels.find(item => item.role === 'link' && item.owner.kind === 'link' && item.owner.id === 'link-4')!;
    expect(label.omitted).not.toBe(true);
    expect(label.onLine).toBe(true);
    for (const lane of corridors) {
      expect(label.bounds!.x).toBeGreaterThanOrEqual(lane.bounds.x - 1e-6);
      expect(label.bounds!.x + label.bounds!.width).toBeLessThanOrEqual(lane.bounds.x + lane.bounds.width + 1e-6);
    }
    expect(score(model).snapshot.gates.G3!.passed).toBe(true);
  }, 60000);
});

describe('the span round refuses what it must', () => {
  it('leaves the sheet as it was when the budget allows no re-run', async () => {
    const plain = await layout(parse(source(SHEETS.mesh)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [], testMaxReruns: 0 });
    expect(plain.links.some(item => item.spanHint !== undefined)).toBe(false);
    expect(plain.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toHaveLength(9);
  }, 60000);

  it('takes no chord on the wide-frame sheet and adds no diagnostic of the round', async () => {
    const { model } = await run(SHEETS.wide);
    expect(model.diagnostics.filter(item => /^SPAN_/.test(item.code))).toEqual([]);
  }, 60000);
});

describe('judgeSpanTrial', () => {
  const forcedMesh = (): Promise<LayoutModel> => layout(parse(source(SHEETS.mesh)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testSpanHints: MESH_IDS });
  const MESH_IDS = ['link-3', 'link-4', 'link-5', 'link-6', 'link-7', 'link-8', 'link-9', 'link-10', 'link-11'];
  let chords: LayoutModel;
  beforeAll(async () => { chords = await forcedMesh(); }, 60000);
  const routedPlain = async (): Promise<LayoutModel> => (await layout(parse(source(SHEETS.mesh)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testSpanHints: [], testCourses: [] }));

  it('keeps a trial that publishes every chord and gains', async () => {
    const base = await routedPlain();
    expect(judgeSpanTrial(base, chords, MESH_IDS)).toEqual({ kept: true, reason: undefined, detail: '' });
  }, 60000);

  it('refuses a trial that loses a promise', async () => {
    const base = await routedPlain();
    expect(judgeSpanTrial(chords, base, MESH_IDS).reason).toBe('promise');
  }, 60000);

  it('refuses a trial that gives no gain by the unified order', async () => {
    expect(judgeSpanTrial(chords, chords, []).reason).toBe('worse');
  }, 60000);

  it('refuses a trial with a new gate finding', async () => {
    const base = await routedPlain();
    const trial = JSON.parse(JSON.stringify(chords)) as LayoutModel;
    const victim = trial.links.find(item => item.id === 'link-3')!, other = trial.links.find(item => item.id === 'link-11')!;
    victim.path = JSON.parse(JSON.stringify(other.path));
    expect(judgeSpanTrial(base, trial, []).reason).toBe('gate');
    expect(judgeSpanTrial(base, trial, []).kept).toBe(false);
  }, 60000);

  it('refuses a trial that grows the canvas by more than 5 %', async () => {
    const base = await routedPlain();
    const trial = JSON.parse(JSON.stringify(chords)) as LayoutModel;
    trial.canvas = { ...trial.canvas!, width: base.canvas!.width * 1.2 };
    expect(judgeSpanTrial(base, trial, MESH_IDS).reason).toBe('growth');
  }, 60000);

  it('refuses a trial that names a blocked chord, and one that removes a link', async () => {
    const base = await routedPlain();
    const blocked = JSON.parse(JSON.stringify(chords)) as LayoutModel;
    blocked.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'SPAN_CHORD_BLOCKED', message: 'x', owners: [{ kind: 'link', id: 'link-3' }] });
    expect(judgeSpanTrial(base, blocked, MESH_IDS).reason).toBe('blocked');
    const removed = JSON.parse(JSON.stringify(chords)) as LayoutModel;
    delete removed.links.find(item => item.id === 'link-1')!.path;
    removed.links.find(item => item.id === 'link-1')!.removed = true;
    expect(judgeSpanTrial(base, removed, MESH_IDS).reason).toBe('removed');
  }, 60000);

  it('is read by the other judges: a new blocked chord refuses a course trial', async () => {
    const trial = JSON.parse(JSON.stringify(chords)) as LayoutModel;
    trial.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'SPAN_CHORD_BLOCKED', message: 'x', owners: [{ kind: 'link', id: 'link-4' }] });
    expect(spanBlockedNew(chords, trial)).toEqual(['link-4']);
    expect(spanBlockedNew(trial, chords)).toEqual([]);
    expect(judgeCourseTrial(chords, trial, new Map()).kept).toBe(false);
  }, 60000);

  it('names a hinted link that ends orthogonal, whatever diagnostic says so (the freeze refuses it: ROUTED_CHORD_REFUSED)', async () => {
    const trial = JSON.parse(JSON.stringify(chords)) as LayoutModel;
    const victim = trial.links.find(item => item.id === 'link-4')!;
    expect(victim.spanHint).toBe(true);
    victim.technique = 'orthogonal';
    victim.path = { ...victim.path!, fixed: false as never, segments: [victim.path!.segments[0]!, { ...victim.path!.segments[0]!, straight: false as never }] };
    trial.diagnostics.push({ stage: 'placement', severity: 'info', code: 'ROUTED_CHORD_REFUSED', message: 'x', owners: [{ kind: 'link', id: 'link-4' }] });
    expect(spanBlockedNew(chords, trial)).toEqual(['link-4']);
    expect(judgeCourseTrial(chords, trial, new Map()).kept).toBe(false);
  }, 60000);
});
