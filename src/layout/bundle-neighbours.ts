import type { LayoutModel } from '../model/index.js';
import { compareId } from './skeleton-graph.js';
import { formsChains, gatherPairs, lateralPairs, type NeighbourPair } from './bundle-ends.js';
export type { NeighbourPair };
export { gatherPairs };
import { orderTools, reseatRow } from './overlay-order.js';
import { bundleNeighboursFailure, ofKind, reservation, splitPair, type Reservation } from './reservations.js';

/**
 * The pairs a row keeps (R3). A node has one neighbour on its right and one on its left, and a chain never closes a ring, so a node
 * with enclosed bundles to three peers keeps what it can: the heaviest bundle first (most members), then the names of the two nodes.
 * Nothing here reads the input order of nodes or links.
 */
export function keptPairs(pairs: readonly NeighbourPair[]): NeighbourPair[] {
  const ranked = [...pairs].sort((a, b) => b.members - a.members || compareId(a.left, b.left) || compareId(a.right, b.right));
  const kept: NeighbourPair[] = [];
  for (const pair of ranked) if (formsChains([...kept, pair].map(item => [item.left, item.right] as const))) kept.push(pair);
  return kept;
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

/** The stage-4 check (R2, R5): every `bundleNeighbours` entry holds on the row as it stands, by the predicate the restore asks (`bundleNeighboursFailure`). */
export function validateBundleNeighbours(model: LayoutModel): string[] {
  return ofKind(model.reservations ?? [], 'bundleNeighbours').flatMap(entry => {
    const why = bundleNeighboursFailure(entry, model);
    return why === undefined ? [] : [why];
  });
}
