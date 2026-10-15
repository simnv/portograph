import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { chordGapNotes, tierGapPlans } from '../../src/layout/gap-plan.js';
import { growTierGaps } from '../../src/layout/gap-room.js';
import { intersection, samePoint } from '../../src/score/geometry.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ranked-groups ticket 101 (Q108, docs/design/routed-chords.md, Section 8): the tier-gap plan keeps its verticals off a held routed chord, and a row
 * that crosses one is legal.
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const CROSSES = 'a-planned-row-crosses-a-routed-chord';
/** The model as 7f publishes it, before routing: the plan is read on it. */
const atBands = async (name: string): Promise<LayoutModel> => bands(bundles(bars(centre(flanks(lanes(rows(await placed(fixture(name)))))))));
const codes = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code.startsWith('TIER_GAP_CHORD_')).map(item => item.code);
const chordsOf = (model: LayoutModel) => model.links.filter(link => model.frozenChords?.includes(link.id));

describe('the tier-gap plan and a held routed chord', () => {
  it('seats a row across the chords of its gap, strictly, and every gate passes', async () => {
    const model = await run(fixture(CROSSES));
    const chords = chordsOf(model);
    expect(chords.length).toBeGreaterThanOrEqual(4);
    const bent = model.links.filter(link => link.technique === 'orthogonal');
    expect(bent.length).toBeGreaterThanOrEqual(2);
    // Some horizontal run of a bent link crosses a chord in the interior of both.
    const crossed = bent.flatMap(link => (link.path?.segments ?? []).filter(seg => Math.abs(seg.from.y - seg.to.y) < 1e-6 && Math.abs(seg.from.x - seg.to.x) > 1)
      .flatMap(seg => chords.map(chord => ({ link: link.id, chord: chord.id, point: intersection(seg, chord.path!.segments[0]!), seg, run: chord.path!.segments[0]! }))))
      .filter(item => item.point !== undefined && ![item.seg.from, item.seg.to, item.run.from, item.run.to].some(end => samePoint(end, item.point!)));
    expect(crossed.length).toBeGreaterThan(0);
    // The plan keeps every leg and drop off the chords it does not cross, so it names nothing.
    expect(codes(model)).toEqual([]);
    for (const [id, gate] of Object.entries(score(model).snapshot.gates)) expect([id, gate.violations]).toEqual([id, []]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);

  it('names a leg that 7f moved within the clearance of a held chord (TIER_GAP_CHORD_CROWDED), and only then', async () => {
    const model = structuredClone(await atBands(CROSSES));
    expect(chordGapNotes(model, tierGapPlans(model))).toEqual([]);
    const gapPlan = tierGapPlans(model).find(item => item.plan.parts.length)!;
    const part = gapPlan.plan.parts.find(item => item.shape === 'stepped')!;
    // The chord of a link that ends at a provider stands 3 px from the leg of the bent link.
    const chord = model.links.filter(link => model.frozenChords!.includes(link.id)).map(link => link.path!.segments[0]!)
      .find(seg => Math.min(seg.from.y, seg.to.y) <= gapPlan.gap.low && Math.max(seg.from.y, seg.to.y) >= gapPlan.gap.high)!;
    chord.from = { x: part.upper.x + 3, y: chord.from.y };
    chord.to = { x: part.upper.x + 3, y: chord.to.y };
    const notes = chordGapNotes(model, tierGapPlans(model));
    const crowded = notes.filter(item => item.code === 'TIER_GAP_CHORD_CROWDED');
    expect(crowded.length).toBeGreaterThan(0);
    expect(crowded[0]!.severity).toBe('info');
    expect(crowded.some(item => item.owners?.some(owner => owner.kind === 'link' && owner.id === part.link))).toBe(true);
    // 7f reads the same plan after each move and puts the note on the model, once.
    growTierGaps(model);
    growTierGaps(model);
    expect(codes(model).filter(code => code === 'TIER_GAP_CHORD_CROWDED').length).toBeGreaterThan(0);
    expect(new Set(model.diagnostics.map(item => item.message)).size).toBe(model.diagnostics.length);
    // The same leg 20 px from the chord is not named.
    chord.from = { x: part.upper.x + 20, y: chord.from.y };
    chord.to = { x: part.upper.x + 20, y: chord.to.y };
    expect(chordGapNotes(model, tierGapPlans(model)).filter(item => item.code === 'TIER_GAP_CHORD_CROWDED')).toEqual([]);
  }, 60000);

  it('names a residual part over the x-span of a held chord (TIER_GAP_CHORD_EXPOSED), and a part of a gap that stays short of room', async () => {
    const model = await atBands(CROSSES);
    const plans = tierGapPlans(model);
    const held = model.links.filter(link => model.frozenChords!.includes(link.id)).map(link => link.path!.segments[0]!);
    // A slanted chord: its x-span in the gap is narrower than the run from port to port, and its middle stands in the gap.
    const chord = held.find(seg => Math.abs(seg.from.x - seg.to.x) > 50)!;
    const middle = (chord.from.x + chord.to.x) / 2;
    const withResidual = (span: { x0: number; x1: number }) => plans.map(({ gap, plan }) => ({ gap, plan: { ...plan,
      residual: [...plan.residual, { id: 'link-99#0', link: 'link-99', order: 99, reason: 'row-cycle' as const, span }] } }));
    const over = chordGapNotes(model, withResidual({ x0: middle - 10, x1: middle + 10 }));
    expect(over.filter(item => item.code === 'TIER_GAP_CHORD_EXPOSED').map(item => item.message.split(' ')[0])).toContain('link-99');
    expect(over.find(item => item.code === 'TIER_GAP_CHORD_EXPOSED')!.severity).toBe('info');
    // A residual part clear of every chord's span in the gap is not named.
    const far = Math.max(...held.flatMap(seg => [seg.from.x, seg.to.x])) + 200;
    expect(chordGapNotes(model, withResidual({ x0: far, x1: far + 50 })).filter(item => item.code === 'TIER_GAP_CHORD_EXPOSED')).toEqual([]);
    // A gap that still asks for room leaves its parts to the router: those over a chord are named.
    const short = plans.map(({ gap, plan }) => ({ gap, plan: { ...plan, growth: 5 } }));
    expect(chordGapNotes(model, short).filter(item => item.code === 'TIER_GAP_CHORD_EXPOSED').length).toBeGreaterThan(0);
    expect(chordGapNotes(model, plans).filter(item => item.code === 'TIER_GAP_CHORD_EXPOSED')).toEqual([]);
  }, 60000);

  it('keeps the middle drop of a Z part off a held chord of its gap (tierGapPlan hands the chords to the plan)', async () => {
    const model = await atBands('an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips');
    const zed = (m: LayoutModel) => tierGapPlans(m).flatMap(item => item.plan.parts.filter(part => part.shape === 'z').map(part => ({ gap: item.gap, middle: part.middle! })))[0]!;
    const free = zed(model);
    expect(free.middle).toBeCloseTo(92.75, 6);
    // Link-1 is a held chord of another gap; forged to stand vertical across this gap at the free middle drop, it is a wall the drop must keep 11.5 px from.
    const forged = structuredClone(model);
    const segment = forged.links.find(link => link.id === 'link-1')!.path!.segments[0]!;
    segment.from = { x: free.middle, y: free.gap.low - 10 }; segment.to = { x: free.middle, y: free.gap.high + 10 };
    expect(forged.frozenChords).toContain('link-1');
    expect(Math.abs(zed(forged).middle - free.middle)).toBeGreaterThanOrEqual(11.5 - 1e-6);
  }, 60000);
});
