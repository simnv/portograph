import type { LayoutLink, LayoutModel, LayoutPath, PathSegment } from '../model/layout.js';
import { linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { effectiveLayer } from '../score/model.js';
import { overlayBlockers, straightChord } from './overlay-paths.js';
import { groupShape } from './grid.js';
import { bandSide, frameSide, GROUP_LABEL_GEOMETRY } from './bands.js';
import { findPort, STRAIGHT_PATH_CLEARANCE, straightCorridorClear } from './row-paths.js';

const OUTWARD = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } } as const;
import { measureText } from '../text/index.js';
import { EPS, intersection, samePoint, segmentDistance, segmentRectDistance } from '../score/geometry.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import type { Rect } from '../model/geometry.js';

/**
 * The **straight** technique of a routed link inside one frame (ticket 34).
 *
 * A routed link whose two ends lie in one frame (the same document group, or a parent and its
 * child) is one straight segment between the two port faces where the chord clears every node body
 * and every pill that is not its own, and keeps the orthogonal route where it does not. The
 * candidate is topology only, known from stage 1; the confirmation reads placed bodies, so it is
 * re-derived by `rebuildRowPaths` after every move (rows, lanes, flanks, centre), and a body that
 * has moved onto the chord takes the link back to the orthogonal route.
 */

/** The document group whose frame holds this layout group: the group itself, or a cell's frame. */
export function frameOfGroup(model: LayoutModel, id: string): string {
  return model.groups[id]?.frame ?? id;
}
function parentFrame(model: LayoutModel, frame: string): string | undefined {
  const parent = model.document.frames?.[frame]?.parent ?? model.document.groups[frame]?.parent;
  return parent === undefined ? undefined : frameOfGroup(model, parent);
}
/** Whether two frames are one frame for this rule: the same, or a parent and its direct child. */
function sameFrame(model: LayoutModel, a: string, b: string): boolean {
  return a === b || parentFrame(model, a) === b || parentFrame(model, b) === a;
}

/** Topology-only test: the frame rule owns this link's path whenever geometry makes it eligible. */
export function frameLinkCandidate(model: LayoutModel, link: LayoutLink): boolean {
  if (link.layer !== 'routed' || !link.attachments || link.bundle !== undefined) return false;
  if (link.technique === 'stub' || effectiveLayer(link) !== 'routed') return false;
  const route = model.document.links[link.sourceIndex]?.route;
  if (route !== undefined && route !== 'straight') return false;
  const { from, to } = link.attachments;
  if (from.node === to.node) return false;
  const a = model.document.nodes[from.node]?.group, b = model.document.nodes[to.node]?.group;
  if (a === undefined || b === undefined) return false;
  // A flank and a bar own their links' paths (flank and bar rules), and a bar is not a frame member.
  if ([a, b].some(id => model.groups[id]?.flank !== undefined || groupShape(model, id) === 'bar')) return false;
  return sameFrame(model, frameOfGroup(model, a), frameOfGroup(model, b));
}

/**
 * A link that took the straight technique and holds its pinned chord. It reserves no lane, no gap
 * run, no stem and no bar membership, and it is no obstacle to the router: like an overlay link it
 * is read by node bodies and pills only.
 */
export function isFrameStraight(model: LayoutModel, link: LayoutLink): boolean {
  return link.technique === 'straight' && link.path?.fixed === true && link.path.segments.length === 1
    && link.path.segments[0]!.straight === true && frameLinkCandidate(model, link);
}

/**
 * The title sides of one link array. A title stands on the edge with fewer routed ports on links that
 * cross its group's boundary (ADR-0011), which the port sides stage 6 froze already decide; stage 7g
 * only places the label on that edge. Cached on the link array like the peer index of `sides-two`:
 * every checked transaction clones the array, and the answer reads it alone.
 */
const sidesCache = new WeakMap<LayoutModel['links'], Map<string, 'top' | 'bottom' | undefined>>();
function titleSides(model: LayoutModel): Map<string, 'top' | 'bottom' | undefined> {
  const cached = sidesCache.get(model.links);
  if (cached) return cached;
  const sides = new Map<string, 'top' | 'bottom' | undefined>();
  for (const id of Object.keys(model.document.frames ?? {})) sides.set(id, frameSide(model, id));
  for (const [id, group] of Object.entries(model.groups)) if (group.frame === undefined) sides.set(id, bandSide(model, group));
  sidesCache.set(model.links, sides);
  return sides;
}

