import type { Point, Rect, Side } from '../model/geometry.js';
import type { PortRef } from '../model/document.js';
import type { LabelBand, LayoutGroup, LayoutLabel, LayoutModel, Owner, PathSegment } from '../model/layout.js';
import { equal } from '../model/json-equality.js';
import { orderedGroupIds } from '../model/model.js';
import { FONT_FAMILY, measureText } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { createCentreBudget, type CentreBudget } from './centre.js';
import { laneSidesHold } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { findPort } from './row-paths.js';
import { bandGap, portId } from './skeleton-graph.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { bottom, GROUP_PADDING, placementWarning, right } from './regions.js';
import { withLayoutMutation } from './mutation.js';

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

/** Widest routed stroke this placement must keep clear; stage 8 may not exceed it. */
export function routedStroke(model: LayoutModel): number {
  return Math.max(DEFAULT_STROKE_WIDTHS.path, ...model.links.filter(link => link.layer === 'routed')
    .map(linkStrokeWidth));
}
function strokeAllowance(model: LayoutModel): number { return routedStroke(model) / 2; }

/**
 * Outward distance of the ordinary checkpoint at a node. It is the 15 px stem, unless that node's
 * stroke-expanded routing obstacle already reaches further; then it clears that obstacle instead.
 */
export function stemReach(model: LayoutModel, node: LayoutModel['nodes'][string]): number {
  const expanded = GROUP_LABEL_GEOMETRY.nodeClearance
    + ((node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) + routedStroke(model)) / 2;
  return Math.max(GROUP_LABEL_GEOMETRY.routerStem, expanded + GROUP_LABEL_GEOMETRY.entryTolerance);
}

/**
 * Every outward point stage 8 must consume: the ordinary 15 px checkpoint of each routed
 * attachment and each vertex of its mandatory shared prefix. Neither input depends on whether the
 * link already carries a path, so completing a remainder in stage 8 cannot retire the reservation.
 */
