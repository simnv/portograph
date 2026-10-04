import type { PortRef } from '../model/document.js';
import type { LayoutLink, LayoutModel, LayoutNode, PathSegment } from '../model/layout.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import { EPS, intersection, samePoint, segmentDistance } from '../score/geometry.js';
import { chordKind, chordVerdict, edgeMisses, fixedPointRefusal, isRoutedChord, SIDE_EDGE_SLACK } from './frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from './row-paths.js';
import { straightChord } from './overlay-paths.js';
import { findPort } from './row-paths.js';
import { facingSide, hintRefusal } from './side-hints.js';
import { portKey } from './sides-one.js';
import { nodeTier } from './read/tier.js';

/**
 * The routed chord shape of the side measure (docs/design/side-faces.md, Sections 5 and 9): a routed link that is no chord now, and would be
 * one straight segment with a lateral port at one or both ends. It is `measureSides`' second pass and reads the same probe model.
 */

/** A lateral port of the probe: the port, its key and the side it would take. */
export interface ChordLateral { ref: PortRef; key: string; side: 'left' | 'right' }
/** Moves a port to a lateral face on a copy of its node (`moved` of the side measure). Undefined when no slot fits. */
export type MovePort = (node: LayoutNode, lateral: ChordLateral, peerY: number) => { node: LayoutNode; grows: boolean } | undefined;

const findPortSide = (model: LayoutModel, ref: PortRef): string | undefined => findPort(model, ref)?.side;

/** Test only: the side probe of ticket 117 sets `on` to read every decision of the chord pass. Nothing in the layout reads it. */
export const chordTrace: { on?: (event: Record<string, unknown>) => void } = {};

export interface Accepted { node: string; side: string; segment: PathSegment; stroke: number }
interface Config { laterals: ChordLateral[]; grows: boolean; nodes: LayoutModel['nodes']; segment: PathSegment }

export interface ChordPass {
  nodes: LayoutModel['nodes'];
  /** The baseline clone with every accepted hint applied in its own coordinates (side-faces.md, Section 19.2). */
  base: LayoutModel['nodes'];
  hints: Map<string, 'left' | 'right'>;
  promised: Map<string, { link: string; bends: 0; shape: 'straight' }>;
  probes: number;
  capped: boolean;
}

/**
 * Whether a chord stands closer than the chord clearance to a chord accepted earlier in the pass, on any node or face (`pitch`, spec Section 8, and review M2):
 * lateral faces are not spread in the first version, and two near-parallel chords would both be lost at 7e. A strict crossing is excused, as G6 excuses it.
 */
export function tooClose(segment: PathSegment, stroke: number, other: Accepted): boolean {
  const point = intersection(segment, other.segment);
  if (point !== undefined && ![segment.from, segment.to, other.segment.from, other.segment.to].some(end => samePoint(end, point))) return false;
  return segmentDistance(segment, other.segment) - (stroke + other.stroke) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS;
}

/** Whether a chord is too close to any chord accepted earlier in the pass, on any node or face (review M2, ticket 117). */
export function pitchRefused(segment: PathSegment, stroke: number, accepted: readonly Accepted[]): boolean {
  return accepted.some(other => tooClose(segment, stroke, other));
}

/**
 * The lateral sides that would make a routed link one straight chord. Candidates are routed links that hold no chord now (a frame chord blocked at
 * its bottom face, a cross-frame chord refused for its edge), in link order. Each is probed with the lateral side at the upper end, at the lower end
 * and at both; the probe is `chordVerdict` on the moved ends (with `SIDE_EDGE_SLACK` at a side edge) and the minimum outward angle. The ranking is
 * the overlay's: fewer lateral ports, no node growth, the lower end, document order. An accepted configuration is applied to the probe nodes before
 * the next link is read. `nodes` is the probe node map on entry (it may hold overlay hints) and on return.
 */
