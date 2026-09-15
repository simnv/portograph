import { measurePortPill } from '../text/index.js';
import { equal } from '../model/json-equality.js';
import type { Rect } from '../model/geometry.js';
import type { Lane, LayoutGroup, LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import type { PortRef } from '../model/document.js';
import { DEFAULT_STROKE_WIDTHS as stroke, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth, routedStrokeWidth } from '../theme/geometry.js';
import { segmentRectDistance } from '../score/geometry.js';
import { findPort } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { moveGroup, union } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { withLayoutMutation } from './mutation.js';
import { bottom, expandCanvas, placementWarning, rebuildRegions, right } from './regions.js';

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
function occupied(model: LayoutModel, group: LayoutGroup) {
  // One routed-stroke lookup for the whole group: it reads every link, and a per-node call makes
  // this measurement cost the link count once for each node and pill.
  const routed = routedStrokeWidth(model), gap = (stroke.pill + routed) / 2;
  return union([group.bounds!, ...group.nodes.flatMap(id => {
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
  const box = occupied(model, group);
  return { left: group.bounds!.x - box.x, right: right(box) - right(group.bounds!) };
}
/**
 * The occupied box a group would have at `bounds`. Its nodes and pills translate with the group, so
 * a pure widening leaves a pill that already reaches past the padding exactly where it is.
 */
function occupiedAt(model: LayoutModel, group: LayoutGroup, bounds: Rect): Rect {
  const current = occupied(model, group);
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
    const box = occupiedAt(model, group, bounds);
    return model.lanes.filter(lane => lane.tier === group.tier).every(lane => group.bounds!.x >= lane.x
      ? box.x >= right(lane.bounds) - 1e-6 : right(box) <= lane.bounds.x + 1e-6);
  });
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
  for (const group of Object.values(model.groups)) if (group.tier === lane.tier && overlaps(occupied(model, group))) return false;
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
  for (const other of model.links) {
    if (other.id === link.id) continue;
    const runs = [...other.path?.fixed ? other.path.segments : [], ...other.fixedSegments ?? []];
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
 */
export function reseatLanes(model: LayoutModel): boolean {
  let moved = false;
  for (const lane of model.lanes) {
    if (lane.owner.kind !== 'link') continue;
    const link = model.links.find(item => item.id === (lane.owner as { id: string }).id);
    if (!link || link.bundle || !link.attachments) continue;
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
  prior: Lane[], fixedSources: Set<string>): number[] | undefined {
  if (prior.some(lane => Math.abs(x - lane.x) < (width + lane.bounds.width) / 2 - 1e-6)) return undefined;
  const boxes = groups.map(group => occupied(model, group)), shifts = groups.map(() => 0);
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
    for (const lane of prior) {
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
  for (const tier of model.tierBands.map(band => band.tier)) {
    const groups = Object.values(model.groups).filter(group => group.tier === tier).sort((a, b) => a.bounds!.x - b.bounds!.x);
    const main = groups.filter(group => !group.flank);
    const tierLinks = links.filter(link => transitTiers(model, link).includes(tier));
    for (const [index, link] of tierLinks.entries()) {
      const source = model.nodes[laneSource(model, link).node]!, sx = findPort(model, laneSource(model, link))!.anchor!.x;
      const width = laneWidth(model, link), half = width / 2;
      const nearest = [...main].sort((a, b) => Math.min(Math.abs(sx - a.bounds!.x), Math.abs(sx - right(a.bounds!)))
        - Math.min(Math.abs(sx - b.bounds!.x), Math.abs(sx - right(b.bounds!))))[0] ?? groups[0]!;
      const core = occupied(model, nearest);
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
        .map(split => ({ split, shift: marginTranslations(model, groups, split, sx, width, prior, fixedSources) }))
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
        shifts = marginTranslations(model, groups, split, x, width, prior, fixedSources);
      }
      if (!shifts) {
        // A source or earlier corridor blocks propagation. An exterior corridor needs no movement.
        const left = Math.min(...groups.map(group => occupied(model, group).x), ...prior.map(lane => lane.bounds.x)) - half;
        const rightX = Math.max(...groups.map(group => right(occupied(model, group))), ...prior.map(lane => right(lane.bounds))) + half;
        x = side === undefined ? (Math.abs(left - sx) <= Math.abs(rightX - sx) ? left : rightX) : side === 'left' ? left : rightX;
        shifts = groups.map(() => 0);
      }
      const moved: string[] = [];
      for (const [index, group] of groups.entries()) {
        const dx = shifts[index]!;
        if (!dx) continue;
        moveGroup(model, group, dx, 0);
        // Repeated pushes must serialize as one exact common translation, not independently
        // accumulated floating-point sums for each anchor and its container.
        const origin = origins.get(group.id)!, totalDx = group.bounds!.x - origin.x;
        for (const old of origin.nodes) {
          const node = model.nodes[old.id]!;
          node.bounds!.x = old.x + totalDx;
          node.ports.forEach((port, i) => { port.anchor = { ...old.anchors[i]!, x: old.anchors[i]!.x + totalDx }; });
        }
        moved.push(...group.nodes);
        placementWarning(model, 'LANE_MARGIN_EXPANDED', `Expanded the occupied margin of ${group.id} for ${link.id}.`, [group.id], 'group');
      }
      // Subsequent reservations inspect current pills, not the pre-translation measurements.
      if (moved.length) rebuildNodeGeometry(model, moved, 'current');
      if (x < source.bounds!.x || x > right(source.bounds!)) placementWarning(model, 'LANE_OUTSIDE_SOURCE_SPAN',
        `${link.id} cannot fit an in-span corridor beside existing reservations at tier ${tier}; routing must complete its attachment jog.`, [link.id]);
      pending.push({ id: laneId(link, tier), owner: { kind: 'link', id: link.id }, layer: 'routed', group: nearest.id, tier,
        side: x < nearest.bounds!.x ? 'left' : 'right', x, bounds: { x: x - half, width, ...laneExtent(model, tier) } });
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
      const box = occupied(model, other);
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
