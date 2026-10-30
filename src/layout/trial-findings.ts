import type { LayoutModel } from '../model/layout.js';
import { isRoutedChord } from './frame-paths.js';
import { score } from '../score/index.js';
import type { ScoreCounts } from '../score/types.js';
import { evaluate, separationShortfalls, worseSeparations, xCatalogue } from './constraints/index.js';

/**
 * What a trial publishes that is broken, as a set of names. A round that places again judges its trial on these sets as well as on its counts: a trial
 * that adds a name the baseline did not have is refused, even when it removes another (a trade is a different diagram, not a gain).
 */

/** The hard entries of the x constraint catalogue the layout owes and breaks (a documented clearance such as the band gap between two root groups). */
export function constraintFindings(model: LayoutModel): Set<string> {
  const result = new Set<string>();
  for (const item of evaluate(model, xCatalogue(model))) if (item.violated && item.constraint.strength === 'hard' && item.class === 'invariant-violation') result.add(`x|${item.constraint.id}`);
  return result;
}

/**
 * The minimum separations a trial breaks or deepens against its baseline (ticket 17), by catalogue id, whatever the class of the entry: a warning the baseline
 * already carries does not excuse a break the trial adds, and a baseline that is short already is not licence to be shorter.
 */
export function separationWorse(trial: LayoutModel, base: LayoutModel): string[] {
  return worseSeparations(separationShortfalls(trial), separationShortfalls(base));
}

/** The gate violations of the routed model, by gate, code and elements,; undefined when the model does not score. */
export function gateFindings(model: LayoutModel): { findings: Set<string>; counts: ScoreCounts } | undefined {
  try {
    const findings = new Set<string>(), snapshot = score(model, { force: true }).snapshot;
    for (const [id, gate] of Object.entries(snapshot.gates)) if (!gate.passed) for (const violation of gate.violations) findings.add(`${id}|${violation.code}|${violation.elements.join(',')}`);
    return { findings, counts: snapshot.counts };
  } catch { return undefined; }
}

/**
 * The spanning chords (architecture ticket 22) that a trial leaves with a wall in their corridor and the baseline did not: `SPAN_CHORD_BLOCKED` names them at the end
 * of 7f. A round after the span round (course, side, overlay course) may not buy a gain with one: its trial is refused.
 */
export function spanBlockedNew(base: LayoutModel, trial: LayoutModel): string[] {
  // A hinted link also fails when the freeze refuses it (`ROUTED_CHORD_REFUSED`: a later round changed the port pitch) and the router draws it orthogonally
  // through bands where 7a reserved no lane. So every hinted link that does not end as a routed chord is named, whatever diagnostic says so.
  const owners = (model: LayoutModel): Set<string> => new Set([
    ...model.diagnostics.filter(item => item.code === 'SPAN_CHORD_BLOCKED').flatMap(item => (item.owners ?? []).map(owner => 'id' in owner ? owner.id : '')),
    ...model.links.filter(link => link.spanHint === true && !isRoutedChord(model, link)).map(link => link.id),
  ]);
  return added(owners(trial), owners(base));
}

/** The names in `now` that `then` does not have. */
export const added = (now: ReadonlySet<string>, then: ReadonlySet<string>): string[] => [...now].filter(name => !then.has(name));
