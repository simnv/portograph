import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { verdictTap } from '../../src/layout/objective.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 04: every judge (window, rank, side, fan, close-up, pull, keep-out, step-out, centre step) reads its verdict from the
 * one objective module, and the module reproduces what each judge said before it. The expected digests in `objective-verdicts.json` were
 * recorded from main at 86680ab, before any judge moved, by the same test-only tap (`verdictTap`); the profiles must give the same
 * verdicts, in the same order, with the same figures, on each fixture. Not a golden: it changes only when a judge is meant to.
 *
 * The `centreGroupStep` entries were re-recorded at 7598f3b (architecture 2 ticket 07). That commit skips the replay of the centring check for a group
 * with no candidate, and a replay calls the judge, so the call count fell (for example 7 to 1). Recorded on all 16 fixtures with inputs: every call the
 * branch still makes has main's verdict, and every call it dropped belonged to a replay whose result the check discarded. The verdicts did not change.
 *
 * `three-canton-groups-close-up-to-a-band-gap` and `three-continents` were re-recorded for architecture-2 ticket 23: the overlay port clearance
 * grew from 4 to 7.75 px, so the per-link overlay paths the judges read (`overlayBasePath`; the separated tracks are stage 8's) and their
 * figures changed. No judge changed, and every call count is main's but one: on `three-continents` the trial asks `windowsHold` 54 times
 * (was 55).
 * Re-recorded again for architecture 2 ticket 22: no judge moved, but the inputs did. A long flat chord to a lateral face (80 degrees or more from
 * the normal) is an L, a direct family draws its members as chords decided at the start of 7f (they reserve no gap row), and a member that crowds a
 * planned part runs the attempt again, so four fixtures place other geometry and call the judges on it. three-canton-groups-close-up-to-a-band-gap
 * was recorded once more when two runs from opposite sides of one face came to share a row of the tier gap: its gap plan, and so its geometry, changed. a-chord-hint-and-a-lane-hint-never-share-a-batch
 * was recorded once more for the far-end pull, which stands lb next to fe4.
 * three-canton-groups-close-up-to-a-band-gap was recorded once more for architecture-2 ticket 25: no judge moved, but the zones of canton `a`
 * now stand under their feeds (routed crossings 12 to 4), so the judges are called on other geometry.
 * Eight fixtures were re-recorded for snack-theme ticket 157: the Verdana metrics changed every text width and line height, so the judges are called on other geometry.
 * Twelve were re-recorded for the ticket 157 engine fixes (centring checked again after the overlay windows, its rounds, the title floor). No judge
 * moved: the full streams were compared with the ones at e72e3a9e, and no figures that a judge was given before get another verdict now. On ten
 * fixtures the only change is `centreGroupStep` calls added (the publication check replays each step after the windows); no call was dropped.
 * `three-continents` also asks `windowsHold` and `pickTarget` more often and on other figures (the rounds place the windows again), and on
 * `overlay-links-reorder-two-locations` the geometry differs: `pullTier` reads 0/0 overlay segments where it read 4/4, and `settleKeepOut` is not asked.
 * Ten were re-recorded for the snack-theme ticket 159 engine fixes (stacked nodes, the default; the card switch is not read here). The fixes are the beside-row pack
 * move guard, the riser lane host, the bars, the frozen chords (`blockedChordsAt`, `chordBlockedNew`), the node floor of a moved port, and the frame separation
 * (`frameSeparation`): the judges are called on other geometry and the call counts move. Six fixtures keep the ticket 157 digests.
 */
const FIXTURES = [
  'a-free-client-group-stands-where-its-overlay-links-cross-least', 'a-lower-rank-steps-off-the-chords-of-rank-0', 'a-mover-takes-the-position-that-clears-most-chords',
  'a-side-hint-moves-a-port-to-a-lateral-side', 'a-chord-hint-and-a-lane-hint-never-share-a-batch', 'a-location-router-leaves-a-lateral-side-toward-a-far-provider',
  'a-fan-spreads-its-ports-so-its-chords-hold-clearance', 'three-canton-groups-close-up-to-a-band-gap', 'a-canton-member-frame-slides-off-a-straight-chord',
  'three-continents', 'a-group-with-routed-links-steps-off-a-straight-chord', 'a-linked-node-steps-out-of-a-straight-chord', 'overlay-links-reorder-two-locations',
  'an-overlay-that-7f-straightens-needs-more-than-four-pixels-of-slack', 'a-declined-grown-member-stops-at-an-overlay-chord', 'a-held-lane-between-two-cantons-refuses-the-close-up',
];
const EXPECTED = new URL('./objective-verdicts.json', import.meta.url);
const golden = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** The verdicts of one layout, in order, as "name value" lines. */
async function record(source: string): Promise<string[]> {
  const lines: string[] = [];
  verdictTap.sink = (name, value) => { lines.push(`${name} ${value}`); };
  try { await layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [] }); } finally { delete verdictTap.sink; }
  return lines;
}

/** Per judge: how many verdicts, and a digest of all of them in order. */
function digest(lines: readonly string[]): Record<string, string> {
  const by = new Map<string, string[]>();
  for (const line of lines) {
    const name = line.slice(0, line.indexOf(' '));
    const list = by.get(name) ?? [];
    list.push(line);
    by.set(name, list);
  }
  return Object.fromEntries([...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, list]) => [name, `${list.length} ${createHash('sha1').update(list.join('\n')).digest('hex').slice(0, 16)}`]));
}

describe('the judges after the objective module', () => {
  afterEach(() => { delete verdictTap.sink; });
  const expected = (): Record<string, Record<string, string>> => JSON.parse(readFileSync(EXPECTED, 'utf8')) as Record<string, Record<string, string>>;

  it.each(FIXTURES)('gives each verdict it gave before: %s', async name => {
    expect(digest(await record(golden(name)))).toEqual(expected()[name]);
  }, 120000);

  // By-hand runs. VERDICT_FILES is a comma list of yaml paths and VERDICT_OUT a directory for the full streams.
  // VERDICT_DIGESTS names the file that receives the digests of FIXTURES: saved once, from the judges as they stood at 86680ab.
  it.skipIf(process.env.VERDICT_FILES === undefined)('writes the full verdict streams of the files it is given', async () => {
    const out = process.env.VERDICT_OUT!;
    mkdirSync(out, { recursive: true });
    for (const file of process.env.VERDICT_FILES!.split(',')) writeFileSync(join(out, `${basename(file, '.yaml')}.txt`), `${(await record(readFileSync(file, 'utf8'))).join('\n')}\n`);
  }, 1200000);

  it.skipIf(process.env.VERDICT_DIGESTS === undefined)('writes the digests of the fixtures', async () => {
    const all: Record<string, Record<string, string>> = {};
    for (const name of FIXTURES) all[name] = digest(await record(golden(name)));
    writeFileSync(process.env.VERDICT_DIGESTS!, `${JSON.stringify(all, null, 2)}\n`);
  }, 1200000);
});
