import type { LayoutGroup, LayoutModel, LayoutNode, LayoutPort } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { portAnchor } from '../geometry/index.js';
import { laneSidesHold, optionalMoveHolds, nodeTier, occupiedOverhang, riserAvoidance, riserKeepOutAfterMove, riserPenetration, selectAnchorTier } from './lanes.js';
import { cellReach } from './frames.js';
import { besideWalls, frameColumns, keepOutShifts, packBesideRows, type CellWindow, type FrameColumn } from './columns.js';
import { findPort } from './row-paths.js';
import { portId, bandGap, SKELETON_SPACING } from './skeleton-graph.js';
import { crosses, overlayBlockers, straightChord } from './overlay-paths.js';
import { moveGroup } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { packRowsOf } from './grid.js';
import { rowGap } from './sides-two.js';
import { linkLabelGap } from './bands.js';
import { alignmentAllowance, ownSideWidth } from './size.js';
import { withLayoutMutation } from './mutation.js';
import { placeOverlayFree } from './overlay-place.js';
import { fitRegionGroup, GROUP_PADDING, placementWarning, rebuildRegions, right } from './regions.js';
import { EPS } from '../score/geometry.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';

export interface CentreBudget { remaining: number; passes: number }
export function createCentreBudget(): CentreBudget { return { remaining: 8, passes: 0 }; }
export { selectAnchorTier };
/**
 * `x` is the authoritative feed x: the parent anchor, or the owned lane x in the adjacent tier for a
 * transit. `key` is the parent port either way: a parent port feeding several children is vertical
 * to one of them (the first by x), and the rest fan — lanes packed at lane width cannot seat two
 * default-width children side by side, so a per-lane winner would only manufacture infeasible pins.
 */
