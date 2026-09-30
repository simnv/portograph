import type { PortRef } from '../model/document.js';
import type { Lane, LayoutLink, LayoutModel, LayoutNode } from '../model/layout.js';
import { facingSide, hintRefusal } from './side-hints.js';
import { portKey } from './sides-one.js';
import { probeSideLane, sideLaneCandidate } from './lanes.js';
import type { ChordLateral, MovePort } from './side-chords.js';

/**
 * The routed L of the side measure (docs/design/side-faces.md, Sections 5, 6 and 10; ticket 119): a routed link that is stepped now (two bends or
 * more planned on the baseline) and would be one turn with a lateral port at ONE end: the far port's drop, the side lane at the far port's x, and the
 * side run into the lateral face. It is `measureSides`' third pass. It probes on the kept 7e model, because placement decides a lane (7a) and holds
 * it (7c, 7f); "bent now" is read on the baseline. The probe is 7a's own corridor test at the far port's x (`probeSideLane`): the source-aligned
 * lane only, since an exterior corridor would give three bends and the trial keeps a hint only when the lane is source-aligned.
 */

export interface LanePass {
  nodes: LayoutModel['nodes'];
  /** The baseline clone with every accepted hint applied in its own coordinates (side-faces.md, Section 19.2). */
  base: LayoutModel['nodes'];
  hints: Map<string, 'left' | 'right'>;
  promised: Map<string, { link: string; bends: 1; shape: 'lane' }>;
  probes: number;
  capped: boolean;
}

/** Test only: the side probe of ticket 119 reads every decision of the lane pass through `on`. Nothing in the layout reads it. */
export const laneTrace: { on?: (event: Record<string, unknown>) => void } = {};

export function measureLaneSides(model: LayoutModel, nodes: LayoutModel['nodes'], base: LayoutModel['nodes'], refused: ReadonlySet<string>, taken: ReadonlySet<string>,
  moved: MovePort, refusedKey: (key: string, side: string) => string, bends: (link: LayoutLink) => number, probes: number, probeCap: number): LanePass {
  const pass: LanePass = { nodes, base, hints: new Map(), promised: new Map(), probes, capped: false };
  const order = new Map(Object.keys(model.document.nodes).map((id, index) => [id, index]));
  const tierOf = (ref: PortRef): number => model.groups[model.document.nodes[ref.node]!.group]!.tier!;
  const centreOf = (node: LayoutNode): { x: number; y: number } => ({ x: node.bounds!.x + node.bounds!.width / 2, y: node.bounds!.y + node.bounds!.height / 2 });
  const lanes: Lane[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.attachments === undefined || link.removed === true) continue;
    if (bends(link) < 2) { laneTrace.on?.({ ev: 'skip', link: link.id, why: 'fewer than two planned bends on the baseline' }); continue; }
    const ends = [link.attachments.from, link.attachments.to];
    // A link with a hinted end (an overlay, a chord or an earlier lane of this round or a kept trial) is decided.
    if (ends.some(ref => taken.has(portKey(ref)) || pass.nodes[ref.node]?.ports.some(port => portKey(port.ref) === portKey(ref) && port.sideHint === true))) continue;
    if (ends[0]!.node === ends[1]!.node || tierOf(ends[0]!) === tierOf(ends[1]!)) continue;
    const configs: { lateral: ChordLateral; nodes: LayoutModel['nodes']; lane: Lane }[] = [];
    for (const [index, ref] of ends.entries()) {
      const peer = ends[1 - index]!, node = pass.nodes[ref.node]!, key = portKey(ref);
      const port = node.ports.find(item => portKey(item.ref) === key);
      if (port === undefined || port.sideHint === true || (port.side !== 'top' && port.side !== 'bottom') || taken.has(key)) continue;
      if (hintRefusal(model, ref) !== undefined || node.bounds === undefined || pass.nodes[peer.node]?.bounds === undefined) continue;
      const side = facingSide(centreOf(node).x, centreOf(pass.nodes[peer.node]!).x) as 'left' | 'right';
      if (refused.has(refusedKey(key, side))) continue;
      const lateral: ChordLateral = { ref, key, side };
      const result = moved(node, lateral, centreOf(pass.nodes[peer.node]!).y);
      if (result === undefined) { laneTrace.on?.({ ev: 'attempt', link: link.id, port: key, offered: false, why: 'no slot on the lateral face' }); continue; }
      const draft = { ...pass.nodes, [ref.node]: { ...result.node, ports: result.node.ports.map(item => portKey(item.ref) === key ? { ...item, sideHint: true as const, laneHint: true as const } : item) } };
      const probe: LayoutModel = { ...model, nodes: draft };
      if (probes >= probeCap) { pass.capped = true; break; }
      if (sideLaneCandidate(probe, link) === undefined || portKey(sideLaneCandidate(probe, link)!) !== key) {
        laneTrace.on?.({ ev: 'attempt', link: link.id, port: key, offered: false, why: 'not a side lane candidate with this face' }); continue;
      }
      const lane = probeSideLane(probe, link, ref, lanes);
      if (lane === undefined) { laneTrace.on?.({ ev: 'attempt', link: link.id, port: key, offered: false, why: 'the source-aligned corridor is not clear' }); continue; }
      laneTrace.on?.({ ev: 'attempt', link: link.id, port: key, offered: true, why: 'candidate configuration', x: lane.x });
      configs.push({ lateral, nodes: draft, lane });
    }
    if (pass.capped) break;
    if (configs.length === 0) continue;
    pass.probes++;
    probes = pass.probes;
    // The lower end (the deeper tier) first, then document order: the drop runs from the upper port, as in Section 5.
    configs.sort((a, b) => (tierOf(b.lateral.ref) - tierOf(a.lateral.ref)) || (order.get(a.lateral.ref.node)! - order.get(b.lateral.ref.node)!));
    const best = configs[0]!;
    pass.nodes = best.nodes;
    lanes.push(best.lane);
    // The same hint on the baseline clone, in its coordinates; a node with no box or no slot there keeps its ports.
    const peer = ends.find(ref => portKey(ref) !== best.lateral.key)!;
    const node = pass.base[best.lateral.ref.node], peerBox = pass.base[peer.node]?.bounds;
    const result = node?.bounds !== undefined && peerBox !== undefined ? moved(node, best.lateral, centreOf(pass.base[peer.node]!).y) : undefined;
    if (result !== undefined) pass.base = { ...pass.base, [best.lateral.ref.node]: { ...result.node, ports: result.node.ports.map(port => portKey(port.ref) === best.lateral.key ? { ...port, sideHint: true as const, laneHint: true as const } : port) } };
    pass.hints.set(best.lateral.key, best.lateral.side);
    pass.promised.set(best.lateral.key, { link: link.id, bends: 1, shape: 'lane' });
  }
  return pass;
}
