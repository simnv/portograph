import type { Point, Rect, Side } from '../model/geometry.js';
import { stemDepth, type GapPlan } from './sides-two.js';
import type { PortRef } from '../model/document.js';
import type { LabelBand, LayoutGroup, LayoutLabel, LayoutModel, LayoutNode, LayoutPort, Owner, PathSegment } from '../model/layout.js';
import { equal } from '../model/json-equality.js';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
import { orderedGroupIds } from '../model/model.js';
import { FONT_FAMILY, measureText } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { createCentreBudget, type CentreBudget } from './centre.js';
import { laneSidesHold } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { findPort, straightCorridorClear } from './row-paths.js';
import { bandGap, portId } from './skeleton-graph.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { bottom, fitRegionGroup, GROUP_PADDING, groupPadding, placementWarning, rebuildRegions, right } from './regions.js';
import { withLayoutMutation } from './mutation.js';
import { effectiveLayer } from '../score/model.js';
import { LINK_LABEL_GEOMETRY, overlayLabelsSuppressed } from './link-labels.js';
import { OVERLAY_PILL_CLEARANCE } from './overlay-paths.js';

const EPS = 1e-6;
export const GROUP_LABEL_GEOMETRY = {
  fontFamily: FONT_FAMILY,
  fontSize: 12,
  fontWeight: 700 as const,
  horizontalInset: 8,
  verticalInset: 4,
  bandExtra: 8,
  /** Shortest outward routing checkpoint stage 8 may use for an ordinary attachment. */
  routerStem: 15,
  /** G6 node clearance; stage 8 expands each node obstacle by this plus the two half strokes. */
  nodeClearance: 10,
  /** Keeps a required entry point strictly outside a stroke-aware obstacle, not on its boundary. */
  entryTolerance: 0.25,
} as const;
const OUTWARD: Record<Side, Point> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

interface ForbiddenInterval { low: number; high: number; id: string }
interface LabelPlan { labels: LayoutLabel[]; growth?: { group: LayoutGroup; width: number }; blocked: string[] }
/** Where one tier's groups land when the grown group takes its new width. */
interface GroupPlacement { group: LayoutGroup; x: number; width: number }
/** A point stage 8 must reach outside every obstacle to honour this placement. */
export interface RouterEntryPoint {
  link: string;
  end: 'from' | 'to';
  node: string;
  port: PortRef;
  side: Side;
  kind: 'stem' | 'shared';
  point: Point;
  /** Distance of `point` from the anchor along the port's outward normal. */
  outward: number;
}

function measurement(model: LayoutModel, groupId: string) {
  return measureText(model.document.groups[groupId]!.label,
    { fontSize: GROUP_LABEL_GEOMETRY.fontSize, weight: GROUP_LABEL_GEOMETRY.fontWeight });
}

/**
 * Widest routed stroke this placement must keep clear; stage 8 may not exceed it.
 *
 * Memoised on the link array for the same reason as `routedStrokeWidth`, and under the same rule:
 * every reservation that is stroke-aware asks for this number, many of them inside per-port or
 * per-pair loops, and `layer` and `strokeWidth` are written in stage 1 alone, so one array
 * identity has one answer.
 */
const widestRoutedStroke = new WeakMap<readonly LayoutModel['links'][number][], number>();
export function routedStroke(model: LayoutModel): number {
  const memo = widestRoutedStroke.get(model.links);
  if (memo !== undefined) return memo;
  let widest: number = DEFAULT_STROKE_WIDTHS.path;
  for (const link of model.links) {
    if (link.layer !== 'routed') continue;
    const width = linkStrokeWidth(link);
    if (width > widest) widest = width;
  }
  widestRoutedStroke.set(model.links, widest);
  return widest;
}
function strokeAllowance(model: LayoutModel): number { return routedStroke(model) / 2; }

/**
 * How far a node's routing obstacle reaches beyond its drawn rectangle. This is the one definition
 * of that distance; `route/obstacles` builds the rectangle itself from the same constants, and
 * placement reserves against it before any path exists.
 */
export function nodeObstacleReach(model: LayoutModel, node: LayoutModel['nodes'][string],
  stroke = routedStroke(model)): number {
  return GROUP_LABEL_GEOMETRY.nodeClearance + ((node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) + stroke) / 2;
}

/**
 * How far apart the router nudges two routes that run side by side, and so the least room a
 * reservation must leave beside anything another link still has to reach: at less than this the
 * router refuses the corridor rather than narrowing it. `routeParameters` hands this exact figure to
 * libavoid as `idealNudgingDistance`, and placement measures against the same one, so a reservation
 * cannot leave a gap stage 8 will not use.
 */
export function nudgingDistance(model: LayoutModel): number {
  return GROUP_LABEL_GEOMETRY.nodeClearance + routedStroke(model);
}

/**
 * Outward distance of the ordinary checkpoint at a node. It is the 15 px stem, unless that node's
 * stroke-expanded routing obstacle already reaches further; then it clears that obstacle instead.
 */
export function stemReach(model: LayoutModel, node: LayoutModel['nodes'][string]): number {
  return Math.max(GROUP_LABEL_GEOMETRY.routerStem, nodeObstacleReach(model, node) + GROUP_LABEL_GEOMETRY.entryTolerance);
}

/**
 * Every outward point stage 8 must consume: the ordinary 15 px checkpoint of each routed
 * attachment and each vertex of its mandatory shared prefix. Neither input depends on whether the
 * link already carries a path, so completing a remainder in stage 8 cannot retire the reservation.
 */
