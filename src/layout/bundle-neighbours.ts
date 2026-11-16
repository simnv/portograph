import type { Bundle, LayoutModel, Side } from '../model/index.js';
import { compareId } from './skeleton-graph.js';
import { naturalSideOf } from './port-side.js';
import { findPort } from './row-paths.js';
import { orderTools, reseatRow } from './overlay-order.js';
import { bundleNeighboursFailure, ofKind, reservation, splitPair, type Reservation } from './reservations.js';

/** One bundle that a row encloses and that stands lateral: `left` leaves to the right and `right` is entered from the left. */
export interface NeighbourPair { left: string; right: string; bundle: string; members: number }

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
      const side = naturalSideOf(findPort(model, ref)!);
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

/**
 * The pairs a row keeps (R3). A node has one neighbour on its right and one on its left, and a chain never closes a ring, so a node
 * with enclosed bundles to three peers keeps what it can: the heaviest bundle first (most members), then the names of the two nodes.
 * Nothing here reads the input order of nodes or links.
 */
export function keptPairs(pairs: readonly NeighbourPair[]): NeighbourPair[] {
  const ranked = [...pairs].sort((a, b) => b.members - a.members || compareId(a.left, b.left) || compareId(a.right, b.right));
  const next = new Map<string, string>(), previous = new Map<string, string>(), kept: NeighbourPair[] = [];
  for (const pair of ranked) {
    if (next.has(pair.left) || previous.has(pair.right)) continue;
    // A ring: the right end already leads, through kept pairs, back to the left end.
    let cursor: string | undefined = pair.right;
    while (cursor !== undefined && cursor !== pair.left) cursor = next.get(cursor);
    if (cursor === pair.left) continue;
    next.set(pair.left, pair.right); previous.set(pair.right, pair.left); kept.push(pair);
  }
  return kept;
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

/**
 * The row neighbours of the bundles a free row holds (stage 4, after the ELK result is read and before any order stage). Each free row that
 * encloses a lateral facing bundle decides once which pairs it keeps (`keptPairs`), seats its order with them side by side, and writes the
 * decision to the ledger (`bundleNeighbours`, R1). `reseatRow`, every replay and `validateBundleNeighbours` read that record and never decide
 * again. A row that cannot be seated (no room to its right) records nothing and says so (`BUNDLE_NEIGHBOURS_REFUSED`, R6).
 * A canton, a rank cell, a flanked row, a grid and a bar are not free rows: the author or another rule places their nodes.
 */
export function seatBundleNeighbours(model: LayoutModel): void {
  const { freeRow } = orderTools(model);
  const entries: Reservation[] = [];
  // A placement re-run decides again on its own skeleton: the entries of an earlier run are dropped.
  if (model.reservations !== undefined) model.reservations = model.reservations.filter(entry => entry.kind !== 'bundleNeighbours');
  for (const group of Object.values(model.groups).filter(freeRow).sort((a, b) => compareId(a.id, b.id))) {
    const kept = keptPairs(lateralPairs(model, group.id));
    if (kept.length === 0) continue;
    const pairs = kept.map(pair => [pair.left, pair.right] as const), order = group.rowOrder ?? group.nodes, next = gatherPairs(order, pairs);
    if (splitPair(pairs, next) !== undefined) throw new Error(`Bundle neighbours of ${group.id} cannot stand side by side`);
    if (next.some((node, i) => node !== order[i]) && !reseatRow(model, group, next, true)) {
      model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'BUNDLE_NEIGHBOURS_REFUSED',
        message: `${group.id} cannot seat the two ends of ${kept.map(pair => pair.bundle).join(', ')} side by side: the row has no room to its right.`,
        owners: [group.owner] });
      continue;
    }
    entries.push(reservation('bundleNeighbours', { kind: 'group', id: group.id }, '', 'skeleton', 0, { group: group.id, pairs }));
  }
  if (entries.length) model.reservations = [...(model.reservations ?? []), ...entries];
}

/** The stage-4 check (R2, R5): every `bundleNeighbours` entry holds on the row as it stands. Reads the record, never the bundles. */
export function validateBundleNeighbours(model: LayoutModel): string[] {
  return ofKind(model.reservations ?? [], 'bundleNeighbours').flatMap(entry => {
    const why = bundleNeighboursFailure(entry, model);
    return why === undefined ? [] : [why];
  });
}
