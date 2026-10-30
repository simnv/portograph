import type { Diagnostic, LayoutModel } from '../model/layout.js';
import { blockedChords, edgeLeavers, freezeChords } from './frame-paths.js';
import { crowdedDirectMembers, crowdedFanMembers, DIRECT_RETRIES, planDirectFamilies } from './direct-families.js';
import { refuseFanMembers } from './fan-admission.js';
import { freezeFanKeepers } from './bundle-junctions.js';
import { seatLaneSources } from './parent-stand.js';
import { centreContext, refreshWindowDeclines } from './centre.js';
import { type LaneFollow, sideLaneFindings, spanLaneFindings, rebuildLaneExtents, reseatLanes } from './lanes.js';
import { stepLinklessOutOfChords } from './overlay-place.js';
import { type AdoptedCopy, stepOverChords } from './chord-clear.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { alignLinkedGroupGridAndPack, closeCantonsAndSettle, settleKeepOut, produceGroupLabelBands, replanGroupLabels, labelBorders, reserveLinkLabelRoom, roomHolds, roomLikelyHolds } from './bands.js';
import { nestOverlayPorts } from './overlay-nest.js';
import { recordLabelYields } from './link-labels.js';
import { holdColumnAxes, refreshHeldWarnings } from './columns.js';
import { growTierGaps } from './gap-room.js';
import { holds } from './reservation-checks.js';
import { candidateCopy, chooseReseat, roomShort, shortGaps } from './decide.js';
import { attemptCounters, lastAttempt } from './attempt-counters.js';
import { attemptTimings, timed } from './attempt-timings.js';
import { countStep, ledgerOn, ledgerSnapshot, startAttemptEntry, type LedgerSnapshot } from './attempt-ledger.js';

/**
 * The stage-7f placement attempt: the producer of the `bands` rule (ADR-0010, ADR-0015). `withLayoutMutation` invokes it on its own draft,
 * after it has checked that the bands callback authored no placement; nothing else calls it, and it has no unchecked draft API of its own.
 * The transaction validates and freezes what it leaves. The order of the passes, each budget and its reset point, every tolerance, warning
 * and comparison are those 7f has always had (ticket 02 of the architecture roadmap moved them here and changed none).
 *
 * The passes, in order, on the draft:
 *   1. `freezeChords`, then `produceGroupLabelBands`: the last confirmation of a chord becomes a wall, then the reservation of the label bands.
 *   2. Up to `CANTON_ROUNDS` rounds of `settleRound` (the tier-gap growth, the link label room again, the close-up, the keep-out), `stepLinklessOutOfChords` and the step over a chord (`stepOverChords`, which judges
 *      each move on a copy that `trialSettle` has run). The choices of the linkless step, the chord step and the lane reseat are all made by the
 *      decision loop of decide.ts, each judged by the profile `judges` names for its kind; a round that moved anything is followed by `replayRegions`, or, when the step kept
 *      a move, by taking the settled copy of the last kept move (the replay and the next round's settling are then done).
 *   3. The held-axis probe (`holdColumnAxes` on a copy), and the non-convergence warning for the cantons.
 *   4. `reseatLanes`, adopted only when its settled trial is no worse in the named respects (`chooseReseat`, decide.ts).
 *   5. The diagnostics read once on the final geometry: blocked chords, side lanes, chords that leave a frame by a side edge.
 */