export function routerEntryPoints(model: LayoutModel): RouterEntryPoint[] {
  const result: RouterEntryPoint[] = [];
  // One gap plan per row gap for this pass; nothing moves while it runs.
  const gaps = new Map<string, GapPlan | undefined>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const end of ['from', 'to'] as const) {
      const ref = link.attachments[end], port = findPort(model, ref);
      if (!port?.anchor || !port.side) continue;
      const anchor = port.anchor, delta = OUTWARD[port.side];
      const common = { link: link.id, end, node: ref.node, port: { ...port.ref }, side: port.side };
      // The same figure `stemCheckpoint` gives stage 8, a leg's reserved slot included.
      const stem = stemDepth(model, port, gaps);
      result.push({ ...common, kind: 'stem', outward: stem,
        point: { x: anchor.x + stem * delta.x, y: anchor.y + stem * delta.y } });
      for (const segment of link.sharedRuns?.[end] ?? []) for (const point of [segment.from, segment.to]) {
        result.push({ ...common, kind: 'shared', point: { ...point },
          outward: (point.x - anchor.x) * delta.x + (point.y - anchor.y) * delta.y });
      }
    }
  }
  return result;
}

/** Keep required entry points below the band, reserving clearance for any valid label position. */
export function bandEntryConflicts(model: LayoutModel, entries = routerEntryPoints(model)): { band: LabelBand; entry: RouterEntryPoint }[] {
  const allowance = strokeAllowance(model), result: { band: LabelBand; entry: RouterEntryPoint }[] = [];
  for (const entry of entries) for (const band of model.labelBands) {
    const box = band.bounds;
    if (entry.point.x >= box.x - allowance - EPS && entry.point.x <= right(box) + allowance + EPS
      && entry.point.y >= box.y - allowance - EPS && entry.point.y <= bottom(box) + allowance + EPS) result.push({ band, entry });
  }
  return result;
}

/**
 * The edge a group's title occupies: the horizontal edge with fewer incident routed link ports, so
 * the title sits opposite the links that enter the group and nothing has to route around it. Ties,
 * including groups linked only through left/right ports, keep the top. Reads frozen port topology
 * only, so placement, publication and restore agree.
 */
export function bandSide(model: LayoutModel, group: LayoutGroup): 'top' | 'bottom' {
  const members = new Set(group.nodes), counts = { top: 0, bottom: 0 };
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const ref of [link.attachments.from, link.attachments.to]) {
      if (!members.has(ref.node)) continue;
      const side = findPort(model, ref)?.side;
      if (side === 'top' || side === 'bottom') counts[side]++;
    }
  }
  return counts.top > counts.bottom ? 'bottom' : 'top';
}

/** Reserved gap beside the band; entry points of this group's own ports on that side must clear it. */
function clearanceFor(model: LayoutModel, group: LayoutGroup, entries: RouterEntryPoint[], side: 'top' | 'bottom'): number {
  const members = new Set(group.nodes);
  const reach = Math.max(0, ...entries.filter(entry => entry.side === side && members.has(entry.node)).map(entry => entry.outward));
  const room = detourLabelRoom(model, group);
  if (reach <= 0) return Math.max(groupPadding(model, group)[side], room);
  return Math.max(groupPadding(model, group)[side], room, reach + strokeAllowance(model) + GROUP_LABEL_GEOMETRY.entryTolerance);
}

type SameTierEnds = { leftPort: LayoutPort; leftNode: LayoutNode; rightPort: LayoutPort; rightNode: LayoutNode };
/**
 * The one reading of which same-tier described links have a run to lengthen (ADR-0014): both ports
 * on a left or right side, and facing each other across the gap — a right port on the left end, a
 * left port on the right end. Ports on the same side, or facing away, wrap around their nodes and
 * the router places the wrapping leg where it likes, so no anchor distance bounds that run. The
 * reservation and the title-band clearance both ask here, so neither moves anything for a link the
 * other diagnoses.
 */
function sameTierEnds(from: LayoutPort, fromNode: LayoutNode, to: LayoutPort, toNode: LayoutNode): SameTierEnds | { unreservable: string } {
  if (!['left', 'right'].includes(from.side!) || !['left', 'right'].includes(to.side!)) return { unreservable: 'joins two nodes of one tier through top or bottom ports' };
  const [leftPort, leftNode, rightPort, rightNode] = from.anchor!.x <= to.anchor!.x ? [from, fromNode, to, toNode] : [to, toNode, from, fromNode];
  if (leftPort.side !== 'right' || rightPort.side !== 'left') return { unreservable: 'does not face its peer across the gap' };
  return { leftPort, leftNode, rightPort, rightNode };
}

/**
 * A described link between two nodes of one row that has a third node between them will detour
 * around that node, hugging it at node clearance, and its label then follows that run (ADR-0014).
 * The band under the title reserves the room that label needs: the title's link margin, the label
 * height, its normal gap and stroke, and the node clearance the run keeps. Without it the run sits
 * between the title margin and the node with no side free, and the longest segment goes unused.
 */
function detourLabelRoom(model: LayoutModel, group: LayoutGroup): number {
  let room = 0;
  for (const link of model.links) {
    const text = model.document.links[link.sourceIndex]?.label;
    if (!text || link.layer !== 'routed' || link.technique === 'stub' || link.bundle || !link.attachments) continue;
    if (effectiveLayer(link) === 'overlay') continue;
    const fromTier = model.groups[model.document.nodes[link.attachments.from.node]!.group]!.tier;
    if (fromTier !== group.tier || model.groups[model.document.nodes[link.attachments.to.node]!.group]!.tier !== group.tier) continue;
    const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
    if (!from?.anchor || !to?.anchor || link.attachments.from.node === link.attachments.to.node) continue;
    const ends = sameTierEnds(from, model.nodes[link.attachments.from.node]!, to, model.nodes[link.attachments.to.node]!);
    if ('unreservable' in ends) continue;
    const low = ends.leftPort.anchor!.x, high = ends.rightPort.anchor!.x;
    // The detour runs over this group's nodes when one of them lies between the two ends of the link.
    const between = group.nodes.some(id => id !== link.attachments!.from.node && id !== link.attachments!.to.node
      && model.nodes[id]!.bounds!.x < high && right(model.nodes[id]!.bounds!) > low);
    if (!between) continue;
    const measured = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });
    const nodeStroke = Math.max(DEFAULT_STROKE_WIDTHS.node, ...group.nodes.map(id => model.nodes[id]!.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node));
    room = Math.max(room, GROUP_LABEL_LINK_CLEARANCE + measured.height + LINK_LABEL_GEOMETRY.normalGap + linkStrokeWidth(link)
      + GROUP_LABEL_GEOMETRY.nodeClearance + (nodeStroke + linkStrokeWidth(link)) / 2 + GROUP_LABEL_GEOMETRY.entryTolerance);
  }
  return room;
}

