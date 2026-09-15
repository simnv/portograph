import type { Point, Rect } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { groupConsumers } from '../score/model.js';
import { GROUP_LABEL_GEOMETRY, routedStroke } from '../layout/bands.js';
import { portId } from '../layout/skeleton-graph.js';
import { bottom, right } from '../score/geometry.js';
import type { RoutePin } from './types.js';

/** Arc length removed from each end of a reserved chain that starts at its own port anchor. */
export const TERMINAL_TRIM = 18;

/**
 * One routing obstacle. `consumers` are the links whose own reserved geometry this rectangle
 * covers: only they may pass through it, and only because a rule already gave them that space.
 * Every other link avoids it.
 */
export interface RouteObstacle {
  id: string;
  bounds: Rect;
  consumers: string[];
  /** Attachment pins, added by the planner to the node obstacles a connector starts or ends on. */
  pins?: RoutePin[];
}

const expand = (bounds: Rect, by: number): Rect => ({
  x: bounds.x - by, y: bounds.y - by, width: bounds.width + 2 * by, height: bounds.height + 2 * by,
});

const clearanceOf = (node: LayoutModel['nodes'][string], stroke: number): number =>
  GROUP_LABEL_GEOMETRY.nodeClearance + ((node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) + stroke) / 2;

/** Expansion of a node's model rectangle into its routing obstacle; the node itself never grows. */
export function nodeClearance(model: LayoutModel, nodeId: string): number {
  return clearanceOf(model.nodes[nodeId]!, routedStroke(model));
}

/**
 * One node's routing obstacle: its model rectangle with the node clearance, grown to swallow every
 * visible pill with the pill clearance. A pill on a top or bottom side reaches further outward than
 * the node clearance, and a link attaching there must pass through its own pill. Keeping both in
 * one rectangle means every connector has the same obstacle set: an attachment may always leave
 * the shape it is pinned to, so no link needs a pill exemption of its own.
 */
export function nodeObstacle(model: LayoutModel, nodeId: string): Rect {
  return nodeBox(model.nodes[nodeId]!, routedStroke(model));
}
function nodeBox(node: LayoutModel['nodes'][string], stroke: number): Rect {
  const pillGap = (stroke + DEFAULT_STROKE_WIDTHS.pill) / 2;
  const boxes = [expand(node.bounds!, clearanceOf(node, stroke)),
    ...node.ports.filter(port => port.pill && port.pill.layer !== 'overlay').map(port => expand(port.pill!.bounds, pillGap))];
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(right)) - x, height: Math.max(...boxes.map(bottom)) - y };
}

/** Half-width of the protective cover around one reserved run of `link`. */
function runClearance(link: LayoutLink, stroke: number): number {
  return GROUP_LABEL_GEOMETRY.nodeClearance + (linkStrokeWidth(link) + stroke) / 2;
}

const anchorsOf = (model: LayoutModel, link: LayoutLink): Point[] => {
  if (!link.attachments) return [];
  return (['from', 'to'] as const).flatMap(end => {
    const ref = link.attachments![end];
    const anchor = model.nodes[ref.node]?.ports.find(port => portId(port.ref) === portId(ref))?.anchor;
    return anchor ? [anchor] : [];
  });
};

const samePlace = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) <= 1e-6 && Math.abs(a.y - b.y) <= 1e-6;

/**
 * Trim `distance` of arc length from one end of a polyline, once per whole chain. A chain shorter
 * than the two trims protects nothing; that is the documented limit of the 18 px constant and the
 * final gates still judge the geometry near the terminals.
 */
export function trimChain(points: Point[], start: number, end: number): Point[] {
  const total = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y), 0);
  if (total <= start + end + 1e-6) return [];
  const walk = (list: Point[], distance: number): Point[] => {
    let remaining = distance;
    const result = [...list];
    while (remaining > 1e-6 && result.length >= 2) {
      const a = result[0]!, b = result[1]!, span = Math.hypot(b.x - a.x, b.y - a.y);
      if (span <= remaining + 1e-6) { result.shift(); remaining -= span; continue; }
      const ratio = remaining / span;
      result[0] = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
      remaining = 0;
    }
    return result;
  };
  return walk(walk(points, start).reverse(), end).reverse();
}

