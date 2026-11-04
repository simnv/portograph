import { measurePortPill } from '../text/index.js';
import { equal } from '../model/json-equality.js';
import { readCache } from '../model/read-cache.js';
import type { Rect } from '../model/geometry.js';
import type { Course, Diagnostic, Lane, LayoutGroup, LayoutLink, LayoutModel, MeshBus, PathSegment } from '../model/layout.js';
import type { PortRef } from '../model/document.js';
import { DEFAULT_STROKE_WIDTHS as stroke, linkStrokeWidth, routedStrokeWidth } from '../theme/geometry.js';
import { segmentRect, segmentRectDistance } from '../geometry/planar.js';
import { findPort } from './row-paths.js';
import { CourseRefusal, isCourseLane, validateCourseLane } from './courses.js';
import { isGapRun, laneRunKind } from './lane-kind.js';
import { courseGeometry, courseOf, isApproachCourse, perimeterLaneId, ringsOf, type LaneDraft } from './course-lanes.js';
import { gapEnds, gapGeometry, gapLaneId, gapReservation, isGapCourse } from './course-gap.js';
import { admitBypassLanes, bypassGeometry, bypassLaneExtent, bypassLaneId, isBypassCourse } from './course-bypass.js';
import { RING_PITCH, endMode } from './course-rows.js';
import { groupShape } from './grid.js';
import { compareId, portId } from './skeleton-graph.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { moveGroup, union } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { withStageMutation } from './mutation.js';
import { chordKind, chordsHold, isRoutedChord } from './frame-paths.js';
import { type ProposedBox, foreignReach, framesAfter, foreignRoot, heldLaneReach, ownFrameCells, rebuildFrames, riserForeignReach, riserHostGrowth, frameNodes } from './frames.js';
import { BUS_RUN_CLEARANCE } from './bus-room.js';
import { bottom, expandCanvas, GROUP_PADDING, placementWarning, rebuildRegions, right } from './regions.js';
import { corridorSideOf } from './reservations.js';
import { nodeTier, transitTiers } from './read/tier.js';
import { isSpanLane, replaySpanLane, spanCorridor, spanLaneId, SpanRefusal, SpanReservationRefusal } from './span-lanes.js';
import { orderPortsByLanes } from './turn-order.js';
import { trunkBuses, trunkGeometry, trunkHeads, trunkRing } from './trunk.js';
import { PlacementRefusal } from './placement-refusal.js';

/** A corridor `reseatLanes` moved, and the child port it moved it onto. */
export interface LaneFollow { lane: string; child: PortRef }

/**
 * Whether every corridor that followed a child still stands at that child's port. The move exists
 * only to put the corridor at the port, so this is the measure of whether it still buys anything —
 * read after whatever the move set off has been settled again.
 */
export function lanesHoldTheirChild(model: LayoutModel, followed: LaneFollow[]): boolean {
  return followed.every(item => {
    const lane = model.lanes.find(candidate => candidate.id === item.lane);
    const anchor = findPort(model, item.child)?.anchor;
    return lane !== undefined && anchor !== undefined && Math.abs(anchor.x - lane.x) <= PLACEMENT_EPS;
  });
}

export { nodeTier, transitTiers };
/** Anchor tier = most main-tier nodes, bars included, flanks excluded; ties: lowest tier (7c). */
export function selectAnchorTier(model: LayoutModel): number | undefined {
  const counts = new Map<number, number>();
  for (const group of Object.values(model.groups)) if (!group.flank && group.nodes.length) counts.set(group.tier!, (counts.get(group.tier!) ?? 0) + group.nodes.length);
  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a - b)[0];
}
/**
 * The transit end a lane aligns to: the endpoint nearer the anchor tier, because stage 7c holds that
 * end fixed and aligns the other under the lane. Ties, and bundle members (7e owns their geometry),
 * keep the authored source.
 */
export function laneSource(model: LayoutModel, link: LayoutLink): PortRef {
  const ends = link.attachments!;
  if (link.bundle) return ends.from;
  const anchor = selectAnchorTier(model);
  if (anchor === undefined) return ends.from;
  return Math.abs(nodeTier(model, ends.to.node) - anchor) < Math.abs(nodeTier(model, ends.from.node) - anchor) ? ends.to : ends.from;
}
/** Measured normal pill extent plus 10 px gap, or the stroke-aware node clearance diameter. */
export function laneWidth(model: LayoutModel, link?: LayoutLink): number {
  const pills = link?.attachments ? [findPort(model, link.attachments.from), findPort(model, link.attachments.to)] : [];
  const maxNodeStroke = Math.max(stroke.node, ...Object.values(model.nodes).map(node => node.strokeWidth ?? stroke.node));
  return Math.max(24 + 10, ...pills.map(port => (port?.ref.name !== undefined ? measurePortPill(port.ref.name).width : 0) + 10), 20 + routedStrokeWidth(model) + maxNodeStroke);
}
/**
 * The box a group keeps clear of every lane. A frame's reach is its cells plus every lane it holds, so
 * this one reader adds, for a link foreign to the frame of a rank cell, the lanes of the links that end
 * in that frame (ticket 14). `lanes` is the reservation read: the model's own once allocation is over,
 * the running list while it is under way (`allocateLanes` binds it once).
 */
export function occupied(model: LayoutModel, group: LayoutGroup, link?: LayoutLink, lanes: readonly Lane[] = model.lanes) {
  // One routed-stroke lookup for the whole group: it reads every link, and a per-node call makes
  // this measurement cost the link count once for each node and pill.
  const routed = routedStrokeWidth(model), gap = (stroke.pill + routed) / 2;
  // A link foreign to the frame of a rank cell gets its lane beside the frame edge, not beside the cell
  // (ticket 04), so it never enters the frame. A link that ends inside the frame is not asked for more.
  const reach = link && foreignReach(model, group.id, link), box = group.bounds!;
  // The lanes of links that end in the frame, reserved beside this cell, grow the frame.
  // `heldLaneReach` answers nothing for a lane of another group, whatever its owner is, so only the lanes of this group look their owner up.
  const taken = link ? lanes.map(lane => heldLaneReach(model, group.id, link, lane, lane.group === group.id ? laneLink(model, lane) : undefined)).filter((item): item is Rect => item !== undefined) : [];
  return union([box, ...(reach ? [{ x: reach.x, y: box.y, width: reach.width, height: box.height }] : []),
    ...taken.map(item => ({ x: item.x, y: box.y, width: item.width, height: box.height })), ...group.nodes.flatMap(id => {
    const node = model.nodes[id]!, box = node.bounds!, clearance = 10 + ((node.strokeWidth ?? stroke.node) + routed) / 2;
    return [{ x: box.x - clearance, y: box.y, width: box.width + 2 * clearance, height: box.height },
      ...node.ports.filter(port => port.pill).map(port => {
        const pill = port.pill!.bounds;
        return { x: pill.x - gap, y: pill.y, width: pill.width + 2 * gap, height: pill.height };
      })];
  })]);
}
/**
 * How far the stroke-aware occupied extent of a group reaches past its box, on each side. A rule
 * that moves the group inside a lane window must keep this reach out of the lane too, because
 * `validateLanes` measures the same extent.
 */
export function occupiedOverhang(model: LayoutModel, group: LayoutGroup): { left: number; right: number } {
  // A cell also keeps the frame edge clear of the lanes of the links foreign to its frame (ticket 04).
  const boxes = [occupied(model, group), ...model.lanes.filter(lane => lane.tier === group.tier)
    .map(lane => laneLink(model, lane)).filter((link): link is LayoutLink => link !== undefined).map(link => occupied(model, group, link))];
  const box = union(boxes);
  return { left: group.bounds!.x - box.x, right: right(box) - right(group.bounds!) };
}
/**
 * The occupied box a group would have at `bounds`. Its nodes and pills translate with the group, so
 * a pure widening leaves a pill that already reaches past the padding exactly where it is.
 */
function occupiedAt(model: LayoutModel, group: LayoutGroup, bounds: Rect, link?: LayoutLink): Rect {
  const current = occupied(model, group, link);
  return union([bounds, { ...current, x: current.x + (bounds.x - group.bounds!.x) }]);
}
/**
 * Whether every reserved lane of a tier would still lie on the side of each group that currently
 * contains it once those groups take the proposed boxes. Lane x, width, owner and side are
 * immutable after allocation, so a movement that fails this is geometrically infeasible rather than
 * something an ordered replay can repair. This is the same occupied extent `validateLanes` measures.
 */
export function laneSidesHold(model: LayoutModel, proposed: ProposedBox[], report = true, frames = true): boolean {
  // From 7f on a straight link is a wall like a lane (ticket 34): the move is refused for that unit.
  if (!chordsHold(model, proposed, report)) return false;
  return proposed.every(({ group, bounds }) => {
    // A lane of either kind keeps the side of every group of a sub-tier it stands beside.
    const sameTier = model.lanes.filter(lane => wallBeside(lane, group.tier!) && !(lane.group === group.id && bypassLane(model, lane))).every(lane => {
      const box = occupiedAt(model, group, bounds, laneLink(model, lane));
      return group.bounds!.x >= lane.x ? box.x >= right(lane.bounds) - PLACEMENT_EPS : right(box) <= lane.bounds.x + PLACEMENT_EPS;
    });
    return sameTier;
  }) && (!frames || sideLaneFramesHold(model, proposed));
}
/**
 * Whether a lane is a wall beside the groups of a sub-tier. A perimeter lane stands beside the sub-tiers of its span: its `tier` is the one of its upper end's
 * group, which the lane need not reach (a course that leaves the bottom face of a node drops through the tier gap first). Its x is derived from the outermost
 * box on that span (`rebuildLaneExtents`), so a box that widens takes the lane out with it; only an aligned lane, which stands on its far port's x, is a wall.
 * `aligned` is the promise 7a records (`Lane.aligned`): the far natural end is a feed of 7c under the lane, so the lane stands on it from centring on.
 * Every other lane keeps its x and stands in its own sub-tier.
 */
function wallBeside(lane: Lane, tier: number): boolean {
  if (lane.kind !== 'perimeter') return lane.tier === tier;
  return lane.aligned === true && lane.span !== undefined && lane.span.top <= tier && tier <= lane.span.bottom;
}
/** Whether a lane is a stem of a row bypass: it stands in the gaps of its own group and is derived from the node boxes. */
function bypassLane(model: LayoutModel, lane: Lane): boolean {
  return lane.kind === 'gap' && lane.owner.kind === 'link' && (model.courses ?? []).some(course => course.link === (lane.owner as { id: string }).id && isBypassCourse(course));
}
/**
 * A side lane stands outside every frame that holds its node (side-faces.md, Section 10). A move is refused when the frame box rebuilt from the
 * proposed boxes (the cells' reach and every transit lane a frame holds, as `rebuildFrames` derives it) reaches deeper across the lane than the
 * frame box stands now: a frame that already crosses the lane is not made to cross it more, so the guard never stalls a layout.
 */
function sideLaneFramesHold(model: LayoutModel, proposed: ProposedBox[]): boolean {
  // A side lane and a column-gap lane both serve a lateral port and stand beside the frames that hold its node (the alias: both are gap runs).
  const sides = model.lanes.filter(lane => isGapRun(lane) && lane.port !== undefined);
  if (!sides.length || !model.frames?.length || proposed.every(({ group, bounds }) => Math.abs(bounds.x - group.bounds!.x) <= PLACEMENT_EPS
    && Math.abs(bounds.width - group.bounds!.width) <= PLACEMENT_EPS)) return true;
  const derived = framesAfter(model, proposed);
  if (derived === undefined) return true;
  const after = new Map(derived.map(frame => [frame.id, frame.box]));
  return sides.every(lane => model.frames!.filter(frame => frameNodes(model, frame.id).includes(lane.port!.node)).every(frame => {
    const reach = (box: Rect): number => lane.side === 'right' ? right(box) - lane.bounds.x : right(lane.bounds) - box.x;
    const next = after.get(frame.id);
    return next === undefined || reach(next) <= Math.max(0, reach(frame.box)) + PLACEMENT_EPS;
  }));
}
/** The x distance the riser keeps from a routed port on the facing edge of a member row: `k` plus half a stroke (mesh-bus.md, section 11.5). */
const riserKeepOut = (model: LayoutModel): number => BUS_RUN_CLEARANCE + routedStrokeWidth(model) / 2;
/**
 * The ports routed links attach to (stubs left out), by `portId`, per `model.links` array (architecture-2 ticket 60). The key is the array
 * identity and its length; the links' `layer` and `attachments` are written only in stage 2, and the in-place `technique` writers of stage 7
 * touch only links with no authored route, which are never stubs, or work on a fresh clone before any read, so no later write changes the answer. `LayoutOptions.checkCaches` checks it.
 */
const routedPortReads = new WeakMap<readonly LayoutLink[], { count: number; ids: ReadonlySet<string> }>();
const routedPortCache = readCache('facingRoutedPorts');
function routedPortIds(model: LayoutModel): ReadonlySet<string> {
  const known = routedPortReads.get(model.links);
  if (known !== undefined && known.count === model.links.length) return routedPortCache.hit(model, known.ids, () => computeRoutedPortIds(model.links));
  routedPortCache.miss();
  const ids = computeRoutedPortIds(model.links);
  routedPortReads.set(model.links, { count: model.links.length, ids });
  return ids;
}
const computeRoutedPortIds = (links: readonly LayoutLink[]): ReadonlySet<string> => new Set(links.filter(link => link.layer === 'routed' && link.technique !== 'stub' && link.attachments)
  .flatMap(link => [portId(link.attachments!.from), portId(link.attachments!.to)]));
/** The routed ports on the facing edge of a member row of a join, per join: the ports the riser keeps out of. */
function facingRoutedPorts(model: LayoutModel, group: LayoutGroup): { riser: number; ports: { node: string; ordinal: number; x: number }[] }[] {
  const result: { riser: number; ports: { node: string; ordinal: number; x: number }[] }[] = [];
  // Read once, and only when a join faces this group: no join means no read of the links.
  let used: ReadonlySet<string> | undefined;
  for (const upper of (model.meshBuses ?? []).filter(bus => bus.riser !== undefined && bus.cross !== undefined)) {
    const lower = model.meshBuses!.find(bus => bus.id === upper.joined);
    const side = group.tier === upper.row ? 'bottom' : lower !== undefined && group.tier === lower.row ? 'top' : undefined;
    if (side === undefined) continue;
    const routed = used ??= routedPortIds(model);
    const ports = group.nodes.flatMap(id => model.nodes[id]!.ports.filter(port => port.side === side && port.anchor !== undefined && routed.has(portId(port.ref)))
      .map(port => ({ node: id, ordinal: port.ref.ordinal, x: port.anchor!.x })));
    result.push({ riser: upper.riser!.x, ports });
  }
  return result;
}
/** The riser x and the keep-out to hold for the ports on `side` of the nodes of `tier`: the riser of every join whose member row that is. */
export function riserAvoidance(model: LayoutModel, tier: number, side: 'top' | 'bottom'): { xs: number[]; keep: number; routed: Set<string> } {
  const xs = (model.meshBuses ?? []).filter(bus => bus.riser !== undefined && bus.cross !== undefined).flatMap(upper => {
    const lower = model.meshBuses!.find(bus => bus.id === upper.joined);
    return (tier === upper.row && side === 'bottom') || (lower !== undefined && tier === lower.row && side === 'top') ? [upper.riser!.x] : [];
  });
  // The routed ports are read only where a riser stands on this side, so no riser means no scan of the links.
  const routed = new Set<string>(xs.length === 0 ? [] : model.links.filter(link => link.layer === 'routed' && link.technique !== 'stub' && link.attachments)
    .flatMap(link => [portId(link.attachments!.from), portId(link.attachments!.to)]));
  return { xs, keep: riserKeepOut(model) - PLACEMENT_EPS, routed };
}
/** Whether a move of `group` by `dx` keeps its facing routed ports out of the riser keep-out. */
export function riserKeepOutAfterMove(model: LayoutModel, group: LayoutGroup, dx: number): boolean {
  return riserKeepOutHolds(model, [{ group, bounds: { ...group.bounds!, x: group.bounds!.x + dx } }]);
}
/** The routed ports of a member row that stand within the riser keep-out now: what 7f reports (`MESH_BUS_RISER_KEEP_OUT`). */
export function riserKeepOutBreaches(model: LayoutModel): { node: string; riser: number }[] {
  const breaches: { node: string; riser: number }[] = [];
  for (const group of Object.values(model.groups)) for (const item of facingRoutedPorts(model, group)) {
    for (const port of item.ports) if (Math.abs(port.x - item.riser) < riserKeepOut(model) - PLACEMENT_EPS && !breaches.some(b => b.node === port.node)) breaches.push({ node: port.node, riser: item.riser });
  }
  return breaches;
}
/** How far each routed port of the facing edge of `group` stands inside the riser keep-out after a move by `dx` (a port outside it has no entry). */
export function riserPenetrations(model: LayoutModel, group: LayoutGroup, dx = 0): Map<string, number> {
  const keep = riserKeepOut(model) - PLACEMENT_EPS, result = new Map<string, number>();
  for (const item of facingRoutedPorts(model, group)) for (const port of item.ports) {
    const depth = keep - Math.abs(port.x + dx - item.riser);
    if (depth > 1e-9) result.set(`${port.node}:${port.ordinal}`, Math.max(result.get(`${port.node}:${port.ordinal}`) ?? 0, depth));
  }
  return result;
}
/** Whether no port is deeper in the keep-out in `after` than in `before`. A port is judged by itself: a move that frees one port does not pay for pushing another deeper. */
export function riserNoDeeper(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): boolean {
  return [...after].every(([key, depth]) => depth <= (before.get(key) ?? 0) + 1e-9);
}
/**
 * A move of a member row keeps every routed port of its facing edge `k` plus half a stroke from the riser x, as a move is measured against a lane
 * (mesh-bus.md, section 11.5). A move is refused when any port goes deeper in the keep-out; one that makes a breach smaller is allowed. Only the moves that can be declined ask it: a move that must be made
 * (`packClear`) is never refused for it.
 */
