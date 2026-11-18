import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { betterByUnified } from '../../src/layout/turn-measure.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { measureTurnOrder } from '../../src/layout/turn-measure.js';
import { farEndDecisionsOf } from '../../src/layout/reservations.js';
import type { Env } from '../../src/pipeline/env.js';
import { chooseStart } from '../../src/pipeline/driver.js';
import { turn } from '../../src/pipeline/rounds.js';
import type { State } from '../../src/pipeline/state.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { FLANK_LINK_AROUND_A_NEIGHBOUR } from '../hand-solves.js';

/**
 * Architecture ticket 24, phase 2: the stage-5 key of a turn-ordered run (`testTurnOrder`) and G5 on the faces it placed. The hand solve 09 has one self
 * crossing today: the two column-gap skirts of Mgmt 1 leave one bottom face in far-end order, and the nearer lane crosses the stem of the farther one.
 */
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const solve09 = (): string => FLANK_LINK_AROUND_A_NEIGHBOUR;
const counts = (model: LayoutModel) => score(model).snapshot.counts.routed;
/** The faces the turn round recorded, without their ports. */
const faces = (model: LayoutModel): { node: string; side: string }[] => (model.freeze?.turnOrder ?? []).map(face => ({ node: face.node, side: face.side }));

describe('the turn order of a forced run (hand solve 09)', () => {
  it('is off with testTurnOrder false: no frozen faces and the far-end order', async () => {
    const model = await layout(parse(solve09()), { ...options, testTurnOrder: false });
    expect(model.freeze?.turnOrder).toBeUndefined();
    expect(model.turnOrder).toBeUndefined();
  });

  it('removes the self crossing of the two skirts and adds no turn', async () => {
    const plain = await layout(parse(solve09()), { ...options, testTurnOrder: false });
    const forced = await layout(parse(solve09()), { ...options, testTurnOrder: true });
    expect(faces(forced)).toContainEqual({ node: 'mg-1', side: 'bottom' });
    expect(counts(plain).crossings).toBe(1);
    expect(counts(forced).crossings).toBe(0);
    expect(counts(forced).turns).toBeLessThanOrEqual(counts(plain).turns);
    expect(Object.values(score(forced).snapshot.gates).every(gate => gate.passed)).toBe(true);
    expect(forced.diagnostics.map(item => item.code)).not.toContain('PORT_TURN_MISSED');
  });

  it('restores from JSON with its frozen faces', async () => {
    const forced = await layout(parse(solve09()), { ...options, testTurnOrder: true });
    const restored = restoreLayoutModel(JSON.stringify(forced));
    expect(restored.freeze?.turnOrder).toEqual(forced.freeze?.turnOrder);
    expect(() => restoreLayoutModel(JSON.stringify({ ...forced, turnOrder: undefined }))).toThrow(/turn order/);
  });
});

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const readTurnFixture = (name: string): string => readFileSync(new URL(`../fixtures/turn-order/${name}.yaml`, import.meta.url), 'utf8');
const geometry = (model: LayoutModel): string => JSON.stringify(model.links.map(link => [link.id, link.path?.segments.map(segment => [segment.from, segment.to])]));
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);

