/**
 * The move checks as derived reservations (architecture 2, ticket 03).
 *
 * A move of a unit in x is held by five guards (a riser keep-out, a trunk extension, the lane sides with the frozen chords, the far port of a side lane, a span
 * corridor). Each guard reads a fact of the model before the move and judges the move against it. Here each fact is the evidence of a derived reservation, read
 * fresh for every move, and the guard is the predicate of that reservation. The list is ordered as the guards were, and a failure stops the list, so a diagnostic
 * a guard reports is reported as before. These reservations are transaction-local: they are never stored on the model.
 */
import type { Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { transient, type Reservation, type Reservations } from './reservations.js';
import { isSideLane, laneLink, laneSidesHold, riserNoDeeper, riserPenetrations, sideLaneSource, sideLanesHold, spanBreaches } from './lanes.js';
import { foreignOverExtensions, trunkHeads, trunkXAfter } from './trunk.js';
const isSpanLane = (lane: { kind?: string }): boolean => lane.kind === 'span';

export type ProposedMove = { group: LayoutGroup; bounds: Rect }[];
type Maker = (model: LayoutModel, proposed: ProposedMove) => Reservation[];
/** The derived kinds a move is held to, in the order the guards were chained. */
export type MoveKind = 'riserKeepOut' | 'trunkExtension' | 'laneSide' | 'sideAlignment' | 'spanCorridor';

/** The routed ports of the member rows that stand in a riser keep-out now: a move may not take one deeper. */
const riserKeepOut: Maker = (model, proposed) => {
  const upper = (model.meshBuses ?? []).find(bus => bus.riser !== undefined && bus.cross !== undefined);
  if (upper === undefined) return [];
  const maxDepth = proposed.flatMap(({ group, bounds }) => Math.abs(bounds.x - group.bounds!.x) <= 1e-9 ? [] : [...riserPenetrations(model, group)]);
  return [transient('riserKeepOut', { kind: 'mesh-bus', id: upper.id }, 'move', 'lanes', { bus: upper.id, maxDepth })];
};
/** The foreign units that stand across a bar extension of a trunk join now: a move may not add one. */
const trunkExtension: Maker = model => trunkHeads(model).map(head => transient('trunkExtension', { kind: 'mesh-bus', id: head.id }, 'move', 'lanes',
  { head: head.id, allowedPairs: foreignOverExtensions(model, head).map(item => `${item.group}|${item.bus}`) }));
/** The lanes and the frozen chords a move keeps. */
const laneSide: Maker = model => {
  if (model.lanes.length === 0 && !model.frozenChords?.length) return [];
  return [transient('laneSide', { kind: 'command', id: 'move' }, 'lanes', 'lanes', { lanes: model.lanes.map(lane => lane.id), groups: [], frameReach: [], chords: model.frozenChords ?? [] })];
};
/** The side lanes whose far port stands on the lane now. */
const sideAlignment: Maker = model => {
  const lanes = model.lanes.filter(isSideLane).flatMap(lane => {
    const link = laneLink(model, lane);
    return link?.attachments ? [{ lane: lane.id, far: sideLaneSource(link, lane) }] : [];
  });
  return lanes.length === 0 ? [] : [transient('sideAlignment', { kind: 'command', id: 'move' }, 'lanes', 'lanes', { lanes })];
};
/** The walls that stand in a span corridor now: a move may not add one. */
const spanCorridor: Maker = model => {
  if (!model.lanes.some(isSpanLane)) return [];
  return [transient('spanCorridor', { kind: 'command', id: 'move' }, 'corridors', 'lanes', { link: '', allowedBreaches: [...spanBreaches(model)] })];
};
const MAKERS: readonly (readonly [MoveKind, Maker])[] = [['riserKeepOut', riserKeepOut], ['trunkExtension', trunkExtension], ['laneSide', laneSide], ['sideAlignment', sideAlignment], ['spanCorridor', spanCorridor]];

/** The reservations a move is held to, with their evidence read from `model` as it stands. */
export function moveReservations(model: LayoutModel, proposed: ProposedMove): Reservations {
  return MAKERS.flatMap(([, make]) => make(model, proposed));
}

/** Whether the move keeps one derived reservation. The predicates are the guards of `optionalMoveHolds`, with the evidence taken from the payload. */
function holdsMoveEntry(entry: Reservation, model: LayoutModel, proposed: ProposedMove, report: boolean): boolean {
  switch (entry.kind) {
    case 'riserKeepOut': {
      const before = new Map(entry.payload.maxDepth);
      return proposed.every(({ group, bounds }) => {
        const dx = bounds.x - group.bounds!.x;
        return Math.abs(dx) <= 1e-9 || riserNoDeeper(before, riserPenetrations(model, group, dx));
      });
    }
    case 'trunkExtension': {
      const head = trunkHeads(model).find(item => item.id === entry.payload.head)!, allowed = new Set(entry.payload.allowedPairs);
      return foreignOverExtensions(model, head, proposed, trunkXAfter(model, head, proposed)).every(item => allowed.has(`${item.group}|${item.bus}`));
    }
    case 'laneSide': return laneSidesHold(model, proposed, report);
    case 'sideAlignment': return sideLanesHold(model, proposed, report);
    case 'spanCorridor': {
      const allowed = new Set(entry.payload.allowedBreaches);
      for (const key of spanBreaches(model, proposed)) if (!allowed.has(key)) return false;
      return true;
    }
    default: return true;
  }
}

/**
 * Whether a move that can be declined keeps every derived reservation: the verdict of `optionalMoveHolds`. A required move (`packClear`) never asks. Each kind is
 * derived only when the guards before it have passed, as the guards were chained. `only` limits the check to some kinds (a test of one guard).
 */
export function holdsMove(model: LayoutModel, proposed: ProposedMove, report = true, only?: readonly MoveKind[]): boolean {
  for (const [kind, make] of MAKERS) {
    if (only !== undefined && !only.includes(kind)) continue;
    for (const entry of make(model, proposed)) if (!holdsMoveEntry(entry, model, proposed, report)) return false;
  }
  return true;
}

/**
 * Whether a slide of some nodes of a group by `dx` (a row slide or a single-node move; the group box stays) keeps the move reservations that read a body or an anchor: the riser
 * keep-out of its facing ports and the far port of an aligned side lane. A node that leaves its lane's x is refused, as a unit that does.
 */
export function holdsNodeMove(model: LayoutModel, group: LayoutGroup, ids: readonly string[], dx: number): boolean {
  if (Math.abs(dx) <= 1e-9) return true;
  return holdsMove(model, [{ group: { ...group, nodes: [...ids] }, bounds: { ...group.bounds!, x: group.bounds!.x + dx } }], false, ['riserKeepOut', 'sideAlignment']);
}
