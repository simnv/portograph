/**
 * The driver (architecture 2, ticket 04): one loop over the rounds, one admission rule, one explicit stack for the trials in flight. Each round is a descriptor (`rounds.ts`); the
 * driver decides which of them gets one of the command's placement starts, and `open` and `close` (`round.ts`) run the trial. A start is spent when a placement starts and is never
 * given back.
 *
 * Admission: a group of rounds that follow each other in the pipeline competes for the starts left. A round first leaves one start to each live offer of the rounds it protects
 * (span: course, side, turn; course and side: turn). If the starts left cover every live round of the group, they run in order. If they cover one, the round whose offer promises
 * the most takes it (a tie goes to the round with the higher declared tie), and the others are skipped. Every decision is made again after a trial, on the baseline it kept.
 */
import { beats } from '../layout/course-measure.js';
import type { Env } from './env.js';
import { FAN_ROUNDS } from './limits.js';
import { close, open, type AnyRound, type Opened, type Refusal } from './round.js';
import { course, fan, farEnd, overlay, side, span, turn } from './rounds.js';
import type { State } from './state.js';
import { crowdedHeldChords } from '../layout/direct-families.js';
import { refuseChordEntries, reserve as addReservations } from '../layout/reservations.js';
import { score } from '../score/index.js';
import { restoreLayoutModel } from '../layout/mutation.js';
import type { Diagnostic, LayoutModel } from '../model/index.js';
import { bandsWithoutWithdrawnSeats } from './seat-retry.js';

/** The rounds in the order of the pipeline. A group holds the rounds that compete for the same starts: the fan, the span, the side and course, the turn and overlay, and last the far-end round, which reads the settled result of all of them. */
const PLAN: readonly (readonly AnyRound[])[] = [[fan], [span], [side, course], [turn, overlay], [farEnd]];
/** The starts a round may still take: the command's budget less the starts spent, or the floor the round has of its own. */
const tokens = (env: Env, round: AnyRound): number => round.budget.own === true ? (env.options.testFarEndRuns ?? round.budget.floor) - env.farEndRuns : Math.max(env.maxReruns, round.budget.floor) - env.reruns;
const tied = (a: readonly number[], b: readonly number[]): boolean => !beats(a, b) && !beats(b, a);

/**
 * The admission rule for one group: which offer takes the starts that `room` leaves. All of them when they all fit (the first is returned and the rest follow), none when `room` is
 * under one, else the one that promises the most; a tie goes to the higher declared tie, and the first of equals stays.
 */
export function chooseStart(room: number, offers: readonly { gain: readonly number[]; tie: number }[]): number {
  if (room >= offers.length) return 0;
  if (room < 1) return -1;
  return offers.reduce((best, item, i) => beats(item.gain, offers[best]!.gain) || (tied(item.gain, offers[best]!.gain) && item.tie > offers[best]!.tie) ? i : best, 0);
}

/** How many of the rounds that `group` protects have an offer waiting for a start. */
export async function reservedFor(env: Env, s: State, group: readonly AnyRound[], rounds: readonly AnyRound[]): Promise<number> {
  const ids = new Set(group.flatMap(round => round.budget.protects));
  let count = 0;
  for (const round of rounds) if (ids.has(round.id) && round.enabled(env) && await round.live?.(env, s) === true) count++;
  return count;
}

/**
 * The kept 7e result gets its 7f run: the baseline every offer is measured on, and its routed result. A seat set that 7f withdraws (dense-16x9
 * ticket 36, ruling B) leaves room for a set that no longer stands: the command places the kept ledger once more with that row declined and
 * bands it again (`bandsWithoutWithdrawnSeats`).
 */
async function baseline(env: Env, s: State): Promise<void> {
  const { placed, banded } = await bandsWithoutWithdrawnSeats(env, s.kept, s.kept7e, false, s.sideNotes);
  s.kept7e = placed;
  s.base = banded.model; s.baseMoved = banded.moved; s.baseUnmoved = banded.unmoved;
  if (env.options.testCourses === undefined) s.routedBase = await env.route(s.base);
}

