import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel, withLayoutMutation } from '../../src/layout/mutation.js';
import { entryFailure, ofKind, reservation, type Reservation } from '../../src/layout/reservations.js';
import { withdrawSeatSet } from '../../src/layout/seat-set.js';
import { faceHeld, resortFaces } from '../../src/layout/free-slots.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import { retryWithdrawnSeatSets } from '../../src/pipeline/seat-retry.js';
import { FEED_ORDER_SLOT_HELD } from '../../src/layout/feed-order.js';
import { faceSortOf, orderFace } from '../../src/layout/sides-two.js';
import { staleFaces } from '../../src/layout/far-end-order.js';
import { SIDE_TIE_ORDER } from '../../src/layout/sides-one.js';
import { createEnv } from '../../src/pipeline/env.js';
import type { LayoutModel, LayoutStage } from '../../src/model/index.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 36, slice 3 (owner ruling 2): an unfed member of a seated row stands in a gap its seated neighbours leave. Stage 4 records the
 * member as open in its cell's `rowOrder` entry; the seat set closes the slot at stage 6, and the faces that read the member are sorted again by the
 * stage-5 sorter.
 */
const sheet = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const GAP = sheet('an-unfed-member-stands-in-a-gap-its-row-seats-leave');
const HELD = sheet('an-unfed-member-keeps-its-slot-where-the-row-below-reads-it');
const opts = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const run = async (yaml: string): Promise<LayoutModel> => layout(parse(yaml), opts);
/** The model the rows rule publishes (stage 6), captured on the way. */
const atRows = async (yaml: string): Promise<LayoutModel> => {
  const env = createEnv(parse(yaml), opts), step = env.step;
  let rows: LayoutModel | undefined;
  env.step = ((stage: LayoutStage, ...rest: unknown[]) => {
    const out = (step as (...args: unknown[]) => LayoutModel)(stage, ...rest);
    if (stage === 'rows' && rows === undefined) rows = structuredClone(out);
    return out;
  }) as typeof env.step;
  await env.place([]);
  return rows!;
};
const cellEntry = (model: LayoutModel, cell: string) => ofKind(model.reservations ?? [], 'rowOrder').find(entry => 'cell' in entry.payload && entry.payload.cell === cell);
const findings = (model: LayoutModel): string[] =>
  Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed && gate.severity === 'error').map(([id]) => id).sort();
/** The round, early and final reads of `entry`, and the full restore: each refusal, or 'ACCEPTED'. */
const reads = (model: LayoutModel, entry: Reservation): string[] => {
  let restore = 'ACCEPTED';
  try { restoreLayoutModel(JSON.stringify(model)); } catch (error) { restore = String(error); }
  return [entryFailure(entry, model, 'round') ?? 'ACCEPTED', entryFailure(entry, model, 'early') ?? 'ACCEPTED', entryFailure(entry, model, 'final') ?? 'ACCEPTED', restore];
};
/** The ports of a face in engine order, by name. */
const face = (model: LayoutModel, node: string, side: string): string[] =>
  model.nodes[node]!.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => port.ref.name!);
/** Swaps two ports of one face: their engine order and their anchors (the face as stage 5 left it before the slot closed). */
const swap = (model: LayoutModel, node: string, a: string, b: string): void => {
  const [one, two] = [a, b].map(name => model.nodes[node]!.ports.find(port => port.ref.name === name)!);
  const order = one!.engineOrder!;
  one!.engineOrder = two!.engineOrder!; two!.engineOrder = order;
  const anchor = one!.anchor!;
  one!.anchor = two!.anchor!; two!.anchor = anchor;
};

