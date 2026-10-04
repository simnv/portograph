import type { LayoutModel } from '../model/layout.js';
import { blockedChords, edgeLeavers, freezeChords } from './frame-paths.js';
import { type LaneFollow, lanesHoldTheirChild, sideLaneFindings, rebuildLaneExtents, reseatLanes } from './lanes.js';
import { centreViolations } from './centre.js';
import { stepLinklessOutOfChords } from './overlay-place.js';
import { stepOverChords } from './chord-clear.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { alignLinkedGroupGridAndPack, closeCantonsAndSettle, settleKeepOut, type LinkLabelShortfall, produceGroupLabelBands, replanGroupLabels, reserveLinkLabelRoom } from './bands.js';
import { holdColumnAxes, refreshHeldWarnings } from './columns.js';
import { growTierGaps } from './gap-room.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { tierGapPlans } from './gap-plan.js';
import { attemptCounters } from './attempt-counters.js';
import { countStep, ledgerOn, ledgerSnapshot, startAttemptEntry, type LedgerSnapshot } from './attempt-ledger.js';

/**
 * The stage-7f placement attempt: the producer of the `bands` rule (ADR-0010, ADR-0015). `withLayoutMutation` invokes it on its own draft,
 * after it has checked that the bands callback authored no placement; nothing else calls it, and it has no unchecked draft API of its own.
 * The transaction validates and freezes what it leaves. The order of the passes, each budget and its reset point, every tolerance, warning
 * and comparison are those 7f has always had (ticket 02 of the architecture roadmap moved them here and changed none).
 *
 * The passes, in order, on the draft:
 *   1. `freezeChords`, then `produceGroupLabelBands`: the last confirmation of a chord becomes a wall, then the reservation of the label bands.
 *   2. Up to `CANTON_ROUNDS` rounds of `settleRound`, `stepLinklessOutOfChords` and the step over a chord (`stepOverChords`, which judges
 *      each move on a copy that `trialSettle` has run); a round that moved anything is followed by `replayRegions`.
 *   3. The held-axis probe (`holdColumnAxes` on a copy), and the non-convergence warning for the cantons.
 *   4. `reseatLanes`, adopted only when the settled trial is no worse in four named respects.
 *   5. The diagnostics read once on the final geometry: blocked chords, side lanes, chords that leave a frame by a side edge.
 */

/** Rounds of the tier-gap growth and the canton close-up in 7f (ranked-groups ticket 65). */
const CANTON_ROUNDS = 4;
/** The move of a close-up round, in px, under which the cantons stand a band gap apart for every purpose (ranked-groups ticket 65). */
const CANTON_CREEP = 0.5;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** A copy of the model to try something on. Counted, so a test can read how much trying one attempt does. */
function candidateCopy(model: LayoutModel): LayoutModel {
  attemptCounters.candidateCopies++;
  return clone(model);
}

