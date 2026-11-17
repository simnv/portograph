import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { repackOverlaps } from '../../src/layout/rows.js';
import { findPort } from '../../src/layout/row-paths.js';
import { ofKind, type Reservation } from '../../src/layout/reservations.js';
import { SEAT_SET_REDECISIONS, seatSetScope } from '../../src/layout/seat-set.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withMoveBeforeGrow } from './move-before-grow.js';

/**
 * Dense-16x9 ticket 36, slice 1: stage 5 seats a child row under its parents' ports as one seat set (`seatSet`), and 7c applies it.
 * The set keeps the members at their own width and stands their feeds vertical; where they also feed the row below, 7c without the set
 * stretches them toward it (a-seated-row-leaves-its-lower-row-one-feed).
 */
const sheet = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const fixture = sheet('a-child-row-stands-under-its-parents-ports');
const run = async (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const seatSets = (model: LayoutModel) => ofKind(model.reservations ?? [], 'seatSet');
const vertical = (model: LayoutModel, link: string): boolean => {
  const item = model.links.find(entry => entry.id === link)!;
  const a = findPort(model, item.attachments!.from)!.anchor!, b = findPort(model, item.attachments!.to)!.anchor!;
  return Math.abs(a.x - b.x) <= 1e-6;
};
/** The link between two ports, by its ends. */
const between = (model: LayoutModel, from: string, to: string): string => {
  const [a, b] = [from.split('.'), to.split('.')];
  const ends = (end: { node: string; name?: string }, [node, name]: string[]) => end.node === node && end.name === name;
  return model.links.find(entry => ends(entry.attachments!.from, a!) && ends(entry.attachments!.to, b!))!.id;
};
const findings = (model: LayoutModel): string[] =>
  Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed && gate.severity === 'error').map(([id]) => id).sort();
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
    expect(entry!.payload.order).toEqual(['c1', 'n1', 'c2']);
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

  // The rows rule decides the sets in its last repack; every later repack (the call of 7e in bundle-geometry.ts) applies them and decides none.
  it('a later repack applies the sets it finds and decides none', async () => {
    const model = await run(fixture);
    const again = JSON.parse(JSON.stringify(model)) as LayoutModel;
    repackOverlaps(again);
    expect(seatSets(again)).toEqual(seatSets(model));
    for (const id of seatSets(model)[0]!.payload.order) expect(again.nodes[id]!.bounds).toEqual(model.nodes[id]!.bounds);
    const none = JSON.parse(JSON.stringify(model)) as LayoutModel;
    none.reservations = (none.reservations ?? []).filter(entry => entry.kind !== 'seatSet');
    repackOverlaps(none);
    expect(seatSets(none)).toEqual([]);
  }, 60000);

  it('makes no seat set without moveBeforeGrow', async () => {
    const model = await run(fixture.replace('layout: { moveBeforeGrow: true }', 'layout: { moveBeforeGrow: false }'));
    expect(seatSets(model)).toEqual([]);
    expect(model.diagnostics.filter(note => note.code.startsWith('SEAT_SET_'))).toEqual([]);
  }, 60000);
});

// The coordinator's ruling (option C): the seat set does not buy the verticals of the row below by stretched nodes; slice 3 seats both
// adjacent rows. These two sheets are that trade: one without a gate finding, and one that stands as expected-fail until slice 3.
describe('a seated row that also feeds the row below (dense-16x9 ticket 36, slice 1 trade)', () => {
  it('keeps its members at their own width under their parents; one feed to the row below stays a chord, with no gate finding', async () => {
    const model = await run(sheet('a-seated-row-leaves-its-lower-row-one-feed'));
    const upper = seatSets(model).find(item => item.payload.row === 'site#1')!;
    expect(content(model).find(item => item.row === 'site#1')!.seats).toEqual(['p1>c1', 'p2>c2']);
    for (const seat of upper.payload.seats) expect(vertical(model, seat.link), seat.link).toBe(true);
    for (const id of ['c1', 'c2']) expect(model.nodes[id]!.bounds!.width, id).toBe(model.nodes.n1!.bounds!.width);
    const below = [between(model, 'c1.b', 'k1.t1'), between(model, 'c2.b', 'k1.t3')];
    expect(below.filter(link => vertical(model, link))).toHaveLength(1);
    expect(findings(model)).toEqual([]);
  }, 120000);

  it('is what keeps the members narrow: without seat sets 7c stretches them toward the row below', async () => {
    const legacy = await layout(parse(sheet('a-seated-row-leaves-its-lower-row-one-feed')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testSeatSets: false });
    expect(seatSets(legacy)).toEqual([]);
    for (const id of ['c1', 'c2']) expect(legacy.nodes[id]!.bounds!.width, id).toBeGreaterThan(legacy.nodes.n1!.bounds!.width);
  }, 120000);

  // Expected to fail until slice 3 (both adjacent rows): today G6 parallel clearance, the chord c2 > k1 against the detour of n1 > k1.
  it.fails('slice 3: both adjacent rows: a-seated-row-and-the-row-below-stand-together has no gate finding (now G6, link-6 with link-7)', async () => {
    const model = await run(withMoveBeforeGrow(sheet('a-seated-row-and-the-row-below-stand-together')));
    expect(seatSets(model).map(item => item.payload.row)).toContain('site#1');
    expect(findings(model)).toEqual([]);
  }, 60000);

  it('is a sheet of the default without the option: no seat set, no gate finding', async () => {
    const model = await run(sheet('a-seated-row-and-the-row-below-stand-together'));
    expect(seatSets(model)).toEqual([]);
    expect(findings(model)).toEqual([]);
  }, 60000);
});

