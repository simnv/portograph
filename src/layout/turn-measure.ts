import type { Side } from '../model/geometry.js';
import type { LayoutModel, LayoutPort } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { busOfPort } from './bus.js';
import { SIDE_TIE_ORDER } from './sides-one.js';
import { portId as portKey } from './skeleton-graph.js';
import { farCoordinate } from './peers.js';
import { pairedFaceKey } from './parallel-sets.js';
import { findPort } from './row-paths.js';
import { faceKey as faceName, plannedTurns, straightFaces, turnOrder, type PlannedTurn, type TurnPort } from './turn-order.js';
import { added as namesAdded, constraintFindings, gateFindings, separationWorse, spanBlockedNew } from './trial-findings.js';
import { compare, lazyCount, profiles, reading, routedBends, type Reading } from './objective.js';
import type { ScoreCounts } from '../score/types.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * The turn round of architecture ticket 24 (`docs/design/turn-order.md`, Section 10): the offer and the judge.
 */

export interface TurnOffer {
  /** The faces whose turn order differs from the order they have, in node and side order. Empty: no offer. */
  faces: { node: string; side: Side }[];
  /** The faces that hold a held straight link on the baseline and were not turned by it, by `faceKey`: they keep far-end order, so no offer names them and the trial reserves them (`turnExcept`). */
  except: string[];
}

/**
 * The faces where the planned first turns would change the order of the ports. It reads the kept 7f model (final anchors, kept courses and lane hints) with the
 * comparator of stage 5: the free ports of a face (not authored, not the bus port) sorted by the turn order, against the same ports sorted by the face key alone
 * (`pairedFaceKey`: a facing pair's shared key, else the far end)
 * and against the order they stand in. A face is offered when the turns move it and it does not stand in the turn order already. Authored order wins, so an
 * authored port is never part of the comparison.
 */
export function measureTurnOrder(base: LayoutModel): TurnOffer {
  const offer: TurnOffer = { faces: [], except: [...straightFaces(base)].sort() };
  const straight = new Set(offer.except);
  const turns = plannedTurns(base, true), plain = plannedTurns(base, false);
  // Stage 5's face key: a facing pair's shared key, else the far coordinate (`pairedFaceKey`, R1).
  const faceKey = pairedFaceKey(base, (ref, at) => farCoordinate(base, ref, at), ref => findPort(base, ref)?.side);
  for (const id of orderedNodeIds(base.document)) {
    const node = base.nodes[id]!;
    for (const side of SIDE_TIE_ORDER) {
      const along = side === 'top' || side === 'bottom' ? 'x' : 'y';
      // A face that holds a held routed chord takes far-end order (docs/design/turn-order.md, Section 3): the turn order never offers it.
      if (straight.has(faceName(id, side))) continue;
      const ports = node.ports.filter(port => port.side === side && port.anchor !== undefined && port.authorOrder === undefined && busOfPort(base, port.ref) === undefined)
        .sort((a, b) => a.anchor![along] - b.anchor![along]);
      if (ports.length < 2) continue;
      const far = (port: LayoutPort): number => faceKey(port.ref, side);
      const sorted = (planned: ReadonlyMap<string, PlannedTurn>): LayoutPort[] => {
        const slots = new Map(ports.map(port => [port, { far: far(port), ...(planned.get(portKey(port.ref)) ?? {}) } as TurnPort] as const));
        const by = turnOrder([...slots.values()]);
        return [...ports].sort((a, b) => by(slots.get(a)!, slots.get(b)!));
      };
      const moved = sorted(turns), flat = sorted(plain);
      if (moved.some((port, index) => port !== flat[index]) && moved.some((port, index) => port !== ports[index])) offer.faces.push({ node: id, side });
    }
  }
  return offer;
}

export interface TurnVerdict {
  kept: boolean;
  reason: string;
  /** The counts the judge read, both layers: bent links, turns, crossings of the baseline and of the trial. */
  before?: Count;
  after?: Count;
}
export interface Count { bent: number; turns: number; crossings: number }

/** Better by the unified order, read lexicographically: fewer bent links, then fewer turns, then fewer crossings. Equal on all three is no gain. */
export function betterByUnified(before: Count, after: Count): boolean {
  return after.bent !== before.bent ? after.bent < before.bent : after.turns !== before.turns ? after.turns < before.turns : after.crossings < before.crossings;
}

const countOf = (counts: ScoreCounts): Count => ({ bent: counts.routed.bent + counts.overlay.bent, turns: counts.routed.turns + counts.overlay.turns, crossings: counts.routed.crossings + counts.overlay.crossings.pairs });

