import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { PortRef } from '../model/document.js';
import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { orderedGroupIds } from '../model/model.js';
import { naturalSideOf } from './port-side.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';

export const SKELETON_SPACING = { padding: 12, tierGap: 60, nodeClearance: 20 } as const;
export const groupId = (id: string): string => `group:${id}`;
export const nodeId = (id: string): string => `node:${id}`;
/** Plain printable ASCII without a quote or a backslash: `JSON.stringify` returns such a string unchanged between quotes. */
const PLAIN = /^[ !#-[\]-~]*$/;
const quoted = (text: string): string => PLAIN.test(text) ? `"${text}"` : JSON.stringify(text);
/** The key of a port, byte-identical to the JSON of `[node, anonymous, name, ordinal]` and built without serializing an array. */
export const portId = (ref: PortRef): string => {
  const ordinal = ref.ordinal;
  if (typeof ordinal !== 'number' || !Number.isFinite(ordinal)) return `port:${JSON.stringify([ref.node, ref.anonymous === true, ref.name ?? null, ordinal])}`;
  return `port:[${quoted(ref.node)},${ref.anonymous === true},${ref.name == null ? 'null' : quoted(ref.name)},${ordinal}]`;
};
export function nodeGap(model: LayoutModel, a: string, b: string): number {
  return SKELETON_SPACING.nodeClearance
    + ((model.nodes[a]!.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) + (model.nodes[b]!.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2;
}
/**
 * The horizontal spacing between units: sibling columns, grid columns, flanks, rows of a grid and ELK's layer spacing. One number for
 * the whole diagram, from the node clearance and the widest stroke. The vertical seat of a tier gap is `tierGapMin` (architecture-2
 * ticket 57); today the two are equal.
 */
export function bandGap(model: LayoutModel): number {
  const maxStroke = Math.max(DEFAULT_STROKE_WIDTHS.node, ...Object.values(model.nodes).map(node => node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node));
  return Math.max(SKELETON_SPACING.tierGap, SKELETON_SPACING.nodeClearance + maxStroke);
}

/**
 * The least height of a tier gap, body to body: stage 4 and stage 6 seat every band this far under the band above, and it is the
 * floor of the tier-gap plan (`gap-plan.ts`). The reservations of a gap (its bands, its parts, its link labels) raise a gap above it,
 * never below (architecture-2 ticket 57). Split from `bandGap`, which keeps every horizontal use; the value is the same today.
 */
export function tierGapMin(model: LayoutModel): number {
  const maxStroke = Math.max(DEFAULT_STROKE_WIDTHS.node, ...Object.values(model.nodes).map(node => node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node));
  return Math.max(SKELETON_SPACING.tierGap, SKELETON_SPACING.nodeClearance + maxStroke);
}
export function peerCounts(model: LayoutModel, group: LayoutGroup): Map<string, number> {
  const counts = new Map<string, number>();
  for (const link of model.links) {
    const ends = link.attachments!;
    for (const [from, to] of [[ends.from, ends.to], [ends.to, ends.from]] as const) {
      if (model.document.nodes[from.node]!.group === group.id && model.document.nodes[to.node]!.group === group.flank!.of) {
        counts.set(to.node, (counts.get(to.node) ?? 0) + 1);
      }
    }
  }
  return counts;
}
export function greatestPeers(model: LayoutModel, group: LayoutGroup): string[] {
  const counts = peerCounts(model, group);
  const greatest = Math.max(0, ...counts.values());
  return model.groups[group.flank!.of]!.nodes.filter(id => (counts.get(id) ?? 0) === greatest);
}
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export { compareId };

/** Select declaration-order proxies before graph construction, including fallback graphs. */
export function selectProxyPeers(model: LayoutModel): void {
  for (const id of orderedGroupIds(model.document)) {
    const group = model.groups[id]!;
    if (!group.flank) continue;
    const order = model.groups[group.flank.of]!.nodes;
    const candidates = greatestPeers(model, group);
    candidates.sort((a, b) => (group.flank!.align === 'left' ? 1 : -1) * (order.indexOf(a) - order.indexOf(b)) || compareId(a, b));
    if (candidates[0] !== undefined) group.flank.proxyPeer = candidates[0];
  }
}

/** Flank groups and every incident link stay out of the skeleton. They are placed by rule. */
export function buildSkeletonGraph(model: LayoutModel, tier?: number): ElkNode {
  selectProxyPeers(model);
  const groups = orderedGroupIds(model.document).map(id => model.groups[id]!)
    .filter(group => !group.flank && (tier === undefined || group.tier === tier));
  const nodes = new Set(groups.flatMap(group => group.nodes));
  const maxStroke = Math.max(DEFAULT_STROKE_WIDTHS.node, ...[...nodes].map(id => model.nodes[id]!.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node));
  const spacing = String(SKELETON_SPACING.nodeClearance + maxStroke);
  const options = {
    'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.partitioning.activate': tier === undefined ? 'true' : 'false',
    'elk.layered.crossingMinimization.semiInteractive': 'true',
    'elk.json.shapeCoords': 'ROOT', 'elk.json.edgeCoords': 'ROOT', 'elk.randomSeed': '1',
    'elk.spacing.nodeNode': spacing, 'elk.layered.spacing.nodeNodeBetweenLayers': String(bandGap(model)),
    'elk.padding': `[top=${SKELETON_SPACING.padding},left=${SKELETON_SPACING.padding},bottom=${SKELETON_SPACING.padding},right=${SKELETON_SPACING.padding}]`,
  };
  return {
    id: 'root', layoutOptions: options,
    children: groups.map(group => {
      let order = [...group.nodes];
      for (const flank of Object.values(model.groups)) {
        if (flank.flank?.of !== group.id || flank.flank.proxyPeer === undefined) continue;
        const peer = flank.flank.proxyPeer;
        order = order.filter(id => id !== peer);
        if (flank.flank.align === 'left') order.unshift(peer); else order.push(peer);
      }
      return {
        id: groupId(group.id), width: 2 * SKELETON_SPACING.padding, height: 2 * SKELETON_SPACING.padding,
        layoutOptions: { ...options, 'elk.partitioning.partition': String(group.tier),
          // SIMPLE keeps proxy positions distinct across internal layers of flank-facing rows.
          ...(Object.values(model.groups).some(flank => flank.flank?.of === group.id)
            ? { 'elk.layered.nodePlacement.strategy': 'SIMPLE' } : {}),
        },
        children: group.nodes.map(id => {
          const node = model.nodes[id]!;
          if (!node.size) throw new Error(`Skeleton requires measured size for ${id}`);
          const sideNames = { top: 'NORTH', right: 'EAST', bottom: 'SOUTH', left: 'WEST' } as const;
          return {
            id: nodeId(id), width: node.size.width, height: node.size.height,
            layoutOptions: {
              'elk.portConstraints': 'FIXED_SIDE', 'elk.nodeSize.constraints': '[MINIMUM_SIZE, PORTS]',
              'elk.nodeSize.minimum': `[${node.size.width}, ${node.size.height}]`,
              'elk.position': `[${order.indexOf(id) * 100}, 0]`,
              'elk.spacing.portPort': String(Math.max(12, ...Object.values(node.sidePitch ?? {}))),
            },
            ports: node.ports.map(port => ({ id: portId(port.ref), width: 0, height: 0,
              layoutOptions: { 'elk.port.side': sideNames[naturalSideOf(port)!] } })),
          };
        }),
      };
    }),
    edges: model.links.filter(link => link.meshBus === undefined && nodes.has(link.attachments!.from.node) && nodes.has(link.attachments!.to.node))
      .map(link => ({ id: link.id, sources: [portId(link.attachments!.from)], targets: [portId(link.attachments!.to)] })),
  };
}