/** One trial and the trials inside it, on an explicit stack. A child round (the span's fans) works on its parent's tentative state and inherits its reservation. */
async function trial(env: Env, s: State, root: AnyRound, offer: unknown, reserved: number): Promise<Refusal | undefined> {
  interface Frame { round: AnyRound; offer: unknown; view: State; opened: Opened; kids: number }
  const stack: Frame[] = [];
  const push = async (view: State, round: AnyRound, o: unknown): Promise<Refusal | undefined> => {
    const opened = await open(env, view, round, o);
    if ('at' in opened) return opened;
    stack.push({ round, offer: o, opened, kids: 0, view: round.children.length === 0 ? view : { ...view, kept7e: opened.trial7e, kept: opened.ledger, fallbackFrom: view.kept7e } });
    return undefined;
  };
  let refusal = await push(s, root, offer);
  while (refusal === undefined && stack.length > 0) {
    const frame = stack.at(-1)!, child = frame.round.children[0];
    if (child !== undefined && frame.kids < FAN_ROUNDS && tokens(env, child) - reserved >= 1) {
      const childOffer = await child.measure(env, frame.view);
      if (childOffer !== undefined) {
        frame.kids++;
        refusal = await push(frame.view, child, childOffer);
        if (refusal !== undefined) frame.round.refuse(env, s, frame.offer, refusal);
        continue;
      }
    }
    stack.pop();
    const placed = frame.round.children.length === 0 ? frame.opened : { ledger: frame.view.kept, trial7e: frame.view.kept7e };
    const done = await close(env, frame.round.children.length === 0 ? frame.view : s, frame.round, frame.offer, placed);
    const parent = stack.at(-1);
    // A child that the ledger refuses at 7e ends the parent's fans only; the parent goes on with the placement it has.
    if (parent === undefined) refusal = done;
    else if (done !== undefined) parent.kids = FAN_ROUNDS;
  }
  return refusal;
}

/** The visits of one round: it runs a trial on its first offer, and may measure again and try once more when its budget says so and a start is left. */
async function visit(env: Env, s: State, round: AnyRound, first: unknown, reserved: number): Promise<void> {
  for (let visits = 0, offer = first; offer !== undefined && visits < round.budget.visits; visits++) {
    const rebased = s.rebased ?? 0;
    const refusal = await trial(env, s, round, offer, reserved);
    // A baseline placed again without a declined stagger is no trial of the round: its visit is given back (bounded by the rows, `keptStaggers`).
    if ((s.rebased ?? 0) > rebased) visits--;
    if (refusal === undefined ? !round.budget.again : !round.budget.retries.includes(refusal.at)) return;
    if (visits + 1 >= round.budget.visits) return;
    offer = await round.measure(env, s);
    if (offer !== undefined && tokens(env, round) - reserved < 1) { round.skip(env, s, offer, env.maxReruns - env.reruns); return; }
  }
}

export async function drive(env: Env, s: State, plan: readonly (readonly AnyRound[])[] = PLAN): Promise<void> {
  const rounds = plan.flat();
  for (const [index, group] of plan.entries()) {
    if (index === 1) await baseline(env, s);
    // A round is measured again after a trial only if it had an offer before, or declares that a sibling's trial may give it one (`reopens`). A skipped sibling is not dropped:
    // it is measured again and gets a start if the kept trial left one (the turn offer gone), and is skipped when it is found without one.
    const offered = new Set<AnyRound>();
    let pending = group.filter(round => round.enabled(env));
    while (pending.length > 0) {
      const offers: [AnyRound, unknown][] = [];
      for (const round of pending) { const offer = await round.measure(env, s); if (offer !== undefined) { offers.push([round, offer]); offered.add(round); } }
      if (offers.length === 0) break;
      const reserved = await reservedFor(env, s, offers.map(([round]) => round), rounds);
      const room = Math.max(...offers.map(([round]) => tokens(env, round))) - reserved, left = env.maxReruns - env.reruns;
      const winner = chooseStart(room, offers.map(([round, offer]) => ({ gain: round.gain(env, s, offer), tie: round.budget.tie })));
      if (winner < 0) { for (const [round, offer] of offers) round.skip(env, s, offer, left); break; }
      const [ran, offer] = offers[winner]!;
      await visit(env, s, ran, offer, reserved);
      pending = pending.filter(round => round !== ran && (offered.has(round) || round.budget.reopens));
    }
  }
}