/** Rounds of the tier-gap growth, the label room and the canton close-up in 7f (ranked-groups ticket 65). */
const CANTON_ROUNDS = 4;
/** The move of a close-up round, in px, under which the cantons stand a band gap apart for every purpose (ranked-groups ticket 65). */
const CANTON_CREEP = 0.5;
/** Reservations of the label room in one settle (architecture-2 ticket 27; R4: a count). Past it, a room still short is given up (`settleRoom`). */
const LABEL_ROOM_PASSES = 4;
/** The warning of a settle that gave a label room up at `LABEL_ROOM_PASSES` (`labelRoomUnsettled`). */
const LABEL_ROOM_UNSETTLED = 'LINK_LABEL_ROOM_UNSETTLED';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** One line of the opt-in trace: a pass, a short hash of the model after it, and what the pass decided. */
export interface AttemptTraceEvent { pass: string; revision: string; verdict: string }
export interface AttemptOptions {
  /** A check of the command deadline: it throws between the passes of 7f and never changes the layout (ticket 141). */
  abortAt?: (() => void) | undefined;
  /** Opt-in per-pass trace. Off when absent; the events are handed to the caller and never written into the layout. */
  trace?: ((event: AttemptTraceEvent) => void) | undefined;
  /** False runs 7f without its optional moves (the linkless step and the chord step): the unmoved baseline of the side round (architecture ticket 15, phase 3b). Default true. */
  moves?: boolean | undefined;
}
/** An FNV-1a hash of the model text, eight hex digits. Read only when a trace was asked for. */
function revisionOf(model: LayoutModel): string {
  const text = JSON.stringify(model);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

/** The grid and the labels, settled again: the part of a replay that does not rebuild the regions. */
export function replayGridAndLabels(model: LayoutModel): void {
  timed('grid-pack', () => alignLinkedGroupGridAndPack(model));
  timed('labels', () => replanGroupLabels(model));
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

/** The codes a replay reads from the list or writes to it: a diagnostic of one of these, added after the copy was taken, could change what the replay does. */
const REPLAY_CODES = /^(MESH_BUS|GROUP_GRID|GROUP_LABEL|COLUMN_AXIS|PLACEMENT_|ROUTED_CHORD_TITLE|LINK_LABEL)/;

/**
 * Take a settled copy as the state of `model`, which the caller still holds, when that is exactly what replaying `model` would give; otherwise
 * leave `model` alone and return false (the caller replays). The copy was taken at diagnostic count `baseDiagnostics`; `original` is its list then.
 * A replay filters the list and appends to it, so the copy's list is the authority: an entry of it that is in `original` survived, any other is new.
 * What `model` gained since the copy (`added`: the notes of the judge, the warnings of the gap growth) is where the replay would have found it:
 * after the survivors, before the new entries. That holds when nothing of `original` was withdrawn (a withdrawn warning could have taken an added
 * one of its code with it, and a re-raised one is placed by the replay), the new entries come last, and no added entry has a code the replay reads
 * or writes. Then the result is the replay's, in its order. With nothing added the copy's list is the replay's result whatever the replay withdrew.
 * Keys the copy no longer has (`delete model.busBands`) are deleted from `model`.
 */
export function adoptSettled(model: LayoutModel, copy: LayoutModel, baseDiagnostics: number, original: ReadonlySet<Diagnostic>): boolean {
  // The replay inside a settled copy may move a group by a required move, which keeps its exception. A copy that loses a requested promise (a lane owner's far anchor on the lane, a course) is not adopted.
  if (holds(model.reservations ?? [], copy, entry => entry.kind === 'laneOwner' || entry.kind === 'course').length > 0) return false;
  const added = model.diagnostics.slice(baseDiagnostics);
  const survivors = copy.diagnostics.filter(item => original.has(item)), fresh = copy.diagnostics.filter(item => !original.has(item));
  if (added.length) {
    const firstFresh = fresh.length ? copy.diagnostics.indexOf(fresh[0]!) : copy.diagnostics.length;
    const held = new Set(copy.diagnostics.map(item => item.code));
    const safe = survivors.length === original.size && survivors.every((_, i) => copy.diagnostics[i] === survivors[i]) && firstFresh >= survivors.length
      && added.every(item => !REPLAY_CODES.test(item.code) && !held.has(item.code));
    if (!safe) return false;
  }
  const diagnostics = [...survivors, ...added, ...fresh];
  for (const key of Object.keys(model)) if (!(key in copy)) delete (model as unknown as Record<string, unknown>)[key];
  Object.assign(model, copy);
  model.diagnostics = diagnostics;
  return true;
}

/** The close-up of the cantons and the keep-out of a foreign drop's clearance, each followed by the replay when it moved. Returns the close-up's shift. */
function closeUpAndKeepOut(model: LayoutModel, tap?: (step: SettleStep, changed: boolean) => void): number {
  const shift = timed('close-cantons', () => closeCantonsAndSettle(model));
  if (shift > 0) replayRegions(model);
  tap?.('close-up', shift > 0);
  // A frame edge a foreign drop would run along is moved off it before anything is planned in the geometry (ticket 75).
  const kept = timed('keep-out', () => settleKeepOut(model));
  if (kept) replayRegions(model);
  tap?.('keep-out', kept);
  return shift;
}

/**
 * The label room of every described link (architecture-2 ticket 27), as the last step of a settle: `reserveLinkLabelRoom` on the geometry as it
 * stands; when it reserved, the replay, the close-up and the keep-out, and the room again. The producer reserved the room once; a later 7f move
 * (a chord step, a rank move, the close-up, the keep-out, the linkless step) moves a line end in x, the line turns, and its window shrinks.
 *
 * Convergence: the loop ends when a pass reserves nothing, so nothing moves after the last reading of the room. No measure proves that it ends:
 * the reservation only grows the room, but the replay and the close-up move x and can turn a line again. `passes` bounds it (R4): after that many
 * reservations the rooms a reservation would still grow are given up, not reserved (`labelRoomUnsettled`, named `LINK_LABEL_ROOM_UNSETTLED`; R6):
 * the label placement decides them: with no window a label may lie across a border (`LINK_LABEL_ON_BORDER`), and stage 9's collision test
 * refuses a place on a link. No gate judges such a label (G3 leaves out overlay labels). Returns the shift of the close-ups it ran.
 */
export function settleRoom(model: LayoutModel, tap?: (step: SettleStep, changed: boolean) => void, passes = LABEL_ROOM_PASSES): number {
  let shift = 0;
  for (let pass = 0; ; pass++) {
    if (pass >= passes) {
      giveUpRoom(model, passes);
      return shift;
    }
    const reserved = timed('label-room', () => reserveLinkLabelRoom(model));
    if (reserved) replayRegions(model);
    tap?.('room', reserved);
    if (!reserved) return shift;
    shift += closeUpAndKeepOut(model, tap);
  }
}

/**
 * The rooms a reservation would still grow at the pass bound, given up: their links join `labelRoomUnsettled` in link order, and a warning names
 * them. Their labels may then lie across a border, with `LINK_LABEL_ON_BORDER` from stage 9.
 */
function giveUpRoom(model: LayoutModel, passes: number): void {
  const short = roomShort(model);
  if (!short.size) return;
  const order = new Map(model.links.map((link, at) => [link.id, at]));
  const byOrder = (a: string, b: string): number => order.get(a)! - order.get(b)!;
  model.labelRoomUnsettled = [...new Set([...(model.labelRoomUnsettled ?? []), ...short])].sort(byOrder);
  const fresh = [...short].sort(byOrder);
  model.diagnostics.push({ stage: 'placement', severity: 'warning', code: LABEL_ROOM_UNSETTLED, owners: fresh.map(id => ({ kind: 'link' as const, id })),
    message: `The label room of ${fresh.join(', ')} was still short after ${passes} passes of the reservation, the replay and the close-up; it is given up, and the label placement decides; with no window the label may lie across a border.` });
}

/**
 * The growth of the tier gaps is measured on the columns as they stand, and the close-up of the cantons (ranked-groups ticket 65)
 * moves them in x after centring widened one in place: so the growth is measured again after every move, and the rounds end when
 * the close-up has nothing to move. A round that moves groups replays the region producers, and the grid and the labels after it.
 * One round of the growth, the close-up, the keep-out and the label room (last, `settleRoom`), on any model: the loop runs it on the draft, and the
 * step over a chord (ticket 77) runs it on a copy to see what a move settles into. It returns the shift of the close-ups.
 */
export function settleRound(model: LayoutModel, tap?: (step: SettleStep, changed: boolean) => void, passes = LABEL_ROOM_PASSES): number {
  attemptCounters.settleCalls++;
  const trial: { trial?: LayoutModel; baseDiagnostics?: number; original?: ReadonlySet<Diagnostic> } = {};
  const grew = timed('grow-tier-gaps', () => growTierGaps(model, trial));
  // The growth stopped on "no change": its last trial is the grown model after the replay below, so it is taken instead of replaying (ticket 13, phase 2).
  // `adoptSettled` declines when the diagnostics would differ from the replay's; the replay then runs.
  if (grew && !(trial.trial !== undefined && trial.original !== undefined && adoptSettled(model, trial.trial, trial.baseDiagnostics!, trial.original))) {
    // The replay refits every group box to its content, so a linked pair the first step gave one
    // x-extent (ADR-0012) holds two again and the published model would not be the grid's fixed
    // point — which is what `validateGroupLabelBands` demands. The grid is settled here, before
    // the labels are planned in these boxes, because it belongs to the replay and not to the
    // third step: it grows box extents onto edges that already exist, and moves a node only to pack beside rows that stood open
    // before it (once, then the replay; ticket 136), and a label planned in the narrower box would be centred on the box the grid then widens.
    replayRegions(model);
  }
  tap?.('grow', grew);
  const shift = closeUpAndKeepOut(model, tap);
  // The label room last (architecture-2 ticket 27): a chord trial runs this round on its copy, so the judges read, and the draft adopts, a copy
  // whose rooms hold; the draft rounds reserve on their own settled state the same way.
  return shift + settleRoom(model, tap, passes);
}

/** What the step over a chord judges a move by: the replays and a round of `settleRound`, which is what the next round does. */
export function trialSettle(probe: LayoutModel): SettleReading {
  return timed('trial-settle', () => {
    timed('replay-first', () => replayRegions(probe));
    const steps: SettleReading['steps'] = [];
    const shift = timed('settle-round', () => settleRound(probe, (step, changed) => { steps.push([step, changed]); }));
    return { shift, steps, roomSettled: true };
  });
}
/** The steps of a round of `settleRound`, in order. */
export type SettleStep = 'grow' | 'room' | 'close-up' | 'keep-out';
/**
 * What a round of `settleRound` found, with the steps it took in order: a copy that adopted it hands this on instead of settling again.
 * `roomSettled`: the round ended on the label room, which reserved nothing or was given up, and nothing moved after it (ticket 27); a judge
 * then reads the room of the copy from `labelRoomUnsettled` and reserves nothing again (`roomFindings`, decide.ts).
 */
export interface SettleReading { shift: number; steps: [SettleStep, boolean][]; roomSettled: true }

/**
 * Run the 7f producer on the transaction's draft. The draft already stands on the stage before `bands` and has passed the callback checks;
 * the caller validates and freezes it after this returns.
 */
export function placementAttempt(draft: LayoutModel, options: AttemptOptions = {}): void {
  attemptCounters.attempts++; attemptCounters.in7f++;
  try {
    // A direct member that 7f's later moves bring within the clearance of a fallback's planned part is not unfrozen: the attempt is run again
    // from its start with that member refused (`crowds`, architecture-2 ticket 22). The refusals only grow, so the retries end (R2, R4).
    const start = clone(draft), refused = new Set<string>();
    for (let retry = 0; ; retry++) {
      attemptBody(draft, options, refused);
      const crowded = crowdedDirectMembers(draft).filter(id => !refused.has(id));
      // A straight fan member is crowded the same way, and refused the same way (architecture-2 ticket 40): it falls back alone, as `crowds`.
      const fans = draft.fanAdmissions === undefined ? [] : crowdedFanMembers(draft).filter(id => !refused.has(id));
      if (!crowded.length && !fans.length) break;
      if (retry >= DIRECT_RETRIES) {
        if (crowded.length) draft.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'DIRECT_FAMILY_CROWDED', owners: crowded.map(id => ({ kind: 'link' as const, id })),
          message: `The direct ${crowded.length === 1 ? 'member' : 'members'} ${crowded.join(', ')} stand within the clearance of a planned part after ${DIRECT_RETRIES} retries of 7f; the gates judge.` });
        if (fans.length) draft.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'FAN_MEMBER_CROWDED', owners: fans.map(id => ({ kind: 'link' as const, id })),
          message: `The fan ${fans.length === 1 ? 'member' : 'members'} ${fans.join(', ')} stand within the clearance of a planned part after ${DIRECT_RETRIES} retries of 7f; the gates judge.` });
        break;
      }
      for (const id of fans) refused.add(id);
      for (const id of crowded) refused.add(id);
      for (const key of Object.keys(draft)) delete (draft as unknown as Record<string, unknown>)[key];
      Object.assign(draft, clone(start));
    }
  } finally { attemptCounters.in7f--; }
}

