import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/model/index.js';

// Dense-16x9 ticket 36a, review 2, finding 3: the step decision of 7f compares the sets a move loses on the column wall as identities. A
// controlled state: the objective admits the move (it straightens one overlay link), and the settled copy with the move withdraws site#1 on the
// wall while the copy without it withdraws site#2 there. Equal counts, a new loss: the move does not stand. No claim that a corpus sheet takes this path.
vi.mock('../../src/layout/objective.js', async actual => ({
  ...await actual<Record<string, unknown>>(),
  read: (model: { probeMoved?: number }) => ({ overlay: { straight: model.probeMoved ? 1 : 0 }, crossings: () => 0, growth: { width: 0 }, routed: { straight: 0 } }),
  gains: (a: { overlay: { straight: number } }, b: { overlay: { straight: number } }) => a.overlay.straight > b.overlay.straight,
}));
const { chordDecision } = await import('../../src/layout/decide.js');
const { reservation } = await import('../../src/layout/reservations.js');
const { SEAT_WALL_COLUMN } = await import('../../src/layout/seat-set.js');
const { layout, parse } = await import('../../src/index.js');
const { createAttempt } = await import('./phase-two-fixture.js');
const { createAvoidAttempt } = await import('../route/fixture.js');

const CHILD_ROW = readFileSync(new URL('../../goldens/synthetic/a-child-row-stands-under-its-parents-ports.yaml', import.meta.url), 'utf8');
/** The child row with a row under it: two standing seat sets, site#1 and site#2. */
const CHAIN = CHILD_ROW.replace('\nlinks:', '\n  g1: { group: site, ports: [{ name: u, side: top }] }\n  g2: { group: site, ports: [{ name: u, side: top }] }\nlinks:')
  + '\n  - { from: c1.b, to: g1.u }\n  - { from: c2.b, to: g2.u }\n';

const decide = async (lost: (moved: boolean) => string): Promise<boolean> => {
  const model = structuredClone(await layout(parse(CHAIN), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt })) as LayoutModel & { probeMoved?: number };
  expect((model.reservations ?? []).filter(entry => entry.kind === 'seatSet').map(entry => entry.kind === 'seatSet' && entry.payload.row).sort()).toEqual(['site#1', 'site#2']);
  model.probeMoved = 0;
  const decision = chordDecision(model, (copy: LayoutModel & { probeMoved?: number }) => {
    const row = lost(Boolean(copy.probeMoved));
    copy.reservations = [...(copy.reservations ?? []).filter(entry => !(entry.kind === 'seatSet' && entry.payload.row === row)),
      reservation('seatSetDeclined', { kind: 'group', id: row }, '', 'rows', 0, { row, at: 'centre', why: `${SEAT_WALL_COLUMN} (0 to 1)` })];
  }, [], new Set());
  return decision.choose('probe', [1], 0, dx => { model.probeMoved = dx; }, () => { model.probeMoved = 0; }, [], () => true);
};

it('refuses a move whose settled copy trades one wall withdrawal for another', async () => {
  expect(await decide(moved => moved ? 'site#1' : 'site#2')).toBe(false);
}, 120000);

it('takes a move whose settled copy loses on the wall only what the copy without it loses', async () => {
  expect(await decide(() => 'site#2')).toBe(true);
}, 120000);