function riserKeepOutHolds(model: LayoutModel, proposed: { group: LayoutGroup; bounds: Rect }[]): boolean {
  return proposed.every(({ group, bounds }) => {
    const dx = bounds.x - group.bounds!.x;
    if (Math.abs(dx) <= 1e-9) return true;
    return riserNoDeeper(riserPenetrations(model, group), riserPenetrations(model, group, dx));
  });
}
/**
 * The far port of a side lane keeps the lane's x (side-faces.md, Section 10, *The far port*): a move that changes the x of the far port of a side
 * lane the port stands on, while the lane stays, is refused (`SIDE_LANE_HELD`, info). It reads every group, in every tier, not only the lane's.
 */
export function sideLanesHold(model: LayoutModel, proposed: { group: LayoutGroup; bounds: Rect }[], report = true): boolean {
  return proposed.every(({ group, bounds }) => {
    const dx = bounds.x - group.bounds!.x;
    if (Math.abs(dx) <= PLACEMENT_EPS) return true;
    return model.lanes.filter(isSideLane).every(lane => {
      const link = laneLink(model, lane);
      if (!link?.attachments) return true;
      const far = sideLaneSource(link, lane), port = findPort(model, far);
      if (!group.nodes.includes(far.node) || port?.anchor === undefined || Math.abs(port.anchor.x - lane.x) > PLACEMENT_EPS) return true;
      if (report) placementInfo(model, 'SIDE_LANE_HELD', `A move of ${group.id} would take the far port of ${link.id} off its side lane; the move is refused.`, link.id);
      return false;
    });
  });
}
/** An info finding of placement, once per message. */
function placementInfo(model: LayoutModel, code: string, message: string, link: string): void {
  if (model.diagnostics.some(item => item.code === code && item.message === message)) return;
  model.diagnostics.push({ stage: 'placement', severity: 'info', code, message, owners: [{ kind: 'link', id: link }] });
}
/**
 * What a unit puts in a span corridor (architecture ticket 22): the corridor already holds the clearances (the group-edge link margin and the half stroke of the
 * chord), so the unit counts by its box, the frame edge it stands inside for a chord foreign to its frame, and its bodies and pills with their own half stroke
 * only. `occupied` adds the 10 px clearance a second time; against a corridor it would flag a chord that stands the gate clearance away.
 */
function spanWall(model: LayoutModel, group: LayoutGroup, link: LayoutLink): Rect {
  const box = group.bounds!, reach = foreignReach(model, group.id, link);
  return union([box, ...(reach ? [{ x: reach.x, y: box.y, width: reach.width, height: box.height }] : []), ...group.nodes.flatMap(id => {
    const node = model.nodes[id]!, half = (node.strokeWidth ?? stroke.node) / 2, body = node.bounds!;
    return [{ x: body.x - half, y: body.y, width: body.width + 2 * half, height: body.height },
      ...node.ports.filter(port => port.pill).map(port => {
        const pill = port.pill!.bounds;
        return { x: pill.x - stroke.pill / 2, y: pill.y, width: pill.width + stroke.pill, height: pill.height };
      })];
  })]);
}
/**
 * The walls that stand in a span corridor (architecture ticket 22, docs/design/routed-chords.md, Section 14.3), as `lane|wall` keys: a unit of the corridor's band
 * (its occupied box, as `validateLanes` measures it) or a lane that is not a corridor, whose box meets the corridor. The end groups of the chord are no wall (they
 * stand outside the transited bands). `proposed` is a move not made yet: the groups take the proposed boxes with their bodies, and the corridors are derived
 * again from the end anchors that move.
 */
export function spanBreaches(model: LayoutModel, proposed: { group: LayoutGroup; bounds: Rect }[] = []): Set<string> {
  const result = new Set<string>();
  const corridors = model.lanes.filter(isSpanLane);
  if (!corridors.length) return result;
  let moved = model;
  if (proposed.length) {
    const groups = { ...model.groups }, nodes = { ...model.nodes };
    for (const { group, bounds } of proposed) {
      const dx = bounds.x - group.bounds!.x, dy = bounds.y - group.bounds!.y;
      groups[group.id] = { ...group, bounds: { ...bounds } };
      if (!dx && !dy) continue;
      for (const id of group.nodes) {
        const node = model.nodes[id]!;
        nodes[id] = { ...node, bounds: { ...node.bounds!, x: node.bounds!.x + dx, y: node.bounds!.y + dy },
          ports: node.ports.map(port => ({ ...port, ...(port.anchor ? { anchor: { x: port.anchor.x + dx, y: port.anchor.y + dy } } : {}),
            ...(port.pill ? { pill: { ...port.pill, bounds: { ...port.pill.bounds, x: port.pill.bounds.x + dx, y: port.pill.bounds.y + dy } } } : {}) })) };
      }
    }
    moved = { ...model, groups, nodes };
  }
  for (const lane of corridors) {
    const link = laneLink(model, lane);
    const box = link === undefined ? undefined : spanCorridor(moved, link, lane.tier);
    if (link === undefined || box === undefined) { result.add(`${lane.id}|chord`); continue; }
    const meets = (other: Rect): boolean => other.x < right(box) - PLACEMENT_EPS && right(other) > box.x + PLACEMENT_EPS;
    for (const group of Object.values(moved.groups)) {
      if (group.tier !== lane.tier || group.bounds === undefined || !group.nodes.length) continue;
      if (meets(spanWall(moved, group, link))) result.add(`${lane.id}|${group.id}`);
    }
    for (const other of model.lanes) if (other !== lane && other.tier === lane.tier && !isSpanLane(other) && meets(other.bounds)) result.add(`${lane.id}|${other.id}`);
    // A chord that is no spanning chord and crosses the corridor box is a wall too (spanning chords cross each other by design). Legs and link labels are not
    // placed yet when 7a to 7f read this (a leg is derived by the router, a label by stage 9), so they are no wall here; stage 9 reserves the label room (`spanLabelRooms`).
    for (const other of moved.links) {
      if (other.id === link.id || other.spanHint === true || !isRoutedChord(moved, other)) continue;
      if (segmentRect(other.path!.segments[0]!, box)) result.add(`${lane.id}|${other.id}`);
    }
  }
  return result;
}
/** `SPAN_CHORD_BLOCKED` (warning): a move that 7f cannot refuse put a wall into a held span corridor. The span round refuses a trial that carries one. */
export function spanLaneFindings(model: LayoutModel): Diagnostic[] {
  const blocked = new Map<string, string[]>();
  for (const key of spanBreaches(model)) {
    const [lane, wall] = key.split('|') as [string, string], owner = model.lanes.find(item => item.id === lane)?.owner;
    if (owner?.kind !== 'link') continue;
    blocked.set(owner.id, [...blocked.get(owner.id) ?? [], wall]);
  }
  return [...blocked].map(([link, walls]) => ({ stage: 'placement' as const, severity: 'warning' as const, code: 'SPAN_CHORD_BLOCKED', owners: [{ kind: 'link' as const, id: link }],
    message: `A placement move that could not be refused put ${[...new Set(walls)].join(', ')} in the corridor of the spanning chord ${link}.` }));
}
/**
 * The end of 7c: a side lane whose far port centring has put on the lane x (and that 7a did not seat there) is recorded once (`SIDE_LANE_SEATED`,
 * info), because `aligned` cannot change after 7a. `SIDE_SHAPE_LOST` warns when 7f moves such a port off the lane.
 */
export function recordSeatedSideLanes(model: LayoutModel): void {
  for (const lane of model.lanes.filter(isSideLane)) {
    const link = laneLink(model, lane), far = link?.attachments ? findPort(model, sideLaneSource(link, lane))?.anchor : undefined;
    if (link === undefined || far === undefined || lane.aligned === true || Math.abs(far.x - lane.x) > PLACEMENT_EPS) continue;
    placementInfo(model, 'SIDE_LANE_SEATED', `The far port of ${link.id} stands on its side lane after centring.`, link.id);
  }
}
/**
 * The findings of the end of 7f about the side lanes (side-faces.md, Sections 10 and 11): `SIDE_SHAPE_LOST` (warning) names each link whose lane
 * 7a seated on the far port's x and whose far port has left it, so the drop is a stepped part; `SIDE_LANE_INSIDE_FRAME` (warning) names each
 * link whose lane a frame box of its end now crosses. `validateLanes` does not throw for either: a forced 7f move can cause them after 7a.
 */
export function sideLaneFindings(model: LayoutModel): Diagnostic[] {
  const result: Diagnostic[] = [];
  const seated = new Set(model.diagnostics.filter(item => item.code === 'SIDE_LANE_SEATED').flatMap(item => (item.owners ?? []).flatMap(owner => 'id' in owner ? [owner.id] : [])));
  for (const lane of model.lanes.filter(isSideLane)) {
    const link = laneLink(model, lane);
    if (!link?.attachments) continue;
    const owners = [{ kind: 'link' as const, id: link.id }];
    const far = findPort(model, sideLaneSource(link, lane))?.anchor;
    if ((lane.aligned === true || seated.has(link.id)) && far !== undefined && Math.abs(far.x - lane.x) > PLACEMENT_EPS) {
      result.push({ stage: 'placement', severity: 'warning', code: 'SIDE_SHAPE_LOST', owners,
        message: `${link.id} lost its drop: the far port stands ${Math.round(Math.abs(far.x - lane.x) * 100) / 100} px off its side lane, so the part is stepped.` });
    }
    if (lane.port !== undefined && !outermostOfRow(model, lane.port)) {
      result.push({ stage: 'placement', severity: 'warning', code: 'SIDE_LANE_NOT_OUTERMOST', owners,
        message: `A node stands beyond the port of ${link.id} in its row, between the port and its side lane; the side run crosses it.` });
    }
    const crossed = (model.frames ?? []).filter(frame => frameNodes(model, frame.id).includes(lane.port!.node)
      && (lane.side === 'right' ? lane.bounds.x < right(frame.box) - PLACEMENT_EPS : right(lane.bounds) > frame.box.x + PLACEMENT_EPS));
    for (const frame of crossed) {
      result.push({ stage: 'placement', severity: 'warning', code: 'SIDE_LANE_INSIDE_FRAME', owners,
        message: `The box of frame ${frame.id} crosses the side lane of ${link.id}; the side run ends inside the frame.` });
    }
  }
  return result;
}
/** The link a lane belongs to. */
export function laneLink(model: LayoutModel, lane: Lane): LayoutLink | undefined {
  return lane.owner.kind === 'link' ? model.links.find(link => link.id === (lane.owner as { id: string }).id) : undefined;
}
function laneId(link: LayoutLink, tier: number): string { return `lane:${JSON.stringify(link.id)}:${tier}`; }
/** The id of the side lane of a link (docs/design/side-faces.md, Section 10). */
export const sideLaneId = (link: LayoutLink): string => `side-lane:${link.id}`;
/** Whether a lane is a side lane; an absent `kind` reads `transit`. Every lane function that serves one kind asks this and skips the other. */
export const isSideLane = (lane: Lane): boolean => lane.kind === 'side';
function laneExtent(model: LayoutModel, tier: number): { y: number; height: number } {
  const box = model.tierBands.find(band => band.tier === tier)!.bounds!;
  const pad = 10 + stroke.path / 2;
  return { y: box.y - pad, height: box.height + 2 * pad };
}
function reservation(model: LayoutModel, link: LayoutLink, lane: Lane): PathSegment {
  const downward = nodeTier(model, link.attachments!.from.node) < nodeTier(model, link.attachments!.to.node);
  const a = { x: lane.x, y: lane.bounds.y }, b = { x: lane.x, y: bottom(lane.bounds) };
  return { from: downward ? a : b, to: downward ? b : a, owner: { kind: 'link', id: link.id }, lane: lane.id };
}
/**
 * The far end of a side lane: the port that is not lateral. The lane aligns to it (7a puts the lane on its x where it can) and the lateral
 * end is not moved under the lane, because the side run joins them at any x.
 */
export function sideLaneSource(link: LayoutLink, lane: Lane): PortRef {
  const ends = link.attachments!;
  return portId(ends.from) === portId(lane.port!) ? ends.to : ends.from;
}
/**
 * The extent of a side lane: measured from the lateral port, not the band. From the band edge that faces the far end (grown by the same
 * pad as `laneExtent`) to the port's anchor y. `rebuildLaneExtents` replays it from the port's current y.
 */
export function sideLaneExtent(model: LayoutModel, lane: Lane, link: LayoutLink): { y: number; height: number } {
  const band = model.tierBands.find(item => item.tier === lane.tier)!.bounds!, pad = 10 + stroke.path / 2;
  const at = findPort(model, lane.port!)!.anchor!.y;
  if (nodeTier(model, sideLaneSource(link, lane).node) < lane.tier) return { y: band.y - pad, height: at - (band.y - pad) };
  return { y: at, height: bottom(band) + pad - at };
}
/**
 * The two fixed segments of a side lane, in path order: the vertical run at the lane x over the extent, then the side run from the lane x
 * to the port's face at the port's y (the run is the port's stem: at least one stem long). Where the lateral port is the source of the link,
 * the path leaves by the side run and both segments run the other way. Both carry `lane: <id>`.
 */
