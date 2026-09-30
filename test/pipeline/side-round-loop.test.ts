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
  (key, value: unknown) => key === 'runtime' ? undefined : value);
const keyOf = (model: LayoutModel, node: string): string => portKey(model.nodes[node]!.ports.find(port => port.ref.anonymous === true)!.ref);
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

  it('drops a trial that adds an overlay crossing at a moved port, though its planned bends fall (review M1)', async () => {
    // On this input 7f straightens link-6 by itself. A scripted hint on its probe end passes the shape test but makes it cross link-5.
    const plain = await run(TWO_TIERS, undefined, 0);
    const link = plain.links.find(item => item.id === 'link-6')!;
    const model = await run(TWO_TIERS, (call, real) => call === 1 ? offerOf(portKey(link.attachments!.from), 'right', link.id) : real());
    expect(model.nodes['probe']!.ports.some(port => port.sideHint === true)).toBe(false);
    expect(model.diagnostics.map(item => item.code)).not.toContain('SIDE_HINT_TAKEN');
    expect(withoutNotes(model)).toBe(withoutNotes(plain));
  }, 60000);

  it('lets a placement error that is no hint refusal surface', async () => {
    state.script = undefined; state.calls = 0;
    // The second placement run (the side trial) throws a TypeError from the progress callback of its `resolve` stage.
    let resolves = 0;
    const onProgress = (progress: { stage: string }): void => { if (progress.stage === 'resolve' && ++resolves === 2) throw new TypeError('boom'); };
    await expect(layout(parse(fixture(PAST_SIBLING)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, onProgress })).rejects.toThrow(TypeError);
  }, 60000);

  it('does not blame a new hint for an old one that already faced away on the kept model (review L1)', async () => {
    const plain = await run(PAST_SIBLING, undefined, 0);
    const link = plain.links.find(item => item.layer === 'overlay')!;
    // A test hint on the server end that faces away from the client, from the first placement on. The scripted offer is for the client end.
    state.script = (call, real) => call === 1 ? offerOf(portKey(link.attachments!.to), 'left', link.id) : real(); state.calls = 0;
    const model = await layout(parse(fixture(PAST_SIBLING)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
      testSideHints: new Map([[portKey(link.attachments!.from), 'left' as const]]) });
    const refused = model.diagnostics.filter(item => item.code === 'SIDE_HINT_REFUSED');
    expect(refused.map(item => item.message).join()).not.toContain('broke an old one');
  }, 60000);
});
