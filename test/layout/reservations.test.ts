import { describe, expect, it } from 'vitest';
import { courseEntries, holds, holdsRouted, promisedTurns, coursesOf, declinedEntries, declineTrunk, declinedTrunksOf, DeclinedTrunks, laneKeysOf, laneOwners, nodeFloors, nodeFloorsOf, pitchFloors, pitchFloorsOf, portRefOf, reserve, validateReservations, sideFaces, sideHintsOf, spanEntries, spansOf, turnEntries, turnOf } from '../../src/layout/reservations.js';
import { portKey } from '../../src/layout/sides-one.js';

describe('reservation ledger', () => {
  it('refuses a restored model whose pitch is under a reserved floor, and one that holds twice an id', () => {
    const ledger = pitchFloors(new Map([['n', { left: 10 }]]), 'fan', 0);
    const model = (pitch: number, reservations = ledger): never => ({ links: [], reservations, nodes: { n: { id: 'n', ports: [], sidePitch: { left: pitch } } } }) as never;
    expect(() => validateReservations(model(10))).not.toThrow();
    expect(() => validateReservations(model(9))).toThrow(/does not hold/);
    expect(() => validateReservations(model(10, [...ledger, ...ledger]))).toThrow(/held twice/);
  });
  it('refuses a ledger whose node floors are not the frozen ones', () => {
    const ledger = nodeFloors(new Map([['n', { width: 10, height: 20 }]]), 'side', 0);
    const model = (frozen: number): never => ({ links: [], reservations: ledger, freeze: { nodeFloors: [{ node: 'n', size: { width: frozen, height: 20 } }] }, nodes: { n: { id: 'n', ports: [], size: { width: 12, height: 20 } } } }) as never;
    expect(() => validateReservations(model(10))).not.toThrow();
    expect(() => validateReservations(model(11))).toThrow(/frozen node floors/);
  });
  it('refuses a side face the port does not stand on, and a hinted port with no reservation', () => {
    const ref = { node: 'n', name: 'p', ordinal: 1 }, key = portKey(ref);
    const ledger = sideFaces(new Map([[key, 'left' as const]]), new Map(), 'side', 0);
    const model = (port: object, reservations = ledger): never => ({ links: [], reservations, nodes: { n: { id: 'n', ports: [{ ref, ...port }] } } }) as never;
    expect(() => validateReservations(model({ side: 'left', sideHint: true }))).not.toThrow();
    expect(() => validateReservations(model({ side: 'right', sideHint: true }))).toThrow(/not the face/);
    expect(() => validateReservations(model({ side: 'left' }))).toThrow(/not the face/);
    expect(() => validateReservations(model({ side: 'left', sideHint: true }, pitchFloors(new Map([['n', { left: 1 }]]), 'fan', 0)))).toThrow(/no reservation|does not hold/);
  });
  it('refuses a lane hint that has no lane owner, and a lane owner with no side face', () => {
    const ref = { node: 'n', name: 'p', ordinal: 1 }, key = portKey(ref);
    const hints = new Map([[key, 'left' as const]]), promised = new Map([[key, { link: 'l', bends: 1, shape: 'lane' as const }]]);
    const faces = sideFaces(hints, promised, 'side', 0), owners = laneOwners([key], hints, promised, 'side', 0);
    const model = (port: object, reservations: readonly unknown[] = [...faces, ...owners]): never => ({ links: [], reservations, nodes: { n: { id: 'n', ports: [{ ref, side: 'left', sideHint: true, ...port }] } } }) as never;
    expect(() => validateReservations(model({ laneHint: true }))).not.toThrow();
    expect(() => validateReservations(model({}))).toThrow(/lane owners/);
    expect(() => validateReservations(model({ laneHint: true }, owners))).toThrow(/no side face|not the face|no reservation/);
  });
  it('refuses a ledger whose courses are not the courses of the model', () => {
    const course = { link: 'l', kind: 'gap', from: { face: 'left' }, to: { face: 'right' }, runs: [] } as never;
    const model = (courses: object[]): never => ({ links: [], reservations: courseEntries([course], new Map([['l', 2]]), 'course', 0), courses, nodes: {} }) as never;
    expect(() => validateReservations(model([course]))).not.toThrow();
    expect(() => validateReservations(model([]))).toThrow(/Reserved courses/);
  });
  it('refuses a ledger whose spanning chords are not the frozen span hints', () => {
    const model = (frozen: string[]): never => ({ reservations: spanEntries(['b'], 'span', 0), links: [{ id: 'a' }, { id: 'b' }], freeze: { spans: frozen }, nodes: {} }) as never;
    expect(() => validateReservations(model(['b']))).not.toThrow();
    expect(() => validateReservations(model(['a']))).toThrow(/spanning chords/);
    expect(() => validateReservations(model([]))).toThrow(/spanning chords/);
  });
  it('refuses a ledger that orders every face by turns when the model does not', () => {
    const model = (turnOrder: boolean): never => ({ links: [], reservations: turnEntries(true, [], false, 'turn', 0), ...(turnOrder ? { turnOrder: true } : {}), nodes: {} }) as never;
    expect(() => validateReservations(model(true))).not.toThrow();
    expect(() => validateReservations(model(false))).toThrow(/turn order/);
  });
  it('refuses reserved turn links that are not the turn links of the model', () => {
    const model = (turnLinks: string[]): never => ({ links: [], reservations: turnEntries(false, ['a', 'b'], false, 'course', 0), turnOrder: true, turnLinks, nodes: {} }) as never;
    expect(() => validateReservations(model(['a', 'b']))).not.toThrow();
    expect(() => validateReservations(model(['a']))).toThrow(/turn links/);
  });
  it('refuses a declined trunk join that the ledger does not decline', () => {
    const model = (reservations: readonly unknown[]): never => ({ links: [], reservations, declinedTrunks: ['k'], nodes: {} }) as never;
    expect(() => validateReservations(model(declineTrunk('k', 'blocked', 0)))).not.toThrow();
    expect(() => validateReservations(model(declineTrunk(undefined, 'the placement budget is spent', 0)))).not.toThrow();
    expect(() => validateReservations(model(declineTrunk('other', 'blocked', 0)))).toThrow(/no reservation declines it/);
  });
  it('fails a chord, a lane, a span and a turn order that 7e does not show, each with the port and link it concerns', () => {
    const key = portKey({ node: 'n', name: 'p', ordinal: 1 });
    const hints = new Map([[key, 'left' as const]]), promised = new Map([[key, { link: 'l', bends: 0, shape: 'straight' as const }]]);
    const lanePromised = new Map([[key, { link: 'l', bends: 1, shape: 'lane' as const }]]);
    const bare = { links: [{ id: 'l', layer: 'routed' }], lanes: [], freeze: { turnOrder: [] }, nodes: {} };
    const chord = holds(sideFaces(hints, promised, 'side', 0), bare as never);
    expect(chord.map(item => [item.kind, item.key, item.link])).toEqual([['sideFace', key, 'l']]);
    expect(holds(sideFaces(hints, new Map(), 'side', 0), bare as never)).toEqual([]);
    const lane = holds(laneOwners([key], hints, lanePromised, 'side', 0), bare as never);
    expect(lane.map(item => [item.kind, item.key, item.link])).toEqual([['laneOwner', key, 'l']]);
    const seated = { ...bare, lanes: [{ kind: 'side', owner: { kind: 'link', id: 'l' }, aligned: true }] };
    expect(holds(laneOwners([key], hints, lanePromised, 'side', 0), seated as never)).toEqual([]);
    expect(holds(spanEntries(['l', 'gone'], 'span', 0), bare as never, entry => entry.kind === 'spanChord' && entry.payload.link === 'gone').map(item => item.link)).toEqual(['gone']);
    expect(holds(turnEntries(true, [], true, 'turn', 0), bare as never)).toHaveLength(1);
    expect(holds(turnEntries(true, [], false, 'turn', 0), bare as never)).toEqual([]);
    expect(holds(turnEntries(true, [], true, 'turn', 0), { ...bare, freeze: { turnOrder: [{ node: 'n', side: 'top' }] } } as never)).toEqual([]);
  });
  it('holds a kept course to the turns it promised on a routed model', () => {
    const course = { link: 'l', kind: 'gap', from: { face: 'left' }, to: { face: 'right' }, runs: [] } as never;
    const ledger = courseEntries([course], new Map([['l', 1]]), 'course', 0);
    expect([...promisedTurns(ledger)]).toEqual([['l', 1]]);
    const segment = (x0: number, y0: number, x1: number, y1: number): object => ({ from: { x: x0, y: y0 }, to: { x: x1, y: y1 } });
    const routed = (segments: object[] | undefined): never => ({ links: [{ id: 'l', ...(segments === undefined ? {} : { path: { segments } }) }] }) as never;
    expect(holdsRouted(ledger, routed([segment(0, 0, 10, 0), segment(10, 0, 10, 10)]))).toEqual([]);
    const bent = holdsRouted(ledger, routed([segment(0, 0, 10, 0), segment(10, 0, 10, 10), segment(10, 10, 20, 10)]));
    expect(bent.map(item => [item.link, item.got, item.max])).toEqual([['l', 2, 1]]);
    expect(holdsRouted(ledger, routed(undefined)).map(item => item.got)).toEqual([undefined]);
    expect(holdsRouted(courseEntries([course], undefined, 'course', 0), routed(undefined))).toEqual([]);
  });
  it('merges pitch and node floors by componentwise maximum and keeps declaration order', () => {
    const a = reserve([], pitchFloors(new Map([['n', { left: 10 }], ['m', { right: 4 }]]), 'fan', 0));
    const b = reserve(a, pitchFloors(new Map([['n', { left: 8, right: 6 }]]), 'fan', 1));
    expect([...pitchFloorsOf(b)]).toEqual([['n', { left: 10, right: 6 }], ['m', { right: 4 }]]);
    const sizes = reserve(reserve([], nodeFloors(new Map([['n', { width: 10, height: 30 }]]), 'side', 0)), nodeFloors(new Map([['n', { width: 20, height: 5 }]]), 'side', 1));
    expect(nodeFloorsOf(sizes).get('n')).toEqual({ width: 20, height: 30 });
  });
  it('round-trips a port key and the hints and lanes built from it', () => {
    const key = portKey({ node: 'n', name: 'p', ordinal: 2 }), anonymous = portKey({ node: 'n', anonymous: true, ordinal: 1 });
    expect(portKey(portRefOf(key))).toBe(key);
    expect(portKey(portRefOf(anonymous))).toBe(anonymous);
    const hints = new Map<string, 'left' | 'right'>([[key, 'left'], [anonymous, 'right']]);
    const promised = new Map([[key, { link: 'l', bends: 1, shape: 'lane' as const }], [anonymous, { link: 'k', bends: 0, shape: 'straight' as const }]]);
    const ledger = reserve(sideFaces(hints, promised, 'side', 1), laneOwners([key], hints, promised, 'side', 1));
    expect([...sideHintsOf(ledger)]).toEqual([...hints]);
    expect([...laneKeysOf(ledger)]).toEqual([key]);
  });
  it('rejects a side that disagrees and a course that conflicts', () => {
    const key = portKey({ node: 'n', name: 'p', ordinal: 1 });
    const left = sideFaces(new Map([[key, 'left' as const]]), new Map(), 'side', 0), right = sideFaces(new Map([[key, 'right' as const]]), new Map(), 'side', 0);
    expect(() => reserve(left, right)).toThrow(/asks for the side/);
    const course = { link: 'l', kind: 'gap', from: { face: 'left' }, to: { face: 'right' }, runs: [] } as never;
    const other = { ...(course as object), kind: 'perimeter' } as never;
    expect(coursesOf(reserve(courseEntries([course], undefined, 'course', 0), courseEntries([course], undefined, 'course', 1)))).toHaveLength(1);
    expect(() => reserve(courseEntries([course], undefined, 'course', 0), courseEntries([other], undefined, 'course', 1))).toThrow(/conflicts/);
  });
  it('unions spans, turn links and declines', () => {
    expect([...spansOf(reserve(spanEntries(['a'], 'span', 0), spanEntries(['b', 'a'], 'span', 1)))]).toEqual(['a', 'b']);
    const turn = reserve(turnEntries(false, ['a'], false, 'course', 0), turnEntries(false, ['b', 'a'], false, 'course', 1));
    expect(turnOf(turn)).toEqual({ all: false, links: ['a', 'b'], requireChanged: false });
    expect(turnOf(reserve(turn, turnEntries(true, [], true, 'turn', 2))).all).toBe(true);
    const declined = new DeclinedTrunks();
    declined.set('k', 'blocked');
    declined.all = true;
    const back = declinedTrunksOf(declinedEntries(declined, 0));
    expect(back.get('k')).toBe('blocked');
    expect(back.get('other')).toBe('the placement budget is spent');
  });
});
