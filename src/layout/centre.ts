import { liftedGroups } from './lift.js';
import { portEndInsets, portSideCapacity } from './port-insets.js';
import { faceExcess, facePairPitches } from './pair-pitch.js';
import type { AlignedExtentEdge, AlignmentDeclineReason, Diagnostic, LayoutGroup, LayoutLink, LayoutModel, LayoutNode, LayoutPort, LayoutStage, ParentSpread } from '../model/layout.js';
import type { Rect, Side } from '../model/geometry.js';
import { portAnchor } from '../geometry/index.js';
import { laneSidesHold, rightWallReach, spanBreaches, recordSeatedSideLanes, occupiedOverhang, riserAvoidance, riserKeepOutAfterMove, riserNoDeeper, riserPenetrations, selectAnchorTier } from './lanes.js';
import { holdsMove, holdsNodeMove, resizeEvidence, resizeHolds, seatRefusal, type ResizeEvidence } from './move-reservations.js';
import { rowRoomKeptByStep } from './label-room-guard.js';
import { cellReach } from './frames.js';
import { memberRoom, standsInCanton } from './read/canton.js';
import { centringFeeds, type Feed } from './read/feeds.js';
import { straightChordIds } from './read/overlay-straight.js';
import { holds, profiles, reading, straightOf, tapVerdict, verdictTap } from './objective.js';
import { besideGap, besideWalls, frameColumns, keepOutShifts, packBesideRows, type CellWindow, type FrameColumn } from './columns.js';
import { findPort } from './row-paths.js';
import { attemptCounters } from './attempt-counters.js';
import { timed } from './attempt-timings.js';
import { orderBundles } from './bundle-geometry.js';
import { normalizePrimaryBundlePorts } from './flanks.js';
import { portId, bandGap, SKELETON_SPACING } from './skeleton-graph.js';
import { crosses } from './overlay-paths.js';
import { moveGroup } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { recentreSeatedFaces, seatedFaces } from './face-centre.js';
import { isGridGroup, packRowsOf } from './grid.js';
import { nodeTier } from './read/tier.js';
import { rowGap } from './sides-two.js';
import { alignmentAllowance, ownSideWidth, withinAlignmentCap } from './size.js';
import { moveBeforeGrow } from './read/move-before-grow.js';
import { standsVertical, strandedGrowth } from './given-back.js';
import { withStageMutation } from './mutation.js';
import { barReach } from './bars.js';
import { placeOverlayFree } from './overlay-place.js';
import { fitRegionGroup, GROUP_PADDING, groupInsets, placementWarning, rebuildRegions, right } from './regions.js';
import { EPS, segmentRectDistance } from '../geometry/planar.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { standPortsOverChildren, withdrawWallMoves, type StepReader } from './parent-stand.js';
import { chordKind, chordNearPairs, isRoutedChord, withSharedLinkKinds, withStepLinkKinds } from './frame-paths.js';
import { readCache } from '../model/read-cache.js';
import { linkById } from './peers.js';
import { ALIGNMENT_TARGETS_DIFFER, declinedTargets, directMembers, tapTarget, owesVertical, sameDeclines, writeAlignmentSeats, writeAlignmentTargets, type TargetNotes } from './alignment-targets.js';
import { faceKey } from './turn-order.js';
import { untrimmedModel } from './end-trim.js';
import { NO_MOVE_EPS, PLACEMENT_EPS, RISER_DEPTH_EPS } from './tolerance.js';
import { chainBlockOf } from './read/chain.js';

export interface CentreBudget { remaining: number; passes: number }
export function createCentreBudget(): CentreBudget { return { remaining: 8, passes: 0 }; }
export { selectAnchorTier };
function shiftNode(node: LayoutNode, dx: number): void {
  node.bounds!.x += dx;
  for (const port of node.ports) port.anchor!.x += dx;
}
interface WideningLimit { low: number; high: number }

/** Widen into free row space only; stacked siblings do not constrain horizontal growth. */
function siblingLimit(model: LayoutModel, group: LayoutGroup, node: LayoutNode): WideningLimit {
  const limit = { low: -Infinity, high: Infinity }, box = node.bounds!, order = group.rowOrder!;
  const index = order.indexOf(node.id);
  for (const [otherIndex, id] of order.entries()) {
    if (id === node.id) continue;
    const other = model.nodes[id]!.bounds!;
    if (Math.min(box.y + box.height, other.y + other.height) <= Math.max(box.y, other.y) + EPS) continue;
    if (otherIndex < index) limit.low = Math.max(limit.low, right(other) + rowGap(model, id, node.id));
    else limit.high = Math.min(limit.high, other.x - rowGap(model, node.id, id));
  }
  return limit;
}

/** How far a body may grow on each side before it reaches a straight overlay chord, and the link that says so. */
interface OverlayStops { low: number; high: number; lowLink?: string; highLink?: string }

/**
 * The overlay cap on an alignment growth (ranked-groups ticket 29). A chord is the straight segment
 * between the two attachment anchors of an overlay link that has no end on `node`, read in the model
 * as it stands. A chord the ungrown body already crosses is not a stop: the body is already on it.
 * Any other chord that reaches the rows of the body lies wholly on one side of it, and the growth on
 * that side stops one node clearance short of the place where the chord enters the body's rows. A
 * side with no chord is unbounded; a chord nearer than the clearance leaves no growth at all.
 */
function overlayStops(model: LayoutModel, node: LayoutNode): OverlayStops {
  const stops: OverlayStops = { low: -Infinity, high: Infinity };
  const box = node.bounds!, top = box.y, bottom = box.y + box.height, boxRight = right(box);
  const clearance = SKELETON_SPACING.nodeClearance + (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) / 2;
  for (const link of model.links) {
    if (link.layer !== 'overlay' || !link.attachments) continue;
    const { from, to } = link.attachments;
    if (from.node === node.id || to.node === node.id) continue;
    const one = findPort(model, from)?.anchor, two = findPort(model, to)?.anchor;
    if (!one || !two || crosses(one, two, box)) continue;
    // The part of the chord inside the rows of the body: the parameter range where y is in [top, bottom].
    let lo = 0, hi = 1;
    if (Math.abs(two.y - one.y) <= EPS) { if (one.y <= top + EPS || one.y >= bottom - EPS) continue; }
    else {
      const at = [(top - one.y) / (two.y - one.y), (bottom - one.y) / (two.y - one.y)];
      lo = Math.max(0, Math.min(...at)); hi = Math.min(1, Math.max(...at));
      if (hi - lo <= EPS) continue;
    }
    const xs = [one.x + (two.x - one.x) * lo, one.x + (two.x - one.x) * hi];
    if (Math.min(...xs) >= boxRight - EPS) {
      const cap = Math.max(boxRight, Math.min(...xs) - clearance);
      if (cap < stops.high) { stops.high = cap; stops.highLink = link.id; }
    } else if (Math.max(...xs) <= box.x + EPS) {
      const cap = Math.min(box.x, Math.max(...xs) + clearance);
      if (cap > stops.low) { stops.low = cap; stops.lowLink = link.id; }
    }
  }
  return stops;
}

/**
 * The two body edges a face of `count` ports at `pitch` needs when its port `index` stands at `x`: the ports keep their pitch on both sides,
 * and the outer ones retain the stored face insets inside the edges. The one statement of the alignment's edge arithmetic: `keptTargets`, `alignSide`
 * and the aligned extent (`alignedExtentOf`) read it.
 */
function alignedEdges(node: LayoutNode, side: Side, index: number, x: number, count: number, pitch: number): { low: number; high: number } {
  const inset = portEndInsets(node, side, pitch), excess = engineExcess(node, side, pitch);
  const before = excess[index] ?? 0, after = (excess[count - 1] ?? 0) - before;
  return { low: x - index * pitch - before - inset.low, high: x + (count - 1 - index) * pitch + after + inset.high };
}
/**
 * The running pair-pitch excess of a face in engine order (`faceExcess`, dense-16x9 ticket 04), or none on a face no pair pitch binds: the
 * alignment adds it to its `index * pitch` arithmetic, which stays exact on a face of one pitch.
 */
function engineExcess(node: LayoutNode, side: Side, pitch = node.sidePitch![side]!): number[] {
  if (!facePairPitches(node, side).length) return [];
  return faceExcess(node, side, node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!), pitch);
}
/** The distance from the port at engine index `i` to the one at `j` of a face standing at its pitch and its pair pitches (`engineExcess`). */
const stepSpan = (excess: readonly number[], pitch: number, i: number, j: number): number => (j - i) * pitch + ((excess[j] ?? 0) - (excess[i] ?? 0));
/** The keep decision of `alignSide` without its mutation: the targets a side keeps, none when the side is declined as a whole (architecture ticket 12). */
function keptTargets(model: LayoutModel, node: LayoutNode, side: Side, targets: ReadonlyMap<string, number>, limit: WideningLimit, stops: OverlayStops, stopped: (link: string) => void = () => {}, judgeCap = true): { index: number; x: number; key: string }[] {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
  const pitch = node.sidePitch![side]!, kept: { index: number; x: number; key: string }[] = [], excess = engineExcess(node, side, pitch);
  const box = node.bounds!, oldRight = right(box);
  if (box.x < limit.low - EPS || oldRight > limit.high + EPS) return [];
  // The default bound (ticket 29): no target whose reach leaves the body wider than its allowance. With `layout.moveBeforeGrow` the cap of the
  // seat is judged on the side as a whole (ADR-0027).
  const seats = moveBeforeGrow(model), allowance = seats ? Infinity : alignmentAllowance(model, node, side);
  /** The width the body ends with when the port at `index` is aligned to `x`. */
  const reach = (index: number, x: number): number => { const edges = alignedEdges(node, side, index, x, ports.length, pitch); return Math.max(oldRight, edges.high) - Math.min(box.x, edges.low); };
  /** Whether the body, grown in place to stand `list` (in engine order), keeps the alignment cap (ADR-0027). */
  const capHolds = (list: readonly { index: number; x: number }[]): boolean => {
    const low = alignedEdges(node, side, list[0]!.index, list[0]!.x, ports.length, pitch).low, high = alignedEdges(node, side, list.at(-1)!.index, list.at(-1)!.x, ports.length, pitch).high;
    return withinAlignmentCap(model, node, [side], { from: box.width, width: Math.max(oldRight, high) - Math.min(box.x, low) });
  };
  for (const [index, port] of ports.entries()) {
    const key = portId(port.ref), x = targets.get(key), last = kept[kept.length - 1];
    const edges = x === undefined ? undefined : alignedEdges(node, side, index, x, ports.length, pitch);
    if (x !== undefined && (edges!.low < limit.low - EPS || edges!.high > limit.high + EPS)) continue;
    if (x !== undefined && reach(index, x) > allowance + EPS) continue;
    // The overlay cap comes last, so it is named only where it alone declines the target.
    if (x !== undefined) {
      const beyondLow = edges!.low < stops.low - EPS;
      if (beyondLow || edges!.high > stops.high + EPS) {
        stopped((beyondLow ? stops.lowLink : stops.highLink)!);
        continue;
      }
    }
    if (x !== undefined && (!last || x - last.x >= stepSpan(excess, pitch, last.index, index))) kept.push({ index, x, key });
  }
  if (!kept.length) return [];
  if (!seats) {
    const first = kept[0]!, last = kept[kept.length - 1]!;
    return Math.max(oldRight, alignedEdges(node, side, last.index, last.x, ports.length, pitch).high)
      - Math.min(box.x, alignedEdges(node, side, first.index, first.x, ports.length, pitch).low) > allowance + EPS ? [] : kept;
  }
  // A seat has judged the cap on all its faces (`seatNode`); the parent spread asks it here, on the face it grows.
  return !judgeCap || capHolds(kept) ? kept : [];
}

/**
 * Keep compatible targets that fit between siblings and inside the alignment cap (`withinAlignmentCap`);
 * other ports retain their legal slots.
 *
 * A side is kept only when growing the body in place to its targets keeps the alignment cap — the
 * third bound on a widening, beside the siblings of the row and the reserved lane and flank window
 * of `reservedWindow`, and the one that says the node has to stay something a reader still reads as
 * this node (ticket 29). What gives way is the alignment: the port keeps its legal slot, the feed is
 * reported `CENTRE_ALIGNMENT_INFEASIBLE` like any other alignment the row cannot hold, and stage 8
 * routes the link instead of receiving it pinned. Two targets that each fit alone but not together —
 * one parent far to the left, one far to the right — decline the whole side, because widening to the
 * outer one is the same growth by another name.
 */
function alignSide(model: LayoutModel, node: LayoutNode, side: Side, targets: Map<string, number>, limit: WideningLimit, stops: OverlayStops, stopped: (link: string) => void,
  avoid: { xs: number[]; keep: number; routed: Set<string> } = { xs: [], keep: 0, routed: new Set() }, held: ReadonlyMap<string, (x: number) => boolean> = new Map(), judgeCap = true): Set<string> {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
  const pitch = node.sidePitch![side]!, excess = engineExcess(node, side, pitch);
  const box = node.bounds!, oldRight = right(box);
  const kept = keptTargets(model, node, side, targets, limit, stops, stopped, judgeCap);
  if (!kept.length) return new Set();
  const first = kept[0]!, last = kept[kept.length - 1]!;
  /** Where the port at `index` stands: spread between two kept targets in proportion to its pitches, else at its pitches beside the nearest one. */
  const seatOf = (index: number): number => {
    const before = [...kept].reverse().find(target => target.index <= index), after = kept.find(target => target.index >= index);
    if (before && after && before.index !== after.index) {
      return excess.length ? before.x + stepSpan(excess, pitch, before.index, index) * (after.x - before.x) / stepSpan(excess, pitch, before.index, after.index)
        : before.x + (index - before.index) * (after.x - before.x) / (after.index - before.index);
    }
    return before ? before.x + stepSpan(excess, pitch, before.index, index) : first.x - stepSpan(excess, pitch, index, first.index);
  };
  // The width the alignment needs is what each edge moved outward, added to the width the node
  // already has. `Math.max(oldRight, grown) - box.x` states the same thing through two absolute
  // edges, and a rectangle recovered through an edge it was not stored with does not come back:
  // `(box.x + box.width) - box.x` returns `box.width` only when `box.x + box.width` is itself
  // representable, and it loses up to half a ULP of the sum's binade when it is not — the coarse
  // widths this rule works in make a binade crossing the case that does it. A node that moved
  // neither edge then ended narrower than the width it kept. Both terms below are non-negative, so
  // centring widens the node or leaves it alone, in the arithmetic and not only in the intent the
  // guards in `mutation.ts` read. It can leave the right edge up to two ULP short of `grown`; no
  // consumer reads that edge, and the last kept port sits 10 + pitch / 2 inside it.
  // The riser keep-out (mesh-bus.md, section 11.5): an alignment that would put a port of the facing edge of a member row within `k` of the riser is declined.
  if (avoid.xs.length) {
    const landing = ports.map((_, index) => seatOf(index));
    if (landing.some((x, index) => avoid.routed.has(portId(ports[index]!.ref)) && avoid.xs.some(riser => Math.abs(x - riser) < avoid.keep))) return new Set();
  }
  // A port of a held chord that is not itself an alignment target is packed against the kept ones, and the chord follows it. The chord was decided
  // at the old x; where the new one lays it across the lane of another link, `validateLanes` refuses the fixed path at publication. The side is declined
  // instead, like the riser case above; stage 8 routes the feeds that lose their alignment.
  if (held.size) {
    const seats = ports.map((_, index) => seatOf(index));
    if (seats.some((x, index) => !kept.some(target => target.index === index) && Math.abs(x - ports[index]!.anchor!.x) > EPS
      && held.get(portId(ports[index]!.ref))?.(x) === false)) return new Set();
  }
  const oldX = box.x, grown = alignedEdges(node, side, last.index, last.x, ports.length, pitch).high;
  box.x = Math.min(box.x, alignedEdges(node, side, first.index, first.x, ports.length, pitch).low);
  box.width += (oldX - box.x) + Math.max(0, grown - oldRight);
  node.size!.width = box.width;
  for (const port of node.ports) {
    if (port.side === 'left') port.anchor!.x = box.x;
    if (port.side === 'right') port.anchor!.x = right(box);
  }
  ports.forEach((port, index) => { port.anchor = portAnchor(box, side, seatOf(index) - box.x); });
  return new Set(kept.map(target => target.key));
}
/**
 * The seat of a node (ADR-0027, dense-16x9 ticket 02): the one decision of a centring step that stands the ports of a node over their feeds. It
 * chooses a set of targets, a body position inside the slack of the row and a body width. The body moves first; it grows only by what no move
 * gives, never past the alignment cap (`withinAlignmentCap`). A target outside the chosen set keeps its pitch slot, and routing completes its link.
 */
/** The most seats one node tries against its guards in one step (R4, scope: one node in one step). A refused seat is undone whole. */
export const SEAT_TRIES = 4;
const SEAT_REFUSED = 'ALIGNMENT_SEAT_REFUSED';
/** One wanted port of a node's top or bottom face, at its place in engine order. */
export interface SeatTarget { key: string; side: 'top' | 'bottom'; index: number; x: number; owes: boolean }
/**
 * One candidate seat: the targets it stands (port-key order), where the body stands (`x`) and how wide it is, the slide (`dx`) and the growth it
 * takes, the owed verticals it stands, and whether it is a growth in place (the body keeps its edges and grows over the targets, as before ADR-0027).
 */
export interface SeatCandidate { keys: string[]; x: number; width: number; dx: number; growth: number; owed: number; inPlace: boolean; recorded?: boolean }
/** What bounds the seats of one node: the row siblings (`siblingLimit`), the window of the group's step and the overlay walls. */
/**
 * The alignment cap of a seat (ADR-0027): whether a body `width` wide that stands the targets of `window` keeps it.
 */
export type SeatCap = (window: readonly SeatTarget[], width: number) => boolean;
interface SeatBounds { siblings: WideningLimit; window: WideningLimit; stops: OverlayStops; kept?: ReadonlySet<string> | undefined }

