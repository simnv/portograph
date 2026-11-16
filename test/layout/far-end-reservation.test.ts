import { describe, expect, it } from 'vitest';
import { holds } from '../../src/layout/reservation-checks.js';
import { farEndEntries, farEndOrderOf, reserve, validateReservations } from '../../src/layout/reservations.js';
import { faceIsStale, standsWrong } from '../../src/layout/far-end-order.js';

/** Dense-16x9 ticket 07: the ledger entry `farEndOrder`, its checks, and G5's shared predicate. Generic names only. */
const ref = (name: string, ordinal: number) => ({ node: 'hub', name, ordinal });
const a = ref('a', 1), b = ref('b', 2), c = ref('c', 3);
const model = (order: readonly string[], extra: object = {}): never => ({
  links: [], stage: 'sides-two', ...extra,
  nodes: { hub: { id: 'hub', ports: [a, b, c].map(item => ({ ref: item, side: 'bottom', engineOrder: order.indexOf(item.name) })) } },
}) as never;

describe('the far-end order of the ledger', () => {
  const entries = farEndEntries([{ node: 'hub', side: 'bottom', ports: [c, a, b] }], 'farEnd', 2);
  it('holds when the face stands in the reserved order, and fails by name when it does not', () => {
    expect(holds(entries, model(['c', 'a', 'b']))).toEqual([]);
    const failed = holds(entries, model(['a', 'b', 'c']));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.kind).toBe('farEndOrder');
    expect(failed[0]!.why).toMatch(/bottom face of hub.*reserved order/);
  });
  it('fails a face the model does not have, and a face with a port more', () => {
    const missing = farEndEntries([{ node: 'ghost', side: 'bottom', ports: [a, b] }], 'farEnd', 2);
    expect(holds(missing, model(['c', 'a', 'b']))[0]!.why).toMatch(/does not exist/);
    const two = farEndEntries([{ node: 'hub', side: 'bottom', ports: [c, a] }], 'farEnd', 2);
    expect(holds(two, model(['c', 'a', 'b']))).toHaveLength(1);
  });
  it('replaces an earlier entry for the face: the latest proposal stands', () => {
    const later = farEndEntries([{ node: 'hub', side: 'bottom', ports: [a, b, c] }], 'farEnd', 3);
    expect(farEndOrderOf(reserve(entries, later))[0]!.ports.map(port => port.name)).toEqual(['a', 'b', 'c']);
    expect(reserve(entries, later)).toHaveLength(1);
  });
  it('reads back in node and side order', () => {
    const faces = farEndEntries([{ node: 'z', side: 'top', ports: [a, b] }, { node: 'a', side: 'left', ports: [a, b] }, { node: 'a', side: 'bottom', ports: [a, b] }], 'farEnd', 1);
    expect(farEndOrderOf(faces).map(face => `${face.node}|${face.side}`)).toEqual(['a|bottom', 'a|left', 'z|top']);
  });
  it('is validated on restore: the model carries the entry, or the ledger and the model disagree', () => {
    const seated = { farEndOrder: [{ node: 'hub', side: 'bottom', ports: [c, a, b] }], reservations: entries };
    expect(() => validateReservations(model(['c', 'a', 'b'], seated))).not.toThrow();
    expect(() => validateReservations(model(['c', 'a', 'b'], { reservations: entries }))).toThrow(/far-end orders/);
    expect(() => validateReservations(model(['c', 'a', 'b'], { farEndOrder: seated.farEndOrder, reservations: [] }))).toThrow(/far-end orders/);
  });
  it('refuses a malformed entry (R6: a guard that cannot read its input refuses)', () => {
    const bad = [{ ...entries[0]!, payload: { node: 'hub', side: 'bottom', ports: [a] } }] as never;
    expect(() => validateReservations(model(['c', 'a', 'b'], { reservations: bad }))).toThrow(/malformed/);
    const twice = [{ ...entries[0]!, payload: { node: 'hub', side: 'bottom', ports: [a, a] } }] as never;
    expect(() => validateReservations(model(['c', 'a', 'b'], { reservations: twice }))).toThrow(/malformed/);
  });
});

describe('G5 predicate shared with the far-end round', () => {
  const port = (own: number, min: number, max: number) => ({ port: {} as never, own, min, max });
  it('fails strictly separated ranges that stand the other way round, and only those', () => {
    expect(standsWrong({ own: 1, min: 20 }, { own: 2, max: 10 })).toBe(true);
    expect(standsWrong({ own: 1, min: 10 }, { own: 2, max: 10 })).toBe(false);
    expect(standsWrong({ own: 2, min: 20 }, { own: 1, max: 10 })).toBe(false);
  });
  it('a face is stale when any pair fails, and not when ranges overlap', () => {
    expect(faceIsStale([port(1, 20, 25), port(2, 5, 10)])).toBe(true);
    expect(faceIsStale([port(1, 5, 25), port(2, 5, 10)])).toBe(false);
    expect(faceIsStale([port(1, 5, 10), port(2, 20, 25)])).toBe(false);
  });
});
