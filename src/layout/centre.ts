import type { AlignedExtentEdge, Diagnostic, LayoutGroup, LayoutModel, LayoutNode, LayoutPort, LayoutStage } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { portAnchor } from '../geometry/index.js';
import { laneSidesHold, spanBreaches, recordSeatedSideLanes, occupiedOverhang, riserAvoidance, riserKeepOutAfterMove, riserNoDeeper, riserPenetrations, selectAnchorTier } from './lanes.js';
import { holdsMove } from './move-reservations.js';
import { cellReach } from './frames.js';
import { memberRoom, standsInCanton } from './read/canton.js';
import { centringFeeds, type Feed } from './read/feeds.js';
import { straightChordIds } from './read/overlay-straight.js';
import { holds, profiles, reading, straightOf, tapVerdict } from './objective.js';
import { besideWalls, frameColumns, keepOutShifts, packBesideRows, type CellWindow, type FrameColumn } from './columns.js';
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
import { packRowsOf } from './grid.js';
import { rowGap } from './sides-two.js';
import { linkLabelGap } from './bands.js';
import { alignmentAllowance, ownSideWidth } from './size.js';
import { withStageMutation } from './mutation.js';
import { barReach } from './bars.js';
import { placeOverlayFree } from './overlay-place.js';
import { fitRegionGroup, GROUP_PADDING, placementWarning, rebuildRegions, right } from './regions.js';
import { EPS, segmentRectDistance } from '../geometry/planar.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { standPortsOverChildren, withdrawWallMoves, type StepReader } from './parent-stand.js';
import { chordKind, isRoutedChord, withSharedLinkKinds, withStepLinkKinds } from './frame-paths.js';

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
    if (otherIndex < index) limit.low = Math.max(limit.low, right(other) + Math.max(rowGap(model, id, node.id), linkLabelGap(model, id, node.id)));
    else limit.high = Math.min(limit.high, other.x - Math.max(rowGap(model, node.id, id), linkLabelGap(model, node.id, id)));
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
 * and the outer ones stand 10 + pitch / 2 inside the edges. The one statement of the alignment's edge arithmetic: `keptTargets`, `alignSide`
 * and the aligned extent (`alignedExtentOf`) read it.
 */
function alignedEdges(index: number, x: number, count: number, pitch: number): { low: number; high: number } {
  return { low: x - index * pitch - 10 - pitch / 2, high: x + (count - 1 - index) * pitch + 10 + pitch / 2 };
}
/** The keep decision of `alignSide` without its mutation: the targets a side keeps, none when the side is declined as a whole (architecture ticket 12). */
function keptTargets(node: LayoutNode, side: Side, targets: ReadonlyMap<string, number>, limit: WideningLimit, stops: OverlayStops, stopped: (link: string) => void = () => {}): { index: number; x: number; key: string }[] {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
  const pitch = node.sidePitch![side]!, kept: { index: number; x: number; key: string }[] = [];
  const box = node.bounds!, oldRight = right(box);
  if (box.x < limit.low - EPS || oldRight > limit.high + EPS) return [];
  const allowance = alignmentAllowance(node, side);
  /** The width the body ends with when the port at `index` is aligned to `x`. */
  const reach = (index: number, x: number): number => { const edges = alignedEdges(index, x, ports.length, pitch); return Math.max(oldRight, edges.high) - Math.min(box.x, edges.low); };
  for (const [index, port] of ports.entries()) {
    const key = portId(port.ref), x = targets.get(key), last = kept[kept.length - 1];
    const edges = x === undefined ? undefined : alignedEdges(index, x, ports.length, pitch);
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
    if (x !== undefined && (!last || x - last.x >= (index - last.index) * pitch)) kept.push({ index, x, key });
  }
  if (!kept.length) return [];
  const first = kept[0]!, last = kept[kept.length - 1]!;
  if (Math.max(oldRight, alignedEdges(last.index, last.x, ports.length, pitch).high)
    - Math.min(box.x, alignedEdges(first.index, first.x, ports.length, pitch).low) > allowance + EPS) return [];
  return kept;
}