function bandFor(model: LayoutModel, groupId: string, entries: RouterEntryPoint[]): LabelBand {
  const group = model.groups[groupId]!, measured = measurement(model, groupId), side = bandSide(model, group);
  const height = measured.height + GROUP_LABEL_GEOMETRY.bandExtra;
  return { id: `label-band:${groupId}`, group: groupId, owner: { ...group.owner }, layer: 'routed', side,
    bounds: { x: group.bounds!.x, y: side === 'top' ? group.bounds!.y : bottom(group.bounds!) - height,
      width: group.bounds!.width, height },
    clearance: clearanceFor(model, group, entries, side) };
}

/**
 * Rebuild every band from current group geometry; reports a changed reservation for replay.
 * Reserved link geometry is rebuilt only by the ordered replay, so a caller that has just moved
 * boxes must supply the entry points it measured while the two agreed.
 */
function syncBands(model: LayoutModel, entries = routerEntryPoints(model)): boolean {
  const before = new Map(model.labelBands.map(band => [band.group, band.clearance]));
  model.labelBands = orderedGroupIds(model.document).map(id => bandFor(model, id, entries));
  return model.labelBands.some(band => before.has(band.group) && Math.abs(before.get(band.group)! - band.clearance) > EPS);
}

function intersectsY(rect: Rect, y: number, height: number): boolean {
  return rect.y <= y + height + EPS && bottom(rect) >= y - EPS;
}

/** Identity of one owned rectangle, taken from semantic fields so key order cannot change it. */
function ownedRectKey(bounds: Rect, owner: Owner): string {
  const fields = owner.kind === 'barCross' ? [owner.node, owner.link] : [owner.id];
  // An array keeps the field order fixed, and string escaping keeps an authored ID unambiguous.
  return JSON.stringify([bounds.x, bounds.y, bounds.width, bounds.height, owner.kind, ...fields]);
}

function segmentRect(segment: PathSegment, stroke: number): Rect {
  const x = Math.min(segment.from.x, segment.to.x) - stroke, y = Math.min(segment.from.y, segment.to.y) - stroke;
  return { x, y, width: Math.abs(segment.to.x - segment.from.x) + 2 * stroke,
    height: Math.abs(segment.to.y - segment.from.y) + 2 * stroke };
}

/**
 * Reserved link geometry in one stable order: the complete path, partially fixed lane runs, then
 * the mandatory outward shared runs of both ends. A complete bundle path repeats the runs it
 * consumed, so identical stroke-aware rectangles with identical ownership collapse to one entry.
 */
function linkRects(link: LayoutModel['links'][number]): ForbiddenRect[] {
  const stroke = linkStrokeWidth(link) / 2;
  // A stage-8 remainder (`fixed: false`) is routed around this placement, so only the runs a rule
  // reserved count here; re-deriving a label against a later route would let routing move it.
  const reserved = link.path?.fixed === false ? [] : link.path?.segments ?? [];
  const sources: [string, PathSegment[]][] = [['path', reserved],
    ['fixed', link.fixedSegments ?? []], ['shared:from', link.sharedRuns?.from ?? []],
    ['shared:to', link.sharedRuns?.to ?? []]];
  const seen = new Set<string>(), result: ForbiddenRect[] = [];
  for (const [kind, segments] of sources) for (const [index, segment] of segments.entries()) {
    const bounds = segmentRect(segment, stroke), key = ownedRectKey(bounds, segment.owner);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id: `${link.id}:${kind}:${index}`, bounds, clearance: GROUP_LABEL_LINK_CLEARANCE });
  }
  return result;
}

/** A reserved rectangle a label must avoid; `clearance` is the title's link-free margin for link geometry. */
export interface ForbiddenRect { id: string; bounds: Rect; clearance?: number }

/** Every reserved rectangle a group label must avoid, with stable semantic IDs. */
export function groupLabelObstacles(model: LayoutModel, placed: LayoutLabel[] = []): ForbiddenRect[] {
  return forbiddenRects(model, placed);
}

function forbiddenRects(model: LayoutModel, placed: LayoutLabel[]): ForbiddenRect[] {
  const result: ForbiddenRect[] = [];
  for (const node of Object.values(model.nodes)) {
    const half = (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) / 2;
    result.push({ id: `node:${node.id}`, bounds: { x: node.bounds!.x - half, y: node.bounds!.y - half,
      width: node.bounds!.width + 2 * half, height: node.bounds!.height + 2 * half } });
    for (const port of node.ports) if (port.pill) {
      const p = port.pill.bounds, gap = DEFAULT_STROKE_WIDTHS.pill / 2;
      result.push({ id: `pill:${portId(port.ref)}`, bounds: {
        x: p.x - gap, y: p.y - gap, width: p.width + 2 * gap, height: p.height + 2 * gap,
      } });
    }
  }
  // Stage 9 labels are placed around this band, so re-deriving the band around them would let a
  // later label move an earlier frozen one. That covers the generated legend below the diagram as
  // well. Group labels are replanned here and join through `placed`.
  const stageNine = (role: string | undefined): boolean => role === 'link' || role === 'legend';
  for (const label of [...model.labels.filter(item => item.role !== 'group' && !stageNine(item.role)), ...placed]) {
    if (!label.omitted && label.layer !== 'overlay' && label.bounds) result.push({ id: label.id, bounds: label.bounds });
  }
  const margin = GROUP_LABEL_LINK_CLEARANCE;
  for (const lane of model.lanes) if (lane.layer !== 'overlay') result.push({ id: lane.id, bounds: lane.bounds, clearance: margin });
  for (const bundle of model.bundles) {
    for (const [index, bounds] of (bundle.envelopeParts?.length ? bundle.envelopeParts : bundle.envelope ? [bundle.envelope] : [] as Rect[]).entries()) {
      result.push({ id: `${bundle.id}:envelope:${index}`, bounds, clearance: margin });
    }
  }
  for (const obstacle of model.obstacles) if (obstacle.layer !== 'overlay') result.push({ id: obstacle.id, bounds: obstacle.bounds, clearance: margin });
  for (const link of model.links) result.push(...linkRects(link), ...feedCorridorRects(model, link));
  return result;
}

