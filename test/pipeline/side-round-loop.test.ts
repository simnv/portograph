import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import type { SideOffer } from '../../src/layout/side-measure.js';
import { portKey } from '../../src/layout/sides-one.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 115: the rules of the round loop, driven by a scripted measure (the real measure never offers these hints). */
type Script = ((call: number, real: () => SideOffer) => SideOffer) | undefined;
const state: { script: Script; calls: number } = { script: undefined, calls: 0 };
vi.mock('../../src/layout/side-measure.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/layout/side-measure.js')>();
  return { ...real, measureSides: (...args: Parameters<typeof real.measureSides>): SideOffer => {
    const call = ++state.calls;
    return state.script ? state.script(call, () => real.measureSides(...args)) : real.measureSides(...args);
  } };
});

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const PAST_SIBLING = 'an-overlay-leaves-a-lateral-side-past-a-sibling-body';
const BLOCKED = 'an-overlay-keeps-its-natural-side-when-the-lateral-segment-is-blocked';
const TWO_TIERS = 'members-of-two-tiers-stand-as-two-rows';
const FAN = 'a-fan-spreads-its-ports-so-its-chords-hold-clearance';
const run = async (name: string, script?: Script, testMaxReruns?: number): Promise<LayoutModel> => {
  state.script = script; state.calls = 0;
  return layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...(testMaxReruns === undefined ? {} : { testMaxReruns }) });
};
const withoutNotes = (model: LayoutModel): string => JSON.stringify({ ...model, diagnostics: model.diagnostics.filter(item => !item.code.startsWith('SIDE_')) },
  (key, value: unknown) => key === 'runtime' || key === 'reservations' ? undefined : value);
const offerOf = (key: string, side: 'left' | 'right', link: string): SideOffer => ({
  hints: new Map([[key, side]]), promised: new Map([[key, { link, bends: 0, shape: 'straight' as const }]]), capped: false });

describe('the round loop (ticket 115, side-faces.md Section 7)', () => {
  it('stops after a kept trial: one trial reaches 7f per command, so a second offer is never measured', async () => {
    const model = await run(PAST_SIBLING);
    expect(state.calls).toBe(1);
    expect(model.diagnostics.filter(item => item.code === 'SIDE_HINT_TAKEN')).toHaveLength(1);
  }, 60000);

  it('judges the published result, not the 7e shape: a scripted hint on a blocked link is kept because its routed trial has fewer bends (main refused it at 7e)', async () => {
    const plain = await run(BLOCKED);
    const link = plain.links.find(item => item.layer === 'overlay')!.id;
    const server = plain.links.find(item => item.id === link)!.attachments!.from;
    const model = await run(BLOCKED, (call, real) => call === 1 ? offerOf(portKey(server), 'right', link) : real());
    const kept = model.nodes['server']!.ports.some(port => port.sideHint === true);
    const bends = (m: LayoutModel): number => m.links.find(item => item.id === link)!.path!.segments.length - 1;
    expect(kept).toBe(true);
    expect(bends(model)).toBeLessThan(bends(plain));
    expect(model.diagnostics.map(item => item.code)).not.toContain('SIDE_SHAPE_LOST');
  }, 60000);

  const bogus = (n: number): SideOffer => offerOf(JSON.stringify(['core-1', true, null, 90 + n]), 'right', 'link-1');

  it('skips a side round once the command has made its placement re-runs: a note, no placement run, no clock', async () => {
    // The fan fixture makes one fan re-run; with the cap at 1 the first offer finds the count spent.
    const model = await run(FAN, call => bogus(call), 1);
    const codes = model.diagnostics.map(item => item.code);
    expect(codes.filter(code => code === 'SIDE_ROUND_SKIPPED')).toHaveLength(1);
    expect(codes).not.toContain('SIDE_HINT_REFUSED');
    expect(state.calls).toBe(1);
    expect(withoutNotes(model)).toBe(withoutNotes(await run(FAN)));
  }, 60000);

  it('refuses a hint whose placement run is rejected, and offers again in the retry round', async () => {
    const model = await run(FAN, call => bogus(call));
    expect(model.diagnostics.filter(item => item.code === 'SIDE_HINT_REFUSED')).toHaveLength(2);
    expect(state.calls).toBe(2);
    expect(withoutNotes(model)).toBe(withoutNotes(await run(FAN)));
  }, 60000);

  it('refuses a scripted hint on a link that 7f straightens by itself: the routed trial gives no gain (review M1; crossings are no criterion)', async () => {
    // On this input 7f straightens link-6 by itself. A scripted hint on its probe end passes the shape test but makes it cross link-5.
    const plain = await run(TWO_TIERS, undefined, 0);
    const link = plain.links.find(item => item.id === 'link-6')!;
    const model = await run(TWO_TIERS, (call, real) => call === 1 ? offerOf(portKey(link.attachments!.from), 'right', link.id) : real());
    // The trial's route gives the same bends as the baseline (7f straightens the link by itself), so the round refuses it for no gain.
    expect(model.diagnostics.find(item => item.code === 'SIDE_HINT_REFUSED')!.message).toContain('gives no gain');
    expect(model.nodes['probe']!.ports.some(port => port.sideHint === true)).toBe(false);
    expect(model.diagnostics.map(item => item.code)).not.toContain('SIDE_HINT_TAKEN');
    expect(withoutNotes(model)).toBe(withoutNotes(plain));
  }, 60000);

  it('refuses a hint for a chord that the trial 7e does not hold, and keeps the baseline (review M1, ticket 117)', async () => {
    const far = 'a-location-router-leaves-a-lateral-side-toward-a-far-provider';
    // The baseline is the sheet with no side offer, the other rounds as they run: on this sheet the course round offers link-3 the L of a step (ticket 09
    // of architecture-2, follow-up), so a run with no re-run at all is not the baseline the refused hint must keep.
    const none = (): SideOffer => ({ hints: new Map(), promised: new Map(), capped: false });
    const plain = await run(far, none);
    expect(plain.courses?.map(item => item.link)).toEqual(['link-3']);
    const link = plain.links.find(item => item.attachments!.from.node === 'east-router' && item.attachments!.to.node === 'provider')!;
    // The left face of the east router faces away from its peer: the chord leaves inward, so 7e cannot hold it. The scripted offer promises the straight shape.
    const model = await run(far, call => call === 1 ? offerOf(portKey(link.attachments!.from), 'left', link.id) : { hints: new Map(), promised: new Map(), capped: false });
    const refused = model.diagnostics.filter(item => item.code === 'SIDE_HINT_REFUSED');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('does not hold its chord at stage 7e');
    expect(model.nodes['east-router']!.ports.some(port => port.sideHint === true)).toBe(false);
    expect(withoutNotes(model)).toBe(withoutNotes(plain));
  }, 60000);

  it('lets a placement error that is no hint refusal surface', async () => {
    state.script = undefined; state.calls = 0;
    // The second placement run (the side trial) throws a TypeError from the progress callback of its `resolve` stage.
    let resolves = 0;
    const onProgress = (progress: { stage: string }): void => { if (progress.stage === 'resolve' && ++resolves === 2) throw new TypeError('boom'); };
    await expect(layout(parse(fixture(PAST_SIBLING)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, onProgress })).rejects.toThrow(TypeError);
  }, 60000);
});
