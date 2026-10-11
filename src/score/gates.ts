import type { Frame, LayoutLink, LayoutModel, LayoutNode, PathSegment, Point, Rect } from '../model/index.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import { EPS, bottom, contains, horizontal, intersection, length, near, overlapSegment, rectDistance, rectOverlap, right, samePoint, segmentDistance, segmentRect, segmentRectDistance, vertical } from './geometry.js';

/** A rejection box kept by its far edges; see `gates`. `measurable` is false beyond `REJECT_LIMIT`. */
interface Span { x: number; y: number; right: number; bottom: number; measurable: boolean }

/**
 * Coordinate magnitude beyond which a pair is measured instead of rejected.
 *
 * The measured tests build parametric slabs and projections from differences of coordinates. Two
 * coordinates further apart than this cancel, and the test can then report a contact that is not
 * there. A rejection bound cannot reproduce such an answer, so a pair that reaches this magnitude
 * skips the reject and is measured, exactly as it was before. Below it one subtraction is accurate
 * to 2^-27 px, which the reject's own one-pixel margin covers many times over. No diagram this
 * pipeline lays out comes near the limit.
 */
const REJECT_LIMIT = 2 ** 26;
const measurable = (x: number, y: number, right: number, bottom: number): boolean =>
  x > -REJECT_LIMIT && y > -REJECT_LIMIT && right < REJECT_LIMIT && bottom < REJECT_LIMIT;
import { anchorOnBoundary, barContact, bundlePair, effectiveLayer, endpoints, groupBoxes, groupConsumers, incident, junctionFan, linkPort, mergedRun, outward, port, refEqual, refKey, sharedStem } from './model.js';
import { overlayEndpoint } from '../layout/overlay-paths.js';
import { isRoutedChord } from '../layout/frame-paths.js';
import { separationShortfalls } from '../layout/constraints/separation.js';
import type { Segment } from './model.js';
import type { GateId, GateResult, ScoreCounters } from './types.js';

/**
 * The two runs on either side of one tread of an orthogonal staircase: the same link's segments
 * `i` and `i + 2`, joined by the segment between them, with no shared extent. They lie before and
 * after the tread, so they never appear beside each other and their measured distance is a corner
 * of one wire. Any other pair of a link's segments — a loop that brings two distant bends together,
 * for instance — is measured like any other clearance pair.
 */
function staircaseTread(a: Segment, b: Segment): boolean {
  if (a.link.id !== b.link.id || Math.abs(a.index - b.index) !== 2) return false;
  const segments = a.link.path!.segments;
  const low = Math.min(a.index, b.index), tread = segments[low + 1];
  if (!tread) return false;
  return samePoint(segments[low]!.to, tread.from) && samePoint(tread.to, segments[low + 2]!.from)
    && !alongside(a.segment, b.segment);
}

/** Shared extent of two parallel axis-aligned segments along the axis they both run on. */
export function alongside(a: PathSegment, b: PathSegment): boolean {
  const along = horizontal(a) && horizontal(b)
    ? (segment: PathSegment): [number, number] => [Math.min(segment.from.x, segment.to.x), Math.max(segment.from.x, segment.to.x)]
    : (segment: PathSegment): [number, number] => [Math.min(segment.from.y, segment.to.y), Math.max(segment.from.y, segment.to.y)];
  const [aLow, aHigh] = along(a), [bLow, bHigh] = along(b);
  return Math.min(aHigh, bHigh) - Math.max(aLow, bLow) > EPS;
}

/**
 * G9 `frame-contains` (ranked-groups spec, section 5). A frame holds its cells and its child frames;
 * no two frames that are not parent and child overlap, and no frame overlaps a group that is not one
 * of its cells; no node outside a frame's cells and child cells lies inside it. G1 and G8 keep
 * reading cells.
 */
