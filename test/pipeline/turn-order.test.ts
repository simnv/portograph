import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { betterByUnified } from '../../src/layout/turn-measure.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { measureTurnOrder } from '../../src/layout/turn-measure.js';
import type { Env } from '../../src/pipeline/env.js';
import { chooseStart } from '../../src/pipeline/driver.js';
import { turn } from '../../src/pipeline/rounds.js';
import type { State } from '../../src/pipeline/state.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 24, phase 2: the stage-5 key of a turn-ordered run (`testTurnOrder`) and G5 on the faces it placed. The hand solve 09 has one self
 * crossing today: the two column-gap skirts of Mgmt 1 leave one bottom face in far-end order, and the nearer lane crosses the stem of the farther one.
 */
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const solve09 = (): string => readFileSync(new URL('../../ref/hand-solves/09-flank-link-around-a-neighbour.yaml', import.meta.url), 'utf8');
const counts = (model: LayoutModel) => score(model).snapshot.counts.routed;

describe('the turn order of a forced run (hand solve 09)', () => {
  it('is off with testTurnOrder false: no frozen faces and the far-end order', async () => {
    const model = await layout(parse(solve09()), { ...options, testTurnOrder: false });
    expect(model.freeze?.turnOrder).toBeUndefined();
    expect(model.turnOrder).toBeUndefined();
  });

  it('removes the self crossing of the two skirts and adds no turn', async () => {
    const plain = await layout(parse(solve09()), { ...options, testTurnOrder: false });
    const forced = await layout(parse(solve09()), { ...options, testTurnOrder: true });
    expect(forced.freeze?.turnOrder).toContainEqual({ node: 'mg-1', side: 'bottom' });
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
    expect(on.freeze?.turnOrder).toContainEqual({ node: 'fl-1', side: 'bottom' });
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
    const scoped = await layout(parse(solve09()), { ...options, testCourses: courses, testTurnLinks: ['link-5'] });
    expect(all.freeze?.turnOrder).toContainEqual({ node: 'core-1', side: 'left' });
    expect(scoped.freeze?.turnOrder).toEqual([{ node: 'mg-1', side: 'bottom' }]);
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
