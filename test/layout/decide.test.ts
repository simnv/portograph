import { describe, expect, it } from 'vitest';
import { holds, judges, profiles, reading } from '../../src/layout/objective.js';

/** Architecture ticket 13, phase 3: the decision loop reads every judge from the one table, and the lane reseat is judged by a profile. */
describe('the judges of the decision loop', () => {
  it('names today\'s profile for each kind of choice', () => {
    expect(judges.chordCheap).toBe(profiles.settled);
    expect(judges.chordSettled).toBe(profiles.settled);
    expect(judges.rankSettled).toBe(profiles.settledRanked);
    expect(judges.rankCheap).toBe(profiles.cheapCrossings);
    expect(judges.linkless).toBe(profiles.keepSet);
    expect(judges.laneReseat).toBe(profiles.laneReseat);
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
