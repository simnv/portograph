import type { PortRef } from '../model/document.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPath, LayoutPort, PathSegment } from '../model/layout.js';
import type { Rect } from '../model/geometry.js';
import { EPS, length, segmentDistance, segmentRectDistance } from '../score/geometry.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { groupConsumers } from '../score/model.js';
import { portId } from './skeleton-graph.js';
import { groupShape } from './grid.js';
import { joinFanTrees } from './bundle-geometry.js';
import { expectedFramePath, isRoutedChord, routedChordCandidate, standaloneChord, withLinkFacts } from './frame-paths.js';
import { nodeTierIfAny } from './read/tier.js';

/**
 * Coordinate magnitude beyond which an obstacle is measured instead of rejected.
 *
 * `segmentRectDistance` and `segmentDistance` build parametric slabs and projections from
 * coordinate differences. Two coordinates further apart than this cancel, and the measurement can
 * then report a contact that is not there. A rejection bound cannot reproduce such an answer, so a
 * shape that reaches this magnitude is measured, exactly as it was before. Below it one
 * subtraction is accurate to 2^-27 px, which the reject's own one-pixel margin covers many times
 * over. No diagram this pipeline lays out comes near the limit.
 */
const REJECT_LIMIT = 2 ** 26;
const measurable = (x: number, y: number, right: number, bottom: number): boolean =>
  x > -REJECT_LIMIT && y > -REJECT_LIMIT && right < REJECT_LIMIT && bottom < REJECT_LIMIT;

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
  // The fields `portId` keys on, compared without building the key.
  const anonymous = ref.anonymous === true, name = ref.name ?? null;
  return model.nodes[ref.node]?.ports.find(({ ref: at }) => at.ordinal === ref.ordinal && at.node === ref.node && (at.name ?? null) === name && (at.anonymous === true) === anonymous);
}
function rowNode(model: LayoutModel, id: string): boolean {
  const document = model.document.nodes[id];
  const group = document === undefined ? undefined : model.groups[document.group];
  return group !== undefined && group.flank === undefined && groupShape(model, group.id) === 'row';
}
function lateral(model: LayoutModel, link: LayoutLink): { from: LayoutPort; to: LayoutPort } | undefined {
  if (link.layer !== 'routed' || !link.attachments) return undefined;
  const a = link.attachments.from.node, b = link.attachments.to.node;
  if (a === b || !rowNode(model, a) || !rowNode(model, b) || nodeTierIfAny(model, a) !== nodeTierIfAny(model, b)) return undefined;
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
  if (link.bundle !== undefined) return false;
  const route = model.document.links[link.sourceIndex]?.route;
  if (route !== undefined && route !== 'straight' && route !== 'orthogonal') return false;
  // A group-link member is a candidate by the frame rule only (ticket 38): it never takes a level path.
  return routedChordCandidate(model, link) || (link.groupLink === undefined && lateral(model, link) !== undefined);
}
function automatic(model: LayoutModel, link: LayoutLink): boolean {
  return model.document.links[link.sourceIndex]?.route === undefined;
}

/**
 * What a corridor is measured for when the caller is not the rows rule.
 *
 * `stroke` replaces the link's own width. Stage 8 passes the widest routed stroke, because that is
 * what `routeObstacles` and `reservationConflicts` expand every reservation by: a thin link measured
 * at its own width could be claimed inside the band the router would have kept clear.
 *
 * `attached` replaces the two ends the corridor may pass through. A whole link's corridor leaves one
 * of its ports and arrives at the other, so both are its own; one **piece** of a path may have a
 * reserved terminal at either end, and the node behind such an end is then ordinary foreign
 * geometry the piece has to keep out of.
 */
export interface CorridorOptions {
  stroke?: number;
  /** Receives the first check that refused the corridor (`ROUTED_CHORD_REFUSED`). */
  refusal?: { reason?: 'body' | 'pill' | 'lane' | 'frame' | 'corridor' };
  attached?: { nodes: readonly string[]; ports: readonly string[] };
}

