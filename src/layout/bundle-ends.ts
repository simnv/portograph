import type { Bundle, LayoutModel, LayoutPort, Side } from '../model/index.js';
import type { PortRef } from '../model/document.js';
import { naturalSideOf } from './port-side.js';
import { portKey } from './sides-one.js';

/**
 * What the bundle neighbour rule reads from the model, apart from the rule's decision (`bundle-neighbours.ts`): a leaf, so the writer, the
 * guards, the stage-4 check and the restore (`reservations.ts`) ask the same predicates (R1, R5). Nothing here selects a pair.
 */

/** One bundle that a row encloses and that stands lateral: `left` leaves to the right and `right` is entered from the left. */
export interface NeighbourPair { left: string; right: string; bundle: string; members: number }

const portAt = (model: LayoutModel, ref: PortRef): LayoutPort | undefined => {
  const key = portKey(ref);
  return model.nodes[ref.node]?.ports.find(port => portKey(port.ref) === key);
};

/**
 * The side each end of `bundle` takes when every member agrees on it, as `[side at nodes[0], side at nodes[1]]`; undefined when a member
 * disagrees or a port has no side yet.
 */
function endSides(model: LayoutModel, bundle: Bundle): [Side, Side] | undefined {
  const sides: [Set<Side>, Set<Side>] = [new Set(), new Set()];
  for (const id of bundle.members) {
    const link = model.links.find(item => item.id === id)?.attachments;
    if (link === undefined) return undefined;
    const reversed = link.from.node !== bundle.nodes[0];
    for (const [end, ref] of [[0, reversed ? link.to : link.from], [1, reversed ? link.from : link.to]] as const) {
      const port = portAt(model, ref), side = port === undefined ? undefined : naturalSideOf(port);
      if (side === undefined) return undefined;
      sides[end].add(side);
    }
  }
  return sides[0].size === 1 && sides[1].size === 1 ? [[...sides[0]][0]!, [...sides[1]][0]!] : undefined;
}

/**
 * The bundles of `group` that a row owes room: both ends are its own nodes, and the two end faces look at each other along the row
 * (one `right`, the other `left`). A bundle whose faces look the same way, or up and down, owes no neighbour: its channel is not the gap
 * between two bodies of one row.
 */
export function lateralPairs(model: LayoutModel, group: string): NeighbourPair[] {
  return model.bundles.flatMap(bundle => {
    if (!bundle.nodes.every(node => model.document.nodes[node]?.group === group)) return [];
    const sides = endSides(model, bundle);
    if (sides === undefined || sides[0] === sides[1] || !sides.every(side => side === 'left' || side === 'right')) return [];
    const [left, right] = sides[0] === 'right' ? bundle.nodes : [bundle.nodes[1], bundle.nodes[0]];
    return [{ left, right, bundle: bundle.id, members: bundle.members.length }];
  });
}

/** Whether `pairs` form chains: a node is the left of at most one pair and the right of at most one, and no chain closes a ring. The one predicate of the writer's choice and of the check. */
export function formsChains(pairs: readonly (readonly [string, string])[]): boolean {
  const next = new Map<string, string>(), previous = new Set<string>();
  for (const [left, right] of pairs) {
    if (left === right || next.has(left) || previous.has(right)) return false;
    next.set(left, right); previous.add(right);
  }
  for (const [start] of next) {
    const seen = new Set<string>([start]);
    for (let node = next.get(start); node !== undefined; node = next.get(node)) {
      if (seen.has(node)) return false;
      seen.add(node);
    }
  }
  return true;
}

/**
 * `order` with every kept pair side by side, `left` before `right`. A chain of pairs stands as one block at the place of its first member in
 * `order`; every other node keeps its place. The result is a function of `order` and the pairs only.
 */
export function gatherPairs(order: readonly string[], pairs: readonly (readonly [string, string])[]): string[] {
  const next = new Map(pairs), heads = pairs.filter(([left]) => !pairs.some(([, right]) => right === left)).map(([left]) => left);
  const chains = new Map<string, string[]>();
  for (const head of heads) {
    const chain = [head];
    for (let node = next.get(head); node !== undefined; node = next.get(node)) chain.push(node);
    for (const node of chain) chains.set(node, chain);
  }
  const seated = new Set<string>(), result: string[] = [];
  for (const node of order) {
    if (seated.has(node)) continue;
    for (const member of chains.get(node) ?? [node]) { result.push(member); seated.add(member); }
  }
  return result;
}
