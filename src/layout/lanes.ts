import { equal } from '../model/json-equality.js';
import type { Rect } from '../model/geometry.js';
import type { Lane, LayoutGroup, LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { DEFAULT_STROKE_WIDTHS as stroke, linkStrokeWidth, routedStrokeWidth } from '../theme/geometry.js';
import { segmentRectDistance } from '../score/geometry.js';
import { findPort } from './row-paths.js';
import { moveGroup, union } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { withLayoutMutation } from './mutation.js';
import { bottom, expandCanvas, placementWarning, rebuildRegions, right } from './regions.js';

export function nodeTier(model: LayoutModel, id: string): number {
  return model.groups[model.document.nodes[id]!.group]!.tier!;
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
  return Math.max(24 + 10, ...pills.map(port => (port?.pill?.size.width ?? 0) + 10), 20 + routedStrokeWidth(model) + maxNodeStroke);
}
function occupied(model: LayoutModel, group: LayoutGroup) {
  return union([group.bounds!, ...group.nodes.flatMap(id => {
    const node = model.nodes[id]!, box = node.bounds!, clearance = 10 + ((node.strokeWidth ?? stroke.node) + routedStrokeWidth(model)) / 2;
    return [{ x: box.x - clearance, y: box.y, width: box.width + 2 * clearance, height: box.height },
      ...node.ports.filter(port => port.pill).map(port => {
        const pill = port.pill!.bounds, gap = (stroke.pill + routedStrokeWidth(model)) / 2;
        return { x: pill.x - gap, y: pill.y, width: pill.width + 2 * gap, height: pill.height };
      })];
  })]);
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
/** Prefer the nearest in-span slot that leaves room for the remaining members of this source. */
function inSpanSlot(model: LayoutModel, link: LayoutLink, core: { x: number; width: number }, width: number,
  prior: Lane[], remaining: LayoutLink[]): number | undefined {
  const source = model.nodes[link.attachments!.from.node]!.bounds!, half = width / 2;
  let intervals = [
    { low: source.x, high: Math.min(right(source), core.x - half) },
    { low: Math.max(source.x, core.x + core.width + half), high: right(source) },
  ].filter(range => range.low <= range.high);
  for (const lane of prior) {
    const low = lane.x - (lane.bounds.width + width) / 2, high = lane.x + (lane.bounds.width + width) / 2;
    intervals = intervals.flatMap(range => high <= range.low || low >= range.high ? [range]
      : [{ low: range.low, high: low }, { low: high, high: range.high }].filter(part => part.high >= part.low && part.low >= range.low && part.high <= range.high));
  }
  const cohort = remaining.filter(other => other.attachments!.from.node === link.attachments!.from.node);
  const count = cohort.length, gap = Math.max(width, ...cohort.map(other => laneWidth(model, other)));
  const sx = findPort(model, link.attachments!.from)!.anchor!.x;
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
  // Retain the source-side order through every intermediate tier, including same-node bundles.
  const links = model.links.filter(link => transitTiers(model, link).length).sort((a, b) =>
    findPort(model, a.attachments!.from)!.anchor!.x - findPort(model, b.attachments!.from)!.anchor!.x || a.sourceIndex - b.sourceIndex);
  const fixedSources = new Set(links.map(link => model.document.nodes[link.attachments!.from.node]!.group));
  for (const tier of model.tierBands.map(band => band.tier)) {
    const groups = Object.values(model.groups).filter(group => group.tier === tier).sort((a, b) => a.bounds!.x - b.bounds!.x);
    const main = groups.filter(group => !group.flank);
    const tierLinks = links.filter(link => transitTiers(model, link).includes(tier));
    for (const [index, link] of tierLinks.entries()) {
      const source = model.nodes[link.attachments!.from.node]!, sx = findPort(model, link.attachments!.from)!.anchor!.x;
      const width = laneWidth(model, link), half = width / 2;
      const nearest = [...main].sort((a, b) => Math.min(Math.abs(sx - a.bounds!.x), Math.abs(sx - right(a.bounds!)))
        - Math.min(Math.abs(sx - b.bounds!.x), Math.abs(sx - right(b.bounds!))))[0] ?? groups[0]!;
      const core = occupied(model, nearest);
      const side = sx < core.x + core.width / 2 ? 'left' : 'right';
      let x = side === 'left' ? Math.min(sx, core.x - half) : Math.max(sx, right(core) + half);
      // Reserve in transported source order. Previous corridors are immutable even during planning.
      const prior = pending.filter(lane => lane.tier === tier);
      for (const lane of prior) if (Math.abs(x - lane.x) < (width + lane.bounds.width) / 2) {
        x = lane.x + (width + lane.bounds.width) / 2;
      }
      // Prefer a full in-span allocation for the remaining same-source members when it fits.
      x = inSpanSlot(model, link, core, width, prior, tierLinks.slice(index)) ?? x;
      // If exterior packing crossed the main group, take its other margin.
      if (x + half > core.x && x - half < right(core)) x = right(core) + half;
      const split = groups.indexOf(nearest) + (x > right(core) ? 1 : 0);
      let shifts = marginTranslations(model, groups, split, x, width, prior, fixedSources);
      if (!shifts) {
        // A source or earlier corridor blocks propagation. An exterior corridor needs no movement.
        const left = Math.min(...groups.map(group => occupied(model, group).x), ...prior.map(lane => lane.bounds.x)) - half;
        const rightX = Math.max(...groups.map(group => right(occupied(model, group))), ...prior.map(lane => right(lane.bounds))) + half;
        x = Math.abs(left - sx) <= Math.abs(rightX - sx) ? left : rightX;
        shifts = groups.map(() => 0);
      }
      const moved: string[] = [];
      for (const [index, group] of groups.entries()) {
        const dx = shifts[index]!;
        if (!dx) continue;
        moveGroup(model, group, dx, 0); moved.push(...group.nodes);
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
    if (lane.side === 'left' ? lane.x >= group.bounds!.x : lane.x <= right(group.bounds!)) throw new Error('Lane side contradicts its group');
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
