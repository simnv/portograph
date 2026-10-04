import { describe, expect, it } from 'vitest';
import { compare, gains, holds, judges, profiles, reading, type Reading } from '../../src/layout/objective.js';

/** Architecture ticket 13, phase 3: the decision loop reads every judge from the one table, and the lane reseat is judged by a profile. */
describe('the judges of the decision loop', () => {
  it('names today\'s profile for each kind of choice that has one of its own', () => {
    expect(judges.rankMove).toBe(profiles.rankMove);
    expect(judges.rankCheap).toBe(profiles.cheapCrossings);
    expect(judges.linkless).toBe(profiles.keepSet);
    expect(judges.laneReseat).toBe(profiles.laneReseat);
    expect(judges.driftHeld).toBe(profiles.driftHeld);
  });

  const straight = (count: number, extra: Partial<Reading> = {}): Reading => reading({ overlay: { straight: count, bent: 0, turns: 0 }, ...extra });
  it('raises the straight count, and holds back a move that drifts, grows the canvas or adds a finding', () => {
    const base = straight(2, { drift: 0, growth: { width: 100, height: 0 }, sets: { crowded: new Set(), disordered: new Set(), residuals: new Set() } });
    const fine = straight(3, { drift: 0.4, widthCap: 105, growth: { width: 104, height: 0 }, sets: { crowded: new Set(), disordered: new Set(), residuals: new Set() } });
    expect(gains(fine, base, judges.chordSettled)).toBe(true);
    expect(gains({ ...fine, drift: 3 }, base, judges.chordSettled)).toBe(false);
    expect(gains({ ...fine, growth: { width: 120, height: 0 } }, base, judges.chordSettled)).toBe(false);
    expect(gains({ ...fine, sets: { ...fine.sets, crowded: new Set(['a|b']) } }, base, judges.chordSettled)).toBe(false);
    expect(gains({ ...fine, overlay: { straight: 2, bent: 0, turns: 0 } }, base, judges.chordSettled)).toBe(false);
  });
  it('keeps a body off a frozen chord, and picks the most straight links', () => {
    const before = straight(1, { sets: { blocked: new Set(['x']) } });
    expect(gains(straight(2, { sets: { blocked: new Set(['x']) } }), before, judges.chordCheap)).toBe(true);
    expect(gains(straight(2, { sets: { blocked: new Set(['x', 'y']) } }), before, judges.chordCheap)).toBe(false);
    expect(compare(straight(3), straight(2), judges.chordBest)).toBeLessThan(0);
    expect(compare(straight(2), straight(2), judges.chordBest)).toBe(0);
  });

  const none = (): Set<string> => new Set<string>();
  const facts = { lanesHold: true, chordsClear: true };
  const held = reading({ sets: { centring: new Set(['a']), gaps: none(), room: none() } });
  it('lets a reseat that names nothing new pass, and refuses a trade of one finding for another', () => {
    const same = reading({ sets: { centring: new Set(['a']), gaps: none(), room: none() }, facts });
    const fewer = reading({ sets: { centring: none(), gaps: none(), room: none() }, facts });
    const traded = reading({ sets: { centring: new Set(['b']), gaps: none(), room: none() }, facts });
    expect(holds(same, held, judges.laneReseat)).toBe(true);
    expect(holds(fewer, held, judges.laneReseat)).toBe(true);
    expect(holds(traded, held, judges.laneReseat)).toBe(false);
  });
  it('refuses a reseat that leaves a corridor off its child or a body on a frozen chord', () => {
    const sets = { centring: none(), gaps: none(), room: none() };
    expect(holds(reading({ sets, facts: { ...facts, lanesHold: false } }), held, judges.laneReseat)).toBe(false);
    expect(holds(reading({ sets, facts: { ...facts, chordsClear: false } }), held, judges.laneReseat)).toBe(false);
  });
});