describe('an open member stands in a gap its row seats leave (dense-16x9 ticket 36, slice 3)', () => {
  it('seats r1 between c1 and c2 and sorts the faces below again', async () => {
    const model = await run(GAP);
    const [set] = ofKind(model.reservations ?? [], 'seatSet').filter(entry => entry.payload.row === 'site#1');
    expect(cellEntry(model, 'site#1')!.payload).toMatchObject({ open: ['r1'] });
    expect(set!.payload.order).toEqual(['c1', 'r1', 'c2']);
    expect(model.groups['site#1']!.rowOrder).toEqual(['c1', 'r1', 'c2']);
    // The faces of the block below stand in the order of their far ends: c1, r1, c2.
    for (const hub of ['h1', 'h2']) expect(face(model, hub, 'top'), hub).toEqual(['a', 'b', 'c']);
    expect(staleFaces(model)).toEqual([]);
    expect(findings(model)).toEqual([]);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 120000);

  it('keeps a member whose other slot changes the order below in its slot, by name', async () => {
    const model = await run(HELD);
    expect(model.diagnostics.filter(item => item.code === FEED_ORDER_SLOT_HELD).map(item => item.message)).toEqual([
      'r1 keeps its slot in site#1: at place 1 of the row the rows below it would be ordered otherwise.']);
    expect((cellEntry(model, 'site#1')?.payload as { open?: string[] } | undefined)?.open).toBeUndefined();
    expect(model.groups['site#1']!.rowOrder).toEqual(['c1', 'c2', 'r1']);
  }, 120000);

  // One sorter (R1): after the slot closed, the stage-5 sort run again on every face of the sheet changes nothing.
  it('leaves no face of the sheet that the stage-5 sorter would order otherwise', async () => {
    const model = await atRows(GAP);
    expect(model.groups['site#1']!.rowOrder).toEqual(['c1', 'r1', 'c2']);
    const sort = faceSortOf(model), changed: string[] = [];
    for (const id of Object.keys(model.nodes).sort()) for (const side of SIDE_TIE_ORDER) {
      const now = model.nodes[id]!.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
      if (orderFace(model, sort, id, side).ordered.some((port, index) => port !== now[index])) changed.push(`${id}.${side}`);
    }
    expect(changed).toEqual([]);
  }, 120000);

  // The failure of the design note's scratch slots variant (G5): the row reordered and the faces below left in their stage-5 order.
  it('refuses a row reordered with the faces below left in their stage-5 order', async () => {
    const model = await atRows(GAP);
    for (const hub of ['h1', 'h2']) swap(model, hub, 'b', 'c');
    const entry = ofKind(model.reservations ?? [], 'seatSet').find(item => item.payload.row === 'site#1')!;
    const out = reads(model, entry);
    expect(out.filter(item => item === 'ACCEPTED')).toEqual([]);
    expect(out[0]).toMatch(/reads a moved open member of site#1 and stands out of the order of its far ends/);
  }, 120000);

  // The forged records: `open` and the closed order are facts of the model at every read.
  it('refuses a fed member listed open', async () => {
    const model = structuredClone(await run(GAP)), entry = cellEntry(model, 'site#1')!;
    const forged = { ...entry, payload: { ...entry.payload, open: ['r1', 'c2'] } } as Reservation;
    model.reservations = model.reservations!.map(item => item === entry ? forged : item);
    const out = reads(model, forged);
    expect(out.filter(item => item === 'ACCEPTED')).toEqual([]);
    expect(out[0]).toMatch(/the open member c2 of site#1 is not free: its link .* ends on p2, outside the sub-tier directly below/);
  }, 120000);

  it('refuses a member with a peer link listed open', async () => {
    const yaml = GAP.replace("r1: { group: site, ports: [", "r1: { group: site, ports: [{ name: q, side: right }, ")
      .replace("c2: { group: site, ports: [", "c2: { group: site, ports: [{ name: q, side: left }, ") + '\n  - { from: r1.q, to: c2.q }\n';
    const model = structuredClone(await run(yaml)), entry = cellEntry(model, 'site#1')!;
    expect((entry.payload as { open?: string[] }).open).toBeUndefined();
    const forged = { ...entry, payload: { ...entry.payload, open: ['r1'] } } as Reservation;
    model.reservations = model.reservations!.map(item => item === entry ? forged : item);
    const out = reads(model, forged);
    expect(out.filter(item => item === 'ACCEPTED')).toEqual([]);
    expect(out[0]).toMatch(/the open member r1 of site#1 is not free: its link .* is a peer link in the row/);
  }, 120000);

  it('refuses an open member moved without the seat set that closes its slot, and a closed order that moves a fed member', async () => {
    const model = await run(GAP), entry = cellEntry(model, 'site#1')!;
    // No seat set stands in the order the row stands in.
    const unset = structuredClone(model);
    unset.reservations = unset.reservations!.filter(item => !(item.kind === 'seatSet' && item.payload.row === 'site#1'));
    const out = reads(unset, unset.reservations.find(item => item.id === entry.id)!);
    expect(out.filter(item => item === 'ACCEPTED')).toEqual([]);
    expect(out[0]).toMatch(/moves its open members, and no seat set of the row stands in that order/);
    // A fed member moved: the row and its set name c2 before c1.
    const swapped = structuredClone(model);
    swapped.groups['site#1']!.rowOrder = ['c2', 'r1', 'c1'];
    const set = swapped.reservations!.find(item => item.kind === 'seatSet' && item.payload.row === 'site#1')!;
    if (set.kind === 'seatSet') set.payload.order = ['c2', 'r1', 'c1'];
    const rowOut = reads(swapped, swapped.reservations!.find(item => item.id === entry.id)!), setOut = reads(swapped, set);
    expect([...rowOut, ...setOut].filter(item => item === 'ACCEPTED')).toEqual([]);
    expect(rowOut[0]).toMatch(/does not stand in the order its feeds give/);
    expect(setOut[0]).toMatch(/moves a member that the order of its row fixes/);
  }, 120000);

  it('lets no rule but the rows rule move an open member, and the rows rule no fed member', async () => {
    const rows = restoreLayoutModel(JSON.stringify(await atRows(GAP)));
    expect(() => withLayoutMutation(rows, 'lanes', draft => { draft.groups['site#1']!.rowOrder = ['c1', 'c2', 'r1']; })).toThrow(/Topology or membership changed/);
    // Before the rows rule: the open member stands where stage 4 put it, and the rows rule may not move a fed member.
    const env = createEnv(parse(GAP), opts), step = env.step;
    let before: LayoutModel | undefined;
    env.step = ((stage: LayoutStage, ...rest: unknown[]) => {
      const out = (step as (...args: unknown[]) => LayoutModel)(stage, ...rest);
      if (stage === 'sides-two' && before === undefined) before = structuredClone(out);
      return out;
    }) as typeof env.step;
    await env.place([]);
    const restored = restoreLayoutModel(JSON.stringify(before!));
    expect(restored.groups['site#1']!.rowOrder).toEqual(['c1', 'c2', 'r1']);
    expect(() => withLayoutMutation(restored, 'rows', draft => { draft.groups['site#1']!.rowOrder = ['c2', 'c1', 'r1']; })).toThrow(/Topology or membership changed/);
  }, 120000);

  // R3: the slot is chosen by content. With the links reversed the sheet is the same; with the nodes reversed stage 4 stands the parents the other
  // way round (as for slice 1), and r1 still stands between the seated members, with every face in the order of its far ends.
  it('chooses the same slot with the nodes or the links in reverse order (R3)', async () => {
    const links = await run(reversed(GAP, 'links'));
    expect(links.groups['site#1']!.rowOrder).toEqual(['c1', 'r1', 'c2']);
    for (const hub of ['h1', 'h2']) expect(face(links, hub, 'top'), hub).toEqual(['a', 'b', 'c']);
    const nodes = await run(reversed(GAP, 'nodes'));
    expect(nodes.groups['site#1']!.rowOrder![1]).toBe('r1');
    expect([...nodes.groups['site#1']!.rowOrder!].sort()).toEqual(['c1', 'c2', 'r1']);
    for (const model of [links, nodes]) { expect(staleFaces(model)).toEqual([]); expect(findings(model)).toEqual([]); }
  }, 240000);
});

/**
 * Review 1 of slice 3 (design/36c-review-1.md): the facing-pair key the dependency reader lost, a held face that bypassed the slot refusal, an open
 * record accepted without its proof, and a slot contest decided by declaration order. Each test was red on eb506a7e.
 */
const PAIR = sheet('an-open-member-with-a-facing-pair-sorts-the-pair-face-again');
const COMPETE = sheet('two-open-members-take-one-gap-by-content');
/** The gap sheet with one hub below (h2 and its links left out). */
const SINGLE = GAP.split('\n').filter(line => !line.startsWith('  h2:') && !line.includes('to: h2.') && !line.includes('from: h2.')).join('\n');
/** Every face that the stage-5 sorter would order otherwise than it stands. */
const unsorted = (model: LayoutModel): string[] => {
  const sort = faceSortOf(model), changed: string[] = [];
  for (const id of Object.keys(model.nodes).sort()) for (const side of SIDE_TIE_ORDER) {
    const now = model.nodes[id]!.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
    if (orderFace(model, sort, id, side).ordered.some((port, index) => port !== now[index])) changed.push(`${id}.${side}`);
  }
  return changed;
};
/** Swaps two declaration lines of the YAML (the lines that start with `a` and `b`). */
const swapLines = (yaml: string, a: string, b: string): string => {
  const lines = yaml.split('\n'), i = lines.findIndex(line => line.startsWith(a)), j = lines.findIndex(line => line.startsWith(b));
  [lines[i], lines[j]] = [lines[j]!, lines[i]!];
  return lines.join('\n');
};
/** The model with `open` of the `cell` entry replaced (a forged record). */
const forgeOpen = (model: LayoutModel, cell: string, open: string[]): Reservation => {
  const entry = cellEntry(model, cell)!, forged = { ...entry, payload: { ...entry.payload, open } } as Reservation;
  model.reservations = model.reservations!.map(item => item === entry ? forged : item);
  return forged;
};

describe('slice 3, review 1', () => {
  // Finding 1: a facing pair's key is cached when the sort is made; the face that reads a moved member through it is found and sorted again.
  it('sorts again a face that reads a moved open member through a facing pair', async () => {
    const rows = await atRows(PAIR);
    expect(rows.groups['site#1']!.rowOrder).toEqual(['c1', 'r1', 'c2']);
    expect(unsorted(rows)).toEqual([]);
    const model = await run(PAIR);
    expect(staleFaces(model)).toEqual([]);
    expect(findings(model)).toEqual([]);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 120000);

  // Finding 2: a face that the ledger holds in a far-end order declines the slot by name; the placement keeps the other slot.
  it('declines a slot whose face below a far-end order holds', async () => {
    const env = createEnv(parse(SINGLE), opts);
    const held = reservation('farEndOrder', { kind: 'node', id: 'h1' }, 'top', 'sides-two', 0,
      { node: 'h1', side: 'top', ports: ['a', 'c', 'b'].map(name => ({ node: 'h1', name, ordinal: 1 })) });
    const model = await env.place([held]);
    expect(model.groups['site#1']!.rowOrder).toEqual(['c1', 'c2', 'r1']);
    expect(face(model, 'h1', 'top')).toEqual(['a', 'c', 'b']);
  }, 120000);

  // Finding 2, as a class: one predicate names every other owner of a face (`faceHeld`), read before any face is sorted; one forged owner per kind.
  it('names every other owner of a face that reads a moved member before any face is sorted', async () => {
    const rows = await atRows(GAP), cell = rows.document.nodes.h1!.group;
    const top = (model: LayoutModel) => model.nodes.h1!.ports.filter(port => port.side === 'top');
    const atH1 = (model: LayoutModel) => model.links.filter(link => top(model).some(port => portId(port.ref) === portId(link.attachments!.to)));
    const forgeries: [string, (model: LayoutModel) => void, RegExp][] = [
      ['turn record', model => { model.freeze = { ...model.freeze, turnOrder: [{ node: 'h1', side: 'top' }] } as NonNullable<LayoutModel['freeze']>; }, /a turn record/],
      ['bar', model => { model.document.groups[cell] = { ...model.document.groups[cell]!, shape: 'bar' }; }, /a bar/],
      ['bundle', model => { for (const link of atH1(model)) link.bundle = 'forged'; }, /a bundle/],
      ['bus', model => { model.meshBuses = [{ id: 'forged', ports: [top(model)[0]!.ref] }] as unknown as NonNullable<LayoutModel['meshBuses']>; }, /a bus/],
      ['far-end order', model => { model.farEndOrder = [{ node: 'h1', side: 'top', ports: top(model).map(port => port.ref) }]; }, /a far-end order/],
      ['flank', model => { model.groups[cell]!.flank = { of: 'site#1' } as NonNullable<LayoutModel['groups'][string]['flank']>; }, /a flank/],
      ['stagger row', model => { model.staggerRows = [{ group: cell }] as unknown as NonNullable<LayoutModel['staggerRows']>; }, /a stagger row/],
      ['grid', model => { model.document.groups[cell] = { ...model.document.groups[cell]!, shape: 'grid' }; }, /a grid/],
    ];
    for (const [kind, forge, why] of forgeries) {
      const model = structuredClone(rows);
      forge(model);
      expect(`${kind}: ${faceHeld(model, faceSortOf(model), 'h1', 'top')}`).toMatch(why);
      const out = resortFaces(model, new Set(['r1']), false);
      expect(typeof out === 'string' ? out : 'SORTED', kind).toMatch(new RegExp(`the top face of h1 reads a moved member and belongs to ${why.source}`));
    }
    // The planned first turns: a sort whose turn reservations plan a turn on the face.
    const sort = faceSortOf(rows), port = top(rows)[0]!;
    const planned = { ...sort, planned: new Map([[portId(port.ref), { turn: 'low', shape: 'return', reach: 0 }]]), plainTurns: new Map() } as typeof sort;
    expect(faceHeld(rows, planned, 'h1', 'top')).toBe('the planned first turns');
    expect(faceHeld(rows, sort, 'h1', 'top')).toBeUndefined();
  }, 120000);

  // Finding 3: `open` is proved at every read by stage 4's own proof (`openProofFault`), and a premise reads an open member only through a proved record.
  it('refuses an open record without its lower-row proof, and a premise it would hide', async () => {
    const model = structuredClone(await run(HELD));
    const forged = forgeOpen(model, 'site#1', ['r1']);
    const out = reads(model, forged);
    expect(out.filter(item => item === 'ACCEPTED')).toEqual([]);
    expect(out[0]).toMatch(/the open member r1 of site#1 is not free: at place 1 of the row the rows below it would be ordered otherwise/);
    const premise = structuredClone(model), lower = cellEntry(premise, 'site#2')!;
    const feed = lower.payload.feeds.find(item => item.row === 'site#1')!;
    (feed as unknown as { order: string[] }).order = ['r1', 'c1', 'c2'];
    const lowerOut = reads(premise, lower);
    expect(lowerOut.filter(item => item === 'ACCEPTED')).toEqual([]);
  }, 120000);

  it('opens no member whose link ends on a lateral face, and no member of a canton row', async () => {
    const lateral = GAP.replace('h1: { group: site, ports: [{ name: a, side: top }, { name: b, side: top }', 'h1: { group: site, ports: [{ name: a, side: top }, { name: b, side: left }');
    const canton = GAP.replace('groups:\n', 'groups:\n  zone: { label: Zone }\n').replace('site: { tier: 1,', 'site: { tier: 1, canton: zone,');
    for (const [yaml, why] of [[lateral, /ends on a left face/], [canton, /in a canton/]] as const) {
      const model = structuredClone(await run(yaml));
      expect((cellEntry(model, 'site#1')?.payload as { open?: string[] } | undefined)?.open).toBeUndefined();
      const out = reads(model, forgeOpen(model, 'site#1', ['r1']));
      expect(out.filter(item => item === 'ACCEPTED')).toEqual([]);
      expect(out[0]).toMatch(why);
    }
  }, 240000);

  // Finding 4: two open members that compete for one gap; the choice ends on content, not on the declaration order (R3).
  it('chooses between competing open members by content (R3)', async () => {
    const plain = await run(COMPETE);
    expect(plain.groups['site#1']!.rowOrder).toEqual(['c1', 'r1', 'c2', 'r2']);
    for (const yaml of [swapLines(COMPETE, '  r1:', '  r2:'), reversed(COMPETE, 'links')]) {
      const model = await run(yaml);
      expect(model.groups['site#1']!.rowOrder).toEqual(['c1', 'r1', 'c2', 'r2']);
      expect(findings(model)).toEqual([]);
    }
  }, 240000);

  // A sheet of the corpus where a slot moves: `n1` has no link, so it is open. With the movement of the open member out of the leading keys (the fix
  // of finding 4), `k1` takes the seat nearer where it stood (under c2), and `n1` steps aside to the row end; the row width is the same.
  it('lets an open member step aside so the fed member takes the nearer seat', async () => {
    const model = await run(sheet('a-seated-row-leaves-its-lower-row-one-feed'));
    expect(model.groups['site#2']!.rowOrder).toEqual(['k1', 'n1']);
    const set = ofKind(model.reservations ?? [], 'seatSet').find(entry => entry.payload.row === 'site#2')!;
    expect(set.payload.seats.map(seat => seat.far.node)).toEqual(['c2']);
    expect(staleFaces(model)).toEqual([]);
    expect(findings(model)).toEqual([]);
  }, 120000);

  // Remaining check: a withdrawn set that closed a slot gives the slot and the faces back when the command places once more without it.
  it('gives the slot and the faces back when a withdrawn set is placed once more without it', async () => {
    const env = createEnv(parse(GAP), opts), model = structuredClone(await env.place([]));
    expect(model.groups['site#1']!.rowOrder).toEqual(['c1', 'r1', 'c2']);
    withdrawSeatSet(model, 'site#1', 'a withdrawal for the test');
    const out = await retryWithdrawnSeatSets(model, { place: () => env.place([]), declined: () => env.seatSetDeclined ?? new Map(),
      decline: rows => { env.seatSetDeclined = new Map([...(env.seatSetDeclined ?? []), ...rows]); }, snapshot: () => env.seatSetDeclined,
      restore: saved => { if (saved === undefined) delete env.seatSetDeclined; else env.seatSetDeclined = saved; }, refused: () => false });
    expect(out.retries).toBe(1);
    expect(out.model.groups['site#1']!.rowOrder).toEqual(['c1', 'c2', 'r1']);
    expect(face(out.model, 'h1', 'top')).toEqual(['a', 'c', 'b']);
    expect(() => restoreLayoutModel(JSON.stringify(out.model))).not.toThrow();
  }, 120000);
});