/**
 * The strips the titles stand in: the edge each titled group or frame keeps its label on, as tall as
 * the title's band, grown by the link-free margin. The label's x is chosen in 7g, after this rule pins
 * its chord, so the whole strip is held: a chord that crossed it would meet a title that no later stage
 * could move out of the way in a frame as narrow as its own label, and stage 9 would discover what
 * placement could have reserved. Such a link keeps the orthogonal route, which the title planner already
 * detours.
 */
function titleStrips(model: LayoutModel): Rect[] {
  const strips: Rect[] = [], sides = titleSides(model);
  const add = (label: string | undefined, side: 'top' | 'bottom' | undefined, box: Rect): void => {
    if (!label || side === undefined) return;
    const height = measureText(label, { fontSize: 12, weight: 700 }).height + 8 + 2 * GROUP_LABEL_LINK_CLEARANCE;
    strips.push({ x: box.x, y: side === 'top' ? box.y - GROUP_LABEL_LINK_CLEARANCE : box.y + box.height - height + GROUP_LABEL_LINK_CLEARANCE, width: box.width, height });
  };
  for (const [id, frame] of Object.entries(model.document.frames ?? {})) {
    const cells = frame.cells.map(cell => model.groups[cell]).filter(group => group?.bounds !== undefined)
      .sort((a, b) => a!.tier! - b!.tier!);
    const side = sides.get(id);
    if (cells.length) add(frame.label, side, (side === 'bottom' ? cells.at(-1)! : cells[0]!).bounds!);
  }
  for (const [id, group] of Object.entries(model.groups)) {
    if (group.frame === undefined && group.bounds && group.nodes.length) add(model.document.groups[id]?.label, sides.get(id), group.bounds);
  }
  return strips;
}

/** The bare chord of the link between its two faces, or undefined when its ends coincide. Nothing is checked. */
export function chordSegment(model: LayoutModel, link: LayoutLink): PathSegment | undefined {
  const chord = straightChord(model, link);
  if (!chord || Math.hypot(chord.to.x - chord.from.x, chord.to.y - chord.from.y) < 1e-6) return undefined;
  return { from: chord.from, to: chord.to, owner: { ...link.owner } };
}

/**
 * The chord of the link when nothing that no other link can change refuses it: the two faces, the tiers between them, the title strips and
 * the corridor the bodies and reservations leave (ticket 89 review). The fan rules ask this first: a link that fails here is no reason to
 * widen a face or to offer a chord to its neighbours.
 */
export function standaloneChord(model: LayoutModel, link: LayoutLink): PathSegment | undefined {
  const segment = chordSegment(model, link);
  if (!segment) return undefined;
  // A link that crosses a tier it does not end in needs the lane lanes.ts reserves for it, and a lane
  // cannot be given back after 7c has aligned the ends under it. Such a link keeps the lane and the
  // orthogonal route, so that no move after stage 7a can leave a transit without its reservation.
  const tiers = [link.attachments!.from.node, link.attachments!.to.node].map(id => model.groups[model.document.nodes[id]!.group]!.tier!);
  if (model.tierBands.some(band => band.tier > Math.min(...tiers) && band.tier < Math.max(...tiers))) return undefined;
  if (titleStrips(model).some(strip => segmentRectDistance(segment, strip) === 0)) return undefined;
  // The chord must also hold every clearance the gates measure a routed segment against (G2, G6),
  // or a published straight link would fail the gate its rule was meant to satisfy.
  if (!straightCorridorClear(model, link, segment)) return undefined;
  return segment;
}

/**
 * The reserved vertical run of a link that stays orthogonal, at one end: from the port face outward to the row the plan will
 * seat, which is not known before 7f: the whole tier gap it faces when the link runs on through it, or a drop to the far port's stem tip when
 * that port stands in the band across the gap. A side port or a port with no tier gap beyond it keeps the stem alone (ticket 91).
 */