/** Architecture ticket 24, phase 3: the turn round. */
describe('the turn round', () => {
  it('takes the turn order of two skirts from one face and removes their crossing', async () => {
    const name = 'two-skirts-from-one-face-nest';
    const skipped = await layout(parse(fixture(name)), { ...options, testTurnOrder: false });
    const on = await layout(parse(fixture(name)), options);
    expect(codes(on)).toContain('TURN_ORDER_TAKEN');
    expect(counts(on).crossings).toBe(0);
    expect(counts(on).turns).toBeLessThanOrEqual(counts(skipped).turns);
    expect(counts(skipped).crossings).toBe(1);
    expect(codes(skipped)).not.toContain('TURN_ORDER_TAKEN');
    expect(faces(on)).toContainEqual({ node: 'fl-1', side: 'bottom' });
  });

  it('is byte for byte the baseline when there is no offer (testTurnOrder false is the same layout)', async () => {
    for (const name of ['turns-both-ways-from-one-bottom-face', 'a-side-lane-turns-up-above-a-straight-peer']) {
      const on = await layout(parse(fixture(name)), options);
      const off = await layout(parse(fixture(name)), { ...options, testTurnOrder: false });
      expect(geometry(on)).toBe(geometry(off));
      expect(codes(on)).not.toContain('TURN_ORDER_TAKEN');
      expect(on.freeze?.turnOrder).toBeUndefined();
    }
  });

  it('judges by the unified order read lexicographically: a crossing for a turn is refused, an equal trial is refused', () => {
    expect(betterByUnified({ bent: 2, turns: 6, crossings: 1 }, { bent: 2, turns: 6, crossings: 0 })).toBe(true);
    expect(betterByUnified({ bent: 2, turns: 6, crossings: 1 }, { bent: 2, turns: 7, crossings: 0 })).toBe(false);
    expect(betterByUnified({ bent: 2, turns: 6, crossings: 1 }, { bent: 3, turns: 6, crossings: 0 })).toBe(false);
    expect(betterByUnified({ bent: 2, turns: 6, crossings: 1 }, { bent: 2, turns: 6, crossings: 1 })).toBe(false);
    expect(betterByUnified({ bent: 2, turns: 6, crossings: 1 }, { bent: 1, turns: 9, crossings: 5 })).toBe(true);
  });

  it('needs a start, and leaves the last one to an overlay round that promises something (the admission rule)', () => {
    const turnOffer = { gain: [0, 0, 0], tie: 0 }, overlay = (gain: number[]) => ({ gain, tie: 1 });
    expect(chooseStart(0, [turnOffer])).toBe(-1);
    expect(chooseStart(1, [turnOffer])).toBe(0);
    expect(chooseStart(2, [turnOffer, overlay([0, 1, 4])])).toBe(0);
    expect(chooseStart(1, [turnOffer, overlay([0, 1, 4])])).toBe(1);
    expect(chooseStart(1, [turnOffer, overlay([0, 0, 0])])).toBe(1);
    expect(chooseStart(1, [turnOffer, overlay([0, -1, 0])])).toBe(0);
  });
});

/** Architecture ticket 24, phase 5: the row bypass (hand solve 01). */
describe('the row bypass', () => {
  const ring = 'a-ring-closes-above-its-row';
  it('plans the closing link round the top edge of its row: four turns, no crossing, the route on the reserved row', async () => {
    const off = await layout(parse(fixture(ring)), { ...options, testCourses: [] });
    const model = await layout(parse(fixture(ring)), options);
    expect(counts(off).crossings).toBe(1);
    expect(counts(model).crossings).toBe(0);
    expect(counts(model).turns).toBe(counts(off).turns);
    expect(codes(model)).toContain('ROW_BYPASS_PLANNED');
    expect(codes(model)).not.toContain('PORT_TURN_MISSED');
    expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
    const link = model.links.find(item => item.id === 'link-2')!;
    expect(link.fixedSegments).toHaveLength(6);
    expect(link.path!.segments.map(segment => [segment.from, segment.to])).toEqual(link.fixedSegments!.map(segment => [segment.from, segment.to]));
    expect(model.courses).toMatchObject([{ link: 'link-2', kind: 'bypass', edge: 'top', runs: ['gap', 'padding', 'gap'] }]);
    expect(model.lanes.map(lane => lane.id).sort()).toEqual(['gap-lane:link-2:0', 'gap-lane:link-2:1']);
  });

  it('puts the closing link in the upper slot of both faces', async () => {
    const model = await layout(parse(fixture(ring)), options);
    const link = model.links.find(item => item.id === 'link-2')!;
    const slot = (node: string, side: 'left' | 'right'): number => {
      const ref = link.attachments!.from.node === node ? link.attachments!.from : link.attachments!.to;
      return model.nodes[node]!.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!).findIndex(port => port.ref.ordinal === ref.ordinal);
    };
    expect(slot('r4', 'left')).toBe(0);
    expect(slot('r1', 'right')).toBe(0);
  });

  it('restores from JSON with its course and lanes', async () => {
    const model = await layout(parse(fixture(ring)), options);
    const restored = restoreLayoutModel(JSON.stringify(model));
    expect(restored.courses).toEqual(model.courses);
    expect(restored.lanes.map(lane => lane.id)).toEqual(model.lanes.map(lane => lane.id));
  });

  it('is byte for byte the baseline on a sheet with no blocked row link', async () => {
    const name = 'turns-both-ways-from-one-bottom-face';
    const on = await layout(parse(fixture(name)), options);
    const off = await layout(parse(fixture(name)), { ...options, testCourses: [] });
    expect(geometry(on)).toBe(geometry(off));
    expect(on.courses).toBeUndefined();
  });
});

