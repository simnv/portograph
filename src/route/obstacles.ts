import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { groupBoxes, groupConsumers } from '../score/model.js';
import { GROUP_LABEL_GEOMETRY, routedStroke } from '../layout/bands.js';
import { portId } from '../layout/skeleton-graph.js';
import { isRoutedChord } from '../layout/frame-paths.js';
import { bottom, right } from '../geometry/planar.js';
import type { RoutePin } from './types.js';
import { PLACEMENT_EPS } from '../layout/tolerance.js';

/** Arc length removed from each end of a reserved chain that starts at its own port anchor. */
export const TERMINAL_TRIM = 18;

/**
 * One routing obstacle. `consumers` are links that may pass this rectangle: owners of reserved
 * geometry, or links explicitly permitted to cross that run by a routing rule. Every other link
 * avoids it.
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

const samePlace = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) <= PLACEMENT_EPS && Math.abs(a.y - b.y) <= PLACEMENT_EPS;

/**
 * Trim `distance` of arc length from one end of a polyline, once per whole chain. A chain shorter
 * than the two trims protects nothing; that is the documented limit of the 18 px constant and the
 * final gates still judge the geometry near the terminals.
 */
export function trimChain(points: Point[], start: number, end: number): Point[] {
  const total = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y), 0);
  if (total <= start + end + PLACEMENT_EPS) return [];
  const walk = (list: Point[], distance: number): Point[] => {
    let remaining = distance;
    const result = [...list];
    while (remaining > PLACEMENT_EPS && result.length >= 2) {
      const a = result[0]!, b = result[1]!, span = Math.hypot(b.x - a.x, b.y - a.y);
      if (span <= remaining + PLACEMENT_EPS) { result.shift(); remaining -= span; continue; }
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
  // A rank cell is never an obstacle: the frame it belongs to is, in its place.
  for (const { id, bounds } of groupBoxes(model)) {
    push({ id: `group:${id}`, bounds: expand(bounds, half + GROUP_EDGE_LINK_CLEARANCE), consumers: groupConsumers(model, id) });
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
    // A span corridor is no router obstacle: its chord is a fixed path (architecture ticket 22).
    if (lane.layer === 'overlay' || lane.kind === 'span') continue;
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
  for (const item of reservedRunObstacles(model)) push(item);
  for (const item of ownGroupExitWalls(model, result)) push(item);
  return result;
}


const OPPOSITE_SIDE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** `outer` minus the `holes`, as disjoint rectangles: the grid the hole edges cut, merged along each row band. */
function subtract(outer: Rect, holes: Rect[]): Rect[] {
  const cut = (lo: number, hi: number, values: number[]): number[] =>
    [...new Set([lo, hi, ...values.filter(v => v > lo && v < hi)])].sort((a, b) => a - b);
  const xs = cut(outer.x, outer.x + outer.width, holes.flatMap(h => [h.x, h.x + h.width]));
  const ys = cut(outer.y, outer.y + outer.height, holes.flatMap(h => [h.y, h.y + h.height]));
  const result: Rect[] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    let start: number | undefined;
    const flush = (end: number): void => {
      if (start !== undefined) result.push({ x: start, y: ys[j]!, width: end - start, height: ys[j + 1]! - ys[j]! });
      start = undefined;
    };
    for (let i = 0; i + 1 < xs.length; i++) {
      const cx = (xs[i]! + xs[i + 1]!) / 2, cy = (ys[j]! + ys[j + 1]!) / 2;
      const inHole = holes.some(h => cx > h.x && cx < h.x + h.width && cy > h.y && cy < h.y + h.height);
      if (inHole) flush(xs[i]!); else start ??= xs[i]!;
    }
    flush(xs.at(-1)!);
  }
  return result;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - PLACEMENT_EPS && b.x < a.x + a.width - PLACEMENT_EPS
  && a.y < b.y + b.height - PLACEMENT_EPS && b.y < a.y + a.height - PLACEMENT_EPS;

const containsPoint = (box: Rect, p: Point): boolean =>
  p.x >= box.x - PLACEMENT_EPS && p.x <= box.x + box.width + PLACEMENT_EPS
  && p.y >= box.y - PLACEMENT_EPS && p.y <= box.y + box.height + PLACEMENT_EPS;

/**
 * The walls of a link's own group beyond the end of its shared run (ticket 13, ADR-0013).
 *
 * A link attached inside a group is exempt from that group's obstacle, because it crosses the
 * boundary at its port. A shared run ends at a junction row that stands inside the group's padding
 * (rows are measured from the port, not from the group edge), and from there the exempt router
 * is free to run along the group's edge at any distance. The group cannot simply become solid for
 * this link: the terminal is inside it.
 *
 * The exits are doors: strips one stroke wide that run from the terminal through the wall in each
 * direction but back towards the port's own node. They lie in the padding and the margin around the
 * terminal, which the fan's junction row and the group edge margin already reserve (the row is
 * placed by `fanRows`, the margin by `edgeMargin`). Everywhere else the group box, with its edge
 * margin, is a wall for this link, so the exterior remainder keeps the group clearance. A door
 * that meets foreign geometry is dropped, and with no door left the link keeps the exemption it
 * had. Nothing here is discovered by the router: the doors come from the terminal and the box,
 * both fixed before placement freezes.
 */
function ownGroupExitWalls(model: LayoutModel, existing: RouteObstacle[]): RouteObstacle[] {
  const result: RouteObstacle[] = [];
  const stroke = routedStroke(model), half = stroke / 2, boxes = groupBoxes(model);
  for (const link of model.links) {
    if (link.layer === 'overlay' || link.path || link.fixedSegments?.length || !link.attachments) continue;
    for (const end of ['from', 'to'] as const) {
      const runs = link.sharedRuns?.[end];
      if (!runs?.length) continue;
      const ref = link.attachments[end], other = link.attachments[end === 'from' ? 'to' : 'from'];
      const group = model.document.nodes[ref.node]?.group;
      if (group === undefined || model.document.nodes[other.node]?.group === group) continue;
      const port = model.nodes[ref.node]?.ports.find(item => portId(item.ref) === portId(ref));
      const box = boxes.find(item => item.id === group)?.bounds;
      if (!port?.side || !box) continue;
      const terminal = runs.at(-1)!.to;
      if (!containsPoint(box, terminal)) continue;
      const wall = expand(box, half + GROUP_EDGE_LINK_CLEARANCE);
      const lo = half, back = port.side;
      // A door runs from the terminal out through the wall in one direction; the way back to the
      // port's own node is not one. Each door must be clear of foreign geometry to count.
      const doors = ([
        ['top', { x: terminal.x - lo, y: wall.y, width: 2 * lo, height: terminal.y - wall.y }],
        ['bottom', { x: terminal.x - lo, y: terminal.y, width: 2 * lo, height: wall.y + wall.height - terminal.y }],
        ['left', { x: wall.x, y: terminal.y - lo, width: terminal.x - wall.x, height: 2 * lo }],
        ['right', { x: terminal.x, y: terminal.y - lo, width: wall.x + wall.width - terminal.x, height: 2 * lo }],
      ] as [Side, Rect][]).filter(([side, door]) => side !== OPPOSITE_SIDE[back] && door.width > 0 && door.height > 0
        && !existing.some(item => !item.id.startsWith('group:') && !item.consumers.includes(link.id)
          && !containsPoint(item.bounds, terminal) && overlaps(item.bounds, door))).map(([, door]) => door);
      if (!doors.length) continue;
      const consumers = groupConsumers(model, group).filter(id => id !== link.id);
      for (const [index, bounds] of subtract(wall, doors).entries()) {
        result.push({ id: `exit-wall:${link.id}:${end}:${index}`, bounds, consumers });
      }
    }
  }
  return result;
}

/**
 * The cover of every reserved run the model already holds: a complete pinned path, a lane run, an
 * outward shared prefix. These are the rectangles a route may not enter and the rectangles a run
 * stage 8 claims for itself may not enter either, so the claim is measured against exactly the set
 * `routeObstacles` puts in front of the router, with the same margins.
 */
export function reservedRunObstacles(model: LayoutModel): RouteObstacle[] {
  const { push, result } = collector();
  const stroke = routedStroke(model);
  for (const link of model.links) {
    // A straight link inside one frame is no router obstacle, like an overlay link (ticket 34): routes that
    // cross a tier gap must be able to cross its chord, and G6 excuses a strict crossing.
    if (link.layer === 'overlay' || link.technique === 'stub' || isRoutedChord(model, link)) continue;
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
export function completedRouteCovers(model: LayoutModel, link: LayoutLink, connector: string, points: Point[]):
{ obstacle: RouteObstacle; segment: Pick<PathSegment, 'from' | 'to'> }[] {
  const anchors = anchorsOf(model, link);
  const startsAtPort = anchors.some(anchor => samePlace(anchor, points[0]!));
  const endsAtPort = anchors.some(anchor => samePlace(anchor, points.at(-1)!));
  const trimmed = trimChain(points, startsAtPort ? TERMINAL_TRIM : 0, endsAtPort ? TERMINAL_TRIM : 0);
  const segments = trimmed.slice(1).map((to, index) => ({ from: trimmed[index]!, to }))
    .filter(segment => !samePlace(segment.from, segment.to));
  return chainRects(trimmed, runClearance(link, routedStroke(model))).map((bounds, index) => ({
    obstacle: { id: `routed:${connector}:${index}`, bounds, consumers: [link.id] }, segment: segments[index]!,
  }));
}

export function completedRouteObstacles(model: LayoutModel, link: LayoutLink, connector: string, points: Point[]): RouteObstacle[] {
  return completedRouteCovers(model, link, connector, points).map(item => item.obstacle);
}

export const rectContainsPoint = (bounds: Rect, point: Point, tolerance = PLACEMENT_EPS): boolean =>
  point.x >= bounds.x + tolerance && point.x <= right(bounds) - tolerance
  && point.y >= bounds.y + tolerance && point.y <= bottom(bounds) - tolerance;
