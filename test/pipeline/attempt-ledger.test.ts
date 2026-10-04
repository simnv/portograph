import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import type { AttemptTraceEvent } from '../../src/layout/placement-attempt.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 13, phase 1: the ledger. It reads the counts of section 2 of the design (main 78dcc8b, before any change of 7f) and pins them.
 * A change to 7f that moves one of these numbers is a decision to make in the open, not a side effect; the later phases of the ticket change them on purpose.
 *
 * The columns follow section 2: the counters over the whole `layout()` (settle, centring, copies, validation replays); place runs (`placeRuns`: the first run, the fan
 * re-runs and every side re-run, also one that the placement rejected, so it can exceed the figure of section 2); 7f runs; the rounds of all 7f runs and how many of them ended open; the rounds in
 * which the chord step moved a mover, over all 7f runs and in the base run alone; the held-axis probe that would move a column; before 7f, the routed chords lost and the straight overlay links the
 * windows lost at `centre` (first run and fan re-runs only, as the designer's replica read them); and in the loop of the base 7f run, the overlay links lost,
 * the routed aligned links lost and the bodies that came to stand on a frozen chord.
 *
 * Phase 2 (derive once) lowered the settle, centring, replay and gap-round counts of the fixtures that grow a gap or move a chord, and changed nothing else:
 * the chord step hands back the settled copy of its last kept move and the draft takes it (no replay, no settle in the next round), and the growth of the
 * tier gaps hands back its last trial when it stopped on "no change" and the round takes it in place of the replay. The layout is byte-identical.
 */
const golden = (name: string): string =>
  readFileSync(new URL(`../../goldens/${name === 'm1-sip-edge' ? '' : 'synthetic/'}${name}.yaml`, import.meta.url), 'utf8');

interface Row {
  name: string; counters: string; runs: number; attempts: number; rounds: number; open: number; chord: number; baseChord: number; reseat: 'none' | 'refused';
  probe: number; preChords: number; preCentre: number; base7f: string;
}
const row = (name: string, counters: string, runs: number, attempts: number, rounds: number, open: number, chord: number,
  rest: Partial<Pick<Row, 'baseChord' | 'reseat' | 'probe' | 'preChords' | 'preCentre' | 'base7f'>> = {}): Row =>
  ({ name, counters, runs, attempts, rounds, open, chord, baseChord: 0, reseat: 'none', probe: 0, preChords: 0, preCentre: 0, base7f: '0/0/0', ...rest });

const ROWS: Row[] = [
  // Phase 4 (the unified order): the base 7f of three-continents now moves a chord (before 0 moves) and loses 2 overlay links in the loop, and the attempt costs more work.
  row('three-continents', '23/74/54/5', 2, 2, 4, 0, 2, { preCentre: 2, baseChord: 1, base7f: '2/0/0' }),
  row('a-tier-gap-plan-orders-every-part', '1/40/10/3', 1, 1, 1, 0, 0, { reseat: 'refused', preChords: 1 }),
  row('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row', '1/7/7/3', 1, 1, 1, 0, 0),
  row('a-tier-gap-grows-to-its-rows', '1/5/7/3', 1, 1, 1, 0, 0),
  row('a-re-seated-band-carries-its-bar-and-flank', '1/5/7/3', 1, 1, 1, 0, 0),
  row('sync-links-do-not-stack-a-tier', '1/4/7/3', 1, 1, 1, 0, 0),
  row('an-overlay-leaves-a-lateral-side-past-a-sibling-body', '2/7/12/5', 2, 2, 2, 0, 0),
  row('a-chord-hint-and-a-lane-hint-never-share-a-batch', '2/16/12/5', 4, 2, 2, 0, 0, { probe: 2 }),
  row('a-fan-spreads-its-ports-so-its-chords-hold-clearance', '1/7/7/3', 2, 1, 1, 0, 0),
  row('transit-fan', '1/4/7/3', 1, 1, 1, 0, 0),
  row('a-canton-member-frame-slides-off-a-straight-chord', '1/10/7/3', 2, 1, 1, 0, 0),
  row('columns-hold-their-axis-after-7f', '1/19/7/3', 3, 1, 1, 0, 0),
  row('a-canton-band-holds-the-rows-off', '1/7/7/3', 2, 1, 1, 0, 0),
  row('a-member-title-widens-a-beside-row', '1/7/7/3', 1, 1, 1, 0, 0, { base7f: '0/1/0' }),
  row('a-canton-column-is-not-pulled-into-a-flank', '2/15/12/5', 4, 2, 2, 0, 0),
  row('a-flank-link-around-a-neighbour-runs-along-the-core-edge', '1/4/7/3', 1, 1, 1, 0, 0),
  row('m1-sip-edge', '1/5/7/3', 1, 1, 1, 0, 0),
  // The phase-1 fixture: the base 7f chord step moves a group (before this, only NTP among the named sheets did).
  // Phase 3b of ticket 15: the base 7f moved a group and the kept result has no offer, so the unmoved 7f baseline is measured and its offer runs as one extra, refused side trial (3 attempts, 2 place runs; the settled copy 7f kept filters, the unmoved baseline is rebuilt).
  row('a-chord-step-moves-a-group-off-a-straight-chord', '14/29/37/6', 2, 3, 5, 0, 2, { baseChord: 1 }),
];

interface Reading { counters: string; runs: number; attempts: number; rounds: number; open: number; chord: number; baseChord: number; reseat: string; probe: number; preChords: number; preCentre: number; base7f: string; events: AttemptTraceEvent[] }
async function ledger(text: string, on = true): Promise<Reading> {
  resetAttemptCounters(); attemptCounters.ledger = on;
  const events: AttemptTraceEvent[] = [];
  await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...(on ? { attemptTrace: event => events.push(event) } : {}) });
  const c = attemptCounters, i = c.invalidations, placed = c.placements.slice(0, 1 + i.fanReruns), base = c.attemptLog[0]!;
  return { counters: [c.settleCalls, c.centringPasses, c.candidateCopies, c.validationReplays].join('/'),
    runs: c.placeRuns, attempts: c.attempts, rounds: c.rounds, open: c.openRounds, chord: c.chordRoundsMoved, baseChord: base.chordRoundsMoved,
    reseat: c.reseat.refused ? 'refused' : c.reseat.adopted ? 'adopted' : 'none', probe: i.heldProbeMoved,
    preChords: placed.reduce((sum, entry) => sum + entry.chordsLost, 0), preCentre: placed.reduce((sum, entry) => sum + entry.centreOverlayLost, 0),
    base7f: `${base.overlayLost}/${base.alignedLost}/${base.bodiesOnFrozenChord}`, events };
}

