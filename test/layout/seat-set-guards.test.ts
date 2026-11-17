import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/model/index.js';
import { layout, parse } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { entryFailure, ofKind, reservation, seatSetFault } from '../../src/layout/reservations.js';
import { clampFarEndShift, nameFarEndClamp, SEAT_FAR_END_CLAMPED, seatFarEndRange, seatInterval, seatSetsLost } from '../../src/layout/seat-set.js';
import type { SeatSetPayload } from '../../src/layout/reservations.js';
import { withMoveBeforeGrow } from './move-before-grow.js';
import { createEnv } from '../../src/pipeline/env.js';
import type { LayoutStage } from '../../src/model/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 36a, reviews 2 and 3: the guards of the seat-set records and of the far-end range, closed as a class (the pattern of tickets
// 29 and 31).
//
// Every field of the two records, the predicate that proves it, and its reads. "Reads" means all three of `RESERVATION_CHECKS` (round, early,
// final: `everywhere`) and both restores, through `seatSetFault` and `seatSetDeclinedFault` in reservations.ts. `shape` is `shapeFailure`, and
// `ledger` is `validateLedgerShape`, at both restores and at every round check.
//
// seatSet (entry)
//   id, activeFrom, revision   ledger: unique id, the kind's activeFrom, an integer revision >= 0.
//   owner, producer            seatSetFault: the group of `row`, producer 'rows'; one seat set per row.
// seatSet.payload
//   row                        seatSetFault: a group of the model with a box; owner is that group.
//   frame                      seatSetFault: the group's frame.
//   order                      seatSetFault: the group's rowOrder (or nodes), the same list; against the cell's rowOrder entry (slice 3,
//                              `closedSlotsFaultOf`): only its open members in other slots, and every face that reads an open member in the
//                              order of its far ends (the G5 predicate, `staleThrough`). Forged rows: test/layout/free-slots.test.ts.
//   widths, xs                 seatSetFault: each member body at its x (relative to the origin) and width, to PLACEMENT_EPS.
//   seats[]                    seatSetProvenanceFault: a link of the model, once over seats, holds and declined; its ends are the member and far
//                              ports; member in the row, far outside; a feed by `equationKind` (the reader `readRow` uses: routed, no solid-block
//                              chord, the member's top port under a bottom port of a node of the frame on a tier above, no bundle), far port above.
//     memberOffset             seatSetFault: the member port's offset on its body, to PLACEMENT_EPS.
//     farOffset                read by no decision and not proved: the far port's offset at the decision; the ruled boundary is the port, so a
//                              parent body that grows keeps the set (the doc of seatSetProvenanceFault says so).
//     the equation             seatSetFault: member port over far port, to PLACEMENT_EPS.
//   holds[]                    seatSetProvenanceFault: as a seat, but a `side` link by `equationKind` (through a member's top or bottom face, no
//                              feed); seatSetFault: the two anchors within SEAT_STANDS_EPS.
//   blockFaces[]               seatSetProvenanceFault: each solid-block face of a member claimed exactly once (keys with counts) with its
//                              complete port list; seatSetFault: the ports in that order.
//   boundary[]                 seatSetProvenanceFault: exactly the far ports of the equations, in key order; seatSetFault: each at its offset x.
//   interval                   seatSetFault: covers every member body, and the cell box covers it.
//   declined[]                 seatSetProvenanceFault: a feed of the row by `equationKind`, once, and no equation of the set. reason: shape only;
//                              a label of the diagnostic, read by no decision.
// rowOrder.payload.open (slice 3; the other fields of rowOrder are ticket 25's)
//   open[]                     rowOrderFailure (`openFault`), with the writer's proof (review 1 of slice 3): each a member of the cell and of the
//                              entry's order, once; every link leaves its bottom face for the top face of a node in the sub-tier directly below,
//                              and the cell stands in no canton (`openMemberFault`: no feed from above, no peer link); no other slot of it in
//                              the entry's order changes a decision below (`openSlotHeld` over `belowReader`, the reader stage 4 wrote it with).
//                              The cell may stand off the entry's order only in its open members (`closedSlotsFault`), from the rows rule on,
//                              in no stagger row and no feeding chain, in the order of a standing seat set of the row (or of a set this run
//                              withdrew); a premise that reads a cell with proved open members reads the order stage 4 recorded for it
//                              (`openOrder`), any other feeding row the order it stands in. The mutation guard lets only the rows rule move
//                              them (`structure` with the open members read out). Forged rows: test/layout/free-slots.test.ts (a fed member
//                              listed open, a member with a peer link, a member that a slot below holds, a premise that hides one, a member
//                              with a link to a lateral face, a member of a canton row, an open member moved with no seat set, a permutation
//                              that moves a fed member, a rule other than rows that moves an open member).
// seatSetDeclined (entry)
//   id, activeFrom, revision   ledger, as above.
//   owner, producer            seatSetDeclinedFault: the group of `row`, producer 'rows'; one decline per row; no seat set of the row stands.
// seatSetDeclined.payload
//   row                        seatSetDeclinedFault: a group of the model, on a model from stage 6 on.
//   at                         seatSetDeclinedFault: 'input', or a rule from the rows rule on that the model has reached (its stage at least the
//                              stage before the rule: a rule edits a draft that carries the stage before it).
//   why                        shape only: the reason the rule gave. `seatSetsLost` reads its clause on the settled copies of one run (never on a
//                              restored model), and the retry names it.
//   fixed[]                    seatSetDeclinedFault: only on a withdrawal from 7c on; each { link, node } a link the rows rule reads as an equation
//                              of the row (`equationEnds`, `equationKind`) from `node` outside the row to a member, once. Lifetime: the rest of the
//                              placement run that withdrew the set; the next placement writes the decline at its input without it.
const opts = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const CHILD_ROW = readFileSync(new URL('../../goldens/synthetic/a-child-row-stands-under-its-parents-ports.yaml', import.meta.url), 'utf8');
/** The child row with a complete solid block under it: `c1` and `c2` feed `g1`, `g2` and `n1`, so the set holds two bottom block faces. */
const BLOCK = CHILD_ROW.replace('\nlinks:', '\n  g1: { group: site }\n  g2: { group: site }\nlinks:')
  + '\n  - [c1, g1]\n  - [c1, g2]\n  - [c2, g1]\n  - [c2, g2]\n  - [c1, n1]\n  - [c2, n1]\n';