export function sideReservation(model: LayoutModel, link: LayoutLink, lane: Lane): PathSegment[] {
  const anchor = findPort(model, lane.port!)!.anchor!;
  const farAbove = nodeTier(model, sideLaneSource(link, lane).node) < lane.tier;
  const edge = { x: lane.x, y: farAbove ? lane.bounds.y : bottom(lane.bounds) }, turn = { x: lane.x, y: anchor.y };
  const owner = { kind: 'link' as const, id: link.id };
  const lateralIsTarget = portId(link.attachments!.to) === portId(lane.port!);
  return lateralIsTarget
    ? [{ from: edge, to: turn, owner, lane: lane.id }, { from: { ...turn }, to: { x: anchor.x, y: anchor.y }, owner: { ...owner }, lane: lane.id }]
    : [{ from: { x: anchor.x, y: anchor.y }, to: turn, owner, lane: lane.id }, { from: { ...turn }, to: edge, owner: { ...owner }, lane: lane.id }];
}
/** The fixed segments a link's lanes reserve, in path order: its transit lanes in tier order, or its one side lane. */
function laneReservation(model: LayoutModel, link: LayoutLink): PathSegment[] | undefined {
  // An overlay course reserves its lane and its padding rows, but no fixed segment: the router never sees an overlay, and `overlayPath` reads the lane (ticket 15, phase 7).
  if (link.layer === 'overlay') return undefined;
  const owned = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id && !isSpanLane(lane));
  // A course lane reserves the runs of its course (ticket 15): the side runs and padding rows of its ends, and the vertical run beyond every box.
  const perimeter = owned.find(isCourseLane), course = perimeter === undefined ? undefined : courseOf(model, link.id);
  if (perimeter !== undefined && course !== undefined) {
    // A bypass reserves its whole route: both stems, the padding row and the side runs (ticket 24, phase 5).
    if (isBypassCourse(course)) return bypassGeometry(model, link, course)?.segments;
    return perimeter.kind === 'gap' ? gapReservation(model, link, course, perimeter)
      : courseGeometry(model, link, course, perimeter, (group, item) => occupied(model, group, item), ringsOf(model.lanes))?.segments;
  }
  const side = owned.find(isSideLane);
  if (side) return sideReservation(model, link, side);
  const order = transitTiers(model, link);
  owned.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
  return owned.length ? owned.map(lane => reservation(model, link, lane)) : undefined;
}
/**
 * Put the lanes of an earlier reading back, and with them everything derived from lanes: their extents (`rebuildLaneExtents`) and the frames, which hold the
 * lanes of their own links (`heldLaneReach`). A trial that moved a corridor derived the frames again (`reseatLanes`); the restore that refuses it derives them
 * again too, or a frame edge stands at the refused corridor and stage 8 reads frames that contradict the cells.
 */
export function restoreLanes(model: LayoutModel, held: LayoutModel['lanes']): void {
  model.lanes = held;
  rebuildLaneExtents(model);
  rebuildFrames(model);
}
/** Extent-only replay. Never allocates, moves, renames, or changes the owner of a lane. */
export function rebuildLaneExtents(model: LayoutModel): void {
  for (const lane of model.lanes) {
    if (isSpanLane(lane)) {
      // A span corridor's x and width are derived from the two end anchors (architecture ticket 22).
      const link = laneLink(model, lane);
      if (link === undefined || !replaySpanLane(model, lane, link)) throw new SpanRefusal(`The span corridor ${lane.id} has no chord in its band`);
      continue;
    }
    if (lane.kind === 'gap') {
      // A column-gap lane keeps its x for good; its extent is replayed from the lateral port's y, as a side lane's is (ticket 15, phase 5).
      const link = laneLink(model, lane), course = link === undefined ? undefined : courseOf(model, link.id);
      if (link !== undefined && course !== undefined && isBypassCourse(course)) {
        // The stems of a bypass stand at the centre of their gaps and are derived from the node boxes, so a move of the group takes them along.
        const geometry = bypassGeometry(model, link, course), index = lane.id === bypassLaneId(link.id, 1) ? 1 : 0;
        if (geometry !== undefined) {
          const extent = bypassLaneExtent(geometry, index);
          lane.x = extent.x;
          Object.assign(lane.bounds, { x: extent.x - lane.bounds.width / 2, y: extent.y, height: extent.height });
        }
        continue;
      }
      const geometry = link === undefined || course === undefined ? undefined : gapGeometry(model, link, course);
      if (geometry !== undefined) Object.assign(lane.bounds, geometry.extent);
      continue;
    }
    if (isCourseLane(lane)) continue;
    if (!isSideLane(lane)) { Object.assign(lane.bounds, laneExtent(model, lane.tier)); continue; }
    // A side lane is replayed from its lateral port's current y, not from the band.
    const link = laneLink(model, lane);
    if (link?.attachments && findPort(model, lane.port!)?.anchor) Object.assign(lane.bounds, sideLaneExtent(model, lane, link));
  }
  // A course lane stands beyond every box on its extent, so it is replayed after the other lanes, which it reads; its x is derived (ticket 15, Section 2).
  const rings = ringsOf(model.lanes), stacked: Lane[] = [];
  for (const lane of model.lanes.filter(item => item.kind === 'perimeter').sort((a, b) => (a.ring ?? 0) - (b.ring ?? 0))) {
    if (lane.owner.kind === 'mesh-bus') {
      // A trunk lane stands beyond every box on the extent between its uppermost bar and its lowermost, like a course lane (mesh-bus.md, section 12.5).
      const head = model.meshBuses?.find(item => item.id === (lane.owner as { id: string }).id);
      const geometry = head === undefined ? undefined : trunkGeometry(model, head, { side: lane.side, ring: lane.ring ?? 0 }, group => occupied(model, group), stacked);
      if (head === undefined || geometry === undefined) throw new Error(`Lane ${lane.id} has no trunk`);
      lane.x = geometry.x;
      Object.assign(lane.bounds, geometry.bounds);
      head.trunk!.x = geometry.x;
      stacked.push(lane);
      continue;
    }
    const link = laneLink(model, lane), course = link === undefined ? undefined : courseOf(model, link.id);
    if (link === undefined || course === undefined) throw new Error(`Lane ${lane.id} has no course`);
    const geometry = courseGeometry(model, link, course, lane, (group, item) => occupied(model, group, item), rings, stacked);
    if (geometry === undefined) throw new CourseRefusal(`The course of ${link.id} cannot join one lane`);
    lane.x = geometry.x;
    Object.assign(lane.bounds, geometry.bounds);
    stacked.push(lane);
  }
  for (const link of model.links) {
    delete link.fixedSegments;
    if (link.bundle) continue;
    const runs = laneReservation(model, link);
    if (runs) link.fixedSegments = runs;
  }
  expandCanvas(model);
}
/** The end of a transit a lane does not align to: the one 7c has to bring under the corridor. */
function laneChild(model: LayoutModel, link: LayoutLink): PortRef {
  const source = laneSource(model, link);
  return source === link.attachments!.from ? link.attachments!.to : link.attachments!.from;
}
/**
 * Whether the child node keeps its feed order. The order the move can break is the order of the
 * corridors of one tier against the order of the children they serve: two that swap put each
 * link's descent across the other's. The order of a *node's* feeds cannot break here, because this
 * rule runs after the last centring replay — the measurement behind the rule's condition is in
 * decisions-log Q48.
 */
function feedOrderHolds(model: LayoutModel, lane: Lane, link: LayoutLink, cx: number): boolean {
  const anchor = findPort(model, laneChild(model, link))!.anchor!;
  for (const other of model.lanes) {
    if (other === lane || other.tier !== lane.tier || other.owner.kind !== 'link') continue;
    const peer = model.links.find(item => item.id === (other.owner as { id: string }).id);
    if (!peer || peer.bundle || !peer.attachments) continue;
    const peerChild = findPort(model, laneChild(model, peer))?.anchor;
    if (peerChild && (cx - other.x) * (anchor.x - peerChild.x) < -1e-9) return false;
  }
  return true;
}
/** Whether a node is drawn as a bar, whose port x stage 7d derives instead of placing. */
function isBarNode(model: LayoutModel, id: string): boolean {
  return model.document.groups[model.document.nodes[id]!.group]!.shape === 'bar';
}
/** Whether more than one routed link attaches to a port, which makes it a fan (ticket 20). */
function shared(model: LayoutModel, ref: PortRef): boolean {
  const key = portId(ref);
  return model.links.filter(link => link.layer === 'routed' && link.attachments
    && [link.attachments.from, link.attachments.to].some(end => portId(end) === key)).length > 1;
}
/** Every box a corridor may not stand in, other than the geometry the moving link owns. */
function corridorFree(model: LayoutModel, lane: Lane, link: LayoutLink, child: PortRef, x: number): boolean {
  const half = lane.bounds.width / 2, window = { x: x - half, width: lane.bounds.width };
  const overlaps = (box: { x: number; width: number }) => box.x < window.x + window.width - PLACEMENT_EPS && box.x + box.width > window.x + PLACEMENT_EPS;
  // Inside the transited band the corridor is the reservation `validateLanes` measures.
  for (const group of Object.values(model.groups)) if (group.tier === lane.tier && overlaps(occupied(model, group, link))) return false;
  for (const other of model.lanes) if (other !== lane && other.tier === lane.tier
    && Math.abs(other.x - x) < (other.bounds.width + lane.bounds.width) / 2 - PLACEMENT_EPS) return false;
  // Beyond the band the corridor is the child's own descent. It may enter the child's group and
  // nothing else: a foreign node, a foreign group box or a reserved run of another link stops it.
  const anchor = findPort(model, child)!.anchor!;
  const low = Math.min(lane.bounds.y, anchor.y), high = Math.max(bottom(lane.bounds), anchor.y);
  const span = { x: window.x, y: low, width: window.width, height: high - low };
  const childGroup = model.document.nodes[child.node]!.group;
  for (const node of Object.values(model.nodes)) {
    if (node.id === child.node) continue;
    const box = node.bounds!;
    if (overlaps(box) && box.y < bottom(span) - PLACEMENT_EPS && bottom(box) > span.y + PLACEMENT_EPS) return false;
  }
  for (const group of Object.values(model.groups)) {
    if (group.id === childGroup || group.tier === lane.tier) continue;
    const box = group.bounds!;
    if (overlaps(box) && box.y < bottom(span) - PLACEMENT_EPS && bottom(box) > span.y + PLACEMENT_EPS) return false;
  }
  // Every reserved run of another link, in the three forms placement writes: a pinned path, the
  // corridor runs of 7a, and the shared runs 7e cuts for a fan. The gap allocation counts all
  // three, so a corridor that ignored one would stand where a reserved run already does.
  for (const other of model.links) {
    if (other.id === link.id) continue;
    const runs = [...other.path?.fixed ? other.path.segments : [], ...other.fixedSegments ?? [],
      ...other.sharedRuns?.from ?? [], ...other.sharedRuns?.to ?? []];
    for (const segment of runs) if (segmentRectDistance(segment, span) < linkStrokeWidth(other) / 2 - PLACEMENT_EPS) return false;
  }
  return true;
}
/**
 * 7c seats a transit feed's child under the corridor its link owns. Where it could not, the
 * corridor follows the child instead of the child's route crossing back to it (ticket 02). Only
 * the corridor in the tier next to the child may move, and only when the corridor at the child's
 * port x is free of foreign geometry, and the move keeps the child node's feed order. Only the
 * corridor in the tier next to the child may move: the corridors before it carry the link across
 * tiers it has left behind, and the jog between two corridors is what § 7a already accepts.
 *
 * `followed` collects what each move is *for*: the corridor and the child port it was seated on.
 * The move buys that one alignment and nothing else, so a caller that lets other plans settle
 * afterwards can ask whether the corridor still stands at that port, and refuse a move that no
 * longer does.
 */
export function reseatLanes(model: LayoutModel, followed?: LaneFollow[]): boolean {
  let moved = false;
  // The corridors are taken in reservation order and each candidate is measured against the ones
  // already moved, the same serialization 7a allocates in. A corridor is never measured against a
  // move that has not been made.
  for (const lane of model.lanes) {
    // A side lane serves the lateral end and is never seated under a child: only transit corridors follow their child.
    if (lane.owner.kind !== 'link' || laneRunKind(lane) !== 'transit') continue;
    const link = model.links.find(item => item.id === (lane.owner as { id: string }).id);
    if (!link || link.bundle || !link.attachments) continue;
    // A lane that passes a frame the link is foreign to is one x for the whole frame (ticket 04); the
    // corridor cannot follow the child alone without breaking that.
    if (foreignRoot(model, lane.group, link) !== undefined) continue;
    // 7e has already cut the geometry of a link that shares a run, and a shared port's tree is
    // reserved against the corridor this rule would move. Both keep their corridor. So does a link
    // with a bar end: 7d takes that port's x from this very corridor, and the bar rebuild every
    // publication replays would then contradict the declaration-order geometry it re-derives.
    if (link.sharedRuns || [link.attachments.from, link.attachments.to]
      .some(end => shared(model, end) || isBarNode(model, end.node))) continue;
    const child = laneChild(model, link);
    // `transitTiers` runs from the authored source to the authored target. The corridor that may
    // move is the one next to the *child*, which is that order's last tier only when the child is
    // the authored target; read it from the child so the answer does not follow the authoring.
    const order = transitTiers(model, link);
    if ((child === link.attachments.to ? order.at(-1) : order[0]) !== lane.tier) continue;
    const anchor = findPort(model, child)?.anchor;
    if (!anchor || Math.abs(anchor.x - lane.x) < 0.5) continue;
    if (!corridorFree(model, lane, link, child, anchor.x) || !feedOrderHolds(model, lane, link, anchor.x)) continue;
    const group = Object.values(model.groups).filter(item => item.tier === lane.tier)
      .sort((a, b) => Math.abs(anchor.x - (a.bounds!.x + a.bounds!.width / 2)) - Math.abs(anchor.x - (b.bounds!.x + b.bounds!.width / 2)))[0];
    if (!group) continue;
    lane.x = anchor.x;
    lane.bounds.x = anchor.x - lane.bounds.width / 2;
    lane.group = group.id;
    // The one in-place write of a lane's group: a new array, so a read cached by the identity of `model.lanes` (ticket 60) reads again.
    // Only `model` gets it: no shallow copy of the model that shares these lanes may outlive a reseat (none does; drafts are deep copies).
    model.lanes = [...model.lanes];
    lane.side = anchor.x < group.bounds!.x ? 'left' : 'right';
    moved = true;
    followed?.push({ lane: lane.id, child });
    placementWarning(model, 'LANE_FOLLOWS_ITS_CHILD',
      `${link.id} could not be seated under its corridor at tier ${lane.tier}; the corridor follows the child port.`, [link.id]);
  }
  // A frame holds the lanes of its own links (`heldLaneReach`), so a moved corridor can move a frame edge: the frames are derived again.
  if (moved) { rebuildLaneExtents(model); rebuildFrames(model); }
  return moved;
}
/** Prefer the nearest in-span slot that leaves room for the remaining members of this source. */
function inSpanSlot(model: LayoutModel, link: LayoutLink, core: { x: number; width: number }, width: number,
  prior: Lane[], remaining: LayoutLink[]): number | undefined {
  const source = model.nodes[laneSource(model, link).node]!.bounds!, half = width / 2;
  let intervals = [
    { low: source.x, high: Math.min(right(source), core.x - half) },
    { low: Math.max(source.x, core.x + core.width + half), high: right(source) },
  ].filter(range => range.low <= range.high);
  for (const lane of prior) {
    const low = lane.x - (lane.bounds.width + width) / 2, high = lane.x + (lane.bounds.width + width) / 2;
    intervals = intervals.flatMap(range => high <= range.low || low >= range.high ? [range]
      : [{ low: range.low, high: low }, { low: high, high: range.high }].filter(part => part.high >= part.low && part.low >= range.low && part.high <= range.high));
  }
  const cohort = remaining.filter(other => laneSource(model, other).node === laneSource(model, link).node);
  const count = cohort.length, gap = Math.max(width, ...cohort.map(other => laneWidth(model, other)));
  const sx = findPort(model, laneSource(model, link))!.anchor!.x;
  const candidates = intervals.flatMap(range => [range.low, range.high, Math.max(range.low, Math.min(sx, range.high)),
    ...Array.from({ length: count }, (_, index) => range.high - index * gap).filter(x => x >= range.low)]);
  const capacity = (x: number): number => intervals.reduce((sum, range) => {
    const low = Math.max(x, range.low);
    return sum + (range.high < low ? 0 : Math.floor((range.high - low + PLACEMENT_EPS) / gap) + 1);
  }, 0);
  const enough = candidates.filter(x => capacity(x) >= count);
  return (enough.length ? enough : candidates).sort((a, b) => Math.abs(a - sx) - Math.abs(b - sx) || a - b)[0];
}
/**
 * Plan outward pushes from the insertion gap, not from a corridor's centre. The gap partitions
 * the original group order even when a wide corridor contains an entire neighboring group.
 * Propagate each push through its neighbors and retain their existing occupied separation.
 * `stillStays`: a unit the push does not move is not judged against the prior lanes (a span corridor, ticket 35): it crosses no lane it did not
 * cross before, and the corridor itself is judged against every prior lane at its own x (first line).
 */
