import type { PortRef } from '../model/document.js';
import type { Point, Rect } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPort, PathSegment } from '../model/layout.js';
import { placePortPill } from '../geometry/index.js';
import { measurePortPill } from '../text/index.js';
import { EPS, intersection, samePoint } from '../score/geometry.js';
import { isRoutedChord } from './frame-paths.js';
import { transitTiers } from './lanes.js';
import { crosses, overlayBlockers, overlayPath, straightChord, type OverlayBlockers } from './overlay-paths.js';
import { facingSide, hintRefusal } from './side-hints.js';
import { portKey } from './sides-one.js';
import { measureChordSides } from './side-chords.js';

/**
 * The side measure (docs/design/side-faces.md, Sections 4 to 7): on a placed model (stages 1 to 7e) it names the lateral sides that would
 * give a bent overlay link one straight segment. Ticket 115 offers the straight shape of an overlay link only.
 */

/** Most probes one `measureSides` call makes, in link order (a count; `SIDE_PROBE_CAPPED`). */
export const PROBE_CAP = 256;
/** A straight segment out of a lateral face leaves at this angle or more from the face (review L1). */
export const MIN_LATERAL_ANGLE = 15;
const MIN_OUTWARD = Math.sin(MIN_LATERAL_ANGLE * Math.PI / 180);
/** The lateral pitch of an anonymous port; a named one is `pill height + 4` (spec Section 8). */
const LATERAL_PITCH = 12;

export const refusedKey = (key: string, side: string): string => `${key}|${side}`;

const isOverlay = (link: LayoutLink): boolean => link.layer === 'overlay' && link.meshBus === undefined && link.attachments !== undefined;

/**
 * The bends a link will have, read from the placed model, no router (spec Section 6). An overlay link: the segments of its derived path
 * less one. A link with a pinned path (a chord, a level path): that path's segments less one. Any other routed link: per tier gap 0 when
 * its two ends stand on one x (a drop, adjacent tiers only), else 2. A lower bound.
 */
export function plannedBends(model: LayoutModel, link: LayoutLink, blockers?: OverlayBlockers): number {
  if (link.attachments === undefined) return 0;
  if (isOverlay(link)) return Math.max(0, overlayPath(model, link, blockers).segments.length - 1);
  if (isRoutedChord(model, link)) return 0;
  if (link.path?.fixed === true) return Math.max(0, link.path.segments.length - 1);
  const refs = [link.attachments.from, link.attachments.to];
  const ends = refs.map(ref => model.nodes[ref.node]?.ports.find(port => portKey(port.ref) === portKey(ref))?.anchor);
  const tiers = refs.map(ref => model.groups[model.document.nodes[ref.node]!.group]?.tier ?? 0);
  const gaps = Math.abs(tiers[0]! - tiers[1]!);
  if (gaps === 0) return 0;
  const drop = gaps === 1 && transitTiers(model, link).length === 0 && ends[0] !== undefined && ends[1] !== undefined && Math.abs(ends[0].x - ends[1].x) <= EPS;
  return drop ? 0 : 2 * gaps;
}

/** How many links are bent, and how many bends they have in all, on one model (the round's gain test). */
export function bendTotals(model: LayoutModel): { bent: number; total: number } {
  const blockers = overlayBlockers(model);
  let bent = 0, total = 0;
  for (const link of model.links) {
    const bends = plannedBends(model, link, blockers);
    if (bends > 0) { bent++; total += bends; }
  }
  return { bent, total };
}

/** Extra room 7f may take: it grows tier gaps after 7e, so a segment that misses every body by less than this at 7e can still publish straight (as `FAN_SLACK`). */
export const NATURAL_SLACK = 4;
const NORMAL_OF: Readonly<Record<string, Point>> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const shrink = (box: Rect, by: number): Rect => ({ x: box.x + by, y: box.y + by, width: Math.max(0, box.width - 2 * by), height: Math.max(0, box.height - 2 * by) });

/**
 * Whether the overlay link's straight segment between its natural faces is clear of every foreign body and pill once each is pulled in by
 * `NATURAL_SLACK`. Such a link is bent at 7e only by a margin 7f closes, and it publishes straight without a hint (ticket 115 review, M1).
 */
function naturalStraightNearlyClear(model: LayoutModel, link: LayoutLink, blockers: OverlayBlockers): boolean {
  const chord = straightChord(model, link, blockers, true);
  if (chord === undefined) return false;
  const ends = [link.attachments!.from, link.attachments!.to].map(ref => model.nodes[ref.node]?.ports.find(port => portKey(port.ref) === portKey(ref)));
  const dir = { x: chord.to.x - chord.from.x, y: chord.to.y - chord.from.y };
  const leaves = (port: LayoutPort | undefined, sign: number): boolean => port?.side !== undefined
    && sign * (dir.x * NORMAL_OF[port.side]!.x + dir.y * NORMAL_OF[port.side]!.y) >= -EPS;
  if (!leaves(ends[0], 1) || !leaves(ends[1], -1)) return false;
  const own = ends.flatMap(port => port?.pill && port.ref.anonymous !== true ? [port.pill.bounds] : []);
  const window: Rect = { x: Math.min(chord.from.x, chord.to.x), y: Math.min(chord.from.y, chord.to.y), width: Math.abs(dir.x), height: Math.abs(dir.y) };
  return !blockers.some(window, box => !own.some(pill => pill.x === box.x && pill.y === box.y && pill.width === box.width && pill.height === box.height)
    && crosses(chord.from, chord.to, shrink(box, NATURAL_SLACK)));
}