/** The wanted ports of the top and bottom faces of `node`, by x, then by port key (R3: the last key). */
function seatTargets(node: LayoutNode, wanted: ReadonlyMap<string, number>, owes: (key: string) => boolean, sides: readonly ('top' | 'bottom')[] = ['top', 'bottom']): SeatTarget[] {
  const result: SeatTarget[] = [];
  for (const side of sides) {
    if (node.sidePitch?.[side] === undefined) continue;
    const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
    for (const [index, port] of ports.entries()) {
      const key = portId(port.ref), x = wanted.get(key);
      if (x !== undefined) result.push({ key, side, index, x, owes: owes(key) });
    }
  }
  return result.sort((a, b) => a.x - b.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Gives a body back the box it had before its first seat (ADR-0027, clause 4): the width `from`, at the offset `at` inside the seated box (the
 * record keeps both), with its height; the ports of each face stand again at the face's pitch, centred on the box, as the engine slots place
 * them. One function for the producer and every replay (R1).
 */
function giveBackGrowth(model: LayoutModel, node: LayoutNode, recorded: number, at: number): void {
  const box = node.bounds!;
  // A rule after the first seat may have given a face more ports (a side hint, a bundle): the body keeps the room its faces and content need.
  const from = Math.max(recorded, node.sizeFloor?.width ?? 0, node.contentSize?.width ?? 0,
    ...(['top', 'bottom'] as const).map(side => { const count = node.ports.filter(port => port.side === side).length; return count && node.sidePitch?.[side] !== undefined ? portSideCapacity(node, side, count) : 0; }));
  if (box.width <= from + EPS) return;
  node.bounds = { ...box, x: box.x + Math.max(0, Math.min(at, box.width - from)), width: from };
  node.size = { width: from, height: box.height };
  rebuildNodeGeometry(model, [node.id], 'from-slots');
}
/**
 * The seats of one node, best first (ADR-0027). Each window of targets consecutive in x whose targets keep the pitch of their face (`keptTargets`
 * reads the pitch the same way) needs an interval (`alignedEdges`). The body slides to the x nearest to where it stands that holds the interval
 * when it is wide enough; otherwise it becomes the interval: it moves to the low edge and grows the rest. The slide stays inside the siblings,
 * the step window and the overlay walls. A body that may not move (`movable` false) takes only a seat that needs no slide, and a body moves
 * only for a window that stands an owed vertical: a held chord runs at any angle (`owesVertical`), so a move for it alone decides nothing
 * the chord freeze has not decided, and two such seats on one body take turns pass after pass while the main move follows them. Each window also
 * gives a growth in place, the seat before ADR-0027: a body a guard keeps from moving still grows over its targets. A seat past the alignment
 * cap (`cap`) is no candidate: it goes to `capped`, so the seat can name the targets the cap alone declines. Order: the most owed verticals, the most targets, the least growth, the least slide, a seat that moves
 * before one in place, then the port keys (R3: the last key).
 */
export function seatCandidates(node: LayoutNode, targets: readonly SeatTarget[], bounds: SeatBounds, movable: boolean, cap: SeatCap, capped: SeatCandidate[] = []): SeatCandidate[] {
  const box = node.bounds!, x0 = box.x, w0 = box.width, result: SeatCandidate[] = [];
  const counts = { top: node.ports.filter(port => port.side === 'top').length, bottom: node.ports.filter(port => port.side === 'bottom').length };
  const excesses = { top: node.sidePitch?.top === undefined ? [] : engineExcess(node, 'top'), bottom: node.sidePitch?.bottom === undefined ? [] : engineExcess(node, 'bottom') };
  const low = Math.max(bounds.siblings.low, bounds.window.low, bounds.stops.low), high = Math.min(bounds.siblings.high, bounds.window.high, bounds.stops.high);
  // A body that becomes its interval grows: the siblings and the overlay walls bound it, as they bound a growth in place, and the group box grows with it.
  const growLow = Math.max(bounds.siblings.low, bounds.stops.low), growHigh = Math.min(bounds.siblings.high, bounds.stops.high);
  const inLimit = x0 >= bounds.siblings.low - EPS && x0 + w0 <= bounds.siblings.high + EPS;
  for (let i = 0; i < targets.length; i++) {
    let edgeLow = Infinity, edgeHigh = -Infinity, owed = 0, stoppedInPlace = false;
    const last: Partial<Record<'top' | 'bottom', SeatTarget>> = {};
    for (let j = i; j < targets.length; j++) {
      const target = targets[j]!, facePitch = node.sidePitch![target.side]!, before = last[target.side];
      // A face keeps its engine order at its pitch and its pair pitches; a window that breaks it breaks every wider window too.
      if (before !== undefined && !(target.index > before.index && target.x - before.x >= stepSpan(excesses[target.side], facePitch, before.index, target.index))) break;
      last[target.side] = target;
      const edges = alignedEdges(node, target.side, target.index, target.x, counts[target.side], facePitch);
      edgeLow = Math.min(edgeLow, edges.low); edgeHigh = Math.max(edgeHigh, edges.high);
      if (target.owes) owed++;
      // The overlay walls and the siblings bound each target's own edges in place, as `keptTargets` reads them.
      if (edges.low < bounds.stops.low - EPS || edges.high > bounds.stops.high + EPS || edges.low < bounds.siblings.low - EPS || edges.high > bounds.siblings.high + EPS) stoppedInPlace = true;
      const window = targets.slice(i, j + 1), keys = window.map(item => item.key).sort();
      const need = edgeHigh - edgeLow, holds = (width: number): boolean => cap(window, width);
      // The window the recorded seat keeps (`kept`) is that seat again, not a new decision: the main move or a neighbour carried the body off it,
      // and it goes back by a move bounded as a move+grow is, by the siblings and the walls, and the group box follows it.
      const recorded = bounds.kept !== undefined && bounds.kept.size > 0 && keys.length === bounds.kept.size && keys.every(key => bounds.kept!.has(key));
      const seat = (item: SeatCandidate): SeatCandidate => recorded ? { ...item, recorded } : item;
      if (need <= w0 + EPS) {
        // A body that holds the interval where it stands stays: the bounds of the row bound a move, not a body that does not move.
        const from = Math.max(edgeHigh - w0, recorded ? growLow : low), to = Math.min(edgeLow, (recorded ? growHigh : high) - w0), stays = x0 >= edgeHigh - w0 - EPS && x0 <= edgeLow + EPS;
        if (stays) result.push(seat({ keys, x: x0, width: w0, dx: 0, growth: 0, owed, inPlace: false }));
        else if (movable && (owed > 0 || recorded) && from <= to + EPS) {
          const x = Math.max(from, Math.min(x0, to));
          result.push(seat({ keys, x, width: w0, dx: x - x0, growth: 0, owed, inPlace: false }));
        }
      } else if (movable && (owed > 0 || recorded) && edgeLow >= growLow - EPS && edgeHigh <= growHigh + EPS) {
        // A seat the cap alone refuses is kept apart: its targets are the ones the cap declines (`seatNode`).
        (holds(need) ? result : capped).push(seat({ keys, x: edgeLow, width: need, dx: edgeLow - x0, growth: need - w0, owed, inPlace: false }));
      }
      // The growth in place: the body keeps its edges and reaches over the targets.
      const reachLow = Math.min(x0, edgeLow), width = Math.max(x0 + w0, edgeHigh) - reachLow;
      if (inLimit && !stoppedInPlace && width > w0 + EPS) (holds(width) ? result : capped).push(seat({ keys, x: reachLow, width, dx: 0, growth: width - w0, owed, inPlace: true }));
    }
  }
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= NO_MOVE_EPS;
  // The recorded seat is tried first among the seats that stand as many owed verticals and targets: a seat is decided again only for more.
  return result.sort((a, b) => b.owed - a.owed || b.keys.length - a.keys.length || Number(b.recorded === true) - Number(a.recorded === true)
    || (near(a.growth, b.growth) ? 0 : a.growth - b.growth) || (near(Math.abs(a.dx), Math.abs(b.dx)) ? 0 : Math.abs(a.dx) - Math.abs(b.dx))
    || Number(a.inPlace) - Number(b.inPlace) || (a.keys.join() < b.keys.join() ? -1 : a.keys.join() > b.keys.join() ? 1 : 0));
}

/**
 * Whether a target owes its seat a vertical, read the way the producer and every replay read it alike. A held cross chord owes none
 * (`owesVertical`), but a chord is held only once 7f has frozen the chords (`frozenChords`): before that the chord of a link is decided again
 * on every rebuild, and a seat that read it would rank its targets one way in the producer and another in the replay of a later stage. So
 * before the freeze every target owes its vertical.
 */
function seatOwes(model: LayoutModel, seats: ReadonlyMap<string, Feed>, links: ReadonlyMap<string, LayoutLink>, direct: ReadonlySet<string>): (key: string) => boolean {
  if (model.frozenChords === undefined) return () => true;
  return key => owesVertical(model, links.get(seats.get(key)!.link), direct);
}
/** The cap a seat of `node` keeps (`withinAlignmentCap`), from `from`: the width before its recorded seat, else the width where the seat begins. */
function seatCap(model: LayoutModel, node: LayoutNode, from: number): SeatCap {
  return (window, width) => withinAlignmentCap(model, node, (['top', 'bottom'] as const).filter(side => window.some(target => target.side === side)), { from, width });
}
/**
 * What a seat did: the targets it stands, its slide, the width the body had before it, and the targets the
 * cap declines (a seat that stands more owed verticals, or as many and more targets, than the one that stands was refused by the cap alone).
 */
interface SeatOutcome { kept: Set<string>; dx: number; from: number; capped: Set<string> }

/**
 * Seats one node of a centring step (ADR-0027): the seats of `seatCandidates`, best first, are made on the model one at a time, at most
 * `SEAT_TRIES`. A seat stands when every face keeps its targets (`alignSide`: the riser keep-out, the held chords of ports it packs) and, for a
 * seat that slides the body, the move guards hold: the node move (`holdsNodeMove`: the riser keep-out of its facing ports, the side lanes, the block
 * chords), each held chord that follows a moved port, and the reservations a resize keeps, read on the box the group fits (`seatRefusal`). A
 * refused seat is undone whole and the next one is tried; when every try is refused, the body stays and `ALIGNMENT_SEAT_REFUSED` names the
 * first guard that refused (R6). A target outside the seat is named by the step (`CENTRE_ALIGNMENT_INFEASIBLE`); one whose own edges reach an
 * overlay wall is named to `stopped`.
 */
function seatNode(model: LayoutModel, group: LayoutGroup, node: LayoutNode, wanted: ReadonlyMap<string, number>, owes: (key: string) => boolean,
  window: WideningLimit, stops: OverlayStops, stopped: (link: string) => void, links: ReadonlyMap<string, Feed>, warn: boolean, kept?: ReadonlySet<string>,
  recordedFrom?: number): SeatOutcome {
  // The width of a seated body is measured from the record (ADR-0027, clause 4): the width before its first seat, never a box an earlier pass grew.
  const box = node.bounds!, from = Math.min(box.width, recordedFrom ?? Infinity), none: SeatOutcome = { kept: new Set(), dx: 0, from, capped: new Set() };
  // A seat reads the geometry alone, never an earlier `cap` decline: the publication check replays it after the route rule has dropped the
  // record, and both must decide alike (R1). The decline records the last decision; the vertical tally reads it.
  const targets = seatTargets(node, wanted, owes);
  if (!targets.length) return none;
  // A body stage 5 seated (a stagger member, a feeding chain) or a grid cell keeps its place in the row; it aligns inside the width it may grow to.
  const movable = !isGridGroup(model, group.id) && !model.staggerRows?.some(row => row.group === group.id) && chainBlockOf(model, node.id) === undefined;
  const siblings = siblingLimit(model, group, node);
  const refusedByCap: SeatCandidate[] = [];
  const candidates = seatCandidates(node, targets, { siblings, window, stops, kept }, movable, seatCap(model, node, from), refusedByCap);
  const saved = JSON.stringify(node);
  const restore = (): void => {
    const copy = JSON.parse(saved) as LayoutNode;
    node.bounds = copy.bounds!; node.size = copy.size!; node.ports = copy.ports;
  };
  let evidence: ResizeEvidence | undefined, refusal: string | undefined, chosen: SeatCandidate | undefined, tries = 0;
  const fitted = (): Rect => { const was = group.bounds!; fitRegionGroup(model, group); const fit = group.bounds!; group.bounds = was; return fit; };
  for (const candidate of candidates) {
    if (tries === SEAT_TRIES) break;
    tries++;
    const moves = Math.abs(candidate.dx) > NO_MOVE_EPS;
    if (moves && evidence === undefined) evidence = { ...resizeEvidence(model, group), box: fitted() };
    const why = ((): string | undefined => {
      if (moves && !holdsNodeMove(model, group, [node.id], candidate.dx)) return 'node move';
      const held = moves ? heldChordPorts(model, node) : new Map<string, (x: number) => boolean>();
      if (moves) shiftNode(node, candidate.dx);
      for (const side of ['top', 'bottom'] as const) {
        const keys = candidate.keys.filter(key => targets.some(target => target.key === key && target.side === side));
        if (!keys.length) continue;
        const kept = alignSide(model, node, side, new Map(keys.map(key => [key, wanted.get(key)!])), siblings, stops, () => {},
          riserAvoidance(model, group.tier!, side), heldChordPorts(model, node), false);
        if (kept.size !== keys.length) return 'alignment';
      }
      if (!moves) return undefined;
      if (node.ports.some(port => port.anchor !== undefined && held.get(portId(port.ref))?.(port.anchor.x) === false)) return 'held chord';
      return seatRefusal(model, group, evidence!, fitted());
    })();
    if (why === undefined) { chosen = candidate; break; }
    restore();
    refusal ??= why;
  }
  // The overlay walls name the targets left out whose own edges reach them, as `keptTargets` names them.
  for (const target of targets) {
    if (chosen?.keys.includes(target.key)) continue;
    const pitch = node.sidePitch![target.side]!, edges = alignedEdges(node, target.side, target.index, target.x, node.ports.filter(port => port.side === target.side).length, pitch);
    if (edges.low < stops.low - EPS && stops.lowLink !== undefined) stopped(stops.lowLink);
    else if (edges.high > stops.high + EPS && stops.highLink !== undefined) stopped(stops.highLink);
  }
  // The cap declines the targets of the seats it alone refused that would stand more than the seat that stands (the most owed verticals, then the most targets).
  const owedNow = chosen?.owed ?? 0, countNow = chosen?.keys.length ?? 0;
  const capped = new Set(refusedByCap.filter(item => item.owed > owedNow || (item.owed === owedNow && item.keys.length > countNow))
    .flatMap(item => item.keys).filter(key => !chosen?.keys.includes(key)));
  if (chosen === undefined) {
    if (refusal !== undefined && warn) {
      const named = [...new Set(targets.map(target => links.get(target.key)?.link).filter((link): link is string => link !== undefined))].sort();
      placementWarning(model, SEAT_REFUSED, `${node.id} keeps its place and width: the ${refusal} refuses each seat it tried over its feeds; ${named.join(', ')} keep a jog and routing completes them.`, named);
    }
    return { ...none, capped };
  }
  return { kept: new Set(chosen.keys), dx: chosen.dx, from, capped };
}
/**
 * The pairs (frozen chord with an end in the group, foreign lane) whose box the chord touches, read on the anchors as they stand. The whole step is
 * measured with it, as the riser keep-out is: the clamp, `packClear`, `standNearFeed`, the row pack and the region fit move the group after the two local
 * guards below have looked, and a chord that follows its ports across a lane it cleared is refused by `validateLanes` at publication.
 */
export function chordLaneCrossings(model: LayoutModel, group: LayoutGroup): Set<string> {
  const result = new Set<string>();
  if (model.frozenChords === undefined) return result;
  const inside = new Set(group.nodes);
  for (const link of model.links) {
    if (!link.attachments || !isRoutedChord(model, link)) continue;
    const { from, to } = link.attachments, one = findPort(model, from)?.anchor, two = findPort(model, to)?.anchor;
    if (!one || !two || !(inside.has(from.node) || inside.has(to.node))) continue;
    for (const lane of model.lanes) {
      if (lane.owner.kind === 'link' && lane.owner.id === link.id) continue;
      if (segmentRectDistance({ from: one, to: two, owner: link.owner }, lane.bounds) < linkStrokeWidth(link) / 2 - EPS) result.add(`${link.id}|${lane.id}`);
    }
  }
  return result;
}
/** Whether every held routed chord with one end in the group still stands clear of the foreign lane boxes after the group moves `dx` in x. */
export function chordsClearAfterMove(model: LayoutModel, group: LayoutGroup, dx: number): boolean {
  // Before the freeze of 7f the chords are decided again on every rebuild; only a frozen chord follows its ports whatever they do.
  if (Math.abs(dx) <= EPS || model.frozenChords === undefined) return true;
  const inside = new Set(group.nodes);
  return model.links.every(link => {
    if (!link.attachments || !isRoutedChord(model, link)) return true;
    const { from, to } = link.attachments, one = findPort(model, from)?.anchor, two = findPort(model, to)?.anchor;
    if (!one || !two || inside.has(from.node) === inside.has(to.node)) return true;
    const segment = { from: inside.has(from.node) ? { x: one.x + dx, y: one.y } : one, to: inside.has(to.node) ? { x: two.x + dx, y: two.y } : two, owner: link.owner };
    // A chord end that stands inside a lane column is a move the passes undo (they seat the lane's child again); only a chord that crosses a column
    // between its ends is a move that stays.
    const within = (point: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }): boolean =>
      point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
    return model.lanes.every(lane => lane.owner.kind === 'link' && lane.owner.id === link.id || within(segment.from, lane.bounds) || within(segment.to, lane.bounds)
      || segmentRectDistance(segment, lane.bounds) >= linkStrokeWidth(link) / 2 - EPS);
  });
}
/** For each port of the node whose link holds a routed chord: whether the chord, with that port moved to x, still stands clear of every foreign lane box. */
export function heldChordPorts(model: LayoutModel, node: LayoutNode): Map<string, (x: number) => boolean> {
  const result = new Map<string, (x: number) => boolean>();
  if (model.frozenChords === undefined) return result;
  for (const link of model.links) {
    if (!link.attachments || !isRoutedChord(model, link)) continue;
    for (const [mine, other] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]] as const) {
      if (mine.node !== node.id) continue;
      const here = findPort(model, mine)?.anchor, there = findPort(model, other)?.anchor;
      if (!here || !there) continue;
      result.set(portId(mine), x => model.lanes.every(lane => lane.owner.kind === 'link' && lane.owner.id === link.id
        || segmentRectDistance({ from: { x, y: here.y }, to: there, owner: link.owner }, lane.bounds) >= linkStrokeWidth(link) / 2 - EPS));
    }
  }
  return result;
}
function geometry(model: LayoutModel): number[] {
  return Object.values(model.nodes).flatMap(node => [node.bounds!.x, node.bounds!.width, ...node.ports.map(port => port.anchor!.x)]);
}
/** The child columns stand against the parent cells beside them again; the anchor tier and the flanks keep their place in centring (idempotent, ticket 28). */
function settleRows(model: LayoutModel): boolean {
  return packBesideRows(model, cell => model.groups[cell]!.tier !== model.anchorTier && !model.groups[cell]!.flank);
}
/** Reusable bounded producer. The caller shares one budget across all ordered placement replay. */
export interface CentreContext {
  steps: { tier: number; authority: number }[];
  winners: Map<string, string>;
  groupOrder: Map<number, string[]>;
  limits: Map<string, { low: number; high: number }>;
  /** The flank window of each tier, measured once: 7c never moves or resizes a flank. */
  flankLimits: Map<number, WideningLimit>;
  /** The columns of the top-level frames when centring began: the wall no cell of a frame leaves (ticket 09). */
  columns: readonly FrameColumn[];
  /** The walls between the columns of one parent, when centring began (ticket 28). */
  walls: ReadonlyMap<string, CellWindow>;
}
/** Everything one centring pass reads but never writes: step order, winners, group order, lane windows. */
export function centreContext(model: LayoutModel, anchor: number, columns: readonly FrameColumn[] = frameColumns(model)): CentreContext {
  const tiers = model.tierBands.map(band => band.tier), index = tiers.indexOf(anchor);
  const plainSteps = [...tiers.slice(index + 1).map((tier, i) => ({ tier, authority: tiers[index + i]! })),
    ...tiers.slice(0, index).reverse().map((tier, i) => ({ tier, authority: tiers[index - i]! }))];
  // D-Q5 (S13): a push leaves bands that hold only lifted groups between a feeder and the units it fed before the push. A tier whose
  // authority is such a band is centred once more on the nearest band toward the anchor that holds a group that did not lift, so a vertical
  // feed across the pushed bands stays vertical (the feed is reserved here, at placement).
  const lifted = liftedGroups(model);
  const liftOnly = (tier: number): boolean => lifted.size > 0 && model.tierBands.some(band => band.tier === tier && band.groups.length > 0
    && band.groups.every(id => lifted.has(id) || model.groups[id]?.flank !== undefined));
  const steps = plainSteps.flatMap(step => {
    if (liftOnly(step.tier) || !liftOnly(step.authority)) return [step];
    const at = tiers.indexOf(step.authority), dir = at > tiers.indexOf(step.tier) ? 1 : -1;
    let far = at;
    while (far >= 0 && far < tiers.length && liftOnly(tiers[far]!) && tiers[far] !== anchor) far += dir;
    return far >= 0 && far < tiers.length ? [step, { tier: step.tier, authority: tiers[far]! }] : [step];
  });
  const winners = new Map<string, string>();
  for (const step of steps) for (const feed of [...centringFeeds(model, step.tier, step.authority)].sort((a, b) => model.nodes[a.child.ref.node]!.bounds!.x - model.nodes[b.child.ref.node]!.bounds!.x || portId(a.child.ref).localeCompare(portId(b.child.ref)))) {
    const key = `${step.tier}:${feed.key}`;
    if (!winners.has(key)) winners.set(key, portId(feed.child.ref));
  }
  const groupOrder = new Map(steps.map(step => [step.tier, Object.values(model.groups).filter(group => group.tier === step.tier && !group.flank)
    .sort((a, b) => a.bounds!.x - b.bounds!.x).map(group => group.id)]));
  // Preserve which side of each fixed lane contains each group.
  const limits = new Map<string, { low: number; high: number }>();
  for (const group of Object.values(model.groups)) {
    let low = -Infinity, high = Infinity;
    for (const lane of model.lanes.filter(lane => lane.tier === group.tier)) {
      if (group.bounds!.x >= lane.x) low = Math.max(low, right(lane.bounds)); else high = Math.min(high, lane.bounds.x);
    }
    limits.set(group.id, { low, high });
  }
  const flankLimits = new Map<number, WideningLimit>(model.tierBands.map(band => [band.tier, { low: -Infinity, high: Infinity }]));
  for (const flank of Object.values(model.groups)) {
    const limit = flank.flank && flankLimits.get(flank.tier!);
    if (!limit) continue;
    if (flank.flank!.align === 'left') limit.low = Math.max(limit.low, right(flank.bounds!) + bandGap(model));
    else limit.high = Math.min(limit.high, flank.bounds!.x - bandGap(model));
  }
  return { steps, winners, groupOrder, limits, flankLimits, columns, walls: besideWalls(model) };
}
/**
 * The window a group of `tier` may never leave. A fixed lane of 7a stays on the side that holds it,
 * and a flank beside the tier keeps its band gap. The window holds the box of the group and the
 * stroke-aware reach of its nodes and pills, which `validateLanes` measures as well.
 */
function reservedWindow(model: LayoutModel, context: CentreContext, tier: number, id: string): WideningLimit {
  const limit = context.limits.get(id)!, flank = context.flankLimits.get(tier) ?? { low: -Infinity, high: Infinity };
  const column = columnWindow(model, context, tier, id);
  const low = Math.max(limit.low, flank.low), high = Math.min(limit.high, flank.high);
  // An unbounded window needs no measurement, and measuring one costs a pass over the group.
  if (low === -Infinity && high === Infinity) return column;
  const reach = occupiedOverhang(model, model.groups[id]!);
  return { low: Math.max(low + reach.left, column.low), high: Math.min(high - reach.right, column.high) };
}