/** Architecture ticket 24, review: the carried order is scoped (3), the budget is never given back (6). */
describe('the carried turn order and the budget', () => {
  it('a bypass trial orders the faces of the bypass link only, and later runs keep that scope (finding 3)', async () => {
    const model = await layout(parse(fixture('a-ring-closes-above-its-row')), options);
    expect(model.turnOrder).toBe(true);
    expect(model.turnLinks).toEqual(['link-2']);
  });

  it('a run for some links orders their faces and no other face (finding 3)', async () => {
    const full = await layout(parse(solve09()), { ...options, testTurnOrder: false });
    const courses = full.courses!;
    const all = await layout(parse(solve09()), { ...options, testCourses: courses, testTurnOrder: true });
    const scoped = await layout(parse(solve09()), { ...options, testCourses: courses, testTurnLinks: ['link-6'] });
    expect(faces(all)).toContainEqual({ node: 'core-1', side: 'left' });
    expect(faces(scoped)).toEqual([{ node: 'mg-1', side: 'bottom' }]);
    const none = await layout(parse(solve09()), { ...options, testCourses: courses, testTurnLinks: ['link-1'] });
    expect(none.freeze?.turnOrder).toBeUndefined();
  });

  it('decides the offer before any placement: a sheet with no offer places exactly as without the round (finding 6)', async () => {
    const name = 'turns-both-ways-from-one-bottom-face';
    resetAttemptCounters();
    await layout(parse(fixture(name)), options);
    const on = attemptCounters.placeRuns;
    resetAttemptCounters();
    await layout(parse(fixture(name)), { ...options, testTurnOrder: false });
    expect(on).toBe(attemptCounters.placeRuns);
  });

  it('measures its offer from the kept model: faces on a baseline that the courses made, none once the order stands (findings 6)', async () => {
    const base = await layout(parse(solve09()), { ...options, testTurnOrder: false });
    expect(measureTurnOrder(base).faces.length).toBeGreaterThan(0);
    const kept = await layout(parse(solve09()), options);
    expect(measureTurnOrder(kept).faces).toEqual([]);
  });

  it('skips the round, never passes the cap, and gives no re-run back (finding 6)', async () => {
    resetAttemptCounters();
    const tight = await layout(parse(solve09()), { ...options, testMaxReruns: 1 });
    expect(attemptCounters.placeRuns).toBeLessThanOrEqual(2);
    expect(tight.diagnostics.map(item => item.code)).toContain('TURN_ROUND_SKIPPED');
    resetAttemptCounters();
    const room = await layout(parse(solve09()), { ...options, testMaxReruns: 2 });
    expect(attemptCounters.placeRuns).toBeLessThanOrEqual(3);
    expect(room.diagnostics.map(item => item.code)).toContain('TURN_ORDER_TAKEN');
  });

  it('sets a start aside for the turn round on a baseline that has an offer, and none on one that has not (finding 6)', async () => {
    const held = await layout(parse(fixture('a-held-lane-stays-on-its-frames-side-of-a-foreign-frame')), { ...options, testTurnOrder: false });
    const plain = await layout(parse(fixture('turns-both-ways-from-one-bottom-face')), { ...options, testTurnOrder: false });
    const live = (base: LayoutModel): Promise<boolean | undefined> => turn.live?.({} as Env, { base } as State) ?? Promise.resolve(undefined);
    expect(await live(held)).toBe(true);
    expect(await live(plain)).toBe(false);
    // With the one start of the budget set aside, a round that has used none of it has no start left; on a baseline without an offer it keeps its start.
    expect(chooseStart(1 - 1, [{ gain: [0, 0, 0], tie: 0 }])).toBe(-1);
    expect(chooseStart(1 - 0, [{ gain: [0, 0, 0], tie: 0 }])).toBe(0);
  });
});

