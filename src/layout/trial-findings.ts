import type { LayoutModel } from '../model/layout.js';
import { isRoutedChord } from './frame-paths.js';
import { score } from '../score/index.js';
import { violationIdentity } from '../score/gates.js';
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

/**
 * The gate violations of the routed model, by gate, code and elements, with their multiplicity; undefined when the model does not score. `severity`
 * keeps the gates of that severity only (the side round asks for the error gates: a preference step never buys with a gate failure).
 *
 * A gate can name the same elements more than once: G5 publishes only the node for each inverted pair of a face (`portOrder`). The second and each
 * later violation of one name is its own name, `<name>|#<n>` (dense-16x9 ticket 60, review 1, P2), so the set difference of `added` counts them: three
 * where the baseline has one adds two names.
 *
 * `identity: 'face'` adds the identity the gate gives past its elements (`violationIdentity`: the face, and the two ports of a free-port reversal in
 * either order; review 2, P2), so a reversal on the top face and one on the bottom face of one node are two names. Two identities exist on purpose
 * (ruling in review 2 of ticket 60; ticket 62): the growth choice (`judgeGrowthChoice`) compares two whole runs and reads by face; the trial rounds (far-end,
 * course, side, span, turn, lift) keep the node, because with the face the course round refuses a course whose new reversal the far-end round
 * repairs later (sweep v6-3-1 and v7-3-1 with the option on: G5 0 to 4, crossings 0 to 8). Ticket 62 looks at the rounds' order of judgement.
 */
export function gateFindings(model: LayoutModel, severity?: 'error' | 'warning', identity: 'node' | 'face' = 'node'): { findings: Set<string>; counts: ScoreCounts } | undefined {
  try {
    const findings = new Set<string>(), seen = new Map<string, number>(), snapshot = score(model, { force: true }).snapshot;
    for (const [id, gate] of Object.entries(snapshot.gates)) {
      if (gate.passed || (severity !== undefined && gate.severity !== severity)) continue;
      for (const violation of gate.violations) {
        const face = identity === 'face' ? violationIdentity(violation) : undefined;
        const key = `${id}|${violation.code}|${violation.elements.join(',')}${face === undefined ? '' : `|${face}`}`, n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        findings.add(n === 1 ? key : `${key}|#${n}`);
      }
    }
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