/**
 * A top/bottom feed whose two anchors already share an x, and whose straight corridor is clear of
 * everything placement has fixed, will be routed as that straight line in stage 8. The corridor is
 * therefore reserved here, so a label is never placed where the route then has to detour around it
 * — the pipeline's load-bearing rule. The check ignores group labels (this stage places them) and
 * stage-9 labels, so planning and restore see the same corridor.
 */
function feedCorridorRects(model: LayoutModel, link: LayoutModel['links'][number]): ForbiddenRect[] {
  if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments || link.bundle) return [];
  if (link.path && link.path.fixed !== false) return [];
  const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
  if (!from?.anchor || !to?.anchor || !from.side || !to.side) return [];
  const vertical = (from.side === 'bottom' && to.side === 'top') || (from.side === 'top' && to.side === 'bottom');
  if (!vertical || Math.abs(from.anchor.x - to.anchor.x) > EPS) return [];
  const segment: PathSegment = { from: { ...from.anchor }, to: { ...to.anchor }, owner: { kind: 'link', id: link.id } };
  const stageNine = (role: string | undefined): boolean => role === 'link' || role === 'legend';
  const view: LayoutModel = { ...model, labels: model.labels.filter(label => label.role !== 'group' && !stageNine(label.role)) };
  if (!straightCorridorClear(view, link, segment)) return [];
  return [{ id: `${link.id}:feed-corridor`, bounds: segmentRect(segment, linkStrokeWidth(link) / 2), clearance: GROUP_LABEL_LINK_CLEARANCE }];
}

function intervals(model: LayoutModel, placed: LayoutLabel[], y: number, height: number, width: number): ForbiddenInterval[] {
  // Link geometry keeps the title's link-free margin on every side; nodes, pills and labels do not.
  const raw = forbiddenRects(model, placed).filter(item => intersectsY(item.bounds, y - (item.clearance ?? 0), height + 2 * (item.clearance ?? 0))).map(item => ({
    low: item.bounds.x - width - (item.clearance ?? 0), high: right(item.bounds) + (item.clearance ?? 0), id: item.id,
  })).sort((a, b) => a.low - b.low || a.high - b.high || a.id.localeCompare(b.id));
  const merged: ForbiddenInterval[] = [];
  for (const item of raw) {
    const prior = merged.at(-1);
    if (prior && item.low <= prior.high + EPS) prior.high = Math.max(prior.high, item.high);
    else merged.push({ ...item });
  }
  return merged;
}

function firstFree(start: number, ranges: ForbiddenInterval[]): number {
  let candidate = start;
  for (const range of ranges) {
    if (range.high < candidate - EPS) continue;
    if (range.low > candidate + EPS) break;
    candidate = range.high + EPS;
  }
  return candidate;
}

/**
 * Where widening `grown` to `width` leaves every group of its tier, or nothing when the request is
 * not a widening or would move a group out of the window its tier's reserved lanes leave it. Lane
 * geometry cannot move, so a label gap that only a crossing movement could reach is infeasible and
 * the group keeps its width; `planLabels` and `reserveInitialSpace` share this one decision.
 */
function growthPlan(model: LayoutModel, grown: LayoutGroup, width: number): GroupPlacement[] | undefined {
  const groups = Object.values(model.groups).filter(group => group.tier === grown.tier)
    .sort((a, b) => a.bounds!.x - b.bounds!.x || a.id.localeCompare(b.id));
  const at = groups.indexOf(grown);
  if (at < 0 || width <= grown.bounds!.width + EPS) return undefined;
  const gaps = groups.slice(0, -1).map((group, index) => groups[index + 1]!.bounds!.x - right(group.bounds!));
  const plan: GroupPlacement[] = groups.map(group => ({ group, x: group.bounds!.x, width: group.bounds!.width }));
  plan[at]!.width = width;
  for (let index = at + 1; index < plan.length; index++) {
    const prior = plan[index - 1]!, minimum = prior.x + prior.width + Math.max(gaps[index - 1]!, bandGap(model));
    if (plan[index]!.x < minimum - EPS) plan[index]!.x = minimum;
  }
  return laneSidesHold(model, plan.map(item => ({ group: item.group,
    bounds: { ...item.group.bounds!, x: item.x, width: item.width } }))) ? plan : undefined;
}

function planLabels(model: LayoutModel, permitGrowth: boolean): LabelPlan {
  const labels: LayoutLabel[] = [], blocked: string[] = [];
  for (const id of orderedGroupIds(model.document)) {
    const group = model.groups[id]!, measured = measurement(model, id);
    const band = model.labelBands.find(item => item.group === id);
    const y = (band ? band.bounds.y : group.bounds!.y) + GROUP_LABEL_GEOMETRY.verticalInset;
    const start = group.bounds!.x + GROUP_LABEL_GEOMETRY.horizontalInset;
    const limit = right(group.bounds!) - GROUP_LABEL_GEOMETRY.horizontalInset - measured.width;
    const ranges = intervals(model, labels, y, measured.height, measured.width);
    const centre = group.bounds!.x + (group.bounds!.width - measured.width) / 2;
    const candidates = [centre, start, limit, ...ranges.flatMap(range => [range.low - 2 * EPS, range.high + 2 * EPS])]
      .filter(x => x >= start - EPS && x <= limit + EPS && ranges.every(range => x < range.low - EPS || x > range.high + EPS))
      .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
    const x = candidates[0] ?? firstFree(start, ranges);
    if (x > limit + EPS) {
      // Classify every group that needs to grow, so an exhausted budget still reports the ones
      // that no budget could have repaired.
      const width = x + measured.width + GROUP_LABEL_GEOMETRY.horizontalInset - group.bounds!.x;
      if (!growthPlan(model, group, width)) blocked.push(id);
      else if (permitGrowth) return { labels, blocked, growth: { group, width } };
    }
    labels.push({ id: `label:group:${id}`, owner: { ...group.owner }, layer: 'routed', role: 'group',
      text: model.document.groups[id]!.label, fontFamily: GROUP_LABEL_GEOMETRY.fontFamily,
      fontSize: GROUP_LABEL_GEOMETRY.fontSize, fontWeight: GROUP_LABEL_GEOMETRY.fontWeight,
      lineHeight: measured.lineHeight, lines: measured.lines, textRotation: 0,
      bounds: { x: x <= limit + EPS ? x : group.bounds!.x + GROUP_LABEL_GEOMETRY.horizontalInset,
        y, width: measured.width, height: measured.height } });
  }
  return { labels, blocked };
}

