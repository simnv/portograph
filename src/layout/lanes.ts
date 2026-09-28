import { measurePortPill } from '../text/index.js';
import { equal } from '../model/json-equality.js';
import type { Rect } from '../model/geometry.js';
import type { Lane, LayoutGroup, LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import type { PortRef } from '../model/document.js';
import { DEFAULT_STROKE_WIDTHS as stroke, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth, routedStrokeWidth } from '../theme/geometry.js';
import { segmentRectDistance } from '../score/geometry.js';
import { findPort } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { moveGroup, union } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { withLayoutMutation } from './mutation.js';
import { foreignReach, foreignRoot, heldLaneReach, ownFrameCells } from './frames.js';
import { bottom, expandCanvas, GROUP_PADDING, placementWarning, rebuildRegions, right } from './regions.js';

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

export function nodeTier(model: LayoutModel, id: string): number {
  return model.groups[model.document.nodes[id]!.group]!.tier!;
}
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
export function transitTiers(model: LayoutModel, link: LayoutLink): number[] {
  if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) return [];
  const a = nodeTier(model, link.attachments.from.node), b = nodeTier(model, link.attachments.to.node);
  return model.tierBands.map(band => band.tier).filter(tier => tier > Math.min(a, b) && tier < Math.max(a, b)).sort((u, v) => a < b ? u - v : v - u);
}
/** Measured normal pill extent plus 10 px gap, or the stroke-aware node clearance diameter. */
export function laneWidth(model: LayoutModel, link: LayoutLink): number {
  const pills = link.attachments ? [findPort(model, link.attachments.from), findPort(model, link.attachments.to)] : [];
  const maxNodeStroke = Math.max(stroke.node, ...Object.values(model.nodes).map(node => node.strokeWidth ?? stroke.node));
  return Math.max(24 + 10, ...pills.map(port => (port?.ref.name !== undefined ? measurePortPill(port.ref.name).width : 0) + 10), 20 + routedStrokeWidth(model) + maxNodeStroke);
}
function occupied(model: LayoutModel, group: LayoutGroup, link?: LayoutLink, held: readonly Lane[] = []) {
  // One routed-stroke lookup for the whole group: it reads every link, and a per-node call makes
  // this measurement cost the link count once for each node and pill.
  const routed = routedStrokeWidth(model), gap = (stroke.pill + routed) / 2;
  // A link foreign to the frame of a rank cell gets its lane beside the frame edge, not beside the cell
  // (ticket 04), so it never enters the frame. A link that ends inside the frame is not asked for more.
  const reach = link && foreignReach(model, group.id, link), box = group.bounds!;
  // The lanes of links that end in the frame, already reserved beside this cell, will grow the frame (ticket 14).
  const taken = link ? held.map(lane => heldLaneReach(model, group.id, link, lane, laneLink(model, lane))).filter((item): item is Rect => item !== undefined) : [];
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
export function laneSidesHold(model: LayoutModel, proposed: { group: LayoutGroup; bounds: Rect }[]): boolean {
  return proposed.every(({ group, bounds }) => {
    return model.lanes.filter(lane => lane.tier === group.tier).every(lane => {
      const box = occupiedAt(model, group, bounds, laneLink(model, lane));
      return group.bounds!.x >= lane.x ? box.x >= right(lane.bounds) - 1e-6 : right(box) <= lane.bounds.x + 1e-6;
    });
  });
}
/** The link a lane belongs to. */
function laneLink(model: LayoutModel, lane: Lane): LayoutLink | undefined {
  return lane.owner.kind === 'link' ? model.links.find(link => link.id === (lane.owner as { id: string }).id) : undefined;
}
function laneId(link: LayoutLink, tier: number): string { return `lane:${JSON.stringify(link.id)}:${tier}`; }
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
/** Extent-only replay. Never allocates, moves, renames, or changes the owner of a lane. */
export function rebuildLaneExtents(model: LayoutModel): void {
  for (const lane of model.lanes) Object.assign(lane.bounds, laneExtent(model, lane.tier));
  for (const link of model.links) {
    delete link.fixedSegments;
    if (link.bundle) continue;
    const owned = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id);
    const order = transitTiers(model, link);
    owned.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
    if (owned.length) link.fixedSegments = owned.map(lane => reservation(model, link, lane));
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
  const overlaps = (box: { x: number; width: number }) => box.x < window.x + window.width - 1e-6 && box.x + box.width > window.x + 1e-6;
  // Inside the transited band the corridor is the reservation `validateLanes` measures.
  for (const group of Object.values(model.groups)) if (group.tier === lane.tier && overlaps(occupied(model, group, link))) return false;
  for (const other of model.lanes) if (other !== lane && other.tier === lane.tier
    && Math.abs(other.x - x) < (other.bounds.width + lane.bounds.width) / 2 - 1e-6) return false;
  // Beyond the band the corridor is the child's own descent. It may enter the child's group and
  // nothing else: a foreign node, a foreign group box or a reserved run of another link stops it.
  const anchor = findPort(model, child)!.anchor!;
  const low = Math.min(lane.bounds.y, anchor.y), high = Math.max(bottom(lane.bounds), anchor.y);
  const span = { x: window.x, y: low, width: window.width, height: high - low };
  const childGroup = model.document.nodes[child.node]!.group;
  for (const node of Object.values(model.nodes)) {
    if (node.id === child.node) continue;
    const box = node.bounds!;
    if (overlaps(box) && box.y < bottom(span) - 1e-6 && bottom(box) > span.y + 1e-6) return false;
  }
  for (const group of Object.values(model.groups)) {
    if (group.id === childGroup || group.tier === lane.tier) continue;
    const box = group.bounds!;
    if (overlaps(box) && box.y < bottom(span) - 1e-6 && bottom(box) > span.y + 1e-6) return false;
  }
  // Every reserved run of another link, in the three forms placement writes: a pinned path, the
  // corridor runs of 7a, and the shared runs 7e cuts for a fan. The gap allocation counts all
  // three, so a corridor that ignored one would stand where a reserved run already does.
  for (const other of model.links) {
    if (other.id === link.id) continue;
    const runs = [...other.path?.fixed ? other.path.segments : [], ...other.fixedSegments ?? [],
      ...other.sharedRuns?.from ?? [], ...other.sharedRuns?.to ?? []];
    for (const segment of runs) if (segmentRectDistance(segment, span) < linkStrokeWidth(other) / 2 - 1e-6) return false;
  }
  // A group title keeps its link-free margin from every link, this link included (ADR-0013).
  for (const label of model.labels) {
    if (label.role !== 'group' || label.omitted || !label.bounds) continue;
    const box = {
      x: label.bounds.x - GROUP_LABEL_LINK_CLEARANCE, y: label.bounds.y - GROUP_LABEL_LINK_CLEARANCE,
      width: label.bounds.width + 2 * GROUP_LABEL_LINK_CLEARANCE, height: label.bounds.height + 2 * GROUP_LABEL_LINK_CLEARANCE,
    };
    if (overlaps(box) && box.y < bottom(span) - 1e-6 && bottom(box) > span.y + 1e-6) return false;
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
    if (lane.owner.kind !== 'link') continue;
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
    lane.side = anchor.x < group.bounds!.x ? 'left' : 'right';
    moved = true;
    followed?.push({ lane: lane.id, child });
    placementWarning(model, 'LANE_FOLLOWS_ITS_CHILD',
      `${link.id} could not be seated under its corridor at tier ${lane.tier}; the corridor follows the child port.`, [link.id]);
  }
  if (moved) rebuildLaneExtents(model);
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
    return sum + (range.high < low ? 0 : Math.floor((range.high - low + 1e-6) / gap) + 1);
  }, 0);
  const enough = candidates.filter(x => capacity(x) >= count);
  return (enough.length ? enough : candidates).sort((a, b) => Math.abs(a - sx) - Math.abs(b - sx) || a - b)[0];
}
/**
 * Plan outward pushes from the insertion gap, not from a corridor's centre. The gap partitions
 * the original group order even when a wide corridor contains an entire neighboring group.
 * Propagate each push through its neighbors and retain their existing occupied separation.
 */