/** One line of the opt-in trace: a pass, a short hash of the model after it, and what the pass decided. */
export interface AttemptTraceEvent { pass: string; revision: string; verdict: string }
export interface AttemptOptions {
  /** A check of the command deadline: it throws between the passes of 7f and never changes the layout (ticket 141). */
  abortAt?: (() => void) | undefined;
  /** Opt-in per-pass trace. Off when absent; the events are handed to the caller and never written into the layout. */
  trace?: ((event: AttemptTraceEvent) => void) | undefined;
}
/** An FNV-1a hash of the model text, eight hex digits. Read only when a trace was asked for. */
function revisionOf(model: LayoutModel): string {
  const text = JSON.stringify(model);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

/**
 * The tier gaps whose plan asks for more height than they have. 7f has already reserved the room every gap asks
 * for, so a later reservation change that makes one of these owe more room owes it room nothing
 * will reserve.
 */
function shortGaps(model: LayoutModel): string[] {
  // A gap is short where the plan asks for more height than the gap has. A residual part is the router's and is planned no seat.
  return tierGapPlans(model).filter(({ plan }) => plan.growth > PLACEMENT_EPS).map(({ gap }) => `gap:${gap.above}:${gap.below}`);
}
/** Whether `after` names nothing `before` does not. A trade of one item for another is not "no worse". */
function noNewItems(after: readonly string[], before: readonly string[]): boolean {
  const held = new Set(before);
  return after.every(item => held.has(item));
}

/** The grid and the labels, settled again: the part of a replay that does not rebuild the regions. */
export function replayGridAndLabels(model: LayoutModel): void {
  alignLinkedGroupGridAndPack(model);
  replanGroupLabels(model);
}
/**
 * The replay a move of groups is followed by: the regions, the grid and the labels. This is the one place that names it; `settleRound`,
 * the rounds below and the chord trials all call it.
 */
export function replayRegions(model: LayoutModel): void {
  attemptCounters.replays++;
  rebuildRegionGeometry(model, undefined, undefined, true);
  replayGridAndLabels(model);
}

/**
 * The growth of the tier gaps is measured on the columns as they stand, and the close-up of the cantons (ranked-groups ticket 65)
 * moves them in x after centring widened one in place: so the growth is measured again after every move, and the rounds end when
 * the close-up has nothing to move. A round that moves groups replays the region producers, and the grid and the labels after it.
 * One round of the growth and the close-up, on any model: the loop runs it on the draft, and the step over a chord (ticket 77)
 * runs it on a copy to see what a move settles into. It returns the shift of the close-up.
 */
export function settleRound(model: LayoutModel, tap?: (step: 'grow' | 'close-up' | 'keep-out', changed: boolean) => void): number {
  attemptCounters.settleCalls++;
  const grew = growTierGaps(model);
  if (grew) {
    // The replay refits every group box to its content, so a linked pair the first step gave one
    // x-extent (ADR-0012) holds two again and the published model would not be the grid's fixed
    // point — which is what `validateGroupLabelBands` demands. The grid is settled here, before
    // the labels are planned in these boxes, because it belongs to the replay and not to the
    // third step: it grows box extents onto edges that already exist, and moves a node only to pack beside rows that stood open
    // before it (once, then the replay; ticket 136), and a label planned in the narrower box would be centred on the box the grid then widens.
    replayRegions(model);
  }
  tap?.('grow', grew);
  const shift = closeCantonsAndSettle(model);
  if (shift > 0) replayRegions(model);
  tap?.('close-up', shift > 0);
  // A frame edge a foreign drop would run along is moved off it before anything is planned in the geometry (ticket 75).
  const kept = settleKeepOut(model);
  if (kept) replayRegions(model);
  tap?.('keep-out', kept);
  return shift;
}

/** What the step over a chord judges a move by: the replays and a round of `settleRound`, which is what the next round does. */
export function trialSettle(probe: LayoutModel): void { replayRegions(probe); settleRound(probe); }

/**
 * Run the 7f producer on the transaction's draft. The draft already stands on the stage before `bands` and has passed the callback checks;
 * the caller validates and freezes it after this returns.
 */
export function placementAttempt(draft: LayoutModel, options: AttemptOptions = {}): void {
  attemptCounters.attempts++; attemptCounters.in7f++;
  try { attemptBody(draft, options); } finally { attemptCounters.in7f--; }
}

function attemptBody(draft: LayoutModel, options: AttemptOptions): void {
  const { abortAt, trace } = options;
  const note = (pass: string, verdict: string): void => { if (trace) trace({ pass, revision: revisionOf(draft), verdict }); };
  // The ledger (architecture ticket 13, phase 1): what each step loses and gains, read only when a test or the trace asks for it.
  const ledger = ledgerOn(trace !== undefined), entry = startAttemptEntry();
  let seen: LedgerSnapshot | undefined = ledger ? ledgerSnapshot(draft) : undefined;
  const account = (pass: string): void => {
    if (seen === undefined) return;
    const now = ledgerSnapshot(draft);
    note(`ledger:${pass}`, countStep(seen, now, entry));
    seen = now;
  };
  // 7f reserves two things. A tier gap grows to the rows the plan must seat in it
  // (ADR-0015 rule 1) before any label is placed, because the growth moves whole bands down and
  // a label placed first would stay behind. The replay then rebuilds every claim the movement
  // touched, exactly as a reservation change does anywhere else in 7f.
  // The last confirmation of a chord was the end of 7e: from here it is a wall (ticket 34).
  abortAt?.();
  freezeChords(draft);
  note('freeze-chords', 'done');
  produceGroupLabelBands(draft);
  note('group-label-bands', 'done');
  account('freeze');
  abortAt?.();
  // The cantons close up when a round's close-up has nothing to move. The step over a chord (ticket 77) has its own convergence: a round
  // that moved something runs one more, so the growth and the close-up are measured on the geometry that stands, and the last round runs
  // no step, since its move could not be measured again. A mover moves in one round only, so the rounds end.
  let closed = false, again = false;
  const movers = new Set<string>();
  for (let round = 0; round < CANTON_ROUNDS && (!closed || again); round++) {
    abortAt?.();
    // A creep under half a pixel, left by the centring replay, counts as settled; the replay still follows any move.
    const afterChords = again;
    const shift = settleRound(draft, (step, changed) => {
      if (step === 'grow' && changed && round > 0) attemptCounters.invalidations.gapRegrown++;
      account(`round-${round}:${step}`);
    });
    closed = shift < CANTON_CREEP;
    attemptCounters.rounds++; entry.rounds++;
    if (!closed) { attemptCounters.openRounds++; entry.openRounds++; if (afterChords) attemptCounters.invalidations.closeUpReopened++; }
    note(`round-${round}:settle`, closed ? 'closed' : 'open');
    // The growth and the close-up change the slope of a chord that spans a gap and the x of a column: a group with no links
    // steps out of a chord again, after the replays (ticket 76 review). Cheap and idempotent.
    const linkless = stepLinklessOutOfChords(draft);
    note(`round-${round}:linkless`, linkless ? 'moved' : 'unchanged');
    account(`round-${round}:linkless`);
    // A chord between two tiers keeps the tiers between it free of nodes. A move is judged on a copy that the replays and a round of
    // `settle` have run, which is what the next round does.
    const cleared = round < CANTON_ROUNDS - 1 && stepOverChords(draft, trialSettle, movers);
    note(`round-${round}:chords`, cleared ? 'moved' : 'unchanged');
    if (cleared) { attemptCounters.chordRoundsMoved++; entry.chordRoundsMoved++; }
    account(`round-${round}:chords`);
    if (linkless || cleared) replayRegions(draft);
    account(`round-${round}:replay`);
    again = cleared;
  }
  if (ledger) {
    const short = shortGaps(draft).length;
    attemptCounters.invalidations.shortGapsAfterRounds += short;
    note('ledger:short-gaps', String(short));
  }
  // The held-axis warnings say where a column stood when they were raised; the replays above move columns after that (a centring replay
  // that has budget again, ticket 75). A probe pass over a copy says what they say now. When it moves nothing its warnings replace ours,
  // which withdraws a warning for a column (or a canton member) that reaches its feed. When it would move a column, the model is left as it
  // is (a pull here is ticket 67's, which measured a worse layout) and the jog of each warning is read again on the geometry that stands.
  const probe = candidateCopy(draft), stood = JSON.stringify(Object.values(probe.groups).map(group => group.bounds));
  holdColumnAxes(probe, 0);
  if (JSON.stringify(Object.values(probe.groups).map(group => group.bounds)) === stood) {
    draft.diagnostics = [...draft.diagnostics.filter(item => item.code !== 'COLUMN_AXIS_HELD'), ...probe.diagnostics.filter(item => item.code === 'COLUMN_AXIS_HELD')];
    note('held-axes', 'replaced');
  } else {
    attemptCounters.invalidations.heldProbeMoved++;
    refreshHeldWarnings(draft);
    note('held-axes', 'refreshed');
  }
  if (!closed) attemptCounters.invalidations.cantonNonConvergence++;
  if (!closed && !draft.diagnostics.some(item => item.code === 'PLACEMENT_NON_CONVERGENCE' && item.message.startsWith('The cantons'))) draft.diagnostics.push({
    stage: 'placement', severity: 'warning', code: 'PLACEMENT_NON_CONVERGENCE',
    message: `The cantons did not settle a band gap apart in ${CANTON_ROUNDS} rounds of the close-up and the replay; final gates decide the retained geometry.`,
  });
  // 7c seats each transit feed's child under the corridor its link owns; where it could not, the
  // corridor follows the child (ticket 02). The move belongs to the transaction, not to the
  // callback, exactly as the growth above does. It runs last in 7f, after every centring replay,
  // because each replay reads lane x as that feed's authoritative x: a corridor moved before one
  // is a corridor the replay chases, and the child's node stretches after it. The move itself
  // moves no node, so the label bands 7f has just reserved keep their height and their clearance
  // as it leaves them — but a lane is an input to two of the plans inside those bands, those plans
  // are settled again below, and one of the two can move a node when it settles.
  abortAt?.();
  const heldLanes = clone(draft.lanes), followedLanes: LaneFollow[] = [];
  if (reseatLanes(draft, followedLanes)) {
    rebuildLaneExtents(draft);
    // Four things the move can spoil, and it is refused rather than allowed to. It may open an
    // alignment 7c could not reach, and the centring invariant would then read the published
    // placement as unfinished work. It also turns the run in the gap beside the corridor from a
    // column into a row, and the height rule has already measured that gap: a gap that cannot
    // seat the new row would owe room nothing reserves. And a corridor is an obstacle the link
    // label reservation measures against — it decides whether a labelled row link detours, and
    // whether the room it needs lies beyond a reserved lane — so a corridor that moves across one
    // of those runs leaves a label a run 7e and 7f already reserved and did not get (stress ticket
    // 18). That third one has to be refused rather than settled again: re-reserving moves nodes,
    // and by here the corridors are fixed. The first three are compared as sets, not as counts: a
    // move that trades one unverified alignment, one short gap or one short run for another is not
    // "no worse", it is a different diagram with the same tally.
    //
    // The settling below can move whole frames: where the grid widens a box beside rows that stood open, it packs them once (ticket 136), and a
    // corridor stands where the replay reads it, not where it stood before. So "the corridors are fixed" above holds for the move this transaction makes, not
    // for the trial that follows it, and the fourth criterion reads the settled model.
    //
    // The fourth reads what the move is *for*. A corridor moves to stand at its child's port and
    // buys that one alignment; the settling below can move a node under it — `replanGroupLabels`
    // falls back to the full producer, which reserves room and pushes the groups after it — and a
    // corridor whose child has moved out from under it is a move that bought nothing and left a
    // jog nothing reserved. The first three cannot see that: after the fallback,
    // `produceGroupLabelBands` has already driven `reserveLinkLabelRoom` to its fixed point, so
    // the room criterion is empty by construction on exactly the path that moves the node.
    //
    // All four are measured on the **settled** model, not on the one the move leaves behind. A
    // corridor is geometry two of 7f's own plans are derived from — `laneSidesHold` decides which
    // linked pair may share an x-extent, so a corridor that leaves a group's window releases a
    // merge the grid declined; and a lane rectangle is a forbidden range for a group label, so a
    // corridor that moves changes where the label may stand — and both are therefore settled again
    // against the corridors this move publishes, because `validateGroupLabelBands` re-derives both
    // and the published model has to be their fixed point (ADR-0015: a derived plan a later stage
    // re-derives may read only what is frozen when both readings happen). That settling is done on
    // a trial *before* the decision, because all four criteria read what it changes:
    // `straightCorridorClear` iterates the group boxes the grid widens and the labels the replan
    // places, and on `a-corridor-moves-after-the-grid-settles` the grid really does widen a box by
    // 29.03 px here. The accepted model is the trial itself, so nothing is re-derived twice.
    const settled = candidateCopy(draft);
    replayGridAndLabels(settled);
    const afterRoom: LinkLabelShortfall[] = [], heldRoom: LinkLabelShortfall[] = [];
    reserveLinkLabelRoom(candidateCopy(settled), afterRoom);
    const after = { centring: centreViolations(settled), gaps: shortGaps(settled) };
    draft.lanes = heldLanes; rebuildLaneExtents(draft);
    reserveLinkLabelRoom(candidateCopy(draft), heldRoom);
    const held = { centring: centreViolations(draft), gaps: shortGaps(draft) };
    if (noNewItems(after.centring, held.centring) && noNewItems(after.gaps, held.gaps)
      && noNewItems(afterRoom.map(item => item.link), heldRoom.map(item => item.link))
      && lanesHoldTheirChild(settled, followedLanes) && blockedChords(settled).length === 0) {
      // Adopt the trial whole: `draft` is the object this transaction validates and returns, so it
      // takes the settled state rather than repeating the two producers on itself.
      Object.assign(draft, settled);
      attemptCounters.reseat.adopted++;
      note('reseat-lanes', 'adopted');
    } else {
      draft.diagnostics = draft.diagnostics.filter(item => item.code !== 'LANE_FOLLOWS_ITS_CHILD');
      attemptCounters.reseat.refused++;
      note('reseat-lanes', 'refused');
    }
  } else { attemptCounters.reseat.none++; note('reseat-lanes', 'none'); }
  // A move 7f cannot refuse (a title band's room, a tier gap's rows) may still leave a body on a held chord.
  // The chord is kept, its link is named, and the final gates judge it; it never falls back (ticket 34).
  for (const id of blockedChords(draft)) {
    draft.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'STRAIGHT_LINK_BLOCKED',
      message: `A body stands on the straight link ${id} that 7f could not move.`, owners: [{ kind: 'link', id }] });
  }
  // The side lanes' findings are read once, after the 7f settle loop, on the final geometry (side-faces.md, Sections 10 and 11).
  draft.diagnostics = draft.diagnostics.filter(item => !['SIDE_SHAPE_LOST', 'SIDE_LANE_INSIDE_FRAME', 'SIDE_LANE_NOT_OUTERMOST'].includes(item.code));
  draft.diagnostics.push(...sideLaneFindings(draft));
  // 7f may turn a held cross-frame chord shallow (a title widening pushes a column). The move is not refused, so the chord that now leaves its
  // frame by a side edge, or inside the 10 px corner margin, is named (reason `edge`); the gates judge it.
  for (const id of edgeLeavers(draft)) {
    draft.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'STRAIGHT_LINK_EDGE',
      message: `The straight link ${id} leaves its frame by a side edge or inside the corner margin after 7f (edge).`, owners: [{ kind: 'link', id }] });
  }
  note('diagnostics', 'done');
}