/** Nothing foreign may lie inside the segment's gate clearances. Other pinned paths count as foreign. */
export function straightCorridorClear(model: LayoutModel, link: LayoutLink, segment: PathSegment,
  options: CorridorOptions = {}): boolean {
  // The corridor has to clear this link's own resolved width, not the theme default: a weighted
  // path measured at 1.5 px would be pinned where G6 then fails it.
  const stroke = options.stroke ?? linkStrokeWidth(link);
  const ends = link.attachments;
  if (!ends) return false;
  const attached = options.attached ?? { nodes: [ends.from.node, ends.to.node], ports: [portId(ends.from), portId(ends.to)] };
  const endNodes = new Set(attached.nodes);
  const endPorts = new Set(attached.ports);
  const refuse = (reason: NonNullable<NonNullable<CorridorOptions['refusal']>['reason']>): false => {
    if (options.refusal) options.refusal.reason = reason;
    return false;
  };
  const ownsObstacle = (owner: { kind: string; id?: string }): boolean => owner.kind === 'link' && owner.id === link.id;
  // The corridor is closed by whatever comes nearer than a clearance, so anything further than the
  // clearance from the segment's own bounding box cannot close it. Rejecting such a shape by four
  // comparisons keeps the measured distance for the few shapes that can. The answer is a single
  // boolean, so the tests may be taken in any order; each one below still measures exactly what it
  // measured before. The extra pixel covers the EPS the measured tests carry.
  const low = { x: Math.min(segment.from.x, segment.to.x), y: Math.min(segment.from.y, segment.to.y) };
  const high = { x: Math.max(segment.from.x, segment.to.x), y: Math.max(segment.from.y, segment.to.y) };
  // A rectangle's far edges are `x + width` and `y + height`, which is what the measured tests
  // read. Another run's far edges are the larger of its two endpoints: at a large coordinate
  // `x + width` does not return the edge the endpoint really has, and a reject computed from it
  // could drop a run the measured test would have rejected the corridor for.
  const near = measurable(low.x, low.y, high.x, high.y);
  const beyond = (box: Rect, reach: number): boolean => {
    const far = box.x + box.width, bottom = box.y + box.height;
    return near && measurable(box.x, box.y, far, bottom)
      && (low.x - far > reach || box.x - high.x > reach || low.y - bottom > reach || box.y - high.y > reach);
  };
  const beyondRun = (run: PathSegment, reach: number): boolean => {
    const runLeft = Math.min(run.from.x, run.to.x), runRight = Math.max(run.from.x, run.to.x);
    const runTop = Math.min(run.from.y, run.to.y), runBottom = Math.max(run.from.y, run.to.y);
    return near && measurable(runLeft, runTop, runRight, runBottom)
      && (low.x - runRight > reach || runLeft - high.x > reach || low.y - runBottom > reach || runTop - high.y > reach);
  };
  const pillReach = (stroke + DEFAULT_STROKE_WIDTHS.pill) / 2 + 1, laneReach = stroke / 2 + 1;
  const labelReach = stroke / 2 + GROUP_LABEL_LINK_CLEARANCE + 1;
  const groupReach = GROUP_EDGE_LINK_CLEARANCE + stroke / 2 + 1;
  for (const node of Object.values(model.nodes)) {
    if (node.layer === 'overlay' || !node.bounds) continue;
    const nodeStroke = node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node;
    if (!beyond(node.bounds, STRAIGHT_PATH_CLEARANCE.node + (stroke + nodeStroke) / 2 + 1) && !endNodes.has(node.id)
      && segmentRectDistance(segment, node.bounds) - (stroke + nodeStroke) / 2 < STRAIGHT_PATH_CLEARANCE.node - EPS) return refuse('body');
    for (const port of node.ports) {
      if (!port.pill || port.pill.layer === 'overlay' || beyond(port.pill.bounds, pillReach) || endPorts.has(portId(port.ref))) continue;
      if (segmentRectDistance(segment, port.pill.bounds) - (stroke + DEFAULT_STROKE_WIDTHS.pill) / 2 < -EPS) return refuse('pill');
    }
  }
  for (const label of model.labels) {
    if (label.omitted || !label.bounds || label.layer === 'overlay' || beyond(label.bounds, labelReach) || ownsObstacle(label.owner)) continue;
    if (label.role === 'pill' && label.port && endPorts.has(portId(label.port))) continue;
    if (segmentRectDistance(segment, label.bounds) < stroke / 2 + (label.role === 'group' ? GROUP_LABEL_LINK_CLEARANCE : 0) - EPS) return refuse('corridor');
  }
  for (const lane of model.lanes) {
    if (lane.layer === 'overlay' || beyond(lane.bounds, laneReach) || ownsObstacle(lane.owner)) continue;
    if (segmentRectDistance(segment, lane.bounds) < stroke / 2 - EPS) return refuse('lane');
  }
  // A foreign group box, with its edge margin, is closed to this link (ADR-0013): placement must
  // not reserve a straight corridor that stage 8 would then be forbidden to use. The consumer test
  // reads every link, so it is asked only about a group near enough to close the corridor.
  for (const [id, group] of Object.entries(model.groups)) {
    if (!group.bounds || !group.nodes.length || beyond(group.bounds, groupReach)) continue;
    if (groupConsumers(model, id).includes(link.id)) continue;
    if (segmentRectDistance(segment, group.bounds) < GROUP_EDGE_LINK_CLEARANCE + stroke / 2 - EPS) return refuse('frame');
  }
  for (const other of model.links) {
    // A straight link inside one frame is no obstacle: like an overlay link it reads bodies only.
    if (other.id === link.id || other.layer === 'overlay' || isRoutedChord(model, other)) continue;
    const otherStroke = linkStrokeWidth(other);
    const runReach = STRAIGHT_PATH_CLEARANCE.path + (stroke + otherStroke) / 2 + 1;
    // A stage-8 remainder (`fixed: false`) is routed around this corridor, so it is not an
    // obstacle to the rule that reserved the corridor first. Re-deriving the pin against it would
    // let routing retract a placement decision, which the pipeline's load-bearing rule forbids.
    const foreign = other.path?.fixed === false ? [] : other.path?.segments ?? [];
    for (const run of [...foreign, ...(other.fixedSegments ?? [])]) {
      if (beyondRun(run, runReach)) continue;
      if (segmentDistance(segment, run) - (stroke + otherStroke) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS) return refuse('corridor');
    }
  }
  for (const bundle of model.bundles) {
    for (const zone of [bundle.rows, bundle.envelope]) {
      if (zone && !beyond(zone, laneReach) && segmentRectDistance(segment, zone) < stroke / 2 - EPS) return refuse('corridor');
    }
  }
  for (const obstacle of model.obstacles) {
    if (beyond(obstacle.bounds, laneReach) || ownsObstacle(obstacle.owner)) continue;
    if (segmentRectDistance(segment, obstacle.bounds) < stroke / 2 - EPS) return refuse('corridor');
  }
  return true;
}