export function orthogonalLeg(model: LayoutModel, link: LayoutLink, end: 'from' | 'to'): PathSegment | undefined {
  const port = findPort(model, link.attachments![end]), out = port?.side === undefined ? undefined : OUTWARD[port.side];
  if (!port?.anchor || !out) return undefined;
  let length: number = GROUP_LABEL_GEOMETRY.routerStem;
  if (out.x === 0) {
    const y = port.anchor.y;
    const boxes = model.tierBands.flatMap(band => band.bounds ? [band.bounds] : []);
    const edgeOf = (box: Rect): number => out.y > 0 ? box.y : box.y + box.height;
    const across = boxes.filter(box => (edgeOf(box) - y) * out.y > EPS).sort((a, b) => (edgeOf(a) - edgeOf(b)) * out.y)[0];
    if (across) {
      const edge = edgeOf(across);
      const far = findPort(model, link.attachments![end === 'from' ? 'to' : 'from']);
      // The far end stands in the band across the gap, facing back: the link ends in this gap, and its longest vertical is a drop to the
      // far port's stem tip (a row stands at most there; a row nearer the edge, at the group-edge margin, is shorter). Otherwise the
      // link runs on through the gap by a lane and the leg is the whole gap (ticket 91).
      const meets = far?.anchor !== undefined && far.side === (out.y > 0 ? 'top' : 'bottom')
        && far.anchor.y >= across.y - EPS && far.anchor.y <= across.y + across.height + EPS;
      const reach = meets ? far!.anchor!.y - out.y * GROUP_LABEL_GEOMETRY.routerStem : edge;
      length = Math.max(length, Math.abs(reach - y));
    }
  }
  return { from: port.anchor, to: { x: port.anchor.x + length * out.x, y: port.anchor.y + length * out.y }, owner: { ...link.owner } };
}

/** The chord this rule pins for the link, or undefined when a body stands on it or a gate would fail it. */
export function expectedFramePath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
  if (!frameLinkCandidate(model, link)) return undefined;
  if (model.frozenChords !== undefined) return frozenChordPath(model, link);
  const segment = standaloneChord(model, link);
  if (!segment) return undefined;
  // Two chords are no obstacle to each other for the router, but G6 still measures their clearance:
  // only a strict crossing excuses a pair that stands closer than 10 px (a shared end does not).
  const stroke = linkStrokeWidth(link);
  for (const other of model.links) {
    if (other.id === link.id || !isFrameStraight(model, other)) continue;
    const run = other.path!.segments[0]!;
    if (!chordsApart(segment, run, stroke, linkStrokeWidth(other))) return undefined;
  }
  // The router leaves every other port by a stem of at least 15 px, and G6 keeps that stem 10 px from the
  // chord. Stage 8 cannot make room the chord took, so the chord stays clear of every stem placement has
  // already promised, its own ports' other links included. The stem is only the start of a vertical leg that runs on
  // to the link's gap row, so the chord holds the clearance against the whole leg (ticket 91).
  for (const other of model.links) {
    if (other.id === link.id || other.layer !== 'routed' || other.technique === 'stub' || !other.attachments || other.removed === true) continue;
    if (isFrameStraight(model, other)) continue;
    for (const end of ['from', 'to'] as const) {
      const leg = orthogonalLeg(model, other, end);
      if (leg && segmentDistance(segment, leg) - (stroke + linkStrokeWidth(other)) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS) return undefined;
    }
  }
  // Declared, at any angle: the segment has no axis to read, so the gates measure it by distance.
  segment.straight = true;
  return { owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [segment] };
}

/**
 * From stage 7f on the decision is frozen: a link that held a chord keeps it and only the segment follows
 * its ports; a link that did not stays orthogonal, because the room a fallback needs (stems, a gap row)
 * was sized before 7f and nothing after it sizes more (ticket 34).
 */
function frozenChordPath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
  if (!model.frozenChords!.includes(link.id)) return undefined;
  const chord = straightChord(model, link, undefined, true);
  if (!chord) return undefined;
  const segment: PathSegment = { from: chord.from, to: chord.to, owner: { ...link.owner }, straight: true };
  return { owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [segment] };
}

/** The chords held at the start of 7f: the links that are straight now. */
export function freezeChords(model: LayoutModel): void {
  const held = model.links.filter(link => isFrameStraight(model, link)).map(link => link.id);
  // No field where nothing is held, so a model without a chord keeps the shape it always had.
  if (held.length) model.frozenChords = held;
}