/** How many frames hold the frame of a rank cell: 0 for a cell of a top-level frame. */
function frameDepth(model: LayoutModel, id: string): number {
  const frames = model.document.frames ?? {};
  let depth = 0;
  for (let frame = frames[model.groups[id]!.frame ?? '']?.parent; frame !== undefined; frame = frames[frame]?.parent) depth++;
  return depth;
}

/**
 * The window the columns of the frames of a tier leave a group (ranked-groups ticket 09). A rank cell
 * stays inside the column of its frame: the box of the cell, and the reach `cellReach` gives its
 * bodies and pills, lie between the column edges. Any other group stays `besideGap` out of the column of every
 * frame that spans its sub-tier, on the side it stands on (the gap G9 reads, ticket 75). Unbounded for a tier with no frame.
 */
function columnWindow(model: LayoutModel, context: CentreContext, tier: number, id: string): WideningLimit {
  const group = model.groups[id]!, box = group.bounds!;
  const own = context.columns.find(column => column.cells.has(id));
  if (own) {
    // A child frame stands inside its parent's box with the group margin to spare, at every level.
    const reach = cellReach(model, id), inset = GROUP_PADDING * frameDepth(model, id);
    const wall = context.walls.get(id) ?? { low: -Infinity, high: Infinity };
    // A member of a canton is walled by the canton frame box, not the column: a member that spent the slack would grow the box by it,
    // and every replay would read the grown box and spend it again (canton-groups ticket 56).
    // A member above the anchor tier may stand past the canton wall up to the aligned extent it reserved (architecture-2 ticket 31): the canton
    // grows with it. `memberRoom` is the one reader of the member wall; the pull of 7f and the chord step call it too.
    const room = own.wall === undefined ? { low: own.x + inset, high: own.x + own.width - inset } : memberRoom(model, own.wall, reach, [id], inset);
    return { low: Math.max(wall.low, room.low + (box.x - reach.x)), high: Math.min(wall.high, room.high - (reach.x + reach.width - (box.x + box.width))) };
  }
  const window = { low: -Infinity, high: Infinity };
  if (!context.columns.some(column => column.from <= tier && tier <= column.to)) return window;
  // A plain group keeps `besideGap` from the column edge: the frame may spend its room up to that edge (R1, the gap gate G9 reads).
  const reach = occupiedOverhang(model, group), centre = box.x + box.width / 2, gap = besideGap(model, true, false);
  for (const column of context.columns.filter(item => item.from <= tier && tier <= item.to)) {
    if (centre < column.x + column.width / 2) window.high = Math.min(window.high, column.x - gap - reach.right);
    else window.low = Math.max(window.low, column.x + column.width + gap + reach.left);
  }
  return window;
}

/**
 * The rightmost edge a group of `tier` may take before the groups after it have nowhere to go.
 * A widening makes them give way (`packClear`), but they never cross a reserved lane or a flank.
 * One backwards sweep packs them against their own windows and reserves the room that needs.
 * Space before use: a widening this room cannot hold is declined here. It is not discovered as an
 * overlap at stage 8.
 */
/**
 * The right edge a later group may reach before the move guard (`laneSidesHold`) refuses to clear it (`rightWallReach`: per lane wall, with the
 * occupied reach the guard measures toward that lane). The tail reads it so that a step never takes room `packClear` cannot give back (ticket DR-04:
 * two sibling boxes overlapped at publication).
 */
function guardWall(model: LayoutModel, id: string): number {
  return rightWallReach(model, model.groups[id]!);
}
function tailReservation(model: LayoutModel, context: CentreContext, tier: number, order: string[]): Map<string, number> {
  const result = new Map<string, number>();
  let bound = Infinity;
  // The step of one group never moves or resizes the groups after it. One sweep therefore stays
  // exact for the whole tier step. It costs one pass over the groups of the tier.
  for (const id of [...order].reverse()) {
    result.set(id, bound);
    bound = Math.min(bound, reservedWindow(model, context, tier, id).high, guardWall(model, id)) - model.groups[id]!.bounds!.width - bandGap(model);
  }
  return result;
}

/**
 * Keep the tier packed left to right. Centring widens a group into the space of the groups after
 * it. Those groups must give way, also when this step does not centre them, and when their own
 * centring window is too narrow to hold them. Two overlapping group boxes are not a poor diagram.
 * They are an input stage 8 refuses, because a foreign group obstacle then contains an attachment
 * shape.
 */
function packClear(model: LayoutModel, context: CentreContext, tier: number, group: LayoutGroup, previous: LayoutGroup | undefined): void {
  if (!previous) return;
  const window = reservedWindow(model, context, tier, group.id);
  const low = Math.max(window.low, right(previous.bounds!) + bandGap(model));
  if (group.bounds!.x >= low - EPS) return;
  const bounds = { ...group.bounds!, x: low };
  // A forced move: it passes the lane sides but not the side-lane frame guard (the riser keep-out is exempt the same way).
  if (low + group.bounds!.width > window.high + EPS || !laneSidesHold(model, [{ group, bounds }], true, false)) {
    placementWarning(model, 'CENTRE_TIER_PACK_INFEASIBLE',
      `${group.id} cannot clear ${previous.id} inside its reserved lane and flank window; the final gates judge the result.`,
      [group.id], 'group');
    return;
  }
  moveGroup(model, group, low - group.bounds!.x, 0);
}

/**
 * A declined group stands where the feeds want it inside its wall, not where the pack left it (ranked-groups ticket 70). The column pull
 * (`slideRange`) reads the room up to the far wall and takes it toward the feed; a decline that only packed the group clear at the near wall
 * left that room to the pull, which then moved a finished layout. Centring and the pull now put the group at the same in-window x when the pull's
 * feed set equals centring's (ticket 74 files the cases where they differ), so the pull finds nothing to do. The target is clamped at the overlay
 * chords as the main move is (`overlayStops`, ticket 29). `target` is the x the mean of the feeds asks for, read from where the step began.
 */
function standNearFeed(model: LayoutModel, context: CentreContext, tier: number, id: string, group: LayoutGroup, target: number, wideLow: number, wideHigh: number): void {
  const box = group.bounds!;
  // The bounds were computed on the widened group; the restored group stands in a fresh window.
  const window = reservedWindow(model, context, tier, id), low = Math.max(wideLow, window.low), high = Math.min(wideHigh, window.high);
  if (!standsInCanton(model, group) || !Number.isFinite(target) || box.width > high - low + EPS) return;
  const dx = Math.max(low, Math.min(target, high - box.width)) - box.x;
  if (Math.abs(dx) <= EPS || !holdsMove(model, [{ group, bounds: { ...box, x: box.x + dx } }])) return;
  moveGroup(model, group, dx, 0);
}

/** How many targets of a face stand in engine order at the face's pitch: the in-order keep of `keptTargets` without its limits, cap or stops. */
function inOrderTargets(node: LayoutNode, side: Side, targets: ReadonlyMap<string, number>): number {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!), pitch = node.sidePitch![side]!;
  const excess = engineExcess(node, side, pitch);
  let last: { index: number; x: number } | undefined, count = 0;
  for (const [index, port] of ports.entries()) {
    const x = targets.get(portId(port.ref));
    if (x !== undefined && (!last || x - last.x >= stepSpan(excess, pitch, last.index, index))) { last = { index, x }; count++; }
  }
  return count;
}
/**
 * The feeds of one group in one step, with the x each child port wants and the transits that yield. A child port has one seat (architecture ticket 12):
 * a port fed by two parents at different x seats under the feed its face keeps with the most of its siblings' seats, ties and a lone port to the first
 * feed, and the other feeds are fan remainders that pull nothing and grow nothing. `seats` names the feed each seat is read from.
 */
function groupFeeds(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, warn: boolean): { own: Feed[]; wanted: Map<string, number>; yielded: Set<Feed>; seats: Map<string, Feed>; conflicts: Set<string> } {
  const own = list.filter(feed => model.document.nodes[feed.child.ref.node]!.group === id);
  // Adjacent feeds first: a transit yields to any other feed of the same child port instead of
  // contesting it, so a fan of lanes into one port cannot exhaust the shared budget.
  const yielded = new Set<Feed>(), seats = new Map<string, Feed>(), rival = new Map<string, Feed[]>(), conflicts = new Set<string>();
  const wide = keptWide(model);
  const remainder = (feed: Feed): void => {
    yielded.add(feed);
    if (warn) placementWarning(model, 'CENTRE_FAN_REMAINDER', `${feed.link} shares its child port with a feed at another x; that feed owns vertical alignment.`, [feed.link]);
  };
  for (const feed of [...own].sort((a, b) => Number(a.transit) - Number(b.transit))) {
    const child = portId(feed.child.ref);
    if (context.winners.get(`${tier}:${feed.key}`) !== child) {
      if (warn) placementWarning(model, 'CENTRE_FAN_REMAINDER', `${feed.link} shares a parent port; the first child by x owns vertical alignment.`, [feed.link]);
      continue;
    }
    const seat = seats.get(child);
    if (!seat) { seats.set(child, feed); continue; }
    if (seat.x === feed.x) continue;
    if (feed.transit) remainder(feed);
    else if (wide) conflicts.add(child);
    else rival.set(child, [...(rival.get(child) ?? [seat]), feed]);
  }
  // The rivals of a seat are read in an order of the drawing, never of `links` (R3, ticket DR-04): a feed from a bar first, because 7d shapes
  // the bar under the port wherever it stands and a port over another feed would stand the bar over that feed's node; then by x.
  const onBar = (feed: Feed): number => model.document.groups[model.document.nodes[feed.parent.ref.node]!.group]!.shape === 'bar' ? 0 : 1;
  for (const [child, list] of rival) {
    const candidates = [...list].sort((a, b) => onBar(a) - onBar(b) || a.x - b.x || a.key.localeCompare(b.key));
    const first = candidates[0]!, node = model.nodes[first.child.ref.node]!, side = first.child.side!;
    const others = new Map<string, number>();
    for (const [key, feed] of seats) if (key !== child && !rival.has(key) && feed.child.ref.node === node.id && feed.child.side === side) others.set(key, feed.x);
    let best = first, bestCount = -1;
    if (others.size) {
      // Read from the order and the pitch of the face alone, never from the bounds: the producer reads the face before the step and the validator after it,
      // and both must pick one seat (the widened body would let a rival fit that did not fit before).
      for (const candidate of candidates) {
        const count = inOrderTargets(node, side, new Map([...others, [child, candidate.x]]));
        if (count > bestCount) { best = candidate; bestCount = count; }
      }
    }
    seats.set(child, best);
    for (const feed of candidates) if (feed.x !== best.x) remainder(feed);
  }
  const links = linkById(model);
  const wanted = new Map<string, number>();
  for (const [child, feed] of seats) {
    // A solid block owns its face capacity; its feeds centre the row but never stretch a body.
    if (links.get(feed.link)?.solidBlock !== true) wanted.set(child, feed.x);
  }
  return { own, wanted, yielded, seats, conflicts };
}
/**
 * The offset a group step centres on: the mean of the distinct parent x less the mean of the distinct child x of its chosen feeds. Summed in
 * ascending order (R3): a floating-point sum taken in feed order, which is link order, moves the group by a different last bit when the links
 * are listed otherwise.
 */
function centringOffset(chosen: readonly Feed[]): number {
  const mean = (values: Iterable<number>): number => { const xs = [...values].sort((a, b) => a - b); return xs.reduce((sum, x) => sum + x, 0) / xs.length; };
  return mean(new Map(chosen.map(feed => [feed.key, feed.x])).values()) - mean(new Map(chosen.map(feed => [portId(feed.child.ref), feed.child.anchor!.x])).values());
}
/**
 * The feeds a group step centres on, and the offset its main move takes toward them (`centringOffset`), as the step reads them: undefined for a
 * group the step does not centre (a bar, or a group with no feed of its own).
 */
function ownCentring(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string): { own: Feed[]; chosen: Feed[]; offset: number; verticals: number } | undefined {
  if (model.document.groups[id]!.shape === 'bar') return undefined;
  const { own, yielded } = groupFeeds(model, context, tier, list, id, false);
  if (!own.length) return undefined;
  const chosen = moveBeforeGrow(model) ? seatedFeeds(model, chosenFeeds(context, tier, own, yielded)) : chosenFeeds(context, tier, own, yielded);
  // The child ports whose feed may own a vertical (the first child by x of its parent port, not yielded): a fan remainder can stand no drop straight.
  const owning = chosen.filter(feed => context.winners.get(`${tier}:${feed.key}`) === portId(feed.child.ref) && !yielded.has(feed));
  return { own, chosen, offset: centringOffset(chosen), verticals: new Set(owning.map(feed => portId(feed.child.ref))).size };
}
/**
 * The seat of the centred groups of one row (dense-16x9 ticket 27): the least-absolute-deviations solution of "each group at the x its own feeds
 * want" under the order of the row and the band gap between neighbours. Each group alone wants its box at `x + centringOffset`, which does not
 * depend on where the group stands. Pool adjacent violators: a run of groups whose wanted boxes would overlap is seated as one unit on the
 * weighted median of what its members want, so the packing no longer stacks such a row to one side of its feeds (the first group at its mean,
 * the others to its right). The median, not the mean: a drop is straight or bent, and its slant does not count, so the unit keeps one member at
 * its own feeds (the heaviest side holds), and a run of equal members stands centred, its middle member at the common mean. When the weight
 * splits evenly, every value of the median interval is a median; the tie rule takes the end at which the member that comes first in the row
 * stands on its own feeds. The weight of a group is the number of
 * its wanted child ports whose feed may own a vertical (a fan remainder may not): each such drop is straight only at the group's own x; the
 * width of a box is no part of a drop, and a group with no such port pulls the unit nowhere.
 * A run holds only groups fed by the same parent nodes (the parents of all the group's own feeds): those are the groups that pile up on one
 * feed mean. Groups fed by different parents that the packing pushes together keep the old pack (measured on the corpus: pooling every packed
 * run moved 55 sheets and bent links on 17 of them, because the unit moved a group off feeds it stood straight on). A run is also broken by a
 * group the step does not centre, by a rank cell (its frame column holds it), and between groups that a lane of 7a parts (different lane
 * windows). Returns the pooled box x of each group the unit moves off its own wanted x; a member at its own x, and a group alone,
 * take their own offset, as before. The row's slack and every bound are the step's: the main move stops at the overlay walls, the clamp takes the
 * window (lanes, flanks, frame columns, the group before it, the tail the groups after it reserve), and every guard of the step holds as it does for
 * a group's own mean. Read in group order, a geometric order (R3); a tie of values in the median is broken by that order.
 */
function rowSeats(model: LayoutModel, context: CentreContext, tier: number, list: Feed[]): Map<string, number> {
  const order = context.groupOrder.get(tier)!, gap = bandGap(model), seats = new Map<string, number>();
  type Item = { id: string; want: number; width: number; weight: number; parents: string };
  let run: Item[] = [], window = '', feeding = '';
  /**
   * The weighted median of `values`: the first value, in ascending order and then group order, at which half the weight is reached. When the
   * weight splits evenly there, that value and the next bound the median interval, and the tie rule takes the end that belongs to the member that
   * comes first in the row (`at`): that member stands on its own feeds. The lower end alone measured worse: on `own-lane-is-an-obstacle` it put
   * the second group on its feeds, and the first group's two drops bent and crossed (2 to 4 bends, 0 to 1 crossing).
   */
  const median = (values: readonly { value: number; weight: number; at: number }[]): number => {
    const sorted = [...values].sort((p, q) => p.value - q.value || p.at - q.at), half = sorted.reduce((sum, item) => sum + item.weight, 0) / 2;
    let below = 0;
    for (const [index, item] of sorted.entries()) {
      below += item.weight;
      if (below < half - PLACEMENT_EPS) continue;
      // An even split: every value between this one and the next is a median. The member that comes first in the row keeps its own feeds.
      const next = sorted[index + 1];
      return below <= half + PLACEMENT_EPS && next !== undefined && next.at < item.at ? next.value : item.value;
    }
    return sorted[sorted.length - 1]!.value;
  };
  const flush = (): void => {
    if (run.length > 1) {
      // In the coordinates `want - before`, where `before` is the room the groups ahead of a group take with their gaps, the order constraint is
      // monotonicity, and the pooled blocks are its least-absolute-deviations fit.
      const blocks: { members: { value: number; weight: number; at: number }[]; value: number }[] = [];
      let before = 0;
      for (const [at, item] of run.entries()) {
        let block = { members: [{ value: item.want - before, weight: item.weight, at }], value: item.want - before };
        before += item.width + gap;
        while (blocks.length && blocks[blocks.length - 1]!.value > block.value + PLACEMENT_EPS) {
          const members = [...blocks.pop()!.members, ...block.members];
          block = { members, value: median(members) };
        }
        blocks.push(block);
      }
      for (const block of blocks) {
        if (block.members.length < 2) continue;
        for (const { at } of block.members) {
          let x = block.value;
          for (let i = 0; i < at; i++) x += run[i]!.width + gap;
          if (Math.abs(x - run[at]!.want) > PLACEMENT_EPS) seats.set(run[at]!.id, x);
        }
      }
    }
    run = [];
  };
  for (const id of order) {
    const read = context.columns.some(column => column.cells.has(id)) ? undefined : ownCentring(model, context, tier, list, id);
    if (read === undefined) { flush(); window = ''; feeding = ''; continue; }
    const limit = context.limits.get(id)!, key = `${limit.low}|${limit.high}`;
    // Only groups fed by the same parent nodes pile up on one feed mean: a run is broken where the set of parents changes.
    const parents = [...new Set(read.own.map(feed => feed.parent.ref.node))].sort().join('|');
    if (key !== window || parents !== feeding) flush();
    window = key; feeding = parents;
    const box = model.groups[id]!.bounds!;
    run.push({ id, want: box.x + read.offset, width: box.width, weight: read.verticals, parents });
  }
  flush();
  return seats;
}
/**
 * The offset the main move of the step of group `id` takes: toward the seat of its row (`rowSeats`) when the group stands in a pooled run, else
 * toward the mean of its own chosen feeds. The seats are read once per tier, where the tier stands when its steps begin, as the tail reservation
 * is: a step never moves the groups after it, so each later step begins where the seats were read, and a grown body of an earlier step changes
 * the seats only at the next pass. The passes of 7c, their replays in 7f and the publication check read them the same way (R1).
 */
function stepOffset(model: LayoutModel, id: string, chosen: readonly Feed[], seats: ReadonlyMap<string, number>): number {
  const seat = seats.get(id);
  return seat === undefined ? centringOffset(chosen) : seat - model.groups[id]!.bounds!.x;
}
/**
 * The feeds the main move of a step centres on while seats stand (ADR-0027: the seat owns the body). A node the record seats on at least one
 * port of a node feed pulls the group only through the feeds of its kept ports: a feed its seat left out (the cap, the order of the face, the
 * row) would carry the body off the feeds it stands, pass after pass. A seat on transit-lane ports alone holds nothing: a lane follows its
 * child. Before the centre rule writes the record, a node that stands a feed where the step begins pulls only through the feeds it stands.
 * When no feed is left, the step centres on all of them.
 */
function seatedFeeds(model: LayoutModel, chosen: readonly Feed[]): Feed[] {
  const record = model.alignmentSeats;
  const stands = (feed: Feed): boolean => feed.child.anchor !== undefined && Math.abs(feed.child.anchor.x - feed.x) <= 0.5;
  const standing = new Set(chosen.filter(stands).map(feed => feed.child.ref.node));
  const pulling = chosen.filter(feed => {
    const node = feed.child.ref.node;
    if (record === undefined) return !standing.has(node) || stands(feed);
    const seat = Object.hasOwn(record, node) ? record[node] : undefined;
    const holds = seat !== undefined && chosen.some(other => other.child.ref.node === node && !other.transit && seat.ports.includes(portId(other.child.ref)));
    return !holds || seat.ports.includes(portId(feed.child.ref));
  });
  return pulling.length ? pulling : [...chosen];
}
/** The feeds a group step centres on: the ones that may own an alignment. A fan remainder and a yielded transit would only pull the group away from the x its child is aligned to. */
function chosenFeeds(context: CentreContext, tier: number, own: Feed[], yielded: ReadonlySet<Feed>): Feed[] {
  const vertical = own.filter(feed => context.winners.get(`${tier}:${feed.key}`) === portId(feed.child.ref) && !yielded.has(feed));
  return vertical.length ? vertical : own;
}
/**
 * The aligned extent of each canton member just above the anchor tier (architecture-2 ticket 31, `LayoutModel.alignedExtents`). The canton
 * column of such a member is only as wide as the anchor row of its canton, and the member aligned over that row needs its end-port insets
 * and its side-face pills beyond the outer feeds. That room is known before the first step, so it is reserved here; the clamp of a step
 * never discovers it. Decided once, in the centre rule only: a later run, a replay and the publication check read the record. A replay of a
 * later rule that finds no record in a model with a canton reserves nothing (the canton walls hold) and says so (R6): it would decide on
 * geometry the passes have moved.
 */
