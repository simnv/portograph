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
import { groupExitsHold } from './group-exit-check.js';
import type { ProposedBox } from './frames.js';
import { foreignOverExtensions, trunkHeads, trunkXAfter } from './trunk.js';
import { lanesHoldGrowth } from './growth-guard.js';
import { chordsHold } from './frame-paths.js';
import { findPort } from './row-paths.js';
import { NO_MOVE_EPS, PLACEMENT_EPS } from './tolerance.js';
const isSpanLane = (lane: { kind?: string }): boolean => lane.kind === 'span';

/** The boxes a stage proposes; `ProposedBox.dx` says whether the bodies move with a box (a move) or stay (a widening). */
export type ProposedMove = ProposedBox[];
type Maker = (model: LayoutModel, proposed: ProposedMove) => Reservation[];
/** The derived kinds a move is held to, in the order the guards were chained. */
export type MoveKind = 'riserKeepOut' | 'trunkExtension' | 'laneSide' | 'sideAlignment' | 'spanCorridor' | 'groupExit';

/** The routed ports of the member rows that stand in a riser keep-out now: a move may not take one deeper. */
const riserKeepOut: Maker = (model, proposed) => {
  const upper = (model.meshBuses ?? []).find(bus => bus.riser !== undefined && bus.cross !== undefined);
  if (upper === undefined) return [];
  const maxDepth = proposed.flatMap(({ group, bounds }) => Math.abs(bounds.x - group.bounds!.x) <= NO_MOVE_EPS ? [] : [...riserPenetrations(model, group)]);
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
/** The exits 7e reserved (architecture ticket 13): a move keeps the end of each beyond the margin of the boxes it leaves, and its strip clear of every other group. */
const groupExit: Maker = model => model.groupExits?.length
  ? [transient('groupExit', { kind: 'command', id: 'move' }, 'exits', 'bands', { exits: model.groupExits })] : [];
const MAKERS: readonly (readonly [MoveKind, Maker])[] = [['riserKeepOut', riserKeepOut], ['trunkExtension', trunkExtension], ['laneSide', laneSide], ['sideAlignment', sideAlignment], ['spanCorridor', spanCorridor], ['groupExit', groupExit]];

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
        return Math.abs(dx) <= NO_MOVE_EPS || riserNoDeeper(before, riserPenetrations(model, group, dx));
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
    case 'groupExit': return groupExitsHold(model, entry.payload.exits, proposed);
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
  if (Math.abs(dx) <= NO_MOVE_EPS) return true;
  const bounds = { ...group.bounds!, x: group.bounds!.x + dx };
  if (!holdsMove(model, [{ group: { ...group, nodes: [...ids] }, bounds }], false, ['riserKeepOut', 'sideAlignment'])) return false;
  // A node slide leaves the container in place. Omit its id so the chord trial moves only these bodies.
  return !model.blockReservations?.length || chordsHold(model, [{ group: { nodes: [...ids], bounds: group.bounds! }, bounds }], false);
}

/**
 * What a resize of one group is judged against (architecture-2 ticket 32): the facts of the reservations `holdsMove` reads, taken before the resize. A
 * resize is no translation: the parent spread grows a body, moves the row nodes before it left and the ones after it right, and the clamp into its
 * window then moves the group. Its group box can come back to the x it had while its nodes have moved, so the move kinds, which read the move as the
 * shift of the box, would see nothing. The resize is therefore made on the model, and `resizeHolds` reads the same facts again where its nodes stand.
 */
export interface ResizeEvidence {
  /** The group box before the resize. */
  box: Rect;
  /** The routed ports of the facing edges in a riser keep-out, with their depth. */
  riser: Map<string, number>;
  /** The walls in a span corridor, as `lane|wall` keys. */
  breaches: Set<string>;
  /** For each trunk head, the foreign units across its bar extension, as `group|bus` keys. */
  trunks: Map<string, Set<string>>;
  /** The side lanes whose far port, a port of the group, stands on the lane x. */
  farOnLane: string[];
}
const overExtensions = (model: LayoutModel): Map<string, Set<string>> =>
  new Map(trunkHeads(model).map(head => [head.id, new Set(foreignOverExtensions(model, head).map(item => `${item.group}|${item.bus}`))]));
/** The evidence of `group` in `model` before a resize. */
export function resizeEvidence(model: LayoutModel, group: LayoutGroup): ResizeEvidence {
  const farOnLane = model.lanes.filter(isSideLane).flatMap(lane => {
    const link = laneLink(model, lane);
    if (!link?.attachments) return [];
    const far = sideLaneSource(link, lane), port = findPort(model, far);
    return group.nodes.includes(far.node) && port?.anchor !== undefined && Math.abs(port.anchor.x - lane.x) <= PLACEMENT_EPS ? [lane.id] : [];
  });
  return { box: { ...group.bounds! }, riser: riserPenetrations(model, group), breaches: spanBreaches(model), trunks: overExtensions(model), farOnLane };
}
/**
 * Whether a resize of `group`, made on `model`, keeps what `evidence` read before it: every reserved lane window and span corridor meets the new box no
 * more than it met the old one (`lanesHoldGrowth`), every lane of the tier keeps its side of the occupied extent (`laneSidesHold`), no facing port goes
 * deeper in a riser keep-out, no new wall stands in a span corridor, no new foreign unit stands across a trunk extension, and every far port that stood
 * on its side lane still does. The exits of 7e are a record a resize does not read: a model that has them refuses (R6).
 */
export function resizeHolds(model: LayoutModel, group: LayoutGroup, evidence: ResizeEvidence): boolean {
  if (model.groupExits?.length) return false;
  if (!lanesHoldGrowth(model, [{ group: { ...group, bounds: evidence.box }, bounds: group.bounds! }])) return false;
  if (!laneSidesHold(model, [{ group, bounds: group.bounds! }], false)) return false;
  if (!riserNoDeeper(evidence.riser, riserPenetrations(model, group))) return false;
  if ([...spanBreaches(model)].some(key => !evidence.breaches.has(key))) return false;
  for (const [head, pairs] of overExtensions(model)) for (const pair of pairs) if (!evidence.trunks.get(head)?.has(pair)) return false;
  return evidence.farOnLane.every(id => {
    const lane = model.lanes.find(item => item.id === id), link = lane === undefined ? undefined : laneLink(model, lane);
    const port = link?.attachments ? findPort(model, sideLaneSource(link, lane!)) : undefined;
    return port?.anchor !== undefined && Math.abs(port.anchor.x - lane!.x) <= PLACEMENT_EPS;
  });
}