function attemptBody(draft: LayoutModel, options: AttemptOptions, refused: ReadonlySet<string> = new Set()): void {
  const { abortAt, trace } = options, moves = options.moves !== false;
  const note = (pass: string, verdict: string): void => { if (trace) trace({ pass, revision: revisionOf(draft), verdict }); };
  // The ledger (architecture ticket 13, phase 1): what each step loses and gains, read only when a test or the trace asks for it.
  const ledger = ledgerOn(trace !== undefined), entry = startAttemptEntry(ledger);
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
  // The fan members a retry refused fall back before anything else is decided on their legs (architecture-2 ticket 40).
  if (draft.fanFamilies !== undefined) refuseFanMembers(draft, refused);
  planDirectFamilies(draft, refused);
  note('direct-families', String(draft.directFamilies?.length ?? 0));
  freezeChords(draft, refused);
  note('freeze-chords', 'done');
  produceGroupLabelBands(draft);
  note('group-label-bands', 'done');
  account('freeze');
  abortAt?.();
  // The cantons close up when a round's close-up has nothing to move. The step over a chord (ticket 77) has its own convergence: a round
  // that moved something runs one more, so the growth and the close-up are measured on the geometry that stands, and the last round runs
  // no step, since its move could not be measured again. A mover moves in one round only, so the rounds end.
  lastAttempt.moved = false; lastAttempt.unmoved = undefined;
  let closed = false, again = false;
  const movers = new Set<string>();
  /** The settled copy of the last move of the chord step, once the draft has taken it: the next round reads its settling and does not settle again. */
  let taken: SettleReading | undefined;
  /** Whether the draft moved after the last label room of the rounds (the linkless step and its replay, ticket 27). */
  let unsettled = false;
  for (let round = 0; round < CANTON_ROUNDS && (!closed || again); round++) {
    abortAt?.();
    if (attemptTimings.on) attemptTimings.hooks.round?.(draft);
    // A creep under half a pixel, left by the centring replay, counts as settled; the replay still follows any move.
    const afterChords = again;
    const tapped = (step: SettleStep, changed: boolean): void => {
      if (step === 'grow' && changed && round > 0) attemptCounters.invalidations.gapRegrown++;
      account(`round-${round}:${step}`);
    };
    let shift: number;
    if (taken !== undefined) {
      // The draft stands on the settled copy that judged the last chord move; that copy has run this round already.
      for (const [step, changed] of taken.steps) tapped(step, changed);
      shift = taken.shift;
      taken = undefined;
    } else shift = settleRound(draft, tapped);
    if (attemptTimings.on) attemptTimings.hooks.base?.(draft);
    closed = shift < CANTON_CREEP;
    attemptCounters.rounds++; entry.rounds++;
    if (!closed) { attemptCounters.openRounds++; entry.openRounds++; if (afterChords) attemptCounters.invalidations.closeUpReopened++; }
    note(`round-${round}:settle`, closed ? 'closed' : 'open');
    // The growth and the close-up change the slope of a chord that spans a gap and the x of a column: a group with no links
    // steps out of a chord again, after the replays (ticket 76 review). Cheap and idempotent.
    const linkless = moves && stepLinklessOutOfChords(draft);
    if (linkless) lastAttempt.moved = true;
    note(`round-${round}:linkless`, linkless ? 'moved' : 'unchanged');
    account(`round-${round}:linkless`);
    // A chord between two tiers keeps the tiers between it free of nodes. A move is judged on a copy that the replays and a round of
    // `settle` have run, which is what the next round does.
    const kept: { adopted?: AdoptedCopy } = {};
    const cleared = moves && round < CANTON_ROUNDS - 1 && stepOverChords(draft, trialSettle, movers, kept);
    if (cleared) lastAttempt.moved = true;
    note(`round-${round}:chords`, cleared ? 'moved' : 'unchanged');
    if (cleared) { attemptCounters.chordRoundsMoved++; entry.chordRoundsMoved++; }
    account(`round-${round}:chords`);
    // The copy that judged the last kept move has the replay and the next round's settling done: the draft takes it (ticket 13, phase 2).
    if (cleared && kept.adopted !== undefined && adoptSettled(draft, kept.adopted.copy, kept.adopted.baseDiagnostics, kept.adopted.original)) {
      taken = kept.adopted.result as SettleReading;
      unsettled = false;
    } else {
      if (linkless || cleared) replayRegions(draft);
      unsettled = linkless || cleared;
    }
    account(`round-${round}:replay`);
    again = cleared;
  }
  // The linkless step of the last round and its replay move a line end after that round's label room: the room is the last step here too
  // (architecture-2 ticket 27). A close-up it runs that moves the cantons reopens them, and the warning below says so.
  if (unsettled) {
    const tail = settleRoom(draft, step => account(`tail:${step}`));
    if (tail >= CANTON_CREEP) closed = false;
    note('tail:room', 'settled');
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
  const seated = draft.anchorTier === undefined ? undefined : seatLaneSources(draft, centreContext(draft, draft.anchorTier).steps);
  if (reseatLanes(draft, followedLanes)) {
    seated?.reconcile();
    rebuildLaneExtents(draft);
    // Four things the move can spoil, and it is refused rather than allowed to. It may open an
    // alignment 7c could not reach, and the centring invariant would then read the published
    // placement as unfinished work. It also turns the run in the gap beside the corridor from a
    // column into a row, and the height rule has already measured that gap: a gap that cannot
    // seat the new row would owe room nothing reserves. And a corridor is an obstacle the link
    // label reservation measures against — it decides whether a labelled row link detours and
    // where the room it needs is inserted — so a corridor that moves across one
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
    // The candidate is derived once, on a copy that has the grid and the labels replayed, and judged there by `judges.laneReseat` (decide.ts, kind `lane-reseat`).
    if (chooseReseat(draft, heldLanes, followedLanes, replayGridAndLabels, seated?.undo)) {
      attemptCounters.reseat.adopted++;
      note('reseat-lanes', 'adopted');
    } else {
      seated?.undo();
      draft.diagnostics = draft.diagnostics.filter(item => item.code !== 'LANE_FOLLOWS_ITS_CHILD');
      attemptCounters.reseat.refused++;
      note('reseat-lanes', 'refused');
    }
  } else { seated?.undo(); attemptCounters.reseat.none++; note('reseat-lanes', 'none'); }
  seated?.settle(draft);
  // A perimeter lane's x is derived from the boxes over its span (ADR-0010, amendment of ticket 15, phase 4): the settling above can move a box after the last
  // replay, so the lane is read once more on the geometry that publishes.
  if (draft.lanes.some(lane => lane.kind === 'perimeter')) rebuildLaneExtents(draft);
  // The fan edge keepers (architecture-2 ticket 18) are taken on the boxes that publish: 7f centres and stretches frames, so the choice
  // is open until the last replay. From here the validator and a restore read the record, member and depth, and never choose again.
  freezeFanKeepers(draft);
  // The overlay ports of a face nest (ticket 23) on the geometry that publishes, after every placement move was judged: a trade moves
  // no box and no other port, and one that would need room 7f did not reserve is not made (`roomHolds`).
  nestOverlayPorts(draft, roomHolds, roomLikelyHolds);
  // A pair of labels on diagonal lines whose bands first meet on the geometry that publishes is decided here, once; a pair decided
  // earlier keeps its direction (`recordLabelYields`). Stage 9 and the validator read the record.
  recordLabelYields(draft, labelBorders(draft));
  // A move 7f cannot refuse (a title band's room, a tier gap's rows) may still leave a body on a held chord.
  // The chord is kept, its link is named, and the final gates judge it; it never falls back (ticket 34).
  for (const id of blockedChords(draft)) {
    draft.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'STRAIGHT_LINK_BLOCKED',
      message: `A body stands on the straight link ${id} that placement could not move.`, owners: [{ kind: 'link', id }] });
  }
  // The side lanes' findings are read once, after the 7f settle loop, on the final geometry (side-faces.md, Sections 10 and 11).
  draft.diagnostics = draft.diagnostics.filter(item => !['SIDE_SHAPE_LOST', 'SIDE_LANE_INSIDE_FRAME', 'SIDE_LANE_NOT_OUTERMOST'].includes(item.code));
  draft.diagnostics.push(...sideLaneFindings(draft));
  draft.diagnostics = draft.diagnostics.filter(item => item.code !== 'SPAN_CHORD_BLOCKED');
  draft.diagnostics.push(...spanLaneFindings(draft));
  // 7f may turn a held cross-frame chord shallow (a title widening pushes a column). The move is not refused, so the chord that now leaves its
  // frame by a side edge, or inside the 10 px corner margin, is named (reason `edge`); the gates judge it.
  for (const id of edgeLeavers(draft)) {
    draft.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'STRAIGHT_LINK_EDGE',
      message: `The straight link ${id} leaves its frame by a side edge or inside the corner margin after placement.`, owners: [{ kind: 'link', id }] });
  }
  // The window declines of 7c name the links still off their seat on the geometry that publishes: the close-up, the chord step and the replays of 7f
  // move groups after the last centring run (architecture-2 ticket 31).
  refreshWindowDeclines(draft);
  note('diagnostics', 'done');
}