const CENTRE_RULE_INPUT: LayoutStage = 'flanks';
function reserveAlignedExtents(model: LayoutModel, context: CentreContext): void {
  if (model.alignedExtents !== undefined || !Object.values(model.document.frames ?? {}).some(frame => frame.kind === 'canton')) return;
  // The centre rule runs on the model the flanks rule published: its stage marker is still `flanks` (`mutation.ts`, `stages`).
  if (model.stage !== CENTRE_RULE_INPUT) {
    if (!model.diagnostics.some(d => d.code === 'ALIGNED_EXTENTS_UNDECIDED')) {
      placementWarning(model, 'ALIGNED_EXTENTS_UNDECIDED', `The centre rule recorded no aligned extents for the canton members; this centring at stage ${model.stage} reserves none and the canton walls hold.`, []);
    }
    return;
  }
  const anchor = model.anchorTier!, extents: NonNullable<LayoutModel['alignedExtents']> = {};
  const step = context.steps.find(item => item.authority === anchor && item.tier < anchor);
  if (step !== undefined) {
    const list = centringFeeds(model, step.tier, anchor);
    for (const id of context.groupOrder.get(step.tier)!) {
      const extent = alignedExtentOf(model, context, step.tier, list, id);
      if (extent !== undefined) extents[id] = extent;
    }
  }
  model.alignedExtents = extents;
}
/**
 * The box a step would give a canton member: the group moved under the mean of its feeds, as the main move of the step does, then each body
 * grown to the targets the alignment keeps (`keptTargets`, the alignment's own bounds: the row siblings, the alignment cap and the
 * overlay stops), with the margins and side-face pills the box has beyond its bodies. Each edge is stored against the outer feed port on its
 * side. `undefined` for a group that is not a canton member, has a feed from outside its canton or a transit feed (those feeds do not move
 * with the canton), or keeps no target.
 */
function alignedExtentOf(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string): { low: AlignedExtentEdge; high: AlignedExtentEdge } | undefined {
  const group = model.groups[id]!, column = context.columns.find(item => item.cells.has(id));
  if (column?.wall === undefined || model.document.groups[id]!.shape === 'bar') return undefined;
  const { own, wanted, yielded, seats } = groupFeeds(model, context, tier, list, id, false);
  if (!seats.size || [...seats.values()].some(feed => feed.transit || !column.cells.has(model.document.nodes[feed.parent.ref.node]!.group))) return undefined;
  // The main move of the step, read with the step's own readers (`centringOffset`, `farthest`, `mainMove`). Precondition: this runs once, at the
  // first centring run, before any step. No body has grown yet, so the overlay walls do not bound the move, and the move read here is the one
  // the first step takes. A later run would read a group the passes have moved, and the record is not read again there.
  const walls = new Map(group.rowOrder!.map(node => [node, overlayStops(model, model.nodes[node]!)]));
  const { farthestLeft, farthestRight } = farthest(model, walls);
  const dx = mainMove(model, group, farthestLeft, farthestRight, centringOffset(chosenFeeds(context, tier, own, yielded)));
  let bodyLow = Infinity, bodyHigh = -Infinity, grownLow = Infinity, grownHigh = -Infinity, kept = false;
  const box = group.bounds!, seated = moveBeforeGrow(model);
  const inset = seated ? groupInsets(model, group) : undefined, owes = seated ? seatOwes(model, seats, linkById(model), directMembers(model)) : undefined;
  const movable = !isGridGroup(model, id) && !model.staggerRows?.some(row => row.group === id);
  for (const nodeId of group.rowOrder!) {
    const node = model.nodes[nodeId]!, body = node.bounds!;
    bodyLow = Math.min(bodyLow, body.x); bodyHigh = Math.max(bodyHigh, right(body));
    const moved: LayoutNode = { ...node, bounds: { ...body, x: body.x + dx }, ports: node.ports.map(port => ({ ...port, anchor: { ...port.anchor!, x: port.anchor!.x + dx } })) };
    const limit = siblingLimit(model, group, node);
    if (!seated) {
      // The default: each body grown in place to the targets the alignment keeps.
      const targets = keptTargets(model, moved, 'bottom', wanted, { low: limit.low + dx, high: limit.high + dx }, overlayStops(model, moved));
      grownLow = Math.min(grownLow, body.x + dx); grownHigh = Math.max(grownHigh, right(body) + dx);
      if (!targets.length) continue;
      kept = true;
      const pitch = node.sidePitch!.bottom!, count = node.ports.filter(port => port.side === 'bottom').length, first = targets[0]!, last = targets[targets.length - 1]!;
      grownLow = Math.min(grownLow, alignedEdges(node, 'bottom', first.index, first.x, count, pitch).low);
      grownHigh = Math.max(grownHigh, alignedEdges(node, 'bottom', last.index, last.x, count, pitch).high);
      continue;
    }
    // The seat the step would take for the bottom face (ADR-0027), in the window the step gives a seat: the group box less its insets, moved
    // with the group. The window of the step is the one this extent reserves, so it is not read here.
    const seat = seatCandidates(moved, seatTargets(moved, wanted, owes!, ['bottom']), { siblings: { low: limit.low + dx, high: limit.high + dx },
      window: { low: box.x + dx + inset!.left, high: right(box) + dx - inset!.right }, stops: overlayStops(model, moved) }, movable && chainBlockOf(model, nodeId) === undefined,
    seatCap(model, moved, moved.bounds!.width))[0];
    // A seat holds the body: a slide leaves the place the body had, a growth in place keeps it inside.
    const seatLow = seat?.x ?? body.x + dx, seatHigh = seat === undefined ? right(body) + dx : seat.x + seat.width;
    grownLow = Math.min(grownLow, seatLow); grownHigh = Math.max(grownHigh, seatHigh);
    if (seat !== undefined) kept = true;
  }
  if (!kept) return undefined;
  // The outer feeds by x; the port id breaks a tie (R3).
  const feeds = [...seats.values()].sort((a, b) => a.x - b.x || portId(a.parent.ref).localeCompare(portId(b.parent.ref)));
  const lowFeed = feeds[0]!, highFeed = feeds[feeds.length - 1]!;
  return { low: { port: lowFeed.parent.ref, offset: grownLow - (bodyLow - box.x) - lowFeed.x },
    high: { port: highFeed.parent.ref, offset: grownHigh + (right(box) - bodyHigh) - highFeed.x } };
}
const SPREAD_DECLINED = 'PARENT_SPREAD_DECLINED';
/** Names a parent that keeps its ports at pitch over its children, why, and the links that align on the child side instead (R6). */
function declineSpread(model: LayoutModel, node: string, links: readonly string[], why: string): undefined {
  const sorted = [...links].sort(), message = `${node} keeps its ports at pitch over its children: ${why}; ${sorted.join(', ')} align on the child side.`;
  if (!model.diagnostics.some(d => d.code === SPREAD_DECLINED && d.message === message)) {
    model.diagnostics.push({ stage: 'placement', severity: 'warning', code: SPREAD_DECLINED, message,
      owners: [{ kind: 'node', id: node }, ...sorted.map(id => ({ kind: 'link' as const, id }))] });
  }
  return undefined;
}
/**
 * A parent below the anchor tier spreads its ports over its children (architecture-2 ticket 32, Q120). Below the anchor tier a child group
 * is centred under its feeds, and its ports align under the parent ports. Where the fed bottom ports of a parent stand closer together than
 * the top ports of its children can, the child side alone cannot align: its nodes cannot stand closer than a row gap. The parent therefore
 * moves its ports, once, before the first step: each fed port goes to the spacing of its child, about the mean of the fed ports. The body
 * grows by the deficit and no further, and the row neighbours move away by the growth on their side.
 *
 * Decided once, in the centre rule only (its input stage, `flanks`), and stored (`parentSpreads`). While the centre rule runs, `{}` says it
 * decided that no parent spreads, so the later runs of the passes on that model (after a wall move is given back) do not decide again. The
 * wide twin of the rule is a copy taken before the first run: it decides once on its own copy, from the same geometry. `centre` drops an
 * empty record when it ends, so after the centre rule absent and `{}` both mean that no parent spread (a sheet that spreads nothing keeps the
 * bytes it had). A later run, a replay and the publication check read the geometry the spread left and never decide again. Returns whether a
 * parent spread.
 */
function reserveParentSpreads(model: LayoutModel, context: CentreContext, columns: readonly FrameColumn[]): boolean {
  const anchor = model.anchorTier!, below = context.steps.filter(step => step.authority > anchor);
  if (model.parentSpreads !== undefined || !below.length || model.stage !== CENTRE_RULE_INPUT) return false;
  const spreads: NonNullable<LayoutModel['parentSpreads']> = {};
  // The deepest parent tier first: a spread moves the row of its parent, and that row holds the children the tier above spreads over.
  for (const { tier, authority } of [...below].sort((a, b) => b.authority - a.authority)) {
    for (const plan of spreadPlans(model, tier, authority)) {
      const spread = spreadParent(model, centreContext(model, anchor, columns), tier, authority, plan);
      if (spread !== undefined) spreads[plan.node] = spread;
    }
  }
  model.parentSpreads = spreads;
  return Object.keys(spreads).length > 0;
}
/**
 * The parents of one step that spread (`reserveParentSpreads`), each with the feeds it spreads, in the order of its bottom ports. A feed
 * spreads when it is adjacent (no transit), its link is no bundle member and no mesh bus, its parent port feeds no other child of the step
 * (a fan port stands over its first child, ticket 20), and no other parent feeds its child node (a complete block, the X: the child cannot
 * stand under two parents, so neither spreads over it). A parent in a bar, a flank or a grid keeps its ports: 7d owns the bar, and a grid
 * keeps its columns. A parent with at least two such feeds whose children stand further apart than its ports by more than half a pixel
 * somewhere spreads when the children stand in one group and in the order of its ports; otherwise it keeps its ports and is named (R6).
 * Ordered by the x of the parent, then its id (R3).
 */
function spreadPlans(model: LayoutModel, tier: number, authority: number): { node: string; feeds: Feed[] }[] {
  const list = centringFeeds(model, tier, authority), links = linkById(model);
  const groupOf = (node: string): string => model.document.nodes[node]!.group;
  const fixed = (node: string): boolean => { const group = groupOf(node); return model.document.groups[group]!.shape === 'bar' || Boolean(model.groups[group]!.flank) || isGridGroup(model, group); };
  const portFeeds = new Map<string, number>(), parentsOf = new Map<string, Set<string>>(), byParent = new Map<string, Feed[]>();
  for (const feed of list) {
    portFeeds.set(feed.key, (portFeeds.get(feed.key) ?? 0) + 1);
    parentsOf.set(feed.child.ref.node, (parentsOf.get(feed.child.ref.node) ?? new Set()).add(feed.parent.ref.node));
    if (!feed.transit && nodeTier(model, feed.parent.ref.node) === authority) byParent.set(feed.parent.ref.node, [...(byParent.get(feed.parent.ref.node) ?? []), feed]);
  }
  const plans: { node: string; feeds: Feed[] }[] = [];
  for (const [node, all] of byParent) {
    if (fixed(node)) continue;
    const feeds = all.filter(feed => portFeeds.get(feed.key) === 1 && parentsOf.get(feed.child.ref.node)!.size === 1 && !fixed(feed.child.ref.node)
      && !links.get(feed.link)!.bundle && links.get(feed.link)!.technique !== 'mesh-bus').sort((a, b) => a.parent.engineOrder! - b.parent.engineOrder!);
    if (feeds.length < 2) continue;
    const pairs = feeds.slice(1).map((feed, i) => ({ child: feed.child.anchor!.x - feeds[i]!.child.anchor!.x, parent: feed.parent.anchor!.x - feeds[i]!.parent.anchor!.x }));
    // The rule asks only where the children stand further apart than the ports somewhere.
    if (!pairs.some(pair => Math.abs(pair.child) - Math.abs(pair.parent) > 0.5)) continue;
    const named = feeds.map(feed => feed.link);
    if (new Set(feeds.map(feed => groupOf(feed.child.ref.node))).size !== 1) declineSpread(model, node, named, 'its children stand in more than one group');
    else if (pairs.some(pair => pair.child <= EPS)) declineSpread(model, node, named, 'its children do not stand in the order of its ports');
    else plans.push({ node, feeds });
  }
  return plans.sort((a, b) => model.nodes[a.node]!.bounds!.x - model.nodes[b.node]!.bounds!.x || a.node.localeCompare(b.node));
}
/**
 * One parent spread: the fed bottom ports go to the spacing of their children about their own mean, the body grows to hold them (`alignSide`,
 * bounded by the alignment cap (`withinAlignmentCap`) and the overlay stops, with no sibling bound: the siblings move instead), the nodes of its row before it
 * move left by the growth on the left and the ones after it right by the growth on the right, and the group is clamped into the window the
 * step of the parent's tier gives it (`stepWindow`: the reserved lanes and flanks, the frame columns, the group before it and the room the
 * groups after it reserve). The spread is made on the model and judged where it stands: the move reservations, read again on the resized
 * group (`resizeHolds`: lane windows and sides, the riser keep-out of the spread ports, span corridors, trunk extensions, side-lane far ports),
 * and the child side: the child group, centred under the spread ports, must fit its own reserved window. A spread that keeps fewer ports than
 * it spreads, or that the window, a reservation or the child window refuses, is undone whole and named (`PARENT_SPREAD_DECLINED`, R6): the
 * feeds then align as before, on the child side.
 */
function spreadParent(model: LayoutModel, context: CentreContext, tier: number, authority: number, plan: { node: string; feeds: Feed[] }): ParentSpread | undefined {
  const node = model.nodes[plan.node]!, group = model.groups[model.document.nodes[plan.node]!.group]!;
  // The ports as the model holds them now: a spread before this one, or its undoing, moved or replaced the nodes of its row.
  const feeds = plan.feeds.map(feed => ({ key: feed.key, link: feed.link, parent: findPort(model, feed.parent.ref)!, child: findPort(model, feed.child.ref)! }));
  const decline = (why: string): undefined => declineSpread(model, plan.node, feeds.map(feed => feed.link), why);
  // The ports take the spacing of their children about their own mean: a block centred on the face stays centred on it (ticket 10), and the body grows
  // by the deficit, half on each side. Sums in ascending order (R3), as `centringOffset` takes them.
  const mean = (values: number[]): number => [...values].sort((a, b) => a - b).reduce((sum, x) => sum + x, 0) / values.length;
  const parents = mean(feeds.map(feed => feed.parent.anchor!.x)), children = mean(feeds.map(feed => feed.child.anchor!.x));
  const targets = new Map(feeds.map(feed => [feed.key, parents + feed.child.anchor!.x - children]));
  const unbounded = { low: -Infinity, high: Infinity }, stops = overlayStops(model, node);
  if (keptTargets(model, node, 'bottom', targets, unbounded, stops).length !== feeds.length) return decline(`the body would grow past ${moveBeforeGrow(model) ? 'the alignment cap' : 'its alignment allowance'} or onto an overlay link`);
  const saved = JSON.stringify({ group, nodes: group.nodes.map(id => model.nodes[id]!) }), evidence = resizeEvidence(model, group);
  const restore = (): void => {
    const copy = JSON.parse(saved) as { group: LayoutGroup; nodes: LayoutNode[] };
    model.groups[group.id] = copy.group;
    for (const item of copy.nodes) model.nodes[item.id] = item;
  };
  const undo = (why: string): undefined => { restore(); return decline(why); };
  // The face and the body, then the row.
  const oldX = node.bounds!.x, oldRight = right(node.bounds!);
  if (alignSide(model, node, 'bottom', targets, unbounded, stops, () => {}, riserAvoidance(model, authority, 'bottom')).size !== feeds.length) {
    return undo('a port would stand on the keep-out of a mesh-bus riser');
  }
  const growth = { low: oldX - node.bounds!.x, high: right(node.bounds!) - oldRight };
  const row = packRowsOf(model, group).find(item => item.includes(plan.node))!, at = row.indexOf(plan.node);
  for (const id of row.slice(0, at)) shiftNode(model.nodes[id]!, -growth.low);
  for (const id of row.slice(at + 1)) shiftNode(model.nodes[id]!, growth.high);
  fitRegionGroup(model, group);
  // The clamp into the window of the parent's tier step.
  const order = context.groupOrder.get(authority)!, index = order.indexOf(group.id), step = context.steps.find(item => item.tier === authority)!;
  const previous = index > 0 ? standingBox(model, model.groups[order[index - 1]!]!) : undefined;
  const window = stepWindow(model, context, authority, centringFeeds(model, authority, step.authority), group.id, previous, tailReservation(model, context, authority, order));
  if (group.bounds!.width > window.high - window.low + EPS) {
    return undo(`spread it is ${group.bounds!.width.toFixed(1)} px wide and the window of its group holds ${Math.max(0, window.high - window.low).toFixed(1)} px`);
  }
  const dx = Math.max(window.low, Math.min(group.bounds!.x, window.high - group.bounds!.width)) - group.bounds!.x;
  moveGroup(model, group, dx, 0);
  // An optional change of boxes: the move reservations, read again where the resized group stands.
  if (!resizeHolds(model, group, evidence)) return undo('the resized group would break a reserved lane, riser keep-out, corridor or side lane');
  // The child side: the child group, moved under the spread ports, stays inside its own reserved window (the lanes and flanks of its tier, its frame column).
  const childGroup = model.groups[model.document.nodes[feeds[0]!.child.ref.node]!.group]!, box = childGroup.bounds!;
  const offset = mean(feeds.map(feed => feed.parent.anchor!.x)) - children, room = reservedWindow(model, context, tier, childGroup.id);
  if (box.x + offset < room.low - EPS || right(box) + offset > room.high + EPS) {
    return undo(`its children cannot stand under the spread ports: ${childGroup.id} would stand at ${(box.x + offset).toFixed(1)} to ${(right(box) + offset).toFixed(1)}`
      + ` and its window holds ${room.low.toFixed(1)} to ${room.high.toFixed(1)}`);
  }
  rebuildNodeGeometry(model, group.nodes, 'current');
  const left = node.bounds!.x;
  // A record of the decision for the diagnostics and the tests: the face the spread made and how far the row neighbours moved in all, the clamp included.
  // No rule reads these fields back; the rules read only that the entry is there (`isSpreadFace`).
  return { width: node.bounds!.width, ports: node.ports.filter(port => port.side === 'bottom').map(port => ({ port: { ...port.ref }, offset: port.anchor!.x - left })),
    shift: { low: growth.low - dx, high: growth.high + dx } };
}
/**
 * The overlay walls the main move of a group step stops at. The move carries a body an earlier pass grew toward its feeds, and a move that carries such a
 * body onto a chord is the same growth by another name. A body that has not grown does not bound the move.
 */
function farthest(model: LayoutModel, walls: ReadonlyMap<string, OverlayStops>): { farthestLeft: number; farthestRight: number } {
  let farthestLeft = -Infinity, farthestRight = Infinity;
  for (const [id, stops] of walls) {
    const node = model.nodes[id]!, box = node.bounds!;
    if (box.width <= Math.max(ownSideWidth(node, 'top'), ownSideWidth(node, 'bottom')) + EPS) continue;
    farthestLeft = Math.max(farthestLeft, stops.low - box.x);
    farthestRight = Math.min(farthestRight, stops.high - right(box));
  }
  return { farthestLeft, farthestRight };
}
/** The main move of a group step toward the offset `toMean`: stopped at the overlay walls, and nil when it breaks the riser keep-out or carries a frozen chord across a lane. */
function mainMove(model: LayoutModel, group: LayoutGroup, farthestLeft: number, farthestRight: number, toMean: number): number {
  const shift = Math.max(farthestLeft, Math.min(toMean, farthestRight));
  return riserKeepOutAfterMove(model, group, shift) && chordsClearAfterMove(model, group, shift) ? shift : 0;
}
/**
 * The x range of the box of a group at the end of its step: its reserved window, clear of the group before it, inside the room the groups after it reserve,
 * and short of the next group the step does not centre.
 */
function stepWindow(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, tail: ReadonlyMap<string, number>): { low: number; high: number } {
  const order = context.groupOrder.get(tier)!, window = reservedWindow(model, context, tier, id);
  const low = Math.max(window.low, previous ? right(previous.bounds!) + bandGap(model) : -Infinity);
  let high = Math.min(window.high, tail.get(id)!);
  const nextFixed = order.slice(order.indexOf(id) + 1).map(id => model.groups[id]!).find(other => !list.some(feed => model.document.nodes[feed.child.ref.node]!.group === other.id));
  if (nextFixed) high = Math.min(high, nextFixed.bounds!.x - bandGap(model));
  return { low, high };
}
/** The box a group stands at for the group after it in the tier order. A bar stands where 7d will shape it, so the groups after it clear the extent its span gives it (ticket 19). */
function standingBox(model: LayoutModel, group: LayoutGroup): LayoutGroup {
  const reach = barReach(model, group.id);
  return reach === undefined ? group : { ...group, bounds: { ...group.bounds!, x: Math.min(group.bounds!.x, reach.x), width: Math.max(right(group.bounds!), reach.x + reach.width) - Math.min(group.bounds!.x, reach.x) } };
}
/**
 * Whether the step of group `id` leaves the box of the group where it is when its offset goes from `from` to `to` (architecture ticket 15, follow-up): the
 * group stands between walls that take the change of offset. Both readings must hold:
 * - the group fills the window of its frame column (`columnWindow`: a rank cell never leaves the column of its frame; a canton member never leaves the box
 *   of its canton, or the aligned extent it reserved, which the canton pass reads too, architecture-2 ticket 31). The column is as wide as the cell, so it holds no room for the cell to shift into, and a later replay that widens the cell widens the
 *   column with it. A wall that a lane of 7a, a neighbour, an overlay or a chord makes is a reading of geometry that a later replay moves (a lane limit
 *   that pinned a group at one replay let it shift 33 px at the next on `a-group-shift-leaves-a-chord-clear-of-a-lane`), so it is no proof.
 * - the step as it runs now puts the group at the same x for both offsets: the main move, stopped at the overlay walls, then the clamp into the step window.
 * The widenings, the row pack and the region fit of the step are not predicted: the two readings of one box differ only by the offset.
 */