const strictCrossing = (a: PathSegment, b: PathSegment): boolean => {
  const point = intersection(a, b);
  return point !== undefined && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, point));
};

/**
 * How many pairs of links cross where one of the pair is an overlay link ending on one of `nodes` (spec Section 15 reports crossings; the round
 * must not add one at a moved port). It reads the segments known at 7e with no router: the derived path of an overlay link, the pinned path of
 * a chord or a level path. A pair counts once.
 */
export function overlayCrossingsAt(model: LayoutModel, nodes: ReadonlySet<string>): number {
  const blockers = overlayBlockers(model), cache = new Map<string, PathSegment[]>();
  const segments = (link: LayoutLink): PathSegment[] => {
    if (cache.has(link.id)) return cache.get(link.id)!;
    // A link 7f will straighten by itself is read as its natural chord, the shape it publishes, not as the bent path it has at 7e.
    const chord = isOverlay(link) && naturalStraightNearlyClear(model, link, blockers) ? straightChord(model, link, blockers, true) : undefined;
    cache.set(link.id, chord !== undefined ? [{ from: chord.from, to: chord.to, owner: link.owner }]
      : isOverlay(link) ? overlayPath(model, link, blockers).segments : link.path?.segments ?? []);
    return cache.get(link.id)!;
  };
  const near = model.links.filter(link => isOverlay(link) && (nodes.has(link.attachments!.from.node) || nodes.has(link.attachments!.to.node)));
  const pairs = new Set<string>();
  for (const one of near) for (const other of model.links) {
    if (other.id === one.id || other.attachments === undefined) continue;
    const key = one.id < other.id ? `${one.id}|${other.id}` : `${other.id}|${one.id}`;
    if (pairs.has(key)) continue;
    if (segments(one).some(a => segments(other).some(b => strictCrossing(a, b)))) pairs.add(key);
  }
  return pairs.size;
}

export interface SideOffer {
  /** New hints: `portKey` to the lateral side. Never an old hint, never a refused key. */
  hints: Map<string, 'left' | 'right'>;
  /** For each new hint, the link and the bends the probe promised (0: straight). */
  promised: Map<string, { link: string; bends: number; shape: 'straight' }>;
  /** True when the probe cap left candidates unprobed. */
  capped: boolean;
}

interface Lateral { ref: PortRef; key: string; side: 'left' | 'right' }
interface Config { laterals: Lateral[]; grows: boolean; nodes: LayoutModel['nodes'] }

/** The node with the port moved to the lateral face: a copy, the placed node is not touched. Undefined when no slot fits the box. */
function moved(node: LayoutNode, lateral: Lateral, peerY: number): { node: LayoutNode; grows: boolean } | undefined {
  const box = node.bounds!;
  const measured = lateral.ref.anonymous === true ? undefined : measurePortPill(lateral.ref.name!);
  const pitch = measured === undefined ? LATERAL_PITCH : Math.max(LATERAL_PITCH, measured.text.height + 4);
  const others = node.ports.filter(port => port.side === lateral.side && port.anchor !== undefined).map(port => port.anchor!.y);
  let y = box.y + box.height / 2;
  if (others.length > 0) y = peerY > box.y + box.height / 2 ? Math.max(...others) + pitch : Math.min(...others) - pitch;
  if (y < box.y + pitch / 2 - EPS || y > box.y + box.height - pitch / 2 + EPS) return undefined;
  const anchor: Point = { x: lateral.side === 'left' ? box.x : box.x + box.width, y };
  const ports = node.ports.map(port => {
    if (portKey(port.ref) !== lateral.key) return port;
    const { pill, ...rest } = port;
    const next: LayoutPort = { ...rest, side: lateral.side, anchor };
    if (measured !== undefined && pill !== undefined) {
      const placed = placePortPill(box, lateral.side, y - box.y, measured);
      next.pill = { ...pill, size: placed.size, bounds: placed.bounds, textRotation: placed.textRotation, radius: placed.radius };
    }
    return next;
  });
  return { node: { ...node, ports }, grows: others.length > 0 };
}