function marginTranslations(model: LayoutModel, groups: LayoutGroup[], split: number, x: number, width: number,
  prior: Lane[], fixedSources: Set<string>, link: LayoutLink, framed = false): number[] | undefined {
  if (prior.some(lane => Math.abs(x - lane.x) < (width + lane.bounds.width) / 2 - 1e-6)) return undefined;
  const boxes = groups.map(group => occupied(model, group, link, prior)), shifts = groups.map(() => 0);
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
    for (const lane of prior) {
      // A lane of a link that ends in this cell's frame stands inside the box: the frame grows to hold it,
      // so the cell cannot move away from it (ticket 14).
      if (group.frame !== undefined && lane.group === group.id && box.x <= lane.bounds.x + 1e-6 && right(box) >= right(lane.bounds) - 1e-6) {
        if (dx) return undefined;
        continue;
      }
      // Existing corridors cannot be crossed or consumed by a later margin expansion.
      if (right(box) <= lane.bounds.x + 1e-6) {
        if (right(box) + dx > lane.bounds.x + 1e-6) return undefined;
      } else if (box.x >= right(lane.bounds) - 1e-6) {
        if (box.x + dx < right(lane.bounds) - 1e-6) return undefined;
      } else return undefined;
    }
  }
  return shifts;
}
/** Allocate all corridors before publishing x. Intermediate occupied margins may translate horizontally. */
export function allocateLanes(model: LayoutModel): void {
  if (model.lanes.length || model.links.some(link => link.fixedSegments)) throw new Error('Lanes can be allocated only once');
  const pending: Lane[] = [];
  const origins = new Map(Object.values(model.groups).map(group => [group.id, {
    x: group.bounds!.x, nodes: group.nodes.map(id => {
      const node = model.nodes[id]!;
      return { id, x: node.bounds!.x, anchors: node.ports.map(port => ({ ...port.anchor! })) };
    }),
  }]));
  // Retain the source-side order through every intermediate tier, including same-node bundles.
  // Links sharing one alignment-end anchor follow their far ends' x, so the lanes of a fan from one
  // port keep the children's row order and 7c can align every child under its own lane.
  const farEnd = (link: LayoutLink) => {
    const source = laneSource(model, link);
    return source === link.attachments!.from ? link.attachments!.to : link.attachments!.from;
  };
  const farX = (link: LayoutLink) => findPort(model, farEnd(link))!.anchor!.x;
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
   * The x the link's target holds once placement freezes, where placement already knows it. The
   * target is the far end: 7c brings it under the lane, and where it cannot, the run out of the
   * lane travels to it. Five far ends have no x to read yet, and the rule that reads the target
   * takes no opinion from them: a bundle member keeps the authored source and 7e owns its geometry,
   * a bar takes its port x from the other end in 7d, a port that several links share is a fan whose
   * x 7c settles from all of its peers at once, a far end 7c seats under the lane takes the lane's
   * own x, so reading it here would only read this rule's own answer back, and a far end the
   * transited tier itself feeds travels with the groups this stage moves aside.
   */
  const targetX = (link: LayoutLink, tier: number): number | undefined => {
    if (link.bundle || seatedByCentre(link)) return undefined;
    const far = farEnd(link);
    return isBar(far) || (portLoad.get(portId(far)) ?? 0) > 1 || peerTiers.get(far.node)!.has(tier)
      ? undefined : findPort(model, far)!.anchor!.x;
  };
  const links = model.links.filter(link => transitTiers(model, link).length).sort((a, b) =>
    findPort(model, laneSource(model, a))!.anchor!.x - findPort(model, laneSource(model, b))!.anchor!.x || farX(a) - farX(b) || a.sourceIndex - b.sourceIndex);
  const fixedSources = new Set(links.map(link => model.document.nodes[laneSource(model, link).node]!.group));
  /**
   * Move the planned groups aside, then reserve the corridor beside `group`. Subsequent reservations
   * inspect current pills, not the pre-translation measurements.
   */
  const commit = (link: LayoutLink, tier: number, groups: LayoutGroup[], group: LayoutGroup, x: number, shifts: number[]): void => {
    const source = model.nodes[laneSource(model, link).node]!, width = laneWidth(model, link), half = width / 2;
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
  for (const link of links) {
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
        const boxes = item.cells.map(cell => occupied(model, cell, link, pending));
        const fixed = item.cells.filter(cell => !tiers.includes(cell.tier!)).map(cell => occupied(model, cell, link, pending));
        return {
          item, centre: (Math.min(...boxes.map(box => box.x)) + Math.max(...boxes.map(box => right(box)))) / 2,
          low: Math.min(...boxes.map(box => box.x)), high: Math.max(...boxes.map(box => right(box))),
          fixedLow: Math.min(...fixed.map(box => box.x)), fixedHigh: Math.max(...fixed.map(box => right(box))),
        };
      }).sort((a, b) => a.centre - b.centre);
      const rootOf = new Map(ordered.flatMap((entry, index) => entry.item.cells.map(cell => [cell.id, index] as const)));
      const desire = tiers.map(tier => targetX(link, tier)).find(value => value !== undefined) ?? sx;
      const wanted = ordered.filter(entry => entry.centre < desire).length;
      // Every cell of a root before `gap` stands left of the lane and every cell of the others right of it;
      // a group of no root takes the side of its centre. The left groups must be a prefix of the tier.
      const plan = (tier: number, x: number, gap: number) => {
        const groups = Object.values(model.groups).filter(group => group.tier === tier).sort((a, b) => a.bounds!.x - b.bounds!.x);
        const isLeft = (group: LayoutGroup): boolean => rootOf.has(group.id) ? rootOf.get(group.id)! < gap : group.bounds!.x + group.bounds!.width / 2 < x;
        const split = groups.filter(isLeft).length;
        const prior = pending.filter(lane => lane.tier === tier);
        return { groups, shifts: groups.slice(0, split).every(isLeft) ? marginTranslations(model, groups, split, x, width, prior, fixedSources, link, true) : undefined };
      };
      // A lane that stands clear of every root where it is now moves no cell of the frame. Where the gap
      // is too narrow the plan may push the cells of a crossed sub-tier aside to open it, as it does for
      // plain groups, but only by what opening a corridor between two abutting boxes takes: the lane and
      // the frame margin on each side. A larger push would carry a frame away from the lane's source
      // instead of opening a gap, so the lane stands beyond that frame. The cells of the other sub-tiers
      // bound the plan. Among the gaps the endpoints ask for, the lane nearest its source wins (a corridor
      // under its source avoids an approach jog), then the plan that moves the fewest cells.
      const own = ownFrameCells(model, link);
      const ownBoxes = Object.values(model.groups).filter(group => own.has(group.id) && tiers.includes(group.tier!)).map(group => occupied(model, group, link));
      const opening = width + 2 * GROUP_PADDING;
      const candidates = [false, true].flatMap(open => Array.from({ length: ordered.length + 1 }, (_, gap) => {
        const [before, after] = [ordered.slice(0, gap), ordered.slice(gap)];
        const low = Math.max(-Infinity, ...before.map(entry => open ? entry.fixedHigh : entry.high)) + half;
        const high = Math.min(Infinity, ...after.map(entry => open ? entry.fixedLow : entry.low)) - half;
        return { gap, low, high };
      }).filter(item => item.low <= item.high).flatMap(item => {
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
        const left = Math.min(...every.map(group => occupied(model, group, link, pending).x), ...lanesHere.map(lane => lane.bounds.x)) - half;
        const rightX = Math.max(...every.map(group => right(occupied(model, group, link, pending))), ...lanesHere.map(lane => right(lane.bounds))) + half;
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
      const nearest = [...main].sort((a, b) => Math.min(Math.abs(sx - a.bounds!.x), Math.abs(sx - right(a.bounds!)))
        - Math.min(Math.abs(sx - b.bounds!.x), Math.abs(sx - right(b.bounds!))))[0] ?? groups[0]!;
      const core = occupied(model, nearest, link);
      // A corridor passes its tier on the side of the transited group that faces the link's target
      // (ticket 03), so the run leaves the tier already on the side its far end stands on. Where the
      // target has no x to read, the corridor keeps the side the source asks for.
      const target = targetX(link, tier);
      const side = target === undefined ? undefined : target < core.x + core.width / 2 ? 'left' : 'right';
      let x = sx < core.x + core.width / 2 ? Math.min(sx, core.x - half) : Math.max(sx, right(core) + half);
      // Reserve in transported source order. Previous corridors are immutable even during planning.
      const prior = pending.filter(lane => lane.tier === tier);
      for (const lane of prior) if (Math.abs(x - lane.x) < (width + lane.bounds.width) / 2) {
        x = lane.x + (width + lane.bounds.width) / 2;
      }
      // A corridor directly below its source avoids an approach jog. Before ownership freezes,
      // move intermediate groups aside where that preserves prior corridors and source groups.
      // An insertion gap that leaves the transited group on the target side is taken first; a plan
      // on the other side is taken only where the target side has none.
      const at = groups.indexOf(nearest);
      const offSide = (split: number): number => side === undefined ? 0 : Number(side === 'left' ? split > at : split <= at);
      const direct = Array.from({ length: groups.length + 1 }, (_, split) => split)
        .map(split => ({ split, shift: marginTranslations(model, groups, split, sx, width, prior, fixedSources, link) }))
        .filter((plan): plan is { split: number; shift: number[] } => plan.shift !== undefined)
        .sort((a, b) => offSide(a.split) - offSide(b.split)
          || a.shift.reduce((sum, dx) => sum + Math.abs(dx), 0) - b.shift.reduce((sum, dx) => sum + Math.abs(dx), 0))[0]?.shift;
      let shifts: number[] | undefined;
      if (direct) { x = sx; shifts = direct; }
      else {
        // Prefer a full in-span allocation for the remaining same-source members when it fits.
        x = inSpanSlot(model, link, core, width, prior, tierLinks.slice(index)) ?? x;
        // If exterior packing crossed the main group, take the margin the target side asks for.
        if (x + half > core.x && x - half < right(core)) x = side === 'left' ? core.x - half : right(core) + half;
        const split = at + (x > right(core) ? 1 : 0);
        shifts = marginTranslations(model, groups, split, x, width, prior, fixedSources, link);
      }
      if (!shifts) {
        // A source or earlier corridor blocks propagation. An exterior corridor needs no movement.
        const left = Math.min(...groups.map(group => occupied(model, group, link).x), ...prior.map(lane => lane.bounds.x)) - half;
        const rightX = Math.max(...groups.map(group => right(occupied(model, group, link))), ...prior.map(lane => right(lane.bounds))) + half;
        x = side === undefined ? (Math.abs(left - sx) <= Math.abs(rightX - sx) ? left : rightX) : side === 'left' ? left : rightX;
        shifts = groups.map(() => 0);
      }
      commit(link, tier, groups, nearest, x, shifts);
    }
  }
  model.lanes = pending;
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
  rebuildRegions(model);
  rebuildLaneExtents(model);
}
/** Validate reservations independently of allocation history, including restored JSON. */
export function validateLanes(model: LayoutModel): void {
  const expected = model.links.flatMap(link => transitTiers(model, link).map(tier => laneId(link, tier))).sort();
  if (JSON.stringify(model.lanes.map(lane => lane.id).sort()) !== JSON.stringify(expected)) throw new Error('Lane reservations omit, repeat or invent a transit');
  for (const lane of model.lanes) {
    const ownerId = lane.owner.kind === 'link' ? lane.owner.id : undefined;
    const link = model.links.find(link => link.id === ownerId);
    if (!link || lane.layer !== 'routed' || !transitTiers(model, link).includes(lane.tier) || lane.id !== laneId(link, lane.tier)
      || model.groups[lane.group]?.tier !== lane.tier || !['left', 'right'].includes(lane.side)
      || lane.bounds.width < laneWidth(model, link) || lane.bounds.x !== lane.x - lane.bounds.width / 2
      || !Object.values(lane.bounds).every(Number.isFinite) || !Number.isFinite(lane.x)) throw new Error('Invalid owned lane geometry');
    const extent = laneExtent(model, lane.tier);
    if (lane.bounds.y !== extent.y || lane.bounds.height !== extent.height) throw new Error('Lane extent contradicts tier band');
    const group = model.groups[lane.group]!;
    if (lane.side === 'left' ? lane.x >= group.bounds!.x : lane.x <= right(group.bounds!)) throw new Error(`Lane side contradicts its group: ${lane.id} / ${group.id}`);
    for (const other of Object.values(model.groups).filter(group => group.tier === lane.tier)) {
      const box = occupied(model, other, link);
      if (box.x < right(lane.bounds) - 1e-6 && right(box) > lane.bounds.x + 1e-6) throw new Error(`Lane ${lane.id} crosses occupied group ${other.id}`);
    }
    for (const other of model.lanes) if (other !== lane && other.tier === lane.tier
      && Math.abs(other.x - lane.x) < (other.bounds.width + lane.bounds.width) / 2 - 1e-6) throw new Error('Owned lanes overlap');
    for (const other of model.links) if (other.id !== link.id && other.path?.fixed) for (const segment of other.path.segments) {
      if (segmentRectDistance(segment, lane.bounds) < linkStrokeWidth(other) / 2 - 1e-6) throw new Error('Fixed path crosses a foreign lane');
    }
  }
  for (const link of model.links) {
    const order = transitTiers(model, link);
    const owned = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id)
      .sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
    const runs = owned.length ? owned.map(lane => reservation(model, link, lane)) : undefined;
    if (!equal(link.fixedSegments, link.bundle ? undefined : runs)) throw new Error(`Fixed lane segments contradict reservations on ${link.id}`);
    if (link.path && runs && !runs.every(run => link.path!.segments.some(segment => equal(segment, run)))) {
      throw new Error('Complete path omits an immutable reserved segment');
    }
  }
}
export function lanes(model: LayoutModel): LayoutModel { return withLayoutMutation(model, 'lanes', allocateLanes); }