/**
 * Dense-16x9 ticket 05: a face that holds a held straight link takes far-end order, a face with only orthogonal links keeps the first-turn order, and G5 accepts a face the turn
 * round recorded while its ports stand in the recorded order (`freeze.turnOrder`). The sheet is `two-skirts-from-one-face-nest`: the bottom face of `fl-1` is an orthogonal-only face.
 */
describe('far-end order on a face that holds a straight link', () => {
  const name = 'two-skirts-from-one-face-nest';
  const bottomOrder = (model: LayoutModel): string[] => model.nodes['fl-1']!.ports.filter(port => port.side === 'bottom').sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => `${port.ref.name}#${port.ref.ordinal}`);
  const g5 = (model: LayoutModel): number => score(model).snapshot.gates.G5.violations.length;
  const forced = async (extra: object = {}): Promise<LayoutModel> => {
    const courses = (await layout(parse(fixture(name)), { ...options, testTurnOrder: false })).courses!;
    return layout(parse(fixture(name)), { ...options, testCourses: courses, testTurnOrder: true, ...extra });
  };

  it('an orthogonal-only face keeps the first-turn order, which differs from the far-end order, and G5 accepts it', async () => {
    const plain = await layout(parse(fixture(name)), { ...options, testTurnOrder: false });
    const on = await layout(parse(fixture(name)), options);
    expect(faces(on)).toContainEqual({ node: 'fl-1', side: 'bottom' });
    expect(bottomOrder(on)).not.toEqual(bottomOrder(plain));
    expect(on.frozenChords?.some(id => on.links.find(link => link.id === id)?.attachments?.from.node === 'fl-1')).toBeFalsy();
    expect(g5(on)).toBe(0);
  });

  it('a face reserved for far-end order keeps the far-end order, is not recorded as turned, and G5 passes', async () => {
    const plain = await layout(parse(fixture(name)), { ...options, testTurnOrder: false });
    const model = await forced({ testTurnExcept: ['fl-1|bottom'] });
    expect(model.turnExcept).toEqual(['fl-1|bottom']);
    expect(faces(model)).not.toContainEqual({ node: 'fl-1', side: 'bottom' });
    expect(faces(model)).toContainEqual({ node: 'core-1', side: 'left' });
    expect(bottomOrder(model)).toEqual(bottomOrder(plain));
    expect(g5(model)).toBe(0);
    // The reservation restores with the model, and a model that lost the record is refused.
    expect(restoreLayoutModel(JSON.stringify(model)).turnExcept).toEqual(['fl-1|bottom']);
    expect(() => restoreLayoutModel(JSON.stringify({ ...model, turnExcept: undefined }))).toThrow(/far-end faces|Frozen turn order/);
  });

  it('G5 reads the record of the turn round: a recorded face is accepted, the same order on a face with no record fails', async () => {
    const turned = await forced();
    expect(faces(turned)).toContainEqual({ node: 'fl-1', side: 'bottom' });
    expect(g5(turned)).toBe(0);
    // A chord that the trial later holds on the face changes nothing: the gate reads the record (the ports in their order), and derives no turn from the published paths.
    const link = turned.links.find(item => item.attachments?.from.node === 'fl-1' || item.attachments?.to.node === 'fl-1')!;
    expect(g5({ ...turned, frozenChords: [...(turned.frozenChords ?? []), link.id] } as LayoutModel)).toBe(0);
    const unrecorded = { ...turned, freeze: { ...turned.freeze!, turnOrder: turned.freeze!.turnOrder!.filter(face => face.node !== 'fl-1') } } as LayoutModel;
    expect(score(unrecorded).snapshot.gates.G5.violations.map(item => item.elements[0])).toContain('fl-1');
  });

  it('the offer leaves out a face that holds a held chord and names it for the trial', async () => {
    const base = await layout(parse(fixture(name)), { ...options, testTurnOrder: false });
    expect(measureTurnOrder(base).faces).toContainEqual({ node: 'fl-1', side: 'bottom' });
    expect(measureTurnOrder(base).except).not.toContain('fl-1|bottom');
    const link = base.links.find(item => item.attachments?.from.node === 'fl-1')!;
    const held = { ...base, frozenChords: [link.id] } as LayoutModel;
    const offer = measureTurnOrder(held);
    expect(offer.faces).not.toContainEqual({ node: 'fl-1', side: 'bottom' });
    // Both ends of a held chord stand on faces that keep far-end order.
    const ends = [link.attachments!.from, link.attachments!.to].map(ref => `${ref.node}|${base.nodes[ref.node]!.ports.find(port => port.ref.name === ref.name && port.ref.ordinal === ref.ordinal)!.side}`);
    expect(offer.except).toEqual(expect.arrayContaining(ends));
    expect(offer.except).toContain('fl-1|bottom');
  });
});

