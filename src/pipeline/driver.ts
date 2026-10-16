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
import { course, fan, overlay, side, span, turn } from './rounds.js';
import type { State } from './state.js';

/** The rounds in the order of the pipeline. A group holds the rounds that compete for the same starts: the fan, the span, the side and course, the turn and overlay. */
const PLAN: readonly (readonly AnyRound[])[] = [[fan], [span], [side, course], [turn, overlay]];
const ROUNDS = PLAN.flat();
/** The starts a round may still take: the command's budget less the starts spent, or the floor the round has of its own. */
const tokens = (env: Env, round: AnyRound): number => Math.max(env.maxReruns, round.budget.floor) - env.reruns;
const tied = (a: readonly number[], b: readonly number[]): boolean => !beats(a, b) && !beats(b, a);

/** How many of the rounds that `group` protects have an offer waiting for a start. */
async function reservedFor(env: Env, s: State, group: readonly AnyRound[]): Promise<number> {
  const ids = new Set(group.flatMap(round => round.budget.protects));
  let count = 0;
  for (const round of ROUNDS) if (ids.has(round.id) && round.enabled(env) && await round.live?.(env, s) === true) count++;
  return count;
}

/** The kept 7e result gets its 7f run: the baseline every offer is measured on, and its routed result. */
async function baseline(env: Env, s: State): Promise<void> {
  const banded = await env.bands(s.kept7e);
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
    const refusal = await trial(env, s, round, offer, reserved);
    if (refusal === undefined ? !round.budget.again : !round.budget.retries.includes(refusal.at)) return;
    if (visits + 1 >= round.budget.visits) return;
    offer = await round.measure(env, s);
    if (offer !== undefined && tokens(env, round) - reserved < 1) { round.skip(env, s, offer, env.maxReruns - env.reruns); return; }
  }
}

export async function drive(env: Env, s: State): Promise<void> {
  for (const [index, group] of PLAN.entries()) {
    if (index === 1) await baseline(env, s);
    let pending = group.filter(round => round.enabled(env));
    while (pending.length > 0) {
      const offers: [AnyRound, unknown][] = [];
      for (const round of pending) { const offer = await round.measure(env, s); if (offer !== undefined) offers.push([round, offer]); }
      if (offers.length === 0) break;
      const reserved = await reservedFor(env, s, offers.map(([round]) => round));
      const room = tokens(env, offers[0]![0]) - reserved, left = env.maxReruns - env.reruns, scarce = room < offers.length;
      // Scarce starts: the round whose offer promises the most keeps them; the others are skipped before it runs. A round that is not first has to beat the best so far.
      const gain = ([round, offer]: [AnyRound, unknown]): readonly number[] => round.gain(env, s, offer);
      const winner = !scarce ? 0 : room < 1 ? -1 : offers.reduce((best, item, i) => beats(gain(item), gain(offers[best]!)) || (tied(gain(item), gain(offers[best]!)) && item[0].budget.tie > offers[best]![0].budget.tie) ? i : best, 0);
      for (const [i, [round, offer]] of offers.entries()) if (scarce && i !== winner) round.skip(env, s, offer, left);
      if (winner < 0) break;
      await visit(env, s, offers[winner]![0], offers[winner]![1], reserved);
      const ran = offers[0]![0];
      pending = scarce ? [] : pending.filter(round => round !== ran && (group.indexOf(round) > group.indexOf(ran) || round.budget.reopens));
    }
  }
}