function frameGate(model: LayoutModel, fail: (id: GateId, code: string, elements: string[], message: string) => void): void {
  const frames = model.frames ?? [];
  const byId = new Map(frames.map(frame => [frame.id, frame]));
  /** Whether `frame` stands below `above` in the parent chain (a canton holds members, a member its children). */
  const below = (frame: Frame, above: string): boolean => {
    for (let id = frame.parent; id !== undefined; id = byId.get(id)?.parent) if (id === above) return true;
    return false;
  };
  const cellsOf = (id: string): Set<string> => new Set(frames.filter(frame => frame.id === id || below(frame, id)).flatMap(frame => frame.cells));
  for (const [i, frame] of frames.entries()) {
    for (const cell of frame.cells) {
      const group = model.groups[cell];
      if (!group?.bounds || !contains(frame.box, group.bounds)) fail('G9', 'frame-contains', [frame.id, cell], 'Frame must contain its cells');
    }
    const parent = frames.find(item => item.id === frame.parent);
    if (parent && !contains(parent.box, frame.box)) fail('G9', 'frame-contains', [parent.id, frame.id], 'Frame must contain its child frames');
    for (const other of frames.slice(i + 1)) {
      if (below(other, frame.id) || below(frame, other.id)) continue;
      if (rectOverlap(frame.box, other.box)) fail('G9', 'frame-overlap', [frame.id, other.id], 'Frames overlap');
    }
    const own = cellsOf(frame.id);
    for (const group of Object.values(model.groups)) {
      if (own.has(group.id) || group.frame !== undefined || !group.bounds || !group.nodes.length) continue;
      if (rectOverlap(frame.box, group.bounds)) fail('G9', 'frame-overlap', [frame.id, group.id], 'Frame overlaps a group that is not its own');
    }
    const held = new Set([...own].flatMap(cell => model.groups[cell]?.nodes ?? []));
    for (const node of Object.values(model.nodes)) {
      if (held.has(node.id) || !node.bounds) continue;
      if (rectOverlap(frame.box, node.bounds)) fail('G9', 'frame-foreign-node', [frame.id, node.id], 'A node outside the frame lies inside it');
    }
  }
}

/**
 * G9 `min-separation` (architecture ticket 17). The last check of placement, read on the published model: every hard minimum separation of the x constraint
 * catalogue (the band gap between root groups and frames, the frame gap, the cell gap) that the layout stands under, whatever its classification. It reports and
 * repairs nothing. A gap wider than the minimum is no finding.
 */
function separationGate(model: LayoutModel, fail: (id: GateId, code: string, elements: string[], message: string) => void): void {
  if (Object.values(model.groups).some(group => group.bounds === undefined)) return;
  for (const [id, item] of separationShortfalls(model)) fail('G9', 'min-separation', item.owners, `Minimum separation ${id} is short by ${item.short.toFixed(1)} px`);
}

/**
 * G5 `port-order` / `author-port-order`: on each side, ports order by their far ends unless authored. The gate reads it, and so does
 * placement, which asks whether a move of a group turns the far ends of a port over (ticket 77): one predicate.
 */
export function portOrder(model: LayoutModel, nodes: readonly LayoutNode[], routedLinks: ReadonlySet<LayoutLink>,
  fail: (id: GateId, code: string, elements: string[], message: string) => void): void {
  // Every port's far anchors, recorded in one pass over the routed links. The port-order gate below
  // reads this index; scanning every link for every port made the gate quadratic in the diagram.
  // A link is seen from both of its ends, exactly as the gate saw it, and a link whose far port is
  // missing contributes nothing, as before.
  const farAnchors = new Map<string, Point[]>();
  for (const link of model.links) {
    if (!routedLinks.has(link)) continue;
    const ends = endpoints(link);
    for (const [near, far] of [[ends.from, ends.to], [ends.to, ends.from]] as const) {
      const target = port(model, far);
      if (!target) continue;
      const at = refKey(near), list = farAnchors.get(at);
      if (list) list.push(target.anchor!); else farAnchors.set(at, [target.anchor!]);
    }
  }
  for (const node of nodes) for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const alongX = side === 'top' || side === 'bottom';
    const positions = node.ports.filter(p => p.side === side && p.authorOrder === undefined).flatMap(p => {
      const peers = farAnchors.get(refKey(p.ref));
      if (!peers?.length) return [];
      let min = Infinity, max = -Infinity;
      for (const anchor of peers) {
        const at = alongX ? anchor.x : anchor.y;
        if (at < min) min = at;
        if (at > max) max = at;
      }
      return [{ own: alongX ? p.anchor!.x : p.anchor!.y, min, max }];
    });
    for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i]!, b = positions[j]!;
      if (a.own < b.own - EPS && a.min > b.max + EPS || b.own < a.own - EPS && b.min > a.max + EPS)
        fail('G5', 'port-order', [node.id], 'Port order must match strictly separated far-end ranges unless authored');
    }
    const authored = node.ports.filter(p => p.side === side && p.authorOrder !== undefined)
      .sort((a, b) => (side === 'top' || side === 'bottom' ? a.anchor!.x - b.anchor!.x : a.anchor!.y - b.anchor!.y));
    if (authored.some((p, i) => i > 0 && p.authorOrder! < authored[i - 1]!.authorOrder!))
      fail('G5', 'author-port-order', [node.id], 'Physical port order reverses unequal authored keys');
  }
}

