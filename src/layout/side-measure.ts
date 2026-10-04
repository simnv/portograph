import type { PortRef } from '../model/document.js';
import type { Point, Rect } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPort } from '../model/layout.js';
import { placePortPill } from '../geometry/index.js';
import { measurePortPill } from '../text/index.js';
import { EPS } from '../geometry/planar.js';
import { isRoutedChord } from './frame-paths.js';
import { isSideLane, transitTiers } from './lanes.js';
import { crosses, overlayBlockers, overlayPath, straightChord, type OverlayBlockers } from './overlay-paths.js';
import { facingSide, hintRefusal } from './side-hints.js';
import { portKey } from './sides-one.js';
import { measureChordSides } from './side-chords.js';
import { measureLaneSides } from './side-lanes.js';
import { nodeTier } from './read/tier.js';

/**
 * The side measure (docs/design/side-faces.md, Sections 4 to 7): on a placed model (stages 1 to 7e) it names the lateral sides that would
 * give a bent overlay link one straight segment. Ticket 115 offers the straight shape of an overlay link; ticket 116 adds the L (one lateral end, one turn).
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
  // A side lane (spec Section 6): one bend into the lateral port, and a stepped part in the gap above a lane the far port does not stand on.
  const lane = model.lanes.find(item => isSideLane(item) && item.owner.kind === 'link' && item.owner.id === link.id);
  if (lane !== undefined) return lane.aligned === true ? 1 : 3;
  if (link.path?.fixed === true) return Math.max(0, link.path.segments.length - 1);
  const refs = [link.attachments.from, link.attachments.to];
  const ends = refs.map(ref => model.nodes[ref.node]?.ports.find(port => portKey(port.ref) === portKey(ref))?.anchor);
  const tiers = refs.map(ref => model.groups[model.document.nodes[ref.node]!.group]?.tier ?? 0);
  const gaps = Math.abs(tiers[0]! - tiers[1]!);
  if (gaps === 0) return 0;
  const drop = gaps === 1 && transitTiers(model, link).length === 0 && ends[0] !== undefined && ends[1] !== undefined && Math.abs(ends[0].x - ends[1].x) <= EPS;
  return drop ? 0 : 2 * gaps;
}

export interface SideOffer {
  /** New hints: `portKey` to the lateral side. Never an old hint, never a refused key. */
  hints: Map<string, 'left' | 'right'>;
  /** For each new hint, the link and the bends the probe promised (0: straight). */
  promised: Map<string, { link: string; bends: number; shape: 'straight' | 'L' | 'lane' }>;
  /** True when the probe cap left candidates unprobed. */
  capped: boolean;
  /**
   * The two probe clones after every accepted hint (Section 19.2, rule 2): the overlay probe on the baseline and the routed probe on the
   * kept 7e model, each hint in its own coordinates. The routed shapes (tickets 117, 119) read the second; the overlay shape reads the first.
   */
  probes?: { base: LayoutModel['nodes']; kept7e: LayoutModel['nodes'] };
}

interface Lateral { ref: PortRef; key: string; side: 'left' | 'right' }
interface Config { laterals: Lateral[]; grows: boolean; nodes: LayoutModel['nodes']; nodes7e: LayoutModel['nodes']; shape?: 'L' }

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
 * The L shape (spec Sections 5 and 11, ticket 116): one lateral end, and the overlay derivation on the baseline probe gives exactly one turn
 * (two segments). The caller asks for it once no straight shape fits; it is a gain only when the link has two bends or more now. A lateral
 * port at both ends is not an L, and no angle rule applies: both runs are axis-aligned. The same hint goes on the kept 7e clone (`attempt`).
 */