describe('the far-end range, table-driven (dense-16x9 ticket 36a, review 2)', () => {
  // A synthetic ledger: rows a to d stand on tiers 0 to 3, each one node of its own name with one port; u is an unrelated row beside a.
  const ROWS = ['a', 'b', 'c', 'd', 'u'] as const, TIER: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, u: 0 };
  const base = (): LayoutModel => {
    const m = { document: { nodes: {} as Record<string, { group: string }> }, nodes: {} as Record<string, unknown>, groups: {} as Record<string, unknown>, anchorTier: 99, reservations: [] as unknown[], diagnostics: [] as unknown[] };
    for (const row of ROWS) {
      const x = row === 'u' ? 400 : 0, y = TIER[row]! * 100;
      m.document.nodes[row] = { group: row };
      m.nodes[row] = { id: row, bounds: { x, y, width: 100, height: 40 }, ports: [{ ref: { node: row, port: 'p' }, side: 'bottom', anchor: { x: x + 50, y } }] };
      m.groups[row] = { id: row, tier: TIER[row], nodes: [row], bounds: { x, y, width: 100, height: 40 } };
    }
    return m as unknown as LayoutModel;
  };
  const set = (row: string, far: string[]) => reservation('seatSet', { kind: 'group', id: row }, '', 'rows', 0, {
    row, frame: 'f', order: [row], widths: [100], xs: [0],
    seats: far.map(id => ({ link: `${id}-${row}`, member: { node: row, port: 'p' }, far: { node: id, port: 'p' }, memberOffset: 50, farOffset: 0 })),
    holds: [], blockFaces: [], boundary: far.map(id => ({ port: { node: id, port: 'p' }, x: 0 })), interval: { low: -50, high: 50 }, declined: [],
  } as unknown as SeatSetPayload);
  const declined = (row: string, far: string[]) => reservation('seatSetDeclined', { kind: 'group', id: row }, '', 'rows', 0,
    { row, at: 'centre', why: 'the parent port moved', fixed: far.map(id => ({ link: `${id}-${row}`, node: id })) });
  // The room of each seated row: b and d in a wide column, c in a narrow one.
  const ROOM: Record<string, { low: number; high: number }> = { b: { low: -20, high: 140 }, c: { low: -5, high: 110 }, d: { low: -60, high: 160 } };
  const room = (row: string) => ROOM[row] ?? { low: -Infinity, high: Infinity };
  const CASES: { name: string; ledger: () => unknown[]; anchor?: number; range: [number, number] | undefined; binds: string[] }[] = [
    { name: 'no set', ledger: () => [], range: undefined, binds: [] },
    { name: 'one set', ledger: () => [set('b', ['a'])], range: [-20, 40], binds: ['b'] },
    { name: 'a chain of two', ledger: () => [set('b', ['a']), set('c', ['b'])], range: [-5, 10], binds: ['b', 'c'] },
    { name: 'a chain of two, ledger reversed', ledger: () => [set('c', ['b']), set('b', ['a'])], range: [-5, 10], binds: ['b', 'c'] },
    { name: 'a chain with a direct feed', ledger: () => [set('b', ['a']), set('c', ['a', 'b'])], range: [-5, 10], binds: ['b', 'c'] },
    { name: 'a chain with a direct feed, ledger reversed', ledger: () => [set('c', ['a', 'b']), set('b', ['a'])], range: [-5, 10], binds: ['b', 'c'] },
    { name: 'two sets sharing a far-end row, in different columns', ledger: () => [set('b', ['a']), set('d', ['a'])], range: [-20, 40], binds: ['b', 'd'] },
    { name: 'an anchor-tier set', ledger: () => [set('b', ['a'])], anchor: 1, range: undefined, binds: [] },
    { name: 'a set withdrawn with fixed far ends', ledger: () => [declined('b', ['a'])], range: [0, 0], binds: [] },
  ];
  const MOVES: { name: string; moving: string; dx: number }[] = [
    { name: 'inside the room', moving: 'a', dx: 4 },
    { name: 'past the wall', moving: 'a', dx: 300 },
    { name: 'an unrelated row', moving: 'u', dx: 300 },
  ];
  /** Whether a standing set still stands after the groups `moved` translate by dx: its far ends all move and its row stays in its room, or none moves. */
  const stands = (m: LayoutModel, p: SeatSetPayload, moved: Set<string>, dx: number): boolean => {
    const carriers = [...p.seats, ...p.holds].map(eq => m.document.nodes[eq.far.node]!.group);
    if (!carriers.some(id => moved.has(id))) return true;
    if (!carriers.every(id => moved.has(id)) || !moved.has(p.row)) return Math.abs(dx) <= 1e-9;
    const at = seatInterval(m, p), r = room(p.row);
    return at.low + dx >= r.low - 1e-9 && at.high + dx <= r.high + 1e-9;
  };
  for (const c of CASES) for (const move of MOVES) it(`${c.name}: a move of ${move.name}`, () => {
    const m = base();
    m.reservations = c.ledger() as NonNullable<LayoutModel['reservations']>;
    if (c.anchor !== undefined) m.anchorTier = c.anchor;
    const range = seatFarEndRange(m, [move.moving], room);
    // No node outside a set's equations is bound: an unrelated row reads no range.
    if (move.moving === 'u') { expect(range).toBeUndefined(); return; }
    expect(range === undefined ? undefined : [range.low, range.high]).toEqual(c.range);
    const shift = clampFarEndShift(range, move.dx);
    if (shift.clamped) nameFarEndClamp(m, 'the probe', move.moving, move.dx, shift.dx, range!.why);
    // A clamp is named.
    expect(m.diagnostics.some(d => d.code === SEAT_FAR_END_CLAMPED)).toBe(shift.clamped);
    expect(shift.clamped).toBe(c.range !== undefined && (move.dx < c.range[0] || move.dx > c.range[1]));
    // The standing sets after the step include the standing sets before. The anchor-tier set is the documented exception: it sets no bound,
    // and its rule withdraws it by name (pipeline.md, 7c).
    const moved = new Set([move.moving]);
    for (let grew = true; grew;) {
      grew = false;
      for (const entry of ofKind(m.reservations ?? [], 'seatSet')) {
        const carriers = [...entry.payload.seats, ...entry.payload.holds].map(eq => eq.far.node);
        if (!moved.has(entry.payload.row) && m.groups[entry.payload.row]!.tier !== m.anchorTier && carriers.every(id => moved.has(id))) { moved.add(entry.payload.row); grew = true; }
      }
    }
    const lost = ofKind(m.reservations ?? [], 'seatSet').filter(entry => !stands(m, entry.payload, moved, shift.dx)).map(entry => entry.payload.row);
    expect(lost).toEqual(c.anchor !== undefined && Math.abs(shift.dx) > 0 ? ['b'] : []);
    expect([...moved].filter(id => id !== move.moving).sort()).toEqual(c.anchor === undefined ? c.binds : []);
  });
});