function marginTranslations(read: (group: LayoutGroup) => Rect, groups: LayoutGroup[], split: number, x: number, width: number,
  prior: Lane[], fixedSources: Set<string>, framed = false, stillStays = false): number[] | undefined {
  if (prior.some(lane => Math.abs(x - lane.x) < (width + lane.bounds.width) / 2 - PLACEMENT_EPS)) return undefined;
  const boxes = groups.map(read), shifts = groups.map(() => 0);
  let boundary = x - width / 2;
  for (let i = split - 1; i >= 0; i--) {
    shifts[i] = Math.min(0, boundary - right(boxes[i]!));
    const gap = i > 0 ? Math.max(0, boxes[i]!.x - right(boxes[i - 1]!)) : 0;
    boundary = boxes[i]!.x + shifts[i]! - gap;
  }
  boundary = x + width / 2;
  for (let i = split; i < groups.length; i++) {
    shifts[i] = Math.max(0, boundary - boxes[i]!.x);
    const gap = i + 1 < groups.length ? Math.max(0, boxes[i + 1]!.x - right(boxes[i]!)) : 0;
    boundary = right(boxes[i]!) + shifts[i]! + gap;
  }
  for (const [index, group] of groups.entries()) {
    const dx = shifts[index]!, box = boxes[index]!;
    if (dx && fixedSources.has(group.id)) return undefined;
    // A cell of a frame stands on the axis of its column with every other cell of the frame (ticket 09).
    // A push of one sub-tier alone would move it off the axis, so only the frame pass, which checks that
    // every cell of a frame root moves by one dx, may push a cell.
    if (dx && group.frame !== undefined && !framed) return undefined;
    if (!dx && stillStays) continue;
    for (const lane of prior) {
      // A lane of a link that ends in this cell's frame stands inside the box: the frame grows to hold it,
      // so the cell cannot move away from it (ticket 14).
      if (group.frame !== undefined && lane.group === group.id && box.x <= lane.bounds.x + PLACEMENT_EPS && right(box) >= right(lane.bounds) - PLACEMENT_EPS) {
        if (dx) return undefined;
        continue;
      }
      // Existing corridors cannot be crossed or consumed by a later margin expansion.
      if (right(box) <= lane.bounds.x + PLACEMENT_EPS) {
        if (right(box) + dx > lane.bounds.x + PLACEMENT_EPS) return undefined;
      } else if (box.x >= right(lane.bounds) - PLACEMENT_EPS) {
        if (box.x + dx < right(lane.bounds) - PLACEMENT_EPS) return undefined;
      } else return undefined;
    }
  }
  return shifts;
}
/** The id of the riser lane of `bus` in a crossed sub-tier. */
const riserLaneId = (bus: string, tier: number): string => `riser:${bus}:${tier}`;
/** The sub-tiers strictly between the two rows of a join: where its riser holds a lane. */
function crossedTiers(model: LayoutModel, upper: { row: number }, lower: { row: number }): number[] {
  return model.tierBands.map(band => band.tier).filter(tier => tier > upper.row && tier < lower.row).sort((a, b) => a - b);
}

/**
 * Stage 7a, after the lanes of every routed link: the riser of each joined pair (mesh-bus.md, section 11.5). One x for the whole riser is chosen
 * among the slots that stay clear of every body, foreign frame and lane in the crossed sub-tiers, and of every routed port x on the facing edges of
 * the two rows and every lane box in the gaps it crosses (the riser keep-out); then a lane is reserved in each crossed sub-tier. Among the
 * slots: the fewest frame edges crossed by the riser and the bar extensions, the fewest groups moved (none: a slot that needs a group moved
 * aside is not taken), the least bar extension, the x nearest the midpoint of the shorter bar's span, the smaller x.
 * Lane x is immutable afterwards, like any lane.
 */
export function reserveRisers(model: LayoutModel, pending: Lane[], occ: (group: LayoutGroup, link?: LayoutLink) => Rect): void {
  for (const upper of (model.meshBuses ?? []).filter(bus => bus.cross !== undefined)) {
    const lower = model.meshBuses!.find(bus => bus.id === upper.joined);
    if (lower === undefined) continue;
    const members = [...upper.nodes, ...lower.nodes], crossed = crossedTiers(model, upper, lower);
    const width = laneWidth(model), half = width / 2, keepOut = riserKeepOut(model);
    const spanOf = (bus: { ports: PortRef[] }): { lo: number; hi: number } => {
      const xs = bus.ports.map(ref => findPort(model, ref)!.anchor!.x);
      return { lo: Math.min(...xs), hi: Math.max(...xs) };
    };
    const spans = [spanOf(upper), spanOf(lower)];
    const shorter = spans[1]!.hi - spans[1]!.lo < spans[0]!.hi - spans[0]!.lo ? spans[1]! : spans[0]!;
    const middle = (shorter.lo + shorter.hi) / 2;
    // The x-intervals the riser centre may not stand in.
    const blocked: [number, number][] = [];
    for (const tier of crossed) {
      for (const group of Object.values(model.groups).filter(item => item.tier === tier && item.bounds !== undefined && item.nodes.length)) {
        const box = occ(group), reach = riserForeignReach(model, group.id, members);
        const low = Math.min(box.x, reach?.x ?? Infinity), high = Math.max(right(box), reach === undefined ? -Infinity : right(reach));
        blocked.push([low - half, high + half]);
      }
      for (const lane of pending.filter(item => item.tier === tier)) blocked.push([lane.bounds.x - half, right(lane.bounds) + half]);
    }
    const routedUsed = new Set(model.links.filter(link => link.layer === 'routed' && link.technique !== 'stub' && link.attachments)
      .flatMap(link => [portId(link.attachments!.from), portId(link.attachments!.to)]));
    for (const [bus, side] of [[upper, 'bottom'], [lower, 'top']] as const) {
      for (const group of Object.values(model.groups).filter(item => item.tier === bus.row)) for (const id of group.nodes) {
        for (const port of model.nodes[id]!.ports) if (port.side === side && routedUsed.has(portId(port.ref)) && port.anchor) blocked.push([port.anchor.x - keepOut, port.anchor.x + keepOut]);
      }
    }
    // The riser meets each bar at its own x; it keeps the same distance from every stub of both facing edges, so it does not read as a riser into a node.
    for (const bus of [upper, lower]) for (const ref of bus.ports) {
      const anchor = findPort(model, ref)?.anchor;
      if (anchor !== undefined) blocked.push([anchor.x - keepOut, anchor.x + keepOut]);
    }
    for (const lane of pending.filter(item => item.tier >= upper.row && item.tier <= lower.row)) blocked.push([lane.bounds.x - keepOut - half, right(lane.bounds) + keepOut + half]);
    blocked.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const item of blocked) {
      const last = merged.at(-1);
      if (last !== undefined && item[0] <= last[1] + PLACEMENT_EPS) last[1] = Math.max(last[1], item[1]); else merged.push([...item]);
    }
    const free = (x: number): boolean => merged.every(([low, high]) => x <= low + PLACEMENT_EPS || x >= high - PLACEMENT_EPS);
    const candidates = new Set<number>();
    for (const [low, high] of merged) { candidates.add(low); candidates.add(high); }
    if (free(middle)) candidates.add(middle);
    for (const span of spans) { const centre = (span.lo + span.hi) / 2; if (free(centre)) candidates.add(centre); }
    if (!merged.length) candidates.add(middle);
    const frames = model.frames ?? [];
    const holding = frames.filter(frame => frameNodes(model, frame.id).some(node => members.includes(node))).map(frame => frame.box);
    const band = (tier: number) => model.tierBands.find(item => item.tier === tier)!.bounds!;
    const y0 = bottom(band(upper.row)), y1 = band(lower.row).y;
    const score = (x: number) => {
      let edges = 0;
      for (const frame of frames) {
        const box = frame.box;
        if (x > box.x + PLACEMENT_EPS && x < right(box) - PLACEMENT_EPS) for (const y of [box.y, bottom(box)]) if (y > y0 && y < y1) edges++;
      }
      let extension = 0;
      for (const [bus, span, y] of [[upper, spans[0]!, y0 + 15], [lower, spans[1]!, y1 - 15]] as const) {
        void bus;
        const from = x < span.lo ? x : x > span.hi ? span.hi : undefined, to = x < span.lo ? span.lo : x > span.hi ? x : undefined;
        if (from === undefined || to === undefined) continue;
        extension += to - from;
        for (const frame of frames) {
          const box = frame.box;
          if (y <= box.y || y >= bottom(box)) continue;
          for (const edge of [box.x, right(box)]) if (edge > from + PLACEMENT_EPS && edge < to - PLACEMENT_EPS) edges++;
        }
      }
      // The room a frame that holds a member must grow by to hold the lane: a slot inside a member frame costs none.
      const growth = holding.length ? Math.min(...holding.map(box => Math.max(0, box.x - x, x - right(box)))) : 0;
      return { x, edges, extension, growth, distance: Math.abs(x - middle) };
    };
    const ranked = [...candidates].filter(x => Number.isFinite(x) && free(x)).map(score)
      .sort((a, b) => a.edges - b.edges || a.extension - b.extension || a.growth - b.growth || a.distance - b.distance || a.x - b.x);
    const chosen = ranked[0];
    // No slot: stand beyond every body, frame and lane of the crossed sub-tiers (the fallback of the corridor rule).
    const x = chosen?.x ?? (merged.length ? merged.at(-1)![1] : middle);
    const ids: string[] = [];
    for (const tier of crossed) {
      const groups = Object.values(model.groups).filter(item => item.tier === tier && item.bounds !== undefined);
      const outside = groups.filter(item => x < item.bounds!.x || x > right(item.bounds!));
      const near = (item: LayoutGroup): number => Math.abs(x - (item.bounds!.x + item.bounds!.width / 2));
      // The host is the group whose frames grow least to hold the lane (`riserHostGrowth`, the test `transitLanes` grows them by): a lane in the gap between two
      // cantons is held by the canton whose margin it stands in, and the frame across the gap is not stretched over the gap to it. Then the nearest centre, then the id.
      const growth = new Map(groups.map(item => [item.id, riserHostGrowth(model, item.id, members, { x: x - half, width })]));
      const host = [...(outside.length ? outside : groups)].sort((a, b) => growth.get(a.id)! - growth.get(b.id)! || near(a) - near(b) || compareId(a.id, b.id))[0];
      if (host === undefined) continue;
      const id = riserLaneId(upper.id, tier);
      ids.push(id);
      pending.push({ id, owner: { kind: 'mesh-bus', id: upper.id }, layer: 'overlay', group: host.id, tier, side: x < host.bounds!.x ? 'left' : 'right',
        x, bounds: { x: x - half, width, ...laneExtent(model, tier) } });
    }
    upper.riser = { x, lanes: ids };
    model.diagnostics.push({ stage: 'placement', severity: 'info', code: 'MESH_BUS_RISER', owners: [{ kind: 'mesh-bus', id: upper.id }],
      message: `The riser of ${upper.id} and ${lower.id} stands at x ${Math.round(x * 100) / 100}, crossing ${crossed.length} sub-tiers and ${chosen?.edges ?? 0} frame edges`
        + `; 0 groups moved; bar extension ${Math.round((chosen?.extension ?? 0) * 100) / 100} px${chosen === undefined ? '; no free slot, beyond every body' : ''}` });
  }
}

/**
 * Stage 7a, after the risers: the perimeter lane of each trunk join (mesh-bus.md, section 12.5; architecture ticket 21). Owner the head bus, id `trunk:<head>`,
 * side from stage 5, span the member rows. Its ring is one beyond every perimeter lane of its side whose extent it meets (it stands outside the course lanes it
 * nests over); its x is derived, here and at every replay (`rebuildLaneExtents`), beyond every box on its extent.
 */
function reserveTrunks(model: LayoutModel, pending: Lane[], occ: (group: LayoutGroup, link?: LayoutLink) => Rect): void {
  for (const head of trunkHeads(model)) {
    const side = head.trunk!.side;
    if (side === undefined) throw new Error(`Trunk ${head.id} has no side at stage 7a`);
    const buses = trunkBuses(model, head), rows = buses.map(bus => bus.row);
    const first = trunkGeometry(model, head, { side, ring: 0 }, group => occ(group), pending);
    if (first === undefined) throw new Error(`Trunk ${head.id} has no geometry at stage 7a`);
    const ring = trunkRing(pending, side, first.bounds);
    const used = ring === 0 ? first : trunkGeometry(model, head, { side, ring }, group => occ(group), pending)!;
    const outer = (bus: MeshBus): LayoutGroup | undefined => Object.values(model.groups).find(group => group.nodes.includes(bus.nodes[0]!));
    const host = outer(buses[0]!);
    if (host === undefined) throw new Error(`Trunk ${head.id} has no host group`);
    const id = head.trunk!.lane;
    pending.push({ id, kind: 'perimeter', owner: { kind: 'mesh-bus', id: head.id }, layer: 'overlay', group: host.id, tier: host.tier!, side,
      span: { top: Math.min(...rows), bottom: Math.max(...rows) }, ring, x: used.x, bounds: { ...used.bounds } });
    head.trunk!.x = used.x;
  }
}

/**
 * The groups 7a may not translate: the group of the authored source of every routed link that crosses a tier, whether it owns a
 * transit lane or not (a course or a spanning chord). The lane-stage guard in `mutation.ts` and the plans of `allocateLanes` read this one set.
 */
export function heldSourceGroups(model: LayoutModel): Set<string> {
  return new Set(model.links.filter(link => transitTiers(model, link).length).map(link => model.document.nodes[link.attachments!.from.node]!.group));
}
/** The groups no 7a plan may push: the alignment-end group of every link that owns a lane, and `heldSourceGroups`. */
export function fixedSourceGroups(model: LayoutModel): Set<string> {
  const owners = model.links.filter(link => ownsTransitLanes(model, link));
  return new Set([...owners.map(link => model.document.nodes[laneSource(model, link).node]!.group), ...heldSourceGroups(model)]);
}
/**
 * The direct plan of a corridor at the source x (7a): of the insertion gaps whose push `marginTranslations` admits, the one that leaves
 * the transited group `groups[at]` on the `side` the target asks for, else any, then the least total displacement. `split` is the count
 * of groups left of the corridor, so the corridor passes the transited group on its left when `split <= at`. 7a and the stage-4 row
 * order (ticket 17) call it, so the two read one feasibility.
 */
export function directPlan(read: (group: LayoutGroup) => Rect, groups: LayoutGroup[], at: number, side: 'left' | 'right' | undefined, sx: number,
  width: number, prior: Lane[], fixed: Set<string>): { split: number; shift: number[] } | undefined {
  const offSide = (split: number): number => side === undefined ? 0 : Number(side === 'left' ? split > at : split <= at);
  return Array.from({ length: groups.length + 1 }, (_, split) => split)
    .map(split => ({ split, shift: marginTranslations(read, groups, split, sx, width, prior, fixed) }))
    .filter((plan): plan is { split: number; shift: number[] } => plan.shift !== undefined)
    .sort((a, b) => offSide(a.split) - offSide(b.split)
      || a.shift.reduce((sum, dx) => sum + Math.abs(dx), 0) - b.shift.reduce((sum, dx) => sum + Math.abs(dx), 0))[0];
}
/** Whether 7a reserves transit lanes for a link. A link with a course owns none: its perimeter lane stands in the crossed sub-tiers (ticket 15, Section 2); a spanning chord owns span corridors (ticket 22). */
export function ownsTransitLanes(model: LayoutModel, link: LayoutLink): boolean {
  return transitTiers(model, link).length > 0 && courseOf(model, link.id) === undefined && link.spanHint !== true;
}
/**
 * The main group of a transited tier that a corridor passes beside: the group whose nearer edge stands nearest the source x.
 * A tie goes to the group that comes first in `main` (a stable sort); 7a passes the groups left to right.
 */
export function transitedCore(main: readonly LayoutGroup[], sourceX: number): LayoutGroup | undefined {
  const reach = (group: LayoutGroup): number => Math.min(Math.abs(sourceX - group.bounds!.x), Math.abs(sourceX - right(group.bounds!)));
  return [...main].sort((a, b) => reach(a) - reach(b))[0];
}
/**
 * The side of the transited box `core` that a corridor passes on (ticket 03): the side that faces the target where placement
 * knows the target x, else the side the source x stands on. 7a and the stage-4 row order (ticket 17) call this one function.
 */