/**
 * Keep compatible targets that fit between siblings and inside the node's own alignment allowance;
 * other ports retain their legal slots.
 *
 * A target is kept only when reaching it leaves the body no wider than `alignmentAllowance` — the
 * third bound on a widening, beside the siblings of the row and the reserved lane and flank window
 * of `reservedWindow`, and the one that says the node has to stay something a reader still reads as
 * this node (ticket 29). What gives way is the alignment: the port keeps its legal slot, the feed is
 * reported `CENTRE_ALIGNMENT_INFEASIBLE` like any other alignment the row cannot hold, and stage 8
 * routes the link instead of receiving it pinned. Two targets that each fit alone but not together —
 * one parent far to the left, one far to the right — decline the whole side, because widening to the
 * outer one is the same growth by another name.
 */
function alignSide(node: LayoutNode, side: Side, targets: Map<string, number>, limit: WideningLimit, stops: OverlayStops, stopped: (link: string) => void,
  avoid: { xs: number[]; keep: number; routed: Set<string> } = { xs: [], keep: 0, routed: new Set() }, held: ReadonlyMap<string, (x: number) => boolean> = new Map()): Set<string> {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
  const pitch = node.sidePitch![side]!;
  const box = node.bounds!, oldRight = right(box);
  const kept = keptTargets(node, side, targets, limit, stops, stopped);
  if (!kept.length) return new Set();
  const first = kept[0]!, last = kept[kept.length - 1]!;
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
    const landing = ports.map((_, index) => {
      const before = [...kept].reverse().find(target => target.index <= index), after = kept.find(target => target.index >= index);
      return before && after && before.index !== after.index ? before.x + (index - before.index) * (after.x - before.x) / (after.index - before.index)
        : before ? before.x + (index - before.index) * pitch : first.x - (first.index - index) * pitch;
    });
    if (landing.some((x, index) => avoid.routed.has(portId(ports[index]!.ref)) && avoid.xs.some(riser => Math.abs(x - riser) < avoid.keep))) return new Set();
  }
  // A port of a held chord that is not itself an alignment target is packed against the kept ones, and the chord follows it. The chord was decided
  // at the old x; where the new one lays it across the lane of another link, `validateLanes` refuses the fixed path at publication. The side is declined
  // instead, like the riser case above; stage 8 routes the feeds that lose their alignment.
  if (held.size) {
    const seats = ports.map((_, index) => {
      const before = [...kept].reverse().find(target => target.index <= index), after = kept.find(target => target.index >= index);
      return before && after && before.index !== after.index ? before.x + (index - before.index) * (after.x - before.x) / (after.index - before.index)
        : before ? before.x + (index - before.index) * pitch : first.x - (first.index - index) * pitch;
    });
    if (seats.some((x, index) => !kept.some(target => target.index === index) && Math.abs(x - ports[index]!.anchor!.x) > EPS
      && held.get(portId(ports[index]!.ref))?.(x) === false)) return new Set();
  }
  const oldX = box.x, grown = alignedEdges(last.index, last.x, ports.length, pitch).high;
  box.x = Math.min(box.x, alignedEdges(first.index, first.x, ports.length, pitch).low);
  box.width += (oldX - box.x) + Math.max(0, grown - oldRight);
  node.size!.width = box.width;
  for (const port of node.ports) {
    if (port.side === 'left') port.anchor!.x = box.x;
    if (port.side === 'right') port.anchor!.x = right(box);
  }
  ports.forEach((port, index) => {
    const before = [...kept].reverse().find(target => target.index <= index), after = kept.find(target => target.index >= index);
    const x = before && after && before.index !== after.index ? before.x + (index - before.index) * (after.x - before.x) / (after.index - before.index)
      : before ? before.x + (index - before.index) * pitch : first.x - (first.index - index) * pitch;
    port.anchor = portAnchor(box, side, x - box.x);
  });
  return new Set(kept.map(target => target.key));
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
  const steps = [...tiers.slice(index + 1).map((tier, i) => ({ tier, authority: tiers[index + i]! })),
    ...tiers.slice(0, index).reverse().map((tier, i) => ({ tier, authority: tiers[index - i]! }))];
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
 * bodies and pills, lie between the column edges. Any other group stays out of the column of every
 * frame that spans its sub-tier, on the side it stands on. Unbounded for a tier with no frame.
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
  const reach = occupiedOverhang(model, group), centre = box.x + box.width / 2, gap = bandGap(model);
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
function tailReservation(model: LayoutModel, context: CentreContext, tier: number, order: string[]): Map<string, number> {
  const result = new Map<string, number>();
  let bound = Infinity;
  // The step of one group never moves or resizes the groups after it. One sweep therefore stays
  // exact for the whole tier step. It costs one pass over the groups of the tier.
  for (const id of [...order].reverse()) {
    result.set(id, bound);
    bound = Math.min(bound, reservedWindow(model, context, tier, id).high) - model.groups[id]!.bounds!.width - bandGap(model);
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

/** How many targets of a face stand in engine order at the face's pitch: the in-order keep of `keptTargets` without its limits, allowance or stops. */
function inOrderTargets(node: LayoutNode, side: Side, targets: ReadonlyMap<string, number>): number {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!), pitch = node.sidePitch![side]!;
  let last: { index: number; x: number } | undefined, count = 0;
  for (const [index, port] of ports.entries()) {
    const x = targets.get(portId(port.ref));
    if (x !== undefined && (!last || x - last.x >= (index - last.index) * pitch)) { last = { index, x }; count++; }
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
  for (const [child, candidates] of rival) {
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
  const wanted = new Map<string, number>();
  for (const [child, feed] of seats) wanted.set(child, feed.x);
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
 * grown to the targets the alignment keeps (`keptTargets`, the alignment's own bounds: the row siblings, `ALIGNMENT_MAX_GROWTH` and the
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
  const box = group.bounds!;
  for (const nodeId of group.rowOrder!) {
    const node = model.nodes[nodeId]!, body = node.bounds!;
    bodyLow = Math.min(bodyLow, body.x); bodyHigh = Math.max(bodyHigh, right(body));
    const moved: LayoutNode = { ...node, bounds: { ...body, x: body.x + dx }, ports: node.ports.map(port => ({ ...port, anchor: { ...port.anchor!, x: port.anchor!.x + dx } })) };
    const limit = siblingLimit(model, group, node);
    const targets = keptTargets(moved, 'bottom', wanted, { low: limit.low + dx, high: limit.high + dx }, overlayStops(model, moved));
    grownLow = Math.min(grownLow, body.x + dx); grownHigh = Math.max(grownHigh, right(body) + dx);
    if (!targets.length) continue;
    kept = true;
    const pitch = node.sidePitch!.bottom!, count = node.ports.filter(port => port.side === 'bottom').length, first = targets[0]!, last = targets[targets.length - 1]!;
    grownLow = Math.min(grownLow, alignedEdges(first.index, first.x, count, pitch).low);
    grownHigh = Math.max(grownHigh, alignedEdges(last.index, last.x, count, pitch).high);
  }
  if (!kept) return undefined;
  // The outer feeds by x; the port id breaks a tie (R3).
  const feeds = [...seats.values()].sort((a, b) => a.x - b.x || portId(a.parent.ref).localeCompare(portId(b.parent.ref)));
  const lowFeed = feeds[0]!, highFeed = feeds[feeds.length - 1]!;
  return { low: { port: lowFeed.parent.ref, offset: grownLow - (bodyLow - box.x) - lowFeed.x },
    high: { port: highFeed.parent.ref, offset: grownHigh + (right(box) - bodyHigh) - highFeed.x } };
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
function centreGroupStep(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, warn: boolean, tail: Map<string, number>, base?: BaseReadings): { unresolved: Set<string>; group: LayoutGroup } {
  return withStepLinkKinds(model, () => centreGroupStepChecked(model, context, tier, list, id, previous, warn, tail, base));
}
function centreGroupStepChecked(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, warn: boolean, tail: Map<string, number>, base?: BaseReadings): { unresolved: Set<string>; group: LayoutGroup } {
  // From 7e on, an overlay link that draws one straight segment keeps the space placement reserved for it. A step that leaves fewer
  // of them straight (a body or a pill now stands on a chord) is declined as a whole, like a step that solves nothing: the group stays
  // where it stood (ticket 75). A step that straightens one link for another is a trade the alignment is allowed to make.
  if (!CHORD_STAGES.includes(model.stage)) return centreGroupStepRaw(model, context, tier, list, id, previous, warn, tail);
  const group = model.groups[id]!;
  // `moveGroup` leaves pill bounds behind, and the chord reads them: both readings are taken on rebuilt nodes.
  rebuildNodeGeometry(model, group.nodes, 'current');
  const standing = base !== undefined && group.nodes.every(node => JSON.stringify(model.nodes[node]) === base.texts.get(node));
  const held = standing && base.held ? base.held : straightChordIds(model), breached = standing && base.breached ? base.breached : new Set([...keepOutShifts(model).keys()].map(item => item.id));
  if (standing) { base.held = held; base.breached = breached; }
  const snapshot = JSON.parse(JSON.stringify({ group, nodes: group.nodes.map(node => model.nodes[node]!) })) as { group: LayoutGroup; nodes: LayoutNode[] };
  const result = centreGroupStepRaw(model, context, tier, list, id, previous, warn, tail);
  rebuildNodeGeometry(model, model.groups[id]!.nodes, 'current');
  const now = straightChordIds(model);
  // A frame edge that a foreign drop would run along is a spacing routing can only discover; a step may not make one (ticket 75).
  const stands = holds(reading({ overlay: straightOf(now) }), reading({ overlay: straightOf(held) }), profiles.keepCount) && [...keepOutShifts(model).keys()].every(item => breached.has(item.id));
  tapVerdict('centreGroupStep', () => `${stands} ${now.size}/${held.size}`);
  if (stands) return result;
  model.groups[id] = snapshot.group;
  for (const node of snapshot.nodes) model.nodes[node.id] = node;
  packClear(model, context, tier, snapshot.group, previous);
  return { unresolved: new Set(groupFeeds(model, context, tier, list, id, false).wanted.keys()), group: snapshot.group };
}
function centreGroupStepRaw(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, warn: boolean, tail: Map<string, number>): { unresolved: Set<string>; group: LayoutGroup } {
  const group = model.groups[id]!;
  const { own, wanted, yielded, conflicts, seats } = groupFeeds(model, context, tier, list, id, warn);
  const unresolved = new Set<string>(conflicts);
  const startPenetration = riserPenetrations(model, group), startCrossings = chordLaneCrossings(model, group), startBreaches = spanBreaches(model);
  const saved = JSON.parse(JSON.stringify({ group, nodes: group.nodes.map(node => model.nodes[node]!) })) as { group: LayoutGroup; nodes: LayoutNode[] };
  // Centre under the feeds that may own an alignment; a yielded transit would only pull the group
  // away from the x its child is then aligned to.
  const chosen = chosenFeeds(context, tier, own, yielded);
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
  const missBefore = total(misses());
  // The overlay walls of each body, read where the body stands as the step begins. A body an earlier
  // pass grew toward its feeds is carried by the move below as well, and a move that carries it onto
  // a chord is the same growth by another name: the next pass would read a chord the body already
  // crosses and let the growth through. So the move stops at the wall for a grown body. A body that
  // has not grown moves as it always did; the wall then bounds only the growth that follows.
  const walls = new Map(group.rowOrder!.map(id => [id, overlayStops(model, model.nodes[id]!)]));
  const { farthestLeft, farthestRight } = farthest(model, walls);
  const began = group.bounds!.x, toMean = centringOffset(chosen);
  moveGroup(model, group, mainMove(model, group, farthestLeft, farthestRight, toMean), 0);
  const aligned = new Set<string>();
  for (const nodeId of group.rowOrder!) {
    const node = model.nodes[nodeId]!;
    const stops = walls.get(nodeId)!;
    let stoppedBy: string | undefined;
    for (const side of ['top', 'bottom'] as const) {
      for (const key of alignSide(node, side, wanted, siblingLimit(model, group, node), stops, link => { stoppedBy ??= link; }, riserAvoidance(model, group.tier!, side as 'top' | 'bottom'), heldChordPorts(model, node))) aligned.add(key);
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
    return { unresolved: new Set(wanted.keys()), group: saved.group };
  }
  const x = Math.max(low, Math.min(group.bounds!.x, high - group.bounds!.width));
  moveGroup(model, group, x - group.bounds!.x, 0);
  // The riser keep-out is a post-condition of the whole step, read after the clamp (mesh-bus.md, section 11.5): the main move and the alignments were
  // measured where they were made, and the clamp, the row pack and the region fit can undo them. A step that leaves a routed port of the facing edge
  // deeper in the keep-out than the step found it (port by port) is declined like a window that cannot hold the group.
  // The same for a frozen chord: a step that leaves one across a foreign lane box that it did not cross when the step began is declined.
  if (!riserNoDeeper(startPenetration, riserPenetrations(model, group)) || [...chordLaneCrossings(model, group)].some(pair => !startCrossings.has(pair))
    || [...spanBreaches(model)].some(key => !startBreaches.has(key))) {
    model.groups[id] = saved.group;
    for (const node of saved.nodes) model.nodes[node.id] = node;
    packClear(model, context, tier, saved.group, previous);
    standNearFeed(model, context, tier, id, saved.group, began + Math.max(farthestLeft, Math.min(toMean, farthestRight)), low, high);
    return { unresolved: new Set(wanted.keys()), group: saved.group };
  }
  for (const [key, want] of wanted) {
    const port = group.nodes.flatMap(id => model.nodes[id]!.ports).find(port => portId(port.ref) === key)!;
    if (Math.abs(port.anchor!.x - want) > 0.5) unresolved.add(key);
  }
  // A step that aligns nothing and brings no feed closer to its x moves nothing. The passes are an
  // iterative solver: the move puts the group under the mean of its feeds, the widenings below it
  // reach what the row and the allowance let them reach, and the next pass starts from where this
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
  const missAfter = total(misses());
  if (wanted.size && !aligned.size && !own.some(feed => feed.transit) && missAfter > 0.5 && missAfter >= missBefore - 0.5) {
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
    return { unresolved, group: saved.group };
  }
  return { unresolved, group };
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
  // A move a replay before took at a frame-column wall is read again where the model stands now: a wall that no longer holds gives the move back before the
  // passes centre on it (architecture ticket 15, follow-up).
  withdrawRecorded(model);
  const seated = seatedFaces(model);
  timed('centre-passes', () => centrePasses(model, budget));
  // The parent side of a single feed, after the last pass has moved the children (architecture ticket 15).
  const anchorTier = model.anchorTier;
  if (anchorTier !== undefined && model.tierBands.some(band => band.tier === anchorTier)) {
    const context = centreContext(model, anchorTier);
    standPortsOverChildren(model, context.steps, stepReader(model, context));
  }
  // A face centring left alone stands centred on the body it widened (architecture ticket 10, D3). Read before the overlay windows below.
  recentreSeatedFaces(model, seated, feedPorts(model));
  // The windows of the overlay barycentre are read once, where centring has left the partners (ticket 143): a window read in a pass
  // is read on geometry that a later step moves.
  const overlayFinal = (): boolean => {
    if (selectAnchorTier(model) === undefined) return false;
    const before = geometry(model);
    timed('centre-overlay-final', () => { placeOverlayFree(model); rebuildRegions(model); });
    return geometry(model).some((value, i) => Math.abs(value - before[i]!) > 0.5);
  };
  // A partner the windows move carries the end of its overlay chords, and a chord is an overlay stop of the alignment (7c): a chord that moves
  // off a body frees a growth the passes declined, and one that moves onto it stops a growth they kept. The passes stood at a fixed point
  // the publication check confirmed; a model the windows moved is checked again (snack-theme ticket 157).
  const unsettled = (moved: boolean): boolean => moved && timed('centre-violations', () => centreViolations(model, true)).length > 0;
  let moved = overlayFinal();
  // The seated faces and the overlay barycentre above can widen a column after the moves were taken. Read once more; a move given back, or an
  // alignment the windows unsettled, is settled by the passes the budget has left (none left: the stall is reported, ADR-0010).
  if (withdrawRecorded(model) || unsettled(moved)) {
    timed('centre-passes', () => centrePasses(model, budget));
    moved = overlayFinal();
    // The windows read once more after the passes; an alignment they unsettle again is a stall the passes cannot see (ADR-0010).
    if (unsettled(moved)) reportStall(model, [], 'Centering left an alignment off its feed after the overlay windows moved a partner; routing and the final gates decide the retained geometry.');
  }
  refreshWindowDeclines(model);
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
  reserveAlignedExtents(model, context);
  let unresolved = new Set<string>(), ran = false;
  while (budget.remaining > 0) {
    ran = true;
    budget.remaining--; budget.passes++; attemptCounters.centringPasses++;
    const before = geometry(model); unresolved = new Set();
    // A pass whose steps move geometry that a later stage of the same pass moves back is not at a
    // fixed point: the net change is nil, the work is not. Every step is measured on its own.
    let stepped = false;
    for (const { tier, authority } of context.steps) {
      const list = centringFeeds(model, tier, authority), order = context.groupOrder.get(tier)!;
      const tail = tailReservation(model, context, tier, order);
      let previous: LayoutGroup | undefined;
      for (const id of order) {
        const group = model.groups[id]!;
        // Bar shaping owns their source-derived slots and stacked spans; row centering cannot repack
        // them. A group this step does not centre still yields the space a widened neighbour took.
        if (model.document.groups[id]!.shape === 'bar' || !list.some(feed => model.document.nodes[feed.child.ref.node]!.group === id)) {
          packClear(model, context, tier, group, previous);
          // A bar stands where 7d will shape it, which may move no other group: the groups after it clear the extent its span gives it, not the box it has now (ticket 19).
          previous = standingBox(model, group);
          continue;
        }
        const start = geometry(model);
        const result = centreGroupStep(model, context, tier, list, id, previous, true, tail);
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
function reportStall(model: LayoutModel, unresolved: string[], message = 'Centering exhausted the shared eight-pass budget; unresolved alignments remain for routing and final gates.'): void {
  if (model.diagnostics.some(d => d.stage === 'placement' && d.code === 'PLACEMENT_NON_CONVERGENCE')) return;
  placementWarning(model, 'PLACEMENT_NON_CONVERGENCE', message, unresolved, 'group');
}
/**
 * A replay that centred and then rebuilt what depends on the centring (bundle anchors, bars, regions) can leave an alignment
 * the step would move: the passes ended at a fixed point, and the model published from them is not one. The check the
 * publication runs, run here, says so, so that a model never publishes an unexplained centring violation (ticket 75).
 */
export function flagUnverifiedCentring(model: LayoutModel): void {
  if (!model.diagnostics.some(d => d.stage === 'placement' && d.code === 'PLACEMENT_NON_CONVERGENCE') && centreViolations(model, true).length > 0) {
    reportStall(model, [], 'Centering left an alignment off its feed after the bundle, bar and region rebuilds that follow it; routing and the final gates decide the retained geometry.');
  }
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
  return withSharedLinkKinds(() => readCentreViolations(model, ahead, shared));
}
function readCentreViolations(model: LayoutModel, ahead: boolean, shared: CentreContext | undefined): string[] {
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
  const byId = new Map(model.links.map(link => [link.id, link]));
  // The replay reads placement geometry alone; nothing it calls reads the freeze block, and on a
  // large model that block is more than a third of the JSON the per-group copy below would carry.
  const { freeze: _frozen, ...replayed } = model;
  void _frozen;
  // Every trial starts from the same model. The parts a step only reads are copied once and frozen (`TRIAL_SHARED`), and so are the nodes:
  // a trial takes a fresh copy of the nodes of its group and of the group before it (the ones a step writes), and shares the rest. A step that writes
  // to a shared part throws; that trial is then run again on a full copy, so the answer is the one a full copy gives (architecture ticket 14).
  let baseReadings: BaseReadings | undefined;
  let replayedText: string | undefined, sharedParts: Record<string, unknown> | undefined, sharedNodes: Record<string, LayoutNode> | undefined, nodeTexts: Map<string, string> | undefined, fullText: string | undefined;
  const freezeDeep = (value: unknown): void => { if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); } };
  for (const { tier, authority } of context.steps) {
    const list = centringFeeds(model, tier, authority), order = context.groupOrder.get(tier)!;
    // The reservation of the tier is read only by a replay, and a replay runs only for a group with a candidate: the first one reads it.
    let tail: Map<string, number> | undefined;
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
        sharedNodes = Object.fromEntries([...nodeTexts].map(([key, text]) => [key, JSON.parse(text) as LayoutNode]));
        freezeDeep(sharedNodes);
        delete own.nodes;
        replayedText = JSON.stringify(own);
        sharedParts = JSON.parse(JSON.stringify(still)) as Record<string, unknown>;
        freezeDeep(sharedParts);
      }
      const reserved = tail ??= tailReservation(model, context, tier, order);
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
        return { trial, step: centreGroupStep(trial, context, tier, centringFeeds(trial, tier, authority), id, previous && trial.groups[previous.id], false, reserved, base) };
      };
      let step: ReturnType<typeof centreGroupStep>;
      try { step = attempt(false).step; } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        step = attempt(true).step;
      }
      previous = group;
      for (const { child, x, feed, port } of candidates) {
        // Only the ports the producer's own step could not resolve are excused, never their siblings.
        if (step.unresolved.has(child)) continue;
        result.push(`${feed.link}: ${child} sits at x ${port.anchor!.x} instead of its feed x ${x}`);
      }
    }
  }
  return result;
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
export function centre(model: LayoutModel): LayoutModel {
  return withStageMutation(model, 'centre', draft => {
    // The wide twin: the seats of the first feeds with the conflicting feeds pulling, as before ticket 12. It is built only where a port has two parents.
    const twin = (): LayoutModel => {
      const copy = JSON.parse(JSON.stringify(draft)) as LayoutModel;
      copy.diagnostics.push({ stage: 'placement', severity: 'info', code: KEPT_WIDE, message: 'The first feeds seat their ports; a port with two parents is not narrowed.' });
      return copy;
    };
    const wideTwin = hasRivals(draft) ? twin() : undefined;
    orderBundles(draft); normalizePrimaryBundlePorts(draft); centreDraft(draft, createCentreBudget()); recordSeatedSideLanes(draft);
    if (!wideTwin) return;
    centreDraft(wideTwin, createCentreBudget()); recordSeatedSideLanes(wideTwin);
    // Narrow only if free: a link that stands straight under the wide seat must stand straight under the narrow one, or the node keeps its wide seat.
    const narrow = straightLinks(draft);
    if ([...straightLinks(wideTwin)].every(id => narrow.has(id))) return;
    for (const key of Object.keys(draft)) delete (draft as unknown as Record<string, unknown>)[key];
    Object.assign(draft, wideTwin);
  });
}