/**
 * G6 `parallel-clearance` / `bundle-member-gap` over the routed segments: every pair that stands closer than its clearance and is
 * not excused. The gate reads it, and so does placement, which asks it of a model it has not routed (ticket 77): one predicate.
 */
export function parallelClearance(model: LayoutModel, routed: Segment[], fail: (id: GateId, code: string, elements: string[], message: string) => void): void {
  for (let i = 0; i < routed.length; i++) for (let j = i + 1; j < routed.length; j++) {
    const a = routed[i]!, b = routed[j]!;
    if (a.link.id === b.link.id && Math.abs(a.index - b.index) <= 1) continue;
    // Axis-aligned pairs on the same axis, and any pair where a declared straight bundle member is
    // involved (ADR-0017): a diagonal has no axis, so its clearance is measured by distance against
    // every other segment it does not cross.
    const diagonal = a.segment.straight === true || b.segment.straight === true;
    if (!diagonal && !(horizontal(a.segment) && horizontal(b.segment) || vertical(a.segment) && vertical(b.segment))) continue;
    if (diagonal) {
      // Only a strict crossing — interior of both runs — excuses the pair; an endpoint or T contact
      // still owes the clearance.
      const point = intersection(a.segment, b.segment);
      const strict = point !== undefined
        && ![a.segment.from, a.segment.to, b.segment.from, b.segment.to].some(end => samePoint(end, point));
      if (strict) continue;
    }
    // One link's own staircase tread is not a clearance pair. Stage 7a reserves a lane at a fixed x
    // and states that routing completes the attachment jog, so a tread shorter than the clearance
    // is expected geometry rather than a corridor two objects share.
    if (staircaseTread(a, b)) continue;
    const overlap = overlapSegment(a.segment, b.segment);
    if (overlap && sharedStem(model, a, b, overlap) || junctionFan(model, a, b)) continue;
    const bundle = bundlePair(model, a, b);
    // Merged members intentionally share one rendered run. Other bundle runs retain memberGap.
    if (overlap && mergedRun(model, a, b, overlap)) continue;
    const min = bundle ? model.bundles.find(item => item.id === a.link.bundle)!.memberGap ?? 16 : 10;
    const distance = segmentDistance(a.segment, b.segment) - (a.stroke + b.stroke) / 2;
    if (distance < min - EPS) fail('G6', bundle ? 'bundle-member-gap' : 'parallel-clearance', [a.link.id, b.link.id], `Parallel clearance is below ${min} px`);
  }
}