interface Feed { parent: LayoutPort; child: LayoutPort; link: string; x: number; key: string; transit: boolean }
function feeds(model: LayoutModel, tier: number, authority: number): Feed[] {
  const result: Feed[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const [parentRef, childRef] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]]) {
      if (!parentRef || !childRef || nodeTier(model, childRef.node) !== tier) continue;
      // The parent is in the adjacent authority tier, or beyond it for a link that transits the
      // adjacent tier through an owned lane (7a). Both fix the x the child must sit under.
      const parentTier = nodeTier(model, parentRef.node);
      if (parentTier === undefined || (tier > authority ? parentTier > authority : parentTier < authority)) continue;
      if ([parentRef.node, childRef.node].some(id => model.groups[model.document.nodes[id]!.group]!.flank)) continue;
      const parent = findPort(model, parentRef)!, child = findPort(model, childRef)!;
      if (parent.side !== (tier > authority ? 'bottom' : 'top') || child.side !== (tier > authority ? 'top' : 'bottom')) continue;
      // A bundle member carries its lane only until 7e, which owns member geometry; only a
      // non-bundle transit with an owned lane in the authority tier fixes its child's x here.
      const lane = parentTier === authority ? undefined
        : model.lanes.find(lane => lane.owner.kind === 'link' && lane.owner.id === link.id && lane.tier === authority);
      if (parentTier !== authority && (!lane || link.bundle)) continue;
      result.push({ parent, child, link: link.id, x: lane ? lane.x : parent.anchor!.x,
        key: portId(parent.ref), transit: Boolean(lane) });
    }
  }
  return result;
}
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
  avoid: { xs: number[]; keep: number; routed: Set<string> } = { xs: [], keep: 0, routed: new Set() }): Set<string> {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
  const pitch = node.sidePitch![side]!, kept: { index: number; x: number; key: string }[] = [];
  const box = node.bounds!, oldRight = right(box);
  if (box.x < limit.low - EPS || oldRight > limit.high + EPS) return new Set();
  const allowance = alignmentAllowance(node, side);
  /** The width the body ends with when the port at `index` is aligned to `x`. */
  const reach = (index: number, x: number): number =>
    Math.max(oldRight, x + (ports.length - 1 - index) * pitch + 10 + pitch / 2)
    - Math.min(box.x, x - index * pitch - 10 - pitch / 2);
  for (const [index, port] of ports.entries()) {
    const key = portId(port.ref), x = targets.get(key), last = kept[kept.length - 1];
    if (x !== undefined && (x - index * pitch - 10 - pitch / 2 < limit.low - EPS
      || x + (ports.length - 1 - index) * pitch + 10 + pitch / 2 > limit.high + EPS)) continue;
    if (x !== undefined && reach(index, x) > allowance + EPS) continue;
    // The overlay cap comes last, so it is named only where it alone declines the target.
    if (x !== undefined) {
      const beyondLow = x - index * pitch - 10 - pitch / 2 < stops.low - EPS;
      if (beyondLow || x + (ports.length - 1 - index) * pitch + 10 + pitch / 2 > stops.high + EPS) {
        stopped((beyondLow ? stops.lowLink : stops.highLink)!);
        continue;
      }
    }
    if (x !== undefined && (!last || x - last.x >= (index - last.index) * pitch)) kept.push({ index, x, key });
  }
  if (!kept.length) return new Set();
  const first = kept[0]!, last = kept[kept.length - 1]!;
  if (Math.max(oldRight, last.x + (ports.length - 1 - last.index) * pitch + 10 + pitch / 2)
    - Math.min(box.x, first.x - first.index * pitch - 10 - pitch / 2) > allowance + EPS) return new Set();
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
  const oldX = box.x, grown = last.x + (ports.length - 1 - last.index) * pitch + 10 + pitch / 2;
  box.x = Math.min(box.x, first.x - first.index * pitch - 10 - pitch / 2);
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
function geometry(model: LayoutModel): number[] {
  return Object.values(model.nodes).flatMap(node => [node.bounds!.x, node.bounds!.width, ...node.ports.map(port => port.anchor!.x)]);
}
/** The child columns stand against the parent cells beside them again; the anchor tier and the flanks keep their place in centring (idempotent, ticket 28). */
function settleRows(model: LayoutModel): boolean {
  return packBesideRows(model, cell => model.groups[cell]!.tier !== model.anchorTier && !model.groups[cell]!.flank);
}
/** Reusable bounded producer. The caller shares one budget across all ordered placement replay. */
interface CentreContext {
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
function centreContext(model: LayoutModel, anchor: number, columns: readonly FrameColumn[] = frameColumns(model)): CentreContext {
  const tiers = model.tierBands.map(band => band.tier), index = tiers.indexOf(anchor);
  const steps = [...tiers.slice(index + 1).map((tier, i) => ({ tier, authority: tiers[index + i]! })),
    ...tiers.slice(0, index).reverse().map((tier, i) => ({ tier, authority: tiers[index - i]! }))];
  const winners = new Map<string, string>();
  for (const step of steps) for (const feed of [...feeds(model, step.tier, step.authority)].sort((a, b) => model.nodes[a.child.ref.node]!.bounds!.x - model.nodes[b.child.ref.node]!.bounds!.x || portId(a.child.ref).localeCompare(portId(b.child.ref)))) {
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
    const column = own.wall ?? own;
    return { low: Math.max(wall.low, column.x + inset + (box.x - reach.x)), high: Math.min(wall.high, column.x + column.width - inset - (reach.x + reach.width - (box.x + box.width))) };
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
  if (low + group.bounds!.width > window.high + EPS || !laneSidesHold(model, [{ group, bounds }])) {
    placementWarning(model, 'CENTRE_TIER_PACK_INFEASIBLE',
      `${group.id} cannot clear ${previous.id} inside its reserved lane and flank window; the final gates judge the result.`,
      [group.id], 'group');
    return;
  }
  moveGroup(model, group, low - group.bounds!.x, 0);
}

/** The column pull's inner pass (`pullMembers`) reads only the members of a canton. */
function inCanton(model: LayoutModel, group: LayoutGroup): boolean {
  const frames = model.document.frames;
  for (let id = group.frame; id !== undefined && frames?.[id] !== undefined; id = frames[id]!.parent) {
    if (frames[id]!.kind === 'canton') return true;
  }
  return false;
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
  if (!inCanton(model, group) || !Number.isFinite(target) || box.width > high - low + EPS) return;
  const dx = Math.max(low, Math.min(target, high - box.width)) - box.x;
  if (Math.abs(dx) <= EPS || !optionalMoveHolds(model, [{ group, bounds: { ...box, x: box.x + dx } }])) return;
  moveGroup(model, group, dx, 0);
}

/** The feeds of one group in one step, with the x each child port wants and the transits that yield. */
function groupFeeds(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, warn: boolean): { own: Feed[]; wanted: Map<string, number>; yielded: Set<Feed>; conflicts: Set<string> } {
  const own = list.filter(feed => model.document.nodes[feed.child.ref.node]!.group === id);
  // Adjacent feeds first: a transit yields to any other feed of the same child port instead of
  // contesting it, so a fan of lanes into one port cannot exhaust the shared budget.
  const wanted = new Map<string, number>(), yielded = new Set<Feed>(), conflicts = new Set<string>();
  for (const feed of [...own].sort((a, b) => Number(a.transit) - Number(b.transit))) {
    const child = portId(feed.child.ref);
    if (context.winners.get(`${tier}:${feed.key}`) !== child) {
      if (warn) placementWarning(model, 'CENTRE_FAN_REMAINDER', `${feed.link} shares a parent port; the first child by x owns vertical alignment.`, [feed.link]);
      continue;
    }
    if (!wanted.has(child)) wanted.set(child, feed.x);
    else if (wanted.get(child) !== feed.x) {
      if (feed.transit) {
        yielded.add(feed);
        if (warn) placementWarning(model, 'CENTRE_FAN_REMAINDER', `${feed.link} shares its child port with a feed at another x; that feed owns vertical alignment.`, [feed.link]);
      } else conflicts.add(child);
    }
  }
  return { own, wanted, yielded, conflicts };
}
/**
 * One group's centring step: centre under its owning feeds, align the wanted ports, repack, fit,
 * clamp into the lane/flank/neighbour window. Reports exactly which child ports stay unresolved —
 * a conflict, an alignment the row cannot hold, a window the group cannot fit, or a clamp that
 * moved it off its feed — so a check can excuse those and no others. Shared by the producer pass and
 * by the publication/restore check, so both read one definition.
 */
const CHORD_STAGES = ['bundles', 'bands', 'route', 'link-labels', 'validate', 'emit'];
/** The overlay links that draw one straight segment in the model as it stands. */
function straightOverlays(model: LayoutModel): Set<string> {
  const blockers = overlayBlockers(model);
  return new Set(model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && straightChord(model, link, blockers) !== undefined).map(link => link.id));
}
function centreGroupStep(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, warn: boolean, tail: Map<string, number>): { unresolved: Set<string>; group: LayoutGroup } {
  // From 7e on, an overlay link that draws one straight segment keeps the space placement reserved for it. A step that leaves fewer
  // of them straight (a body or a pill now stands on a chord) is declined as a whole, like a step that solves nothing: the group stays
  // where it stood (ticket 75). A step that straightens one link for another is a trade the alignment is allowed to make.
  if (!CHORD_STAGES.includes(model.stage)) return centreGroupStepRaw(model, context, tier, list, id, previous, warn, tail);
  const group = model.groups[id]!;
  // `moveGroup` leaves pill bounds behind, and the chord reads them: both readings are taken on rebuilt nodes.
  rebuildNodeGeometry(model, group.nodes, 'current');
  const held = straightOverlays(model), breached = new Set([...keepOutShifts(model).keys()].map(item => item.id));
  const snapshot = JSON.parse(JSON.stringify({ group, nodes: group.nodes.map(node => model.nodes[node]!) })) as { group: LayoutGroup; nodes: LayoutNode[] };
  const result = centreGroupStepRaw(model, context, tier, list, id, previous, warn, tail);
  rebuildNodeGeometry(model, model.groups[id]!.nodes, 'current');
  const now = straightOverlays(model);
  // A frame edge that a foreign drop would run along is a spacing routing can only discover; a step may not make one (ticket 75).
  if (now.size >= held.size && [...keepOutShifts(model).keys()].every(item => breached.has(item.id))) return result;
  model.groups[id] = snapshot.group;
  for (const node of snapshot.nodes) model.nodes[node.id] = node;
  packClear(model, context, tier, snapshot.group, previous);
  return { unresolved: new Set(groupFeeds(model, context, tier, list, id, false).wanted.keys()), group: snapshot.group };
}
function centreGroupStepRaw(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, warn: boolean, tail: Map<string, number>): { unresolved: Set<string>; group: LayoutGroup } {
  const group = model.groups[id]!, order = context.groupOrder.get(tier)!;
  const { own, wanted, yielded, conflicts } = groupFeeds(model, context, tier, list, id, warn);
  const unresolved = new Set<string>(conflicts);
  const startPenetration = riserPenetration(model, group);
  const saved = JSON.parse(JSON.stringify({ group, nodes: group.nodes.map(node => model.nodes[node]!) })) as { group: LayoutGroup; nodes: LayoutNode[] };
  // Centre under the feeds that may own an alignment; a yielded transit would only pull the group
  // away from the x its child is then aligned to.
  const vertical = own.filter(feed => context.winners.get(`${tier}:${feed.key}`) === portId(feed.child.ref) && !yielded.has(feed));
  const chosen = vertical.length ? vertical : own;
  const distinctParents = new Map(chosen.map(feed => [feed.key, feed.x]));
  const distinctChildren = new Map(chosen.map(feed => [portId(feed.child.ref), feed.child.anchor!.x]));
  const mean = (values: Iterable<number>) => { const xs = [...values]; return xs.reduce((sum, x) => sum + x, 0) / xs.length; };
  /** How far each wanted port is from the x its feed asks for, in the model as it now stands. */
  const misses = (): Map<string, number> => new Map([...wanted].map(([key, want]) => {
    const port = group.nodes.flatMap(node => model.nodes[node]!.ports).find(port => portId(port.ref) === key);
    return [key, port?.anchor ? Math.abs(port.anchor.x - want) : 0];
  }));
  const total = (values: Map<string, number>): number => [...values.values()].reduce((sum, value) => sum + value, 0);
  const missBefore = total(misses());
  // The overlay walls of each body, read where the body stands as the step begins. A body an earlier
  // pass grew toward its feeds is carried by the move below as well, and a move that carries it onto
  // a chord is the same growth by another name: the next pass would read a chord the body already
  // crosses and let the growth through. So the move stops at the wall for a grown body. A body that
  // has not grown moves as it always did; the wall then bounds only the growth that follows.
  const walls = new Map(group.rowOrder!.map(id => [id, overlayStops(model, model.nodes[id]!)]));
  let farthestLeft = -Infinity, farthestRight = Infinity;
  for (const [id, stops] of walls) {
    const node = model.nodes[id]!, box = node.bounds!;
    if (box.width <= Math.max(ownSideWidth(node, 'top'), ownSideWidth(node, 'bottom')) + EPS) continue;
    farthestLeft = Math.max(farthestLeft, stops.low - box.x);
    farthestRight = Math.min(farthestRight, stops.high - right(box));
  }
  const began = group.bounds!.x, toMean = mean(distinctParents.values()) - mean(distinctChildren.values());
  const shift = Math.max(farthestLeft, Math.min(toMean, farthestRight));
  moveGroup(model, group, riserKeepOutAfterMove(model, group, shift) ? shift : 0, 0);
  const aligned = new Set<string>();
  for (const nodeId of group.rowOrder!) {
    const node = model.nodes[nodeId]!;
    const stops = walls.get(nodeId)!;
    let stoppedBy: string | undefined;
    for (const side of ['top', 'bottom'] as const) {
      for (const key of alignSide(node, side, wanted, siblingLimit(model, group, node), stops, link => { stoppedBy ??= link; }, riserAvoidance(model, group.tier!, side as 'top' | 'bottom'))) aligned.add(key);
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
  const window = reservedWindow(model, context, tier, id);
  const low = Math.max(window.low, previous ? right(previous.bounds!) + bandGap(model) : -Infinity);
  let high = Math.min(window.high, tail.get(id)!);
  const nextFixed = order.slice(order.indexOf(id) + 1).map(id => model.groups[id]!).find(other => !list.some(feed => model.document.nodes[feed.child.ref.node]!.group === other.id));
  if (nextFixed) high = Math.min(high, nextFixed.bounds!.x - bandGap(model));
  if (group.bounds!.width > high - low) {
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
  // deeper in the keep-out than the step found it is declined like a window that cannot hold the group.
  if (riserPenetration(model, group) > startPenetration + 1e-9) {
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
/** Reusable bounded producer. The caller shares one budget across all ordered placement replay. */
export function centreDraft(model: LayoutModel, budget: CentreBudget): void {
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
  placeOverlayFree(model, columns);
  let context = centreContext(model, anchor, columns), built = geometry(model);
  let unresolved = new Set<string>(), ran = false;
  while (budget.remaining > 0) {
    ran = true;
    budget.remaining--; budget.passes++;
    const before = geometry(model); unresolved = new Set();
    // A pass whose steps move geometry that a later stage of the same pass moves back is not at a
    // fixed point: the net change is nil, the work is not. Every step is measured on its own.
    let stepped = false;
    for (const { tier, authority } of context.steps) {
      const list = feeds(model, tier, authority), order = context.groupOrder.get(tier)!;
      const tail = tailReservation(model, context, tier, order);
      let previous: LayoutGroup | undefined;
      for (const id of order) {
        const group = model.groups[id]!;
        // Bar shaping owns their source-derived slots and stacked spans; row centering cannot repack
        // them. A group this step does not centre still yields the space a widened neighbour took.
        if (model.document.groups[id]!.shape === 'bar' || !list.some(feed => model.document.nodes[feed.child.ref.node]!.group === id)) {
          packClear(model, context, tier, group, previous);
          previous = group; continue;
        }
        const start = geometry(model);
        const result = centreGroupStep(model, context, tier, list, id, previous, true, tail);
        if (!stepped && geometry(model).some((value, i) => Math.abs(value - start[i]!) > 0.5)) stepped = true;
        if (result.unresolved.size) unresolved.add(id);
        previous = result.group;
      }
    }
    // A partner that a step above moved is read where it stands now (the pass is idempotent).
    placeOverlayFree(model, columns);
    rebuildRegions(model);
    const after = geometry(model);
    if (!stepped && after.every((value, i) => Math.abs(value - before[i]!) <= 0.5)) {
      // Rows packed again are a change of geometry: the next pass reads the settled walls.
      if (settleRows(model)) rebuildRegions(model);
      // The context (winners, group order, lane limits) reads the geometry it was built on. A fixed
      // point of the passes is a fixed point of the step only when the publication check, which
      // replays each step on a context built where the model now stands, agrees. When it does not,
      // the next pass reads a context built from the geometry that stands now.
      if (!centreViolations(model, true).length) return;
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
  if (ran || centreViolations(model, true).length > 0) reportStall(model, [...unresolved]);
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
 * The stage 7c invariant, readable at any later stage (ADR-0010): for every centred group, replaying
 * its own centring step on a copy either leaves each owning alignment where the model has it, or ends
 * unresolved by the producer's own rules for that port (infeasible alignment, conflicting feeds, a
 * window it cannot cross). The check is scoped per child port and reads no diagnostics: a serialized
 * diagnostic proves nothing, and one port's genuine blockage excuses no other port. Ports that later rules own — bar
 * drops and endpoints (7d), ports any bundle member uses (7e) — are not compared.
 */
export function centreViolations(model: LayoutModel, ahead = false): string[] {
  const anchor = model.anchorTier;
  if (anchor === undefined || !model.tierBands.some(band => band.tier === anchor)) return [];
  const context = centreContext(model, anchor);
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
  for (const { tier, authority } of context.steps) {
    const list = feeds(model, tier, authority), order = context.groupOrder.get(tier)!;
    const tail = tailReservation(model, context, tier, order);
    let previous: LayoutGroup | undefined;
    for (const id of order) {
      const group = model.groups[id]!;
      const owned = groupFeeds(model, context, tier, list, id, false);
      if (model.document.groups[id]!.shape === 'bar' || !owned.own.length) { previous = group; continue; }
      const trial = JSON.parse(JSON.stringify(replayed)) as LayoutModel;
      const step = centreGroupStep(trial, centreContext(trial, anchor), tier, feeds(trial, tier, authority), id, previous && trial.groups[previous.id], false, tail);
      previous = group;
      // Both lookups below read one key per wanted child; keying them once keeps the scan of the
      // group's own feeds and ports out of the loop. First entry wins, as `find` did.
      const ownFeeds = new Map<string, Feed>();
      for (const item of owned.own) { const at = portId(item.child.ref); if (!ownFeeds.has(at)) ownFeeds.set(at, item); }
      const groupPorts = new Map<string, LayoutPort>();
      for (const nodeId of group.nodes) for (const item of model.nodes[nodeId]!.ports) {
        const at = portId(item.ref); if (!groupPorts.has(at)) groupPorts.set(at, item);
      }
      for (const [child, x] of owned.wanted) {
        // Only the ports the producer's own step could not resolve are excused, never their siblings.
        if (step.unresolved.has(child)) continue;
        const feed = ownFeeds.get(child)!;
        if (byId.get(feed.link)?.bundle || drops.has(feed.link)) continue;
        if ((afterBundles && bundled.has(child)) || (atBundles && bundled.has(portId(feed.parent.ref)))) continue;
        if (isBar(feed.child.ref.node) || isBar(feed.parent.ref.node)) continue;
        const port = groupPorts.get(child)!;
        if (Math.abs(port.anchor!.x - x) > 0.5) result.push(`${feed.link}: ${child} sits at x ${port.anchor!.x} instead of its feed x ${x}`);
      }
    }
  }
  return result;
}
export function centre(model: LayoutModel): LayoutModel { return withLayoutMutation(model, 'centre', draft => centreDraft(draft, createCentreBudget())); }
