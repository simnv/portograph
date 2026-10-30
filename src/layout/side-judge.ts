import type { Diagnostic, LayoutModel, LayoutNode, LayoutPort } from '../model/layout.js';
import type { Point, Rect } from '../model/geometry.js';
import { isRoutedChord } from './frame-paths.js';
import { crossingsOf } from './read/crossings.js';
import { hintsFacingAway } from './side-hints.js';
import { sharedBlockers } from './overlay-paths.js';
import { plannedBends } from './side-measure.js';
import { added as namesAdded, chordBlockedNew, constraintFindings, separationWorse, spanBlockedNew } from './trial-findings.js';
import { compare, pathBends, reading, refusal, routedBends, routedFamily, sideTrialProfile, tapVerdict } from './objective.js';

/**
 * The judgment of the side round (docs/design/side-faces.md, Sections 19.3 and 19.4). Both the predictor and the verdict compare two finished
 * placements and feed nothing back into placement: routing here only counts.
 */

export { pathBends, routedBends };

export { crossingsOf };

export const straightChords = (model: LayoutModel): number => model.links.filter(link => isRoutedChord(model, link)).length;

export interface TrialInput {
  routedBase: LayoutModel;
  routedTrial: LayoutModel;
  /** The two 7e models, for the chord count. */
  kept7e: LayoutModel;
  trial7e: LayoutModel;
  /** The hinted links of the trial's offer, with the bends each was promised. */
  hinted: ReadonlyMap<string, number>;
  /** The hinted links whose hint is for the routed L through a side lane (ticket 119). Empty for a batch with no lane hint. */
  lanes?: ReadonlySet<string>;
}

export interface Verdict {
  kept: boolean;
  /** Why a refused trial was refused. */
  reason: string;
  /** Hinted links with more bends than on the baseline, or removed by the trial's route. */
  worse: string[];
  /** Links the trial's route removes that the baseline's route keeps. */
  removed: string[];
  /** Hinted ports that face away after 7f and did not on the baseline. */
  away: string[];
  /** Hinted links that stop short of their promise but have no more bends than on the baseline. */
  short: { link: string; bends: number; base: number; promised: number }[];
}

/**
 * Section 19.4: `holds` (no hinted link worse than on the baseline, no link removed, no hint newly facing away) and `gains` (over every link, the
 * bent count falls, or it is equal and the total bends fall; no straight chord is lost). A batch is judged whole: a hinted link short of its
 * promise that has no more bends than the baseline does not refuse it.
 */
export function judgeTrial(input: TrialInput): Verdict {
  const base = routedBends(input.routedBase), trial = routedBends(input.routedTrial);
  const removed = [...base.keys()].filter(id => !trial.has(id));
  const worse = [...input.hinted.keys()].filter(id => !trial.has(id) || (base.has(id) && trial.get(id)! > base.get(id)!));
  const awayBase = new Set(hintsFacingAway(input.routedBase).map(item => item.key));
  const away = [...new Set(hintsFacingAway(input.routedTrial).map(item => item.key).filter(key => !awayBase.has(key)))];
  const short: Verdict['short'] = [];
  for (const [link, promised] of input.hinted) {
    const bends = trial.get(link), before = base.get(link);
    if (bends !== undefined && before !== undefined && bends > promised && bends <= before) short.push({ link, bends, base: before, promised });
  }
  const verdict = (kept: boolean, reason: string): Verdict => { tapVerdict('judgeTrial', () => `${kept} ${reason}`); return { kept, reason, worse, removed, away, short }; };
  if (worse.length > 0) return verdict(false, `a hinted link has more bends than on the baseline (${worse.join(', ')})`);
  if (removed.length > 0) return verdict(false, `the trial's route removes ${removed.join(', ')}, which the baseline's route keeps`);
  if (away.length > 0) return verdict(false, 'a hinted port faces away from its peer');
  const blocked = spanBlockedNew(input.routedBase, input.routedTrial);
  if (blocked.length > 0) return verdict(false, `a move put a wall in the corridor of a spanning chord (${blocked.join(', ')})`);
  const held = chordBlockedNew(input.routedBase, input.routedTrial);
  if (held.length > 0) return verdict(false, `stage 7f stood a body or a foreign frame on a held chord (${held.join(', ')})`);
  // The hard entries of the x catalogue the baseline holds (a band gap between two root groups) stay held: the same check as the course judge's (ticket 17).
  const constraintNew = namesAdded(constraintFindings(input.routedTrial), constraintFindings(input.routedBase));
  if (constraintNew.length > 0) return verdict(false, `the routed trial breaks a hard constraint the baseline holds (${constraintNew.join('; ')})`);
  const separationNew = separationWorse(input.routedTrial, input.routedBase);
  if (separationNew.length > 0) return verdict(false, `the routed trial breaks or deepens a minimum separation (${separationNew.join('; ')})`);
  // A trial that holds a lane hint (ticket 119) is kept only when each lane link's own bends fall, the total bends of the sheet do not rise, and no link
  // without a hint gets worse: a rise in total bends is never a gain, and the count of bent links cannot see what a lane gives.
  // The chord counts of the two 7e models stand in `routed.straight`: the clause that reads them comes last, and a refused trial does not pay for them.
  const now = reading({ routed: routedFamily(trial, straightChords(input.trial7e)) }), then = reading({ routed: routedFamily(base, straightChords(input.kept7e)) });
  const by = sideTrialProfile(new Set(input.hinted.keys()), [...(input.lanes ?? [])]);
  const refused = refusal(now, then, by.gates);
  if (refused !== undefined) return verdict(false, refused);
  if (!(compare(now, then, by) < 0)) {
    return verdict(false, `the routed trial gives no gain (${now.routed.bent} bent links and ${now.routed.turns} bends, against ${then.routed.bent} and ${then.routed.turns})`);
  }
  const lost = refusal(now, then, by.late);
  if (lost !== undefined) return verdict(false, lost);
  return verdict(true, '');
}