/** Apply a lane-feasible widening and its neighbour propagation. An infeasible one does nothing. */
function pushFollowingGroups(model: LayoutModel, grown: LayoutGroup, width: number): void {
  const plan = growthPlan(model, grown, width);
  if (!plan) return;
  grown.bounds!.width = width;
  const moved: string[] = [];
  for (const item of plan) {
    const dx = item.x - item.group.bounds!.x;
    if (item.group !== grown && dx) { moveGroup(model, item.group, dx, 0); moved.push(...item.group.nodes); }
  }
  // `moveGroup` leaves pill bounds behind, and the next reservation measures them. Only horizontal
  // movement can invalidate a lane window, so the vertical band shift needs no rebuild here.
  if (moved.length) rebuildNodeGeometry(model, moved, 'current');
}

/** A group boxed in by reserved lanes keeps a coherent contained label; final gates decide it. */
function diagnoseBlocked(model: LayoutModel, blocked: string[]): void {
  for (const id of blocked) {
    placementWarning(model, 'GROUP_LABEL_GAP_INFEASIBLE', `Group ${id} has no free label gap between `
      + 'the reserved lanes of its tier; final gates decide the retained geometry.', [id], 'group');
  }
}

function consumeGrowthPass(budget: CentreBudget, before: number): void {
  if (budget.passes !== before) return;
  if (budget.remaining <= 0) return;
  budget.remaining--; budget.passes++;
}

function reserveInitialSpace(model: LayoutModel): void {
  const before = new Map(model.tierBands.map(band => [band.tier, { ...band.bounds! }]));
  // The room each group already holds for a band on that side, from the reservation it carries now.
  // 7f calls this producer twice — labels, tier gap room, labels again — so the shift has to be the
  // room still missing, never the whole band again. The map is empty on the first call, where the
  // group holds the ordinary padding and the shift is the whole band beyond it.
  const held = new Map(model.labelBands.map(band => [band.group, band]));
  const entries = routerEntryPoints(model);
  syncBands(model, entries);
  // The band replaces the ordinary padding on its side, and its clearance replaces that padding
  // beside it. A top band pushes its nodes down; a bottom band only grows the box downward. Nodes
  // of one tier keep one row: every group moves its nodes down by the largest top-band shift of its
  // tier — a smaller clearance or a bottom title never breaks the row levelling of stage 6, and a
  // flank stays level with the peer whose band grew more.
  const shifts = new Map(orderedGroupIds(model.document).map(id => {
    const group = model.groups[id]!, band = model.labelBands.find(item => item.group === id)!;
    const prior = held.get(id);
    const room = prior !== undefined && prior.side === band.side
      ? prior.bounds.height + prior.clearance : groupPadding(model, group)[band.side];
    return [id, band.bounds.height + band.clearance - room];
  }));
  const topShift = (tier: number) => Math.max(0, ...orderedGroupIds(model.document)
    .filter(id => model.groups[id]!.tier === tier && model.labelBands.find(item => item.group === id)!.side === 'top')
    .map(id => shifts.get(id)!));
  for (const id of orderedGroupIds(model.document)) {
    const group = model.groups[id]!, band = model.labelBands.find(item => item.group === id)!, shift = shifts.get(id)!;
    const down = Math.max(band.side === 'top' ? shift : 0, topShift(group.tier!));
    for (const nodeId of group.nodes) {
      const node = model.nodes[nodeId]!;
      node.bounds!.y += down;
      for (const port of node.ports) port.anchor!.y += down;
    }
    group.bounds!.height += band.side === 'top' ? down : down + shift;
    pushFollowingGroups(model, group, Math.max(group.bounds!.width,
      measurement(model, id).width + 2 * GROUP_LABEL_GEOMETRY.horizontalInset));
  }
  rebuildBands(model);
  let shift = 0;
  for (const tierBand of [...model.tierBands].sort((a, b) => a.tier - b.tier)) {
    if (shift) for (const group of Object.values(model.groups).filter(item => item.tier === tierBand.tier)) moveGroup(model, group, 0, shift);
    shift += Math.max(0, tierBand.bounds!.height - (before.get(tierBand.tier)?.height ?? tierBand.bounds!.height));
  }
  rebuildBands(model);
  syncBands(model, entries);
}


/**
 * Largest size difference, as a fraction of the shared extent, that the linked-group grid closes.
 * The maintainer first asked for "about 10 %"; the fixtures that motivated the rule (one-px-sources,
 * bar-both-sides) need 21 % and 26 %, and the maintainer confirmed 30 %. One number, here.
 */
export const GROUP_GRID_MAX_GROWTH = 0.30;