/**
 * Cover one trimmed chain. Interior bends get square corner coverage from both sides; the two
 * trimmed ends keep butt caps so a link that shares the endpoint can still reach it.
 */
function chainRects(points: Point[], half: number): Rect[] {
  const result: Rect[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const a = points[index]!, b = points[index + 1]!;
    if (samePlace(a, b)) continue;
    // A butt cap only at a trimmed terminal of the whole chain; every interior bend is covered
    // from both of its segments.
    const capA = index === 0 ? 0 : half, capB = index + 2 === points.length ? 0 : half;
    const low = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
    const high = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
    const lowCap = { x: a.x <= b.x ? capA : capB, y: a.y <= b.y ? capA : capB };
    const highCap = { x: a.x <= b.x ? capB : capA, y: a.y <= b.y ? capB : capA };
    const x = low.x - (high.x > low.x ? lowCap.x : half), y = low.y - (high.y > low.y ? lowCap.y : half);
    result.push({
      x, y,
      width: high.x + (high.x > low.x ? highCap.x : half) - x,
      height: high.y + (high.y > low.y ? highCap.y : half) - y,
    });
  }
  return result;
}

/** The reserved chains of one link, in stable order: a complete path, or its partial claims. */
export function reservedChains(link: LayoutLink): { kind: string; segments: PathSegment[] }[] {
  if (link.path) return [{ kind: 'path', segments: link.path.segments }];
  const result: { kind: string; segments: PathSegment[] }[] = [];
  if (link.sharedRuns?.from?.length) result.push({ kind: 'shared:from', segments: link.sharedRuns.from });
  for (const [index, segment] of (link.fixedSegments ?? []).entries()) result.push({ kind: `fixed:${index}`, segments: [segment] });
  if (link.sharedRuns?.to?.length) result.push({ kind: 'shared:to', segments: link.sharedRuns.to });
  return result;
}

const chainPoints = (segments: PathSegment[]): Point[] => [segments[0]!.from, ...segments.map(segment => segment.to)];

/** Identical rectangles merge into one obstacle owned by every link that reserved it. */
function collector(): { push: (entry: RouteObstacle) => void; result: RouteObstacle[] } {
  const result: RouteObstacle[] = [], index = new Map<string, RouteObstacle>();
  return {
    result,
    push(entry) {
      const { x, y, width, height } = entry.bounds, key = `${x}|${y}|${width}|${height}`;
      const match = index.get(key);
      if (!match) { index.set(key, entry); result.push(entry); return; }
      for (const consumer of entry.consumers) if (!match.consumers.includes(consumer)) match.consumers.push(consumer);
    },
  };
}

/**
 * Every rectangle stage 8 must route around, with the links each one already belongs to.
 *
 * Reservations keep their model geometry; the stroke-aware expansion is adapter-only, so no node,
 * band, lane or envelope grows. Overlay geometry is exempt from clearance gates and is left out.
 */
