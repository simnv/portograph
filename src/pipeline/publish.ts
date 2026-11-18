/**
 * Stage 9: the model the command publishes. The kept baseline is routed once more when the setting asks, the notes of the kept rounds and the findings that a break of a kept
 * promise leaves are named, and the link labels are placed. It decides no layout.
 */
import type { Diagnostic, LayoutModel } from '../model/index.js';
import { linkLabels } from '../layout/link-labels.js';
import { declinedFanDiagnostics, measureFans } from '../layout/fan-spread.js';
import { chordClearances, closedChordPairs } from '../layout/frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from '../layout/row-paths.js';
import { sideHintDiagnostics } from '../layout/side-hints.js';
import { turnMissed } from '../layout/turn-order.js';
import { routedBends } from '../layout/side-judge.js';
import { declinedStaggersOf, farEndDecisionsOf, sideHintsOf, staggerDeclineSentence, withFarEndDecisions } from '../layout/reservations.js';
import { staleFarEndDecisions } from '../layout/far-end-faults.js';
import { routedLinksOf } from '../layout/far-end-order.js';
import { FAN_WRAP_DECLINED } from '../layout/stagger.js';
import { holdsRouted } from '../layout/reservation-checks.js';
import type { Env } from './env.js';
import { portName } from './rounds.js';
import type { State } from './state.js';
import type { SheetSize } from '../layout/flat-gap-choice.js';

/**
 * The routed model the command labels and publishes for the kept state, in the route mode publication uses (dense-16x9 ticket 42, review 1):
 * with `overlayOverBodies` the 7f model routed once more as the publication route, else the routed result the rounds kept. The one reader of that
 * route: `publish` labels it, and the final flat-gap choice compares sheets on it (`publishedSheet`). A route it has to make is kept on the
 * state for the model it routed (`State.published`), so publication does not route the same model twice.
 */
export async function publicationRoute(env: Env, s: State): Promise<LayoutModel> {
  if (s.published?.base === s.base) return s.published.routed;
  const routed = s.base.document.layout?.overlayOverBodies === true ? await env.route(s.base, undefined, true) : s.routedFinal ?? s.routedBase ?? await env.route(s.base);
  s.published = { base: s.base, routed };
  return routed;
}

/** The size of the sheet stage 9 publishes from a publication route (`publicationRoute`): the canvas with the link labels, the legend and the margin. */
export function publishedSheet(env: Env, routed: LayoutModel): SheetSize {
  const canvas = linkLabels(routed, [], env.groupLifts).canvas!;
  return { width: canvas.width, height: canvas.height };
}

/**
 * Stage 9 of the kept state. It reads the state and writes none of it, so the command can publish once more after the final flat-gap choice
 * (`chooseFlatGapsAgain`, dense-16x9 ticket 42).
 */
export async function publish(env: Env, s: State): Promise<LayoutModel> {
  const sideNotes = [...s.sideNotes];
  for (const [key, item] of s.promised) {
    const side = sideHintsOf(s.kept).get(key);
    if (side === undefined) continue;
    sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_TAKEN',
      message: `The port ${portName(key)} takes the side ${side}: the ${item.shape} shape of ${item.link} (${item.bends} bends).`, owners: [{ kind: 'link', id: item.link }] });
  }
  sideNotes.push(...s.keptNotes);
  // A stagger the acceptance gate or a later placement declined is declined in the ledger (dense-16x9 tickets 22 and 35): the note reads that
  // record, and only it (R1, R6).
  for (const [group, decline] of declinedStaggersOf(s.kept)) {
    sideNotes.push({ stage: 'placement', severity: 'info', code: FAN_WRAP_DECLINED, owners: [{ kind: 'group', id: group }],
      message: `The two lines of ${group} are declined: ${staggerDeclineSentence(decline)}.` });
  }
  // Read on the 7e model that publishes: the kept one, or the kept trial's.
  const declined = declinedFanDiagnostics(measureFans(s.kept7e).declined);
  const atFreeze = chordClearances(s.kept7e);
  // 7f moves columns in x after the chords are decided, and no rule bounds it: a pair it closes under the clearance is named here, with the
  // clearance it had at the freeze, so that a G6 failure can be traced to the move (ticket 89 review). Nothing is changed. The pair is read
  // as G6 reads it (`chordClearances`: `runClearance`, the sheaf zone excused) and named only when 7f closed it: under the clearance now and
  // nearer than at the freeze (dense-16x9 ticket 34).
  const lost: Diagnostic[] = [...sideHintDiagnostics(s.base)];
  for (const { pair, before, now } of closedChordPairs(atFreeze, chordClearances(s.base))) {
    lost.push({ stage: 'placement', severity: 'warning', code: 'CHORD_CLEARANCE_LOST',
      message: `Placement moved the straight links ${pair.replace('|', ' and ')} from ${before.toFixed(1)} px apart to ${now.toFixed(1)} px, under the ${STRAIGHT_PATH_CLEARANCE.path} px chord clearance.`,
      owners: pair.split('|').map(id => ({ kind: 'link' as const, id })) });
  }
  // With the setting on, the kept model is routed once more to publish: a judged route carries the ordinary overlay paths.
  const published = await publicationRoute(env, s);
  // A course that publishes more turns than its candidate promised is named; the promise is the polyline its own lane geometry reserved.
  for (const failure of holdsRouted(s.kept, published)) {
    lost.push({ stage: 'placement', severity: 'warning', code: 'COURSE_SHAPE_LOST', owners: [{ kind: 'link', id: failure.link! }],
      message: `The link ${failure.link} has ${failure.got === undefined ? 'no route' : `${failure.got} turns`} on its course, ${failure.max} were promised.` });
  }
  lost.push(...turnMissed(published));
  // A far-end decision that no longer holds on the published sheet buys nothing: it is not published, G5 judges its face again, and the decision is named
  // (R6, dense-16x9 ticket 49). Restore refuses a record that does not hold, so production publishes none.
  const kept = farEndDecisionsOf(s.kept), all = kept.length === 0 ? published : { ...published, reservations: withFarEndDecisions(published.reservations ?? [], kept) };
  const stale = staleFarEndDecisions(all, routedLinksOf(all)), decisions = kept.filter(entry => !stale.some(item => item.entry === entry));
  for (const { entry, why } of stale) {
    lost.push({ stage: 'placement', severity: 'warning', code: 'FAR_END_DECISION_STALE', owners: [{ kind: 'node', id: entry.payload.node }],
      message: `The far-end order of the ${entry.payload.side} face of ${entry.payload.node} was declined (${entry.payload.why}), but ${why}; the decision is not published, and G5 judges the face again.` });
  }
  // A hinted link of a kept trial has no more bends than on the baseline (the judgment tested it); this names a break of that rule.
  if (s.routedFinal !== undefined && s.routedBase !== undefined) {
    const before = routedBends(s.routedBase), after = routedBends(s.routedFinal);
    for (const [key, item] of s.promised) {
      if ((after.get(item.link) ?? Infinity) > (before.get(item.link) ?? Infinity)) lost.push({ stage: 'placement', severity: 'warning', code: 'SIDE_SHAPE_LOST',
        message: `The hinted link ${item.link} (port ${portName(key)}) has more bends than on the baseline (${before.get(item.link)}).`, owners: [{ kind: 'link', id: item.link }] });
    }
  }

  return env.timed('link-labels', () => env.step('link-labels', () => linkLabels(published, [...s.cuts, ...sideNotes, ...declined, ...lost], env.groupLifts, decisions)));
}