interface LinkedPair { a: LayoutGroup; b: LayoutGroup; axis: 'x' | 'y' }
/** Groups joined by a routed link: vertical ports across tiers share x, horizontal ports share y. */
function linkedGroupPairs(model: LayoutModel): LinkedPair[] {
  const seen = new Set<string>(), result: LinkedPair[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
    const a = model.groups[model.document.nodes[link.attachments.from.node]!.group]!;
    const b = model.groups[model.document.nodes[link.attachments.to.node]!.group]!;
    if (!from?.side || !to?.side || a === b) continue;
    const vertical = ['top', 'bottom'].includes(from.side) && ['top', 'bottom'].includes(to.side);
    const horizontal = ['left', 'right'].includes(from.side) && ['left', 'right'].includes(to.side);
    if (!vertical && !horizontal) continue;
    const key = [a.id, b.id].sort().join('\u0000') + (vertical ? ':x' : ':y');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ a, b, axis: vertical ? 'x' : 'y' });
  }
  return result;
}
const rectOverlap = (p: Rect, q: Rect): boolean => p.x < right(q) - EPS && q.x < right(p) - EPS && p.y < bottom(q) - EPS && q.y < bottom(p) - EPS;

/**
 * Linked groups share a grid (ADR-0012): two groups joined by vertical links take one x-extent, two
 * joined by horizontal links take one y-extent, whenever neither box is smaller than that union by
 * more than `GROUP_GRID_MAX_GROWTH` of it. Boxes only grow, nodes never move, and a union
 * that would overlap another group or cross a reserved lane window is skipped. Chains converge in
 * a bounded number of passes because every pass only merges extents.
 */
export function alignLinkedGroupGrid(model: LayoutModel): boolean {
  let changed = false;
  // Extents only grow and only ever onto existing box edges, so the process terminates; the cap
  // exhausting is a defect signal, not a design bound. Pairs × groups passes cover any cascade in
  // which each pass enables one more merge under the cap.
  const groupCount = Object.keys(model.groups).length;
  const bound = groupCount * Math.max(1, linkedGroupPairs(model).length) + 2;
  let pass = 0;
  for (; pass < bound; pass++) {
    let moved = false;
    for (const { a, b, axis } of linkedGroupPairs(model)) {
      const [pos, len] = axis === 'x' ? ['x', 'width'] as const : ['y', 'height'] as const;
      const low = Math.min(a.bounds![pos], b.bounds![pos]);
      const high = Math.max(a.bounds![pos] + a.bounds![len], b.bounds![pos] + b.bounds![len]);
      const extent = high - low;
      if (Math.abs(a.bounds![len] - extent) <= EPS && Math.abs(b.bounds![len] - extent) <= EPS) continue;
      if ((extent - a.bounds![len]) / extent > GROUP_GRID_MAX_GROWTH + EPS
        || (extent - b.bounds![len]) / extent > GROUP_GRID_MAX_GROWTH + EPS) continue;
      const proposed = [a, b].map(group => ({ group, bounds: { ...group.bounds!, [pos]: low, [len]: extent } as Rect }));
      const others = Object.values(model.groups).filter(group => group !== a && group !== b);
      if (proposed.some(item => others.some(other => rectOverlap(item.bounds, other.bounds!)))) continue;
      if (axis === 'x' && !laneSidesHold(model, proposed)) continue;
      for (const item of proposed) item.group.bounds = item.bounds;
      moved = changed = true;
    }
    if (!moved) break;
  }
  if (pass >= bound) placementWarning(model, 'GROUP_GRID_NON_CONVERGENCE', 'Linked-group grid did not settle within its pass bound; final gates decide the retained boxes.', [], 'group');
  if (changed) { rebuildBands(model); rebuildRegions(model); }
  return changed;
}


/**
 * A link's description influences its length (ADR-0014): the run a label will follow must be long
 * enough for the measured text plus the shortening margins before anything is routed. Stage 9
 * centres the label on the run's midpoint, so the room is measured symmetrically about the anchor
 * midpoint out to the nearer pill face (or node edge). A link between two tiers moves every lower
 * tier down by the deficit. A link between two ends of one tier inserts the room at the gap itself:
 * every group starting at or beyond the split moves right, in every tier; in a straddling group a
 * node of the link's own tier moves when it starts beyond the split (a node the detour passes stays
 * by the left end) and a node of any other tier when any part of it lies beyond (a wide source moves
 * with the bar slotted under it), so alignments, flank sides and bar-to-source slots all move alike.
 * A routed link that will detour (ends that are not level, or a straight run `straightCorridorClear`
 * rejects) adds both stroke-aware stems and the anchor-side pill protrusion. Every authored label on
 * a drawn link counts — bars, overlay links whose labels are not suppressed — except bundle members,
 * whose geometry 7e owns. Self-links, same-tier links through top/bottom ports, pairs whose ports do
 * not face each other and links whose room lies beyond a reserved lane are diagnosed and left to the
 * stage 9 ladder.
 */
