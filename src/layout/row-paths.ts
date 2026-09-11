import type { PortRef } from '../model/document.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPath, LayoutPort, PathSegment } from '../model/layout.js';
import { EPS, length, segmentDistance, segmentRectDistance } from '../score/geometry.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { portId } from './skeleton-graph.js';

/** Stroke-aware clearances that the final gates require between a routed segment and foreign geometry. */
export const STRAIGHT_PATH_CLEARANCE = { node: 10, path: 10 } as const;
/** A pinned single segment serves as both port stems. */
const MIN_STEM = 15;

export interface FacingPair {
  link: LayoutLink;
  /** The node on the left; its facing port is on its right side. */
  left: { node: LayoutNode; port: LayoutPort };
  /** The node on the right; its facing port is on its left side. */
  right: { node: LayoutNode; port: LayoutPort };
}

export function findPort(model: LayoutModel, ref: PortRef): LayoutPort | undefined {
  const key = portId(ref);
  return model.nodes[ref.node]?.ports.find(port => portId(port.ref) === key);
}
function rowNode(model: LayoutModel, id: string): boolean {
  const document = model.document.nodes[id];
  const group = document === undefined ? undefined : model.groups[document.group];
  return group !== undefined && group.flank === undefined && model.document.groups[group.id]?.shape === 'row';
}
function tierOf(model: LayoutModel, id: string): number | undefined {
  return model.groups[model.document.nodes[id]!.group]?.tier;
}
function lateral(model: LayoutModel, link: LayoutLink): { from: LayoutPort; to: LayoutPort } | undefined {
  if (link.layer !== 'routed' || !link.attachments) return undefined;
  const a = link.attachments.from.node, b = link.attachments.to.node;
  if (a === b || !rowNode(model, a) || !rowNode(model, b) || tierOf(model, a) !== tierOf(model, b)) return undefined;
  const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
  if (!from || !to) return undefined;
  const opposite = (from.side === 'right' && to.side === 'left') || (from.side === 'left' && to.side === 'right');
  return opposite ? { from, to } : undefined;
}

/** Routed links whose frozen topology places both ends on facing east/west sides of same-tier row nodes. */
export function facingPair(model: LayoutModel, link: LayoutLink): FacingPair | undefined {
  const ports = lateral(model, link);
  if (!ports || !ports.from.anchor || !ports.to.anchor) return undefined;
  const [leftPort, rightPort] = ports.from.side === 'right' ? [ports.from, ports.to] : [ports.to, ports.from];
  if (leftPort.anchor!.x >= rightPort.anchor!.x) return undefined;
  return { link, left: { node: model.nodes[leftPort.ref.node]!, port: leftPort }, right: { node: model.nodes[rightPort.ref.node]!, port: rightPort } };
}

/** Topology-only test: the rows rule owns this link's path whenever geometry makes it eligible. */
export function rowPathCandidate(model: LayoutModel, link: LayoutLink): boolean {
  if (link.bundle !== undefined || link.groupLink !== undefined) return false;
  const route = model.document.links[link.sourceIndex]?.route;
  if (route !== undefined && route !== 'straight' && route !== 'orthogonal') return false;
  return lateral(model, link) !== undefined;
}
function automatic(model: LayoutModel, link: LayoutLink): boolean {
  return model.document.links[link.sourceIndex]?.route === undefined;
}