function lShapes(model: LayoutModel, kept7e: LayoutModel, nodes: LayoutModel['nodes'], nodes7e: LayoutModel['nodes'], link: LayoutLink, ends: PortRef[], laterals: Lateral[]): Config[] {
  if (plannedBends(model, link) < 2) return [];
  const found: Config[] = [];
  for (const lateral of laterals) {
    const peer = ends.find(ref => portKey(ref) !== lateral.key)!;
    const result = moved(nodes[lateral.ref.node]!, lateral, centreOf(nodes[peer.node]!.bounds!).y);
    if (result === undefined) continue;
    const draft = { ...nodes, [lateral.ref.node]: result.node };
    const probe: LayoutModel = { ...model, nodes: draft };
    const blockers = overlayBlockers(probe), segments = overlayPath(probe, link, blockers).segments;
    // `between()` falls back to paths that ignore pills and then bodies when every way round is blocked, and such a path can still have two
    // segments: an L is offered only when both runs are clear of every body and every foreign pill (ticket 116 review, H1).
    const own = ends.flatMap(ref => { const pill = probe.nodes[ref.node]?.ports.find(port => portKey(port.ref) === portKey(ref))?.pill; return pill === undefined ? [] : [pill.bounds]; });
    const clear = segments.every(({ from, to }) => !blockers.some({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) },
      box => !own.some(pill => pill.x === box.x && pill.y === box.y && pill.width === box.width && pill.height === box.height) && crosses(from, to, box)));
    if (segments.length !== 2 || !clear) continue;
    const node7e = nodes7e[lateral.ref.node], peer7e = kept7e.nodes[peer.node]?.bounds;
    const result7e = node7e?.bounds !== undefined && peer7e !== undefined ? moved(node7e, lateral, centreOf(peer7e).y) : undefined;
    found.push({ laterals: [lateral], grows: result.grows, nodes: draft, nodes7e: result7e !== undefined ? { ...nodes7e, [lateral.ref.node]: result7e.node } : nodes7e, shape: 'L' });
  }
  return found;
}

/**
 * The lateral sides to try in the next placement run (spec Sections 4, 5 and 7). Candidates are overlay links that are bent now and whose
 * ends are hint candidates (`hintRefusal`, natural side `top` or `bottom`, peers on different tiers). In link order, each candidate is probed
 * with the lateral side at the upper end, at the lower end, and at both; the probe reads `straightChord` on the moved ends and the minimum
 * outward angle. The configuration with fewer lateral ports wins, then the one that needs no node growth, then the lower end, then the end
 * that comes first in document order. An accepted hint is applied to both probe clones before the next link is read.
 *
 * `base` is the baseline, the model 7f publishes when no trial is kept (side-faces.md, Section 19.2): "bent now" and the overlay probe are read on
 * it, so a link that publishes straight is never a candidate. `kept7e` is the kept 7e model, where the routed probes read; a hint is applied
 * to its clone in its own coordinates. Neither model is touched.
 *
 * The probe model shares every node the probe does not move with the placed model and holds a copy of each node it moves, so the placed
 * model is never touched and no reset is needed (the spec's one clone, by structural sharing).
 *
 * Known limit: `refused` is greedy and keyed by (port, side). A hint refused in a trial with another hint is not offered again, even when it
 * would give its shape alone, and a key refused for one geometry stays refused after the geometry changes. Nothing searches subsets.
 */