export function reserveLinkLabelRoom(model: LayoutModel): boolean {
  let changed = false;
  const suppressed = overlayLabelsSuppressed(model);
  const outer = (port: LayoutPort, node: LayoutNode): Rect => port.pill ? port.pill.bounds : node.bounds!;
  const settle = (nodes: string[]): void => { if (nodes.length) rebuildNodeGeometry(model, nodes, 'current'); };
  for (const link of model.links) {
    const text = model.document.links[link.sourceIndex]?.label;
    if (!text || link.technique === 'stub' || link.bundle || !link.attachments) continue;
    if (effectiveLayer(link) === 'overlay' && suppressed) continue;
    const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
    if (!from?.anchor || !to?.anchor) continue;
    const fromNode = model.nodes[link.attachments.from.node]!, toNode = model.nodes[link.attachments.to.node]!;
    const fromGroup = model.groups[model.document.nodes[fromNode.id]!.group]!, toGroup = model.groups[model.document.nodes[toNode.id]!.group]!;
    const unreserved = (why: string): void => placementWarning(model, 'LINK_LABEL_ROOM_UNRESERVED', `${link.id} ${why}; its label room cannot be reserved and the stage 9 ladder decides.`, [link.id]);
    if (fromNode === toNode) { unreserved('returns to its own node'); continue; }
    const measured = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });
    // An overlay link leaves each port one clearance beyond its own outward face before it turns, so
    // the run its label rides starts that far in from each face (synthetics review ticket 01). Where
    // the detour puts the long run on the other axis entirely, 7f cannot reserve for it at all and
    // the stage 9 ladder decides, as it does for a link whose room lies beyond a reserved lane.
    const required = measured.width + 2 * LINK_LABEL_GEOMETRY.shortenMargin
      + (effectiveLayer(link) === 'overlay' ? 2 * OVERLAY_PILL_CLEARANCE : 0);
    if (fromGroup.tier !== toGroup.tier) {
      const [upper, lower, upperPort, lowerPort] = fromNode.bounds!.y <= toNode.bounds!.y ? [fromNode, toNode, from, to] : [toNode, fromNode, to, from];
      const upperTier = model.groups[model.document.nodes[upper.id]!.group]!.tier!;
      const mid = (upperPort.anchor!.y + lowerPort.anchor!.y) / 2;
      const room = 2 * Math.min(mid - Math.max(bottom(upper.bounds!), bottom(outer(upperPort, upper))), Math.min(lower.bounds!.y, outer(lowerPort, lower).y) - mid);
      const deficit = required - room;
      if (deficit <= EPS) continue;
      const moved = Object.values(model.groups).filter(group => group.tier! > upperTier);
      for (const group of moved) moveGroup(model, group, 0, deficit);
      settle(moved.flatMap(group => group.nodes));
      changed = true;
      continue;
    }
    const ends = sameTierEnds(from, fromNode, to, toNode);
    if ('unreservable' in ends) { unreserved(ends.unreservable); continue; }
    const { leftPort, leftNode, rightPort, rightNode } = ends;
    const low = leftPort.anchor!.x, high = rightPort.anchor!.x, mid = (low + high) / 2;
    // A routed link detours when its ends are not level or when the straight run between them is not
    // clear — the same stroke-aware reading of nodes, pills, foreign group boxes with their margin,
    // lanes, fixed runs and bundle rows and envelopes that pins row paths and reserves corridors
    // (`straightCorridorClear`).
    const straight: PathSegment = { from: { ...leftPort.anchor! }, to: { ...rightPort.anchor! }, owner: { ...link.owner } };
    const detour = effectiveLayer(link) !== 'overlay'
      && (Math.abs(leftPort.anchor!.y - rightPort.anchor!.y) > EPS || !straightCorridorClear(model, link, straight));
    const room = 2 * Math.min(mid - Math.max(right(leftNode.bounds!), right(outer(leftPort, leftNode))), Math.min(rightNode.bounds!.x, outer(rightPort, rightNode).x) - mid);
    // A detour's long run ends at an anchor on one side and at a turn on the other, so its midpoint is
    // not the pill-face midpoint: the label centred there must clear the pill on the anchor side.
    const protrusion = Math.max(right(outer(leftPort, leftNode)) - leftPort.anchor!.x, rightPort.anchor!.x - outer(rightPort, rightNode).x, 0);
    const deficit = required + (detour ? stemReach(model, leftNode) + stemReach(model, rightNode) + 2 * protrusion : 0) - room;
    if (deficit <= EPS) continue;
    // Insert the room at the gap itself: everything at or right of the split — in every tier — moves
    // right together, and a group straddling the split shifts only its nodes beyond it. Alignments,
    // flank sides and bar-to-source slots all survive because both ends of each of them move alike;
    // nothing ever moves left into a preceding group. A reserved lane at or beyond the split cannot
    // move, so such a link is diagnosed instead.
    const split = (Math.max(right(leftNode.bounds!), right(outer(leftPort, leftNode))) + Math.min(rightNode.bounds!.x, outer(rightPort, rightNode).x)) / 2;
    if (model.lanes.some(lane => lane.x >= split - EPS)) { unreserved('needs room beyond a reserved lane'); continue; }
    const moved: string[] = [];
    for (const group of Object.values(model.groups)) {
      if (group.bounds!.x >= split - EPS) { moveGroup(model, group, deficit, 0); moved.push(...group.nodes); continue; }
      if (right(group.bounds!) <= split + EPS) continue;
      // In the link's own tier a node moves only when it starts beyond the split: a node the detour
      // must pass stays by the left end, so the run over it spans the whole gap. In any other tier a
      // node with any part beyond the split moves, so a wide source straddling the cut moves with the
      // bar slotted under its port and 7d's replay finds that slot where it left it.
      const shifted = group.nodes.filter(id => group.tier === fromGroup.tier
        ? model.nodes[id]!.bounds!.x >= split - EPS : right(model.nodes[id]!.bounds!) > split + EPS);
      for (const id of shifted) {
        const node = model.nodes[id]!;
        node.bounds!.x += deficit;
        for (const port of node.ports) { port.anchor!.x += deficit; if (port.pill) port.pill.bounds.x += deficit; }
      }
      if (shifted.length) { moved.push(...shifted); fitRegionGroup(model, group); }
    }
    settle(moved);
    changed = true;
  }
  if (changed) { rebuildBands(model); rebuildRegions(model); }
  return changed;
}

