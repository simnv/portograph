import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import type { AttemptTraceEvent } from '../../src/layout/placement-attempt.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from '../layout/joint-off.js';

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
  withoutJointOrder(readFileSync(new URL(`../../goldens/${name === 'm1-sip-edge' ? '' : 'synthetic/'}${name}.yaml`, import.meta.url), 'utf8'));

interface Row {
  name: string; counters: string | undefined; runs: number; attempts: number; rounds: number; open: number; chord: number; baseChord: number; reseat: 'none' | 'refused';
  probe: number; preChords: number; preCentre: number; base7f: string;
}
const row = (name: string, counters: string | undefined, runs: number, attempts: number, rounds: number, open: number, chord: number,
  rest: Partial<Pick<Row, 'baseChord' | 'reseat' | 'probe' | 'preChords' | 'preCentre' | 'base7f'>> = {}): Row =>
  ({ name, counters, runs, attempts, rounds, open, chord, baseChord: 0, reseat: 'none', probe: 0, preChords: 0, preCentre: 0, base7f: '0/0/0', ...rest });

const ROWS: Row[] = [
  // Phase 4 (the unified order): the base 7f of three-continents now moves a chord (before 0 moves) and loses 2 overlay links in the loop, and the attempt costs more work.
  // Verdana metrics (snack-theme ticket 157): the wider text moves three-continents to 21/99/62/5 with 3 place runs and 3 overlay links lost in the base 7f loop (23/74/54/5, 2 runs, 2 lost with Arial).
  // Ticket 157 review: the rounds of `centreDraft` after the overlay windows stop on a stall (a round that changes neither the geometry nor what the
  // check finds) and keep the rest of the shared budget; the replays of the stages after 7c spend it, so the centring passes are 117 (99 before the stop).
  // Architecture-2 ticket 54 (titles last): no title refuses a chord or pads a band, so the published attempt converges (main 552ca5b2 published with
  // PLACEMENT_NON_CONVERGENCE) and its base 7f loop loses no overlay link (3 before); the unkept course trial ends 2 rounds open. 2 place runs, 5 rounds
  // (3 and 4 before), 24/105/54/5 (21/117/62/5 before).
  // Ticket 57 (the tier gaps solved once, after the rounds): no settle round grows a gap and replays for it. three-continents 22/100/50/5 (24/105/54/5
  // before); a-tier-gap-plan 1/24/10/3, one round (2/56/14/3: its second round was the growth's; 2/48/14/3 and two bodies since ticket 65); two-interleaved 1/6/7/3 and a-tier-gap-grows 1/4/7/3
  // (one centring pass each, the replay after the growth).
  row('three-continents', '22/100/50/5', 2, 2, 5, 2, 2, { preCentre: 2, baseChord: 1 }),
  // Ticket 22: a direct family on this sheet, and the crowding check of the attempt runs it a second round (1/40/10/3, 1 round before).
  // Ticket 65: the settle after the rounds puts src back at the spec's x, a direct member then crowds a planned part, and the attempt body runs
  // once more with it refused (two bodies of one round each, one settle and its eight passes each): 2/48/14/3 and 2 rounds (1/24/10/3 and 1 before).
  row('a-tier-gap-plan-orders-every-part', '2/48/14/3', 1, 1, 2, 0, 0, { reseat: 'refused', preChords: 1 }),
  row('two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row', '1/6/7/3', 1, 1, 1, 0, 0),
  row('a-tier-gap-grows-to-its-rows', '1/4/7/3', 1, 1, 1, 0, 0),
  // Ticket 54: one centring pass fewer (1/5/7/3 before).
  row('a-re-seated-band-carries-its-bar-and-flank', '1/4/7/3', 1, 1, 1, 0, 0),
  row('sync-links-do-not-stack-a-tier', '1/4/7/3', 1, 1, 1, 0, 0),
  row('an-overlay-leaves-a-lateral-side-past-a-sibling-body', '2/7/12/5', 2, 2, 2, 0, 0),
  // Ticket 22: a long, flat chord never joins perpendicular faces, so this sheet has no chord hint at 90 degrees and no second side trial (2/16/12/5, 2 attempts, probe 2 before).
  // The far-end pull (ticket 22) stands lb next to fe4, so its link is a chord (1/14/7/3 before).
  // Ticket 75: the pull is idempotent, so the 7f held-axes probe moves nothing (probe 1 before).
  row('a-chord-hint-and-a-lane-hint-never-share-a-batch', '1/13/7/3', 4, 1, 1, 0, 0),
  row('a-fan-spreads-its-ports-so-its-chords-hold-clearance', '1/7/7/3', 2, 1, 1, 0, 0),
  row('transit-fan', '1/4/7/3', 1, 1, 1, 0, 0),
  // Ticket 162 (a diagonal may cross a title): the two feeds the canton titles refused are chords before centring, which takes them off (pre-7f chords
  // lost 2), and the sheet needs two centring passes less (1/10/7/3 before).
  // Ticket 54: no title refuses the feeds, so no chord is lost before centring (preChords 2 before) and one centring pass less (1/8/7/3 before).
  row('a-canton-member-frame-slides-off-a-straight-chord', '1/7/7/3', 2, 1, 1, 0, 0),
  // Ticket 162: the feeds are authored `route: orthogonal` (as chords they would cross the titles), so no fan or side round places again (1/19/7/3, 3 runs before).
  // Ticket 54: five centring passes fewer (1/10/7/3 before).
  row('columns-hold-their-axis-after-7f', '1/5/7/3', 1, 1, 1, 0, 0),
  row('a-canton-band-holds-the-rows-off', '1/7/7/3', 2, 1, 1, 0, 0),
  // Verdana metrics (snack-theme ticket 157): one centring pass fewer (1/7/7/3 with Arial).
  // Ticket 54: the title no longer refuses link-2 (it takes the halo), so the first placement run holds one more chord, a side hint re-runs the
  // placement (2 runs, 2 attempts, 2 rounds, pre-7f chords lost 1) and the base 7f loses no aligned link (0/1/0, 1/6/7/3 and one of each before).
  // The sheet gains: 6/6 routed straight (5/6), 861 px wide (926), Q 0.9028 (0.8739).
  row('a-member-title-widens-a-beside-row', '2/8/12/5', 2, 2, 2, 0, 0, { preChords: 1 }),
  // The cost counters (settle, centring passes, copies, replays) of this sheet move with every change to the sweep that seats a flank beside a frame (architecture ticket 19: the
  // centring passes 15 to 13); what the sheet pins is its behaviour: the runs, the attempts, the rounds, no open round, no chord move, and the findings below.
  // Architecture 2, ticket 03: the side trial on this sheet (link-1, a lane hint on up-1.100G#3) is refused at its 7e now, because the far port of the lane is 65 px off the lane x
  // (the reservation `laneOwner` reads the anchor, not the flag), where it was refused after 7f for no fewer bends. The second 7f attempt never starts: attempts and rounds 2 to 1. The published layout and score are the same.
  // The 9 px pills need three placement runs instead of four; the other decisions are unchanged.
  row('a-canton-column-is-not-pulled-into-a-flank', undefined, 3, 1, 1, 0, 0),
  row('a-flank-link-around-a-neighbour-runs-along-the-core-edge', '1/4/7/3', 1, 1, 1, 0, 0),
  // Ticket 156: protected x separation restores five centring passes; every other count is unchanged.
  row('m1-sip-edge', '1/5/7/3', 1, 1, 1, 0, 0),
  // The phase-1 fixture: the base 7f chord step moves a group (before this, only NTP among the named sheets did).
  // Phase 3b of ticket 15: the base 7f moved a group and the kept result has no offer, so the unmoved 7f baseline is measured and its offer runs as one extra, refused side trial (3 attempts, 2 place runs; the settled copy 7f kept filters, the unmoved baseline is rebuilt).
  // Architecture 2, ticket 23: the grown overlay port clearance and the separated tracks cost this sheet one settle call, one centring pass and two candidate copies more (14/29/37 to 15/30/39).
  // Verdana metrics (snack-theme ticket 157): 13/28/35/6 (15/30/39/6 with Arial).
  // Ticket 162: two feeds a title refused are chords before centring, which takes them off (pre-7f chords lost 2, 0 before).
  // Ticket 54: no title refuses the feeds (pre-7f chords lost 0) and nine centring passes fewer (13/28/35/6 before).
  row('a-chord-step-moves-a-group-off-a-straight-chord', '13/19/35/6', 2, 3, 5, 0, 2, { baseChord: 1 }),
];