/**
 * The canvas guard of the turn round: the canvas of the routed models as they stand. Stage 9 refits the canvas after the route (labels, legend, outer half of every stroke), so this reads
 * an extent that does not publish; a round that judges the published canvas passes its own reader (the far-end round).
 */
const ownCanvasGrowth = (base: LayoutModel, trial: LayoutModel): string | undefined =>
  (trial.canvas?.width ?? 0) > (base.canvas?.width ?? 0) + PLACEMENT_EPS || (trial.canvas?.height ?? 0) > (base.canvas?.height ?? 0) + PLACEMENT_EPS ? 'the routed trial grows the canvas' : undefined;

/** What the guards of a routed trial read, when they hold: the gate findings and counts of the baseline and of the trial. */
export interface TrialReading { gatesThen: NonNullable<ReturnType<typeof gateFindings>>; gatesNow: NonNullable<ReturnType<typeof gateFindings>> }

/**
 * What every judged re-run of a routed trial must hold, whatever it gains (the turn round and the far-end round share it, R1): no link is removed; no wall in the corridor of a
 * spanning chord; every kept course publishes at most the turns it promised; no new gate finding and no new hard constraint finding (as sets); no minimum separation broken
 * or deepened; and the canvas does not grow. The refusal reason, or the two readings the judge compares.
 */
export function guardRoutedTrial(routedBase: LayoutModel, routedTrial: LayoutModel, keptPromises: ReadonlyMap<string, number>,
  canvasRefusal: (base: LayoutModel, trial: LayoutModel) => string | undefined = ownCanvasGrowth): string | TrialReading {
  const guarded = guardRoutedTrialKind(routedBase, routedTrial, keptPromises, canvasRefusal);
  return 'kind' in guarded ? guarded.reason : guarded;
}

/** Which guard of a routed trial refused it (`guardRoutedTrialKind`). */
/** `gate-finding`: a new finding of error severity; `gate-warning`: new findings of warning severity only (it refuses the trial too). */
export type GuardKind = 'removed-link' | 'span-wall' | 'promise' | 'unscored' | 'gate-finding' | 'gate-warning' | 'constraint' | 'separation' | 'canvas';
/** The guards of `guardRoutedTrial`, with the guard that refused the trial named: the far-end round records a decision for some of them only (dense-16x9 ticket 49). */
export function guardRoutedTrialKind(routedBase: LayoutModel, routedTrial: LayoutModel, keptPromises: ReadonlyMap<string, number>,
  canvasRefusal: (base: LayoutModel, trial: LayoutModel) => string | undefined = ownCanvasGrowth): { kind: GuardKind; reason: string } | TrialReading {
  const was = routedBends(routedBase), now = routedBends(routedTrial);
  const removed = [...was.keys()].filter(id => !now.has(id));
  if (removed.length > 0) return { kind: 'removed-link', reason: `the trial's route removes ${removed.join(', ')}, which the baseline's route keeps` };
  const blocked = spanBlockedNew(routedBase, routedTrial);
  if (blocked.length > 0) return { kind: 'span-wall', reason: `a move put a wall in the corridor of a spanning chord (${blocked.join(', ')})` };
  const lost = [...keptPromises].filter(([id, turns]) => (now.get(id) ?? Infinity) > turns).map(([id]) => id);
  if (lost.length > 0) return { kind: 'promise', reason: `a kept course publishes more turns than it promised (${lost.join(', ')})` };
  const gatesNow = gateFindings(routedTrial), gatesThen = gateFindings(routedBase);
  if (gatesNow === undefined || gatesThen === undefined) return { kind: 'unscored', reason: 'the routed trial does not score' };
  const gateNew = namesAdded(gatesNow.findings, gatesThen.findings);
  if (gateNew.length > 0) {
    // Only a new error-severity finding is a gate the trial breaks (dense-16x9 ticket 49, review 2): a warning alone refuses the trial, and decides nothing.
    const errorsNow = gateFindings(routedTrial, 'error'), errorsThen = gateFindings(routedBase, 'error');
    const errorNew = errorsNow === undefined || errorsThen === undefined ? [] : namesAdded(errorsNow.findings, errorsThen.findings);
    return { kind: errorNew.length > 0 ? 'gate-finding' : 'gate-warning', reason: `the routed trial has gate findings the baseline does not have (${gateNew.join('; ')})` };
  }
  const constraintNew = namesAdded(constraintFindings(routedTrial), constraintFindings(routedBase));
  if (constraintNew.length > 0) return { kind: 'constraint', reason: `the routed trial breaks a hard constraint the baseline holds (${constraintNew.join('; ')})` };
  const separationNew = separationWorse(routedTrial, routedBase);
  if (separationNew.length > 0) return { kind: 'separation', reason: `the routed trial breaks or deepens a minimum separation (${separationNew.join('; ')})` };
  const canvas = canvasRefusal(routedBase, routedTrial);
  if (canvas !== undefined) return { kind: 'canvas', reason: canvas };
  return { gatesThen, gatesNow };
}

