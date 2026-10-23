import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Budget, LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { systemElkClock } from '../../src/layout/elk-worker.js';
import { measureSides } from '../../src/layout/side-measure.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 115 (docs/design/side-faces.md, Q109): the side round straightens an overlay link from a lateral side. */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const PAST_SIBLING = 'an-overlay-leaves-a-lateral-side-past-a-sibling-body';
const BLOCKED = 'an-overlay-keeps-its-natural-side-when-the-lateral-segment-is-blocked';
const TWO_TIERS = 'members-of-two-tiers-stand-as-two-rows';
const FAN = 'a-fan-spreads-its-ports-so-its-chords-hold-clearance';
// The `reservations` field (architecture 2, ticket 03) is the declared ledger of the run, not geometry: the bytes main made have none.
const withoutRuntime = (model: LayoutModel): string => JSON.stringify(model, (key, value: unknown) => key === 'runtime' || key === 'reservations' ? undefined : value);
const hash = (model: LayoutModel): string => createHash('sha256').update(withoutRuntime(model)).digest('hex').slice(0, 16);
interface Counted { model: LayoutModel; places: number }
async function run(name: string, extra: Partial<Parameters<typeof layout>[1]> = {}): Promise<Counted> {
  let places = 0;
  const model = await layout(parse(fixture(name)), { createElkAttempt: () => { places++; return createAttempt(); }, createRouteAttempt: createAvoidAttempt, testOverlayCourses: false, ...extra });
  return { model, places };
}
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);

describe('the side round takes a lateral side for an overlay link past a sibling body', () => {
  it('puts the server port on the right face, draws one segment, names the hint and loses no shape', async () => {
    const { model, places } = await run(PAST_SIBLING);
    const link = model.links.find(item => item.layer === 'overlay')!;
    expect(link.path!.segments).toHaveLength(1);
    const ends = link.attachments!;
    const port = model.nodes[ends.from.node]!.ports.find(item => item.ref.ordinal === ends.from.ordinal && item.ref.name === ends.from.name)!;
    expect(port.side).toBe('right');
    expect(port.sideHint).toBe(true);
    expect(port.naturalSide).toBe('bottom');
    expect(places).toBe(2);
    expect(codes(model)).toContain('SIDE_HINT_TAKEN');
    expect(model.diagnostics.find(item => item.code === 'SIDE_HINT_TAKEN')!.owners).toEqual([{ kind: 'link', id: link.id }]);
    expect(codes(model)).not.toContain('SIDE_SHAPE_LOST');
    expect(codes(model)).not.toContain('SIDE_HINT_FACES_AWAY');
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed)).toEqual([]);
  }, 60000);

  it('on main the same link goes round the sibling, so the hint is what straightens it', async () => {
    // A layout with no side round (the count of re-runs is 0, ticket 141) keeps the natural sides: the path is bent.
    const { model } = await run(PAST_SIBLING, { testMaxReruns: 0 });
    expect(model.links.find(item => item.layer === 'overlay')!.path!.segments.length).toBeGreaterThan(1);
    expect(codes(model)).toContain('SIDE_ROUND_SKIPPED');
    expect(model.nodes['server']!.ports.some(item => item.sideHint === true)).toBe(false);
  }, 60000);

  it('two runs give byte-identical layout JSON', async () => {
    const one = await run(PAST_SIBLING), two = await run(PAST_SIBLING);
    expect(withoutRuntime(one.model)).toBe(withoutRuntime(two.model));
  }, 60000);

  // Ticket 112: machine speed must not change the layout. A clock that makes every read slow, with the deadline far away, cuts nothing.
  it('gives the same layout on a slow clock at a far deadline, with no cut', async () => {
    let tick = 0;
    const clock = { ...systemElkClock, now: () => (tick += 4000) };
    const budget: Budget = { remainingMs: () => 600_000, share: stageMs => stageMs };
    const slow = await run(PAST_SIBLING, { budget, clock }), fast = await run(PAST_SIBLING);
    expect(withoutRuntime(slow.model)).toBe(withoutRuntime(fast.model));
    expect(codes(slow.model).filter(code => code.endsWith('_CUT'))).toEqual([]);
  }, 60000);
});