interface Reading { counters: string; runs: number; attempts: number; rounds: number; open: number; chord: number; baseChord: number; reseat: string; probe: number; preChords: number; preCentre: number; base7f: string; events: AttemptTraceEvent[] }
async function ledger(text: string, on = true): Promise<Reading> {
  resetAttemptCounters(); attemptCounters.ledger = on;
  const events: AttemptTraceEvent[] = [];
  await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [], ...(on ? { attemptTrace: event => events.push(event) } : {}) });
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
    const costless = expected.counters === undefined;
    expect({ counters: costless ? undefined : found.counters, runs: found.runs, attempts: found.attempts, rounds: found.rounds, open: found.open, chord: found.chord, baseChord: found.baseChord, reseat: found.reseat,
      probe: found.probe, preChords: found.preChords, preCentre: found.preCentre, base7f: found.base7f })
      .toEqual({ counters: expected.counters, runs: expected.runs, attempts: expected.attempts, rounds: expected.rounds, open: expected.open, chord: expected.chord, baseChord: expected.baseChord,
        reseat: expected.reseat, probe: expected.probe, preChords: expected.preChords, preCentre: expected.preCentre, base7f: expected.base7f });
    // No fixture stands a body on a frozen chord or fails to settle its cantons (section 2, "Findings").
    const i = attemptCounters.invalidations;
    // Phase 4: the unified order takes a chord move on three-continents that a later round has to regrow a gap for (1); the others stay at 0.
    // Verdana metrics (snack-theme ticket 157): three-continents regrows no gap now (1 with Arial).
    // Ticket 57: a gap may stand short after the rounds (`shortGapsAfterRounds`): the one solve after them grows it. That count is not judged.
    // Ticket 57 deletes the count of regrown gaps (`gapRegrown`): no round grows a gap.
    expect([i.bodyOnFrozenChord, i.cantonNonConvergence]).toEqual([0, 0]);
  }, 60000);

  it('traces the step verdicts of the ledger only when a trace is asked for, and the chord step of the phase-1 fixture moves', async () => {
    const found = await ledger(golden('a-chord-step-moves-a-group-off-a-straight-chord'));
    const passes = found.events.map(event => event.pass);
    // Ticket 57: a round grows no gap (no `grow` step); the one solve runs after the rounds.
    expect(passes).toEqual(expect.arrayContaining(['ledger:freeze', 'ledger:round-0:close-up', 'ledger:round-0:keep-out', 'ledger:round-0:chords', 'ledger:short-gaps', 'solve-tier-gaps']));
    expect(passes).not.toContain('ledger:round-0:grow');
    expect(found.events.find(event => event.pass === 'round-0:chords')?.verdict).toBe('moved');
    expect(found.events.find(event => event.pass === 'ledger:round-0:chords')?.verdict).toMatch(/^overlay -\d+\/\+\d+ aligned -\d+ blocked \+\d+$/);
  }, 60000);

  // Ticket 54 (titles last): three-continents 43/21/25 (19/19/24 before); the run has one 7f round more and publishes with no non-convergence.
  // Verdana metrics (snack-theme ticket 157): three-continents 19/19/24 (21/21/31 with Arial), a-chord-step 10/10/13 (12/12/15 with Arial).
  // Ticket 162: the canton-member frame needs one gap round (2 before): its feeds are chords over the canton titles and grow no gap.
  // Phase 2: the replays, the settled copies the chord step judged on, and the rounds of the gap fixed point (deleted by ticket 57), where they dropped. Before the phase:
  // Phase 4 raised three-continents to 21/21/31 (more candidates pass the gate of the unified order, each one settled). Ticket 22: a-tier-gap-plan gap rounds 3 to 5 (the crowding round of the direct family). Ticket 23 (the overlay port clearance, separated tracks) raised the chord-step fixture 11/11/14 to 12/12/15. Before it: three-continents 8/7/10, a-tier-gap-plan 1/0/3, two-interleaved 1/0/2, a-tier-gap-grows 1/0/2, canton-member-frame 1/0/2, chord-step fixture 5/4/6.
  // Ticket 57: the gap rounds are gone; the tier gaps are solved once per 7f attempt body (`gapSolves` = the attempts and their retries),
  // and no settle round replays for a growth: three-continents 41/19 (43/21 and 25 gap rounds before), the others 0/0 (5, 2, 2, 1 gap
  // rounds), the chord-step fixture 10/10 (13 gap rounds).
  it.each([
    ['three-continents', 41, 19, 2], ['a-tier-gap-plan-orders-every-part', 2, 0, 2], ['two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row', 0, 0, 1],
    ['a-tier-gap-grows-to-its-rows', 0, 0, 1], ['a-canton-member-frame-slides-off-a-straight-chord', 0, 0, 1], ['a-chord-step-moves-a-group-off-a-straight-chord', 10, 10, 3],
  ] as const)('derives once: %s replays %i, settled copies %i, gap solves %i', async (name, replays, trials, solves) => {
    resetAttemptCounters(); attemptCounters.ledger = true;
    await layout(parse(golden(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [] });
    expect([attemptCounters.replays, attemptCounters.settledTrials, attemptCounters.gapSolves]).toEqual([replays, trials, solves]);
    // Exactly one solve per 7f attempt body: an attempt and its retries (a crowded direct member runs the body again, ticket 22), each body one
    // entry of the attempt log. Since ticket 65 a-tier-gap-plan retries once (its replays are the settle after the rounds, once per body).
    expect(attemptCounters.gapSolves).toBe(attemptCounters.attemptLog.length);
  }, 60000);

  it('reads nothing of the model when the ledger and the trace are off', async () => {
    resetAttemptCounters(); attemptCounters.ledger = false;
    await layout(parse(golden('a-member-title-widens-a-beside-row')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const i = attemptCounters.invalidations;
    // The cheap counters run; the ones that need a read of the links stay at zero and the logs hold no entry. (With the ledger on this fixture loses 1 routed aligned link.)
    // Two 7f runs: the baseline and the course trial that gives link-3 the L of a step (architecture-2 ticket 09, follow-up; one trial, kept).
    expect(attemptCounters.attempts).toBe(2);
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
      // Ticket 57 rebaselines this opt-in test: main acad67cd read '77/267/237/5', rounds 10, chord 6, preChords 8, base7f '6/4/0' (stale since the
      // titles-last ticket 54); with one tier-gap solve it reads the values below.
      .toEqual({ counters: '42/153/150/5', runs: 4, attempts: 2, rounds: 5, open: 0, chord: 3, baseChord: 1, reseat: 'none', probe: 0, preChords: 14, preCentre: 12, base7f: '9/4/0' });
    expect([i.bodyOnFrozenChord, i.cantonNonConvergence]).toEqual([0, 0]);
    // The close-up opened again after a chord move, in the base run and in the side trial (section 2: 0.87 px in r1).
    expect(i.closeUpReopened).toBe(0);
    // Phase 2: 16 replays, 12 settled copies, 16 gap rounds. Phase 4 (the unified order lets more candidates pass to a settled copy): 46, 40 and 44.
    // Ticket 57: 41 replays, 38 settled copies, and one gap solve per attempt (2).
    expect([attemptCounters.replays, attemptCounters.settledTrials, attemptCounters.gapSolves]).toEqual([41, 38, 2]);
  }, 120000);
});