// Ruling A: one owner per row arrangement. A row the stage-5 wrap gate owns (a fan) takes no seat set, so the gate decides on the premise it read.
describe('a fan row the wrap gate owns takes no seat set (dense-16x9 ticket 36, slice 1, ruling A)', () => {
  it('stays wrapped on two lines, with no seat set and no gate finding', async () => {
    const model = await run(sheet('a-fan-row-the-wrap-gate-owns-takes-no-seat-set'));
    expect(model.staggerRows?.map(row => row.group)).toContain('west-zone#2');
    expect(seatSets(model).map(item => item.payload.row)).not.toContain('west-zone#2');
    expect(findings(model)).toEqual([]);
  }, 120000);

  it('names the scope of the fan row on its one-line reading: the wrap gate owns this row', async () => {
    const model = await run(sheet('a-fan-row-the-wrap-gate-owns-takes-no-seat-set'));
    const plain = JSON.parse(JSON.stringify(model)) as LayoutModel;
    delete plain.staggerRows;
    expect(seatSetScope(plain, plain.groups['west-zone#2']!)).toBe('the wrap gate owns this row');
    // A row of the same sheet that is no fan stays in scope.
    expect(seatSetScope(plain, plain.groups['east-zone#2']!)).toBeUndefined();
  }, 120000);
});

const seatNotes = (model: LayoutModel, code: string): string[] => (model.diagnostics ?? []).filter(item => item.code === code).map(item => item.message);

// Ruling B: a set that 7c withdraws is declined in the ledger, and the command places once more from stage 6 without it.
describe('a withdrawn seat set is declined and the command places once more (dense-16x9 ticket 36, ruling B)', () => {
  it('keeps no set and no withdrawal for the rows an earlier placement withdrew, names each one, and restores', async () => {
    const model = await run(withMoveBeforeGrow(sheet('a-leaf-child-and-its-beside-cells-stay-one-row')));
    const declined = ofKind(model.reservations ?? [], 'seatSetDeclined').map(entry => entry.payload);
    expect(declined.map(entry => [entry.row, entry.at])).toEqual([['loc#2', 'input'], ['zone#4', 'input']]);
    expect(seatSets(model).map(item => item.payload.row).filter(row => declined.some(entry => entry.row === row))).toEqual([]);
    expect(seatNotes(model, 'SEAT_SET_WITHDRAWN')).toEqual([]);
    expect(seatNotes(model, 'SEAT_SET_DECLINED').filter(message => message.includes('(withdrawn)'))).toHaveLength(2);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 120000);
});

// The guard of the last repack refuses one set per round while the frame columns would crowd a fixed group, at most SEAT_SET_REDECISIONS rounds.
describe('the sets are decided again at most SEAT_SET_REDECISIONS times (dense-16x9 ticket 36, slice 1)', () => {
  it('refuses one set per round, and past the bound every set of the run, each by name', async () => {
    const model = await run(withMoveBeforeGrow(sheet('a-grid-group-stands-fixed-beside-frames')));
    const owner = seatNotes(model, 'SEAT_SET_DECLINED').filter(message => message.includes('(owner)') && message.includes('the grid spares, which gives no way'));
    const bound = `(the sets were decided ${SEAT_SET_REDECISIONS} times)`;
    expect(owner.filter(message => !message.includes(bound))).toHaveLength(SEAT_SET_REDECISIONS - 1);
    expect(owner.filter(message => message.includes(bound)).length).toBeGreaterThan(0);
    expect(seatSets(model)).toEqual([]);
  }, 120000);
});