/** Nothing foreign may lie inside the segment's gate clearances. Other pinned paths count as foreign. */
export function straightCorridorClear(model: LayoutModel, link: LayoutLink, segment: PathSegment): boolean {
  // The corridor has to clear this link's own resolved width, not the theme default: a weighted
  // path measured at 1.5 px would be pinned where G6 then fails it.
  const stroke = linkStrokeWidth(link);
  const ends = link.attachments;
  if (!ends) return false;
  const endNodes = new Set([ends.from.node, ends.to.node]);
  const endPorts = new Set([portId(ends.from), portId(ends.to)]);
  const ownsObstacle = (owner: { kind: string; id?: string }): boolean => owner.kind === 'link' && owner.id === link.id;
  for (const node of Object.values(model.nodes)) {
    if (node.layer === 'overlay' || !node.bounds) continue;
    if (!endNodes.has(node.id)
      && segmentRectDistance(segment, node.bounds) - (stroke + (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2 < STRAIGHT_PATH_CLEARANCE.node - EPS) return false;
    for (const port of node.ports) {
      if (!port.pill || port.pill.layer === 'overlay' || endPorts.has(portId(port.ref))) continue;
      if (segmentRectDistance(segment, port.pill.bounds) - (stroke + DEFAULT_STROKE_WIDTHS.pill) / 2 < -EPS) return false;
    }
  }
  for (const label of model.labels) {
    if (label.omitted || !label.bounds || label.layer === 'overlay' || ownsObstacle(label.owner)) continue;
    if (label.role === 'pill' && label.port && endPorts.has(portId(label.port))) continue;
    if (segmentRectDistance(segment, label.bounds) < stroke / 2 + (label.role === 'group' ? GROUP_LABEL_LINK_CLEARANCE : 0) - EPS) return false;
  }
  for (const lane of model.lanes) {
    if (lane.layer === 'overlay' || ownsObstacle(lane.owner)) continue;
    if (segmentRectDistance(segment, lane.bounds) < stroke / 2 - EPS) return false;
  }
  for (const other of model.links) {
    if (other.id === link.id || other.layer === 'overlay') continue;
    const otherStroke = linkStrokeWidth(other);
    // A stage-8 remainder (`fixed: false`) is routed around this corridor, so it is not an
    // obstacle to the rule that reserved the corridor first. Re-deriving the pin against it would
    // let routing retract a placement decision, which the pipeline's load-bearing rule forbids.
    const foreign = other.path?.fixed === false ? [] : other.path?.segments ?? [];
    for (const run of [...foreign, ...(other.fixedSegments ?? [])]) {
      if (segmentDistance(segment, run) - (stroke + otherStroke) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS) return false;
    }
  }
  for (const bundle of model.bundles) {
    for (const zone of [bundle.rows, bundle.envelope]) if (zone && segmentRectDistance(segment, zone) < stroke / 2 - EPS) return false;
  }
  for (const obstacle of model.obstacles) {
    if (ownsObstacle(obstacle.owner)) continue;
    if (segmentRectDistance(segment, obstacle.bounds) < stroke / 2 - EPS) return false;
  }
  return true;
}

/** The single straight horizontal path the rows rule pins for this link, or undefined when ineligible. */
export function expectedRowPath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
  if (!rowPathCandidate(model, link)) return undefined;
  const pair = facingPair(model, link);
  if (!pair) return undefined;
  const from = findPort(model, link.attachments!.from)!, to = findPort(model, link.attachments!.to)!;
  if (Math.abs(from.anchor!.y - to.anchor!.y) > EPS) return undefined;
  const segment: PathSegment = { from: { ...from.anchor! }, to: { ...to.anchor! }, owner: { ...link.owner } };
  const extent = length(segment);
  const limit = 2 * Math.max(...[pair.left.node, pair.right.node].flatMap(node => [node.bounds!.width, node.bounds!.height]));
  if (extent < MIN_STEM - EPS || extent >= limit - EPS) return undefined;
  if (!straightCorridorClear(model, link, segment)) return undefined;
  return { owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [segment] };
}

/**
 * Replace every row-owned path from current anchors. Stale pins are removed before any pin is
 * recreated, so a translation never leaves an old path beside its replacement. Automatic links
 * record the selected technique; authored routes keep theirs.
 */
export function rebuildRowPaths(draft: LayoutModel): void {
  const candidates = draft.links.filter(link => rowPathCandidate(draft, link));
  for (const link of candidates) delete link.path;
  for (const link of candidates) {
    const path = expectedRowPath(draft, link);
    if (path) link.path = path;
    if (automatic(draft, link)) link.technique = path ? 'straight' : 'orthogonal';
  }
}
