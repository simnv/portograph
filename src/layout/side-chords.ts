import type { PortRef } from '../model/document.js';
import type { LayoutLink, LayoutModel, LayoutNode, PathSegment } from '../model/layout.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import { EPS, intersection, samePoint, segmentDistance } from '../score/geometry.js';
import { chordKind, chordVerdict, isRoutedChord, SIDE_EDGE_SLACK } from './frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from './row-paths.js';
import { facingSide, hintRefusal } from './side-hints.js';
import { portKey } from './sides-one.js';

/**
 * The routed chord shape of the side measure (docs/design/side-faces.md, Sections 5 and 9): a routed link that is no chord now, and would be
 * one straight segment with a lateral port at one or both ends. It is `measureSides`' second pass and reads the same probe model.
 */

/** A lateral port of the probe: the port, its key and the side it would take. */
export interface ChordLateral { ref: PortRef; key: string; side: 'left' | 'right' }
/** Moves a port to a lateral face on a copy of its node (`moved` of the side measure). Undefined when no slot fits. */
export type MovePort = (node: LayoutNode, lateral: ChordLateral, peerY: number) => { node: LayoutNode; grows: boolean } | undefined;

interface Accepted { node: string; side: string; segment: PathSegment; stroke: number }
interface Config { laterals: ChordLateral[]; grows: boolean; nodes: LayoutModel['nodes']; segment: PathSegment }

export interface ChordPass {
  nodes: LayoutModel['nodes'];
  hints: Map<string, 'left' | 'right'>;
  promised: Map<string, { link: string; bends: 0; shape: 'straight' }>;
  probes: number;
  capped: boolean;
}

/**
 * Whether the lateral chord from one face stands closer than the chord clearance to an accepted chord on the same face (`pitch`, spec Section 8):
 * two chords from one lateral face are not spread in the first version, so the second is refused. A strict crossing is excused, as G6 excuses it.
 */
export function tooClose(segment: PathSegment, stroke: number, other: Accepted): boolean {
  const point = intersection(segment, other.segment);
  if (point !== undefined && ![segment.from, segment.to, other.segment.from, other.segment.to].some(end => samePoint(end, point))) return false;
  return segmentDistance(segment, other.segment) - (stroke + other.stroke) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS;
}

/**
 * The lateral sides that would make a routed link one straight chord. Candidates are routed links that hold no chord now (a frame chord blocked at
 * its bottom face, a cross-frame chord refused for its edge), in link order. Each is probed with the lateral side at the upper end, at the lower end
 * and at both; the probe is `chordVerdict` on the moved ends (with `SIDE_EDGE_SLACK` at a side edge) and the minimum outward angle. The ranking is
 * the overlay's: fewer lateral ports, no node growth, the lower end, document order. An accepted configuration is applied to the probe nodes before
 * the next link is read. `nodes` is the probe node map on entry (it may hold overlay hints) and on return.
 */
export function measureChordSides(model: LayoutModel, nodes: LayoutModel['nodes'], refused: ReadonlySet<string>, moved: MovePort, minOutward: number,
  refusedKey: (key: string, side: string) => string, bends: (link: LayoutLink) => number, probes: number, probeCap: number): ChordPass {
  const pass: ChordPass = { nodes, hints: new Map(), promised: new Map(), probes, capped: false };
  const order = new Map(Object.keys(model.document.nodes).map((id, index) => [id, index]));
  const tierOf = (ref: PortRef): number => model.groups[model.document.nodes[ref.node]!.group]!.tier!;
  const centreOf = (node: LayoutNode): { x: number; y: number } => ({ x: node.bounds!.x + node.bounds!.width / 2, y: node.bounds!.y + node.bounds!.height / 2 });
  const accepted: Accepted[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.attachments === undefined || link.removed === true || isRoutedChord(model, link) || bends(link) === 0) continue;
    const ends = [link.attachments.from, link.attachments.to];
    if (ends[0]!.node === ends[1]!.node || tierOf(ends[0]!) === tierOf(ends[1]!)) continue;
    const laterals: ChordLateral[] = [];
    for (const [index, ref] of ends.entries()) {
      const peer = ends[1 - index]!, node = pass.nodes[ref.node]!, key = portKey(ref);
      const port = node.ports.find(item => portKey(item.ref) === key);
      if (port === undefined || port.sideHint === true || (port.side !== 'top' && port.side !== 'bottom')) continue;
      if (hintRefusal(model, ref) !== undefined || node.bounds === undefined || pass.nodes[peer.node]?.bounds === undefined) continue;
      const side = facingSide(centreOf(node).x, centreOf(pass.nodes[peer.node]!).x) as 'left' | 'right';
      if (refused.has(refusedKey(key, side))) continue;
      laterals.push({ ref, key, side });
    }
    if (laterals.length === 0) continue;
    if (pass.probes >= probeCap) { pass.capped = true; break; }
    pass.probes++;
    const configs: Config[] = [];
    const attempt = (chosen: ChordLateral[]): void => {
      let draft = pass.nodes, grows = false;
      for (const lateral of chosen) {
        const peer = ends.find(ref => portKey(ref) !== lateral.key)!;
        const result = moved(draft[lateral.ref.node]!, lateral, centreOf(draft[peer.node]!).y);
        if (result === undefined) return;
        // A hinted port: the chord rule reads a lateral face only on a port a hint moved.
        const node: LayoutNode = { ...result.node, ports: result.node.ports.map(port => portKey(port.ref) === lateral.key ? { ...port, sideHint: true } : port) };
        draft = { ...draft, [lateral.ref.node]: node };
        grows ||= result.grows;
      }
      const probe: LayoutModel = { ...model, nodes: draft };
      if (chordKind(probe, link) === undefined) return;
      const verdict = chordVerdict(probe, link, SIDE_EDGE_SLACK);
      if (!('segment' in verdict)) return;
      const segment = verdict.segment, stroke = linkStrokeWidth(link);
      const length = Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
      if (length <= EPS) return;
      for (const lateral of chosen) {
        const dx = portKey(ends[0]!) === lateral.key ? segment.to.x - segment.from.x : segment.from.x - segment.to.x;
        if (dx * (lateral.side === 'right' ? 1 : -1) / length < minOutward - EPS) return;
        if (accepted.some(other => other.node === lateral.ref.node && other.side === lateral.side && tooClose(segment, stroke, other))) return;
      }
      configs.push({ laterals: chosen, grows, nodes: draft, segment });
    };
    for (const lateral of laterals) attempt([lateral]);
    if (laterals.length === 2) attempt(laterals);
    if (configs.length === 0) continue;
    const key = (config: Config): number[] => [config.laterals.length, Number(config.grows), -tierOf(config.laterals[0]!.ref), order.get(config.laterals[0]!.ref.node)!];
    configs.sort((a, b) => { const x = key(a), y = key(b), at = x.findIndex((value, index) => value !== y[index]); return at < 0 ? 0 : x[at]! - y[at]!; });
    const best = configs[0]!;
    pass.nodes = best.nodes;
    for (const lateral of best.laterals) {
      pass.hints.set(lateral.key, lateral.side);
      pass.promised.set(lateral.key, { link: link.id, bends: 0, shape: 'straight' });
      accepted.push({ node: lateral.ref.node, side: lateral.side, segment: best.segment, stroke: linkStrokeWidth(link) });
    }
  }
  return pass;
}