export function stepTakesOffset(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, from: number, to: number,
  tail: ReadonlyMap<string, number> = tailReservation(model, context, tier, context.groupOrder.get(tier)!)): boolean {
  const group = model.groups[id]!, order = context.groupOrder.get(tier)!, at = order.indexOf(id), box = group.bounds!;
  const column = columnWindow(model, context, tier, id);
  if (column.high - column.low > box.width + 0.5) return false;
  const walls = new Map(group.rowOrder!.map(node => [node, overlayStops(model, model.nodes[node]!)]));
  const { farthestLeft, farthestRight } = farthest(model, walls);
  const previous = at > 0 ? standingBox(model, model.groups[order[at - 1]!]!) : undefined;
  const { low, high } = stepWindow(model, context, tier, list, id, previous, tail);
  // A window that cannot hold the group proves nothing: the step then declines and stands the group near its feed, which moves it.
  if (box.width > high - low + EPS) return false;
  const lands = (toMean: number): number => Math.max(low, Math.min(box.x + mainMove(model, group, farthestLeft, farthestRight, toMean), high - box.width));
  return Math.abs(lands(from) - lands(to)) <= 0.5;
}
/**
 * One group's centring step: centre under its owning feeds, align the wanted ports, repack, fit,
 * clamp into the lane/flank/neighbour window. Reports exactly which child ports stay unresolved —
 * a conflict, an alignment the row cannot hold, a window the group cannot fit, or a clamp that
 * moved it off its feed — so a check can excuse those and no others. Shared by the producer pass and
 * by the publication/restore check, so both read one definition.
 */
const CHORD_STAGES = ['bundles', 'bands', 'route', 'link-labels', 'validate', 'emit'];
/**
 * What the replays of one check read before their step moves anything. Every replay starts from a copy of one model, and the readings below depend on the
 * content of the model alone; the one thing a replay does first is rebuild the nodes of its group. When that leaves the nodes as the model has them (`texts`),
 * the replay stands on the model itself and takes the readings of the first one that did, so they are read once per check and not once per replay.
 */
interface BaseReadings { texts: ReadonlyMap<string, string>; held?: Set<string>; breached?: Set<string> }
/**
 * The chord readings a step that stood took after it moved (architecture-2 ticket 62): the overlay links with a straight chord and the groups a foreign drop
 * would run along. The producer loop hands them to the next step as its readings before: nothing between the two writes the model when the step stood, no
 * group between them was cleared (`packClear`), and the rebuild of the next group's nodes leaves their text as it was. The step tests that last part; the
 * loop drops the value for the rest.
 */
interface CarriedReadings { held: Set<string>; breached: Set<string> }
type GroupStep = { unresolved: Set<string>; group: LayoutGroup; carry?: CarriedReadings; notes: TargetNotes };
/** The centring pass the producer runs now (`CentreBudget.passes`), written on the targets a producer step records; a replay (`warn` off) writes 0. Read by nothing for a decision. */
let stepPass = 0;
const carryCache = readCache('centreCarry');
/** The groups a foreign drop would run along, by id. */
const breachedIds = (model: LayoutModel): Set<string> => new Set([...keepOutShifts(model).keys()].map(item => item.id));
function centreGroupStep(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, warn: boolean, tail: Map<string, number>, rowSeat: ReadonlyMap<string, number>, base?: BaseReadings, carried?: CarriedReadings): GroupStep {
  return withStepLinkKinds(model, () => {
    const began = model.groups[id];
    const step = centreGroupStepChecked(model, context, tier, list, id, previous, warn, tail, rowSeat, base, carried);
    // The targets the step kept, grew toward or declined, read on the geometry it leaves on every exit (architecture-2 ticket 66).
    writeAlignmentTargets(model, model.groups[id]!.nodes, step.notes, warn ? stepPass : 0);
    // The seats, only when the step's own geometry stands: a step given back or kept at its start leaves no seat of its own (ADR-0027).
    if (step.group === began) writeAlignmentSeats(model, step.notes.seated, warn ? stepPass : 0, step.notes.unseated);
    return step;
  });
}
/**
 * The seats of `nodes` that fall, each with its first kept port that no longer stands over its feed (`wanted`, the feed x of each child port)
 * within half a pixel, or that has no feed. The one reading of a fallen seat: the producer withdraws these seats, and the publication check
 * refuses a record that names one (R1, R5). No exemption of the centring replay applies: a kept port is the seat's own decision.
 */
function fallenSeats(model: LayoutModel, nodes: readonly string[], wanted: ReadonlyMap<string, number>): Map<string, string> {
  const fallen = new Map<string, string>(), record = model.alignmentSeats;
  if (record === undefined) return fallen;
  for (const id of nodes) {
    const seat = Object.hasOwn(record, id) ? record[id] : undefined;
    if (seat === undefined) continue;
    const ports = new Map(model.nodes[id]!.ports.map(port => [portId(port.ref), port]));
    for (const key of seat.ports) {
      const want = wanted.get(key), port = ports.get(key);
      if (want === undefined) { fallen.set(id, `${id}: the kept port ${key} has no feed`); break; }
      if (port?.anchor === undefined || Math.abs(port.anchor.x - want) > 0.5) {
        fallen.set(id, `${id}: the kept port ${key} stands at x ${String(port?.anchor?.x)}, not at its feed x ${want}`);
        break;
      }
    }
  }
  return fallen;
}
/**
 * Withdraws the recorded seat of each node of `nodes` that a port it keeps no longer stands over its feed where the step leaves it (a step given
 * back, kept at its start, or clamped off the seat): the record names only seats the geometry holds, and the next step decides that body again.
 */
function withdrawFallenSeats(model: LayoutModel, nodes: readonly string[], wanted: ReadonlyMap<string, number>): void {
  for (const id of fallenSeats(model, nodes, wanted).keys()) delete model.alignmentSeats![id];
}
/** The feed x of each child port over the centred tiers of `context`: the first feed of a port, in step order. */
function seatFeeds(model: LayoutModel, context: CentreContext): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const { tier, authority } of context.steps) for (const feed of centringFeeds(model, tier, authority)) {
    const key = portId(feed.child.ref);
    if (!wanted.has(key)) wanted.set(key, feed.x);
  }
  return wanted;
}
/**
 * `withdrawFallenSeats` over every centred tier: when the passes end (a step of another group, the parent stand or an overlay window may have
 * moved the feed of a seat after it stood), and at the end of each rule from the centre rule on (a rebuild may move a seated body), so the
 * record a rule publishes names only seats its geometry holds.
 */
export function withdrawFallenSeatsOf(model: LayoutModel): void {
  if (model.alignmentSeats === undefined || !Object.keys(model.alignmentSeats).length || model.anchorTier === undefined) return;
  if (!model.tierBands.some(band => band.tier === model.anchorTier)) return;
  withdrawFallenSeatsEverywhere(model, centreContext(model, model.anchorTier));
}
function withdrawFallenSeatsEverywhere(model: LayoutModel, context: CentreContext): void {
  if (model.alignmentSeats === undefined) return;
  withdrawFallenSeats(model, Object.keys(model.alignmentSeats), seatFeeds(model, context));
}
/**
 * The first seat of a stored record that a kept port no longer stands over its feed, or undefined (R5). Every rule from the centre rule on
 * withdraws such a seat before it publishes (`withdrawFallenSeatsOf`), so a record that names one is forged. It reads every kept port against
 * its feed, whatever the centring replay excuses (a held cross chord, a bundle, a bar).
 */