describe('a diagram with no side candidate is the layout main makes', () => {
  // Hashes of the layout JSON without `runtime`, and the number of placement runs, measured on main at 964d77f.
  it('a fan-only input: same bytes, same number of placement runs, nothing offered, no side diagnostic', async () => {
    const { model, places } = await run(FAN);
    expect(places).toBe(2);
    // The hash moved from 6e2c23e8fd517290 with the message rewrite (ticket 02): the only difference in the layout JSON is the text of
    // the ROUTE_UNSUPPORTED message, 'M1 draws the members for group-link' now 'A group-link is drawn as its member links'.
    // Ticket 22: the fan is a direct family; its reserved gap height moves the layout (db0b5d006f05102c before).
    expect(hash(model)).toBe('6b3a6cecb7617b98');
    expect(measureSides(model, model, new Set()).hints.size).toBe(0);
    expect(codes(model).filter(code => code.startsWith('SIDE_'))).toEqual([]);
  }, 60000);

  it('a link that 7f straightens by itself is no candidate: same bytes as with no side round (review M1)', async () => {
    const off = await run(TWO_TIERS, { testMaxReruns: 0 }), on = await run(TWO_TIERS);
    expect(on.places).toBe(1);
    expect(hash(on.model)).toBe(hash(off.model));
    expect(codes(on.model).filter(code => code.startsWith('SIDE_'))).toEqual([]);
  }, 60000);

  it('a bent overlay link whose lateral segment is also blocked gets no hint and the model is main\'s', async () => {
    const { model, places } = await run(BLOCKED);
    expect(model.links.find(item => item.layer === 'overlay')!.path!.segments.length).toBeGreaterThan(1);
    expect(places).toBe(1);
    // Re-baselined for architecture ticket 17: the free rows gain a `rowOrderDecision` record; without that key the hash is the old one.
    expect(hash(model)).toBe('77ce3286e5e7652d');
    expect(measureSides(model, model, new Set()).hints.size).toBe(0);
    expect(codes(model).filter(code => code.startsWith('SIDE_'))).toEqual([]);
  }, 60000);
});

describe('the probe', () => {
  it('offers the right face for the server port, and nothing once that key is refused', async () => {
    const { model } = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const offer = measureSides(model, model, new Set());
    expect([...offer.hints.values()]).toEqual(['right']);
    expect([...offer.promised.values()]).toEqual([expect.objectContaining({ bends: 0, shape: 'straight' })]);
    const [key] = [...offer.hints.keys()];
    expect(measureSides(model, model, new Set([`${key}|right`])).hints.size).toBe(0);
  }, 60000);

  it('refuses a lateral segment that leaves its face at less than 15 degrees', async () => {
    // A narrow client stands near: the straight segment from the server's right face is clear but nearly parallel to that face (review L1).
    const yaml = fixture(PAST_SIBLING).replace('label: Client, size: { width: 170', 'label: Client, size: { width: 90');
    let places = 0;
    const model = await layout(parse(yaml), { createElkAttempt: () => { places++; return createAttempt(); }, createRouteAttempt: createAvoidAttempt, testOverlayCourses: false });
    expect(model.links.find(item => item.layer === 'overlay')!.path!.segments.length).toBeGreaterThan(1);
    expect(places).toBe(1);
    expect(measureSides(model, model, new Set()).hints.size).toBe(0);
  }, 60000);

  it('stops at the probe cap and says so', async () => {
    const { model } = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const offer = measureSides(model, model, new Set(), 0);
    expect(offer.capped).toBe(true);
    expect(offer.hints.size).toBe(0);
  }, 60000);
});
