import { describe, expect, it } from 'vitest';
import { compare, gains, holds, judges, lazyCount, reading, type Family, type Reading } from '../../src/layout/objective.js';
import { pickRankMove } from '../../src/layout/decide.js';

/**
 * Architecture ticket 13, phase 4: every choice of stage 7f is judged by the unified order of the user (fewer bent links over both layers, then fewer turns,
 * then fewer crossings) behind the hard limits, and each judge is read from the one table `judges`.
 */
const family = (bent: number, turns = bent): Family => ({ straight: 0, bent, turns });
const none = (): Set<string> => new Set<string>();
const findings = { crowded: none(), disordered: none(), residuals: none() };
const mk = (overlayBent: number, routedBent: number, crossings = 0, extra: Partial<Reading> = {}): Reading =>
  reading({ overlay: family(overlayBent), routed: family(routedBent), crossings: lazyCount(() => crossings), crossingMode: 'pairs', tie: [0, 0], ...extra });

describe('the judges of the decision loop', () => {
  it('prefers fewer bent links over both layers: a net gain may bend a link that was straight', () => {
    const base = mk(3, 0, 5, { drift: 0, growth: { width: 100, height: 0 }, sets: findings });
    const after = (overlay: number, routed: number): Reading => ({ ...mk(overlay, routed, 5, { drift: 0, growth: { width: 100, height: 0 }, sets: findings }), widthCap: 105 });
    expect(gains(after(1, 1), base, judges.chordSettled)).toBe(true);
    expect(gains(after(2, 1), base, judges.chordSettled)).toBe(false);
    expect(gains(after(3, 0), base, judges.chordSettled)).toBe(false);
  });

  it('breaks a tie of the bent links by the turns, then by the crossings, then by the position', () => {
    const base = mk(2, 0, 4);
    expect(gains({ ...mk(2, 0, 4), overlay: family(2, 1) }, base, judges.chordCheap)).toBe(true);
    expect(gains(mk(2, 0, 3), base, judges.chordCheap)).toBe(true);
    expect(gains({ ...mk(2, 0, 4), tie: [5, 5] }, base, judges.chordCheap)).toBe(false);
    expect(compare({ ...mk(1, 0), tie: [1, 1] }, { ...mk(1, 0), tie: [2, -2] }, judges.chordBest)).toBeLessThan(0);
  });

  it('holds a move back that drifts, grows the canvas past its bound or adds a finding', () => {
    const base = mk(2, 0, 0, { drift: 0, growth: { width: 100, height: 0 }, sets: findings });
    const fine: Reading = { ...mk(1, 0, 0, { drift: 0.4, growth: { width: 104, height: 0 }, sets: findings }), widthCap: 105 };
    expect(gains(fine, base, judges.chordSettled)).toBe(true);
    expect(gains({ ...fine, drift: 3 }, base, judges.chordSettled)).toBe(false);
    expect(gains({ ...fine, growth: { width: 120, height: 0 } }, base, judges.chordSettled)).toBe(false);
    expect(gains({ ...fine, sets: { ...findings, crowded: new Set(['a|b']) } }, base, judges.chordSettled)).toBe(false);
    expect(gains({ ...fine, sets: { ...findings, disordered: new Set(['G5:n']) } }, base, judges.rankSettled)).toBe(false);
  });

  it('keeps a body off a frozen chord', () => {
    const before = mk(2, 0, 0, { sets: { blocked: new Set(['x']) } });
    expect(gains(mk(1, 0, 0, { sets: { blocked: new Set(['x']) } }), before, judges.chordCheap)).toBe(true);
    expect(gains(mk(1, 0, 0, { sets: { blocked: new Set(['x', 'y']) } }), before, judges.chordCheap)).toBe(false);
  });

  it('lets a step of a group with no link stay when it is no worse, and not when it adds a finding', () => {
    const before = mk(2, 0, 3, { sets: findings });
    expect(holds(mk(2, 0, 3, { sets: findings }), before, judges.linkless)).toBe(true);
    expect(holds(mk(3, 0, 3, { sets: findings }), before, judges.linkless)).toBe(false);
    expect(holds(mk(1, 0, 9, { sets: findings }), before, judges.linkless)).toBe(true);
    expect(holds(mk(1, 0, 3, { sets: { ...findings, crowded: new Set(['a|b']) } }), before, judges.linkless)).toBe(false);
  });

  it('picks, of the lower rank moves that passed, the one with the fewest bent links, then the fewest turns, then the fewest crossings, then the nearest', () => {
    const base = { crossings: 2, straight: 3 };
    const move = (dx: number, bent: number, crossings: number, turns = bent): { dx: number; crossings: number; straight: number; reading: Reading } =>
      ({ dx, crossings, straight: 5, reading: { ...mk(bent, 0, crossings), overlay: family(bent, turns), tie: [Math.abs(dx), dx] } });
    const moves = [move(5, 2, 0), move(9, 1, 9), move(-4, 1, 0, 3)];
    expect(pickRankMove(moves, base)).toBe(moves[1]);
    const tied = [move(3, 1, 1), move(-3, 1, 1), move(4, 1, 1)];
    expect(pickRankMove(tied, base)).toBe(tied[1]);
    expect(pickRankMove([], base)).toBeUndefined();
  });

  const facts = { lanesHold: true, chordsClear: true };
  const sets = (centring: string[] = []): NonNullable<Reading['sets']> => ({ centring: new Set(centring), gaps: none(), room: none(), crowded: none(), disordered: none() });
  const held = mk(1, 0, 0, { sets: sets(['a']) });
  it('lets a reseat that names nothing new pass, and refuses a trade of one finding for another', () => {
    expect(holds(mk(1, 0, 0, { sets: sets(['a']), facts }), held, judges.laneReseat)).toBe(true);
    expect(holds(mk(1, 0, 0, { sets: sets(), facts }), held, judges.laneReseat)).toBe(true);
    expect(holds(mk(1, 0, 0, { sets: sets(['b']), facts }), held, judges.laneReseat)).toBe(false);
  });
  it('refuses a reseat that leaves a corridor off its child, a body on a frozen chord, a new crowded pair or a link more bent', () => {
    expect(holds(mk(1, 0, 0, { sets: sets(), facts: { ...facts, lanesHold: false } }), held, judges.laneReseat)).toBe(false);
    expect(holds(mk(1, 0, 0, { sets: sets(), facts: { ...facts, chordsClear: false } }), held, judges.laneReseat)).toBe(false);
    expect(holds(mk(1, 0, 0, { sets: { ...sets(), crowded: new Set(['a|b']) }, facts }), held, judges.laneReseat)).toBe(false);
    expect(holds(mk(2, 0, 0, { sets: sets(), facts }), held, judges.laneReseat)).toBe(false);
  });
});