/** The error-gate findings of a routed model, one key per violation (gate, code and elements). */
function errorFindings(model: LayoutModel): Set<string> {
  const keys = new Set<string>();
  for (const [gate, result] of Object.entries(score(model).snapshot.gates)) {
    if (result.severity !== 'error') continue;
    for (const item of result.violations) keys.add(`${gate} ${item.code} ${[...(item.elements ?? [])].join(',')}`);
  }
  return keys;
}

/**
 * A chord is refused before a gate finding is published (dense-16x9 ticket 14, slice 3; coordinator ruling for ticket 04 slice 2). After the last
 * round has settled, the state to publish is read once: every held chord that would stand under the G6 clearance (`crowdedHeldChords`) is refused,
 * all of them in this one read. Since ticket 28 that covers the direct, fan and solid-block members that the 7f retry gave up on: this step is the
 * last resort after that retry. It runs after `drive`, so no round (the fan round included) reads its result, and nothing runs it again: no loop. The refusal is a reservation (`refusedChord`, one
 * entry per chord) on the ledger of the kept 7e model, and placement replays once from it; 7f consumes the entries (R1). The replay is kept only when its routed result has no
 * error-gate finding that the state before it lacks; otherwise that state stays and `HELD_CHORD_CROWDED` names the chords. One pass at most
 * (R4): the replay is not read again. The rounds read the unrefused baselines, so a crowded baseline that a round repairs stays theirs.
 */
export async function refuseCrowdedChords(env: Env, s: State): Promise<void> {
  const crowded = crowdedHeldChords(s.base);
  if (!crowded.length) return;
  const before = s.routedFinal ?? s.routedBase ?? await env.route(s.base);
  const entries = refuseChordEntries(crowded, env.placements);
  const kept7e = restoreLayoutModel(JSON.stringify({ ...s.kept7e, reservations: addReservations(s.kept7e.reservations ?? [], entries) }));
  // The replay is a placement the command may keep (dense-16x9 ticket 36, review 1, finding 4): a seat set its 7f withdraws is declined and the
  // replay placed once more from its ledger (`bandsWithoutWithdrawnSeats`), before the gates judge it. A replay the gates discard gives back the
  // declines it added, and its notes are not published: the command does not act on a discarded placement's withdrawal.
  const declined = env.seatSetDeclined, ledger = addReservations(s.kept, entries), notes: Diagnostic[] = [];
  const { placed, banded } = await bandsWithoutWithdrawnSeats(env, ledger, kept7e, false, notes);
  const routed = await env.route(banded.model);
  const was = errorFindings(before);
  if ([...errorFindings(routed)].some(key => !was.has(key))) {
    if (declined === undefined) delete env.seatSetDeclined; else env.seatSetDeclined = declined;
    // The kept state is a protected model: the warning joins the notes that stage 9 publishes.
    s.sideNotes.push({ stage: 'placement', severity: 'warning', code: 'HELD_CHORD_CROWDED', owners: crowded.map(id => ({ kind: 'link' as const, id })),
      message: `The held ${crowded.length === 1 ? 'chord' : 'chords'} ${crowded.join(', ')} ${crowded.length === 1 ? 'stands' : 'stand'} under the clearance of a planned part; the replay without ${crowded.length === 1 ? 'it' : 'them'} adds a gate finding, so ${crowded.length === 1 ? 'it stays' : 'they stay'} straight and the gates judge.` });
    return;
  }
  s.kept7e = placed; s.kept = ledger; s.base = banded.model; s.baseMoved = banded.moved; s.baseUnmoved = banded.unmoved;
  s.routedFinal = routed; s.sideNotes.push(...notes);
}