export function corridorSide(core: Rect, sourceX: number, targetX?: number): 'left' | 'right' {
  return (targetX ?? sourceX) < core.x + core.width / 2 ? 'left' : 'right';
}
/**
 * What decides the side of the corridors of a link, read once per model: the far end of each link, and whether its x may be read.
 * 7a reads the port x of the far end; the stage-4 row order (ticket 17) reads the draft centre of the far node. One reader, so the
 * two cannot disagree on which targets count.
 */
export function corridorReader(model: LayoutModel): { farEnd: (link: LayoutLink) => PortRef; target: (link: LayoutLink, tier: number) => PortRef | undefined } {
  const farEnd = (link: LayoutLink): PortRef => {
    const source = laneSource(model, link);
    return source === link.attachments!.from ? link.attachments!.to : link.attachments!.from;
  };
  const isBar = (port: PortRef) => model.document.groups[model.document.nodes[port.node]!.group]!.shape === 'bar';
  const portLoad = new Map<string, number>();
  const peerTiers = new Map<string, Set<number>>();
  for (const link of model.links) if (link.layer === 'routed' && link.attachments) {
    const ends = [link.attachments.from, link.attachments.to] as const;
    for (const end of ends) portLoad.set(portId(end), (portLoad.get(portId(end)) ?? 0) + 1);
    for (const [end, peer] of [ends, [ends[1], ends[0]] as const]) {
      if (!peerTiers.has(end.node)) peerTiers.set(end.node, new Set());
      peerTiers.get(end.node)!.add(nodeTier(model, peer.node));
    }
  }
  /**
   * Whether 7c will seat the far end under the lane as a transit feed. It reads the same two port
   * sides `feeds` reads: the run leaves the alignment end towards the far tier, and enters the far
   * port from that side. A wrapped port fails this, and its far end keeps the x it has.
   */
  const anchorTier = selectAnchorTier(model);
  const seatedByCentre = (link: LayoutLink): boolean => {
    if (anchorTier === undefined) return false;
    const parent = laneSource(model, link), child = farEnd(link);
    if ([parent, child].some(end => model.groups[model.document.nodes[end.node]!.group]!.flank)) return false;
    const below = nodeTier(model, child.node) > anchorTier;
    return findPort(model, parent)!.side === (below ? 'bottom' : 'top')
      && findPort(model, child)!.side === (below ? 'top' : 'bottom');
  };
  /**
   * The far end whose x decides the side, where placement already knows the x it will keep. The
   * target is the far end: 7c brings it under the lane, and where it cannot, the run out of the
   * lane travels to it. Five far ends have no x to read yet, and the rule that reads the target
   * takes no opinion from them: a bundle member keeps the authored source and 7e owns its geometry,
   * a bar takes its port x from the other end in 7d, a port that several links share is a fan whose
   * x 7c settles from all of its peers at once, a far end 7c seats under the lane takes the lane's
   * own x, so reading it here would only read this rule's own answer back, and a far end the
   * transited tier itself feeds travels with the groups this stage moves aside.
   */
  const target = (link: LayoutLink, tier: number): PortRef | undefined => {
    if (link.bundle || seatedByCentre(link)) return undefined;
    const far = farEnd(link);
    return isBar(far) || (portLoad.get(portId(far)) ?? 0) > 1 || peerTiers.get(far.node)!.has(tier) ? undefined : far;
  };
  return { farEnd, target };
}

/** Allocate all corridors before publishing x. Intermediate occupied margins may translate horizontally. */
export function allocateLanes(model: LayoutModel): void {
  if (model.lanes.length || model.links.some(link => link.fixedSegments)) throw new Error('Lanes can be allocated only once');
  const pending: Lane[] = [];
  // The one reader of a group's reach for this allocation: the lanes reserved so far are held lanes.
  const occ = (group: LayoutGroup, link?: LayoutLink): Rect => occupied(model, group, link, pending);
  const origins = new Map(Object.values(model.groups).map(group => [group.id, {
    x: group.bounds!.x, nodes: group.nodes.map(id => {
      const node = model.nodes[id]!;
      return { id, x: node.bounds!.x, anchors: node.ports.map(port => ({ ...port.anchor! })) };
    }),
  }]));
  // Retain the source-side order through every intermediate tier, including same-node bundles.
  // Links sharing one alignment-end anchor follow their far ends' x, so the lanes of a fan from one
  // port keep the children's row order and 7c can align every child under its own lane.
  const corridors = corridorReader(model);
  const farEnd = corridors.farEnd;
  const farX = (link: LayoutLink) => findPort(model, farEnd(link))!.anchor!.x;
  /** The x the link's target holds once placement freezes, where placement already knows it (`corridorReader`). */
  const targetX = (link: LayoutLink, tier: number): number | undefined => {
    const far = corridors.target(link, tier);
    return far === undefined ? undefined : findPort(model, far)!.anchor!.x;
  };
  const links = model.links.filter(link => ownsTransitLanes(model, link)).sort((a, b) =>
    findPort(model, laneSource(model, a))!.anchor!.x - findPort(model, laneSource(model, b))!.anchor!.x || farX(a) - farX(b) || a.sourceIndex - b.sourceIndex);
  // The alignment-end groups stay, and so does every group the lane stage's guard holds (`heldSourceGroups`): a link with a course
  // or a spanning chord owns no lane here, but its source group may not move either (ticket 17 found a plan that moved one).
  const fixedSources = fixedSourceGroups(model);
  /**
   * Move the planned groups aside, then reserve the corridor beside `group`. Subsequent reservations
   * inspect current pills, not the pre-translation measurements.
   */
  const shiftGroups = (link: LayoutLink, groups: LayoutGroup[], shifts: number[]): void => {
    const moved: string[] = [];
    for (const [index, item] of groups.entries()) {
      const dx = shifts[index]!;
      if (!dx) continue;
      moveGroup(model, item, dx, 0);
      // Repeated pushes must serialize as one exact common translation, not independently
      // accumulated floating-point sums for each anchor and its container.
      const origin = origins.get(item.id)!, totalDx = item.bounds!.x - origin.x;
      for (const old of origin.nodes) {
        const node = model.nodes[old.id]!;
        node.bounds!.x = old.x + totalDx;
        node.ports.forEach((port, i) => { port.anchor = { ...old.anchors[i]!, x: old.anchors[i]!.x + totalDx }; });
      }
      moved.push(...item.nodes);
      placementWarning(model, 'LANE_MARGIN_EXPANDED', `Expanded the occupied margin of ${item.id} for ${link.id}.`, [item.id], 'group');
    }
    if (moved.length) rebuildNodeGeometry(model, moved, 'current');
  };
  const commit = (link: LayoutLink, tier: number, groups: LayoutGroup[], group: LayoutGroup, x: number, shifts: number[]): void => {
    const source = model.nodes[laneSource(model, link).node]!, width = laneWidth(model, link), half = width / 2;
    shiftGroups(link, groups, shifts);
    if (x < source.bounds!.x || x > right(source.bounds!)) placementWarning(model, 'LANE_OUTSIDE_SOURCE_SPAN',
      `${link.id} cannot fit an in-span corridor beside existing reservations at tier ${tier}; routing must complete its attachment jog.`, [link.id]);
    pending.push({ id: laneId(link, tier), owner: { kind: 'link', id: link.id }, layer: 'routed', group: group.id, tier,
      side: x < group.bounds!.x ? 'left' : 'right', x, bounds: { x: x - half, width, ...laneExtent(model, tier) } });
  };
  /**
   * A link foreign to a frame crosses every sub-tier of it with ONE lane x, decided here once over the
   * whole frame, before any tier is allocated (ticket 04). The x stands outside the union of the frame's
   * cells (with the frame edge and the pill reach each cell reports) on the side the link's endpoints ask
   * for, so every cell of the frame is on the same side of it in every sub-tier and the link never runs
   * inside the frame. Two frames that share sub-tiers are decided together, and the lane may take the gap
   * between them. Lane x is immutable afterwards: each later move of a cell is measured against it.
   */
  const pinned = new Set<string>();
  const topFrame = (frame: string): string => {
    let id = frame;
    for (let parent = model.document.frames![id]?.parent; parent !== undefined; parent = model.document.frames![id]?.parent) id = parent;
    return id;
  };
  /**
   * A frame's held lanes are decided before the lanes foreign to it. A lane a frame holds grows the frame's
   * reach (`heldLaneReach`), and lane x is immutable, so a foreign lane reserved first may stand where the
   * frame will grow: the held lane can only stand beyond it, and the foreign lane ends inside the frame.
   * Reserved after the held lanes, the foreign lane reads them (ticket 23). The order within each part is
   * the source order of `links`; a link that holds a lane in one frame and is foreign to another is held.
   */
  const holdsLane = (link: LayoutLink): boolean => {
    const own = ownFrameCells(model, link), crossed = transitTiers(model, link);
    return Object.values(model.groups).some(group => own.has(group.id) && crossed.includes(group.tier!));
  };
  const heldLinks = new Set(links.filter(holdsLane));
  for (const link of [...links.filter(item => heldLinks.has(item)), ...links.filter(item => !heldLinks.has(item))]) {
    const crossed = transitTiers(model, link), width = laneWidth(model, link), half = width / 2;
    const cellsOf = new Map<string, LayoutGroup[]>();
    for (const group of Object.values(model.groups)) {
      const root = foreignRoot(model, group.id, link);
      if (root !== undefined) cellsOf.set(root, [...cellsOf.get(root) ?? [], group]);
    }
    const roots = [...cellsOf.entries()].map(([root, cells]) => ({
      root, cells, tiers: new Set(cells.map(cell => cell.tier!).filter(tier => crossed.includes(tier))),
    })).filter(item => item.tiers.size).sort((a, b) => Math.min(...a.tiers) - Math.min(...b.tiers));
    // Roots that share a sub-tier stand side by side in it, so one x decides them together.
    const components: (typeof roots)[] = [];
    for (const item of roots) {
      const joined = components.filter(part => part.some(other => [...item.tiers].some(tier => other.tiers.has(tier))));
      const merged = [item, ...joined.flat()];
      for (const part of joined) components.splice(components.indexOf(part), 1);
      components.push(merged);
    }
    const sx = findPort(model, laneSource(model, link))!.anchor!.x;
    for (const component of components) {
      const tiers = [...new Set(component.flatMap(item => [...item.tiers]))].sort((a, b) => crossed.indexOf(a) - crossed.indexOf(b));
      // Left to right. `bound` is the extent that keeps a root clear of the lane where it stands now;
      // `fixed` is the part of it in sub-tiers the link does not cross, which no plan can move.
      const ordered = component.map(item => {
        const boxes = item.cells.map(cell => occ(cell, link));
        const fixed = item.cells.filter(cell => !tiers.includes(cell.tier!)).map(cell => occ(cell, link));
        return {
          item, centre: (Math.min(...boxes.map(box => box.x)) + Math.max(...boxes.map(box => right(box)))) / 2,
          low: Math.min(...boxes.map(box => box.x)), high: Math.max(...boxes.map(box => right(box))),
          fixedLow: Math.min(...fixed.map(box => box.x)), fixedHigh: Math.max(...fixed.map(box => right(box))),
        };
      }).sort((a, b) => a.centre - b.centre);
      const rootOf = new Map(ordered.flatMap((entry, index) => entry.item.cells.map(cell => [cell.id, index] as const)));
      const desire = tiers.map(tier => targetX(link, tier)).find(value => value !== undefined) ?? sx;
      /**
       * A lane a frame holds stays on that frame's side of every frame the link is foreign to (ticket 26). The
       * held lane makes its own frame grow to it, so a lane beyond a foreign frame would grow the frame across
       * that frame, and the lane of a link foreign to the grown frame would then stand inside it; two frames
       * that hold crossed links do this to each other, and no order of the lanes decides it. The own frame
       * stands between the foreign roots in one place, so the lane takes the one gap that keeps it there.
       * A link that holds no lane in a cell of these sub-tiers keeps the side its far end asks for.
       */
      const rootCells = new Set(ordered.flatMap(entry => entry.item.cells.map(cell => cell.id))), ownCells = ownFrameCells(model, link);
      const heldBoxes = Object.values(model.groups).filter(group => ownCells.has(group.id) && !rootCells.has(group.id) && tiers.includes(group.tier!)).map(group => occ(group, link));
      const heldCentre = heldBoxes.length ? (Math.min(...heldBoxes.map(box => box.x)) + Math.max(...heldBoxes.map(box => right(box)))) / 2 : undefined;
      const heldGap = heldCentre === undefined ? undefined : ordered.filter(entry => entry.centre < heldCentre).length;
      const wanted = heldGap ?? ordered.filter(entry => entry.centre < desire).length;
      // Every cell of a root before `gap` stands left of the lane and every cell of the others right of it;
      // a group of no root takes the side of its centre. The left groups must be a prefix of the tier.
      const plan = (tier: number, x: number, gap: number) => {
        const groups = Object.values(model.groups).filter(group => group.tier === tier).sort((a, b) => a.bounds!.x - b.bounds!.x);
        const isLeft = (group: LayoutGroup): boolean => rootOf.has(group.id) ? rootOf.get(group.id)! < gap : group.bounds!.x + group.bounds!.width / 2 < x;
        const split = groups.filter(isLeft).length;
        const prior = pending.filter(lane => lane.tier === tier);
        return { groups, shifts: groups.slice(0, split).every(isLeft) ? marginTranslations(group => occ(group, link), groups, split, x, width, prior, fixedSources, true) : undefined };
      };
      // A lane that stands clear of every root where it is now moves no cell of the frame. Where the gap
      // is too narrow the plan may push the cells of a crossed sub-tier aside to open it, as it does for
      // plain groups, but only by what opening a corridor between two abutting boxes takes: the lane and
      // the frame margin on each side. A larger push would carry a frame away from the lane's source
      // instead of opening a gap, so the lane stands beyond that frame. The cells of the other sub-tiers
      // bound the plan. Among the gaps the endpoints ask for, the lane nearest its source wins (a corridor
      // under its source avoids an approach jog), then the plan that moves the fewest cells.
      const own = ownFrameCells(model, link);
      const ownBoxes = Object.values(model.groups).filter(group => own.has(group.id) && tiers.includes(group.tier!)).map(group => occ(group, link));
      const opening = width + 2 * GROUP_PADDING;
      const candidates = [false, true].flatMap(open => Array.from({ length: ordered.length + 1 }, (_, gap) => {
        const [before, after] = [ordered.slice(0, gap), ordered.slice(gap)];
        const low = Math.max(-Infinity, ...before.map(entry => open ? entry.fixedHigh : entry.high)) + half;
        const high = Math.min(Infinity, ...after.map(entry => open ? entry.fixedLow : entry.low)) - half;
        return { gap, low, high };
      }).filter(item => item.low <= item.high && (heldGap === undefined || item.gap === heldGap)).flatMap(item => {
        // Beside the source, or beside a cell of the link's own frame that stands in the way: such a cell
        // is not moved (ticket 09), so the lane takes the free side of it inside the frame's column.
        const clamp = (value: number): number => Math.min(Math.max(value, item.low), item.high);
        // Or beside a corridor already reserved in a crossed sub-tier: the gap holds several lanes side by side.
        const stacked = pending.filter(lane => tiers.includes(lane.tier)).flatMap(lane => [lane.x - (width + lane.bounds.width) / 2, lane.x + (width + lane.bounds.width) / 2]);
        const xs = [...new Set([sx, ...ownBoxes.flatMap(box => [box.x - half, right(box) + half]), ...stacked].map(clamp))];
        return xs.map(x => ({ ...item, x }));
      })).map(item => {
        const plans = tiers.map(tier => plan(tier, item.x, item.gap));
        const shifts = plans.flatMap(entry => entry.shifts ?? []);
        // One dx for every cell of a frame root, the cells of the sub-tiers the link does not cross
        // included: a plan that moves some of them and not the others is refused.
        const dxOf = new Map<string, number[]>();
        for (const entry of plans) for (const [at, group] of (entry.shifts ? entry.groups : []).entries()) {
          if (group.frame !== undefined) dxOf.set(topFrame(group.frame), [...dxOf.get(topFrame(group.frame)) ?? [], entry.shifts![at]!]);
        }
        const rigid = [...dxOf.entries()].every(([frame, list]) => list.every(dx => Math.abs(dx - list[0]!) <= PLACEMENT_EPS)
          && (Math.abs(list[0]!) <= PLACEMENT_EPS || list.length === Object.values(model.groups).filter(group => group.frame !== undefined && topFrame(group.frame) === frame).length));
        const feasible = plans.every(entry => entry.shifts !== undefined) && rigid && shifts.every(dx => Math.abs(dx) <= opening + PLACEMENT_EPS);
        return { ...item, feasible, offset: Math.abs(item.x - sx), moved: shifts.reduce((sum, dx) => sum + Math.abs(dx), 0) };
      }).filter(item => item.feasible).sort((a, b) => Math.abs(a.gap - wanted) - Math.abs(b.gap - wanted) || a.offset - b.offset || a.moved - b.moved);
      const chosen = candidates[0];
      let x: number, planned: ReturnType<typeof plan>[];
      if (chosen) { x = chosen.x; planned = tiers.map(tier => plan(tier, x, chosen.gap)); }
      else {
        // No gap takes the lane without crossing a source or an earlier corridor: stand beyond every
        // group and corridor of these sub-tiers, on the side the endpoints ask for.
        const every = tiers.flatMap(tier => Object.values(model.groups).filter(group => group.tier === tier));
        const lanesHere = pending.filter(lane => tiers.includes(lane.tier));
        const left = Math.min(...every.map(group => occ(group, link).x), ...lanesHere.map(lane => lane.bounds.x)) - half;
        const rightX = Math.max(...every.map(group => right(occ(group, link))), ...lanesHere.map(lane => right(lane.bounds))) + half;
        x = wanted * 2 <= ordered.length ? left : rightX;
        planned = tiers.map(tier => ({ groups: Object.values(model.groups).filter(group => group.tier === tier).sort((a, b) => a.bounds!.x - b.bounds!.x), shifts: undefined }));
      }
      for (const [index, tier] of tiers.entries()) {
        const { groups, shifts } = planned[index]!;
        const mine = component.flatMap(item => item.cells).filter(cell => cell.tier === tier);
        const near = (group: LayoutGroup): number => Math.abs(x - (group.bounds!.x + group.bounds!.width / 2));
        // A lane of a link that ends in a frame is hosted in a cell of that frame, so `transitLanes` grows the
        // frame to hold it; a cell of a neighbour frame would leave the frame without it. The lane stands
        // outside that cell (`validateLanes`), so only a cell the lane x is not inside can host it.
        const own = ownFrameCells(model, link);
        const outside = (group: LayoutGroup): boolean => {
          const dx = shifts?.[groups.indexOf(group)] ?? 0;
          return x < group.bounds!.x + dx || x > right(group.bounds!) + dx;
        };
        const ownHosts = Object.values(model.groups).filter(group => group.tier === tier && own.has(group.id) && outside(group));
        const host = [...ownHosts.length ? ownHosts : mine.length ? mine : groups].sort((a, b) => near(a) - near(b))[0]!;
        commit(link, tier, groups, host, x, shifts ?? groups.map(() => 0));
        pinned.add(laneId(link, tier));
      }
    }
  }
  for (const tier of model.tierBands.map(band => band.tier)) {
    const groups = Object.values(model.groups).filter(group => group.tier === tier).sort((a, b) => a.bounds!.x - b.bounds!.x);
    const main = groups.filter(group => !group.flank);
    const tierLinks = links.filter(link => transitTiers(model, link).includes(tier) && !pinned.has(laneId(link, tier)));
    for (const [index, link] of tierLinks.entries()) {
      const sx = findPort(model, laneSource(model, link))!.anchor!.x;
      const width = laneWidth(model, link), half = width / 2;
      const reservedEntry = (model.reservations ?? []).find(entry => entry.kind === 'corridorSide'
        && entry.payload.link === link.id && entry.payload.tier === tier);
      const reservedHost = reservedEntry?.kind === 'corridorSide' ? groups.find(g => g.id === reservedEntry.payload.group) : undefined;
      const nearest = reservedHost ?? transitedCore(main, sx) ?? groups[0]!;
      const core = occ(nearest, link);
      // A corridor passes its tier on the side of the transited group that faces the link's target
      // (ticket 03), so the run leaves the tier already on the side its far end stands on. Where the
      // target has no x to read, the corridor keeps the side the source asks for (`corridorSide`).
      const target = targetX(link, tier);
      const reservedSide = reservedEntry?.kind === 'corridorSide' ? reservedEntry.payload.side : corridorSideOf(model.reservations, link.id, tier, nearest.id);
      const side = reservedSide ?? (target === undefined ? undefined : corridorSide(core, sx, target));
      const prefSide = reservedSide ?? corridorSide(core, sx);
      let x = prefSide === 'left' ? Math.min(sx, core.x - half) : Math.max(sx, right(core) + half);
      // Reserve in transported source order. Previous corridors are immutable even during planning.
      const prior = pending.filter(lane => lane.tier === tier);
      if (reservedSide === undefined) {
        for (const lane of prior) if (Math.abs(x - lane.x) < (width + lane.bounds.width) / 2) {
          x = lane.x + (width + lane.bounds.width) / 2;
        }
      } else {
        const dir = reservedSide === 'left' ? -1 : 1;
        for (let pass = 0, moved = true; moved && pass <= prior.length; pass++) {
          moved = false;
          for (const lane of prior) if (Math.abs(x - lane.x) < (width + lane.bounds.width) / 2 - PLACEMENT_EPS) {
            x = lane.x + dir * (width + lane.bounds.width) / 2;
            moved = true;
          }
        }
      }
      // A corridor directly below its source avoids an approach jog. Before ownership freezes,
      // move intermediate groups aside where that preserves prior corridors and source groups.
      // An insertion gap that leaves the transited group on the target side is taken first; a plan
      // on the other side is taken only where the target side has none (and never against a stage-4 side reservation).
      const at = groups.indexOf(nearest);
      const plan = directPlan(group => occ(group, link), groups, at, side, sx, width, prior, fixedSources);
      const direct = plan !== undefined && (reservedSide === undefined || (reservedSide === 'left' ? plan.split <= at : plan.split > at))
        ? plan.shift : undefined;
      let shifts: number[] | undefined;
      if (direct) { x = sx; shifts = direct; }
      else {
        // Prefer a full in-span allocation for the remaining same-source members when it fits.
        const slot = inSpanSlot(model, link, core, width, prior, tierLinks.slice(index));
        if (slot !== undefined && (reservedSide === undefined || (reservedSide === 'left' ? slot <= core.x - half + PLACEMENT_EPS : slot >= right(core) + half - PLACEMENT_EPS))) {
          x = slot;
        }
        // If exterior packing crossed the main group, take the margin the target side asks for.
        if (x + half > core.x && x - half < right(core)) x = side === 'left' ? core.x - half : right(core) + half;
        const split = at + (reservedSide !== undefined ? (reservedSide === 'right' ? 1 : 0) : (x > right(core) ? 1 : 0));
        shifts = marginTranslations(group => occ(group, link), groups, split, x, width, prior, fixedSources);
      }
      if (!shifts) {
        // A source or earlier corridor blocks propagation. An exterior corridor needs no movement.
        const left = Math.min(...groups.map(group => occ(group, link).x), ...prior.map(lane => lane.bounds.x)) - half;
        const rightX = Math.max(...groups.map(group => right(occ(group, link))), ...prior.map(lane => right(lane.bounds))) + half;
        x = side === undefined ? (Math.abs(left - sx) <= Math.abs(rightX - sx) ? left : rightX) : side === 'left' ? left : rightX;
        shifts = groups.map(() => 0);
      }
      commit(link, tier, groups, nearest, x, shifts);
    }
  }
  // The side lanes are placed against the frames as the transit lanes leave them: `commit` moved groups and `transitLanes` grows a frame for a
  // held lane, so the boxes read at this point are rebuilt from the published lanes first (a document with no candidate keeps its old order).
  if (model.links.some(link => sideLaneCandidate(model, link) !== undefined) || (model.courses ?? []).some(course => !isApproachCourse(course))) {
    model.lanes = pending;
    rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
    rebuildRegions(model);
  }
  reserveSpanCorridors(model, pending, occ, shiftGroups);
  reserveSideLanes(model, pending, occ);
  reserveCourseLanes(model, pending, occ);
  reserveGapLanes(model, pending, occ);
  reserveRisers(model, pending, occ);
  reserveTrunks(model, pending, occ);
  model.lanes = pending;
  // A transit lane fixes the planned first turn of its source port; in a turn-ordered run the ports of that face take the turn order (ticket 24, Section 4).
  if (model.turnOrder === true) orderPortsByLanes(model);
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
  rebuildRegions(model);
  rebuildLaneExtents(model);
}
/**
 * Stage 7a, after the transit lanes: the span corridors of the spanning chords (architecture ticket 22, docs/design/routed-chords.md, Section 14.3). One corridor per transited
 * band of each hinted link, in link order. The units of the band that stand in a corridor move out of it by the push of `marginTranslations` (a frame cell, a source of a
 * lane and a lane already reserved are not pushed); a corridor that cannot be opened refuses the placement run (`SpanRefusal`), so that no later stage discovers it. Two
 * corridors may overlap each other (two chords cross), but never a unit or another kind of lane: that is checked once all are reserved.
 */