describe('the seat-set records prove their own evidence (dense-16x9 ticket 36a, review 2)', () => {
  it('claims each solid-block face exactly once: a duplicate or a missing face is refused', async () => {
    const model = await layout(parse(BLOCK), opts);
    const entry = ofKind(model.reservations ?? [], 'seatSet').find(item => item.payload.blockFaces.length >= 2)!;
    expect(entry, 'the generic block sheet publishes a set with two block faces').toBeDefined();
    expect(seatSetFault(entry, model)).toBeUndefined();
    const forged = (change: (p: SeatSetPayload) => void): string | undefined => {
      const copy = structuredClone(model), item = ofKind(copy.reservations ?? [], 'seatSet').find(one => one.id === entry.id)!;
      change(item.payload);
      return entryFailure(item, copy, 'round');
    };
    expect(forged(p => { p.blockFaces[1] = structuredClone(p.blockFaces[0]!); })).toMatch(/claims the block face .* twice/);
    expect(forged(p => { p.blockFaces = p.blockFaces.slice(0, 1); })).toMatch(/leaves the solid-block face .* out/);
    expect(forged(p => { p.blockFaces = [...p.blockFaces, structuredClone(p.blockFaces[0]!)]; })).toMatch(/twice/);
  }, 120000);

  it('keeps far ends fixed only for the equations of the declined row, and only from 7c on', async () => {
    const model = await layout(parse(CHILD_ROW), opts);
    const set = ofKind(model.reservations ?? [], 'seatSet')[0]!.payload, eq = set.seats[0]!;
    const check = (payload: { row: string; at: string; why: string; fixed?: { link: string; node: string }[] }): string | undefined => {
      const copy = structuredClone(model), entry = reservation('seatSetDeclined', { kind: 'group', id: payload.row }, '', 'rows', 0, payload);
      copy.reservations = [...(copy.reservations ?? []).filter(item => !(item.kind === 'seatSet' && item.payload.row === payload.row)), entry];
      return entryFailure(entry, copy, 'round');
    };
    // The record the withdrawal writes: the far end of an equation of the row, proved by its link.
    expect(check({ row: set.row, at: 'centre', why: 'probe', fixed: [{ link: eq.link, node: eq.far.node }] })).toBeUndefined();
    // An input decline has no 7c position to hold (the forgery of review 2: an unrelated row kept a node of the child row fixed).
    expect(check({ row: 'up', at: 'input', why: 'probe', fixed: [{ link: eq.link, node: 'c1' }] })).toMatch(/only a withdrawal from 7c on/);
    expect(check({ row: set.row, at: 'rows', why: 'probe', fixed: [{ link: eq.link, node: eq.far.node }] })).toMatch(/only a withdrawal from 7c on/);
    // A node no equation of the row reaches, a link of another row, and a link listed twice are refused.
    expect(check({ row: 'up', at: 'centre', why: 'probe', fixed: [{ link: eq.link, node: 'c1' }] })).toMatch(/no equation of the row/);
    expect(check({ row: set.row, at: 'centre', why: 'probe', fixed: [{ link: eq.link, node: eq.member.node }] })).toMatch(/no equation of the row/);
    expect(check({ row: set.row, at: 'centre', why: 'probe', fixed: [{ link: eq.link, node: eq.far.node }, { link: eq.link, node: eq.far.node }] })).toMatch(/no equation of the row/);
  }, 120000);

  // Review 3: the two states restore accepted at 7a198abe. Each is refused by the round, early and final reads and by the full restore.
  const reads = (m: LayoutModel, e: Parameters<typeof entryFailure>[0]): string[] => {
    let restore = 'ACCEPTED';
    try { restoreLayoutModel(JSON.stringify(m)); } catch (error) { restore = String(error); }
    return [entryFailure(e, m, 'round') ?? 'ACCEPTED', entryFailure(e, m, 'early') ?? 'ACCEPTED', entryFailure(e, m, 'final') ?? 'ACCEPTED', restore];
  };
  it('refuses a withdrawal the model has not reached: fixed far ends at 7c on a stage-6 model', async () => {
    const env = createEnv(parse(CHILD_ROW), opts), step = env.step;
    let rows: LayoutModel | undefined;
    env.step = ((stage: LayoutStage, ...rest: unknown[]) => {
      const out = (step as (...args: unknown[]) => LayoutModel)(stage, ...rest);
      if (stage === 'rows') rows = structuredClone(out);
      return out;
    }) as typeof env.step;
    await env.place([]);
    expect(rows!.stage).toBe('rows');
    const p = ofKind(rows!.reservations ?? [], 'seatSet')[0]!.payload, eq = p.seats[0]!;
    const entry = reservation('seatSetDeclined', { kind: 'group', id: p.row }, '', 'rows', 0, { row: p.row, at: 'centre', why: 'a future withdrawal', fixed: [{ link: eq.link, node: eq.far.node }] });
    rows!.reservations = [...(rows!.reservations ?? []).filter(item => item.kind !== 'seatSet'), entry];
    const out = reads(rows!, entry);
    expect(out.filter(item => item === 'ACCEPTED')).toEqual([]);
    expect(out[0]).toMatch(/has not reached that rule/);
  }, 120000);
  it('refuses a solid-block chord as a fixed far end: the rows rule never reads it as an equation', async () => {
    const model = await layout(parse(BLOCK), opts);
    const p = ofKind(model.reservations ?? [], 'seatSet').find(item => item.payload.blockFaces.length >= 2)!.payload;
    const chord = model.links.find(link => link.solidBlock && [link.attachments!.from.node, link.attachments!.to.node].includes(p.order.find(id => p.blockFaces.some(face => face.node === id))!))!;
    const member = p.order.includes(chord.attachments!.from.node) ? chord.attachments!.from.node : chord.attachments!.to.node;
    const node = chord.attachments!.from.node === member ? chord.attachments!.to.node : chord.attachments!.from.node;
    expect(p.order.includes(node), 'the chord leaves the row').toBe(false);
    const entry = reservation('seatSetDeclined', { kind: 'group', id: p.row }, '', 'rows', 0, { row: p.row, at: 'centre', why: 'probe', fixed: [{ link: chord.id, node }] });
    const copy = structuredClone(model);
    copy.reservations = [...(copy.reservations ?? []).filter(item => !(item.kind === 'seatSet' && item.payload.row === p.row)), entry];
    const out = reads(copy, entry);
    expect(out.filter(item => item === 'ACCEPTED')).toEqual([]);
    expect(out[0]).toMatch(/no equation of the row/);
  }, 120000);

  // Lifetime of `fixed`: from the withdrawal to the end of that placement run. The placement the command runs without the set writes the
  // decline again at its input, with no far ends, so its 7c moves those rows again.
  it('carries no fixed far ends past the placement that withdrew the set', async () => {
    const text = withMoveBeforeGrow(readFileSync(new URL('../../goldens/synthetic/a-flank-bundle-into-a-ranked-group-stays-beside-the-frame.yaml', import.meta.url), 'utf8'));
    const model = await layout(parse(text), opts);
    expect(model.diagnostics.some(d => d.code === 'SEAT_SET_DECLINED' && d.message.includes('withdrawn at bundles'))).toBe(true);
    const declines = ofKind(model.reservations ?? [], 'seatSetDeclined').map(entry => entry.payload);
    expect(declines.length).toBeGreaterThan(0);
    expect(declines.filter(item => item.at !== 'input' || item.fixed !== undefined)).toEqual([]);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 900000);

  it('reads lost sets as identities, not counts', () => {
    const ledger = (standing: string[], declined: [string, string][]) => ({ reservations: [
      ...standing.map(row => reservation('seatSet', { kind: 'group', id: row }, '', 'rows', 0, { row } as unknown as SeatSetPayload)),
      ...declined.map(([row, why]) => reservation('seatSetDeclined', { kind: 'group', id: row }, '', 'rows', 0, { row, at: 'centre', why })),
    ] }) as unknown as LayoutModel;
    const before = ledger(['a'], [['b', 'the row would leave the column of its frame (1 to 2)']]);
    const after = ledger(['b'], [['a', 'the row would leave the column of its frame (1 to 2)']]);
    expect(seatSetsLost(before, after, 'the row would leave the column of its frame')).toEqual(['a']);
    expect(seatSetsLost(before, ledger(['a'], []), 'the row would leave the column of its frame')).toEqual([]);
    expect(seatSetsLost(before, ledger([], [['a', 'its row is the anchor tier']]), 'the row would leave the column of its frame')).toEqual([]);
    expect(seatSetsLost(before, ledger([], [['a', 'its row is the anchor tier']]))).toEqual(['a']);
  });
});
