import type { Side } from '../model/geometry.js';
import type { LayoutModel, LayoutPort } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { busOfPort } from './bus.js';
import { SIDE_TIE_ORDER } from './sides-one.js';
import { portId as portKey } from './skeleton-graph.js';
import { unreservedPeers } from './sides-two.js';
import { plannedTurns, turnOrder, type PlannedTurn, type TurnPort } from './turn-order.js';
import { added as namesAdded, constraintFindings, gateFindings, separationWorse, spanBlockedNew } from './trial-findings.js';
import { compare, lazyCount, profiles, reading, routedBends, type Reading } from './objective.js';
import type { ScoreCounts } from '../score/types.js';

/**
 * The turn round of architecture ticket 24 (`docs/design/turn-order.md`, Section 10): the offer and the judge.
 */

export interface TurnOffer {
  /** The faces whose turn order differs from the order they have, in node and side order. Empty: no offer. */
  faces: { node: string; side: Side }[];
}

/**
 * The faces where the planned first turns would change the order of the ports. It reads the kept 7f model (final anchors, kept courses and lane hints) with the
 * comparator of stage 5: the free ports of a face (not authored, not the bus port) sorted by the turn order, against the same ports sorted by the far end alone
 * and against the order they stand in. A face is offered when the turns move it and it does not stand in the turn order already. Authored order wins, so an
 * authored port is never part of the comparison.
 */
export function measureTurnOrder(base: LayoutModel): TurnOffer {
  const offer: TurnOffer = { faces: [] };
  const turns = plannedTurns(base, true), plain = plannedTurns(base, false), peers = unreservedPeers(base);
  for (const id of orderedNodeIds(base.document)) {
    const node = base.nodes[id]!;
    for (const side of SIDE_TIE_ORDER) {
      const along = side === 'top' || side === 'bottom' ? 'x' : 'y';
      const ports = node.ports.filter(port => port.side === side && port.anchor !== undefined && port.authorOrder === undefined && busOfPort(base, port.ref) === undefined)
        .sort((a, b) => a.anchor![along] - b.anchor![along]);
      if (ports.length < 2) continue;
      const far = (port: LayoutPort): number => {
        const list = peers.get(portKey(port.ref)) ?? [];
        const at = list.map(item => base.nodes[item.peer.node]?.ports.find(other => portKey(other.ref) === portKey(item.peer))?.anchor?.[along]).filter((value): value is number => value !== undefined);
        return at.length ? at.reduce((sum, value) => sum + value, 0) / at.length : Infinity;
      };
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
interface Count { bent: number; turns: number; crossings: number }

/** Better by the unified order, read lexicographically: fewer bent links, then fewer turns, then fewer crossings. Equal on all three is no gain. */
export function betterByUnified(before: Count, after: Count): boolean {
  return after.bent !== before.bent ? after.bent < before.bent : after.turns !== before.turns ? after.turns < before.turns : after.crossings < before.crossings;
}

/**
 * Whether the turn round places (Section 10, Budget). It needs a re-run. With one left and an overlay offer on the same baseline it leaves that re-run to the overlay
 * round unless its own promise beats the overlay promise: it promises no bend and no turn, so it runs only when the overlay offer promises nothing either.
 */
export function turnRoundRuns(left: number, overlayAhead: boolean, overlayGain: readonly number[], beats: (a: readonly number[], b: readonly number[]) => boolean): boolean {
  return left > 0 && !(overlayAhead && left === 1 && !beats([0, 0, 0], overlayGain));
}

const countOf = (counts: ScoreCounts): Count => ({ bent: counts.routed.bent + counts.overlay.bent, turns: counts.routed.turns + counts.overlay.turns, crossings: counts.routed.crossings + counts.overlay.crossings.pairs });

/**
 * The judge of the turn trial (Section 10). Kept only when: no link is removed; no new gate finding and no new hard constraint finding (as sets); no minimum
 * separation broken or deepened; every kept course publishes at most the turns it promised; the canvas does not grow; and the published result is better by the
 * unified order (fewer bent links over both layers, then fewer turns, then fewer crossings), read lexicographically: a trial that removes a crossing and adds a
 * turn is refused, and so is a trial that is equal on all three.
 */
export function judgeTurnTrial(routedBase: LayoutModel, routedTrial: LayoutModel, keptPromises: ReadonlyMap<string, number>): TurnVerdict {
  const was = routedBends(routedBase), now = routedBends(routedTrial);
  const removed = [...was.keys()].filter(id => !now.has(id));
  const no = (reason: string): TurnVerdict => ({ kept: false, reason });
  if (removed.length > 0) return no(`the trial's route removes ${removed.join(', ')}, which the baseline's route keeps`);
  const blocked = spanBlockedNew(routedBase, routedTrial);
  if (blocked.length > 0) return no(`a move put a wall in the corridor of a spanning chord (${blocked.join(', ')})`);
  const lost = [...keptPromises].filter(([id, turns]) => (now.get(id) ?? Infinity) > turns).map(([id]) => id);
  if (lost.length > 0) return no(`a kept course publishes more turns than it promised (${lost.join(', ')})`);
  const gatesNow = gateFindings(routedTrial), gatesThen = gateFindings(routedBase);
  if (gatesNow === undefined || gatesThen === undefined) return no('the routed trial does not score');
  const gateNew = namesAdded(gatesNow.findings, gatesThen.findings);
  if (gateNew.length > 0) return no(`the routed trial has gate findings the baseline does not have (${gateNew.join('; ')})`);
  const constraintNew = namesAdded(constraintFindings(routedTrial), constraintFindings(routedBase));
  if (constraintNew.length > 0) return no(`the routed trial breaks a hard constraint the baseline holds (${constraintNew.join('; ')})`);
  const separationNew = separationWorse(routedTrial, routedBase);
  if (separationNew.length > 0) return no(`the routed trial breaks or deepens a minimum separation (${separationNew.join('; ')})`);
  if ((routedTrial.canvas?.width ?? 0) > (routedBase.canvas?.width ?? 0) + 1e-6 || (routedTrial.canvas?.height ?? 0) > (routedBase.canvas?.height ?? 0) + 1e-6) return no('the routed trial grows the canvas');
  const readingOf = (counts: ScoreCounts): Reading => {
    const family = (bent: number, turns: number) => ({ straight: 0, bent, turns });
    return reading({ routed: family(counts.routed.bent, counts.routed.turns), overlay: family(counts.overlay.bent, counts.overlay.turns),
      crossings: lazyCount(() => counts.routed.crossings + counts.overlay.crossings.pairs), crossingMode: 'pairs', tie: [] });
  };
  const before = countOf(gatesThen.counts), after = countOf(gatesNow.counts);
  // The profile and the plain comparison above must agree: the profile is the order the user approved, the function states it in three lines.
  const order = compare(readingOf(gatesNow.counts), readingOf(gatesThen.counts), profiles.unified);
  if (order >= 0 || !betterByUnified(before, after)) return { kept: false, reason: `the routed trial is not better by the unified order (${after.bent} bent links, ${after.turns} turns, ${after.crossings} crossings, against ${before.bent}, ${before.turns} and ${before.crossings})`, before, after };
  return { kept: true, reason: '', before, after };
}
