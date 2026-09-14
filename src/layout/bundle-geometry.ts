import { GROUP_EDGE_LINK_CLEARANCE, routedStrokeWidth } from '../theme/geometry.js';
import type { Bundle, LayoutLink, LayoutModel, LayoutPort, PathSegment, Point, Side } from '../model/index.js';
import { repackOverlaps } from './rows.js';
import { applyBundleOrder } from './bundle-order.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { findPort } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { fitRegionGroup, bottom, right } from './regions.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { rowGap } from './sides-two.js';

export const MEMBER_GAP = 16;
export const MIN_STEM = 15;
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export interface Member { link: LayoutLink; a: LayoutPort; b: LayoutPort; reversed: boolean }
export function members(model: LayoutModel, bundle: Bundle): Member[] {
  return bundle.members.map(id => {
    const link = model.links.find(link => link.id === id)!;
    const reversed = link.attachments!.from.node !== bundle.nodes[0];
    return { link, a: findPort(model, link.attachments![reversed ? 'to' : 'from'])!,
      b: findPort(model, link.attachments![reversed ? 'from' : 'to'])!, reversed };
  });
}
export function axis(side: Side): 'x' | 'y' { return side === 'top' || side === 'bottom' ? 'x' : 'y'; }

/** A group box as a closed interval along one depth axis; `toDepth` maps a corner to that axis. */
export type DepthPair = [number, number];
export function groupDepthPairs(model: LayoutModel, groupIds: Iterable<string>, toDepth: (p: Point) => number): DepthPair[] {
  return [...new Set(groupIds)].map(id => {
    const box = model.groups[id]!.bounds!;
    const values = [toDepth({ x: box.x, y: box.y }), toDepth({ x: box.x + box.width, y: box.y + box.height })];
    return [Math.min(...values), Math.max(...values)] as DepthPair;
  });
}
/** The stroke-aware edge margin: centreline distance a link of this stroke keeps from a group edge. */
export function edgeMargin(strokeWidth: number): number { return GROUP_EDGE_LINK_CLEARANCE + strokeWidth / 2; }
/**
 * A coordinate on or outside a group box, closer to its edge than the margin, moves `direction`-ward
 * to margin distance from that edge (ADR-0013). Strictly inside a box it is the group's own routing
 * space and stays. Bounded, so a chain of boxes cannot loop.
 */