/** A model as JSON, edited: the record of the turn round forged or aged. */
const edited = (model: LayoutModel, edit: (copy: LayoutModel) => void): LayoutModel => {
  const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
  edit(copy);
  return copy;
};

/**
 * Dense-16x9 ticket 05, review: G5 accepts a recorded face only while the record holds (R5). `freeze.turnOrder` keeps the ports of each face in the order the round left
 * them and `freeze.turnExcept` the scope it was taken under; a forged record, a face outside the scope and a move that reorders a recorded face all fail.
 */
describe('G5 and the record of the turn round', () => {
  const name = 'two-skirts-from-one-face-nest';
  const g5 = (model: LayoutModel): string[] => score(model).snapshot.gates.G5.violations.map(item => item.elements[0]!);
  const forced = async (extra: object = {}): Promise<LayoutModel> => {
    const courses = (await layout(parse(fixture(name)), { ...options, testTurnOrder: false })).courses!;
    return layout(parse(fixture(name)), { ...options, testCourses: courses, testTurnOrder: true, ...extra });
  };
  const record = (model: LayoutModel, node: string) => model.freeze!.turnOrder!.find(face => face.node === node)!;
  /** Swaps the seats of the first two ports of a face: the physical order of the face reverses, the record does not. */
  const swapSeats = (model: LayoutModel, node: string, side: string, engine = false): void => {
    const [a, b] = model.nodes[node]!.ports.filter(port => port.side === side).sort((x, y) => x.engineOrder! - y.engineOrder!);
    if (engine) [a!.engineOrder, b!.engineOrder] = [b!.engineOrder!, a!.engineOrder!];
    else [a!.anchor, b!.anchor] = [b!.anchor!, a!.anchor!];
  };

  it('records the ports of each recorded face, in the order the round left them', async () => {
    const turned = await forced();
    expect(turned.freeze!.turnOrder!.length).toBeGreaterThan(0);
    for (const face of turned.freeze!.turnOrder!) {
      const standing = turned.nodes[face.node]!.ports.filter(port => port.side === face.side).sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => port.ref);
      expect(face.ports).toEqual(standing);
    }
    expect(g5(turned)).toEqual([]);
  });

  it('fails a recorded face whose record lists its ports in another order, and one that lists other ports', async () => {
    const turned = await forced();
    expect(g5(edited(turned, copy => record(copy, 'fl-1').ports.reverse()))).toContain('fl-1');
    expect(g5(edited(turned, copy => record(copy, 'fl-1').ports.pop()))).toContain('fl-1');
  });

  it('fails a face that the round never took: a face reserved for far-end order, a face of no node, a record without the turn order', async () => {
    const reserved = await forced({ testTurnExcept: ['fl-1|bottom'] });
    expect(g5(reserved)).toEqual([]);
    const ports = reserved.nodes['fl-1']!.ports.filter(port => port.side === 'bottom').sort((a, b) => a.anchor!.x - b.anchor!.x).map(port => port.ref);
    // The far-end order stands on that face, so the far-end check would pass it; the record still names a face the scope keeps out.
    expect(g5(edited(reserved, copy => { copy.freeze!.turnOrder = [...(copy.freeze!.turnOrder ?? []), { node: 'fl-1', side: 'bottom', ports }]; }))).toContain('fl-1');
    // A face of a node that the model does not have fails the freeze of a restore, as before.
    expect(() => restoreLayoutModel(JSON.stringify(edited(reserved, copy => { copy.freeze!.turnOrder = [{ node: 'no-such-node', side: 'bottom', ports: [] }]; })))).toThrow(/Frozen turn order/);
    const turned = await forced();
    expect(g5(edited(turned, copy => { delete copy.turnOrder; }))).toContain('*');
  });

  it('fails a recorded scope that is not the scope of the model, and a stale scope on a restore', async () => {
    const reserved = await forced({ testTurnExcept: ['fl-1|bottom'] });
    expect(g5(edited(reserved, copy => { copy.freeze!.turnExcept = []; }))).toContain('*');
    expect(() => restoreLayoutModel(JSON.stringify(edited(reserved, copy => { copy.freeze!.turnExcept = []; })))).toThrow(/Frozen turn order/);
  });

  it('fails a scope that the freeze did not record when the record of the faces is absent', async () => {
    const turned = await forced();
    expect(g5(edited(turned, copy => { delete copy.freeze!.turnOrder; copy.turnExcept = ['fl-1|bottom']; }))).toContain('*');
  });

  it('fails an empty record of faces beside a scope that the model does not carry, and an empty record on its own', async () => {
    const reserved = await forced({ testTurnOrder: true, testTurnExcept: ['fl-1|bottom'] });
    expect(g5(reserved)).toEqual([]);
    expect(g5(edited(reserved, copy => { copy.freeze!.turnOrder = []; copy.freeze!.turnExcept = ['bogus|top']; }))).toContain('*');
    expect(g5(edited(reserved, copy => { copy.freeze!.turnOrder = []; }))).toContain('*');
  });

  it('fails a record on a model that carries no turn order: a scope and an empty list in the freeze of a plain run', async () => {
    const plain = await layout(parse(fixture(name)), { ...options, testTurnOrder: false });
    expect(g5(plain)).toEqual([]);
    const forge = (copy: LayoutModel): void => { copy.freeze!.turnExcept = ['fl-1|bottom']; copy.freeze!.turnOrder = []; };
    expect(g5(edited(plain, forge))).toContain('*');
    expect(() => restoreLayoutModel(JSON.stringify(edited(plain, forge)))).toThrow(/Frozen turn order/);
  });

  it('fails a recorded face of a node that the model does not have when the model reaches score() alone', async () => {
    const turned = await forced();
    expect(g5(edited(turned, copy => { copy.freeze!.turnOrder = [...copy.freeze!.turnOrder!, { node: 'no-such-node', side: 'bottom', ports: [] }]; }))).toContain('no-such-node');
  });

  it('refuses to restore a model that carries the turn order and no reservation ledger', async () => {
    const turned = await forced();
    expect(() => restoreLayoutModel(JSON.stringify(turned))).not.toThrow();
    expect(() => restoreLayoutModel(JSON.stringify(edited(turned, copy => { delete copy.reservations; })))).toThrow(/reservation ledger/);
  });

  it('fails a recorded face when a move reorders it after the record: on the published anchors, and on a restore by engine order', async () => {
    const turned = await forced();
    expect(g5(edited(turned, copy => swapSeats(copy, 'fl-1', 'bottom')))).toContain('fl-1');
    // A restore checks the record against the engine order: a record that lists the ports the other way round is refused at the freeze.
    expect(() => restoreLayoutModel(JSON.stringify(edited(turned, copy => record(copy, 'fl-1').ports.reverse())))).toThrow(/Frozen turn order/);
    expect(() => restoreLayoutModel(JSON.stringify(edited(turned, copy => swapSeats(copy, 'fl-1', 'bottom', true))))).toThrow();
  });
});

