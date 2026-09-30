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
  it('drops a trial in which a new hint breaks an old one: the old hint stays and the new one is refused', async () => {
    const plain = await run(PAST_SIBLING);
    const link = plain.links.find(item => item.layer === 'overlay')!.id;
    const client = keyOf(plain, 'client');
    // The second offer turns the client end of the same link to its left face: the server's straight segment then leaves its right face away from
    // the client's left face, and the promise of the old hint (0 bends) is lost.
    const model = await run(PAST_SIBLING, (call, real) => call === 1 ? real() : call === 2 ? offerOf(client, 'left', link) : real());
    const server = model.nodes['server']!.ports.filter(port => port.sideHint === true);
    expect(server.map(port => port.side)).toEqual(['right']);
    expect(model.nodes['client']!.ports.some(port => port.sideHint === true)).toBe(false);
    expect(model.links.find(item => item.id === link)!.path!.segments).toHaveLength(1);
    const refused = model.diagnostics.filter(item => item.code === 'SIDE_HINT_REFUSED');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('a new hint broke an old one');
    expect(refused[0]!.message).toContain('client');
    expect(model.diagnostics.filter(item => item.code === 'SIDE_HINT_TAKEN')).toHaveLength(1);
    expect(withoutNotes(model)).toBe(withoutNotes(plain));
  }, 60000);

  it('a dropped side trial leaves the model as it was and refuses the hint whose shape was lost', async () => {
    const plain = await run(BLOCKED);
    const link = plain.links.find(item => item.layer === 'overlay')!.id;
    const server = plain.links.find(item => item.id === link)!.attachments!.from;
    const model = await run(BLOCKED, (call, real) => call === 1 ? offerOf(portKey(server), 'right', link) : real());
    expect(model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(false);
    expect(withoutNotes(model)).toBe(withoutNotes(plain));
    const refused = model.diagnostics.filter(item => item.code === 'SIDE_HINT_REFUSED');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('its shape was lost');
    expect(model.diagnostics.map(item => item.code)).not.toContain('SIDE_HINT_TAKEN');
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
});
