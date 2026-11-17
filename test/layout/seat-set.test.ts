import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { findPort } from '../../src/layout/row-paths.js';
import { ofKind, type Reservation } from '../../src/layout/reservations.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 36, slice 1: stage 5 seats a child row under its parents' ports as one seat set (`seatSet`), and 7c applies it.
 * The fixture's children grew to 220 px on main to reach their feeds; the set keeps their width and stands both feeds vertical.
 */
const fixture = readFileSync(new URL('../../goldens/synthetic/a-child-row-stands-under-its-parents-ports.yaml', import.meta.url), 'utf8');
const run = async (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const seatSets = (model: LayoutModel) => ofKind(model.reservations ?? [], 'seatSet');
const vertical = (model: LayoutModel, link: string): boolean => {
  const item = model.links.find(entry => entry.id === link)!;
  const a = findPort(model, item.attachments!.from)!.anchor!, b = findPort(model, item.attachments!.to)!.anchor!;
  return Math.abs(a.x - b.x) <= 1e-6;
};
/** The seat set by content: each kept link as its two node ends, and each member's x from the set's first boundary node. */
const content = (model: LayoutModel) => seatSets(model).map(({ payload }) => {
  const ends = (link: string) => { const item = model.links.find(entry => entry.id === link)!; return `${item.attachments!.from.node}>${item.attachments!.to.node}`; };
  return { row: payload.row, seats: payload.seats.map(seat => ends(seat.link)).sort(), xs: Object.fromEntries(payload.order.map((id, i) => [id, payload.xs[i]])), interval: payload.interval };
});

describe('the seat set of a child row (dense-16x9 ticket 36, slice 1)', () => {
  it('stands each fed child under its parent at its own width, as one entry that 7c applies', async () => {
    const model = await run(fixture);
    const [entry] = seatSets(model);
    expect(seatSets(model)).toHaveLength(1);
    expect(entry!.payload.row).toBe('site#1');
    expect(entry!.payload.order).toEqual(['c1', 'c2']);
    expect(content(model)[0]!.seats).toEqual(['p1>c1', 'p2>c2']);
    for (const seat of entry!.payload.seats) expect(vertical(model, seat.link), seat.link).toBe(true);
    // The fed children keep the width of their content, as the unfed member does: no alignment growth inside an owned row.
    for (const id of ['c1', 'c2']) expect(model.nodes[id]!.bounds!.width, id).toBe(model.nodes.n1!.bounds!.width);
    expect(model.diagnostics.filter(note => note.code === 'SEAT_SET_WITHDRAWN')).toEqual([]);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 60000);

  it('refuses a restored model whose member left its seat or whose cell no longer covers the interval', async () => {
    const model = await run(fixture);
    const moved = JSON.parse(JSON.stringify(model)) as LayoutModel;
    seatSets(moved)[0]!.payload.xs[0]! += 5;
    expect(() => restoreLayoutModel(JSON.stringify(moved))).toThrow('the member c1 of site#1 left its seat');
    const narrow = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const [entry] = seatSets(narrow);
    entry!.payload.interval = { low: entry!.payload.interval.low - 50, high: entry!.payload.interval.high };
    expect(() => restoreLayoutModel(JSON.stringify(narrow))).toThrow('does not cover the interval of its seat set');
    const malformed = { ...model, reservations: (model.reservations ?? []).map(item => item.kind === 'seatSet' ? { ...item, payload: { ...item.payload, seats: [] } } as unknown as Reservation : item) };
    expect(() => restoreLayoutModel(JSON.stringify(malformed))).toThrow('Reservation is malformed');
  }, 60000);

  // With the links reversed the sheet is the same, and so is the set. With the nodes reversed stage 4 stands the parents the other way round
  // (a nodes difference that `npm run r3` reports on main too): the set keeps the same links, each vertical, at the same widths.
  it('chooses the same seat set with the nodes or the links in reverse order (R3)', async () => {
    const base = content(await run(fixture));
    expect(content(await run(reversed(fixture, 'links')))).toEqual(base);
    const flipped = await run(reversed(fixture, 'nodes'));
    expect(content(flipped).map(item => item.seats)).toEqual(base.map(item => item.seats));
    for (const seat of seatSets(flipped)[0]!.payload.seats) expect(vertical(flipped, seat.link), seat.link).toBe(true);
    for (const id of ['c1', 'c2']) expect(flipped.nodes[id]!.bounds!.width, id).toBe(flipped.nodes.n1!.bounds!.width);
  }, 120000);

  it('is what keeps the children narrow: without seat sets 7c grows them toward their feeds', async () => {
    const legacy = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testSeatSets: false });
    expect(seatSets(legacy)).toEqual([]);
    for (const id of ['c1', 'c2']) expect(legacy.nodes[id]!.bounds!.width, id).toBeGreaterThan(legacy.nodes.n1!.bounds!.width);
  }, 60000);

  it('makes no seat set without moveBeforeGrow', async () => {
    const model = await run(fixture.replace('layout: { moveBeforeGrow: true }', 'layout: { moveBeforeGrow: false }'));
    expect(seatSets(model)).toEqual([]);
    expect(model.diagnostics.filter(note => note.code.startsWith('SEAT_SET_'))).toEqual([]);
  }, 60000);
});