export function clearOfGroupEdges(value: number, pairs: DepthPair[], direction: 1 | -1, margin: number = GROUP_EDGE_LINK_CLEARANCE): number {
  let result = value;
  for (let guard = 0; guard < 8; guard++) {
    const blocking = pairs.find(([lo, hi]) => !(result > lo + 1e-9 && result < hi - 1e-9)
      && (Math.abs(result - lo) < margin - 1e-9 || Math.abs(result - hi) < margin - 1e-9));
    if (!blocking) return result;
    const edge = Math.abs(result - blocking[0]) <= Math.abs(result - blocking[1]) ? blocking[0] : blocking[1];
    result = edge + direction * margin;
  }
  return result;
}
export function coordinate(port: LayoutPort): number { return port.anchor![axis(port.side!)]; }
export function normal(side: Side): Point {
  return side === 'top' ? { x: 0, y: -1 } : side === 'bottom' ? { x: 0, y: 1 }
    : side === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 };
}
export function outward(port: LayoutPort, length = MIN_STEM): Point {
  const n = normal(port.side!); return { x: port.anchor!.x + n.x * length, y: port.anchor!.y + n.y * length };
}
export function pitch(model: LayoutModel, bundle: Bundle): number {
  return fanPitch(members(model, bundle).map(m => m.link));
}
export function inversionPairs(list: Member[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < list.length; i++) for (const b of list.slice(i + 1)) {
    const a = list[i]!;
    if ((coordinate(a.a) - coordinate(b.a)) * (coordinate(a.b) - coordinate(b.b)) < -1e-6) pairs.push([a.link.id, b.link.id]);
  }
  return pairs;
}
export function facing(list: Member[]): boolean {
  const a = list[0]!.a.side!, b = list[0]!.b.side!, n = normal(a), m = normal(b);
  return n.x === -m.x && n.y === -m.y && list.every(item => item.a.side === a && item.b.side === b);
}
function sorted(ports: LayoutPort[], preferred: (p: LayoutPort) => number, unrelated = new Set<LayoutPort>()): LayoutPort[] {
  const pending = new Set(ports), result: LayoutPort[] = [];
  while (pending.size) {
    const ready = [...pending].filter(p => (p.authorOrder === undefined || ![...pending].some(q => q.authorOrder !== undefined && q.authorOrder < p.authorOrder!))
      && (!unrelated.has(p) || ![...pending].some(q => unrelated.has(q) && q.engineOrder! < p.engineOrder!)));
    if (!ready.length) throw new Error('Bundle side order contradicts authored or unrelated-port precedence');
    ready.sort((a, b) => preferred(a) - preferred(b) || a.engineOrder! - b.engineOrder! || a.ref.ordinal - b.ref.ordinal);
    const next = ready[0]!; pending.delete(next); result.push(next);
  }
  return result;
}
/** Joint common order for distinct endpoint pairs, constrained by both authored partial orders. */
function orderDistinct(model: LayoutModel, bundle: Bundle): void {
  const list = members(model, bundle);
  if (new Set(list.map(m => portId(m.a.ref))).size !== list.length || new Set(list.map(m => portId(m.b.ref))).size !== list.length) return;
  const pending = new Set(list), order: Member[] = [];
  while (pending.size) {
    const ready = [...pending].filter(m => ![...pending].some(n => (['a', 'b'] as const).some(end =>
      n[end].side === m[end].side && n[end].authorOrder !== undefined && m[end].authorOrder !== undefined && n[end].authorOrder! < m[end].authorOrder!)));
    if (!ready.length) return; // Unequal authored keys force real crossovers.
    ready.sort((a, b) => a.a.engineOrder! - b.a.engineOrder! || a.link.sourceIndex - b.link.sourceIndex);
    pending.delete(ready[0]!); order.push(ready[0]!);
  }
  for (const end of ['a', 'b'] as const) {
    const ports = order.map(m => m[end]);
    if (new Set(ports.map(p => p.side)).size !== 1) continue;
    const node = model.nodes[ports[0]!.ref.node]!, side = ports[0]!.side;
    const existing = node.ports.filter(p => p.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
    const slots = existing.filter(p => ports.includes(p)).map(p => p.engineOrder!).sort((a, b) => a - b);
    const proposed = [...existing]; ports.forEach((p, i) => { proposed[slots[i]!] = p; });
    const authored = proposed.filter(p => p.authorOrder !== undefined);
    if (authored.some((p, i) => i && p.authorOrder! < authored[i - 1]!.authorOrder!)) continue;
    const coords = existing.map(coordinate);
    proposed.forEach((p, i) => { p.engineOrder = i; p.anchor![axis(p.side!)] = coords[i]!; });
  }
}

/** The stable id of the junction at `depth` on a shared port; 7d names it before 7e builds it (ADR-0016). */
export const junctionId = (port: LayoutPort, depth: number): string => `junction:${portId(port.ref)}:shared:${depth}`;

/**
 * Fan pitch: the bundle member gap plus the widest member stroke — the same formula `pitch()` uses
 * for a bundle, and never below the default-stroke value (17.5 px), so reserved capacity and the
 * emitted rows cannot drift apart.
 */
export function fanPitch(links: readonly LayoutLink[]): number {
  return MEMBER_GAP + Math.max(DEFAULT_STROKE_WIDTHS.path, ...links.map(linkStrokeWidth));
}

/**
 * Row depths of a fan tree at `port` for `links` members: 15 px out, then one pitch apart, each row
 * moved off a group edge it would run along (ADR-0013). `rows[i]` for `i < links.length` is the
 * depth of junction `i`; `rows[links.length]` is where the straight continuation ends.
 */
export function fanRows(model: LayoutModel, port: LayoutPort, links: readonly LayoutLink[]): number[] {
  return edgeAwareRows(model, port, links, links.length + 1, fanPitch(links));
}

/**
 * Row depths of a bundle's own fan at `port` (`bundleFans`): `count` rows a pitch apart from 15 px
 * out, each moved off a group edge it would run along (ADR-0013), and the `distance` one further
 * pitch out where the members join the channel. The reservation in 7e and the producer read this
 * one function, so the room reserved is the room the fan takes.
 */
export function bundleFanRows(model: LayoutModel, port: LayoutPort, fanLinks: readonly LayoutLink[], count: number, q: number): { rows: number[]; distance: number } {
  const rows = edgeAwareRows(model, port, fanLinks, count, q);
  return { rows, distance: edgeAwareRows(model, port, fanLinks, count + 1, q)[count]! };
}

/**
 * `count` row depths at `port`, a pitch apart from `MIN_STEM` out, each moved off a group edge it
 * would run along (ADR-0013) together with every row after it. The one recurrence both fan kinds
 * read, so a change to the clearance cannot move one and leave the other behind.
 */
function edgeAwareRows(model: LayoutModel, port: LayoutPort, fanLinks: readonly LayoutLink[], count: number, q: number): number[] {
  const n = normal(port.side!), tangent = axis(port.side!);
  const toDepth = (p: Point): number => tangent === 'y' ? n.x * (p.x - port.anchor!.x) : n.y * (p.y - port.anchor!.y);
  const pairs = groupDepthPairs(model, [model.document.nodes[port.ref.node]!.group], toDepth);
  const margin = edgeMargin(Math.max(...fanLinks.map(linkStrokeWidth)));
  const rows: number[] = [];
  for (let i = 0; i < count; i++) rows.push(clearOfGroupEdges(Math.max(MIN_STEM + i * q, (rows[i - 1] ?? -Infinity) + q), pairs, 1, margin));
  return rows;
}

/**
 * How far the fan at one end of a bundle pushes the anchors its paths are measured from, the figure
 * stage 7e reserves before any path exists (ticket 39). `trees` is the stage's one index of junction
 * cohorts by port.
 */
export function fanDepth(model: LayoutModel, trees: Map<string, { port: LayoutPort; links: LayoutLink[] }>,
  bundle: Bundle, list: Member[], end: 'a' | 'b', q: number): number {
  return Math.max(0, ...list.map(m => {
    const at = portId(m[end].ref), cohort = trees.get(at);
    // Wherever two members meet, `bundleFans` draws the bundle's own fan and counts its rows over
    // the whole bundle, even when only some members share that port.
    const meeting = list.filter(other => portId(other[end].ref) === at);
    const own = meeting.length > 1 ? bundleFanRows(model, m[end], meeting.map(other => other.link), list.length, q).distance : 0;
    const outside = cohort?.links.some(link => link.bundle !== bundle.id) === true;
    if (!outside) return own;
    // A link from outside makes the port a junction tree, and `bundleFans` then consumes the shared
    // runs 7e reserved for it instead of drawing its own fan — but only when every member meeting
    // there is in the cohort. A member the cohort left out still brings the bundle's own fan.
    // `fanEnd`, not the last row: a tree that adopts a fixed straight-through leaf can stop earlier.
    const tree = fanEnd(model, cohort!.port, cohort!.links);
    const adopted = new Set(cohort!.links.map(link => link.id));
    return meeting.every(other => adopted.has(other.link.id)) ? tree : Math.max(own, tree);
  }));
}

/** The point `depth` px out from the port along its normal, at the port's own coordinate. */
export function alongNormal(port: LayoutPort, depth: number): Point {
  const n = normal(port.side!);
  return { x: port.anchor!.x + n.x * depth, y: port.anchor!.y + n.y * depth };
}

/**
 * How far a fixed path runs straight out of `port` along its normal before it turns or meets a
 * reserved lane segment: the length of its leading plain collinear run at that end. Zero when the
 * path does not start or end at the port's anchor.
 */
export function leadingRun(port: LayoutPort, segments: readonly PathSegment[]): number {
  const anchor = port.anchor!, n = normal(port.side!), tangent = axis(port.side!);
  const first = segments[0], last = segments.at(-1);
  const forward = first && Math.abs(first.from.x - anchor.x) < 1e-6 && Math.abs(first.from.y - anchor.y) < 1e-6;
  const backward = !forward && last && Math.abs(last.to.x - anchor.x) < 1e-6 && Math.abs(last.to.y - anchor.y) < 1e-6;
  if (!forward && !backward) return 0;
  const ordered = forward ? segments : [...segments].reverse().map(s => ({ ...s, from: s.to, to: s.from }));
  let depth = 0;
  for (const segment of ordered) {
    if (segment.lane !== undefined) break;
    const along = tangent === 'x' ? n.y * (segment.to.y - segment.from.y) : n.x * (segment.to.x - segment.from.x);
    const across = tangent === 'x' ? Math.abs(segment.to.x - segment.from.x) : Math.abs(segment.to.y - segment.from.y);
    if (across > 1e-6 || along <= 1e-6) break;
    depth += along;
  }
  return depth;
}

/** A path already split under this port's tree: its segment at the port is owned by the root junction. */
function carriesRoot(port: LayoutPort, segments: readonly PathSegment[]): boolean {
  const anchor = port.anchor!, first = segments[0], last = segments.at(-1);
  const at = first && Math.abs(first.from.x - anchor.x) < 1e-6 && Math.abs(first.from.y - anchor.y) < 1e-6 ? first
    : last && Math.abs(last.to.x - anchor.x) < 1e-6 && Math.abs(last.to.y - anchor.y) < 1e-6 ? last : undefined;
  return at?.owner.kind === 'shared-stem' && at.owner.id === junctionId(port, 0);
}

/** Traversals stage 7d is still building, by link id, with the port each one may be split at. */
export type PendingFixed = ReadonlyMap<string, { port: string; segments: readonly PathSegment[] }>;

/**
 * The ports stage 7e gives a junction tree, with the links that join it: two or more routed links
 * on one port, none a self-link (ticket 20). A cohort with a bundle keeps every link. In a
 * bundle-less cohort at most one rule-fixed member joins, as the tree's straight-through leaf
 * (ADR-0016): in 7d, a bar drop whose traversal is pending at this port and whose plain straight
 * run reaches the last junction row; in 7e and on restore, a path whose segment at the port already
 * carries the root junction id — which 7d wrote exactly when that fit held. Row and flank paths, and
 * a drop at its bar end, are never split and stay outside. Dropping a member shrinks the rows, so
 * the fit is settled by iteration. Shared with the capacity loop below and with 7d.
 */
export function treeCohorts(model: LayoutModel, pending?: PendingFixed): { port: LayoutPort; links: LayoutLink[] }[] {
  return fanCohorts(model, pending).cohorts;
}

/**
 * The cohorts, and the fixed members excluded from one. An excluded member keeps its own stem out of
 * the port, which coincides with the tree's root: G4 reports that overlap, and stage 7e warns
 * `FAN_MEMBER_UNRESERVED` so the reason is in the model. Adopting such a member — by letting 7d turn
 * it at a junction row — is ticket 37.
 */
export function fanCohorts(model: LayoutModel, pending?: PendingFixed): { cohorts: { port: LayoutPort; links: LayoutLink[] }[]; excluded: { port: LayoutPort; link: LayoutLink }[] } {
  const incidence = new Map<string, { port: LayoutPort; links: LayoutLink[] }>();
  for (const link of model.links) if (link.layer === 'routed' && link.attachments && link.technique !== 'stub') for (const ref of [link.attachments.from, link.attachments.to]) {
    const port = findPort(model, ref)!, key = portId(ref), entry = incidence.get(key) ?? { port, links: [] };
    entry.links.push(link); incidence.set(key, entry);
  }
  const result: { port: LayoutPort; links: LayoutLink[] }[] = [], excluded: { port: LayoutPort; link: LayoutLink }[] = [];
  for (const { port, links } of incidence.values()) {
    if (new Set(links.map(link => link.id)).size !== links.length) continue;
    let active = links;
    {
      const at = portId(port.ref);
      /**
       * A fixed path's plain straight run out of this port, or `undefined` when the link is not
       * fixed here. `eligible` is false for a fixed path this port may not adopt — a drop pending at
       * its other end, a row or flank path (ticket 37), a path not split under the root id — so such
       * a link never occupies the one straight-leaf slot and is simply excluded.
       */
      const fixedRun = (link: LayoutLink): { run: number; eligible: boolean } | undefined => {
        const waiting = pending?.get(link.id);
        if (waiting) return waiting.port === at ? { run: leadingRun(port, waiting.segments), eligible: true } : { run: -1, eligible: false };
        if (link.path?.fixed !== true) return undefined;
        return carriesRoot(port, link.path.segments) ? { run: leadingRun(port, link.path.segments), eligible: true } : { run: -1, eligible: false };
      };
      // At most one fixed member is the straight-through leaf. Every other fixed path — a drop at
      // its bar end, a row or flank path (ticket 37) — is outside the tree whether or not the cohort
      // has bundle members, since 7e would otherwise give it shared runs its own path does not
      // contain. The candidates are tried in source order and the first whose run fits the rows the
      // resulting cohort would have becomes the leaf, so a short drop never blocks a longer one.
      const candidates = links.filter(link => fixedRun(link)?.eligible === true).sort((a, b) => a.sourceIndex - b.sourceIndex);
      const fits = (leaf: LayoutLink | undefined): boolean => {
        if (!leaf) return true;
        const cohort = links.filter(link => fixedRun(link) === undefined || link === leaf);
        if (cohort.length < 2) return false;
        return fixedRun(leaf)!.run >= fanRows(model, port, cohort)[cohort.length - 2]! + fanPitch(cohort) - 1e-6;
      };
      const leaf = candidates.find(candidate => fits(candidate));
      active = links.filter(link => fixedRun(link) === undefined || link === leaf);
      // A bundle owns its members' geometry (7e's own fan), so only the fixed-path filter applies there.
      if (links.some(link => link.bundle)) {
        if (active.length >= 2) {
          result.push({ port, links: active });
          for (const link of links) if (!active.includes(link)) excluded.push({ port, link });
        }
        continue;
      }
      for (;;) {
        if (active.length < 2) break;
        const rows = fanRows(model, port, active), last = rows[active.length - 2]! + fanPitch(active);
        const out = active.filter(link => { const fit = fixedRun(link); return fit !== undefined && fit.run < last - 1e-6; });
        if (!out.length) break;
        active = active.filter(link => !out.includes(link));
      }
    }
    if (active.length >= 2) {
      result.push({ port, links: active });
      for (const link of links) if (!active.includes(link)) excluded.push({ port, link });
    }
  }
  return { cohorts: result, excluded };
}

/**
 * Where the tree's straight continuation ends: `rows[n]`, or earlier when the fixed member that is
 * the straight leaf turns before that — never before the last junction row.
 */
export function fanEnd(model: LayoutModel, port: LayoutPort, links: readonly LayoutLink[], pending?: PendingFixed): number {
  const rows = fanRows(model, port, links), last = rows[links.length - 2]!, end = rows[links.length]!;
  const at = portId(port.ref);
  const runs = links.map(link => {
    const waiting = pending?.get(link.id);
    if (waiting && waiting.port === at) return leadingRun(port, waiting.segments);
    return link.path?.fixed === true ? leadingRun(port, link.path.segments) : Infinity;
  });
  // The continuation must clear the last peel row by a pitch: a fixed member that turns at the row
  // itself would touch the branch peeling there, which no junction exemption covers.
  const shortest = Math.min(end, ...runs);
  return shortest >= last + fanPitch(links) - 1e-6 ? shortest : end;
}

/**
 * Split a fixed path's leading run out of `port` into the fan tree's stems — one per junction, owned
 * by that junction's id — and the remainder owned by the link (ADR-0016). `segments` must run
 * either from the port or into it. Returns the original when the run is too short to hold them.
 */
export function splitUnderJunctions(model: LayoutModel, port: LayoutPort, cohort: readonly LayoutLink[], link: LayoutLink, segments: PathSegment[], pending?: PendingFixed): PathSegment[] {
  const junctions = cohort.length - 1, rows = fanRows(model, port, cohort), end = fanEnd(model, port, cohort, pending);
  if (junctions < 1 || leadingRun(port, segments) < end - 1e-6) return segments;
  const anchor = port.anchor!;
  const forward = Math.abs(segments[0]!.from.x - anchor.x) < 1e-6 && Math.abs(segments[0]!.from.y - anchor.y) < 1e-6;
  const flip = (list: readonly PathSegment[]): PathSegment[] => [...list].reverse().map(s => ({ ...s, from: { ...s.to }, to: { ...s.from } }));
  const ordered = forward ? segments : flip(segments);
  const n = normal(port.side!), tangent = axis(port.side!);
  const along = (s: PathSegment): number => tangent === 'x' ? n.y * (s.to.y - s.from.y) : n.x * (s.to.x - s.from.x);
  // The plain run up to `end` is one straight line; it becomes exactly one segment per junction stem
  // and one continuation, each owned by its junction. The input segment holding `end` keeps its
  // remainder with its own owner and annotations; every later segment is untouched.
  const cuts = [...rows.slice(0, junctions), end].filter((value, index, all) => index === 0 || value > all[index - 1]! + 1e-6);
  const template = ordered[0]!;
  const rebuilt: PathSegment[] = [];
  let from = 0;
  for (const [index, to] of cuts.entries()) {
    const owner = { kind: 'shared-stem' as const, id: junctionId(port, Math.min(index, junctions - 1)) };
    rebuilt.push({ ...template, from: alongNormal(port, from), to: alongNormal(port, to), owner });
    from = to;
  }
  // Consume the input up to `end`: a segment wholly inside the run is replaced by the stems above,
  // and the one holding `end` keeps the part beyond it. A perpendicular segment never advances the
  // depth, so the scan stops at the first turn even when `end` falls on a boundary.
  let depth = 0, index = 0;
  for (; index < ordered.length; index++) {
    const length = along(ordered[index]!);
    if (length <= 1e-6 || depth + length > end + 1e-6) break;
    depth += length;
  }
  if (index < ordered.length && depth < end - 1e-6) {
    // `end` falls inside this segment: keep what lies beyond it, under the link's own name.
    rebuilt.push({ ...ordered[index]!, from: alongNormal(port, end), owner: { ...link.owner } });
    index++;
  }
  rebuilt.push(...ordered.slice(index));
  return forward ? rebuilt : flip(rebuilt);
}

/** Geometry-only plan. No path, lane owner, bar reservation or envelope is written here. */
export function prepareBundleGeometry(model: LayoutModel): void {
  // A diagram with no bundle still reserves the depth of its plain fans (ticket 20); one with
  // neither has nothing to plan.
  if (!model.bundles.length && !treeCohorts(model).some(({ port }) => axis(port.side!) === 'x')) return;
  const oldBands = clone(model.tierBands);
  for (const bundle of model.bundles) { orderDistinct(model, bundle); applyBundleOrder(model, bundle); }
  const planned = new Map<string, Map<LayoutPort, number>>();
  const set = (port: LayoutPort, value: number): void => {
    const key = JSON.stringify([port.ref.node, port.side]);
    const plan = planned.get(key) ?? new Map<LayoutPort, number>();
    plan.set(port, value); planned.set(key, plan);
  };
  const done = new Set<string>();
  const block = (bundle: Bundle, lower?: number): void => {
    const list = members(model, bundle);
    if (!facing(list)) return;
    const tangent = axis(list[0]!.a.side!);
    const q = pitch(model, bundle), inverted = inversionPairs(list).length > 0;
    // A shared bar slot can lie midway between peer tracks. Leave a full pitch from its
    // normal to either independent approach, rather than half a pitch at a two-leaf star.
    const freeBarStar = (['a', 'b'] as const).some(end => {
      const far = end === 'a' ? 'b' : 'a';
      return new Set(list.map(m => portId(m[end].ref))).size === 1
        && model.document.groups[model.document.nodes[list[0]![end].ref.node]!.group]!.shape === 'bar'
        && new Set(list.map(m => portId(m[far].ref))).size === list.length;
    }) && !model.lanes.some(lane => lane.owner.kind === 'link' && bundle.members.includes(lane.owner.id))
      && !model.barDrops.some(drop => bundle.members.includes(drop.link) && drop.barCross.length);
    const spacing = Math.max(q * (inverted || freeBarStar ? 2 : 1), ...list.flatMap(m => [model.nodes[m.a.ref.node]!.sidePitch![m.a.side!]!, model.nodes[m.b.ref.node]!.sidePitch![m.b.side!]!]));
    for (const item of list) for (const p of [item.a, item.b]) model.nodes[p.ref.node]!.sidePitch![p.side!] = spacing;
    const commonStart = Math.max(lower ?? -Infinity, ...bundle.nodes.map(id => model.nodes[id]!.bounds![tangent] + 10 + spacing / 2));
    for (const end of ['a', 'b'] as const) {
      const far = end === 'a' ? 'b' : 'a';
      const ordered = [...list].sort((a, b) => a[end].engineOrder! - b[end].engineOrder! || a[far].engineOrder! - b[far].engineOrder! || a.link.sourceIndex - b.link.sourceIndex);
      const ports = [...new Set(ordered.map(m => m[end]))];
      const node = model.nodes[ports[0]!.ref.node]!, dim = tangent === 'x' ? 'width' : 'height';
      let start = commonStart;
      if (tangent === 'x') {
        const group = model.groups[model.document.nodes[node.id]!.group]!;
        let limit = Infinity;
        for (const id of group.rowOrder ?? []) {
          const sibling = model.nodes[id]!;
          if (id !== node.id && sibling.bounds!.x > node.bounds!.x
            && Math.min(bottom(node.bounds!), bottom(sibling.bounds!)) > Math.max(node.bounds!.y, sibling.bounds!.y)) {
            limit = Math.min(limit, sibling.bounds!.x - rowGap(model, node.id, id));
          }
        }
        for (const lane of model.lanes) if (lane.tier === group.tier && lane.x > group.bounds!.x) {
          limit = Math.min(limit, lane.bounds.x - 12);
        }
        // Alignment is optional; capacity and immutable lanes are not. Leave a bundle bent when
        // projecting a distant peer's x would grow this node across a sibling or reserved lane.
        const sideCount = node.ports.filter(port => port.side === ports[0]!.side).length;
        if (start + (sideCount - 1) * spacing + 10 + spacing / 2 > limit) {
          start = node.bounds!.x + 10 + spacing / 2;
        }
      }
      ports.forEach(port => set(port, start + ordered.findIndex(m => m[end] === port) * spacing));
      node.bounds![dim] = Math.max(node.bounds![dim], start + (list.length - 1) * spacing + 10 + spacing / 2 - node.bounds![tangent]);
      node.size![dim] = node.bounds![dim];
    }
    if (tangent === 'x') for (const item of list) for (const port of [item.a, item.b]) {
      const tier = model.groups[model.document.nodes[port.ref.node]!.group]!.tier!;
      const lane = model.lanes.filter(l => l.owner.kind === 'link' && l.owner.id === item.link.id)
        .sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier))[0];
      if (!lane) continue;
      const node = model.nodes[port.ref.node]!, oldRight = right(node.bounds!);
      node.bounds!.x = Math.min(node.bounds!.x, lane.x - 10 - spacing / 2);
      node.bounds!.width = Math.max(oldRight, lane.x + 10 + spacing / 2) - node.bounds!.x;
      node.size!.width = node.bounds!.width;
      set(port, lane.x);
    }
    done.add(bundle.id);
  };
  // Primary facing blocks occupy the upper range; secondary corridors clear every intervening box.
  for (const group of Object.values(model.groups)) {
    if (!group.flank?.primaryPeer || group.nodes.length !== 1) continue;
    const own = group.nodes[0]!, primary = model.nodes[group.flank.primaryPeer]!;
    const primaryBundle = model.bundles.find(b => b.nodes.includes(own) && b.nodes.includes(primary.id));
    if (!primaryBundle || !facing(members(model, primaryBundle))) continue;
    const list = members(model, primaryBundle);
    if (axis(list[0]!.a.side!) !== 'y' || inversionPairs(list).length) continue;
    // Bringing the flank's box down to its primary's makes room for the block below. A flank that
    // also carries a port outside the bundle has had its own height set by stage 7b to level the
    // pairs *around* that port, so the boxes no longer measure the same thing: moving by them undoes
    // the levelling and leaves the outside port's stem inside the envelope this block reserves
    // (ticket 21). Such a flank is measured between its paired anchors instead.
    const flank = model.nodes[own]!, paired = list[0]!;
    // Only a remainder on the side this bundle uses, and above its members: that is the port 7b
    // levelled the pairs around, and the one whose stem the envelope would otherwise capture. A
    // remainder elsewhere on the flank, or below the block, did not move these ports and is no
    // reason to leave the box where 7b put it.
    const flankPort = (item: Member): LayoutPort => item.a.ref.node === own ? item.a : item.b;
    const facingSide = flankPort(paired).side, top = Math.min(...list.map(item => flankPort(item).anchor!.y));
    // Above the block at all. Demanding a stroke-aware pitch here would answer the wrong question:
    // a weighted remainder needs *more* room than stage 5's member pitch gave it, and refusing the
    // branch for want of that room is exactly the failure this fixes. Reserving the wider pitch is
    // its own work, recorded on the ticket.
    const band = model.tierBands.find(item => item.groups.includes(group.id));
    const outside = flank.ports.some(port => port.side === facingSide && port.anchor!.y < top - 1e-6
      && model.links.some(link => link.layer === 'routed' && link.technique !== 'stub'
        && link.bundle === undefined && link.attachments
        && [link.attachments.from, link.attachments.to].some(ref => portId(ref) === portId(port.ref))))
      // Keeping the flank where 7b put it is only safe inside its own band: the box-based move also
      // repairs a flank lifted past the band above it, and nothing restacks the bands after this.
      && (!band?.bounds || group.bounds!.y >= band.bounds.y - 1e-6);
    const here = flankPort(paired);
    const there = paired.a.ref.node === own ? paired.b : paired.a;
    const dy = Math.max(0, outside ? there.anchor!.y - here.anchor!.y : primary.bounds!.y - flank.bounds!.y);
    if (dy) moveGroup(model, group, 0, dy);
    block(primaryBundle);
    const q = Math.max(pitch(model, primaryBundle), ...list.flatMap(m => [model.nodes[m.a.ref.node]!.sidePitch![m.a.side!]!, model.nodes[m.b.ref.node]!.sidePitch![m.b.side!]!]));
    primary.bounds!.height = Math.max(primary.bounds!.height, 20 + new Set(list.map(m => m.a.ref.node === primary.id ? m.a : m.b)).size * q);
    primary.size!.height = primary.bounds!.height;
    // Each block has to clear whatever stroke its own members really carry.
    const memberStroke = (item: Bundle): number =>
      Math.max(DEFAULT_STROKE_WIDTHS.path, ...members(model, item).map(m => linkStrokeWidth(m.link)));
    let lower = bottom(primary.bounds!) + 10 + (memberStroke(primaryBundle) + (primary.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2;
    for (const secondary of model.bundles.filter(b => b.id !== primaryBundle.id && b.nodes.includes(own))) {
      const peers = members(model, secondary);
      if (!facing(peers) || axis(peers[0]!.a.side!) !== 'y' || inversionPairs(peers).length) continue;
      const boxes = secondary.nodes.map(id => model.nodes[id]!.bounds!);
      const left = Math.min(...boxes.map(right)), rightEdge = Math.max(...boxes.map(b => b.x));
      for (const n of Object.values(model.nodes)) {
        if (secondary.nodes.includes(n.id) || n.bounds!.x >= rightEdge || right(n.bounds!) <= left) continue;
        if (model.groups[model.document.nodes[n.id]!.group]!.tier !== group.tier) continue;
        lower = Math.max(lower, bottom(n.bounds!) + 10 + (memberStroke(secondary) + (n.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2);
      }
      block(secondary, lower);
      lower += peers.length * pitch(model, secondary);
    }
  }
  for (const bundle of model.bundles) if (!done.has(bundle.id)) block(bundle);
  // Install all blocks jointly. Unrelated ports keep their relative order and authored keys stay strict.
  for (const [key, plan] of planned) {
    const [id, side] = JSON.parse(key) as [string, Side], node = model.nodes[id]!;
    const tangent = axis(side), spacing = node.sidePitch![side]!;
    if (tangent === 'x') for (const port of node.ports.filter(p => p.side === side && !plan.has(p))) {
      const incident = model.links.filter(l => l.attachments && [l.attachments.from, l.attachments.to].some(ref => portId(ref) === portId(port.ref)));
      const positions = incident.flatMap(link => model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id).map(lane => lane.x));
      if (positions.length && new Set(positions).size === 1) plan.set(port, positions[0]!);
    }
    const bundled = new Set(model.links.filter(l => l.bundle).flatMap(l => [portId(l.attachments!.from), portId(l.attachments!.to)]));
    const unrelated = new Set(node.ports.filter(p => p.side === side && !bundled.has(portId(p.ref))));
    const ports = sorted(node.ports.filter(p => p.side === side), p => plan.get(p) ?? coordinate(p), unrelated);
    let prior = node.bounds![tangent] + 10 - spacing / 2;
    ports.forEach((port, engineOrder) => {
      const value = Math.max(plan.get(port) ?? coordinate(port), prior + spacing);
      port.engineOrder = engineOrder; port.anchor![tangent] = value; prior = value;
    });
    const dim = tangent === 'x' ? 'width' : 'height';
    node.bounds![dim] = Math.max(node.bounds![dim], prior + 10 + spacing / 2 - node.bounds![tangent], 20 + ports.length * spacing);
    node.size![dim] = node.bounds![dim];
  }
  for (const node of Object.values(model.nodes)) for (const port of node.ports) {
    if (port.side === 'bottom') port.anchor!.y = bottom(node.bounds!);
    if (port.side === 'right') port.anchor!.x = right(node.bounds!);
    if (port.side === 'left') port.anchor!.x = node.bounds!.x;
  }
  for (const group of Object.values(model.groups)) fitRegionGroup(model, group);
  repackOverlaps(model);
  rebuildBands(model);
  let shift = 0;
  for (const band of [...model.tierBands].sort((a, b) => a.tier - b.tier)) {
    const old = oldBands.find(b => b.tier === band.tier)!;
    if (shift) for (const group of Object.values(model.groups).filter(g => g.tier === band.tier)) moveGroup(model, group, 0, shift);
    shift += Math.max(0, bottom(band.bounds!) - bottom(old.bounds!));
  }
  rebuildBands(model);
  // Shared trees and their normal continuation must finish before the nearest fixed lane. Every
  // cohort that stage 7e will give a tree — a bundle's own fan, a cross-bundle port or a plain fan
  // of routed links (ticket 20) — reserves the depth its rows and tracks need before its lane.
  for (const { port, links } of treeCohorts(model)) {
    if (axis(port.side!) !== 'x') continue;
    const n = normal(port.side!), tier = model.groups[model.document.nodes[port.ref.node]!.group]!.tier!;
    const memberIds = new Set(links.map(link => link.id));
    // Only a lane the fan actually runs towards — beyond the port's normal — bounds it; a lane on
    // the other side of the node belongs to a link that leaves this port and turns back.
    const adjacent = model.lanes.filter(lane => lane.owner.kind === 'link' && memberIds.has(lane.owner.id)
      && (n.y > 0 ? lane.tier > tier : lane.tier < tier))
      .sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier))[0];
    // A fan whose links own no lane ends in the next tier band itself: its tree still needs the
    // same depth before that band's entry (ticket 20), so the band is the boundary to reserve against.
    const nextTier = adjacent?.tier ?? [...model.tierBands].map(b => b.tier)
      .filter(t => n.y > 0 ? t > tier : t < tier).sort((a, b) => n.y > 0 ? a - b : b - a)[0];
    if (nextTier === undefined) continue;
    const band = model.tierBands.find(b => b.tier === nextTier)!;
    const entry = n.y > 0 ? band.bounds!.y - 10.75 : -bottom(band.bounds!) - 10.75;
    const incidentBundles = model.bundles.filter(bundle => links.some(link => link.bundle === bundle.id));
    const degree = Math.max(links.length, ...incidentBundles.map(bundle => bundle.members.length));
    const q = Math.max(fanPitch(links), ...incidentBundles.map(bundle => pitch(model, bundle)));
    // Fan rows may each move one edge margin off a group edge (ADR-0013); reserve that room.
    const required = 2 * MIN_STEM + q * (degree + 1) + 2 * edgeMargin(routedStrokeWidth(model));
    const delta = Math.max(0, required - (entry - n.y * port.anchor!.y));
    const movedTier = n.y > 0 ? nextTier : tier;
    if (delta) for (const group of Object.values(model.groups).filter(g => g.tier! >= movedTier)) moveGroup(model, group, 0, delta);
    rebuildBands(model);
  }
  // Merged members need a free join/fan interval before their individual lanes.
  for (const bundle of model.bundles) {
    const list = members(model, bundle).filter(m => m.link.technique === 'merge');
    if (list.length < 2) continue;
    const selectedIds = new Set(list.map(m => m.link.id));
    const own = model.lanes.filter(l => l.owner.kind === 'link' && selectedIds.has(l.owner.id));
    if (!own.length) continue;
    const n = normal(list[0]!.a.side!);
    if (n.y === 0) continue;
    const tier = n.y > 0 ? Math.min(...own.map(l => l.tier)) : Math.max(...own.map(l => l.tier));
    const band = model.tierBands.find(b => b.tier === tier)!;
    const entry = n.y > 0 ? band.bounds!.y - 10.75 : -bottom(band.bounds!) - 10.75;
    const start = Math.max(...list.map(m => n.y * m.a.anchor!.y));
    const delta = Math.max(0, 30 + (2 * list.length + 1) * pitch(model, bundle) + 2 * edgeMargin(routedStrokeWidth(model)) - (entry - start));
    const movedTier = n.y > 0 ? tier : model.groups[model.document.nodes[list[0]!.a.ref.node]!.group]!.tier!;
    if (delta) for (const group of Object.values(model.groups).filter(g => g.tier! >= movedTier)) moveGroup(model, group, 0, delta);
    rebuildBands(model);
  }
  // Reserve the complete crossing area before any producer pins paths. A port with a junction tree
  // advances every path through it by the tree's own depth — its stem, its rows and any row moved
  // off a group edge — which is the same figure 7e will draw, whether the tree comes from the
  // bundle's own shared port or from an ordinary routed link on it.
  const trees = new Map(treeCohorts(model).map(cohort => [portId(cohort.port.ref), cohort]));
  for (const bundle of model.bundles) {
    const list = members(model, bundle), inversions = inversionPairs(list).length;
    if (!facing(list)) continue;
    const q0 = pitch(model, bundle);
    const fan = fanDepth(model, trees, bundle, list, 'a', q0) + fanDepth(model, trees, bundle, list, 'b', q0);
    if (axis(list[0]!.a.side!) === 'y') {
      if (inversions) {
        const q = pitch(model, bundle), [left, rightNode] = bundle.nodes.map(id => model.nodes[id]!).sort((a, b) => a.bounds!.x - b.bounds!.x);
        // Join, leave and fan rows may each move one edge margin off a group edge (ADR-0013), the
        // same allowance the other axis carries.
        const required = 30 + 4 * q * inversions + 2 * q * (list.length + 1) + fan + 2 * edgeMargin(routedStrokeWidth(model)), threshold = rightNode!.bounds!.x;
        const delta = Math.max(0, required - (threshold - right(left!.bounds!)));
        const tier = model.groups[model.document.nodes[rightNode!.id]!.group]!.tier;
        if (delta) for (const group of Object.values(model.groups).filter(g => g.tier === tier)) {
          const moved = group.nodes.filter(id => model.nodes[id]!.bounds!.x >= threshold);
          if (moved.length === group.nodes.length) moveGroup(model, group, delta, 0);
          else for (const id of moved) { model.nodes[id]!.bounds!.x += delta; model.nodes[id]!.ports.forEach(p => { p.anchor!.x += delta; }); }
          fitRegionGroup(model, group);
        }
      }
      continue;
    }
    const q = pitch(model, bundle), a = model.nodes[bundle.nodes[0]]!, b = model.nodes[bundle.nodes[1]]!;
    const upper = a.bounds!.y < b.bounds!.y ? a : b, lower = upper === a ? b : a;
    const upperTier = model.groups[model.document.nodes[upper.id]!.group]!.tier!, lowerTier = model.groups[model.document.nodes[lower.id]!.group]!.tier!;
    if (upperTier >= lowerTier || model.lanes.some(lane => bundle.members.includes(lane.owner.kind === 'link' ? lane.owner.id : ''))) continue;
    const mergeMembers = list.filter(m => m.link.technique === 'merge').length;
    // A merge trunk interleaves its join and leave rows only where the members meet on one port.
    const shared = (['a', 'b'] as const).some(end => new Set(list.map(m => portId(m[end].ref))).size < list.length);
    const mergeAllowance = shared && mergeMembers >= 2 ? (2 * list.length + 1) * q : 0;
    // Join, leave and fan rows may each move one edge margin off a group edge (ADR-0013).
    const general = mergeAllowance + fan + 2 * MIN_STEM + (inversions ? 4 * q * inversions + 2 * q * (list.length + 1) : q * (list.length + 1))
      + 2 * edgeMargin(routedStrokeWidth(model));
    // An unshared merge trunk needs its interleaved join and leave rows between the two stems too.
    const mergeTrunk = mergeMembers >= 2 ? 2 * MIN_STEM + (2 * mergeMembers - 1) * q + 2 * edgeMargin(routedStrokeWidth(model)) : 0;
    const required = Math.max(general, mergeTrunk);
    const delta = Math.max(0, required - (lower.bounds!.y - bottom(upper.bounds!)));
    if (delta) for (const group of Object.values(model.groups).filter(g => g.tier! >= lowerTier)) moveGroup(model, group, 0, delta);
  }
  rebuildBands(model);
}
