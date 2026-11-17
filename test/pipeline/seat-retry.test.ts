import { describe, expect, it } from 'vitest';
import { reservation } from '../../src/layout/reservations.js';
import { retryWithdrawnSeatSets, SEAT_SET_RETRIES, SEAT_SET_RETRY_BOUND, SEAT_SET_RETRY_REFUSED, type SeatRetryPort, type SeatRetryResult } from '../../src/pipeline/seat-retry.js';
import type { LayoutModel } from '../../src/model/layout.js';

/**
 * Dense-16x9 ticket 36, ruling B: the state table of the seat-set retry. A placement is a model whose ledger names the rows its 7c withdrew
 * (`seatSetDeclined` at a rule) and the rows it stood a set on (`seatSet`); the stub places from the declines of the command alone, as stage 6 does.
 */
type Placement = { withdrawn?: string[]; sets?: string[] } | 'refused';
const model = (p: Exclude<Placement, 'refused'>, declined: ReadonlyMap<string, string>): LayoutModel => ({
  reservations: [
    ...[...declined.keys()].map(row => reservation('seatSetDeclined', { kind: 'group', id: row }, '', 'rows', 0, { row, at: 'input', why: 'earlier' })),
    ...(p.withdrawn ?? []).map(row => reservation('seatSetDeclined', { kind: 'group', id: row }, '', 'rows', 0, { row, at: 'centre', why: 'moved' })),
    ...(p.sets ?? []).map(row => ({ kind: 'seatSet', owner: { kind: 'group', id: row }, payload: { row } })),
  ],
} as unknown as LayoutModel);

/** A command whose n-th placement is `script(declines)`; it records every placement and the declines each one read. */
function command(script: (declined: ReadonlySet<string>) => Placement) {
  let declined = new Map<string, string>();
  const placed: string[][] = [];
  const port: SeatRetryPort<Map<string, string>> = {
    place: async () => {
      placed.push([...declined.keys()].sort());
      const p = script(new Set(declined.keys()));
      if (p === 'refused') throw new Error('the placement is refused');
      return model(p, declined);
    },
    declined: () => declined,
    decline: rows => { declined = new Map([...declined, ...rows]); },
    snapshot: () => new Map(declined),
    restore: saved => { declined = saved; },
    refused: error => (error as Error).message === 'the placement is refused',
  };
  return { port, placed, declines: () => [...declined.keys()].sort() };
}

/** The one invariant of every outcome: no set on a declined row, and every withdrawal of the result declined or named by a note. */
function holds(result: SeatRetryResult, declines: string[]): void {
  const id = (owner: unknown): string => (owner as { id: string }).id;
  const entries = result.model.reservations ?? [];
  const sets = entries.filter(entry => entry.kind === 'seatSet').map(entry => id(entry.owner));
  expect(sets.filter(row => declines.includes(row))).toEqual([]);
  const named = new Set(result.notes.flatMap(note => (note.owners ?? []).map(id)));
  const withdrawn = entries.filter(entry => entry.kind === 'seatSetDeclined' && (entry.payload as { at: string }).at !== 'input').map(entry => id(entry.owner));
  expect(withdrawn.filter(row => !declines.includes(row) && !named.has(row))).toEqual([]);
}

describe('the seat-set retry (dense-16x9 ticket 36, ruling B)', () => {
  it('places nothing again when the placement withdrew no set', async () => {
    const c = command(() => ({ sets: ['a'] }));
    const result = await retryWithdrawnSeatSets(model({ sets: ['a'] }, new Map()), c.port);
    expect([result.retries, c.placed, result.notes]).toEqual([0, [], []]);
    holds(result, c.declines());
  });

  it('the retry holds: the withdrawn row is declined, and the placement without it stands', async () => {
    const c = command(declined => declined.has('a') ? { sets: ['b'] } : { withdrawn: ['a'], sets: ['b'] });
    const result = await retryWithdrawnSeatSets(model({ withdrawn: ['a'], sets: ['b'] }, new Map()), c.port);
    expect([result.retries, c.placed, c.declines(), result.notes]).toEqual([1, [['a']], ['a'], []]);
    holds(result, c.declines());
  });

  it('the retry withdraws another row: that row is declined too, and the command places once more', async () => {
    const c = command(declined => declined.has('b') ? {} : declined.has('a') ? { withdrawn: ['b'] } : { withdrawn: ['a'] });
    const result = await retryWithdrawnSeatSets(model({ withdrawn: ['a'] }, new Map()), c.port);
    expect([result.retries, c.placed, c.declines()]).toEqual([2, [['a'], ['a', 'b']], ['a', 'b']]);
    holds(result, c.declines());
  });

  it('the retry changes which rows are in scope: a set on a row that came into scope and is withdrawn is declined as well', async () => {
    const c = command(declined => declined.has('c') ? { sets: ['b'] } : declined.has('a') ? { withdrawn: ['c'], sets: ['b'] } : { withdrawn: ['a'] });
    const result = await retryWithdrawnSeatSets(model({ withdrawn: ['a'] }, new Map()), c.port);
    expect([result.retries, c.declines()]).toEqual([2, ['a', 'c']]);
    holds(result, c.declines());
  });

  it('the retry is refused: the declines go back, and the placement before it stands, named', async () => {
    const c = command(() => 'refused');
    const first = model({ withdrawn: ['a'] }, new Map());
    const result = await retryWithdrawnSeatSets(first, c.port);
    expect([result.model, result.retries, c.declines()]).toEqual([first, 1, []]);
    expect(result.notes.map(note => [note.code, note.owners])).toEqual([[SEAT_SET_RETRY_REFUSED, [{ kind: 'group', id: 'a' }]]]);
    holds(result, c.declines());
  });

  it('the bound: past SEAT_SET_RETRIES placements the last one stands, its withdrawals named', async () => {
    let n = 0;
    const c = command(() => ({ withdrawn: [`r${++n}`] }));
    const result = await retryWithdrawnSeatSets(model({ withdrawn: ['r0'] }, new Map()), c.port);
    expect(result.retries).toBe(SEAT_SET_RETRIES);
    expect(c.placed).toHaveLength(SEAT_SET_RETRIES);
    expect(result.notes.map(note => [note.code, note.owners])).toEqual([[SEAT_SET_RETRY_BOUND, [{ kind: 'group', id: `r${SEAT_SET_RETRIES}` }]]]);
    holds(result, c.declines());
  });

  it('declines each row once per command: a row declined before is no new withdrawal', async () => {
    const c = command(() => ({ withdrawn: ['a'] }));
    c.port.decline(new Map([['a', 'earlier']]));
    const result = await retryWithdrawnSeatSets(model({ withdrawn: ['a'] }, new Map()), c.port);
    expect([result.retries, c.placed]).toEqual([0, []]);
  });
});