function reserveSpanCorridors(model: LayoutModel, pending: Lane[], occ: (group: LayoutGroup, link?: LayoutLink) => Rect,
  shift: (link: LayoutLink, groups: LayoutGroup[], shifts: number[]) => void): void {
  for (const link of model.links) {
    if (link.spanHint !== true) continue;
    for (const tier of transitTiers(model, link)) {
      const box = spanCorridor(model, link, tier);
      if (box === undefined) throw new SpanReservationRefusal(`The chord of ${link.id} does not reach the band of tier ${tier}`);
      const x = box.x + box.width / 2, width = box.width;
      const groups = Object.values(model.groups).filter(group => group.tier === tier).sort((a, b) => a.bounds!.x - b.bounds!.x);
      // A unit left of the corridor stays left of it, and a unit right of it right; a unit it crosses takes the side of its centre.
      const isLeft = (group: LayoutGroup): boolean => {
        const reach = spanWall(model, group, link);
        return right(reach) <= box.x + PLACEMENT_EPS || (reach.x < right(box) - PLACEMENT_EPS && reach.x + reach.width / 2 < x);
      };
      const split = groups.filter(isLeft).length;
      const prior = pending.filter(lane => lane.tier === tier && !isSpanLane(lane));
      // The groups the lane-stage guard holds (`heldSourceGroups`) do not move here either: a push of one is refused as the
      // corridor that cannot be opened, not thrown by the guard later (ticket 17 found a span trial that pushed one).
      const shifts = groups.slice(0, split).every(isLeft) ? marginTranslations(group => spanWall(model, group, link), groups, split, x, width, prior, heldSourceGroups(model), false, true) : undefined;
      if (shifts === undefined) throw new SpanReservationRefusal(`The corridor of ${link.id} cannot be opened in tier ${tier}: a unit or a lane stands in it and cannot move aside`);
      shift(link, groups, shifts);
      const host = [...groups].sort((a, b) => Math.abs(x - (a.bounds!.x + a.bounds!.width / 2)) - Math.abs(x - (b.bounds!.x + b.bounds!.width / 2)))[0]!;
      const moved = spanCorridor(model, link, tier);
      if (moved === undefined) throw new SpanReservationRefusal(`The chord of ${link.id} left the band of tier ${tier} when its units moved`);
      const mx = moved.x + moved.width / 2;
      pending.push({ id: spanLaneId(link.id, tier), kind: 'span', owner: { kind: 'link', id: link.id }, layer: 'routed', group: host.id, tier,
        side: mx < host.bounds!.x ? 'left' : 'right', x: mx, bounds: { x: mx - moved.width / 2, width: moved.width, y: moved.y, height: moved.height } });
    }
  }
  // A corridor stands in no unit of its band, and in no lane that is not a corridor.
  for (const lane of pending.filter(isSpanLane)) {
    for (const group of Object.values(model.groups)) {
      if (group.tier !== lane.tier || group.bounds === undefined || !group.nodes.length) continue;
      const box = spanWall(model, group, laneLink(model, lane)!);
      if (box.x < right(lane.bounds) - PLACEMENT_EPS && right(box) > lane.bounds.x + PLACEMENT_EPS) throw new SpanReservationRefusal(`${lane.id} crosses the unit ${group.id}`);
    }
    for (const other of pending) {
      if (other === lane || other.tier !== lane.tier || isSpanLane(other)) continue;
      if (other.bounds.x < right(lane.bounds) - PLACEMENT_EPS && right(other.bounds) > lane.bounds.x + PLACEMENT_EPS) throw new SpanReservationRefusal(`${lane.id} crosses the lane ${other.id}`);
    }
  }
}
/** The stem a side run keeps at least (spec Section 10: the side run is the port's stem). */
const SIDE_RUN_STEM = 15;
/** Whether a port sits at the mesh bus it belongs to; a bus port is never a candidate (Section 4). */
const onMeshBus = (model: LayoutModel, ref: PortRef): boolean => (model.meshBuses ?? []).some(bus => bus.ports.some(port => portId(port) === portId(ref)));
/**
 * The lateral port of `link` that may take a side lane (docs/design/side-faces.md, Sections 4 and 10), or `undefined`: a routed link, not a stub,
 * bundle member, mesh-bus link or group-link collapse, with no transit lane; one end on a lateral side (hinted or authored) that carries this
 * link alone, the other on the facing top or bottom side of another sub-tier; neither end in a bar group or a flank, the lateral node not in a grid.
 */
export function sideLaneCandidate(model: LayoutModel, link: LayoutLink): PortRef | undefined {
  if (link.layer !== 'routed' || link.technique === 'stub' || link.bundle !== undefined || link.meshBus !== undefined
    || link.groupLink !== undefined || !link.attachments || transitTiers(model, link).length || courseOf(model, link.id) !== undefined) return undefined;
  const ends = [link.attachments.from, link.attachments.to] as const;
  if (ends[0].node === ends[1].node) return undefined;
  const lateral = ends.filter(end => { const side = findPort(model, end)?.side; return side === 'left' || side === 'right'; });
  if (lateral.length !== 1) return undefined;
  const port = lateral[0]!, far = ends.find(end => end !== port)!;
  const [portTier, farTier] = [nodeTier(model, port.node), nodeTier(model, far.node)];
  if (portTier === farTier || findPort(model, far)?.side !== (farTier < portTier ? 'bottom' : 'top')) return undefined;
  if (!findPort(model, port)?.anchor || !findPort(model, far)?.anchor) return undefined;
  if (ends.some(end => groupShape(model, model.document.nodes[end.node]!.group) === 'bar' || model.groups[model.document.nodes[end.node]!.group]?.flank !== undefined)) return undefined;
  if (groupShape(model, model.document.nodes[port.node]!.group) === 'grid' || ends.some(end => onMeshBus(model, end))) return undefined;
  // A hinted lateral port whose link is a routed chord candidate (ticket 117) has the chord as its reserved path, not a side lane: the lane is
  // for the one-bend shape. Both would claim one link, and the route would drop the lane's reserved segments.
  if (findPort(model, port)?.sideHint === true && chordKind(model, link) !== undefined) return undefined;
  const carried = model.links.filter(item => item.attachments && [item.attachments.from, item.attachments.to].some(end => portId(end) === portId(port)));
  return carried.length === 1 ? port : undefined;
}
/** Whether no node of the port's group in its row stands beyond it on the port's side (spec Section 10: the outermost node of its row). */
export function outermostOfRow(model: LayoutModel, port: PortRef): boolean {
  const side = findPort(model, port)!.side, box = model.nodes[port.node]!.bounds!;
  const group = model.groups[model.document.nodes[port.node]!.group]!;
  return group.nodes.every(id => {
    const other = model.nodes[id]!.bounds!;
    if (id === port.node || other.y >= bottom(box) - PLACEMENT_EPS || bottom(other) <= box.y + PLACEMENT_EPS) return true;
    return side === 'right' ? other.x < right(box) - PLACEMENT_EPS : right(other) > box.x + PLACEMENT_EPS;
  });
}
/**
 * Why a side lane cannot stand at `x` for the lateral `port` of `link`, or `undefined` when it can. The side run at the port's y must cross
 * nothing (`body`, `frame`, `lane`); the vertical run must stand outside the node's group and frames on the port's side, clear of every group
 * and lane of the sub-tier (`corridor`).
 */