/**
 * Dense-16x9 ticket 05, review: one sheet that goes through the offer and the trial. `west-gw` faces down with two held straight links and one lane; `up-b` has two lanes and
 * no straight link. The planned first turns would reorder both faces, the round offers `up-b` alone and reserves `west-gw` for far-end order.
 */
describe('a face with a held straight link, through the turn round', () => {
  const name = 'a-face-with-a-held-straight-link-keeps-far-end-order';
  const bottom = (model: LayoutModel, node: string): string[] => model.nodes[node]!.ports.filter(port => port.side === 'bottom').sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => `${port.ref.name ?? ''}#${port.ref.ordinal}`);
  const trials: { turned: string[]; except: string[]; kept: boolean }[] = [];
  const traced = { ...options, testSideTrace: (event: Record<string, unknown>) => {
    if (event['ev'] !== 'turn-trial') return;
    const trial = event['trial'] as LayoutModel;
    trials.push({ turned: (trial.freeze?.turnOrder ?? []).map(face => `${face.node}|${face.side}`), except: trial.turnExcept ?? [], kept: (event['verdict'] as { kept: boolean }).kept });
  } };

  it('has the premise: a face with held straight links and a lane that the planned turns would move, and a face of lanes alone', async () => {
    const base = await layout(parse(readTurnFixture(name)), { ...options, testTurnOrder: false });
    const forced = await layout(parse(readTurnFixture(name)), { ...options, testCourses: base.courses ?? [], testTurnOrder: true });
    expect(faces(forced)).toEqual(expect.arrayContaining([{ node: 'west-gw', side: 'bottom' }, { node: 'up-b', side: 'bottom' }]));
    const ends = (node: string) => base.links.filter(link => [link.attachments!.from, link.attachments!.to].some(ref => ref.node === node && base.nodes[node]!.ports.find(port => port.ref.ordinal === ref.ordinal && port.ref.name === ref.name)!.side === 'bottom'));
    expect(ends('west-gw').filter(link => link.technique === 'straight').length).toBeGreaterThanOrEqual(1);
    expect(ends('west-gw').filter(link => link.technique !== 'straight').length).toBeGreaterThanOrEqual(1);
    expect(ends('up-b').filter(link => link.technique === 'straight')).toEqual([]);
    expect(base.frozenChords!.some(id => ends('west-gw').some(link => link.id === id))).toBe(true);
  });

  it('offers the face of lanes, reserves the straight face, and keeps the trial that turns the face of lanes alone', async () => {
    trials.length = 0;
    const base = await layout(parse(readTurnFixture(name)), { ...options, testTurnOrder: false });
    const offer = measureTurnOrder(base);
    expect(offer.faces).toEqual([{ node: 'up-b', side: 'bottom' }]);
    expect(offer.except).toContain('west-gw|bottom');
    const model = await layout(parse(readTurnFixture(name)), traced);
    expect(trials).toHaveLength(1);
    expect(trials[0]!.except).toEqual(offer.except);
    expect(trials[0]!.turned).toEqual(['up-b|bottom']);
    expect(trials[0]!.kept).toBe(true);
    expect(faces(model)).toEqual([{ node: 'up-b', side: 'bottom' }]);
    expect(model.turnExcept).toEqual(offer.except);
    expect(model.freeze?.turnExcept).toEqual(offer.except);
    expect(codes(model)).toContain('TURN_ORDER_TAKEN');
    // The straight face keeps the far-end order that the baseline gave it, and G5 passes on both faces.
    expect(bottom(model, 'west-gw')).toEqual(bottom(base, 'west-gw'));
    // G5 accepts the recorded face. The baseline runs no far-end round, so its far-end faces keep the stale order of stage 5 and fail G5; the full run proposes
    // their order, the trial is worse by the unified order, and the round records the decision (dense-16x9 ticket 49): G5 reads it, and no violation stays.
    const g5 = (m: LayoutModel): string[] => score(m).snapshot.gates.G5.violations.map(v => v.elements[0]!);
    expect([...new Set(g5(base))]).toEqual(['up-a', 'west-gw']);
    expect(farEndDecisionsOf(model.reservations ?? []).map(entry => `${entry.payload.node} ${entry.payload.side} ${entry.payload.reason}`)).toEqual(['up-a bottom unified', 'west-gw bottom unified']);
    expect(g5(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model)).freeze?.turnOrder).toEqual(model.freeze?.turnOrder);
  });

  it('a run that carries faces for some links keeps them too (turnLinks with turnExcept)', async () => {
    const base = await layout(parse(readTurnFixture(name)), { ...options, testTurnOrder: false });
    const lanes = base.links.filter(link => [link.attachments!.from.node, link.attachments!.to.node].some(node => node === 'up-b')).map(link => link.id);
    const scoped = await layout(parse(readTurnFixture(name)), { ...options, testCourses: base.courses ?? [], testTurnLinks: lanes, testTurnExcept: ['up-b|bottom'] });
    expect(scoped.turnExcept).toEqual(['up-b|bottom']);
    expect(faces(scoped)).not.toContainEqual({ node: 'up-b', side: 'bottom' });
    expect(restoreLayoutModel(JSON.stringify(scoped)).turnExcept).toEqual(['up-b|bottom']);
  });
});