export function gates(model: LayoutModel, routed: Segment[], counters: ScoreCounters): Record<GateId, GateResult> {
  const nodes = Object.values(model.nodes), groups = Object.values(model.groups);
  const gate = (warning = false): GateResult => ({ passed: true, severity: warning ? 'warning' : 'error', violations: [] });
  const result: Record<GateId, GateResult> = { G1: gate(), G2: gate(), G3: gate(nodes.length > 300), G4: gate(), G5: gate(), G6: gate(), G7: gate(), G8: gate(), G9: gate() };
  const fail = (id: GateId, code: string, elements: string[], message: string): void => { result[id].passed = false; result[id].violations.push({ code, elements, message }); };
  const nodeStroke = (n: LayoutNode): number => n.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node;
  // `routed` holds one entry per segment, so "does this link have a routed segment?" was a scan of
  // every segment; the set answers it once.
  const routedLinks = new Set(routed.map(s => s.link));
  // Every gate that pairs one segment or one label with one box fires only when the two are close,
  // and each exact test is dear: two port lookups, a segment-to-rectangle distance, or both. A box
  // grown by the clearance the test uses contains everything that could fire, so a pair it rejects
  // needs no test at all. The loops still walk the model in model order, so the violations they
  // report, and the order they report them in, do not change. The extra pixel covers the EPS the
  // exact tests carry.
  // A span keeps its far edges, never a width: at a large coordinate `x + width` does not return
  // the edge the far endpoint really has, and a reject computed from it could drop a pair the
  // exact test would have failed. A rectangle's far edge is `right()` and `bottom()`, which is
  // what the exact tests read; a segment's is the larger of its two endpoints.
  const span = (x: number, y: number, far: number, low: number): Span =>
    ({ x, y, right: far, bottom: low, measurable: measurable(x, y, far, low) });
  const rectSpan = (box: Rect): Span => span(box.x, box.y, right(box), bottom(box));
  const segmentSpan = (item: PathSegment): Span => span(
    Math.min(item.from.x, item.to.x), Math.min(item.from.y, item.to.y),
    Math.max(item.from.x, item.to.x), Math.max(item.from.y, item.to.y));
  const segmentSpans = routed.map(item => segmentSpan(item.segment));
  const apart = (a: Span, b: Span, reach: number): boolean => a.measurable && b.measurable
    && (a.x - b.right > reach || b.x - a.right > reach || a.y - b.bottom > reach || b.y - a.bottom > reach);
  const nodeSpans = nodes.map(node => rectSpan(node.bounds!));
  let widestNodeStroke: number = DEFAULT_STROKE_WIDTHS.node;
  for (const node of nodes) { const width = nodeStroke(node); if (width > widestNodeStroke) widestNodeStroke = width; }
  // A named port's pill stands outside its node, so one node's whole block is governed by the union
  // of its rectangle and its pills.
  const nodeExtent = nodes.map((node, index) => {
    let box = nodeSpans[index]!;
    for (const item of node.ports) {
      if (!item.pill) continue;
      const other = item.pill.bounds;
      box = span(Math.min(box.x, other.x), Math.min(box.y, other.y),
        Math.max(box.right, right(other)), Math.max(box.bottom, bottom(other)));
    }
    return box;
  });
  const labelNodeReach = Math.max(widestNodeStroke, DEFAULT_STROKE_WIDTHS.pill) / 2 + 1;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    const group = a.owner.kind === 'group' ? model.groups[a.owner.id] : undefined;
    if (!group || !group.nodes.includes(a.id) || !contains(group.bounds!, a.bounds!)) fail('G1', 'node-containment', [a.id], 'Node must lie inside its owning group');
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      if (rectOverlap(a.bounds!, b.bounds!)) fail('G1', 'node-overlap', [a.id, b.id], 'Node rectangles overlap');
      if (a.layer !== 'overlay' && b.layer !== 'overlay' && rectDistance(a.bounds!, b.bounds!) - (nodeStroke(a) + nodeStroke(b)) / 2 < 20 - EPS) fail('G6', 'node-clearance', [a.id, b.id], 'Node clearance is below 20 px');
    }
    for (const p of a.ports) if (p.ref.node !== a.id || !anchorOnBoundary(p, a.bounds!)) fail('G7', 'anchor-boundary', [a.id], 'Port anchor must lie on its declared node side');
  }
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!, band = model.tierBands.find(b => b.tier === group.tier);
    if (!band || !band.groups.includes(group.id) || !contains(band.bounds!, group.bounds!)) {
      fail('G1', 'group-containment', [group.id], 'Group must lie inside its tier band');
      fail('G8', 'group-tier', [group.id], 'Group must lie inside its tier band');
    }
    for (let j = i + 1; j < groups.length; j++) {
      const b = groups[j]!;
      if (rectOverlap(group.bounds!, b.bounds!)) fail('G1', 'group-overlap', [group.id, b.id], 'Group rectangles overlap');
    }
  }
  frameGate(model, fail);
  separationGate(model, fail);
  const bands = [...model.tierBands].sort((a, b) => a.tier - b.tier);
  for (let i = 1; i < bands.length; i++) {
    const a = bands[i - 1]!, b = bands[i]!;
    if (a.tier === b.tier || bottom(a.bounds!) > b.bounds!.y + EPS) fail('G8', 'tier-order', [String(a.tier), String(b.tier)], 'Tier bands must be ordered and non-overlapping');
  }
  // G2 `through-node` and G6 `segment-node-clearance` read `routed` only. An overlay path is exempt from them by design, so an
  // overlay link drawn straight over a node body under the opt-in `layout.overlayOverBodies` (ticket 152, `OVERLAY_OVER_BODY`)
  // fails no gate: no gate forbids an overlay line through a body, and none needs an exception for it.
  const crossedBars = new Set<string>();
  for (const [index, s] of routed.entries()) {
    const box = segmentSpans[index]!, reach = 10 + (s.stroke + widestNodeStroke) / 2 + 1;
    for (let n = 0; n < nodes.length; n++) {
      const node = nodes[n]!;
      if (node.layer === 'overlay' || apart(box, nodeSpans[n]!, reach)) continue;
      const owned = incident(model, s, node.id), bar = barContact(model, s, node.id);
      const distance = segmentRectDistance(s.segment, node.bounds!);
      if (bar && distance <= EPS) crossedBars.add(`${s.link.id}:${node.id}`);
      if (!owned && !bar) {
        if (segmentRect(s.segment, node.bounds!)) fail('G2', 'through-node', [s.link.id, node.id], 'Routed segment touches a foreign node');
        if (distance - (s.stroke + nodeStroke(node)) / 2 < 10 - EPS) fail('G6', 'segment-node-clearance', [s.link.id, node.id], 'Routed segment clearance to a foreign node is below 10 px');
      }
    }
  }
  counters.barCross = crossedBars.size;
  // Group boxes are geometry links respect (ADR-0013): no segment inside a foreign group, and no
  // segment running along any group edge closer than the edge margin.
  // A frame stands in for its cells here: a cell is never an obstacle (ranked-groups spec, section 2).
  const obstacleBoxes = groupBoxes(model).map(({ id, bounds }) => ({ id, bounds, consumers: new Set(groupConsumers(model, id)) }));
  for (const s of routed) {
    for (const group of obstacleBoxes) {
      const box = group.bounds;
      if (!group.consumers.has(s.link.id) && segmentRect(s.segment, box)) fail('G2', 'through-group', [s.link.id, group.id], 'Routed segment passes through a foreign group');
      // Inside its own box a link turns in the group's padding; on or outside an edge it keeps the margin.
      const along = (edge: number, low: number, high: number, at: number, from: number, to: number, inner: [number, number]): boolean =>
        !(at > inner[0] + EPS && at < inner[1] - EPS)
        && Math.abs(at - edge) < GROUP_EDGE_LINK_CLEARANCE + s.stroke / 2 - EPS && Math.min(from, to) < high - EPS && Math.max(from, to) > low + EPS;
      const { from, to } = s.segment;
      const runs = horizontal(s.segment)
        ? [box.y, bottom(box)].some(edge => along(edge, box.x, box.x + box.width, from.y, from.x, to.x, [box.y, bottom(box)]))
        : vertical(s.segment) && [box.x, box.x + box.width].some(edge => along(edge, box.y, bottom(box), from.x, from.y, to.y, [box.x, box.x + box.width]));
      if (runs) fail('G6', 'segment-group-edge', [s.link.id, group.id], `Routed segment runs along a group edge closer than ${GROUP_EDGE_LINK_CLEARANCE} px beyond its half stroke`);
    }
  }
  // G3 leaves out the labels of overlay links; the label of a mesh bus is read against routed geometry (mesh-bus.md, section 5).
  const labels = model.labels.filter(l => !l.omitted && (l.layer !== 'overlay' || l.role === 'mesh-bus'));
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    const associatedPill = label.role === 'pill' && label.port ? port(model, label.port)?.pill : undefined;
    const containedOwnPill = associatedPill !== undefined && label.port !== undefined
      && label.owner.kind === 'node' && label.owner.id === label.port.node
      && associatedPill.owner.kind === 'node' && associatedPill.owner.id === label.port.node
      && contains(associatedPill.bounds, label.bounds!);
    const hit = (other: string): void => { counters.labelHits++; fail('G3', 'label-collision', [label.id, other], 'Label intersects unrelated geometry'); };
    const labelSpan = rectSpan(label.bounds!);
    for (let j = i + 1; j < labels.length; j++) {
      const other = labels[j]!;
      if (rectOverlap(label.bounds!, other.bounds!)) hit(other.id);
    }
    for (let n = 0; n < nodes.length; n++) {
      const node = nodes[n]!;
      if (apart(labelSpan, nodeExtent[n]!, labelNodeReach)) continue;
      const owns = label.owner.kind === 'node' && label.owner.id === node.id;
      const ownedExtent = owns && (label.role === 'pill' ? containedOwnPill : contains(node.bounds!, label.bounds!));
      if (node.layer !== 'overlay' && !ownedExtent && (rectDistance(label.bounds!, node.bounds!) < nodeStroke(node) / 2 - EPS || rectOverlap(label.bounds!, node.bounds!))) hit(node.id);
      for (const p of node.ports) {
        if (!p.pill || p.pill.layer === 'overlay') continue;
        const ownPill = owns && containedOwnPill && label.port !== undefined && refEqual(label.port, p.ref);
        if (!ownPill && (rectOverlap(label.bounds!, p.pill.bounds) || rectDistance(label.bounds!, p.pill.bounds) < DEFAULT_STROKE_WIDTHS.pill / 2 - EPS)) hit(`pill:${node.id}:${p.ref.ordinal}`);
      }
    }
    // A group title owns a link-free margin beyond its stroke-aware edge.
    const margin = label.role === 'group' ? GROUP_LABEL_LINK_CLEARANCE : 0;
    for (let k = 0; k < routed.length; k++) {
      const s = routed[k]!;
      if (apart(labelSpan, segmentSpans[k]!, s.stroke / 2 + margin + 1)) continue;
      // A pill's own incident stem runs behind the pill text by construction.
      if (containedOwnPill && label.port && incident(model, s, label.port.node)
        && [endpoints(s.link).from, endpoints(s.link).to].some(ref => refEqual(ref, label.port!))) continue;
      // A label on a direct line (ticket 16) lies on the one segment it names, centred, and the
      // renderer cuts that line away under the text: that segment is the label's own line, no hit.
      const own = label.onLine === true && label.support?.kind === 'link-segment' && label.owner.kind === 'link' && label.owner.id === label.support.link
        && label.support.link === s.link.id && s.index >= label.support.segment && s.index <= (label.support.through ?? label.support.segment);
      if (own && !horizontal(s.segment) && !vertical(s.segment)) continue;
      // Text drawn across a routed segment is a hit whatever it claims to support.
      if (segmentRect(s.segment, label.bounds!)) { hit(s.link.id); continue; }
      // Only the clearance zone of the one segment a link label was measured against is exempt.
      // Another segment of the same link, a stale or absent reference, and every multiplicity
      // label exempt nothing.
      const support = label.support;
      if (support?.kind === 'link-segment' && label.owner.kind === 'link' && label.owner.id === support.link
        && support.link === s.link.id && s.index >= support.segment && s.index <= (support.through ?? support.segment)) continue;
      if (segmentRectDistance(s.segment, label.bounds!) < s.stroke / 2 + margin - EPS) hit(s.link.id);
    }
  }
  collinearSweep(routed, (a, b, overlap) => {
    if (length(overlap) <= 1 + EPS) return;
    if (mergedRun(model, a, b, overlap)) counters.bundledLength += length(overlap);
    else if (!sharedStem(model, a, b, overlap)) { counters.overlaps++; fail('G4', 'collinear-overlap', [a.link.id, b.link.id], 'Routed segments share more than 1 px'); }
  });
  const lanesUsed = new Set<string>();
  // A span corridor (architecture ticket 22) is a reservation for its chord, which crosses other chords' corridors strictly: it is no lane for this gate.
  for (const lane of model.lanes.filter(lane => lane.layer !== 'overlay' && lane.kind !== 'span')) for (const s of routed) {
    if (!segmentRect(s.segment, lane.bounds)) continue;
    const laneOwner = lane.owner;
    const owns = laneOwner.kind === 'link' && laneOwner.id === s.link.id || laneOwner.kind === 'bundle' && laneOwner.id === s.link.bundle && model.bundles.some(b => b.id === laneOwner.id && b.owner.kind === 'bundle' && b.owner.id === b.id && b.members.includes(s.link.id));
    if (owns && s.segment.lane === lane.id && vertical(s.segment) && near(s.segment.from.x, lane.x)) lanesUsed.add(lane.id);
    // The side run of a side lane starts at the lane x and leaves the lane's box sideways (side-faces.md, Section 10): its owner's reserved run.
    else if (owns && lane.kind === 'side' && s.segment.lane === lane.id && near(s.segment.from.y, s.segment.to.y)) lanesUsed.add(lane.id);
    // The runs of a course lane (ticket 15): its vertical run, the side runs and the padding rows of its ends, all its owner's.
    else if (owns && (lane.kind === 'perimeter' || lane.kind === 'gap') && s.segment.lane === lane.id) lanesUsed.add(lane.id);
    else fail('G4', 'lane-owner', [s.link.id, lane.id], 'Only its owner may occupy a reserved lane');
  }
  counters.lanesUsed = lanesUsed.size;
  for (const link of model.links) {
    const ends = endpoints(link), from = linkPort(model, link, 'from'), to = linkPort(model, link, 'to'), path = link.path?.segments;
    if (!from || !to) { fail('G7', 'missing-port', [link.id], 'Link attachment references a missing port'); continue; }
    if (path?.length) {
      // Where each family really meets its port. A routed path ends on the anchor, under its own
      // pill. An overlay path ends on the port's outward **face**: the overlay layer is masked out
      // of the pill, so an anchor-to-face run is never drawn, and the maintainer asked for the line
      // and its endpoint mark to start on the pill's side (stress ticket 30). The gate still names
      // exactly one point per end — `overlayEndpoint`, the producer's own — and an end that states
      // no side has no face to read and keeps its anchor.
      // A straight link inside one frame (ticket 34) ends on the face too: one segment, no stem.
      const overlay = effectiveLayer(link) !== 'routed' || isRoutedChord(model, link);
      const at = (item: typeof from, ref: { node: string }): Point =>
        (overlay ? overlayEndpoint(model.nodes[ref.node], item) : undefined) ?? item.anchor!;
      if (!samePoint(path[0]!.from, at(from, ends.from)) || !samePoint(path.at(-1)!.to, at(to, ends.to))) fail('G7', 'endpoint-anchor', [link.id], 'Link endpoints must equal the point their ports state');
      for (let i = 1; i < path.length; i++) if (!samePoint(path[i - 1]!.to, path[i]!.from)) fail('G7', 'disconnected-path', [link.id], 'Consecutive routed segments must connect');
    }
    if (!routedLinks.has(link)) continue;
    // A straight link inside one frame is one segment between two faces: it has no stem and may be a diagonal.
    const framed = isRoutedChord(model, link);
    if (!framed && (!outward(from, path![0]!, true) || !outward(to, path!.at(-1)!, false) || length(path![0]!) < 15 - EPS || length(path!.at(-1)!) < 15 - EPS)) fail('G5', 'port-stem', [link.id], 'Port stems must exit perpendicular and extend at least 15 px');
    // A declared diagonal is legal only on a member of a bundle that owns the segment (ADR-0017);
    // anywhere else `straight: true` is an unowned claim and the gate treats it as a bent path.
    const straightOk = (s: PathSegment): boolean => s.straight === true && (framed || link.bundle !== undefined
      && s.owner.kind === 'bundle' && s.owner.id === link.bundle
      && model.bundles.some(item => item.id === link.bundle && item.owner.kind === 'bundle'
        && item.owner.id === item.id && item.members.includes(link.id)));
    // The claim is judged before the geometry: an axis-aligned segment that carries the marker
    // without an owning bundle would otherwise pass unread, yet G4 and the renderer both act on it.
    if (path!.some(s => (s.straight === true ? !straightOk(s) : !horizontal(s) && !vertical(s)) || length(s) <= EPS)) fail('G5', 'orthogonal-path', [link.id], 'Routed segments must have positive length and follow an axis, or be a declared straight member of an owning bundle');
    // ADR-0017 shapes the member as stem, one diagonal, stem: a second diagonal is a staircase of
    // its own and reserves geometry no stage measured.
    if (path!.filter(s => s.straight === true).length > 1) fail('G5', 'orthogonal-path', [link.id], 'A member may declare only one straight segment');
  }
  portOrder(model, nodes, routedLinks, fail);

  parallelClearance(model, routed, fail);
  return result;
}