/** The single straight horizontal path the rows rule pins for this link, or undefined when ineligible. */
export function expectedRowPath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
  if (!rowPathCandidate(model, link)) return undefined;
  const level = link.groupLink === undefined ? expectedLevelPath(model, link) : undefined;
  // A level facing pair the rows rule pins keeps its anchor-to-anchor segment. Every other link inside
  // one frame answers to the frame rule, which reads the chord between the two faces (ticket 34).
  return level ?? (routedChordCandidate(model, link) ? expectedFramePath(model, link) : undefined);
}
function expectedLevelPath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
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
  // A stem placement promised blocks a chord only while its link stays orthogonal (ticket 88). The first pass
  // reads the links after a candidate as orthogonal, so a link that turns straight later still blocked an
  // earlier chord. Each further pass offers the refused frame candidates the chord again (a level pair outside a frame cannot change), keeping every chord held:
  // a new chord only removes a stem and checks its own clearance to the held chords, so the held set only
  // grows, and the loop ends when a pass adds none (at most one pass per candidate).
  const decide = (link: LayoutLink): boolean => {
    const path = expectedRowPath(draft, link);
    if (path) link.path = path;
    if (automatic(draft, link)) link.technique = path ? 'straight' : 'orthogonal';
    return path !== undefined;
  };
  withLinkFacts(draft, () => {
    let open = candidates.filter(link => !decide(link) && routedChordCandidate(draft, link));
    // Two passes, repeated until neither changes anything (ticket 89). The add-only pass above holds a chord only once every stem that blocks
    // it has gone, so two chords that each wait for the other's stem never start. The batch pass offers the candidates left together: each is
    // taken as straight, and a chord that fails against the others leaves and puts its stem back. Only a link that can hold alone (no tier
    // transit, title strip, corridor or body refuses it whatever the others do) is offered, so a chord that never could hold cannot
    // take a neighbour down with it; and the reverted links go back to the add-only pass, where they may hold alone.
    while (draft.frozenChords === undefined) {
      while (open.length) {
        const next = open.filter(link => !decide(link));
        if (next.length === open.length) break;
        open = next;
      }
      const held = open.length ? batchChords(draft, open, automatic) : [];
      if (!held.length) break;
      open = open.filter(link => !held.includes(link));
    }
  });
  // A straight link inside one frame is one chord between two faces, never a leaf of a fan tree.
  joinFanTrees(draft, candidates.filter(link => !isRoutedChord(draft, link)));
}

/**
 * The candidates that hold together (ticket 89). Every link that has a chord of its own takes it as a trial; a link that fails against the
 * others, a body or a title is taken out, all of those at once, and the rest are tried again, until none fails. Returns the links that hold;
 * the others are as they were.
 */
function batchChords(draft: LayoutModel, open: readonly LayoutLink[], automatic: (model: LayoutModel, link: LayoutLink) => boolean): LayoutLink[] {
  const before = new Map(open.map(link => [link, link.technique] as const));
  let trial = open.filter(link => {
    const segment = standaloneChord(draft, link);
    if (!segment) return false;
    link.path = { owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [{ ...segment, straight: true }] };
    if (automatic(draft, link)) link.technique = 'straight';
    return true;
  });
  for (;;) {
    const verdicts = trial.map(link => [link, expectedFramePath(draft, link)] as const);
    const failing = verdicts.filter(([, path]) => path === undefined).map(([link]) => link);
    if (!failing.length) {
      for (const [link, path] of verdicts) if (path) link.path = path;
      return trial;
    }
    for (const link of failing) {
      delete link.path;
      if (automatic(draft, link)) link.technique = before.get(link) ?? 'orthogonal';
    }
    trial = trial.filter(link => !failing.includes(link));
  }
}