/** Transaction-owned stage-7f producer. It replaces every affected claim before publication. */
export function produceGroupLabelBands(model: LayoutModel): void {
  reserveInitialSpace(model);
  reserveLinkLabelRoom(model);
  const budget = createCentreBudget();
  rebuildRegionGeometry(model, budget, undefined, true);
  while (true) {
    // Linked groups share a grid before labels are planned inside their (possibly wider) boxes, and
    // every described link keeps the run its label needs after whatever the replay moved. Either
    // movement, like a changed reservation, must replay the region producers (bars, paths) first.
    alignLinkedGroupGrid(model);
    const roomChanged = reserveLinkLabelRoom(model);
    // A replay that changes reserved outward geometry changes the reservation; refit before placing.
    const bandsChanged = syncBands(model);
    if ((bandsChanged || roomChanged) && budget.remaining > 0) {
      const passes = budget.passes;
      rebuildRegionGeometry(model, budget, undefined, true);
      consumeGrowthPass(budget, passes);
      continue;
    }
    if (roomChanged) {
      // Room moved geometry after the shared budget ran out: replay the producers once more with that
      // same spent budget (no fresh centring passes) so no claim is left stale, and say so — the final
      // gates decide the retained geometry.
      rebuildRegionGeometry(model, budget, undefined, true);
      syncBands(model);
      if (!model.diagnostics.some(item => item.code === 'PLACEMENT_NON_CONVERGENCE')) model.diagnostics.push({
        stage: 'placement', severity: 'warning', code: 'PLACEMENT_NON_CONVERGENCE',
        message: 'Link-label room reservation exhausted the shared eight-pass budget; final gates decide the retained geometry.',
      });
    }
    model.labels = model.labels.filter(label => label.role !== 'group');
    const plan = planLabels(model, true);
    if (!plan.growth) { model.labels.push(...plan.labels); diagnoseBlocked(model, plan.blocked); return; }
    if (budget.remaining <= 0) {
      // The growth-permitted plan stops at the first repairable group, so re-plan for the full
      // blocked classification as well as the retained labels.
      const stalled = planLabels(model, false);
      model.labels.push(...stalled.labels);
      diagnoseBlocked(model, stalled.blocked);
      if (!model.diagnostics.some(item => item.code === 'PLACEMENT_NON_CONVERGENCE')) model.diagnostics.push({
        stage: 'placement', severity: 'warning', code: 'PLACEMENT_NON_CONVERGENCE',
        message: 'Group-label growth exhausted the shared eight-pass budget; final gates decide the retained geometry.',
        owners: [{ kind: 'group', id: plan.growth.group.id }],
      });
      return;
    }
    const stable = routerEntryPoints(model);
    pushFollowingGroups(model, plan.growth.group, plan.growth.width);
    syncBands(model, stable);
    const before = budget.passes;
    rebuildRegionGeometry(model, budget, undefined, true);
    consumeGrowthPass(budget, before);
  }
}

/**
 * 7f's third step: the tier gap room moved whole bands down, so the group labels are planned again
 * in the geometry the move produced. It plans and nothing else — the room is the first step's
 * reservation and a repeat of the reservation would move geometry the measurement has already been
 * taken against. A pure vertical translation leaves every band's height and clearance where they
 * were, so the reservation still holds; where it does not, the full producer runs and reserves.
 *
 * The fallback is given the bands the **first** step reserved, not the ones measured here.
 * `reserveInitialSpace` reads the room a group already holds from the bands the model carries, so a
 * model carrying the new bands would measure each of them against itself, reserve nothing for a
 * clearance that grew between the two steps, and leave the fit to box growth into the gap the
 * measurement has just opened.
 */
export function replanGroupLabels(model: LayoutModel): void {
  const reserved = clone(model.labelBands);
  const reserveAgain = (): void => { model.labelBands = reserved; produceGroupLabelBands(model); };
  if (syncBands(model)) { reserveAgain(); return; }
  const retained = model.labels.filter(label => label.role !== 'group');
  const plan = planLabels({ ...model, labels: retained }, true);
  if (plan.growth) { reserveAgain(); return; }
  model.labels = [...retained, ...plan.labels];
  diagnoseBlocked(model, plan.blocked);
}

/** Recheck exact stable claims against final paths without moving geometry or allocating a new budget. */
export function validateGroupLabelBands(model: LayoutModel): void {
  // Replay the grid on a copy: a settled model does not change; a genuinely unsettled chain exhausts
  // the pass bound again. A serialized diagnostic alone proves nothing.
  if (reserveLinkLabelRoom(clone(model))) throw new Error('A labelled link is shorter than the run its label reserved');
  const trial = clone(model);
  trial.diagnostics = trial.diagnostics.filter(item => item.code !== 'GROUP_GRID_NON_CONVERGENCE');
  const changed = alignLinkedGroupGrid(trial), exhausted = trial.diagnostics.some(item => item.code === 'GROUP_GRID_NON_CONVERGENCE');
  if (changed && !exhausted) throw new Error('Linked groups do not share the grid their links require');
  const entries = routerEntryPoints(model);
  const expectedBands = orderedGroupIds(model.document).map(id => bandFor(model, id, entries));
  if (!equal(model.labelBands, expectedBands)) throw new Error('Group label bands contradict final group geometry');
  for (const band of model.labelBands) {
    if (!Number.isFinite(band.clearance) || band.clearance < GROUP_PADDING - EPS) throw new Error(`Group ${band.group} reserves less than the ordinary padding below its label band`);
    for (const nodeId of model.groups[band.group]!.nodes) {
      const box = model.nodes[nodeId]!.bounds!;
      const clear = band.side === 'top' ? box.y >= bottom(band.bounds) + band.clearance - EPS : bottom(box) <= band.bounds.y - band.clearance + EPS;
      if (!clear) throw new Error(`Group ${band.group} does not retain its reserved clearance beside its label band`);
    }
  }
  // Stage 8 keeps these entry points and the below-band clearance reserved during placement.
  for (const { band, entry } of bandEntryConflicts(model, entries)) {
    if (band.group !== model.document.nodes[entry.node]!.group) continue;
    throw new Error(`Reserved ${entry.kind} entry point of ${entry.link} lies inside the ${band.group} label band reservation`);
  }
  const retained = model.labels.filter(label => label.role !== 'group');
  const expected = { ...model, labels: retained };
  const plan = planLabels(expected, !model.diagnostics.some(item => item.code === 'PLACEMENT_NON_CONVERGENCE'));
  if (plan.growth) throw new Error(`Group label ${plan.growth.group.id} has no reserved free gap`);
  const actual = model.labels.filter(label => label.role === 'group');
  if (!equal(actual, plan.labels)) throw new Error('Group labels contradict measured left-first placement');
}

/** Stage 7f: reserve and place deterministic group labels, then freeze final placement. */
export function bands(model: LayoutModel): LayoutModel {
  return withLayoutMutation(model, 'bands', () => {});
}