/** Grid cell for the diagonal broad phase; a few node widths, so a diagonal spans few cells. */
const DIAGONAL_CELL = 256;

/** A run this many cells long is compared directly instead: the walk below must stay finite. */
const MAX_CELL_STEPS = 4096;

/**
 * Axis-aligned runs: line buckets, each swept against itself and against the buckets within EPS of
 * it, O(S log S + K). Declared straight members (ADR-0017): a uniform grid over the cells each run
 * crosses, with the neighbouring cells, so an EPS-collinear pair always shares a cell; the work
 * follows their total length.
 */
function collinearSweep(segments: Segment[], visit: (a: Segment, b: Segment, overlap: PathSegment) => void): void {
  const declared: Segment[] = [], lines: [Segment[], Segment[]] = [[], []];
  for (const s of segments) {
    // A declared straight bundle member (ADR-0017) has no axis to key by, whatever its angle, so
    // every declared member is indexed below on a uniform grid by the cells it crosses.
    if (s.segment.straight === true) { declared.push(s); continue; }
    if (horizontal(s.segment)) lines[0].push(s);
    else if (vertical(s.segment)) lines[1].push(s);
  }
  for (const line of lines) {
    const h = line === lines[0];
    const coordinate = (s: Segment): [number, number] => {
      const a = h ? s.segment.from.x : s.segment.from.y, b = h ? s.segment.to.x : s.segment.to.y;
      return [Math.min(a, b), Math.max(a, b)];
    };
    // `overlapSegment` calls two axis-aligned runs collinear when their offsets are within EPS, which
    // two exact buckets can straddle, and collinearity within a tolerance is not transitive. So the
    // lines are re-keyed by the EPS the predicate uses and each run is compared with the two
    // neighbouring keys as well: a pair the predicate accepts differs by at most one key, and a key
    // holds only runs the predicate may accept, so neither a chain of near-equal offsets nor a dense
    // cluster of them makes the sweep scan an unrelated pair. (Beyond about 4e8 px the float spacing
    // itself exceeds EPS, so two distinct offsets are never collinear and the key's own rounding
    // there cannot lose a pair.)
    // Past about 9e8 px the key is no longer a safe integer, so `at ± 1` would not move; there the
    // float spacing already exceeds EPS, two distinct offsets can never be collinear, and the exact
    // key alone is complete.
    const key = (s: Segment): number => Math.floor((h ? s.segment.from.y : s.segment.from.x) / EPS);
    const active = new Map<number, Segment[]>();
    const runs = [...line].sort((a, b) => coordinate(a)[0] - coordinate(b)[0]);
    for (const next of runs) {
      const at = key(next), start = coordinate(next)[0];
      for (const k of Number.isSafeInteger(at) ? [at - 1, at, at + 1] : [at]) {
        const list = active.get(k);
        if (!list) continue;
        // Runs are taken in span order, so a span that has closed for this one has closed for every
        // later one: dropping it here keeps the scan proportional to the pairs it really compares.
        let write = 0;
        for (const prior of list) {
          if (coordinate(prior)[1] <= start + 1 + EPS) continue;
          list[write++] = prior;
          const overlap = overlapSegment(prior.segment, next.segment);
          if (overlap) visit(prior, next, overlap);
        }
        list.length = write;
      }
      const own = active.get(at) ?? []; own.push(next); active.set(at, own);
    }
  }
  if (!declared.length) return;
  const cells = new Map<string, { declared: Segment[]; ordinary: Segment[] }>();
  const unindexed: Segment[] = [];
  // Walk the cells a run actually crosses, in half-cell steps so none is skipped, and take each
  // one's eight neighbours as well: a pair the EPS-tolerant predicate accepts can sit either side of
  // a cell boundary, and the neighbourhood covers that.
  const register = (item: Segment, into: 'declared' | 'ordinary'): void => {
    const { from, to } = item.segment;
    const run = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(run / (DIAGONAL_CELL / 2)));
    // A run longer than the whole grid budget — only a hand-written layout reaches this — is
    // compared with every declared member instead, which is complete and cannot outrun the walk.
    if (!Number.isFinite(steps) || steps > MAX_CELL_STEPS) { unindexed.push(item); return; }
    const visited = new Set<string>();
    for (let step = 0; step <= steps; step++) {
      const at = step / steps, x = from.x + (to.x - from.x) * at, y = from.y + (to.y - from.y) * at;
      const cx = Math.floor(x / DIAGONAL_CELL), cy = Math.floor(y / DIAGONAL_CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const cell = `${cx + dx}:${cy + dy}`;
        if (visited.has(cell)) continue;
        visited.add(cell);
        // An ordinary run joins only a cell a declared member already occupies: it is in the grid
        // solely to meet one, and its own line bucket judges it against every other ordinary run.
        const found = cells.get(cell);
        if (found) found[into].push(item);
        else if (into === 'declared') cells.set(cell, { declared: [item], ordinary: [] });
      }
    }
  };
  for (const item of declared) register(item, 'declared');
  const ordinary = segments.filter(s => s.segment.straight !== true && (horizontal(s.segment) || vertical(s.segment)));
  for (const s of ordinary) register(s, 'ordinary');
  const compared = new Set<string>();
  // The predicate decides first and only an overlapping pair is remembered: a cell that holds many
  // declared members on distinct lines then costs arithmetic alone, not a string for every pair.
  const consider = (one: Segment, other: Segment): void => {
    const overlap = overlapSegment(one.segment, other.segment);
    if (!overlap) return;
    const a = `${one.link.id}#${one.index}`, b = `${other.link.id}#${other.index}`;
    const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (compared.has(pair)) return;
    compared.add(pair);
    visit(one, other, overlap);
  };
  for (const cell of cells.values()) {
    for (let i = 0; i < cell.declared.length; i++) {
      const one = cell.declared[i]!;
      for (let j = i + 1; j < cell.declared.length; j++) consider(one, cell.declared[j]!);
      for (const other of cell.ordinary) consider(one, other);
    }
  }
  for (const item of unindexed) {
    for (const other of declared) if (other !== item) consider(item, other);
    // An unindexed declared member is in no cell, so the ordinary runs cannot meet it there either.
    if (item.segment.straight === true) for (const other of ordinary) consider(item, other);
  }
}