export function fallenSeatFault(model: LayoutModel): string | undefined {
  if (model.alignmentSeats === undefined || !Object.keys(model.alignmentSeats).length || model.anchorTier === undefined) return undefined;
  if (!model.tierBands.some(band => band.tier === model.anchorTier)) return undefined;
  const fallen = fallenSeats(model, Object.keys(model.alignmentSeats).sort(), seatFeeds(model, centreContext(model, model.anchorTier)));
  return fallen.values().next().value;
}
function centreGroupStepChecked(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, warn: boolean, tail: Map<string, number>, rowSeat: ReadonlyMap<string, number>, base?: BaseReadings, carried?: CarriedReadings): GroupStep {
  // From 7e on, an overlay link that draws one straight segment keeps the space placement reserved for it. A step that leaves fewer
  // of them straight (a body or a pill now stands on a chord) is declined as a whole, like a step that solves nothing: the group stays
  // where it stood (ticket 75). A step that straightens one link for another is a trade the alignment is allowed to make.
  if (!CHORD_STAGES.includes(model.stage)) return centreGroupStepRaw(model, context, tier, list, id, previous, warn, tail, rowSeat);
  const group = model.groups[id]!;
  const unbuilt = carried === undefined ? undefined : group.nodes.map(node => JSON.stringify(model.nodes[node]));
  // `moveGroup` leaves pill bounds behind, and the chord reads them: both readings are taken on rebuilt nodes.
  rebuildNodeGeometry(model, group.nodes, 'current');
  let held: Set<string>, breached: Set<string>;
  if (carried !== undefined && group.nodes.every((node, index) => JSON.stringify(model.nodes[node]) === unbuilt![index])) {
    // Under `LayoutOptions.checkCaches` both readings are taken again and must be the carried ones.
    try {
      held = carryCache.hit(model, carried.held, () => straightChordIds(model));
      breached = carryCache.hit(model, carried.breached, () => breachedIds(model));
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} (group ${id}, tier ${tier})`, { cause: error });
    }
    attemptCounters.centreCarry.carried++;
  } else {
    if (carried !== undefined) carryCache.miss();
    if (base === undefined) attemptCounters.centreCarry.fresh++;
    const standing = base !== undefined && group.nodes.every(node => JSON.stringify(model.nodes[node]) === base.texts.get(node));
    held = standing && base.held ? base.held : straightChordIds(model); breached = standing && base.breached ? base.breached : breachedIds(model);
    if (standing) { base.held = held; base.breached = breached; }
  }
  const text = JSON.stringify({ group, nodes: group.nodes.map(node => model.nodes[node]!) });
  const snapshot = JSON.parse(text) as { group: LayoutGroup; nodes: LayoutNode[] };
  const result = centreGroupStepRaw(model, context, tier, list, id, previous, warn, tail, rowSeat);
  rebuildNodeGeometry(model, model.groups[id]!.nodes, 'current');
  const now = straightChordIds(model);
  // A frame edge that a foreign drop would run along is a spacing routing can only discover; a step may not make one (ticket 75).
  const after = holds(reading({ overlay: straightOf(now) }), reading({ overlay: straightOf(held) }), profiles.keepCount) ? breachedIds(model) : undefined;
  // A complete step can move and widen a body inside its group. Keep the same-tier windows 7f reserved, including cross-group runs outside
  // siblingLimit: the move and resize guards share this producer replay (R1, R2). It runs only for a step that changed its group.
  const stands = after !== undefined && [...after].every(item => breached.has(item))
    && rowRoomKeptByStep(model, snapshot, JSON.stringify({ group: model.groups[id]!, nodes: model.groups[id]!.nodes.map(node => model.nodes[node]!) }) === text);
  tapVerdict('centreGroupStep', () => `${stands} ${now.size}/${held.size}`);
  if (stands) return { ...result, carry: { held: now, breached: after } };
  model.groups[id] = snapshot.group;
  for (const node of snapshot.nodes) model.nodes[node.id] = node;
  packClear(model, context, tier, snapshot.group, previous);
  // The undo gives back the geometry the step began on, not the step's own geometry a decline or a growth was judged against: no decline and no
  // growth of this step stands, and the record keeps what earlier steps wrote (review 10b F2; the rollback of the given-back branch does the same).
  return { unresolved: new Set(groupFeeds(model, context, tier, list, id, false).wanted.keys()), group: snapshot.group, notes: { ...result.notes, grown: new Map(), declined: new Map() } };
}
/** The verticals a centring step counts (ticket 65): the feeds that owe one and stand on it, then every feed that stands on one. */
type VerticalTally = readonly [owed: number, all: number];
/** Whether tally `a` stands fewer verticals than `b`: the owed ones first, then all (lexicographic). */
const fewerVerticals = (a: VerticalTally, b: VerticalTally): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
/**
 * The tally of one group step, read on the misses of its wanted ports (a miss up to half a pixel stands, as `unresolved` reads it). A feed owes a
 * vertical when its link is an orthogonal link, a frame chord or a direct member; a held cross-frame chord owes none (CONTEXT.md: any angle) and counts
 * only in the second term, and not on a face where two wanted ports, one of them a transit, cannot both stand at pitch: a cross chord never costs a
 * transit port its lane. A target the record declines (`alignmentTargets`, ticket 66) is not counted. A count reads no order, so no tie-break is
 * needed (R3).
 */
function verticalTally(model: LayoutModel, group: LayoutGroup, wanted: ReadonlyMap<string, number>, seats: ReadonlyMap<string, Feed>): (misses: ReadonlyMap<string, number>) => VerticalTally {
  const links = linkById(model);
  const direct = directMembers(model);
  const owes = (feed: Feed): boolean => owesVertical(model, links.get(feed.link), direct);
  // A target a step declined is final for the placement attempt (architecture-2 ticket 66): it is counted neither before nor after, so the kept
  // branch is not tried for it again. A `cap` decline is no decision (the writer does not keep it): it names where the body stood, so the tally
  // counts its target as any other miss, the same in the producer and in a replay.
  const capped = declinedTargets(model, group.nodes, 'cap'), declined = new Set([...declinedTargets(model, group.nodes)].filter(port => !capped.has(port)));
  const inverted = new Set<string>();
  for (const id of group.rowOrder!) {
    const node = model.nodes[id]!;
    for (const side of ['top', 'bottom'] as const) {
      const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
      if (ports.length < 2) continue;
      const pitch = node.sidePitch![side]!, excess = engineExcess(node, side, pitch);
      for (let i = 0; i < ports.length; i++) for (let j = i + 1; j < ports.length; j++) {
        const one = portId(ports[i]!.ref), two = portId(ports[j]!.ref), x = wanted.get(one), y = wanted.get(two);
        if (x !== undefined && y !== undefined && x > y - stepSpan(excess, pitch, i, j) && (seats.get(one)?.transit || seats.get(two)?.transit)) inverted.add(`${id}:${side}`);
      }
    }
  }
  return misses => {
    let owed = 0, all = 0;
    for (const [key, miss] of misses) {
      const feed = seats.get(key);
      if (miss > 0.5 || feed === undefined || declined.has(key)) continue;
      if (owes(feed)) { owed++; all++; } else if (!inverted.has(`${feed.child.ref.node}:${feed.child.side}`)) all++;
    }
    return [owed, all];
  };
}
/**
 * The faces of a group whose aligned ports the clamp left a fraction off their feeds (ticket 65). A miss up to half a pixel counts as standing, so no
 * later step moves it, and the router draws a hair jog. A face whose wanted ports within that tolerance all miss by one shift moves by that shift as a
 * whole (its ports keep their pitch), when it stays inside its body edges and no other port of it ends a link with a corridor of its own, a
 * bundle member or a held chord.
 */
function snapAlignedFaces(model: LayoutModel, group: LayoutGroup, wanted: ReadonlyMap<string, number>): void {
  let cornered: Set<string> | undefined;
  for (const id of group.nodes) {
    const node = model.nodes[id]!, box = node.bounds!;
    for (const side of ['top', 'bottom'] as const) {
      const pitch = node.sidePitch?.[side];
      const ports = node.ports.filter(port => port.side === side && port.anchor).sort((a, b) => a.engineOrder! - b.engineOrder!);
      const shifts = ports.flatMap(port => {
        const want = wanted.get(portId(port.ref));
        return want === undefined || Math.abs(want - port.anchor!.x) > 0.5 ? [] : [want - port.anchor!.x];
      });
      const shift = shifts[0];
      if (pitch === undefined || shift === undefined || Math.abs(shift) <= EPS || shifts.some(item => Math.abs(item - shift) > EPS)) continue;
      const inset = portEndInsets(node, side, pitch);
      if (ports[0]!.anchor!.x + shift - inset.low < box.x - EPS || ports[ports.length - 1]!.anchor!.x + shift + inset.high > right(box) + EPS) continue;
      // A port another rule placed stays: a link with a corridor of its own, a bundle member (7e) and a held chord (`alignSide` keeps its port).
      cornered ??= new Set(model.links.filter(link => link.attachments && (link.bundle !== undefined || isRoutedChord(model, link)
        || model.lanes.some(lane => lane.owner.kind === 'link' && lane.owner.id === link.id)))
        .flatMap(link => [portId(link.attachments!.from), portId(link.attachments!.to)]));
      const corridors = cornered;
      if (ports.some(port => !wanted.has(portId(port.ref)) && corridors.has(portId(port.ref)))) continue;
      for (const port of ports) port.anchor = portAnchor(box, side, port.anchor!.x + shift - box.x);
    }
  }
}
function centreGroupStepRaw(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, warn: boolean, tail: Map<string, number>, rowSeat: ReadonlyMap<string, number>): { unresolved: Set<string>; group: LayoutGroup; notes: TargetNotes } {
  const group = model.groups[id]!;
  const { own, wanted, yielded, conflicts, seats } = groupFeeds(model, context, tier, list, id, warn);
  const unresolved = new Set<string>(conflicts);
  // What the record of the targets reads at the step's end (architecture-2 ticket 66): the room of each target where the step began, the growth
  // toward a target, and the targets the kept branch declines.
  const notes: TargetNotes = { seats, wanted, grown: new Map(), start: new Map(), declined: new Map(), seated: new Map() };
  for (const [key, want] of wanted) {
    const box = model.nodes[seats.get(key)!.child.ref.node]!.bounds!;
    notes.start.set(key, { low: box.x - want, high: right(box) - want });
  }
  const startPenetration = riserPenetrations(model, group), startCrossings = chordLaneCrossings(model, group), startBreaches = spanBreaches(model);
  const saved = JSON.parse(JSON.stringify({ group, nodes: group.nodes.map(node => model.nodes[node]!) })) as { group: LayoutGroup; nodes: LayoutNode[] };
  // Centre under the feeds that may own an alignment; a yielded transit would only pull the group
  // away from the x its child is then aligned to. While a seat stands (`seatedFeeds`), a seated body pulls only through the feeds it keeps.
  const record = model.alignmentSeats, seated = moveBeforeGrow(model);
  const chosen = seated ? seatedFeeds(model, chosenFeeds(context, tier, own, yielded)) : chosenFeeds(context, tier, own, yielded);
  /** How far each wanted port is from the x its feed asks for, in the model as it now stands. */
  const misses = (): Map<string, number> => {
    // One index of the group's ports per reading, the first port of a key first, as `find` gave it.
    const ports = new Map<string, LayoutPort>();
    for (const node of group.nodes) for (const item of model.nodes[node]!.ports) { const at = portId(item.ref); if (!ports.has(at)) ports.set(at, item); }
    return new Map([...wanted].map(([key, want]) => {
      const port = ports.get(key);
      return [key, port?.anchor ? Math.abs(port.anchor.x - want) : 0];
    }));
  };
  const total = (values: Map<string, number>): number => [...values.values()].reduce((sum, value) => sum + value, 0);
  const startMisses = misses(), missBefore = total(startMisses);
  // From 7e on, a step may not give up a vertical it found standing for the mean, and may not bring a held chord under the chord clearance
  // (ticket 65). Both are read before the step moves anything and judged after the clamp.
  const chordStage = CHORD_STAGES.includes(model.stage);
  const tally = chordStage ? verticalTally(model, group, wanted, seats) : undefined;
  const verticalsBefore = tally?.(startMisses);
  // The warnings the step writes are given back when the step is undone for the tally: the kept geometry names its own (R6).
  const diagnosticsBefore = warn && verticalsBefore !== undefined && verticalsBefore[1] > 0 ? [...model.diagnostics] : undefined;
  const moved = new Set(group.nodes);
  const nearBefore = chordStage ? chordNearPairs(model, moved) : undefined;
  /** The first pair (in key order) of a held chord that now stands under the chord clearance to a chord or a foreign body it cleared when the step began. Read on rebuilt nodes: a move leaves the pills behind, and a chord end reads them. */
  const newlyNear = (nodes: readonly string[]): string | undefined => {
    if (nearBefore === undefined) return undefined;
    rebuildNodeGeometry(model, nodes, 'current');
    return [...chordNearPairs(model, moved)].filter(key => !nearBefore.has(key)).sort()[0];
  };
  // The overlay walls of each body, read where the body stands as the step begins. A body an earlier
  // pass grew toward its feeds is carried by the move below as well, and a move that carries it onto
  // a chord is the same growth by another name: the next pass would read a chord the body already
  // crosses and let the growth through. So the move stops at the wall for a grown body. A body that
  // has not grown moves as it always did; the wall then bounds only the growth that follows.
  const walls = new Map(group.rowOrder!.map(id => [id, overlayStops(model, model.nodes[id]!)]));
  const { farthestLeft, farthestRight } = farthest(model, walls);
  // Toward the seat of its row when the packing pools the group with its neighbours (dense-16x9 ticket 27), else toward its own feeds.
  const began = group.bounds!.x, toMean = stepOffset(model, id, chosen, rowSeat);
  moveGroup(model, group, mainMove(model, group, farthestLeft, farthestRight, toMean), 0);
  const aligned = new Set<string>();
  // The window a seat slides a body in (ADR-0027): the slack of its row inside its group box, less the insets the box keeps beyond its bodies.
  // The group itself moves by the main move, toward the mean of its feeds, and the clamp into the window of the step moves it as a whole; a
  // slide inside the box changes neither, and a slide past the box would grow the group, and the next main move would take it back.
  const inset = groupInsets(model, group), box = group.bounds!;
  const rowWindow = { low: box.x + inset.left, high: right(box) - inset.right };
  const links = linkById(model), direct = directMembers(model);
  // The ports each seat keeps (ADR-0027, the seat owns the body): the record once the centre rule has written one; before it, the wanted ports
  // that stood when the step began, which at a fixed point are the same. A kept port stays owed after the chord freeze.
  const kept = new Set<string>(!seated ? [] : record === undefined ? [...startMisses].filter(([, miss]) => miss <= 0.5).map(([key]) => key)
    : group.nodes.flatMap(node => Object.hasOwn(record, node) ? record[node]!.ports : []));
  const owedBefore = seated ? seatOwes(model, seats, links, direct) : () => true, owes = (key: string): boolean => owedBefore(key) || kept.has(key);
  // A group of a pooled run (`rowSeats`, dense-16x9 ticket 27) aligns inside the bodies it has: no member of the run stands at its own feeds, so a
  // growth toward them would only widen the unit and push the other members further off; its feeds pull the unit, as a solid block's feeds do.
  const pooled = rowSeat.has(id);
  const inBody = (node: LayoutNode, limit: WideningLimit): WideningLimit => pooled ? { low: Math.max(limit.low, node.bounds!.x), high: Math.min(limit.high, right(node.bounds!)) } : limit;
  for (const nodeId of group.rowOrder!) {
    const node = model.nodes[nodeId]!;
    const stops = walls.get(nodeId)!;
    let stoppedBy: string | undefined;
    if (!seated) {
      // The default: each face grows its body in place toward its targets, up to the allowance (`alignSide`).
      for (const side of ['top', 'bottom'] as const) {
        const box = node.bounds!, fromX = box.x, fromWidth = box.width;
        const kept = alignSide(model, node, side, wanted, inBody(node, siblingLimit(model, group, node)), stops, link => { stoppedBy ??= link; }, riserAvoidance(model, group.tier!, side as 'top' | 'bottom'), heldChordPorts(model, node));
        for (const key of kept) aligned.add(key);
        // A body that widened toward its targets records the room it reached, from each target's x (the record's `grown`, ticket 66).
        if (box.x < fromX - EPS || box.width > fromWidth + EPS) for (const key of kept) notes.grown.set(key, { low: box.x - wanted.get(key)!, high: right(box) - wanted.get(key)! });
      }
    }
    else {
    const nodePorts = new Set(node.ports.map(port => portId(port.ref)));
    const keptHere = record === undefined ? new Set([...kept].filter(key => nodePorts.has(key))) : Object.hasOwn(record, nodeId) ? new Set(record[nodeId]!.ports) : undefined;
    const recorded = record !== undefined && Object.hasOwn(record, nodeId) ? record[nodeId]! : undefined;
    const seatedFrom = node.bounds!.x;
    const seat = seatNode(model, group, node, wanted, owes, inBody(node, rowWindow), stops, link => { stoppedBy ??= link; }, seats, warn, keptHere, recorded?.from);
    for (const key of seat.kept) aligned.add(key);
    // A body that widened toward its targets records the room it reached, from each target's x (the record's `grown`, ticket 66).
    const box = node.bounds!;
    if (box.width > seat.from + EPS) for (const key of seat.kept) notes.grown.set(key, { low: box.x - wanted.get(key)!, high: right(box) - wanted.get(key)! });
    // A seat that moves or grows the body is recorded, and so is a recorded seat that now keeps other ports; one that keeps none is withdrawn.
    // The width the body needs is the one before its first seat: a later seat does not measure from a box an earlier pass grew.
    const earlier = record !== undefined && Object.hasOwn(record, nodeId) ? record[nodeId]! : undefined, ports = [...seat.kept].sort();
    if (seat.kept.size && (Math.abs(seat.dx) > NO_MOVE_EPS || box.width > seat.from + EPS || (earlier !== undefined && earlier.ports.join() !== ports.join()))) {
      // `at`: where the box before the first seat stands inside the seated box (it moves with the seat); clause 4 gives the body back to it.
      const from = Math.min(seat.from, earlier?.from ?? Infinity);
      notes.seated.set(nodeId, { dx: seat.dx, from, at: Math.max(0, Math.min(seatedFrom + (earlier?.at ?? 0) + seat.dx - box.x, box.width - from)), width: box.width, ports });
    } else if (!seat.kept.size && earlier !== undefined) {
      // A seat that falls gives its growth back (ADR-0027, clause 4): the body goes back to the box it had before its first seat.
      giveBackGrowth(model, node, earlier.from, earlier.at);
      (notes.unseated ??= new Set()).add(nodeId);
    }
    for (const key of seat.capped) notes.declined.set(key, { reason: 'cap', by: nodeId });
    }
    // Once per node, not once per pass and side.
    if (stoppedBy && warn && !model.diagnostics.some(d => d.code === 'ALIGNMENT_STOPPED_AT_OVERLAY' && d.message.startsWith(`${node.id} `))) {
      placementWarning(model, 'ALIGNMENT_STOPPED_AT_OVERLAY',
        `${node.id} stops growing toward its feeds at the overlay link ${stoppedBy}; the ports left outside their feeds stay at pitch and routing completes them.`, [stoppedBy]);
    }
  }
  for (const feed of own) {
    const key = portId(feed.child.ref);
    if (wanted.has(key) && !aligned.has(key)) {
      unresolved.add(key);
      if (warn) placementWarning(model, 'CENTRE_ALIGNMENT_INFEASIBLE', `${feed.link} cannot align within its child's available row span; routing completes it.`, [feed.link]);
    }
  }
  // Per row, not per row order: the first node of a grid row does not have to clear the last node
  // of the row above it, and pushing it clear would shear the grid into a staircase.
  for (const row of packRowsOf(model, group)) {
    for (let i = 1; i < row.length; i++) {
      const a = model.nodes[row[i - 1]!]!, b = model.nodes[row[i]!]!;
      const minimum = right(a.bounds!) + rowGap(model, a.id, b.id);
      if (b.bounds!.x < minimum) shiftNode(b, minimum - b.bounds!.x);
    }
  }
  fitRegionGroup(model, group);
  // The window is the same one the push respects. A left flank bounds this group as a right flank
  // does, and the final clamp reads `low`. A bound that only moves the group first is undone.
  const { low, high } = stepWindow(model, context, tier, list, id, previous, tail);
  if (group.bounds!.width > high - low) {
    // A declined step leaves every feed of the group off its x: it names them (R6, architecture-2 ticket 31).
    if (warn && seats.size) {
      recordWindowDecline(model, id, `aligned it is ${group.bounds!.width.toFixed(1)} px wide and its window holds ${Math.max(0, high - low).toFixed(1)} px`, [...seats.values()].map(feed => feed.link));
    }
    model.groups[id] = saved.group;
    for (const node of saved.nodes) model.nodes[node.id] = node;
    // The window cannot hold this group, but the group before it has already taken its space, so
    // the saved geometry alone would overlap. Decline the alignment and keep the tier packed.
    packClear(model, context, tier, saved.group, previous);
    standNearFeed(model, context, tier, id, saved.group, began + Math.max(farthestLeft, Math.min(toMean, farthestRight)), low, high);
    return { unresolved: new Set(wanted.keys()), group: saved.group, notes };
  }
  const x = Math.max(low, Math.min(group.bounds!.x, high - group.bounds!.width));
  moveGroup(model, group, x - group.bounds!.x, 0);
  snapAlignedFaces(model, group, wanted);
  // The riser keep-out is a post-condition of the whole step, read after the clamp (mesh-bus.md, section 11.5): the main move and the alignments were
  // measured where they were made, and the clamp, the row pack and the region fit can undo them. A step that leaves a routed port of the facing edge
  // deeper in the keep-out than the step found it (port by port) is declined like a window that cannot hold the group.
  // The same for a frozen chord: a step that leaves one across a foreign lane box that it did not cross when the step began is declined, and so is a
  // step that leaves a held chord under the chord clearance where it stood clear (ticket 65).
  if (!riserNoDeeper(startPenetration, riserPenetrations(model, group)) || [...chordLaneCrossings(model, group)].some(pair => !startCrossings.has(pair))
    || [...spanBreaches(model)].some(key => !startBreaches.has(key)) || newlyNear(group.nodes) !== undefined) {
    model.groups[id] = saved.group;
    for (const node of saved.nodes) model.nodes[node.id] = node;
    packClear(model, context, tier, saved.group, previous);
    standNearFeed(model, context, tier, id, saved.group, began + Math.max(farthestLeft, Math.min(toMean, farthestRight)), low, high);
    return { unresolved: new Set(wanted.keys()), group: saved.group, notes };
  }
  for (const [key, want] of wanted) {
    const port = group.nodes.flatMap(id => model.nodes[id]!.ports).find(port => portId(port.ref) === key)!;
    if (Math.abs(port.anchor!.x - want) > 0.5) unresolved.add(key);
  }
  const endMisses = misses();
  // A seat is judged where its step ends. By default this is ticket 71's rule for a body whose growth the centre rule gave back (`givenBack`); with
  // `layout.moveBeforeGrow` it holds for every body (ADR-0027, clause 5). A step that widens such a body
  // and leaves every aligned port of the group off its x after the pack and the clamp is declined whole, as a window that cannot hold the group is:
  // the group stands near its feed with the widths it began the step with, and the aligned targets are named as alignments the row cannot hold (R6).
  // The publication check replays this step, so it reads the same record (R1, R5).
  if (aligned.size && [...aligned].every(key => (endMisses.get(key) ?? 0) > 0.5)
    && group.nodes.some(nodeId => (seated || (model.givenBack !== undefined && Object.hasOwn(model.givenBack, nodeId))) && model.nodes[nodeId]!.bounds!.width > saved.nodes.find(node => node.id === nodeId)!.bounds!.width + EPS)) {
    if (warn) for (const feed of own) {
      if (!aligned.has(portId(feed.child.ref))) continue;
      placementWarning(model, 'CENTRE_ALIGNMENT_INFEASIBLE', `${feed.link} cannot align within its child's available row span; routing completes it.`, [feed.link]);
    }
    model.groups[id] = saved.group;
    for (const node of saved.nodes) model.nodes[node.id] = node;
    packClear(model, context, tier, saved.group, previous);
    standNearFeed(model, context, tier, id, saved.group, began + Math.max(farthestLeft, Math.min(toMean, farthestRight)), low, high);
    // The step is declined whole: the record holds no growth or seat of it, and no decline judged against its geometry stands (ticket 66).
    return { unresolved: new Set(wanted.keys()), group: saved.group, notes: { ...notes, grown: new Map(), declined: new Map(), seated: new Map(), unseated: new Set() } };
  }
  // A step that leaves fewer verticals standing than it found (ticket 65) keeps the geometry it found, clamped into its window, when that keeps more
  // and passes the same post-conditions and the overlay guard (ticket 66: no overlay link the step draws straight loses its straight chord). A keep
  // the guards refuse declines the targets only the kept geometry stands, in the record, for the rest of the attempt. Without it a group that aligns K of its N feeds moves by the mean of all N, crawls by (N - K) / N of the
  // miss, and gives up an alignment it reached when the next mean jumps: the output then depends on where the budget stops. The kept geometry
  // stands more than the step would, not always as many as it found (the clamp can cost one), so the budget alone bounds the passes (R4). The
  // publication check replays this step, so it reads the same decision (R5).
  const verticalsAfter = tally?.(endMisses);
  /**
   * Why the kept geometry, standing in the model now, may not stand; null when it may. Ticket 65's post-conditions first, then the overlay guard
   * of ticket 66, by identity: an overlay link that the step's own geometry draws straight and the kept one does not declines the keep. Each
   * reason names the first key it found, in code-unit order of the keys (R3). The overlay guard reads both geometries on rebuilt nodes, and only here: the kept
   * branch is not the producer's common path.
   */
  const keptRefusal = (keptGroup: LayoutGroup, stepGroup: LayoutGroup, stepNodes: readonly LayoutNode[]): { reason: AlignmentDeclineReason; by: string } | null => {
    const deeper = [...riserPenetrations(model, keptGroup)].filter(([key, depth]) => depth > (startPenetration.get(key) ?? 0) + RISER_DEPTH_EPS).map(([key]) => key).sort()[0];
    if (deeper !== undefined) return { reason: 'riser', by: deeper };
    const lane = [...chordLaneCrossings(model, keptGroup)].filter(pair => !startCrossings.has(pair)).sort()[0];
    if (lane !== undefined) return { reason: 'lane-crossing', by: lane };
    const span = [...spanBreaches(model)].filter(key => !startBreaches.has(key)).sort()[0];
    if (span !== undefined) return { reason: 'span', by: span };
    const near = newlyNear(keptGroup.nodes);
    if (near !== undefined) return { reason: 'chord-clearance', by: near };
    const keptNodes = keptGroup.nodes.map(node => model.nodes[node]!);
    model.groups[id] = stepGroup;
    for (const node of stepNodes) model.nodes[node.id] = node;
    rebuildNodeGeometry(model, stepGroup.nodes, 'current');
    const straight = straightChordIds(model);
    model.groups[id] = keptGroup;
    for (const node of keptNodes) model.nodes[node.id] = node;
    rebuildNodeGeometry(model, keptGroup.nodes, 'current');
    const keptStraight = straightChordIds(model);
    const lost = [...straight].filter(link => !keptStraight.has(link)).sort()[0];
    return lost === undefined ? null : { reason: 'overlay-straight', by: lost };
  };
  if (verticalsBefore !== undefined && verticalsAfter !== undefined && fewerVerticals(verticalsAfter, verticalsBefore) && saved.group.bounds!.width <= high - low) {
    const afterGroup = model.groups[id]!, afterNodes = group.nodes.map(node => model.nodes[node]!);
    const kept = JSON.parse(JSON.stringify(saved)) as typeof saved;
    // What the kept attempt writes (`packClear` can name a tier it cannot pack) belongs to the kept geometry: given back with it when it fails,
    // kept on top of the list before the step when it stands.
    const beforeKept = [...model.diagnostics];
    model.groups[id] = kept.group;
    for (const node of kept.nodes) model.nodes[node.id] = node;
    packClear(model, context, tier, kept.group, previous);
    moveGroup(model, kept.group, Math.max(low, Math.min(kept.group.bounds!.x, high - kept.group.bounds!.width)) - kept.group.bounds!.x, 0);
    snapAlignedFaces(model, kept.group, wanted);
    const keptMisses = misses();
    const refusal = fewerVerticals(verticalsAfter, tally!(keptMisses)) ? keptRefusal(kept.group, afterGroup, afterNodes) : undefined;
    tapTarget('keptBranch', () => `${id} ${warn ? `pass ${stepPass}` : 'replay'} ${refusal === undefined ? 'no-gain' : refusal === null ? 'kept' : `${refusal.reason} ${refusal.by}`}`);
    if (refusal === null) {
      if (diagnosticsBefore) {
        const wrote = new Set(beforeKept);
        model.diagnostics = [...diagnosticsBefore, ...model.diagnostics.filter(item => !wrote.has(item))];
      }
      const left = new Set<string>(conflicts);
      for (const [key, miss] of keptMisses) if (miss > 0.5) left.add(key);
      // The kept geometry names the feeds it leaves off their x, as the step does (R6).
      if (warn) for (const feed of own) {
        const key = portId(feed.child.ref);
        if (!wanted.has(key) || !left.has(key)) continue;
        placementWarning(model, 'CENTRE_ALIGNMENT_INFEASIBLE', `${feed.link} cannot align within its child's available row span; routing completes it.`, [feed.link]);
      }
      return { unresolved: left, group: kept.group, notes };
    }
    // A kept geometry the guards refuse declines the targets it alone stands (ticket 66): stored, so no later pass of this attempt tries them again.
    if (refusal !== undefined) for (const [key, miss] of keptMisses) if (miss <= 0.5 && (endMisses.get(key) ?? 0) > 0.5) notes.declined.set(key, refusal);
    model.groups[id] = afterGroup;
    for (const node of afterNodes) model.nodes[node.id] = node;
    model.diagnostics = beforeKept;
  }
  // A step that aligns nothing and brings no feed closer to its x moves nothing. The passes are an
  // iterative solver: the move puts the group under the mean of its feeds, the widenings below it
  // reach what the row and the alignment cap let them reach, and the next pass starts from where this
  // one left the group. A step that keeps no target, ends with every port off its feed and no
  // nearer it than it found them, has solved nothing and has only given the next pass a new place
  // to chase the mean from. That is the loop this ticket was filed for: `bar-fan` walked a 50 px
  // body to 3 014 px, 123.8 px a pass, through all eight, carrying its one port away from the feed
  // it started on every time (ticket 29).
  //
  // All three conditions are needed. A single feed is made vertical by the move alone, with nothing
  // for `alignSide` to keep, so the kept targets cannot be read on their own; a step that does not
  // converge here may still converge two passes later, so progress is measured rather than assumed;
  // and a transit feed asks for a **reserved lane x**, which the child has to reach and 7f's
  // corridor follows (`LANE_FOLLOWS_ITS_CHILD`) — putting that group back leaves the corridor
  // without the child it was moved for.
  const missAfter = total(endMisses);
  // A member of a row unit (`rowSeats`, dense-16x9 ticket 27) is moved toward the seat of its unit, not toward its own feeds: its progress is
  // measured to that seat. Measured to its own feeds, a member on one side of the unit's centre always moves away from them, the guard gave
  // its move back, and a unit shifted off its seat stood still at every step (review 1 of ticket 27).
  const seatX = rowSeat.get(id), nearerSeat = seatX !== undefined && Math.abs(group.bounds!.x - seatX) < Math.abs(began - seatX) - 0.5;
  if (wanted.size && !aligned.size && !own.some(feed => feed.transit) && missAfter > 0.5 && missAfter >= missBefore - 0.5 && !nearerSeat) {
    model.groups[id] = saved.group;
    for (const node of saved.nodes) model.nodes[node.id] = node;
    packClear(model, context, tier, saved.group, previous);
    standNearFeed(model, context, tier, id, saved.group, began + Math.max(farthestLeft, Math.min(toMean, farthestRight)), low, high);
    // `unresolved` already holds every wanted port: nothing was kept, so the loop above added them
    // all. It is returned as it stands, and the publication check excuses the whole group — which is
    // what the geometry now says, since the ports are back where this step found them. The cost is
    // that the step reports itself unresolved on every pass. The pass loop below ends on geometry
    // alone (ticket 75): the step is a fixed point, its `CENTRE_ALIGNMENT_INFEASIBLE` warning
    // already stands, and it neither spends the budget nor reports `PLACEMENT_NON_CONVERGENCE`.
    // The step's geometry is given back, so a decline judged against it does not stand (ticket 66).
    return { unresolved, group: saved.group, notes: { ...notes, declined: new Map() } };
  }
  return { unresolved, group, notes };
}
/** What the parent-port pass reads of the group steps (`StepReader`), on one context. The tail reservation is read once per tier: the pass moves ports, not boxes. */
export function stepReader(model: LayoutModel, context: CentreContext): StepReader {
  const tails = new Map<number, Map<string, number>>();
  const tail = (tier: number): Map<string, number> => {
    if (!tails.has(tier)) tails.set(tier, tailReservation(model, context, tier, context.groupOrder.get(tier)!));
    return tails.get(tier)!;
  };
  return {
    feeds: (tier, list, id) => { const { own, yielded } = groupFeeds(model, context, tier, list, id, false); return chosenFeeds(context, tier, own, yielded); },
    takes: (tier, list, id, from, to) => stepTakesOffset(model, context, tier, list, id, from, to, tail(tier)),
  };
}
/** Reusable bounded producer. The caller shares one budget across all ordered placement replay. */
export function centreDraft(model: LayoutModel, budget: CentreBudget): void {
  // The record of the alignment targets starts empty at the centre rule's input (architecture-2 ticket 66); every later run of the passes reads and
  // writes the one record (a replay of 7f too), and 7f drops it after its last centring reading.
  // A later run on a model whose centre rule ran no producer (a hand-made transaction) records no target and declines none, and says so (R6),
  // as the aligned extents do.
  if (model.alignmentTargets === undefined) {
    if (model.stage === CENTRE_RULE_INPUT) { model.alignmentTargets = {}; if (moveBeforeGrow(model)) model.alignmentSeats = {}; }
    else if (!model.diagnostics.some(d => d.code === 'ALIGNMENT_TARGETS_UNDECIDED')) {
      placementWarning(model, 'ALIGNMENT_TARGETS_UNDECIDED', `The centre rule recorded no alignment targets; this centring at stage ${model.stage} records none and declines none for good.`, []);
    }
  }
  // A move a replay before took at a frame-column wall is read again where the model stands now: a wall that no longer holds gives the move back before the
  // passes centre on it (architecture ticket 15, follow-up).
  withdrawRecorded(model);
  const seated = seatedFaces(model);
  // The parent side of a single feed, after the last pass has moved the children (architecture ticket 15). A face centring left alone stands centred
  // on the body it widened (architecture ticket 10, D3), read before the overlay windows. The windows of the overlay barycentre are read where
  // centring has left the partners (ticket 143): a window read in a pass is read on geometry that a later step moves. All three follow every run
  // of the passes below, the last one too.
  const passes = (): void => {
    timed('centre-passes', () => centrePasses(model, budget));
    const anchorTier = model.anchorTier;
    if (anchorTier !== undefined && model.tierBands.some(band => band.tier === anchorTier)) {
      const context = centreContext(model, anchorTier);
      standPortsOverChildren(model, context.steps, stepReader(model, context));
    }
    recentreSeatedFaces(model, seated, feedPorts(model));
    if (selectAnchorTier(model) !== undefined) timed('centre-overlay-final', () => { placeOverlayFree(model); rebuildRegions(model); });
    // The parent stand, the seated faces and the overlay windows move feeds after the last step: a seat whose kept port they leave off its feed is withdrawn.
    withdrawFallenSeatsOf(model);
  };
  passes();
  // The seated faces and the overlay barycentre above can widen a column after the moves were taken. A window that moves a partner also moves
  // the ends of its overlay chords, and a chord is an overlay stop of the alignment (7c): a chord that moves off a body frees a growth the passes
  // declined, and one that moves onto it stops a growth they kept; a window can also move a group that walled another (a canton member: its
  // sibling's step then has room it did not have). So read once more: a move given back, or an alignment the publication check (`centreViolations`,
  // `ahead` as the passes read it) finds the step would now take, is settled by the passes the budget has left (snack-theme ticket 157).
  // A round that changes neither the geometry nor what the check finds is a stall the passes cannot see: the rounds stop there and keep the
  // rest of the shared budget for the stages after 7c (ADR-0010). Each round spends a pass, so the rounds end on the budget too (R4).
  const check = (): string[] => timed('centre-violations', () => centreViolations(model, true));
  let found = withdrawRecorded(model) ? undefined : budget.remaining > 0 ? check() : [];
  let rounds = 0;
  while (found === undefined || (found.length > 0 && budget.remaining > 0)) {
    const before = geometry(model), was = found;
    rounds++;
    passes();
    found = check();
    if (was !== undefined && found.join() === was.join() && geometry(model).every((value, i) => Math.abs(value - before[i]!) <= 0.5)) break;
  }
  if (rounds > 0 && found.length > 0) {
    reportStall(model, [], 'Centering left an alignment off its feed after the last overlay windows and the passes the budget allowed; routing and the final gates decide the retained geometry.');
  }
  refreshWindowDeclines(model);
}
/**
 * A `CENTRE_ALIGNMENT_INFEASIBLE` names a feed that a step, or the parent stand, could not put on one x. A later pass, a parent spread, the parent
 * stand or a move of 7f may still stand the link vertical (architecture-2 ticket 32). Read where the model stands, a warning whose links all stand
 * vertical is withdrawn; a warning that names a link it cannot read stays. Run once, after the last move of 7f, on the geometry that publishes: run
 * when centring ends, it would change the diagnostics the later replays compare, and they would run again for it.
 */
