import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { holds } from '../../src/layout/reservation-checks.js';
import { ofKind, spanEntries } from '../../src/layout/reservations.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const SPAN_SHEET = 'goldens/synthetic/a-chord-over-three-tier-gaps-passes-two-middle-tiers.yaml';

describe('the ledger a layout publishes (architecture 2, ticket 03)', () => {
  it('is always written, holds on the published model, and a span chord without a corridor does not hold', async () => {
    const model = await layout(parse(readFileSync(SPAN_SHEET, 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(Array.isArray(model.reservations)).toBe(true);
    const chord = model.links.find(link => link.spanHint === true)!;
    expect(chord).toBeDefined();
    expect(ofKind(model.reservations!, 'spanChord').map(item => item.payload.link)).toContain(chord.id);
    expect(holds(spanEntries([chord.id], 'span', 0), model)).toEqual([]);
    const without = { ...model, lanes: model.lanes.filter(lane => lane.kind !== 'span') };
    expect(holds(spanEntries([chord.id], 'span', 0), without as never).map(item => item.why)).toEqual([expect.stringContaining('has no corridor')]);
  }, 120000);

  it('writes an empty ledger for a sheet that reserves nothing, and restore refuses a ledger of the wrong shape', async () => {
    const model = await layout(parse(readFileSync('ref/hand-solves/01-ring-in-a-row.yaml', 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.reservations).toBeDefined();
    const json = JSON.parse(JSON.stringify(model)) as { reservations: Record<string, unknown>[] };
    expect(() => restoreLayoutModel(JSON.stringify(json))).not.toThrow();
    const forged = (change: (copy: typeof json) => void): string => { const copy = JSON.parse(JSON.stringify(json)) as typeof json; change(copy); return JSON.stringify(copy); };
    expect(() => restoreLayoutModel(forged(copy => { copy.reservations = [{ id: 'x', kind: 'spanChord', owner: { kind: 'link', id: 'l' }, producer: 'span', revision: 0, activeFrom: 'resolve', payload: { link: 3 } }]; }))).toThrow(/malformed/);
    expect(() => restoreLayoutModel(forged(copy => { copy.reservations = [{ id: 'x', kind: 'riserKeepOut', owner: { kind: 'command', id: 'a' }, producer: 'lanes', revision: 0, activeFrom: 'lanes', payload: {} }]; }))).toThrow(/not stored/);
  }, 120000);
});