export function routeObstacles(model: LayoutModel): RouteObstacle[] {
  const { push, result } = collector();
  const stroke = routedStroke(model), half = stroke / 2;
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!;
    if (node.layer === 'overlay') continue;
    push({ id: `node:${id}`, bounds: nodeBox(node, stroke), consumers: [] });
  }
  for (const label of model.labels) {
    if (label.omitted || label.layer === 'overlay' || !label.bounds) continue;
    // A pill label sits inside its pill, and a node label inside its node, so both are already
    // covered; only a link's own label would ever need an exemption.
    const consumers = label.owner.kind === 'link' ? [label.owner.id] : [];
    // A group title's link-free margin is part of its obstacle.
    push({ id: `label:${label.id}`, bounds: expand(label.bounds, half + (label.role === 'group' ? GROUP_LABEL_LINK_CLEARANCE : 0)), consumers });
  }
  // A group box, with its edge margin, obstructs every link that neither attaches inside it nor
  // owns a lane in its margin (ADR-0013). Attached links still cross the boundary at their ports.
  for (const [id, group] of Object.entries(model.groups)) {
    if (!group.bounds || !group.nodes.length) continue;
    push({ id: `group:${id}`, bounds: expand(group.bounds, half + GROUP_EDGE_LINK_CLEARANCE), consumers: groupConsumers(model, id) });
  }
  // A label band reserves placement space, not a solid barrier across the whole group.
  // Its measured label is protected above, including against the group's own attachments.
  //
  // A lane obstructs its owner too. The corridor admits the owner's collinear run and nothing else
  // (`laneRuns`), and that run is already the owner's own obstacle exemption below, so the owner
  // needs no second exemption here. Without this the router treats the whole corridor as free space
  // for the one link that must respect it most: measured, a gap crossed its own lane sideways and
  // another descended 16 px off its centre, and the stitcher then refused geometry that occupied a
  // reservation placement had made.
  for (const lane of model.lanes) {
    if (lane.layer === 'overlay') continue;
    push({ id: lane.id, bounds: expand(lane.bounds, half), consumers: [] });
  }
  for (const bundle of model.bundles) {
    if (bundle.layer === 'overlay') continue;
    const parts = bundle.envelopeParts?.length ? bundle.envelopeParts : bundle.envelope ? [bundle.envelope] : [];
    for (const [index, part] of parts.entries()) {
      push({ id: `${bundle.id}:envelope:${index}`, bounds: expand(part, half), consumers: [...bundle.members] });
    }
  }
  for (const obstacle of model.obstacles) {
    if (obstacle.layer === 'overlay') continue;
    push({ id: `obstacle:${obstacle.id}`, bounds: expand(obstacle.bounds, half),
      consumers: obstacle.owner.kind === 'link' ? [obstacle.owner.id] : [] });
  }
  for (const link of model.links) {
    if (link.layer === 'overlay' || link.technique === 'stub') continue;
    const clearance = runClearance(link, stroke), anchors = anchorsOf(model, link);
    for (const chain of reservedChains(link)) {
      const points = chainPoints(chain.segments);
      const startsAtPort = anchors.some(anchor => samePlace(anchor, points[0]!));
      const endsAtPort = anchors.some(anchor => samePlace(anchor, points.at(-1)!));
      const trimmed = trimChain(points, startsAtPort ? TERMINAL_TRIM : 0, endsAtPort ? TERMINAL_TRIM : 0);
      for (const [index, bounds] of chainRects(trimmed, clearance).entries()) {
        push({ id: `${link.id}:${chain.kind}:${index}`, bounds, consumers: [link.id] });
      }
    }
  }
  return result;
}

/** Protective cover for routes a previous ownership batch has already fixed. */
export function completedRouteObstacles(model: LayoutModel, link: LayoutLink, connector: string, points: Point[]): RouteObstacle[] {
  const anchors = anchorsOf(model, link);
  const startsAtPort = anchors.some(anchor => samePlace(anchor, points[0]!));
  const endsAtPort = anchors.some(anchor => samePlace(anchor, points.at(-1)!));
  const trimmed = trimChain(points, startsAtPort ? TERMINAL_TRIM : 0, endsAtPort ? TERMINAL_TRIM : 0);
  return chainRects(trimmed, runClearance(link, routedStroke(model))).map((bounds, index) => ({
    id: `routed:${connector}:${index}`, bounds, consumers: [link.id],
  }));
}

export const rectContainsPoint = (bounds: Rect, point: Point, tolerance = 1e-6): boolean =>
  point.x >= bounds.x + tolerance && point.x <= right(bounds) - tolerance
  && point.y >= bounds.y + tolerance && point.y <= bottom(bounds) - tolerance;