export function refreshAlignmentDeclines(model: LayoutModel): void {
  model.diagnostics = model.diagnostics.filter(d => {
    if (d.code !== 'CENTRE_ALIGNMENT_INFEASIBLE') return true;
    const links = (d.owners ?? []).flatMap(owner => owner.kind === 'link' && 'id' in owner ? [owner.id] : []);
    return !links.length || !links.every(id => standsVertical(model, id));
  });
}
const WINDOW_DECLINED = 'CENTRE_WINDOW_DECLINED';
/** The window decline of `group` naming `links`: the group is the first owner, the links follow in id order. */
function windowDecline(group: string, sizes: string, links: readonly string[]): Diagnostic {
  const sorted = [...links].sort(), one = sorted.length === 1;
  return { stage: 'placement', severity: 'warning', code: WINDOW_DECLINED,
    message: `${group} declines its alignment: ${sizes}, so ${sorted.join(', ')} ${one ? 'keeps' : 'keep'} a jog; routing completes ${one ? 'it' : 'them'}.`,
    owners: [{ kind: 'group', id: group }, ...sorted.map(id => ({ kind: 'link' as const, id }))] };
}
const declinedGroup = (d: Diagnostic): string | undefined => (d.owners ?? []).flatMap(owner => owner.kind === 'group' && 'id' in owner ? [owner.id] : [])[0];
const declinedLinks = (d: Diagnostic): string[] => (d.owners ?? []).flatMap(owner => owner.kind === 'link' && 'id' in owner ? [owner.id] : []);
const declinedSizes = (d: Diagnostic): string => /^\S+ declines its alignment: (.*), so /.exec(d.message)?.[1] ?? '';
/**
 * One window decline per group (architecture-2 ticket 31): a later decline of the group with other seats adds its links to the warning the group has.
 */
function recordWindowDecline(model: LayoutModel, group: string, sizes: string, links: readonly string[]): void {
  const at = model.diagnostics.findIndex(d => d.code === WINDOW_DECLINED && declinedGroup(d) === group);
  if (at < 0) { model.diagnostics.push(windowDecline(group, sizes, links)); return; }
  const known = declinedLinks(model.diagnostics[at]!), added = links.filter(link => !known.includes(link));
  if (added.length) model.diagnostics[at] = windowDecline(group, declinedSizes(model.diagnostics[at]!), [...known, ...added]);
}
/**
 * A window decline names the feed links of a step that a pass declined (architecture-2 ticket 31). A later pass, or a move of 7f, may still bring a
 * child port to the x its seat wants (the parent port, or the lane of a transit). Read where the model stands, the warning names only the links whose
 * child port stands off that x, and a warning that names none is withdrawn. A link whose seat cannot be read stays named. Run when centring ends and
 * again after the last move of 7f.
 */
export function refreshWindowDeclines(model: LayoutModel): void {
  const anchor = model.anchorTier;
  if (anchor === undefined || !model.tierBands.some(band => band.tier === anchor) || !model.diagnostics.some(d => d.code === WINDOW_DECLINED)) return;
  const context = centreContext(model, anchor);
  model.diagnostics = model.diagnostics.flatMap(d => {
    if (d.code !== WINDOW_DECLINED) return [d];
    const group = declinedGroup(d), tier = group === undefined ? undefined : model.groups[group]?.tier;
    const step = context.steps.find(item => item.tier === tier);
    if (group === undefined || step === undefined) return [d];
    const { seats } = groupFeeds(model, context, step.tier, centringFeeds(model, step.tier, step.authority), group, false);
    const byLink = new Map([...seats.values()].map(feed => [feed.link, feed]));
    const named = declinedLinks(d), kept = named.filter(link => { const feed = byLink.get(link); return feed === undefined || Math.abs(feed.child.anchor!.x - feed.x) > 0.5; });
    if (!kept.length) return [];
    return kept.length === named.length ? [d] : [windowDecline(group, declinedSizes(d), kept)];
  });
}
/** Reads the recorded wall moves again (`withdrawWallMoves`) on the anchor tier centring stored; whether a move was given back. */
function withdrawRecorded(model: LayoutModel): boolean {
  const anchor = model.anchorTier;
  if (!model.parentWallMoves?.length || anchor === undefined || !model.tierBands.some(band => band.tier === anchor)) return false;
  const context = centreContext(model, anchor);
  return withdrawWallMoves(model, context.steps, stepReader(model, context));
}
/**
 * The ports centring owes or reads a feed x: the child ports and the parent ports whose x is the feed, read the way the publication check reads them (`readCentreViolations`): `groupFeeds` of every step. A
 * face with one of these ports is not recentred, so the check cannot see a feed moved (architecture ticket 10).
 */
function feedPorts(model: LayoutModel): Set<string> {
  const anchor = model.anchorTier, result = new Set<string>();
  if (anchor === undefined || !model.tierBands.some(band => band.tier === anchor)) return result;
  const context = centreContext(model, anchor);
  for (const { tier, authority } of context.steps) {
    const list = centringFeeds(model, tier, authority);
    for (const feed of list) result.add(portId(feed.parent.ref));
    for (const id of context.groupOrder.get(tier)!) for (const child of groupFeeds(model, context, tier, list, id, false).wanted.keys()) result.add(child);
  }
  return result;
}
function centrePasses(model: LayoutModel, budget: CentreBudget): void {
  if (!Number.isSafeInteger(budget.remaining) || !Number.isSafeInteger(budget.passes) || budget.remaining < 0
    || budget.passes < 0 || budget.remaining + budget.passes > 8) throw new Error('Centering requires one shared eight-pass budget');
  const anchor = selectAnchorTier(model);
  if (anchor === undefined) { delete model.anchorTier; return; }
  model.anchorTier = anchor;
  // A child column that stands beside cells of its parent is packed against them again on the widths the stages
  // since the pack left (ranked-groups ticket 28): the walls read below are the walls of a packed row.
  if (settleRows(model)) rebuildRegions(model);
  // Free groups first: the steps below read where every group stands (ranked-groups spec 3.1).
  let columns = frameColumns(model);
  // The first run has no windows: the partners stand where the skeleton left them, and a window read there fixes an x that the order rules
  // of the passes below read (ticket 143). The runs after a pass of steps read the partners where centring left them.
  placeOverlayFree(model, columns, false);
  let context = centreContext(model, anchor, columns), built = geometry(model);
  // The parents below the anchor tier spread over their children before the first step (architecture-2 ticket 32): the steps read the spread rows.
  if (reserveParentSpreads(model, context, columns)) {
    settleRows(model);
    rebuildRegions(model);
    context = centreContext(model, anchor, columns); built = geometry(model);
  }
  reserveAlignedExtents(model, context);
  let unresolved = new Set<string>(), ran = false;
  while (budget.remaining > 0) {
    ran = true;
    budget.remaining--; budget.passes++; attemptCounters.centringPasses++;
    stepPass = budget.passes;
    const before = geometry(model); unresolved = new Set();
    // A pass whose steps move geometry that a later stage of the same pass moves back is not at a
    // fixed point: the net change is nil, the work is not. Every step is measured on its own.
    let stepped = false;
    // The readings the last step left, while they still describe the model (`CarriedReadings`); a pass starts without them.
    let carry: CarriedReadings | undefined;
    for (const { tier, authority } of context.steps) {
      const list = centringFeeds(model, tier, authority), order = context.groupOrder.get(tier)!;
      const tail = tailReservation(model, context, tier, order), seats = rowSeats(model, context, tier, list);
      let previous: LayoutGroup | undefined;
      for (const id of order) {
        const group = model.groups[id]!;
        // Bar shaping owns their source-derived slots and stacked spans; row centering cannot repack
        // them. A group this step does not centre still yields the space a widened neighbour took.
        if (model.document.groups[id]!.shape === 'bar' || !list.some(feed => model.document.nodes[feed.child.ref.node]!.group === id)) {
          packClear(model, context, tier, group, previous);
          carry = undefined;
          // A bar stands where 7d will shape it, which may move no other group: the groups after it clear the extent its span gives it, not the box it has now (ticket 19).
          previous = standingBox(model, group);
          continue;
        }
        const start = geometry(model);
        const result = centreGroupStep(model, context, tier, list, id, previous, true, tail, seats, undefined, carry);
        carry = result.carry;
        if (!stepped && geometry(model).some((value, i) => Math.abs(value - start[i]!) > 0.5)) stepped = true;
        if (result.unresolved.size) unresolved.add(id);
        previous = result.group;
      }
    }
    // A partner that a step above moved is read where it stands now (the pass is idempotent).
    timed('centre-overlay-pass', () => { placeOverlayFree(model, columns, false); rebuildRegions(model); });
    const after = geometry(model);
    if (!stepped && after.every((value, i) => Math.abs(value - before[i]!) <= 0.5)) {
      // Rows packed again are a change of geometry: the next pass reads the settled walls.
      if (settleRows(model)) rebuildRegions(model);
      // The context (winners, group order, lane limits) reads the geometry it was built on. A fixed
      // point of the passes is a fixed point of the step only when the publication check, which
      // replays each step on a context built where the model now stands, agrees. When it does not,
      // the next pass reads a context built from the geometry that stands now.
      if (!timed('centre-violations', () => centreViolations(model, true)).length) return;
      const now = geometry(model);
      if (now.every((value, i) => Math.abs(value - built[i]!) <= 0.5)) break;
      columns = frameColumns(model);
      context = centreContext(model, anchor, columns); built = now;
    }
  }
  if (settleRows(model)) rebuildRegions(model);
  // Reached when the last pass still changed geometry, or when the geometry stood and the publication
  // check still found an alignment the step would move (a stall the passes cannot see). A fixed point
  // that the check confirms returns above. A run that entered with no budget left has measured
  // nothing, so it reports only what the check finds off its feed.
  if (ran || timed('centre-violations', () => centreViolations(model, true)).length > 0) reportStall(model, [...unresolved]);
}
/** The link a centring item names; undefined for an item that no link of the model owns. The item text starts with its feed's link id (`readCentreViolations`). */
export function centreItemLink(model: LayoutModel, item: string): string | undefined {
  let found: string | undefined;
  for (const link of model.links) if (item.startsWith(`${link.id}: `) && (found === undefined || link.id.length > found.length)) found = link.id;
  return found;
}
/** The code of the record that the centre step spent its budget or stopped at a fixed point with an alignment open (DR-15). Restore reads its link owners. */
export const CENTRE_ALIGNMENT_OPEN = 'CENTRE_ALIGNMENT_OPEN';
/** The links of the alignments the publication check finds off their feeds on this model. The check only names owners: it adds no verdict to a test's tap. */
function openLinks(model: LayoutModel, excuseChords: boolean): string[] {
  const sink = verdictTap.sink;
  delete verdictTap.sink;
  let found: string[];
  try { found = publishedCentreViolations(model, true); } finally { if (sink !== undefined) verdictTap.sink = sink; }
  const links = new Set<string>();
  // The publication (`ahead` off) excuses a held cross chord; the producer form read here does not, so at the end of 7f (`excuseChords`) the same excuse
  // is applied. Earlier drafts have no settled link kinds, so they name every link and the end of 7f narrows the names.
  const byId = linkById(model);
  const crossChord = (id: string): boolean => withSharedLinkKinds(() => { const link = byId.get(id); return link !== undefined && isRoutedChord(model, link) && chordKind(model, link) === 'cross'; });
  for (const item of found) { const link = centreItemLink(model, item); if (link !== undefined && !(excuseChords && crossChord(link))) links.add(link); }
  return [...links];
}
/**
 * Writes the record of the open alignments. `replace` sets the owners to exactly the links the publication check flags now; otherwise they are added.
 * The record is made only by the centre emitter, and only where the centre step stalled (R5: the exemption is limited to its owner and stage).
 */
function recordOpen(model: LayoutModel, replace: boolean): void {
  const links = openLinks(model, replace);
  let record = model.diagnostics.find(d => d.stage === 'placement' && d.code === CENTRE_ALIGNMENT_OPEN);
  if (record === undefined) {
    record = { stage: 'placement', severity: 'warning', code: CENTRE_ALIGNMENT_OPEN, message: 'Alignments the centre step left off their feeds; routing and the final gates decide the retained geometry.', owners: [] };
    model.diagnostics.push(record);
  }
  const owners = replace ? [] : (record.owners ??= []);
  if (replace) record.owners = owners;
  for (const id of links) if (!owners.some(o => o.kind === 'link' && o.id === id)) owners.push({ kind: 'link', id });
}
function reportStall(model: LayoutModel, unresolved: string[], message = 'Centering exhausted the shared eight-pass budget; unresolved alignments remain for routing and final gates.'): void {
  if (!model.diagnostics.some(d => d.stage === 'placement' && d.code === 'PLACEMENT_NON_CONVERGENCE')) placementWarning(model, 'PLACEMENT_NON_CONVERGENCE', message, unresolved, 'group');
  recordOpen(model, false);
}
/** Counters for centring-flag and centre-check reads; for tests and measurement only, never read by the layout. */
export const centreReadCounters = { flagChecked: 0, flagSkipped: 0, cacheHits: 0 };
export function resetCentreReadCounters(): void {
  centreReadCounters.flagChecked = 0;
  centreReadCounters.flagSkipped = 0;
  centreReadCounters.cacheHits = 0;
}
/**
 * A replay that centred and then rebuilt what depends on the centring (bundle anchors, bars, regions) can leave an alignment
 * the step would move: the passes ended at a fixed point, and the model published from them is not one. The check the
 * publication runs, run here, says so, so that a model never publishes an unexplained centring violation (ticket 75).
 * When `deferNames` is true (inside 7f, before `nameOpenCentring` replaces the owners at the end), a model that already carries
 * `CENTRE_ALIGNMENT_OPEN` skips the redundant `recordOpen` call.
 */
export function flagUnverifiedCentring(model: LayoutModel, deferNames = false): void {
  // Only the centre step's own record arms the naming; a placement non-convergence of another emitter does not (DR-15, R5).
  if (model.diagnostics.some(d => d.stage === 'placement' && d.code === CENTRE_ALIGNMENT_OPEN)) {
    if (deferNames) {
      centreReadCounters.flagSkipped++;
      return;
    }
    centreReadCounters.flagChecked++;
    recordOpen(model, false);
  } else {
    centreReadCounters.flagChecked++;
    if (!model.diagnostics.some(d => d.stage === 'placement' && d.code === 'PLACEMENT_NON_CONVERGENCE') && centreViolations(model, true).length > 0) {
      reportStall(model, [], 'Centering left an alignment off its feed after the bundle, bar and region rebuilds that follow it; routing and the final gates decide the retained geometry.');
    }
  }
}
/**
 * The end of 7f (DR-15). Where the centre step has recorded a stall, the end trim and the moves after it may open other links; the record is
 * set to exactly the links the publication check flags. Where no stall is recorded nothing is named: an alignment open then is a defect of a
 * move after the centre step, and the publication refuses it.
 */
export function nameOpenCentring(model: LayoutModel): void {
  if (model.diagnostics.some(d => d.stage === 'placement' && d.code === CENTRE_ALIGNMENT_OPEN)) recordOpen(model, true);
}
/**
 * The parts of the model that a replayed centring step only reads. The check runs one step per group, each on its own copy; these parts are copied once, frozen
 * and shared by all the copies (a write to one throws), so a copy parses only the groups and the nodes (architecture ticket 14). The diagnostics are shared too: a step with `warn` off writes none, and one that does throws and runs again on a full copy.
 */
const TRIAL_SHARED = ['document', 'links', 'groupLinks', 'meshBuses', 'lanes', 'bundles', 'obstacles', 'frames', 'labels', 'regions', 'tierBands', 'diagnostics'];
/**
 * The stage 7c invariant, readable at any later stage (ADR-0010): for every centred group, replaying
 * its own centring step on a copy either leaves each owning alignment where the model has it, or ends
 * unresolved by the producer's own rules for that port (infeasible alignment, conflicting feeds, a
 * window it cannot cross). The check is scoped per child port and reads no diagnostics: a serialized
 * diagnostic proves nothing, and one port's genuine blockage excuses no other port. Ports that later rules own — bar
 * drops and endpoints (7d), ports any bundle member uses (7e) — are not compared.
 */
export function centreViolations(model: LayoutModel, ahead = false, shared?: CentreContext): string[] {
  return withSharedLinkKinds(() => readCentreViolations(model, ahead, shared, shared === undefined, false));
}
/**
 * The publication check (`validateRegionClaims`): `centreViolations`, and for every group it replays, a face where the replay declines a target the
 * stored record does not decline (`alignment-targets-differ`, architecture-2 ticket 66; `sameDeclines`). Only the publication reads the record
 * this way: the 7f judges compare the violations of two candidates, and a record a candidate's move leaves behind is no violation of that move.
 * The publication excuses a held cross chord (any angle) and so never replays a group for it; `ahead` reads as the producer's own check does.
 */
export function publishedCentreViolations(model: LayoutModel, ahead = false, untrimmed?: LayoutModel): string[] {
  // A caller that has built the untrimmed geometry of the model (the publication check of the end trim, ticket 68) hands it in: it is read as is.
  return withSharedLinkKinds(() => readCentreViolations(untrimmed ?? model, ahead, undefined, true, true));
}
/**
 * The faces where the publication's replay of a 7f draft would decline a target its record does not (`alignment-targets-differ`), read as the
 * producer reads ahead. A move after the last centring of 7f (the lane reseat) changes what a step reads; such a move is judged by the comparison
 * the publication makes, since no centring follows it to write the decline into the record (R1, R5).
 */