describe('the ledger of the 7f placement attempt reads the counts of the ticket 13 design', () => {
  beforeEach(() => { resetAttemptCounters(); });
  afterEach(() => { attemptCounters.ledger = false; resetAttemptCounters(); });

  it.each(ROWS)('$name', async expected => {
    const found = await ledger(golden(expected.name));
    expect({ counters: found.counters, runs: found.runs, attempts: found.attempts, rounds: found.rounds, open: found.open, chord: found.chord, baseChord: found.baseChord, reseat: found.reseat,
      probe: found.probe, preChords: found.preChords, preCentre: found.preCentre, base7f: found.base7f })
      .toEqual({ counters: expected.counters, runs: expected.runs, attempts: expected.attempts, rounds: expected.rounds, open: expected.open, chord: expected.chord, baseChord: expected.baseChord,
        reseat: expected.reseat, probe: expected.probe, preChords: expected.preChords, preCentre: expected.preCentre, base7f: expected.base7f });
    // No fixture regrows a gap, leaves a gap short, stands a body on a frozen chord or fails to settle its cantons (section 2, "Findings").
    const i = attemptCounters.invalidations;
    // Phase 4: the unified order takes a chord move on three-continents that a later round has to regrow a gap for (1); the others stay at 0.
    expect([i.gapRegrown, i.shortGapsAfterRounds, i.bodyOnFrozenChord, i.cantonNonConvergence]).toEqual([expected.name === 'three-continents' ? 1 : 0, 0, 0, 0]);
  }, 60000);

  it('traces the step verdicts of the ledger only when a trace is asked for, and the chord step of the phase-1 fixture moves', async () => {
    const found = await ledger(golden('a-chord-step-moves-a-group-off-a-straight-chord'));
    const passes = found.events.map(event => event.pass);
    expect(passes).toEqual(expect.arrayContaining(['ledger:freeze', 'ledger:round-0:grow', 'ledger:round-0:close-up', 'ledger:round-0:keep-out', 'ledger:round-0:chords', 'ledger:short-gaps']));
    expect(found.events.find(event => event.pass === 'round-0:chords')?.verdict).toBe('moved');
    expect(found.events.find(event => event.pass === 'ledger:round-0:chords')?.verdict).toMatch(/^overlay -\d+\/\+\d+ aligned -\d+ blocked \+\d+$/);
  }, 60000);

  // Phase 2: the replays, the settled copies the chord step judged on, and the rounds of the gap fixed point, where they dropped. Before the phase:
  // Phase 4 raised three-continents to 21/21/31 (more candidates pass the gate of the unified order, each one settled). Before it: three-continents 8/7/10, a-tier-gap-plan 1/0/3, two-interleaved 1/0/2, a-tier-gap-grows 1/0/2, canton-member-frame 1/0/2, chord-step fixture 5/4/6.
  it.each([
    ['three-continents', 21, 21, 31], ['a-tier-gap-plan-orders-every-part', 0, 0, 3], ['two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row', 0, 0, 2],
    ['a-tier-gap-grows-to-its-rows', 0, 0, 2], ['a-canton-member-frame-slides-off-a-straight-chord', 0, 0, 2], ['a-chord-step-moves-a-group-off-a-straight-chord', 11, 11, 14],
  ] as const)('derives once: %s replays %i, settled copies %i, gap rounds %i', async (name, replays, trials, gapRounds) => {
    resetAttemptCounters();
    await layout(parse(golden(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect([attemptCounters.replays, attemptCounters.settledTrials, attemptCounters.gapRounds]).toEqual([replays, trials, gapRounds]);
  }, 60000);

  it('reads nothing of the model when the ledger and the trace are off', async () => {
    resetAttemptCounters(); attemptCounters.ledger = false;
    await layout(parse(golden('a-member-title-widens-a-beside-row')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const i = attemptCounters.invalidations;
    // The cheap counters run; the ones that need a read of the links stay at zero and the logs hold no entry. (With the ledger on this fixture loses 1 routed aligned link.)
    expect(attemptCounters.attempts).toBe(1);
    expect([i.routedAlignedLost, i.overlayStraightLost, i.preOverlayStraightLost, i.shortGapsAfterRounds]).toEqual([0, 0, 0, 0]);
    expect(attemptCounters.placements).toEqual([]);
    expect(attemptCounters.attemptLog).toEqual([]);
  }, 60000);

  // NTP is a public sheet kept outside the repository, and one run is about 17 s: it runs only when PORTOGRAPH_NTP_SHEET names the file.
  it.skipIf(process.env.PORTOGRAPH_NTP_SHEET === undefined)('NTP: the ledger reads section 2', async () => {
    const found = await ledger(readFileSync(process.env.PORTOGRAPH_NTP_SHEET!, 'utf8'));
    const i = attemptCounters.invalidations;
    expect({ counters: found.counters, runs: found.runs, attempts: found.attempts, rounds: found.rounds, open: found.open, chord: found.chord, baseChord: found.baseChord, reseat: found.reseat,
      probe: found.probe, preChords: found.preChords, preCentre: found.preCentre, base7f: found.base7f })
      .toEqual({ counters: '42/168/120/5', runs: 4, attempts: 2, rounds: 6, open: 0, chord: 4, baseChord: 2, reseat: 'none', probe: 0, preChords: 2, preCentre: 9, base7f: '7/0/0' });
    // NTP regrows no gap.
    expect([i.gapRegrown, i.shortGapsAfterRounds, i.bodyOnFrozenChord, i.cantonNonConvergence]).toEqual([0, 0, 0, 0]);
    // The close-up opened again after a chord move, in the base run and in the side trial (section 2: 0.87 px in r1).
    expect(i.closeUpReopened).toBe(0);
    // Phase 2: 16 replays, 12 settled copies, 16 gap rounds. Phase 4 (the unified order lets more candidates pass to a settled copy): 46, 40 and 44.
    expect([attemptCounters.replays, attemptCounters.settledTrials, attemptCounters.gapRounds]).toEqual([46, 40, 44]);
  }, 120000);
});
