import type { LayoutModel, LayoutNode, PathSegment } from '../model/index.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import { EPS, bottom, contains, horizontal, length, near, overlapSegment, rectDistance, rectOverlap, samePoint, segmentDistance, segmentRect, segmentRectDistance, vertical } from './geometry.js';
import { anchorOnBoundary, barContact, bundlePair, endpoints, groupConsumers, incident, junctionFan, mergedRun, outward, port, refEqual, sharedStem } from './model.js';
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

export function gates(model: LayoutModel, routed: Segment[], counters: ScoreCounters): Record<GateId, GateResult> {
  const nodes = Object.values(model.nodes), groups = Object.values(model.groups);
  const gate = (warning = false): GateResult => ({ passed: true, severity: warning ? 'warning' : 'error', violations: [] });
  const result: Record<GateId, GateResult> = { G1: gate(), G2: gate(), G3: gate(nodes.length > 300), G4: gate(), G5: gate(), G6: gate(), G7: gate(), G8: gate() };
  const fail = (id: GateId, code: string, elements: string[], message: string): void => { result[id].passed = false; result[id].violations.push({ code, elements, message }); };
  const nodeStroke = (n: LayoutNode): number => n.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    const group = a.owner.kind === 'group' ? model.groups[a.owner.id] : undefined;
    if (!group || !group.nodes.includes(a.id) || !contains(group.bounds!, a.bounds!)) fail('G1', 'node-containment', [a.id], 'Node must lie inside its owning group');
    for (const b of nodes.slice(i + 1)) {
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
    for (const b of groups.slice(i + 1)) if (rectOverlap(group.bounds!, b.bounds!)) fail('G1', 'group-overlap', [group.id, b.id], 'Group rectangles overlap');
  }
  const bands = [...model.tierBands].sort((a, b) => a.tier - b.tier);
  for (let i = 1; i < bands.length; i++) {
    const a = bands[i - 1]!, b = bands[i]!;
    if (a.tier === b.tier || bottom(a.bounds!) > b.bounds!.y + EPS) fail('G8', 'tier-order', [String(a.tier), String(b.tier)], 'Tier bands must be ordered and non-overlapping');
  }
  const crossedBars = new Set<string>();
  for (const s of routed) {
    for (const node of nodes) {
      if (node.layer === 'overlay') continue;
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
  const groupBoxes = Object.entries(model.groups).filter(([, group]) => group.bounds && group.nodes.length)
    .map(([id, group]) => ({ id, bounds: group.bounds!, consumers: new Set(groupConsumers(model, id)) }));
  for (const s of routed) {
    for (const group of groupBoxes) {
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
  const labels = model.labels.filter(l => !l.omitted && l.layer !== 'overlay');
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    const associatedPill = label.role === 'pill' && label.port ? port(model, label.port)?.pill : undefined;
    const containedOwnPill = associatedPill !== undefined && label.port !== undefined
      && label.owner.kind === 'node' && label.owner.id === label.port.node
      && associatedPill.owner.kind === 'node' && associatedPill.owner.id === label.port.node
      && contains(associatedPill.bounds, label.bounds!);
    const hit = (other: string): void => { counters.labelHits++; fail('G3', 'label-collision', [label.id, other], 'Label intersects unrelated geometry'); };
    for (const other of labels.slice(i + 1)) if (rectOverlap(label.bounds!, other.bounds!)) hit(other.id);
    for (const node of nodes) {
      const owns = label.owner.kind === 'node' && label.owner.id === node.id;
      const ownedExtent = owns && (label.role === 'pill' ? containedOwnPill : contains(node.bounds!, label.bounds!));
      if (node.layer !== 'overlay' && !ownedExtent && (rectDistance(label.bounds!, node.bounds!) < nodeStroke(node) / 2 - EPS || rectOverlap(label.bounds!, node.bounds!))) hit(node.id);
      for (const p of node.ports) {
        if (!p.pill || p.pill.layer === 'overlay') continue;
        const ownPill = owns && containedOwnPill && label.port !== undefined && refEqual(label.port, p.ref);
        if (!ownPill && (rectOverlap(label.bounds!, p.pill.bounds) || rectDistance(label.bounds!, p.pill.bounds) < DEFAULT_STROKE_WIDTHS.pill / 2 - EPS)) hit(`pill:${node.id}:${p.ref.ordinal}`);
      }
    }
    for (const s of routed) {
      // A pill's own incident stem runs behind the pill text by construction.
      if (containedOwnPill && label.port && incident(model, s, label.port.node)
        && [endpoints(s.link).from, endpoints(s.link).to].some(ref => refEqual(ref, label.port!))) continue;
      // Text drawn across a routed segment is a hit whatever it claims to support.
      if (segmentRect(s.segment, label.bounds!)) { hit(s.link.id); continue; }
      // Only the clearance zone of the one segment a link label was measured against is exempt.
      // Another segment of the same link, a stale or absent reference, and every multiplicity
      // label exempt nothing.
      const support = label.support;
      if (support?.kind === 'link-segment' && label.owner.kind === 'link' && label.owner.id === support.link
        && support.link === s.link.id && support.segment === s.index) continue;
      // A group title owns a link-free margin beyond its stroke-aware edge.
      const margin = label.role === 'group' ? GROUP_LABEL_LINK_CLEARANCE : 0;
      if (segmentRectDistance(s.segment, label.bounds!) < s.stroke / 2 + margin - EPS) hit(s.link.id);
    }
  }
  collinearSweep(routed, (a, b, overlap) => {
    if (length(overlap) <= 1 + EPS) return;
    if (mergedRun(model, a, b, overlap)) counters.bundledLength += length(overlap);
    else if (!sharedStem(model, a, b, overlap)) { counters.overlaps++; fail('G4', 'collinear-overlap', [a.link.id, b.link.id], 'Routed segments share more than 1 px'); }
  });
  const lanesUsed = new Set<string>();
  for (const lane of model.lanes.filter(lane => lane.layer !== 'overlay')) for (const s of routed) {
    if (!segmentRect(s.segment, lane.bounds)) continue;
    const laneOwner = lane.owner;
    const owns = laneOwner.kind === 'link' && laneOwner.id === s.link.id || laneOwner.kind === 'bundle' && laneOwner.id === s.link.bundle && model.bundles.some(b => b.id === laneOwner.id && b.owner.kind === 'bundle' && b.owner.id === b.id && b.members.includes(s.link.id));
    if (owns && s.segment.lane === lane.id && vertical(s.segment) && near(s.segment.from.x, lane.x)) lanesUsed.add(lane.id);
    else fail('G4', 'lane-owner', [s.link.id, lane.id], 'Only its owner may occupy a reserved lane');
  }
  counters.lanesUsed = lanesUsed.size;
  for (const link of model.links) {
    const ends = endpoints(link), from = port(model, ends.from), to = port(model, ends.to), path = link.path?.segments;
    if (!from || !to) { fail('G7', 'missing-port', [link.id], 'Link attachment references a missing port'); continue; }
    if (path?.length) {
      if (!samePoint(path[0]!.from, from.anchor!) || !samePoint(path.at(-1)!.to, to.anchor!)) fail('G7', 'endpoint-anchor', [link.id], 'Link endpoints must equal port anchors');
      for (let i = 1; i < path.length; i++) if (!samePoint(path[i - 1]!.to, path[i]!.from)) fail('G7', 'disconnected-path', [link.id], 'Consecutive routed segments must connect');
    }
    if (!routed.some(s => s.link === link)) continue;
    if (!outward(from, path![0]!, true) || !outward(to, path!.at(-1)!, false) || length(path![0]!) < 15 - EPS || length(path!.at(-1)!) < 15 - EPS) fail('G5', 'port-stem', [link.id], 'Port stems must exit perpendicular and extend at least 15 px');
    if (path!.some(s => (!horizontal(s) && !vertical(s)) || length(s) <= EPS)) fail('G5', 'orthogonal-path', [link.id], 'Routed segments must have positive length and follow an axis');
  }
  for (const node of nodes) for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const positions = node.ports.filter(p => p.side === side && p.authorOrder === undefined).flatMap(p => {
      const peers = model.links.filter(l => routed.some(s => s.link === l)).flatMap(l => {
        const ends = endpoints(l), other = refEqual(ends.from, p.ref) ? ends.to : refEqual(ends.to, p.ref) ? ends.from : undefined;
        const target = other && port(model, other);
        return target ? [side === 'top' || side === 'bottom' ? target.anchor!.x : target.anchor!.y] : [];
      });
      return peers.length ? [{ own: side === 'top' || side === 'bottom' ? p.anchor!.x : p.anchor!.y,
        min: Math.min(...peers), max: Math.max(...peers) }] : [];
    });
    for (let i = 0; i < positions.length; i++) for (const b of positions.slice(i + 1)) {
      const a = positions[i]!;
      if (a.own < b.own - EPS && a.min > b.max + EPS || b.own < a.own - EPS && b.min > a.max + EPS)
        fail('G5', 'port-order', [node.id], 'Port order must match strictly separated far-end ranges unless authored');
    }
    const authored = node.ports.filter(p => p.side === side && p.authorOrder !== undefined)
      .sort((a, b) => (side === 'top' || side === 'bottom' ? a.anchor!.x - b.anchor!.x : a.anchor!.y - b.anchor!.y));
    if (authored.some((p, i) => i > 0 && p.authorOrder! < authored[i - 1]!.authorOrder!))
      fail('G5', 'author-port-order', [node.id], 'Physical port order reverses unequal authored keys');
  }

  for (let i = 0; i < routed.length; i++) for (const b of routed.slice(i + 1)) {
    const a = routed[i]!;
    if (a.link.id === b.link.id && Math.abs(a.index - b.index) <= 1) continue;
    if (!(horizontal(a.segment) && horizontal(b.segment) || vertical(a.segment) && vertical(b.segment))) continue;
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
  return result;
}

/** O(S log S + K): line buckets and an interval sweep visit only actual overlap candidates. */
function collinearSweep(segments: Segment[], visit: (a: Segment, b: Segment, overlap: PathSegment) => void): void {
  const buckets = new Map<string, Segment[]>();
  for (const s of segments) {
    const h = horizontal(s.segment);
    if (!h && !vertical(s.segment)) continue;
    // Final routing coordinates define a line exactly; EPS is for geometric predicates only.
    const key = `${h ? 'h' : 'v'}:${h ? s.segment.from.y : s.segment.from.x}`;
    const list = buckets.get(key) ?? []; list.push(s); buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    const h = horizontal(list[0]!.segment), coordinate = (s: Segment): [number, number] => {
      const a = h ? s.segment.from.x : s.segment.from.y, b = h ? s.segment.to.x : s.segment.to.y;
      return [Math.min(a, b), Math.max(a, b)];
    };
    list.sort((a, b) => coordinate(a)[0] - coordinate(b)[0]);
    let active: Segment[] = [];
    for (const next of list) {
      active = active.filter(s => coordinate(s)[1] > coordinate(next)[0] + 1 + EPS);
      for (const prior of active) { const overlap = overlapSegment(prior.segment, next.segment); if (overlap) visit(prior, next, overlap); }
      active.push(next);
    }
  }
}