const shift = (box: Rect, dx: number, dy: number): Rect => ({ ...box, x: box.x + dx, y: box.y + dy });
const shiftPoint = (point: Point, dx: number, dy: number): Point => ({ x: point.x + dx, y: point.y + dy });

/**
 * Section 19.3: `trial7e` with every node moved by the move that 7f gave the same node between `kept7e` and `base`. Ports, anchors and pill
 * bounds move with it; the node keeps its trial size. Groups, frames, lanes, runs and pinned paths stay: the result serves the overlay paths and
 * the facing test, which read nodes and pills alone. No router, no clock.
 */
export function predictPublished(trial7e: LayoutModel, kept7e: LayoutModel, base: LayoutModel): LayoutModel {
  const nodes: Record<string, LayoutNode> = {};
  for (const [id, node] of Object.entries(trial7e.nodes)) {
    const before = kept7e.nodes[id]?.bounds, after = base.nodes[id]?.bounds;
    if (before === undefined || after === undefined || node.bounds === undefined) { nodes[id] = node; continue; }
    const dx = after.x - before.x, dy = after.y - before.y;
    if (dx === 0 && dy === 0) { nodes[id] = node; continue; }
    const ports: LayoutPort[] = node.ports.map(port => ({
      ...port,
      ...(port.anchor === undefined ? {} : { anchor: shiftPoint(port.anchor, dx, dy) }),
      ...(port.pill === undefined ? {} : { pill: { ...port.pill, bounds: shift(port.pill.bounds, dx, dy) } }),
    }));
    nodes[id] = { ...node, bounds: shift(node.bounds, dx, dy), ports };
  }
  return { ...trial7e, nodes };
}

/**
 * The hinted links the predictor calls worse than on the baseline (more planned bends), and the hinted ports newly facing away. The round
 * refuses these only, and only when it can place again. A link that is only short of its promise is never in the answer.
 */
export function predictedWorse(predicted: LayoutModel, base: LayoutModel, hinted: Iterable<string>): { links: string[]; away: string[] } {
  const blockers = sharedBlockers(predicted), baseBlockers = sharedBlockers(base);
  const links: string[] = [];
  for (const id of hinted) {
    const now = predicted.links.find(link => link.id === id), before = base.links.find(link => link.id === id);
    if (now !== undefined && before !== undefined && plannedBends(predicted, now, blockers) > plannedBends(base, before, baseBlockers)) links.push(id);
  }
  const awayBase = new Set(hintsFacingAway(base).map(item => item.key));
  return { links, away: [...new Set(hintsFacingAway(predicted).map(item => item.key).filter(key => !awayBase.has(key)))] };
}

/**
 * The info notes of a kept trial (Sections 19.4 and 19.8): a hinted link short of its promise (`SIDE_SHAPE_SHORT`), each link without a hint whose
 * bends rose (`SIDE_HINT_BENDS_NEIGHBOUR`, what the net count accepted), and each hinted link that crosses more links than on the baseline
 * (`SIDE_HINT_ADDS_CROSSING`, read on the two routed models with no slack; fewer bends win, Section 17).
 */
export function trialNotes(routedBase: LayoutModel, routedTrial: LayoutModel, verdict: Verdict, hinted: Iterable<string>): Diagnostic[] {
  const notes: Diagnostic[] = [], before = routedBends(routedBase), after = routedBends(routedTrial), owned = new Set(hinted);
  const note = (code: string, id: string, message: string): void => { notes.push({ stage: 'placement', severity: 'info', code, message, owners: [{ kind: 'link', id }] }); };
  for (const item of verdict.short) note('SIDE_SHAPE_SHORT', item.link,
    `The hinted link ${item.link} has ${item.bends} bends, short of the ${item.promised} the side round promised, but not more than the ${item.base} of the baseline.`);
  for (const [id, bends] of after) if (!owned.has(id) && bends > (before.get(id) ?? bends)) note('SIDE_HINT_BENDS_NEIGHBOUR', id,
    `The link ${id} has ${bends} bends after the side hints, ${before.get(id)} on the baseline: the net count accepted it.`);
  for (const id of owned) {
    const now = crossingsOf(routedTrial, id), was = crossingsOf(routedBase, id);
    if (now > was) note('SIDE_HINT_ADDS_CROSSING', id,
      `The hinted link ${id} crosses ${now} links after the side hint, ${was} on the baseline; fewer bends win (side-faces.md, Section 17).`);
  }
  return notes;
}