export function measureSides(model: LayoutModel, kept7e: LayoutModel, refused: ReadonlySet<string>, probeCap = PROBE_CAP): SideOffer {
  const offer: SideOffer = { hints: new Map(), promised: new Map(), capped: false };
  const blockers = overlayBlockers(model);
  const order = new Map(Object.keys(model.document.nodes).map((id, index) => [id, index]));
  const tierOf = (ref: PortRef): number => nodeTier(model, ref.node);
  let nodes: LayoutModel['nodes'] = model.nodes, nodes7e: LayoutModel['nodes'] = kept7e.nodes;
  let probes = 0;
  for (const link of model.links.filter(item => isOverlay(item) && plannedBends(model, item, blockers) > 0)) {
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
      let draft = nodes, draft7e = nodes7e, grows = false;
      for (const lateral of chosen) {
        const peer = ends.find(ref => portKey(ref) !== lateral.key)!;
        const result = moved(draft[lateral.ref.node]!, lateral, centreOf(draft[peer.node]!.bounds!).y);
        if (result === undefined) return;
        draft = { ...draft, [lateral.ref.node]: result.node };
        grows ||= result.grows;
        // The same hint on the kept 7e clone, in its own coordinates; a node that has no box or no slot there keeps its 7e ports.
        const node7e = draft7e[lateral.ref.node], peer7e = kept7e.nodes[peer.node]?.bounds;
        const result7e = node7e?.bounds !== undefined && peer7e !== undefined ? moved(node7e, lateral, centreOf(peer7e).y) : undefined;
        if (result7e !== undefined) draft7e = { ...draft7e, [lateral.ref.node]: result7e.node };
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
      configs.push({ laterals: chosen, grows, nodes: draft, nodes7e: draft7e });
    };
    for (const lateral of laterals) attempt([lateral]);
    if (laterals.length === 2) attempt(laterals);
    if (configs.length === 0) configs.push(...lShapes(model, kept7e, nodes, nodes7e, link, ends, laterals));
    if (configs.length === 0) continue;
    // Fewer lateral ports, then no growth, then the lower end (the deeper tier), then document order.
    const key = (config: Config): number[] => [config.laterals.length, Number(config.grows), -tierOf(config.laterals[0]!.ref), order.get(config.laterals[0]!.ref.node)!];
    configs.sort((a, b) => { const x = key(a), y = key(b), at = x.findIndex((value, index) => value !== y[index]); return at < 0 ? 0 : x[at]! - y[at]!; });
    const best = configs[0]!;
    nodes = best.nodes; nodes7e = best.nodes7e;
    for (const lateral of best.laterals) {
      offer.hints.set(lateral.key, lateral.side);
      offer.promised.set(lateral.key, best.shape === 'L' ? { link: link.id, bends: 1, shape: 'L' } : { link: link.id, bends: 0, shape: 'straight' });
    }
  }
  // The routed chord shape (ticket 117): its own pass over the routed links. It probes on the kept 7e model (placement decides a chord, 7f holds it) and
  // reads "bent now" on the baseline; each accepted hint is applied to both clones.
  const chords = measureChordSides(kept7e, nodes7e, nodes, refused, moved, MIN_OUTWARD, refusedKey, link => plannedBends(model, model.links.find(item => item.id === link.id) ?? link, blockers), probes, probeCap);
  for (const [key, side] of chords.hints) offer.hints.set(key, side);
  for (const [key, item] of chords.promised) offer.promised.set(key, item);
  offer.capped ||= chords.capped;
  // The routed L through a side lane (ticket 119): a third pass on the same two clones.
  const taken = new Set([...offer.hints.keys()]);
  // A chord wins over a lane: a side lane stands as a wall in the corridor at 7a and can cost a chord its hold at 7e, so a batch that holds a chord hint holds no lane hint.
  const lanes = chords.hints.size > 0 ? { hints: new Map<string, 'left' | 'right'>(), promised: new Map<string, { link: string; bends: 1; shape: 'lane' }>(), probes: chords.probes, capped: false, nodes: chords.nodes, base: chords.base }
    : measureLaneSides(kept7e, chords.nodes, chords.base, refused, taken, moved, refusedKey, link => plannedBends(model, model.links.find(item => item.id === link.id) ?? link, blockers), chords.probes, probeCap);
  for (const [key, side] of lanes.hints) offer.hints.set(key, side);
  for (const [key, item] of lanes.promised) offer.promised.set(key, item);
  offer.capped ||= lanes.capped;
  offer.probes = { base: lanes.base, kept7e: lanes.nodes };
  return offer;
}
