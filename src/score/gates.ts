import type { LayoutModel, LayoutNode, PathSegment, Point } from '../model/index.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import { EPS, bottom, contains, horizontal, intersection, length, near, overlapSegment, rectDistance, rectOverlap, samePoint, segmentDistance, segmentRect, segmentRectDistance, vertical } from './geometry.js';
import { anchorOnBoundary, barContact, bundlePair, endpoints, groupConsumers, incident, junctionFan, mergedRun, outward, port, refEqual, refKey, sharedStem } from './model.js';
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
  // `routed` holds one entry per segment, so "does this link have a routed segment?" was a scan of
  // every segment; the set answers it once.
  const routedLinks = new Set(routed.map(s => s.link));
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
    for (let j = i + 1; j < labels.length; j++) {
      const other = labels[j]!;
      if (rectOverlap(label.bounds!, other.bounds!)) hit(other.id);
    }
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
    if (!routedLinks.has(link)) continue;
    if (!outward(from, path![0]!, true) || !outward(to, path!.at(-1)!, false) || length(path![0]!) < 15 - EPS || length(path!.at(-1)!) < 15 - EPS) fail('G5', 'port-stem', [link.id], 'Port stems must exit perpendicular and extend at least 15 px');
    // A declared diagonal is legal only on a member of a bundle that owns the segment (ADR-0017);
    // anywhere else `straight: true` is an unowned claim and the gate treats it as a bent path.
    const straightOk = (s: PathSegment): boolean => s.straight === true && link.bundle !== undefined
      && s.owner.kind === 'bundle' && s.owner.id === link.bundle
      && model.bundles.some(item => item.id === link.bundle && item.owner.kind === 'bundle'
        && item.owner.id === item.id && item.members.includes(link.id));
    // The claim is judged before the geometry: an axis-aligned segment that carries the marker
    // without an owning bundle would otherwise pass unread, yet G4 and the renderer both act on it.
    if (path!.some(s => (s.straight === true ? !straightOk(s) : !horizontal(s) && !vertical(s)) || length(s) <= EPS)) fail('G5', 'orthogonal-path', [link.id], 'Routed segments must have positive length and follow an axis, or be a declared straight member of an owning bundle');
    // ADR-0017 shapes the member as stem, one diagonal, stem: a second diagonal is a staircase of
    // its own and reserves geometry no stage measured.
    if (path!.filter(s => s.straight === true).length > 1) fail('G5', 'orthogonal-path', [link.id], 'A member may declare only one straight segment');
  }
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