const centreOf = (box: Rect): { x: number; y: number } => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * The lateral sides to try in the next placement run (spec Sections 4, 5 and 7). Candidates are overlay links that are bent now and whose
 * ends are hint candidates (`hintRefusal`, natural side `top` or `bottom`, peers on different tiers). In link order, each candidate is probed
 * with the lateral side at the upper end, at the lower end, and at both; the probe reads `straightChord` on the moved ends and the minimum
 * outward angle. The configuration with fewer lateral ports wins, then the one that needs no node growth, then the lower end, then the end
 * that comes first in document order. An accepted hint is applied to the probe model before the next link is read.
 *
 * The probe model shares every node the probe does not move with the placed model and holds a copy of each node it moves, so the placed
 * model is never touched and no reset is needed (the spec's one clone, by structural sharing).
 *
 * Known limit: `refused` is greedy and keyed by (port, side). A hint refused in a trial with another hint is not offered again, even when it
 * would give its shape alone, and a key refused for one geometry stays refused after the geometry changes. Nothing searches subsets.
 */
export function measureSides(model: LayoutModel, refused: ReadonlySet<string>, probeCap = PROBE_CAP): SideOffer {
  const offer: SideOffer = { hints: new Map(), promised: new Map(), capped: false };
  const blockers = overlayBlockers(model);
  const order = new Map(Object.keys(model.document.nodes).map((id, index) => [id, index]));
  const tierOf = (ref: PortRef): number => model.groups[model.document.nodes[ref.node]!.group]!.tier!;
  let nodes: LayoutModel['nodes'] = model.nodes;
  let probes = 0;
  for (const link of model.links.filter(item => isOverlay(item) && plannedBends(model, item, blockers) > 0 && !naturalStraightNearlyClear(model, item, blockers))) {
    const ends = [link.attachments!.from, link.attachments!.to];
    if (ends[0]!.node === ends[1]!.node || tierOf(ends[0]!) === tierOf(ends[1]!)) continue;
    const laterals: Lateral[] = [];
    for (const [index, ref] of ends.entries()) {
      const peer = ends[1 - index]!, node = nodes[ref.node]!, key = portKey(ref);
      const port = node.ports.find(item => portKey(item.ref) === key);
      if (port === undefined || port.sideHint === true || (port.side !== 'top' && port.side !== 'bottom')) continue;
      if (hintRefusal(model, ref) !== undefined || node.bounds === undefined || nodes[peer.node]?.bounds === undefined) continue;
      const side = facingSide(centreOf(node.bounds).x, centreOf(nodes[peer.node]!.bounds!).x) as 'left' | 'right';
      if (refused.has(refusedKey(key, side))) continue;
      laterals.push({ ref, key, side });
    }
    if (laterals.length === 0) continue;
    if (probes >= probeCap) { offer.capped = true; break; }
    probes++;
    const configs: Config[] = [];
    const attempt = (chosen: Lateral[]): void => {
      let draft = nodes, grows = false;
      for (const lateral of chosen) {
        const peer = ends.find(ref => portKey(ref) !== lateral.key)!;
        const result = moved(draft[lateral.ref.node]!, lateral, centreOf(draft[peer.node]!.bounds!).y);
        if (result === undefined) return;
        draft = { ...draft, [lateral.ref.node]: result.node };
        grows ||= result.grows;
      }
      const probe: LayoutModel = { ...model, nodes: draft };
      const chord = straightChord(probe, link, overlayBlockers(probe));
      if (chord === undefined) return;
      const length = Math.hypot(chord.to.x - chord.from.x, chord.to.y - chord.from.y);
      if (length <= EPS) return;
      for (const lateral of chosen) {
        const dx = portKey(ends[0]!) === lateral.key ? chord.to.x - chord.from.x : chord.from.x - chord.to.x;
        if (dx * (lateral.side === 'right' ? 1 : -1) / length < MIN_OUTWARD - EPS) return;
      }
      configs.push({ laterals: chosen, grows, nodes: draft });
    };
    for (const lateral of laterals) attempt([lateral]);
    if (laterals.length === 2) attempt(laterals);
    if (configs.length === 0) continue;
    // Fewer lateral ports, then no growth, then the lower end (the deeper tier), then document order.
    const key = (config: Config): number[] => [config.laterals.length, Number(config.grows), -tierOf(config.laterals[0]!.ref), order.get(config.laterals[0]!.ref.node)!];
    configs.sort((a, b) => { const x = key(a), y = key(b), at = x.findIndex((value, index) => value !== y[index]); return at < 0 ? 0 : x[at]! - y[at]!; });
    const best = configs[0]!;
    nodes = best.nodes;
    for (const lateral of best.laterals) {
      offer.hints.set(lateral.key, lateral.side);
      offer.promised.set(lateral.key, { link: link.id, bends: 0, shape: 'straight' });
    }
  }
  // The routed chord shape (ticket 117): its own pass over the routed links, on the nodes the overlay pass left.
  const chords = measureChordSides(model, nodes, refused, moved, MIN_OUTWARD, refusedKey, link => plannedBends(model, link, blockers), probes, probeCap);
  for (const [key, side] of chords.hints) offer.hints.set(key, side);
  for (const [key, item] of chords.promised) offer.promised.set(key, item);
  offer.capped ||= chords.capped;
  return offer;
}