export function routerEntryPoints(model: LayoutModel): RouterEntryPoint[] {
  const result: RouterEntryPoint[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const end of ['from', 'to'] as const) {
      const ref = link.attachments[end], port = findPort(model, ref);
      if (!port?.anchor || !port.side) continue;
      const anchor = port.anchor, delta = OUTWARD[port.side];
      const common = { link: link.id, end, node: ref.node, port: { ...port.ref }, side: port.side };
      const stem = stemReach(model, model.nodes[ref.node]!);
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

/** A required entry point may not sit inside the band obstacle a routed stroke has to avoid. */
export function bandEntryConflicts(model: LayoutModel, entries = routerEntryPoints(model)): { band: LabelBand; entry: RouterEntryPoint }[] {
  const allowance = strokeAllowance(model), result: { band: LabelBand; entry: RouterEntryPoint }[] = [];
  for (const entry of entries) for (const band of model.labelBands) {
    const box = band.bounds;
    if (entry.point.x >= box.x - allowance - EPS && entry.point.x <= right(box) + allowance + EPS
      && entry.point.y >= box.y - allowance - EPS && entry.point.y <= bottom(box) + allowance + EPS) result.push({ band, entry });
  }
  return result;
}

/** Reserved gap below the band; top-side entry points of this group's own nodes must clear it. */
function clearanceFor(model: LayoutModel, group: LayoutGroup, entries: RouterEntryPoint[]): number {
  const members = new Set(group.nodes);
  const reach = Math.max(0, ...entries.filter(entry => entry.side === 'top' && members.has(entry.node)).map(entry => entry.outward));
  if (reach <= 0) return GROUP_PADDING;
  return Math.max(GROUP_PADDING, reach + strokeAllowance(model) + GROUP_LABEL_GEOMETRY.entryTolerance);
}

function bandFor(model: LayoutModel, groupId: string, entries: RouterEntryPoint[]): LabelBand {
  const group = model.groups[groupId]!, measured = measurement(model, groupId);
  return { id: `label-band:${groupId}`, group: groupId, owner: { ...group.owner }, layer: 'routed',
    bounds: { x: group.bounds!.x, y: group.bounds!.y, width: group.bounds!.width,
      height: measured.height + GROUP_LABEL_GEOMETRY.bandExtra },
    clearance: clearanceFor(model, group, entries) };
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
function linkRects(link: LayoutModel['links'][number]): { id: string; bounds: Rect }[] {
  const stroke = linkStrokeWidth(link) / 2;
  // A stage-8 remainder (`fixed: false`) is routed around this placement, so only the runs a rule
  // reserved count here; re-deriving a label against a later route would let routing move it.
  const reserved = link.path?.fixed === false ? [] : link.path?.segments ?? [];
  const sources: [string, PathSegment[]][] = [['path', reserved],
    ['fixed', link.fixedSegments ?? []], ['shared:from', link.sharedRuns?.from ?? []],
    ['shared:to', link.sharedRuns?.to ?? []]];
  const seen = new Set<string>(), result: { id: string; bounds: Rect }[] = [];
  for (const [kind, segments] of sources) for (const [index, segment] of segments.entries()) {
    const bounds = segmentRect(segment, stroke), key = ownedRectKey(bounds, segment.owner);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id: `${link.id}:${kind}:${index}`, bounds });
  }
  return result;
}

/** Every reserved rectangle a group label must avoid, with stable semantic IDs. */
export function groupLabelObstacles(model: LayoutModel, placed: LayoutLabel[] = []): { id: string; bounds: Rect }[] {
  return forbiddenRects(model, placed);
}

function forbiddenRects(model: LayoutModel, placed: LayoutLabel[]): { id: string; bounds: Rect }[] {
  const result: { id: string; bounds: Rect }[] = [];
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
  for (const lane of model.lanes) if (lane.layer !== 'overlay') result.push({ id: lane.id, bounds: lane.bounds });
  for (const bundle of model.bundles) {
    for (const [index, bounds] of (bundle.envelopeParts?.length ? bundle.envelopeParts : bundle.envelope ? [bundle.envelope] : [] as Rect[]).entries()) {
      result.push({ id: `${bundle.id}:envelope:${index}`, bounds });
    }
  }
  for (const obstacle of model.obstacles) if (obstacle.layer !== 'overlay') result.push({ id: obstacle.id, bounds: obstacle.bounds });
  for (const link of model.links) result.push(...linkRects(link));
  return result;
}

function intervals(model: LayoutModel, placed: LayoutLabel[], y: number, height: number, width: number): ForbiddenInterval[] {
  const raw = forbiddenRects(model, placed).filter(item => intersectsY(item.bounds, y, height)).map(item => ({
    low: item.bounds.x - width, high: right(item.bounds), id: item.id,
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
    const y = group.bounds!.y + GROUP_LABEL_GEOMETRY.verticalInset;
    const x = firstFree(group.bounds!.x + GROUP_LABEL_GEOMETRY.horizontalInset,
      intervals(model, labels, y, measured.height, measured.width));
    const limit = right(group.bounds!) - GROUP_LABEL_GEOMETRY.horizontalInset - measured.width;
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
  const entries = routerEntryPoints(model);
  syncBands(model, entries);
  for (const id of orderedGroupIds(model.document)) {
    const group = model.groups[id]!, band = model.labelBands.find(item => item.group === id)!;
    // The band replaces the ordinary top padding, and its clearance replaces that padding below it.
    const shift = band.bounds.height + band.clearance - GROUP_PADDING;
    for (const nodeId of group.nodes) {
      const node = model.nodes[nodeId]!;
      node.bounds!.y += shift;
      for (const port of node.ports) port.anchor!.y += shift;
    }
    group.bounds!.height += shift;
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

/** Transaction-owned stage-7f producer. It replaces every affected claim before publication. */
export function produceGroupLabelBands(model: LayoutModel): void {
  reserveInitialSpace(model);
  const budget = createCentreBudget();
  rebuildRegionGeometry(model, budget, undefined, true);
  while (true) {
    // A replay that changes reserved outward geometry changes the reservation; refit before placing.
    if (syncBands(model) && budget.remaining > 0) {
      const passes = budget.passes;
      rebuildRegionGeometry(model, budget, undefined, true);
      consumeGrowthPass(budget, passes);
      continue;
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

/** Recheck exact stable claims against final paths without moving geometry or allocating a new budget. */
export function validateGroupLabelBands(model: LayoutModel): void {
  const entries = routerEntryPoints(model);
  const expectedBands = orderedGroupIds(model.document).map(id => bandFor(model, id, entries));
  if (!equal(model.labelBands, expectedBands)) throw new Error('Group label bands contradict final group geometry');
  for (const band of model.labelBands) {
    if (!Number.isFinite(band.clearance) || band.clearance < GROUP_PADDING - EPS) throw new Error(`Group ${band.group} reserves less than the ordinary padding below its label band`);
    for (const nodeId of model.groups[band.group]!.nodes) {
      if (model.nodes[nodeId]!.bounds!.y < bottom(band.bounds) + band.clearance - EPS) throw new Error(`Group ${band.group} does not retain its reserved clearance below its label band`);
    }
  }
  // Stage 8 keeps these entry points; owning the group does not waive its own band obstacle.
  for (const { band, entry } of bandEntryConflicts(model, entries)) {
    if (band.group !== model.document.nodes[entry.node]!.group) continue;
    throw new Error(`Reserved ${entry.kind} entry point of ${entry.link} lies inside the ${band.group} label band obstacle`);
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
