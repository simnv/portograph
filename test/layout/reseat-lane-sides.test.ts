import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { layout, parse as parseDocument } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { targetTap } from '../../src/layout/alignment-targets.js';
import { recordDeclineFindings } from '../../src/layout/centre.js';
import { chooseReseat } from '../../src/layout/decide.js';
import { reseatLanes } from '../../src/layout/lanes.js';
import type { LaneFollow } from '../../src/layout/lanes.js';
import { replayGridAndBands } from '../../src/layout/placement-attempt.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withMoveBeforeGrow } from './move-before-grow.js';

// The seat (ADR-0027) is an opt-in until ticket 15: every sheet of this file is read with `layout.moveBeforeGrow: true`.
const parse = (text: string): ReturnType<typeof parseDocument> => parseDocument(withMoveBeforeGrow(text));

/**
 * The lane reseat of 7f (a corridor follows its child, ticket 02 of architecture-1) is the one move after the last centring of 7f. Two rules hold it
 * (dense-16x9 ticket 02, with the seat addendum: a step that grows a body and leaves every aligned port off its feed is declined whole). On
 * a-corridor-moves-after-the-grid-settles both broke the run before them:
 * - the corridor of link-82 followed its child from 2717.7 to 3237.3 px, across `sc-upper` (3083.4 to 3197.1 px) that stands beside it, and the
 *   post-condition of 7f refused the run (`laneSide`). A corridor does not follow its child across a group it stands beside.
 * - in the second placement run the corridor of link-37 followed its child to 2407.6 px; the publication's replay of `zone-4` then read a standing
 *   transit feed it had never read, declined its target `overlay-straight`, and the record did not hold that decline (`alignment-targets-differ`).
 *   The reseat is judged by that comparison: no centring follows it to write the decline.
 */
const SHEET = 'a-corridor-moves-after-the-grid-settles';
const drafts = async (): Promise<LayoutModel[]> => {
  const found: LayoutModel[] = [];
  targetTap.sink = (tap, value) => { if (tap === 'beforeEndTrim') found.push(JSON.parse(value) as LayoutModel); };
  try {
    await layout(parse(readFileSync(new URL(`../../goldens/synthetic/${SHEET}.yaml`, import.meta.url), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  } finally { delete targetTap.sink; }
  return found;
};
const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
/**
 * The draft of the second placement run whose link-37 corridor follows its child (the reseat the rule refuses). Dense ticket 10 slice B changes
 * the trajectory of the sheet, and the run no longer reaches that reseat, so the rule is judged on the stored draft. A draft taken inside 7f is
 * no publication (its stage still reads `bundles` and it carries label bands), so `restoreLayoutModel` refuses it; it is read as JSON and must
 * prove it still describes this sheet and this reseat, or the test names the file and fails.
 * Provenance: a-corridor-moves-after-the-grid-settles, main ece96c5a, layout.moveBeforeGrow on, the `beforeEndTrim` tap of `drafts()` whose reseat follows lane:"link-37":6; regenerate by running `drafts()` on such a commit and writing that tap's JSON text.
 */
const STAGED = new URL('../fixtures/staged/a-corridor-moves-after-the-grid-settles.link-37-reseat-draft.json', import.meta.url);
function stagedDraft(): LayoutModel {
  const name = fileURLToPath(STAGED), draft = JSON.parse(readFileSync(STAGED, 'utf8')) as LayoutModel;
  const document = JSON.parse(JSON.stringify(parse(readFileSync(new URL(`../../goldens/synthetic/${SHEET}.yaml`, import.meta.url), 'utf8')))) as unknown;
  if (!isDeepStrictEqual(draft.document, document)) throw new Error(`${name}: stale draft, its document is not the current parse of ${SHEET} with layout.moveBeforeGrow`);
  const findings = recordDeclineFindings(copy(draft));
  if (findings.length) throw new Error(`${name}: stale draft, its own record has decline findings: ${findings.join(', ')}`);
  const followed: LaneFollow[] = [];
  if (!reseatLanes(copy(draft), followed) || !followed.some(item => item.lane === 'lane:"link-37":6')) {
    throw new Error(`${name}: stale draft, it no longer reseats lane:"link-37":6 (followed ${followed.map(item => item.lane).join(', ') || 'none'})`);
  }
  return draft;
}
/** The groups that stand beside a lane at both readings and have their centre on the other side of it, as the `laneSide` post-condition reads them. */
function sideChanges(before: LayoutModel, after: LayoutModel): string[] {
  const found: string[] = [];
  for (const lane of after.lanes) {
    const old = before.lanes.find(item => item.id === lane.id);
    if (old === undefined) continue;
    for (const group of Object.values(after.groups)) {
      const was = before.groups[group.id]?.bounds, now = group.bounds;
      if (was === undefined || now === undefined || group.id === lane.group) continue;
      const beside = (box: { y: number; height: number }, at: { bounds: { y: number; height: number } }): boolean => box.y < at.bounds.y + at.bounds.height && at.bounds.y < box.y + box.height;
      const straddles = (box: { x: number; width: number }, x: number): boolean => box.x < x && x < box.x + box.width;
      if (!beside(was, old) || !beside(now, lane) || straddles(was, old.x) || straddles(now, lane.x)) continue;
      if ((was.x + was.width / 2 >= old.x) !== (now.x + now.width / 2 >= lane.x)) found.push(`${group.id}|${lane.id}`);
    }
  }
  return found;
}

describe('the lane reseat after the last centring of 7f (dense-16x9 ticket 02)', () => {
  it('a corridor does not follow its child across a group it stands beside', async () => {
    const all = await drafts();
    expect(all.length).toBeGreaterThan(0);
    for (const draft of all) {
      const moved = copy(draft);
      reseatLanes(moved);
      expect(sideChanges(draft, moved)).toEqual([]);
    }
    // The first draft is the one the post-condition refused: the corridor of link-82 stays left of `sc-upper`.
    const first = copy(all[0]!), lane = first.lanes.find(item => item.id === 'lane:"link-82":10')!;
    const x = lane.x, group = first.groups['sc-upper']!.bounds!;
    expect(x).toBeLessThan(group.x);
    reseatLanes(first);
    expect(first.lanes.find(item => item.id === lane.id)!.x).toBe(x);
  }, 300000);
  it('refuses a reseat after which the publication replay declines a target the record does not', () => {
    const all = [stagedDraft()];
    let judged = 0;
    for (const draft of all) {
      const moved = copy(draft), held = structuredClone(moved.lanes), followed: LaneFollow[] = [];
      if (!reseatLanes(moved, followed) || !followed.some(item => item.lane === 'lane:"link-37":6')) continue;
      const settled = copy(moved);
      replayGridAndBands(settled);
      expect(recordDeclineFindings(settled)).toContain('alignment-targets-differ: lab4crt001|top');
      expect(recordDeclineFindings(draft)).toEqual([]);
      expect(chooseReseat(moved, held, followed, replayGridAndBands)).toBe(false);
      judged++;
    }
    expect(judged).toBeGreaterThan(0);
  }, 300000);
});
