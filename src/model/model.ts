import type { NormalisedDocument, NormalisedPort, PortRef } from './document.js';
import type { LayoutGroup, LayoutModel, LayoutNode, LayoutPort } from './layout.js';

/**
 * What M1 really does with a technique it records but does not apply. A `stub` becomes a drawn line
 * again, so it falls back to routed. A `group-link` is drawn as its members, each on the layer its
 * own family chose — aggregation says how many lines stand for the set, never which layer draws
 * them (stress ticket 23) — so naming a layer here would be wrong for an overlay set.
 */
export function unsupportedMessage(technique: 'stub' | 'group-link'): string {
  return technique === 'stub' ? 'M1 falls back to routed for stub' : 'M1 draws the members for group-link';
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => {
    if (typeof field === 'number' && !Number.isFinite(field)) {
      throw new Error('Layout JSON requires finite numbers');
    }
    return field;
  }, 2);
}

function portReference(node: string, port: NormalisedPort): PortRef {
  return port.anonymous
    ? { node, anonymous: true, ordinal: port.ordinal }
    : { node, name: port.name, ordinal: port.ordinal };
}

function orderedIds(map: Record<string, unknown>, order: string[] | undefined, field: string): string[] {
  const keys = Object.keys(map);
  if (order === undefined) return keys;
  if (order.length !== keys.length || new Set(order).size !== keys.length
    || order.some(id => !Object.hasOwn(map, id))) {
    throw new Error(`${field} must be a permutation of the map's own IDs`);
  }
  return [...order];
}

/** Read group declaration order, validating explicit normalization metadata when present. */
export function orderedGroupIds(document: NormalisedDocument): string[] {
  return orderedIds(document.groups, document.groupOrder, 'groupOrder');
}

/** Read node declaration order, validating explicit normalization metadata when present. */
export function orderedNodeIds(document: NormalisedDocument): string[] {
  return orderedIds(document.nodes, document.nodeOrder, 'nodeOrder');
}

/**
 * The nodes of a group as a link endpoint names it. A group that stage 1 replaced by rank cells is no
 * longer in `groups`; its frame (`document.frames`) lists its cells and the cells of its children.
 */
export function groupNodeIds(model: LayoutModel, id: string): string[] {
  const group = model.groups[id];
  if (group !== undefined) return group.nodes;
  const cells = Object.entries(model.document.frames ?? {}).filter(([frame, item]) => frame === id || item.parent === id).flatMap(([, item]) => item.cells);
  const nodes = new Set(cells.flatMap(cell => model.groups[cell]?.nodes ?? []));
  return orderedNodeIds(model.document).filter(node => nodes.has(node));
}

/** Wrap validated stage-0 output without performing resolution or placement. */
export function createLayoutModel(input: NormalisedDocument): LayoutModel {
  const document: NormalisedDocument = JSON.parse(serialize(input));
  const groups = Object.fromEntries(orderedGroupIds(document).map(id => {
    const group = document.groups[id];
    if (group === undefined) throw new Error(`Missing group ${id}`);
    const layoutGroup: LayoutGroup = {
      id, owner: { kind: 'group', id }, layer: 'routed', nodes: [],
    };
    if (group.tier !== undefined) layoutGroup.tier = group.tier;
    if (group.frame !== undefined) layoutGroup.frame = group.frame;
    if (group.align !== undefined) layoutGroup.flank = { align: group.align, of: group.of };
    return [id, layoutGroup];
  }));
  const nodes = Object.fromEntries(orderedNodeIds(document).map(id => {
    const node = document.nodes[id];
    if (node === undefined) throw new Error(`Missing node ${id}`);
    const ports = node.ports.map(port => {
      const layoutPort: LayoutPort = {
        ref: portReference(id, port), owner: { kind: 'node', id }, layer: 'routed',
      };
      if (port.class !== undefined) layoutPort.class = port.class;
      if (port.side !== undefined) layoutPort.side = port.side;
      if (port.order !== undefined) layoutPort.authorOrder = port.order;
      return layoutPort;
    });
    const layoutNode: LayoutNode = { id, owner: { kind: 'group', id: node.group }, layer: 'routed', ports };
    if (node.size !== undefined) layoutNode.sizeFloor = { ...node.size };
    const group = groups[node.group];
    if (!Object.hasOwn(groups, node.group) || group === undefined) {
      throw new Error(`Node ${id} references missing group ${node.group}`);
    }
    group.nodes.push(id);
    return [id, layoutNode];
  }));
  return {
    document, stage: 'normalised', groups, nodes,
    links: document.links.map((link, sourceIndex) => ({
      id: `link-${sourceIndex + 1}`, sourceIndex,
      owner: { kind: 'link', id: `link-${sourceIndex + 1}` },
      from: { ...link.from }, to: { ...link.to },
    })),
    tierBands: [], regions: [], labels: [], lanes: [], bundles: [], junctions: [],
    labelBands: [], barDrops: [], groupLinks: [], obstacles: [], diagnostics: [],
    runtime: { stages: [] },
  };
}

/** Preserve declaration order, optional-field omission and the full runtime block. */
export function serializeLayoutModel(model: LayoutModel): string {
  return serialize(model);
}

/** Snapshot only reproducible model data; timings remain available in full layout JSON. */
export function serializeLayoutSnapshot(model: LayoutModel): string {
  const { runtime: _runtime, ...snapshot } = model;
  void _runtime;
  return serialize(snapshot);
}