function sideLaneRefusal(model: LayoutModel, link: LayoutLink, port: PortRef, x: number, pending: readonly Lane[], occ: (group: LayoutGroup, link?: LayoutLink) => Rect): string | undefined {
  const lateral = findPort(model, port)!, anchor = lateral.anchor!, dir = lateral.side === 'right' ? 1 : -1;
  const width = laneWidth(model, link), half = width / 2, group = model.groups[model.document.nodes[port.node]!.group]!;
  const own = occ(group, link), holding = (model.frames ?? []).filter(frame => frameNodes(model, frame.id).includes(port.node));
  const inner = dir > 0 ? Math.max(right(own), ...holding.map(frame => right(frame.box))) : Math.min(own.x, ...holding.map(frame => frame.box.x));
  if (dir > 0 ? x - half < inner - PLACEMENT_EPS : x + half > inner + PLACEMENT_EPS) return 'corridor';
  if (Math.abs(x - anchor.x) < SIDE_RUN_STEM + routedStrokeWidth(model) / 2) return 'corridor';
  // The side run, from the face to the lane centre, at the port's y.
  const reach = routedStrokeWidth(model) / 2, span = { x: Math.min(anchor.x, x), width: Math.abs(x - anchor.x), y: anchor.y - reach, height: 2 * reach };
  const across = (box: Rect): boolean => box.x < right(span) - PLACEMENT_EPS && right(box) > span.x + PLACEMENT_EPS && box.y < bottom(span) - PLACEMENT_EPS && bottom(box) > span.y + PLACEMENT_EPS;
  for (const node of Object.values(model.nodes)) {
    if (node.id === port.node) continue;
    if (across(node.bounds!) || node.ports.some(item => item.pill !== undefined && across(item.pill.bounds))) return 'body';
  }
  for (const other of Object.values(model.groups)) {
    if (other.id === group.id || other.tier !== group.tier || other.bounds === undefined) continue;
    if (across({ ...occ(other, link), y: other.bounds.y, height: other.bounds.height })) return other.frame !== undefined ? 'frame' : 'body';
  }
  for (const frame of model.frames ?? []) if (!holding.includes(frame) && across(frame.box)) return 'frame';
  for (const lane of pending) if (across(lane.bounds)) return 'lane';
  // The vertical run.
  for (const other of Object.values(model.groups)) {
    if (other.tier !== group.tier || other.bounds === undefined) continue;
    const box = occ(other, link);
    if (box.x < x + half - PLACEMENT_EPS && right(box) > x - half + PLACEMENT_EPS) return 'corridor';
  }
  for (const lane of pending) if (lane.tier === group.tier && Math.abs(lane.x - x) < (lane.bounds.width + width) / 2 - PLACEMENT_EPS) return 'lane';
  return undefined;
}
function pickSideLane(model: LayoutModel, link: LayoutLink, port: PortRef, pending: readonly Lane[], occ: (group: LayoutGroup, link?: LayoutLink) => Rect, alignedOnly = false): { x: number } | { why: string } {
  if (!outermostOfRow(model, port)) return { why: 'body' };
  const lateral = findPort(model, port)!, dir = lateral.side === 'right' ? 1 : -1;
  const group = model.groups[model.document.nodes[port.node]!.group]!, half = laneWidth(model, link) / 2;
  const far = portId(link.attachments!.from) === portId(port) ? link.attachments!.to : link.attachments!.from;
  const farX = findPort(model, far)!.anchor!.x;
  // The corridors that stand beyond the node's group and frames on the port's side: the edges of every box and lane of the sub-tier.
  const edges = new Set<number>();
  const add = (edge: number): void => { edges.add(edge + dir * half); };
  // The far edge of each box (the lane stands beyond it) and its near edge (the lane stands in the gap before it).
  const addBox = (box: Rect): void => { add(dir > 0 ? right(box) : box.x); edges.add((dir > 0 ? box.x : right(box)) - dir * half); };
  for (const other of Object.values(model.groups)) if (other.tier === group.tier && other.bounds !== undefined) addBox(occ(other, link));
  for (const frame of model.frames ?? []) addBox(frame.box);
  for (const lane of pending) if (lane.tier === group.tier) addBox(lane.bounds);
  const own = occ(group, link);
  const inner = dir > 0 ? right(own) : own.x;
  const exterior = [...edges].filter(x => dir * (x - (inner + dir * half)) >= -PLACEMENT_EPS).sort((a, b) => Math.abs(a - farX) - Math.abs(b - farX) || dir * (a - b));
  const aligned = dir * (farX - inner) >= half - PLACEMENT_EPS;
  const tries = alignedOnly ? (aligned ? [farX] : []) : aligned ? [farX, ...exterior.filter(x => Math.abs(x - farX) > PLACEMENT_EPS)] : exterior;
  let first: string | undefined;
  for (const x of tries) {
    const why = sideLaneRefusal(model, link, port, x, pending, occ);
    if (why === undefined) return { x };
    // The reason that blocks is the first that names something in the way; `corridor` only says a window did not fit.
    if (first === undefined || first === 'corridor') first = why;
  }
  return { why: first ?? 'corridor' };
}
/** The side lane of `link` into its lateral `port` at `x`, extent read from the port's anchor now. */
function buildSideLane(model: LayoutModel, link: LayoutLink, port: PortRef, x: number): Lane {
  const lateral = findPort(model, port)!, group = model.groups[model.document.nodes[port.node]!.group]!, half = laneWidth(model, link) / 2;
  const far = portId(link.attachments!.from) === portId(port) ? link.attachments!.to : link.attachments!.from;
  const farX = findPort(model, far)!.anchor!.x;
  const lane: Lane = { id: sideLaneId(link), owner: { kind: 'link', id: link.id }, layer: 'routed', group: group.id, tier: group.tier!,
    side: lateral.side as 'left' | 'right', kind: 'side', port: { ...port }, ...(Math.abs(x - farX) <= PLACEMENT_EPS ? { aligned: true as const } : {}), x, bounds: { x: x - half, width: 2 * half, y: 0, height: 0 } };
  Object.assign(lane.bounds, sideLaneExtent(model, lane, link));
  return lane;
}
/**
 * The source-aligned side lane of `link` into its lateral `port` on `model`, or undefined when its corridor is not clear (ticket 119, the side
 * round's probe). It runs the allocation's own test at the far port's x only, with `extra` (the lanes the round accepted earlier) added to the
 * model's lanes. The lane it returns is not added to the model.
 */
export function probeSideLane(model: LayoutModel, link: LayoutLink, port: PortRef, extra: readonly Lane[] = []): Lane | undefined {
  const pending = [...model.lanes, ...extra];
  const picked = pickSideLane(model, link, port, pending, (group, item) => occupied(model, group, item, pending), true);
  return 'x' in picked ? buildSideLane(model, link, port, picked.x) : undefined;
}
/**
 * Stage 7a, after the transit lanes: a side lane for each routed lateral port (hinted or authored) whose peer is on another sub-tier
 * (spec Section 10, decision 4). The source-aligned corridor is tried first (the far port's x), then the nearest clear exterior corridor.
 * Nothing moves: a candidate whose corridor is not clear gets no lane and stays residual (`SIDE_LANE_REFUSED`, info, with the reason).
 */
function reserveSideLanes(model: LayoutModel, pending: Lane[], occ: (group: LayoutGroup, link?: LayoutLink) => Rect): void {
  for (const link of model.links) {
    const port = sideLaneCandidate(model, link);
    if (port === undefined) continue;
    const picked = pickSideLane(model, link, port, pending, occ);
    if (!('x' in picked)) {
      model.diagnostics.push({ stage: 'placement', severity: 'info', code: 'SIDE_LANE_REFUSED', owners: [{ kind: 'link', id: link.id }],
        message: `${link.id} has a lateral port and no side lane (${picked.why}); the link stays residual.` });
      continue;
    }
    pending.push(buildSideLane(model, link, port, picked.x));
  }
}
/**
 * Stage 7a, after the side lanes: the perimeter lane of each course (ticket 15). The id, owner, side, ring and span are fixed here; the x is derived at the
 * replay that follows (`rebuildLaneExtents`). Rings are taken in course order: a lane stands outside every earlier lane of its side whose extent it meets.
 */
function reserveCourseLanes(model: LayoutModel, pending: Lane[], occ: (group: LayoutGroup, link?: LayoutLink) => Rect): void {
  const placed: Lane[] = [];
  for (const course of model.courses ?? []) {
    if (isGapCourse(course) || isApproachCourse(course) || isBypassCourse(course)) continue;
    const link = model.links.find(item => item.id === course.link);
    if (link?.attachments === undefined || course.side === undefined) throw new Error(`Course on ${course.link} cannot reserve a perimeter lane`);
    const draft: LaneDraft = { id: perimeterLaneId(link.id), side: course.side, ring: 0, ...(endHasNaturalFace(course) ? { aligned: true as const } : {}) };
    const geometry = (ring: number) => courseGeometry(model, link, course, { ...draft, ring }, (group, item) => occ(group, item), ringsOf(placed), placed);
    const first = geometry(0);
    if (first === undefined) throw new CourseRefusal(`The course of ${link.id} cannot join one lane`);
    const ring = placed.filter(lane => lane.side === course.side && lane.bounds.y < bottom(first.bounds) - PLACEMENT_EPS && bottom(lane.bounds) > first.bounds.y + PLACEMENT_EPS).length;
    const used = ring === 0 ? first : geometry(ring)!;
    const host = model.groups[model.document.nodes[used.upper.ref.node]!.group]!;
    const lane: Lane = { id: draft.id, kind: 'perimeter', owner: { kind: 'link', id: link.id }, layer: link.layer === 'overlay' ? 'overlay' : 'routed', group: host.id, tier: host.tier!, side: course.side,
      span: used.span, ring, ...(draft.aligned === true ? { aligned: true as const } : {}), x: used.x, bounds: { ...used.bounds } };
    placed.push(lane);
    pending.push(lane);
  }
}
/**
 * Stage 7a, after the perimeter lanes: the column-gap lane of each gap course (ticket 15, phase 5). The lateral end keeps its face; the lane stands in the
 * free column beside its unit, between it and the nearest unit, frame or lane on that side, at the centre of the column. Its x, id, owner, side and span are
 * fixed here. A column that is too narrow, or a side run that crosses a body, refuses the course (nothing moves for a course, P9; a column that has to
 * open is a later phase).
 */
function reserveGapLanes(model: LayoutModel, pending: Lane[], occ: (group: LayoutGroup, link?: LayoutLink) => Rect): void {
  for (const course of model.courses ?? []) {
    if (isBypassCourse(course)) {
      // The two stems of a row bypass: each at the centre of the gap beside its end (ticket 24, phase 5).
      const link = model.links.find(item => item.id === course.link);
      if (link === undefined) throw new CourseRefusal(`Course on ${course.link} cannot reserve a bypass`);
      const admitted = admitBypassLanes(model, link, course, pending, laneWidth(model, link));
      if ('why' in admitted) throw new CourseRefusal(admitted.why);
      pending.push(...admitted.lanes);
      continue;
    }
    if (!isGapCourse(course)) continue;
    const link = model.links.find(item => item.id === course.link);
    if (link === undefined) throw new CourseRefusal(`Course on ${course.link} cannot reserve a column-gap lane`);
    const admitted = admitGapLane(model, link, course, pending, occ);
    if ('why' in admitted) throw new CourseRefusal(admitted.why);
    pending.push(admitted.lane);
  }
}
/**
 * The admission test of a column-gap lane, the one 7a and the course offer both call: the lane of `course` for `link` on `model`, standing in the centre of
 * the free column beside its lateral end (between the unit with the frames that hold it and the nearest box, frame or lane of the band), or the reason it
 * cannot. `pending` is the lanes already reserved, `occ` the occupied box of a group for the link.
 */
export function admitGapLane(model: LayoutModel, link: LayoutLink, course: Course, pending: readonly Lane[], occ: (group: LayoutGroup, link?: LayoutLink) => Rect): { lane: Lane } | { why: string } {
  const ends = gapEnds(course);
  if (link.attachments === undefined || ends === undefined) return { why: `Course on ${course.link} cannot reserve a column-gap lane` };
  // A gap course joins two ends of one band; a link across bands has its own lanes (transit, side, perimeter).
  if (nodeTier(model, link.attachments[ends.lateral].node) !== nodeTier(model, link.attachments[ends.u].node)) return { why: `The ends of ${link.id} stand in two bands, and a column-gap course joins the ends of one` };
  const port = link.attachments[ends.lateral], lateral = findPort(model, port);
  if (lateral?.anchor === undefined || (lateral.side !== 'left' && lateral.side !== 'right') || !outermostOfRow(model, port)) return { why: `The lateral end of ${link.id} does not face a free column` };
  const dir = lateral.side === 'right' ? 1 : -1, width = laneWidth(model, link), half = width / 2;
  const group = model.groups[model.document.nodes[port.node]!.group]!, own = occ(group, link);
  const holding = (model.frames ?? []).filter(frame => frameNodes(model, frame.id).includes(port.node));
  const inner = dir > 0 ? Math.max(right(own), ...holding.map(frame => right(frame.box))) : Math.min(own.x, ...holding.map(frame => frame.box.x));
  const band = model.tierBands.find(item => item.tier === group.tier)?.bounds;
  if (band === undefined) return { why: `Tier ${group.tier} has no band` };
  // The boxes of the band that stand on the lane's side of the unit: groups, the frames that hold none of its nodes, and the lanes already reserved.
  const meets = (box: Rect): boolean => box.y < bottom(band) - PLACEMENT_EPS && bottom(box) > band.y + PLACEMENT_EPS;
  const boxes: Rect[] = [];
  for (const other of Object.values(model.groups)) if (other.id !== group.id && other.tier === group.tier && other.bounds !== undefined && other.nodes.length > 0) boxes.push(occ(other, link));
  for (const frame of model.frames ?? []) if (!holding.includes(frame) && meets(frame.box)) boxes.push(frame.box);
  for (const lane of pending) if (lane.tier === group.tier) boxes.push(lane.bounds);
  const beyond = boxes.filter(box => dir > 0 ? box.x >= inner - PLACEMENT_EPS : right(box) <= inner + PLACEMENT_EPS);
  if (beyond.length === 0) return { why: `No unit stands beside the lateral end of ${link.id}: the column is the perimeter's` };
  const limit = dir > 0 ? Math.min(...beyond.map(box => box.x)) : Math.max(...beyond.map(box => right(box)));
  if (Math.abs(limit - inner) < width - PLACEMENT_EPS) return { why: `The column beside the lateral end of ${link.id} is ${Math.abs(limit - inner).toFixed(1)} px wide, the lane needs ${width.toFixed(1)}` };
  const x = (limit + inner) / 2;
  const why = sideLaneRefusal(model, link, port, x, pending, occ);
  if (why !== undefined) return { why: `The lane of ${link.id} cannot stand in the column beside its lateral end (${why})` };
  const lane: Lane = { id: gapLaneId(link.id), kind: 'gap', owner: { kind: 'link', id: link.id }, layer: 'routed', group: group.id, tier: group.tier!, side: lateral.side,
    port: { ...port }, span: { top: group.tier!, bottom: group.tier! }, x, bounds: { x: x - half, width, y: 0, height: 0 } };
  const geometry = gapGeometry(model, link, course);
  if (geometry === undefined) return { why: `The lane of ${link.id} has no extent` };
  Object.assign(lane.bounds, geometry.extent);
  return { lane };
}
/** The offer's filter for a bypass: the same admission on a placed model with the course standing, and the lanes it holds but this link's own. */
export function probeBypassLanes(model: LayoutModel, link: LayoutLink, course: Course, extra: readonly Lane[] = []): { lanes: Lane[] } | { why: string } {
  const pending = [...model.lanes.filter(lane => !(lane.owner.kind === 'link' && lane.owner.id === link.id)), ...extra];
  return admitBypassLanes({ ...model, courses: [...(model.courses ?? []).filter(item => item.link !== course.link), course] }, link, course, pending, laneWidth(model, link), false);
}
/** The offer's filter: the same admission on a placed model (the baseline), with the lanes it holds but this link's own. The trial's 7a can still refuse. */
export function probeGapLane(model: LayoutModel, link: LayoutLink, course: Course, extra: readonly Lane[] = []): { lane: Lane } | { why: string } {
  const pending = [...model.lanes.filter(lane => !(lane.owner.kind === 'link' && lane.owner.id === link.id)), ...extra];
  return admitGapLane({ ...model, courses: [course] }, link, course, pending, (group, item) => occupied(model, group, item, pending));
}
const endHasNaturalFace = (course: Course): boolean => endMode(course, 'from') === 'natural' || endMode(course, 'to') === 'natural';
/** A riser lane: owned by the upper bus of a join, at the riser x (set in 7a; moved only with room 7f inserts, `insertRoomAt`), in a crossed sub-tier, clear of every body and lane. */
function validateRiserLane(model: LayoutModel, lane: Lane): void {
  const bus = model.meshBuses?.find(item => item.id === (lane.owner as { id: string }).id);
  if (bus?.riser === undefined || bus.cross === undefined || lane.layer !== 'overlay' || lane.id !== riserLaneId(bus.id, lane.tier)
    || !bus.riser.lanes.includes(lane.id) || lane.x !== bus.riser.x || lane.bounds.width < laneWidth(model)
    || lane.bounds.x !== lane.x - lane.bounds.width / 2 || !Object.values(lane.bounds).every(Number.isFinite)
    || model.groups[lane.group]?.tier !== lane.tier || !['left', 'right'].includes(lane.side)) throw new Error(`Invalid riser lane ${lane.id}`);
  const extent = laneExtent(model, lane.tier);
  if (lane.bounds.y !== extent.y || lane.bounds.height !== extent.height) throw new Error('Lane extent contradicts tier band');
  const group = model.groups[lane.group]!;
  if (lane.side === 'left' ? lane.x >= group.bounds!.x : lane.x <= right(group.bounds!)) throw new Error(`Lane side contradicts its group: ${lane.id} / ${group.id}`);
  for (const other of Object.values(model.groups).filter(item => item.tier === lane.tier)) {
    const box = occupied(model, other);
    if (box.x < right(lane.bounds) - PLACEMENT_EPS && right(box) > lane.bounds.x + PLACEMENT_EPS) throw new Error(`Lane ${lane.id} crosses occupied group ${other.id}`);
  }
  for (const other of model.lanes) if (other !== lane && other.tier === lane.tier
    && Math.abs(other.x - lane.x) < (other.bounds.width + lane.bounds.width) / 2 - PLACEMENT_EPS) throw new Error('Owned lanes overlap');
}
/**
 * A side lane is valid only on a candidate for it: its id, port, tier, side and group are the lateral end's. That the node is the outermost of its row
 * is decided at 7a and frozen; a later move that breaks it is a warning at the end of 7f (`SIDE_LANE_NOT_OUTERMOST`), not a reason to lose the publication.
 */
