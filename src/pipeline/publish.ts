/**
 * Stage 9: the model the command publishes. The kept baseline is routed once more when the setting asks, the notes of the kept rounds and the findings that a break of a kept
 * promise leaves are named, and the link labels are placed. It decides no layout.
 */
import type { Diagnostic, LayoutModel } from '../model/index.js';
import { linkLabels } from '../layout/link-labels.js';
import { declinedFanDiagnostics, measureFans } from '../layout/fan-spread.js';
import { chordClearances } from '../layout/frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from '../layout/row-paths.js';
import { sideHintDiagnostics } from '../layout/side-hints.js';
import { turnMissed } from '../layout/turn-order.js';
import { routedBends } from '../layout/side-judge.js';
import { PLACEMENT_EPS } from '../layout/tolerance.js';
import { sideHintsOf } from '../layout/reservations.js';
import { holdsRouted } from '../layout/reservation-checks.js';
import type { Env } from './env.js';
import { portName } from './rounds.js';
import type { State } from './state.js';

export async function publish(env: Env, s: State): Promise<LayoutModel> {
  for (const [key, item] of s.promised) {
    const side = sideHintsOf(s.kept).get(key);
    if (side === undefined) continue;
    s.sideNotes.push({ stage: 'placement', severity: 'info', code: 'SIDE_HINT_TAKEN',
      message: `The port ${portName(key)} takes the side ${side}: the ${item.shape} shape of ${item.link} (${item.bends} bends).`, owners: [{ kind: 'link', id: item.link }] });
  }
  s.sideNotes.push(...s.keptNotes);
  // Read on the 7e model that publishes: the kept one, or the kept trial's.
  const declined = declinedFanDiagnostics(measureFans(s.kept7e).declined);
  const atFreeze = chordClearances(s.kept7e);
  s.kept7e = s.base;
  // 7f moves columns in x after the chords are decided, and no rule bounds it: a pair it closes under the clearance is named here, with the
  // clearance it had at the freeze, so that a G6 failure can be traced to the move (ticket 89 review). Nothing is changed.
  const lost: Diagnostic[] = [...sideHintDiagnostics(s.kept7e)];
  for (const [pair, now] of chordClearances(s.kept7e)) {
    const before = atFreeze.get(pair);
    if (now < STRAIGHT_PATH_CLEARANCE.path - PLACEMENT_EPS && before !== undefined) {
      lost.push({ stage: 'placement', severity: 'warning', code: 'CHORD_CLEARANCE_LOST',
        message: `Placement moved the straight links ${pair.replace('|', ' and ')} from ${before.toFixed(1)} px apart to ${now.toFixed(1)} px, under the ${STRAIGHT_PATH_CLEARANCE.path} px chord clearance.`,
        owners: pair.split('|').map(id => ({ kind: 'link' as const, id })) });
    }
  }
  // With the setting on, the kept model is routed once more to publish: a judged route carries the ordinary overlay paths.
  const published = s.kept7e.document.layout?.overlayOverBodies === true ? await env.route(s.kept7e, undefined, true) : s.routedFinal ?? s.routedBase ?? await env.route(s.kept7e);
  // A course that publishes more turns than its candidate promised is named; the promise is the polyline its own lane geometry reserved.
  for (const failure of holdsRouted(s.kept, published)) {
    lost.push({ stage: 'placement', severity: 'warning', code: 'COURSE_SHAPE_LOST', owners: [{ kind: 'link', id: failure.link! }],
      message: `The link ${failure.link} has ${failure.got === undefined ? 'no route' : `${failure.got} turns`} on its course, ${failure.max} were promised.` });
  }
  lost.push(...turnMissed(published));
  // A hinted link of a kept trial has no more bends than on the baseline (the judgment tested it); this names a break of that rule.
  if (s.routedFinal !== undefined && s.routedBase !== undefined) {
    const before = routedBends(s.routedBase), after = routedBends(s.routedFinal);
    for (const [key, item] of s.promised) {
      if ((after.get(item.link) ?? Infinity) > (before.get(item.link) ?? Infinity)) lost.push({ stage: 'placement', severity: 'warning', code: 'SIDE_SHAPE_LOST',
        message: `The hinted link ${item.link} (port ${portName(key)}) has more bends than on the baseline (${before.get(item.link)}).`, owners: [{ kind: 'link', id: item.link }] });
    }
  }

  return env.timed('link-labels', () => env.step('link-labels', () => linkLabels(published, [...s.cuts, ...s.sideNotes, ...declined, ...lost])));
}