export function recordDeclineFindings(model: LayoutModel): string[] {
  return publishedCentreViolations(model, true).filter(item => item.startsWith(`${ALIGNMENT_TARGETS_DIFFER}: `));
}
/**
 * The text of the model one check read, and its answer (architecture-2 ticket 63). With no context handed in, the answer reads the model and `ahead` alone:
 * the context is built from the model, every trial is parsed from these texts, and the freeze block is read by nothing the check calls. So a later
 * check on the same model object whose texts are all equal has the same answer, and its replays are not run again. `taps` are the verdicts the
 * replays gave a test's tap (`verdictTap`), given again with the answer; undefined when no tap listened, and such an answer is not reused while one does.
 */
interface CheckedAnswer { ahead: boolean; targets: boolean; own: string; still: string; nodes: ReadonlyMap<string, string>; result: readonly string[]; taps: readonly (readonly [string, string])[] | undefined }
const checkedAnswers = new WeakMap<LayoutModel, CheckedAnswer>();
const answerCache = readCache('centreCheckAnswer');
/** Whether two checks read one model text: the same parts, the same nodes in the same order. */
function sameModelText(known: CheckedAnswer, own: string, still: string, nodes: ReadonlyMap<string, string>): boolean {
  if (known.own !== own || known.still !== still || known.nodes.size !== nodes.size) return false;
  const was = known.nodes.entries();
  for (const [key, text] of nodes) { const [oldKey, oldText] = was.next().value!; if (oldKey !== key || oldText !== text) return false; }
  return true;
}
/** Runs `run` with every verdict it gives the tap also written to `into`; with `forward` off the tap does not see them. Nothing is recorded while no tap listens. */
function recordTaps<T>(into: [string, string][] | undefined, forward: boolean, run: () => T): T {
  const sink = verdictTap.sink;
  if (into === undefined || sink === undefined) return run();
  verdictTap.sink = (name, value) => { into.push([name, value]); if (forward) sink(name, value); };
  try { return run(); } finally { verdictTap.sink = sink; }
}
function readCentreViolations(model: LayoutModel, ahead: boolean, shared: CentreContext | undefined, reuse: boolean, targets: boolean): string[] {
  // The replay reads the geometry its producer decided on (R1): the bodies and boxes before the end trim of 7f (architecture-2 ticket 68). A
  // narrower sibling would let it keep a target the producer could not keep. A context built on the trimmed boxes is not read.
  if (model.bodyTrims !== undefined) return readCentreViolations(untrimmedModel(model), ahead, undefined, reuse, targets);
  const anchor = model.anchorTier;
  if (anchor === undefined || !model.tierBands.some(band => band.tier === anchor)) return [];
  const context = shared ?? centreContext(model, anchor);
  // Stage 7e re-anchors every port a bundle member uses. A child port it moved stays where 7e put it
  // from then on; a parent port it moved is a new feed x that 7f re-centres under, so a feed on such
  // a parent is excused only while the model sits exactly at the bundles stage.
  const bundled = new Set(model.links.filter(link => link.bundle && link.attachments).flatMap(link => [portId(link.attachments!.from), portId(link.attachments!.to)]));
  // `ahead`: a producer is running, and the model it makes is published one stage after the one it stands at.
  const afterBundles = (ahead ? ['bars', 'bundles', 'bands', 'route', 'link-labels', 'validate', 'emit'] : ['bundles', 'bands', 'route', 'link-labels', 'validate', 'emit']).includes(model.stage);
  const atBundles = model.stage === (ahead ? 'bars' : 'bundles');
  const drops = new Set(model.barDrops.map(drop => drop.link));
  const isBar = (node: string): boolean => model.document.groups[model.document.nodes[node]!.group]!.shape === 'bar';
  const result: string[] = [];
  const byId = linkById(model);
  // The replay reads placement geometry alone; nothing it calls reads the freeze block, and on a
  // large model that block is more than a third of the JSON the per-group copy below would carry.
  const { freeze: _frozen, ...replayed } = model;
  void _frozen;
  // Every trial starts from the same model. The parts a step only reads are copied once and frozen (`TRIAL_SHARED`), and so are the nodes:
  // a trial takes a fresh copy of the nodes of its group and of the group before it (the ones a step writes), and shares the rest. A step that writes
  // to a shared part throws; that trial is then run again on a full copy, so the answer is the one a full copy gives (architecture ticket 14).
  let baseReadings: BaseReadings | undefined;
  let replayedText: string | undefined, sharedParts: Record<string, unknown> | undefined, sharedNodes: Record<string, LayoutNode> | undefined, nodeTexts: Map<string, string> | undefined, fullText: string | undefined;
  let key: Omit<CheckedAnswer, 'result' | 'taps'> | undefined;
  const taps: [string, string][] | undefined = reuse && verdictTap.sink !== undefined ? [] : undefined;
  const freezeDeep = (value: unknown): void => { if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); } };
  for (const { tier, authority } of context.steps) {
    const list = centringFeeds(model, tier, authority), order = context.groupOrder.get(tier)!;
    // The reservation of the tier is read only by a replay, and a replay runs only for a group with a candidate: the first one reads it.
    let tail: Map<string, number> | undefined, seats: Map<string, number> | undefined;
    let previous: LayoutGroup | undefined;
    for (const id of order) {
      const group = model.groups[id]!;
      const owned = groupFeeds(model, context, tier, list, id, false);
      if (model.document.groups[id]!.shape === 'bar' || !owned.own.length) { previous = group; continue; }
      // Both lookups below read one key per wanted child; keying them once keeps the scan of the
      // group's own feeds and ports out of the loop. First entry wins, as `find` did.
      const ownFeeds = new Map<string, Feed>();
      for (const item of owned.own) { const at = portId(item.child.ref); if (!ownFeeds.has(at)) ownFeeds.set(at, owned.seats.get(at) ?? item); }
      const groupPorts = new Map<string, LayoutPort>();
      for (const nodeId of group.nodes) for (const item of model.nodes[nodeId]!.ports) {
        const at = portId(item.ref); if (!groupPorts.has(at)) groupPorts.set(at, item);
      }
      // The replay below says only which child ports the producer's own step could not resolve, and those are excused. A group whose wanted
      // ports are all excused by another rule, or stand within half a pixel of their feed, has nothing for the replay to excuse: it is not run.
      const candidates: { child: string; x: number; feed: Feed; port: LayoutPort }[] = [];
      for (const [child, x] of owned.wanted) {
        const feed = ownFeeds.get(child)!;
        if (byId.get(feed.link)?.bundle || drops.has(feed.link)) continue;
        // A held chord runs between two faces at any angle: its child port owes it no place under the feed (ticket 100, the centring of a chord that a title band once refused).
        // Only the publication check excuses it: the centring loop's own check (`ahead`) keeps asking for the alignment, so the passes are the ones they were.
        if (!ahead && isRoutedChord(model, byId.get(feed.link)!) && chordKind(model, byId.get(feed.link)!) === 'cross') continue;
        if ((afterBundles && bundled.has(child)) || (atBundles && bundled.has(portId(feed.parent.ref)))) continue;
        if (isBar(feed.child.ref.node) || isBar(feed.parent.ref.node)) continue;
        const port = groupPorts.get(child)!;
        if (Math.abs(port.anchor!.x - x) > 0.5) candidates.push({ child, x, feed, port });
      }
      if (!candidates.length) { previous = group; continue; }
      if (replayedText === undefined) {
        const own: Record<string, unknown> = {}, still: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(replayed)) (TRIAL_SHARED.includes(key) ? still : own)[key] = value;
        nodeTexts = new Map(Object.entries(model.nodes).map(([key, node]) => [key, JSON.stringify(node)]));
        delete own.nodes;
        replayedText = JSON.stringify(own);
        const stillText = JSON.stringify(still);
        if (reuse) {
          const known = checkedAnswers.get(model);
          if (known !== undefined && known.ahead === ahead && known.targets === targets && (known.taps !== undefined || verdictTap.sink === undefined) && sameModelText(known, replayedText, stillText, nodeTexts)) {
            centreReadCounters.cacheHits++;
            // Under `LayoutOptions.checkCaches` the check runs again in full, without reuse, and its answer and verdicts must be the ones kept.
            const answer = answerCache.hit(model, { result: known.result, taps: known.taps }, () => {
              const again: [string, string][] | undefined = known.taps === undefined ? undefined : [];
              const result = recordTaps(again, false, () => readCentreViolations(model, ahead, undefined, false, targets));
              return { result, taps: again };
            });
            for (const [name, value] of answer.taps ?? []) tapVerdict(name, () => value);
            return [...answer.result];
          }
          answerCache.miss();
          key = { ahead, targets, own: replayedText, still: stillText, nodes: nodeTexts };
        }
        sharedNodes = Object.fromEntries([...nodeTexts].map(([key, text]) => [key, JSON.parse(text) as LayoutNode]));
        freezeDeep(sharedNodes);
        sharedParts = JSON.parse(stillText) as Record<string, unknown>;
        freezeDeep(sharedParts);
      }
      const reserved = tail ??= tailReservation(model, context, tier, order), pooled = seats ??= rowSeats(model, context, tier, list);
      const base: BaseReadings = baseReadings ??= { texts: nodeTexts! };
      const attempt = (full: boolean): { trial: LayoutModel; step: ReturnType<typeof centreGroupStep> } => {
        let trial: LayoutModel;
        if (full) {
          trial = JSON.parse(fullText ??= JSON.stringify(replayed)) as LayoutModel;
        } else {
          const nodes: Record<string, LayoutNode> = { ...sharedNodes };
          for (const nodeId of [...group.nodes, ...(previous?.nodes ?? [])]) { const text = nodeTexts!.get(nodeId); if (text !== undefined) nodes[nodeId] = JSON.parse(text) as LayoutNode; }
          const fresh = JSON.parse(replayedText!) as Record<string, unknown>;
          trial = Object.assign(fresh, sharedParts, { nodes }) as unknown as LayoutModel;
        }
        return { trial, step: centreGroupStep(trial, context, tier, centringFeeds(trial, tier, authority), id, previous && trial.groups[previous.id], false, reserved, pooled, base) };
      };
      let replay: ReturnType<typeof attempt>;
      try { replay = recordTaps(taps, true, () => attempt(false)); } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        attemptCounters.centreCheckFallbacks++;
        replay = recordTaps(taps, true, () => attempt(true));
      }
      const { step, trial } = replay;
      previous = group;
      // The record is read, never decided again (R1): a face where the replay declines a target the record does not decline is a finding (R5).
      // Only 7f's producer ran the tally that declines (its draft stands at `bundles`); 7c to 7e decline nothing, and a chord-stage replay of the
      // 7e output would read rules its producer did not run. So the publication compares the record of 7f alone: at `bands`, and on 7f's own draft
      // when its producer reads ahead (the draft publishes at `bands`), so a move after the last centring is judged by the comparison too.
      if (targets && (model.stage === 'bands' || (ahead && model.stage === 'bundles' && moveBeforeGrow(model))) && model.alignmentTargets !== undefined) {
        for (const nodeId of group.nodes) for (const side of ['top', 'bottom', 'left', 'right'] as const) {
          const face = faceKey(nodeId, side);
          if (!sameDeclines(model.alignmentTargets[face], trial.alignmentTargets?.[face])) result.push(`${ALIGNMENT_TARGETS_DIFFER}: ${face}`);
        }
      }
      // A group its row seats off its own wanted x (`rowSeats`) leaves its wanted ports unresolved by design, so its ports prove nothing: the replay
      // must also leave its box and its bodies where they stand, or the group is off its seat and no port of it is excused (R5, dense-16x9 ticket 27).
      const offSeat = pooled.has(id) && [group.id, ...group.nodes].some(item => {
        const was = (model.groups[item] ?? model.nodes[item])!.bounds!, now = (trial.groups[item] ?? trial.nodes[item])!.bounds!;
        return Math.abs(now.x - was.x) > 0.5 || Math.abs(now.width - was.width) > 0.5;
      });
      for (const { child, x, feed, port } of candidates) {
        // Only the ports the producer's own step could not resolve are excused, never their siblings.
        if (!offSeat && step.unresolved.has(child)) continue;
        result.push(`${feed.link}: ${child} sits at x ${port.anchor!.x} instead of its feed x ${x}`);
      }
    }
    result.push(...rowUnitFaults(model, replayed as LayoutModel, context, tier, authority, list, order, seats ??= rowSeats(model, context, tier, list), () => tail ??= tailReservation(model, context, tier, order)));
  }
  if (key !== undefined) checkedAnswers.set(model, { ...key, result: [...result], taps });
  return result;
}
/**
 * The row units of one tier, checked as units (dense-16x9 ticket 27, review 1; R1, R5). The replay of each group above runs on the model as it
 * stands, so a member of a unit that stands off its seat is held by its neighbours, which stand off it too: a whole unit shifted off its seat
 * passes every replay of one group. The seat is joint (`rowSeats`: the unit's membership and the median of what its members want), so it is
 * checked jointly: when a member stands off its seat (more than half a pixel), one pass of the tier's steps is replayed on a copy, in the order
 * and with the seats and the tail reservation the passes of 7c read, and every member the pass moves (its box or a body) is a finding. A unit
 * at its seat costs nothing; a unit the slack keeps off its seat (the clamp, a guard) stands where the pass leaves it, so the residual the slack
 * forced is no finding. The check covers members with no candidate port (a bundle feed, a shared parent port): it reads boxes, not ports.
 * The finding names the first own feed of the first moved member, so a spent budget names it as it names an open alignment (ADR-0010).
 */
function rowUnitFaults(model: LayoutModel, replayed: LayoutModel, context: CentreContext, tier: number, authority: number, list: Feed[], order: readonly string[],
  seats: ReadonlyMap<string, number>, tail: () => Map<string, number>): string[] {
  if (![...seats].some(([id, seat]) => Math.abs(model.groups[id]!.bounds!.x - seat) > 0.5)) return [];
  const trial = JSON.parse(JSON.stringify(replayed)) as LayoutModel, reserved = tail();
  const feeds = centringFeeds(trial, tier, authority);
  let previous: LayoutGroup | undefined;
  for (const id of order) {
    const group = trial.groups[id]!;
    if (trial.document.groups[id]!.shape === 'bar' || !feeds.some(feed => trial.document.nodes[feed.child.ref.node]!.group === id)) {
      packClear(trial, context, tier, group, previous);
      previous = standingBox(trial, group);
      continue;
    }
    previous = centreGroupStep(trial, context, tier, feeds, id, previous, false, reserved, seats).group;
  }
  const moved = [...seats.keys()].filter(id => [id, ...model.groups[id]!.nodes].some(item => {
    const was = (model.groups[item] ?? model.nodes[item])!.bounds!, now = (trial.groups[item] ?? trial.nodes[item])!.bounds!;
    return Math.abs(now.x - was.x) > 0.5 || Math.abs(now.width - was.width) > 0.5;
  }));
  if (!moved.length) return [];
  const link = groupFeeds(model, context, tier, list, moved[0]!, false).own[0]!.link;
  return [`${link}: the row unit of ${[...seats.keys()].join(', ')} stands off its seat: a replay of its tier moves ${moved.join(', ')}`];
}
/** The code of the note that a model keeps the wide seats of the first feeds: narrowing it would have bent a link that stood straight (ticket 12, "narrow only if free"). */
const KEPT_WIDE = 'CENTRE_SEATS_KEPT_WIDE';
const keptWide = (model: LayoutModel): boolean => model.diagnostics.some(d => d.code === KEPT_WIDE);
/** The links whose two ends stand on one vertical, facing: the links that run straight. */
function straightLinks(model: LayoutModel): Set<string> {
  const result = new Set<string>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments) continue;
    const one = findPort(model, link.attachments.from)?.anchor, two = findPort(model, link.attachments.to)?.anchor;
    if (one && two && Math.abs(one.x - two.x) <= 0.5) result.add(link.id);
  }
  return result;
}
/** Whether any child port of the model is fed by two parents at different x: the only case the narrow seat differs from the wide one. */
function hasRivals(model: LayoutModel): boolean {
  const anchor = model.anchorTier;
  if (anchor === undefined || !model.tierBands.some(band => band.tier === anchor)) return false;
  const context = centreContext(model, anchor);
  for (const { tier, authority } of context.steps) {
    const list = centringFeeds(model, tier, authority), seen = new Map<string, number>();
    for (const feed of list) {
      if (feed.transit) continue;
      const key = portId(feed.child.ref), x = seen.get(key);
      if (x !== undefined && x !== feed.x) return true;
      seen.set(key, feed.x);
    }
  }
  return false;
}
/** After the centre rule an empty spread record and an absent one both mean that no parent spread (`reserveParentSpreads`): the empty one is dropped. */
function dropEmptySpreads(model: LayoutModel): void {
  if (model.parentSpreads !== undefined && !Object.keys(model.parentSpreads).length) delete model.parentSpreads;
}
/**
 * The centre rule's passes and its one judgement of their growths (architecture-2 ticket 71). The passes run from the rule's input; at their end a
 * width the passes added to align a face's links and that no kept target or kept chord uses is stranded (`strandedGrowth`). When one is, the
 * passes run once more from the same input with the record `givenBack`, and every step of a given-back body keeps a growth only for a target it
 * stands. The judgement reads the end of all eight passes, not one pass: a growth one pass strands is the one a later pass may complete.
 *
 * Bound (R4): at most two runs of the passes, each on its own eight-pass budget (the first run is discarded whole, so its budget is no budget of
 * the second). A growth the second run strands that the first did not is kept, and named (`CENTRE_GROWTH_KEPT`, info), as is a given-back body that
 * ends the second run wider than the rule's input (its step is declined only when no aligned port of its group stands).
 */
function centreGivingBack(draft: LayoutModel): void {
  // With `layout.moveBeforeGrow` a seat gives its own growth back (ADR-0027, clause 4): the passes run once.
  if (moveBeforeGrow(draft)) { centreDraft(draft, createCentreBudget()); return; }
  const input = JSON.stringify(draft);
  centreDraft(draft, createCentreBudget());
  const back = strandedGrowth(draft, JSON.parse(input) as LayoutModel);
  if (!Object.keys(back).length) return;
  for (const key of Object.keys(draft)) delete (draft as unknown as Record<string, unknown>)[key];
  Object.assign(draft, JSON.parse(input) as LayoutModel, { givenBack: back });
  centreDraft(draft, createCentreBudget());
  const was = JSON.parse(input) as LayoutModel;
  const kept = Object.keys(strandedGrowth(draft, was)).filter(node => !Object.hasOwn(back, node));
  if (kept.length) {
    draft.diagnostics.push({ stage: 'placement', severity: 'info', code: GROWTH_KEPT,
      message: `The second run of the centring passes strands a growth of ${kept.join(', ')}; the centre rule judges its growths once, so the growth stays.` });
  }
  // The decline reads the targets of the whole group: a given-back body whose sibling stands a target keeps the step's growth (or one of its own
  // ports stood and a later step moved it off). The record then names a growth the geometry keeps, and the note says so (R6).
  const wide = Object.keys(back).filter(node => draft.nodes[node]!.bounds!.width > was.nodes[node]!.bounds!.width + EPS);
  if (wide.length) {
    draft.diagnostics.push({ stage: 'placement', severity: 'info', code: GROWTH_KEPT,
      message: `${wide.join(', ')} ends the second run of the passes wider than the rule's input; its growth stays.` });
  }
}
/** The note that the one judgement of the centre rule left a growth the second run stranded (ticket 71, R6). */
const GROWTH_KEPT = 'CENTRE_GROWTH_KEPT';
export function centre(model: LayoutModel): LayoutModel {
  return withStageMutation(model, 'centre', draft => {
    // The wide twin: the seats of the first feeds with the conflicting feeds pulling, as before ticket 12. It is built only where a port has two parents.
    const twin = (): LayoutModel => {
      const copy = JSON.parse(JSON.stringify(draft)) as LayoutModel;
      copy.diagnostics.push({ stage: 'placement', severity: 'info', code: KEPT_WIDE, message: 'The first feeds seat their ports; a port with two parents is not narrowed.' });
      return copy;
    };
    const wideTwin = hasRivals(draft) ? twin() : undefined;
    orderBundles(draft); normalizePrimaryBundlePorts(draft); centreGivingBack(draft); recordSeatedSideLanes(draft); dropEmptySpreads(draft);
    if (!wideTwin) return;
    centreGivingBack(wideTwin); recordSeatedSideLanes(wideTwin); dropEmptySpreads(wideTwin);
    // Narrow only if free: a link that stands straight under the wide seat must stand straight under the narrow one, or the node keeps its wide seat.
    const narrow = straightLinks(draft);
    if ([...straightLinks(wideTwin)].every(id => narrow.has(id))) return;
    for (const key of Object.keys(draft)) delete (draft as unknown as Record<string, unknown>)[key];
    Object.assign(draft, wideTwin);
  });
}