function validSideLane(model: LayoutModel, lane: Lane, link: LayoutLink): boolean {
  const candidate = sideLaneCandidate(model, link), port = lane.port, found = port === undefined ? undefined : findPort(model, port);
  return candidate !== undefined && port !== undefined && found?.anchor !== undefined && portId(candidate) === portId(port) && lane.id === sideLaneId(link)
    && found.side === lane.side && model.document.nodes[port.node]?.group === lane.group && nodeTier(model, port.node) === lane.tier;
}
/**
 * A span corridor is valid on a hinted candidate only: its id, owner, band and layer are the link's, and its box is the corridor the chord derives from the two end anchors.
 * Another chord's path may cross it (two chords cross each other).
 */
function validateSpanLane(model: LayoutModel, lane: Lane): void {
  const link = lane.owner.kind === 'link' ? model.links.find(item => item.id === (lane.owner as { id: string }).id) : undefined;
  if (link === undefined || link.spanHint !== true || lane.layer !== 'routed' || !transitTiers(model, link).includes(lane.tier) || lane.id !== spanLaneId(link.id, lane.tier)
    || model.groups[lane.group]?.tier !== lane.tier || !['left', 'right'].includes(lane.side) || !Object.values(lane.bounds).every(Number.isFinite)) throw new PlacementRefusal('span', `Invalid span lane ${lane.id}`, { stage: 'lanes', owners: [{ kind: 'lane', id: lane.id }] });
  const box = spanCorridor(model, link, lane.tier);
  if (box === undefined || Math.abs(box.x - lane.bounds.x) > PLACEMENT_EPS || Math.abs(box.width - lane.bounds.width) > PLACEMENT_EPS
    || Math.abs(box.y - lane.bounds.y) > PLACEMENT_EPS || Math.abs(box.height - lane.bounds.height) > PLACEMENT_EPS
    || Math.abs(lane.x - (box.x + box.width / 2)) > PLACEMENT_EPS) throw new PlacementRefusal('span', `Span lane ${lane.id} contradicts the chord of ${link.id}: ${JSON.stringify(lane.bounds)} against ${JSON.stringify(box)}`, { stage: 'lanes', owners: [{ kind: 'lane', id: lane.id }, { kind: 'link', id: link.id }] });
  // A wall in the corridor is not thrown for: a forced 7f move can cause it after 7a, and `spanLaneFindings` names it (`SPAN_CHORD_BLOCKED`).
}
/**
 * A bypass lane (ticket 24, phase 5): one of the two stems of a row bypass. Its id, port and side are the end's; its x and extent are the ones the geometry derives from
 * the node boxes now; it stands in no body of the model (the nodes of its own row stand beside the gap, not in it).
 */
function validateBypassLane(model: LayoutModel, lane: Lane, link: LayoutLink, course: Course): void {
  const geometry = bypassGeometry(model, link, course), index = lane.id === bypassLaneId(link.id, 1) ? 1 : lane.id === bypassLaneId(link.id, 0) ? 0 : undefined;
  if (geometry === undefined || index === undefined) throw new Error(`Gap lane ${lane.id} has no bypass course`);
  const end = geometry.ends[index], extent = bypassLaneExtent(geometry, index);
  if (lane.port === undefined || portId(lane.port) !== portId(end.ref) || lane.side !== end.port.side || lane.tier !== geometry.tier || lane.group !== geometry.group) throw new Error(`Bypass lane ${lane.id} does not serve its end`);
  if (lane.bounds.x !== lane.x - lane.bounds.width / 2 || lane.bounds.width < laneWidth(model, link) - PLACEMENT_EPS || !Object.values(lane.bounds).every(Number.isFinite)) throw new Error(`Invalid bypass lane geometry ${lane.id}`);
  if (Math.abs(lane.x - extent.x) > PLACEMENT_EPS || Math.abs(lane.bounds.y - extent.y) > PLACEMENT_EPS || Math.abs(lane.bounds.height - extent.height) > PLACEMENT_EPS) throw new Error(`Bypass lane ${lane.id} contradicts its gap and port`);
  for (const node of Object.values(model.nodes)) {
    const box = node.bounds;
    if (box !== undefined && box.x < right(lane.bounds) - PLACEMENT_EPS && right(box) > lane.bounds.x + PLACEMENT_EPS && box.y < bottom(lane.bounds) - PLACEMENT_EPS && bottom(box) > lane.bounds.y + PLACEMENT_EPS) throw new Error(`Bypass lane ${lane.id} crosses the node ${node.id}`);
  }
}
/** Validate reservations independently of allocation history, including restored JSON. */
export function validateLanes(model: LayoutModel): void {
  const risers = (model.meshBuses ?? []).filter(bus => bus.cross !== undefined).flatMap(bus => {
    const lower = model.meshBuses!.find(item => item.id === bus.joined);
    return lower === undefined || bus.riser === undefined ? [] : crossedTiers(model, bus, lower).map(tier => riserLaneId(bus.id, tier));
  });
  // A perimeter or column-gap lane belongs to a course (ticket 15); its shape is checked here, its geometry once a phase reserves it.
  const owned = model.lanes.filter(isCourseLane);
  for (const lane of owned) validateCourseLane(model, lane);
  // Perimeter lanes of one side keep a pitch between them where their extents meet, and none stands across the box of a group on its extent.
  for (const lane of owned) {
    if (lane.kind !== 'perimeter') continue;
    for (const other of owned) if (other !== lane && other.kind === 'perimeter' && other.side === lane.side && lane.bounds.y < bottom(other.bounds) - PLACEMENT_EPS && bottom(lane.bounds) > other.bounds.y + PLACEMENT_EPS
      && Math.abs(other.x - lane.x) < RING_PITCH - PLACEMENT_EPS) throw new Error(`Perimeter lanes ${lane.id} and ${other.id} overlap`);
    if (lane.owner.kind === 'mesh-bus') {
      // A trunk lane stands where its geometry derives: beyond every box between its uppermost bar and its lowermost (mesh-bus.md, section 12.5).
      const head = model.meshBuses?.find(item => item.id === (lane.owner as { id: string }).id);
      const geometry = head === undefined ? undefined : trunkGeometry(model, head, { side: lane.side, ring: lane.ring ?? 0 }, group => occupied(model, group), owned.filter(other => other.kind === 'perimeter'));
      if (geometry === undefined || Math.abs(geometry.x - lane.x) > PLACEMENT_EPS || Math.abs(geometry.bounds.y - lane.bounds.y) > PLACEMENT_EPS
        || Math.abs(geometry.bounds.height - lane.bounds.height) > PLACEMENT_EPS || head?.trunk?.x !== lane.x) throw new Error(`Trunk lane ${lane.id} contradicts the boxes on its extent`);
      continue;
    }
    const link = model.links.find(item => lane.owner.kind === 'link' && item.id === lane.owner.id);
    if (link === undefined) continue;
    for (const group of Object.values(model.groups)) {
      if (group.bounds === undefined || group.nodes.length === 0) continue;
      const box = occupied(model, group, link);
      if (box.y < bottom(lane.bounds) - PLACEMENT_EPS && bottom(box) > lane.bounds.y + PLACEMENT_EPS && box.x < right(lane.bounds) - PLACEMENT_EPS && right(box) > lane.bounds.x + PLACEMENT_EPS) throw new Error(`Lane ${lane.id} crosses occupied group ${group.id}`);
    }
  }
  // A column-gap lane belongs to a gap course: it serves the course's lateral port, its extent is the one the port's y gives, and it stands in no box of its sub-tier.
  for (const lane of owned) {
    if (lane.kind !== 'gap') continue;
    const link = model.links.find(item => lane.owner.kind === 'link' && item.id === lane.owner.id), course = link === undefined ? undefined : courseOf(model, link.id);
    if (link !== undefined && course !== undefined && isBypassCourse(course)) { validateBypassLane(model, lane, link, course); continue; }
    const geometry = link === undefined || course === undefined ? undefined : gapGeometry(model, link, course);
    if (link === undefined || course === undefined || geometry === undefined || lane.id !== gapLaneId(link.id)) throw new Error(`Gap lane ${lane.id} has no gap course`);
    if (lane.port === undefined || portId(lane.port) !== portId(link.attachments![geometry.lateral.which])) throw new Error(`Gap lane ${lane.id} does not serve the lateral end of its course`);
    if (lane.tier !== geometry.tier || lane.bounds.x !== lane.x - lane.bounds.width / 2 || lane.bounds.width < laneWidth(model, link) - PLACEMENT_EPS || !Object.values(lane.bounds).every(Number.isFinite)) throw new Error(`Invalid gap lane geometry ${lane.id}`);
    if (Math.abs(lane.bounds.y - geometry.extent.y) > PLACEMENT_EPS || Math.abs(lane.bounds.height - geometry.extent.height) > PLACEMENT_EPS) throw new Error('Gap lane extent contradicts its port');
    for (const other of Object.values(model.groups)) {
      if (other.tier !== lane.tier || other.bounds === undefined || other.nodes.length === 0) continue;
      const box = occupied(model, other, link);
      if (box.x < right(lane.bounds) - PLACEMENT_EPS && right(box) > lane.bounds.x + PLACEMENT_EPS) throw new Error(`Lane ${lane.id} crosses occupied group ${other.id}`);
    }
  }
  const sides = [...new Set(model.lanes.filter(isSideLane).map(lane => `side-lane:${lane.owner.kind === 'link' ? lane.owner.id : ''}`))];
  const spans = model.links.flatMap(link => link.spanHint === true ? transitTiers(model, link).map(tier => spanLaneId(link.id, tier)) : []);
  const expected = [...model.links.flatMap(link => courseOf(model, link.id) === undefined && link.spanHint !== true ? transitTiers(model, link).map(tier => laneId(link, tier)) : []), ...risers, ...sides, ...spans].sort();
  if (JSON.stringify(model.lanes.filter(lane => !isCourseLane(lane)).map(lane => lane.id).sort()) !== JSON.stringify(expected)) throw new Error('Lane reservations omit, repeat or invent a transit');
  for (const lane of model.lanes) {
    if (isCourseLane(lane)) continue;
    if (isSpanLane(lane)) { validateSpanLane(model, lane); continue; }
    if (lane.owner.kind === 'mesh-bus') { validateRiserLane(model, lane); continue; }
    const ownerId = lane.owner.kind === 'link' ? lane.owner.id : undefined;
    const link = model.links.find(link => link.id === ownerId);
    const side = isSideLane(lane);
    if (!link || lane.layer !== 'routed' || (side ? !validSideLane(model, lane, link) : !transitTiers(model, link).includes(lane.tier) || lane.id !== laneId(link, lane.tier))
      || model.groups[lane.group]?.tier !== lane.tier || !['left', 'right'].includes(lane.side)
      || lane.bounds.width < laneWidth(model, link) || lane.bounds.x !== lane.x - lane.bounds.width / 2
      || !Object.values(lane.bounds).every(Number.isFinite) || !Number.isFinite(lane.x)) throw new Error('Invalid owned lane geometry');
    const extent = side ? sideLaneExtent(model, lane, link) : laneExtent(model, lane.tier);
    if (lane.bounds.y !== extent.y || lane.bounds.height !== extent.height) throw new Error(side ? 'Side lane extent contradicts its port' : 'Lane extent contradicts tier band');
    const group = model.groups[lane.group]!;
    if (lane.side === 'left' ? lane.x >= group.bounds!.x : lane.x <= right(group.bounds!)) throw new Error(`Lane side contradicts its group: ${lane.id} / ${group.id}`);
    for (const other of Object.values(model.groups).filter(group => group.tier === lane.tier)) {
      const box = occupied(model, other, link);
      if (box.x < right(lane.bounds) - PLACEMENT_EPS && right(box) > lane.bounds.x + PLACEMENT_EPS) throw new Error(`Lane ${lane.id} crosses occupied group ${other.id}`);
    }
    for (const other of model.lanes) if (other !== lane && other.tier === lane.tier && !isCourseLane(other) && !isSpanLane(other)
      && Math.abs(other.x - lane.x) < (other.bounds.width + lane.bounds.width) / 2 - PLACEMENT_EPS) throw new Error('Owned lanes overlap');
    for (const other of model.links) if (other.id !== link.id && other.path?.fixed) for (const segment of other.path.segments) {
      if (segmentRectDistance(segment, lane.bounds) < linkStrokeWidth(other) / 2 - PLACEMENT_EPS) throw new Error('Fixed path crosses a foreign lane');
    }
  }
  for (const link of model.links) {
    const runs = laneReservation(model, link);
    if (!equal(link.fixedSegments, link.bundle ? undefined : runs)) throw new Error(`Fixed lane segments contradict reservations on ${link.id}`);
    if (link.path && runs && !runs.every(run => link.path!.segments.some(segment => equal(segment, run)))) {
      throw new Error('Complete path omits an immutable reserved segment');
    }
  }
}
export function lanes(model: LayoutModel): LayoutModel { return withStageMutation(model, 'lanes', allocateLanes); }