export function measureChordSides(model: LayoutModel, nodes: LayoutModel['nodes'], base: LayoutModel['nodes'], refused: ReadonlySet<string>, moved: MovePort, minOutward: number,
  refusedKey: (key: string, side: string) => string, bends: (link: LayoutLink) => number, probes: number, probeCap: number): ChordPass {
  const pass: ChordPass = { nodes, base, hints: new Map(), promised: new Map(), probes, capped: false };
  const order = new Map(Object.keys(model.document.nodes).map((id, index) => [id, index]));
  const tierOf = (ref: PortRef): number => nodeTier(model, ref.node);
  const centreOf = (node: LayoutNode): { x: number; y: number } => ({ x: node.bounds!.x + node.bounds!.width / 2, y: node.bounds!.y + node.bounds!.height / 2 });
  const accepted: Accepted[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.attachments === undefined || link.removed === true) continue;
    if (isRoutedChord(model, link) || bends(link) === 0) { chordTrace.on?.({ ev: 'skip', link: link.id, why: isRoutedChord(model, link) ? 'a held chord' : 'no planned bends on the baseline' }); continue; }
    const ends = [link.attachments.from, link.attachments.to];
    if (ends[0]!.node === ends[1]!.node || tierOf(ends[0]!) === tierOf(ends[1]!)) { chordTrace.on?.({ ev: 'skip', link: link.id, why: 'one node or one sub-tier' }); continue; }
    const laterals: ChordLateral[] = [];
    const rejects: string[] = [];
    for (const [index, ref] of ends.entries()) {
      const peer = ends[1 - index]!, node = pass.nodes[ref.node]!, key = portKey(ref);
      const port = node.ports.find(item => portKey(item.ref) === key);
      if (port === undefined || port.sideHint === true || (port.side !== 'top' && port.side !== 'bottom')) { rejects.push(`${ref.node} end: port side ${port?.side}${port?.sideHint === true ? ' (hinted)' : ''}, no lateral candidate`); continue; }
      const why = hintRefusal(model, ref);
      if (why !== undefined || node.bounds === undefined || pass.nodes[peer.node]?.bounds === undefined) { rejects.push(`${ref.node} end: ${why ?? 'no box'}`); continue; }
      const side = facingSide(centreOf(node).x, centreOf(pass.nodes[peer.node]!).x) as 'left' | 'right';
      if (refused.has(refusedKey(key, side))) { rejects.push(`${ref.node} end: ${side} refused earlier`); continue; }
      laterals.push({ ref, key, side });
    }
    if (chordTrace.on !== undefined) {
      const first = chordVerdict(model, link, SIDE_EDGE_SLACK);
      chordTrace.on({ ev: 'link', link: link.id, ends: ends.map(ref => `${ref.node}#${ref.ordinal} ${findPortSide(model, ref)}`), kind: chordKind(model, link) ?? 'not a candidate at the natural faces',
        verdict: 'reason' in first ? first.reason : 'segment', rejects });
    }
    if (laterals.length === 0) continue;
    if (pass.probes >= probeCap) { pass.capped = true; chordTrace.on?.({ ev: 'capped', link: link.id }); break; }
    pass.probes++;
    const configs: Config[] = [];
    const attempt = (chosen: ChordLateral[]): void => {
      const name = chosen.map(l => `${l.ref.node}:${l.side}`).join(' + ');
      const note = (why: string, extra: Record<string, unknown> = {}): void => { chordTrace.on?.({ ev: 'attempt', link: link.id, config: name, offered: false, why, ...extra }); };
      let draft = pass.nodes, grows = false;
      for (const lateral of chosen) {
        const peer = ends.find(ref => portKey(ref) !== lateral.key)!;
        const result = moved(draft[lateral.ref.node]!, lateral, centreOf(draft[peer.node]!).y);
        if (result === undefined) { note('no slot on the lateral face'); return; }
        // A hinted port: the chord rule reads a lateral face only on a port a hint moved.
        const node: LayoutNode = { ...result.node, ports: result.node.ports.map(port => portKey(port.ref) === lateral.key ? { ...port, sideHint: true } : port) };
        draft = { ...draft, [lateral.ref.node]: node };
        grows ||= result.grows;
      }
      const probe: LayoutModel = { ...model, nodes: draft };
      if (chordKind(probe, link) === undefined) { note('chordKind is undefined with these faces'); return; }
      const verdict = chordVerdict(probe, link, SIDE_EDGE_SLACK);
      // The raw chord, for the exit-edge miss, whatever the verdict says.
      const raw = chordTrace.on === undefined ? undefined : straightChord(probe, link, undefined, true);
      const misses = raw === undefined ? [] : edgeMisses(probe, link, { from: raw.from, to: raw.to, owner: { ...link.owner } }).map(m => `${m.box}/${m.side}: ${m.miss === Infinity ? 'no crossing' : `${m.miss.toFixed(1)} px`}`);
      if (!('segment' in verdict)) { note(`chordVerdict refuses: ${verdict.reason}`, { verdict: verdict.reason, misses }); return; }
      const segment = verdict.segment, stroke = linkStrokeWidth(link);
      // Placement holds a chord only when the fixed point of `rebuildRowPaths` does (`expectedFramePath`): the chords already held and the legs of the links that
      // stay orthogonal keep their clearance from it, and its own title fits. A chord that fails there is never held at 7e, so the hint would give no gain.
      const held = fixedPointRefusal(probe, link, { ...segment, straight: true });
      if (held !== undefined) { note(`the fixed point of placement would refuse it: ${held}`, { verdict: 'segment', misses }); return; }
      const length = Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
      if (length <= EPS) { note('zero length', { misses }); return; }
      const angles: string[] = [];
      for (const lateral of chosen) {
        const dx = portKey(ends[0]!) === lateral.key ? segment.to.x - segment.from.x : segment.from.x - segment.to.x;
        const outward = dx * (lateral.side === 'right' ? 1 : -1) / length;
        angles.push(`${lateral.ref.node}: ${(Math.asin(Math.max(-1, Math.min(1, outward))) * 180 / Math.PI).toFixed(1)} deg`);
        if (outward < minOutward - EPS) { note('outward angle under the minimum', { verdict: 'segment', angles, misses }); return; }
      }
      // Every chord accepted earlier in the pass, on any node or face: two near-parallel chords would both be lost at 7e (review M2, ticket 117).
      if (pitchRefused(segment, stroke, accepted)) { note('pitch', { verdict: 'segment', angles, pitch: 'refused', misses }); return; }
      chordTrace.on?.({ ev: 'attempt', link: link.id, config: name, offered: true, why: 'candidate configuration', verdict: 'segment', angles, pitch: 'ok', misses });
      configs.push({ laterals: chosen, grows, nodes: draft, segment });
    };
    for (const lateral of laterals) attempt([lateral]);
    if (laterals.length === 2) attempt(laterals);
    if (configs.length === 0) { chordTrace.on?.({ ev: 'none', link: link.id }); continue; }
    const key = (config: Config): number[] => [config.laterals.length, Number(config.grows), -tierOf(config.laterals[0]!.ref), order.get(config.laterals[0]!.ref.node)!];
    configs.sort((a, b) => { const x = key(a), y = key(b), at = x.findIndex((value, index) => value !== y[index]); return at < 0 ? 0 : x[at]! - y[at]!; });
    const best = configs[0]!;
    pass.nodes = best.nodes;
    // The same hints on the baseline clone, in its coordinates; a node with no box or no slot there keeps its ports.
    for (const lateral of best.laterals) {
      const peer = ends.find(ref => portKey(ref) !== lateral.key)!;
      const node = pass.base[lateral.ref.node], peerBox = pass.base[peer.node]?.bounds;
      const result = node?.bounds !== undefined && peerBox !== undefined ? moved(node, lateral, centreOf(pass.base[peer.node]!).y) : undefined;
      if (result !== undefined) pass.base = { ...pass.base, [lateral.ref.node]: { ...result.node, ports: result.node.ports.map(port => portKey(port.ref) === lateral.key ? { ...port, sideHint: true } : port) } };
    }
    for (const lateral of best.laterals) {
      pass.hints.set(lateral.key, lateral.side);
      pass.promised.set(lateral.key, { link: link.id, bends: 0, shape: 'straight' });
      accepted.push({ node: lateral.ref.node, side: lateral.side, segment: best.segment, stroke: linkStrokeWidth(link) });
    }
  }
  chordTrace.on?.({ ev: 'summary', probesIn: probes, probesOut: pass.probes, cap: probeCap, capped: pass.capped });
  return pass;
}