/**
 * What the unified order reads of a score (`readingOf`), per layer: the bent links and turns of the routed and of the overlay layer, and the crossings (pairs). A far-end
 * decision stores it for both sides (`farEndDecision.tallies`), so the restore check compares them with the judge's own comparator (`unifiedCompare`, R1).
 */
export interface UnifiedTally { routed: { bent: number; turns: number }; overlay: { bent: number; turns: number }; crossings: number }
const tallyOf = (counts: ScoreCounts): UnifiedTally => ({ routed: { bent: counts.routed.bent, turns: counts.routed.turns }, overlay: { bent: counts.overlay.bent, turns: counts.overlay.turns },
  crossings: counts.routed.crossings + counts.overlay.crossings.pairs });
/** The two layers of a tally summed, as a note names them. */
export const countOfTally = (tally: UnifiedTally): Count => ({ bent: tally.routed.bent + tally.overlay.bent, turns: tally.routed.turns + tally.overlay.turns, crossings: tally.crossings });

/** The tally of a routed model by the unified order's own measure (`gateFindings`), or `undefined` when it does not score: restore measures the baseline of a far-end decision with it. */
export const measuredTally = (model: LayoutModel): UnifiedTally | undefined => { const read = gateFindings(model); return read === undefined ? undefined : tallyOf(read.counts); };
/** The tallies of a routed baseline and of its routed trial, or `undefined` when one does not score: what a far-end decision names. */
export function trialCounts(routedBase: LayoutModel, routedTrial: LayoutModel): { base: UnifiedTally; trial: UnifiedTally } | undefined {
  const then = gateFindings(routedBase), now = gateFindings(routedTrial);
  return then === undefined || now === undefined ? undefined : { base: tallyOf(then.counts), trial: tallyOf(now.counts) };
}

/** The unified reading of a tally: the profile the user approved reads it. */
const readingOf = (tally: UnifiedTally): Reading => {
  const family = (bent: number, turns: number) => ({ straight: 0, bent, turns });
  return reading({ routed: family(tally.routed.bent, tally.routed.turns), overlay: family(tally.overlay.bent, tally.overlay.turns),
    crossings: lazyCount(() => tally.crossings), crossingMode: 'pairs', tie: [] });
};
/** The profile order of `trial` against `base` by the unified order (negative: the trial is better). The far-end judge and the restore check of its decision use it (R1). */
export const unifiedCompare = (base: UnifiedTally, trial: UnifiedTally): number => compare(readingOf(trial), readingOf(base), profiles.unified);
/** The counts a verdict names, and the profile order of the trial against the baseline (negative: the trial is better). */
export function unifiedOrder(read: TrialReading): { before: Count; after: Count; order: number } {
  return { before: countOf(read.gatesThen.counts), after: countOf(read.gatesNow.counts), order: unifiedCompare(tallyOf(read.gatesThen.counts), tallyOf(read.gatesNow.counts)) };
}

/**
 * The judge of the turn trial (Section 10). Kept only when the guards of `guardRoutedTrial` hold and the published result is better by the unified order (fewer bent links
 * over both layers, then fewer turns, then fewer crossings), read lexicographically: a trial that removes a crossing and adds a turn is refused, and so is a trial that is
 * equal on all three.
 */
export function judgeTurnTrial(routedBase: LayoutModel, routedTrial: LayoutModel, keptPromises: ReadonlyMap<string, number>): TurnVerdict {
  const guarded = guardRoutedTrial(routedBase, routedTrial, keptPromises);
  if (typeof guarded === 'string') return { kept: false, reason: guarded };
  // The profile and the plain comparison above must agree: the profile is the order the user approved, the function states it in three lines.
  const { before, after, order } = unifiedOrder(guarded);
  if (order >= 0 || !betterByUnified(before, after)) return { kept: false, reason: `the routed trial is not better by the unified order (${after.bent} bent links, ${after.turns} turns, ${after.crossings} crossings, against ${before.bent}, ${before.turns} and ${before.crossings})`, before, after };
  return { kept: true, reason: '', before, after };
}