/** The frozen chords a body or a foreign pill stands on. Empty when none is held. */
export function blockedChords(model: LayoutModel): string[] {
  if (!model.frozenChords?.length) return [];
  const blockers = overlayBlockers(model);
  return model.frozenChords.filter(id => {
    const link = model.links.find(item => item.id === id);
    return link !== undefined && straightChord(model, link, blockers) === undefined;
  });
}
/** Whether two chords keep the chord clearance to each other, or cross strictly (G6 excuses only a strict crossing). */
function chordsApart(a: PathSegment, b: PathSegment, strokeA: number, strokeB: number): boolean {
  const point = intersection(a, b);
  const strict = point !== undefined && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, point));
  return strict || segmentDistance(a, b) - (strokeA + strokeB) / 2 >= STRAIGHT_PATH_CLEARANCE.path - EPS;
}

/**
 * Whether every frozen chord still clears every body and pill once the proposed groups take their boxes.
 * The 7f counterpart of `laneSidesHold`: a move that fails is refused for that unit, and the link is named
 * in a diagnostic. Nothing is held before 7f, so centring and the column rules pass through here unchanged.
 */
export function chordsHold(model: LayoutModel, proposed: { group: { nodes: string[]; bounds?: Rect }; bounds: Rect }[], report = true): boolean {
  if (!model.frozenChords?.length) return true;
  const nodes = { ...model.nodes };
  for (const { group, bounds } of proposed) {
    const from = group.bounds;
    if (!from) continue;
    const dx = bounds.x - from.x, dy = bounds.y - from.y;
    if (!dx && !dy) continue;
    for (const id of group.nodes) {
      const node = model.nodes[id];
      if (!node?.bounds) continue;
      nodes[id] = { ...node, bounds: { ...node.bounds, x: node.bounds.x + dx, y: node.bounds.y + dy },
        ports: node.ports.map(port => ({ ...port,
          ...(port.anchor ? { anchor: { x: port.anchor.x + dx, y: port.anchor.y + dy } } : {}),
          ...(port.pill ? { pill: { ...port.pill, bounds: { ...port.pill.bounds, x: port.pill.bounds.x + dx, y: port.pill.bounds.y + dy } } } : {}) })) };
    }
  }
  const held = blockedChords({ ...model, nodes });
  // A caller that tries many candidates asks with `report` off and reports the final verdict itself (ticket 77).
  if (report) for (const id of held) {
    if (!model.diagnostics.some(item => item.code === 'STRAIGHT_LINK_HELD' && item.owners?.some(owner => owner.kind === 'link' && owner.id === id))) {
      model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'STRAIGHT_LINK_HELD',
        message: `A move that would put a body on the straight link ${id} is refused.`, owners: [{ kind: 'link', id }] });
    }
  }
  return held.length === 0;
}

/**
 * The clearance of every pair of held chords that stands nearer than `within` px and does not cross strictly, keyed `a|b` in link order.
 * Read before and after 7f, it says which pairs 7f closed under the clearance (ticket 89 review); it moves nothing.
 */
export function chordClearances(model: LayoutModel, within = 30): Map<string, number> {
  const chords = model.links.filter(link => isFrameStraight(model, link));
  const result = new Map<string, number>();
  for (const [index, one] of chords.entries()) for (const other of chords.slice(index + 1)) {
    const a = one.path!.segments[0]!, b = other.path!.segments[0]!;
    if (Math.min(a.from.x, a.to.x) - within > Math.max(b.from.x, b.to.x) || Math.min(b.from.x, b.to.x) - within > Math.max(a.from.x, a.to.x)
      || Math.min(a.from.y, a.to.y) - within > Math.max(b.from.y, b.to.y) || Math.min(b.from.y, b.to.y) - within > Math.max(a.from.y, a.to.y)) continue;
    const point = intersection(a, b);
    if (point !== undefined && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, point))) continue;
    result.set(`${one.id}|${other.id}`, segmentDistance(a, b) - (linkStrokeWidth(one) + linkStrokeWidth(other)) / 2);
  }
  return result;
}
