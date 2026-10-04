import type { LayoutModel } from '../model/layout.js';
import { score } from '../score/index.js';
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
export function gateFindings(model: LayoutModel): { findings: Set<string> } | undefined {
  try {
    const findings = new Set<string>(), snapshot = score(model, { force: true }).snapshot;
    for (const [id, gate] of Object.entries(snapshot.gates)) if (!gate.passed) for (const violation of gate.violations) findings.add(`${id}|${violation.code}|${violation.elements.join(',')}`);
    return { findings };
  } catch { return undefined; }
}

/** The names in `now` that `then` does not have. */
export const added = (now: ReadonlySet<string>, then: ReadonlySet<string>): string[] => [...now].filter(name => !then.has(name));
