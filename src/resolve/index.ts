import {
  createLayoutModel, orderedGroupIds, orderedNodeIds,
  type Diagnostic, type Endpoint, type Layer, type LayoutLink, type LayoutModel,
  type NormalisedDocument, type Owner, type PortRef,
} from '../model/index.js';

export interface ResolveOptions {
  /** Pass parseWithDiagnostics().diagnostics here at the orchestrator boundary. */
  diagnostics?: readonly Diagnostic[];
}

export class ResolveError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(diagnostics.filter(diagnostic => diagnostic.severity === 'error').map(diagnostic => diagnostic.message).join('\n'));
    this.name = 'ResolveError';
  }
}

function report(model: LayoutModel, code: string, message: string, owners: Owner[], severity: Diagnostic['severity'] = 'error'): void {
  model.diagnostics.push({ stage: 'model', severity, code, message, owners });
}

function stopOnErrors(model: LayoutModel): void {
  if (model.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new ResolveError(model.diagnostics);
}

function family(linkClass: string | undefined): Layer {
  return linkClass === 'flow' || linkClass === 'sync' ? 'overlay' : 'routed';
}

function orderedPair(a: string, b: string, order: Map<string, number>): [string, string] {
  return order.get(a)! <= order.get(b)! ? [a, b] : [b, a];
}

function endpointNodes(model: LayoutModel, endpoint: Endpoint): string[] {
  return endpoint.group === undefined ? [endpoint.node] : model.groups[endpoint.group]!.nodes;
}

/** Check Cartesian expansion counts before allocating any generated ports or links. */
function validateExpansion(model: LayoutModel): void {
  const counts = new Map(orderedNodeIds(model.document).map(id => [id, model.nodes[id]!.ports.length]));
  let linkCount = 0;
  for (const link of model.links) {
    const from = endpointNodes(model, link.from);
    const to = endpointNodes(model, link.to);
    if (!from.length || !to.length) report(model, 'EMPTY_GROUP_ENDPOINT', 'Cannot expand an empty group endpoint', [link.owner]);
    if (model.document.links[link.sourceIndex]!.route === 'group-link'
      && (link.from.group === undefined || link.to.group === undefined || link.from.group === link.to.group || from.length < 2 || to.length < 2)) {
      report(model, 'GROUP_LINK_MEMBERSHIP', 'group-link requires two distinct groups with at least two nodes each', [link.owner]);
    }
    linkCount += from.length * to.length;
    if (link.from.group !== undefined) for (const id of from) counts.set(id, counts.get(id)! + to.length);
    if (link.to.group !== undefined) for (const id of to) counts.set(id, counts.get(id)! + from.length);
  }
  if (linkCount > 10 * counts.size) report(model, 'LINK_LIMIT', 'Expanded links must not exceed 10 times the node count', []);
  for (const [id, count] of counts) if (count > 20) {
    report(model, 'PORT_LIMIT', `Node ${id} must not exceed 20 ports, including generated anonymous ports`, [{ kind: 'node', id }]);
  }
  stopOnErrors(model);
}

function anonymousPort(model: LayoutModel, nodeId: string): PortRef {
  const node = model.nodes[nodeId]!;
  const ordinal = node.ports.reduce((max, port) => port.ref.anonymous ? Math.max(max, port.ref.ordinal) : max, 0) + 1;
  const ref: PortRef = { node: nodeId, anonymous: true, ordinal };
  node.ports.push({ ref: { ...ref }, owner: { kind: 'node', id: nodeId }, layer: 'routed' });
  return ref;
}

function unsupported(model: LayoutModel, sourceIndex: number, technique: 'stub' | 'group-link', owners: Owner[]): void {
  // The parser reports explicit fallbacks already. Preserve its source path and avoid a duplicate.
  const path = `$.links[${sourceIndex}].route`;
  if (model.diagnostics.some(diagnostic => diagnostic.code === 'ROUTE_UNSUPPORTED'
    && 'path' in diagnostic && diagnostic.path === path)) return;
  report(model, 'ROUTE_UNSUPPORTED', `M1 falls back to routed for ${technique}`, owners, 'warning');
}

interface Aggregation {
  groups: [string, string];
  members: LayoutLink[];
}

function expandEndpoints(model: LayoutModel, groupOrder: Map<string, number>): Aggregation[] {
  const expanded: LayoutLink[] = [];
  const aggregations: Aggregation[] = [];
  for (const link of model.links) {
    const authored = model.document.links[link.sourceIndex]!;
    link.family = family(authored.class);
    link.layer = authored.route === undefined ? link.family : authored.route === 'overlay' ? 'overlay' : 'routed';
    if (authored.route !== undefined) link.technique = authored.route;
    else if (link.family === 'overlay') link.technique = 'overlay';
    if (authored.route === 'stub' || authored.route === 'group-link') {
      link.technique = 'orthogonal';
    }
    if (link.from.group === undefined && link.to.group === undefined) {
      link.attachments = { from: { ...link.from }, to: { ...link.to } };
      expanded.push(link);
      if (authored.route === 'stub') unsupported(model, link.sourceIndex, authored.route, [link.owner]);
      continue;
    }
    const from = endpointNodes(model, link.from);
    const to = endpointNodes(model, link.to);
    const isGroupLink = link.from.group !== undefined && link.to.group !== undefined
      && link.from.group !== link.to.group && from.length >= 2 && to.length >= 2
      && (authored.route === undefined || authored.route === 'group-link');
    if (authored.route === undefined) {
      link.layer = 'routed';
      link.technique = 'orthogonal';
    }
    const members: LayoutLink[] = [];
    for (const fromId of from) for (const toId of to) {
      const id = `${link.id}-${members.length + 1}`;
      const member: LayoutLink = {
        ...link, id, owner: { kind: 'link', id }, from: { ...link.from }, to: { ...link.to },
        attachments: {
          from: link.from.group === undefined ? { ...link.from } : anonymousPort(model, fromId),
          to: link.to.group === undefined ? { ...link.to } : anonymousPort(model, toId),
        },
      };
      members.push(member);
      expanded.push(member);
    }
    const owners = members.map(member => member.owner);
    if (isGroupLink || authored.route === 'stub') unsupported(model, link.sourceIndex, authored.route === 'stub' ? 'stub' : 'group-link', owners);
    if (!isGroupLink) report(model, 'GROUP_ENDPOINT_EXPANDED', 'Expanded group endpoint into concrete port attachments', owners, 'warning');
    if (isGroupLink) aggregations.push({ groups: orderedPair(link.from.group!, link.to.group!, groupOrder), members });
  }
  model.links = expanded;
  return aggregations;
}

function portKey(port: PortRef): string {
  return JSON.stringify([port.node, port.anonymous === true, port.name ?? null, port.ordinal]);
}

/** Expanded link IDs, rather than authored indices, determine actual port use and node degree. */
function warnAttachmentUsage(model: LayoutModel): void {
  const warnedPorts = new Set<string>();
  const warnedNodes = new Set<string>();
  for (const diagnostic of model.diagnostics) {
    if (!('path' in diagnostic) || typeof diagnostic.path !== 'string') continue;
    if (diagnostic.code === 'SHARED_PORT') {
      const match = /^\$\.links\[(\d+)\]\.(from|to)$/.exec(diagnostic.path);
      if (match) {
        const authored = model.document.links[Number(match[1])];
        const endpoint = match[2] === 'from' ? authored?.from : authored?.to;
        if (endpoint?.node !== undefined) warnedPorts.add(portKey(endpoint));
      }
    }
    if (diagnostic.code === 'HIGH_DEGREE' && diagnostic.path.startsWith('$.nodes.')) {
      warnedNodes.add(diagnostic.path.slice('$.nodes.'.length));
    }
  }
  const ports = new Map<string, { port: PortRef; links: Set<string> }>();
  const nodes = new Map<string, Set<string>>();
  for (const link of model.links) for (const port of [link.attachments!.from, link.attachments!.to]) {
    const key = portKey(port);
    const usage = ports.get(key) ?? { port, links: new Set<string>() };
    usage.links.add(link.id);
    ports.set(key, usage);
    const degree = nodes.get(port.node) ?? new Set<string>();
    degree.add(link.id);
    nodes.set(port.node, degree);
  }
  for (const [key, { port, links }] of ports) if (links.size > 1 && !warnedPorts.has(key)) {
    const owners: Owner[] = [...links].map(id => ({ kind: 'link', id }));
    report(model, 'SHARED_PORT', `${links.size} links share port ${port.node}.${port.name ?? 'anonymous'}#${port.ordinal}`, owners, 'warning');
  }
  for (const [id, links] of nodes) if (links.size > 64 && !warnedNodes.has(id)) {
    report(model, 'HIGH_DEGREE', `Node ${id} degree ${links.size} exceeds 64`, [{ kind: 'node', id }], 'warning');
  }
}

function findAggregations(model: LayoutModel, groupOrder: Map<string, number>): Aggregation[] {
  const candidates = new Map<string, Aggregation>();
  for (const link of model.links) {
    const from = model.document.nodes[link.attachments!.from.node]!.group;
    const to = model.document.nodes[link.attachments!.to.node]!.group;
    if (from === to) continue;
    const groups = orderedPair(from, to, groupOrder);
    const key = JSON.stringify(groups);
    const candidate = candidates.get(key) ?? { groups, members: [] };
    candidate.members.push(link);
    candidates.set(key, candidate);
  }
  return [...candidates.values()].filter(({ groups: [from, to], members }) => {
    const fromCount = model.groups[from]!.nodes.length;
    const toCount = model.groups[to]!.nodes.length;
    if (fromCount < 2 || toCount < 2 || members.length !== fromCount * toCount) return false;
    const first = model.document.links[members[0]!.sourceIndex]!;
    const pairs = new Set<string>();
    for (const link of members) {
      const authored = model.document.links[link.sourceIndex]!;
      if (authored.route !== undefined || authored.class !== first.class || link.family !== members[0]!.family
        || link.from.group !== undefined || link.to.group !== undefined) return false;
      const ends = link.attachments!;
      const pair = model.document.nodes[ends.from.node]!.group === from
        ? [ends.from.node, ends.to.node] : [ends.to.node, ends.from.node];
      pairs.add(JSON.stringify(pair));
    }
    return pairs.size === fromCount * toCount;
  });
}

function recordAggregations(model: LayoutModel, aggregations: Aggregation[]): void {
  // Records follow the first originating link, including explicit expansions and inferred sets.
  aggregations.sort((a, b) => a.members[0]!.sourceIndex - b.members[0]!.sourceIndex);
  for (const { groups, members } of aggregations) {
    const id = `group-link-${model.groupLinks.length + 1}`;
    model.groupLinks.push({ id, groups, members: members.map(link => link.id), owner: { kind: 'group-link', id }, layer: 'routed' });
    for (const link of members) {
      link.groupLink = id;
      link.layer = 'routed';
      link.technique = 'orthogonal';
    }
    if (members[0]!.from.group === undefined) {
      unsupported(model, members[0]!.sourceIndex, 'group-link', members.map(link => link.owner));
    }
  }
}

function groupBundles(model: LayoutModel): void {
  const nodeOrder = new Map(orderedNodeIds(model.document).map((id, index) => [id, index]));
  const candidates = new Map<string, { nodes: [string, string]; members: LayoutLink[] }>();
  for (const link of model.links) {
    const route = model.document.links[link.sourceIndex]!.route;
    if (link.layer !== 'routed' || route === 'straight' || route === 'orthogonal' || route === 'overlay') continue;
    const ends = link.attachments!;
    const nodes = orderedPair(ends.from.node, ends.to.node, nodeOrder);
    const key = JSON.stringify(nodes);
    const candidate = candidates.get(key) ?? { nodes, members: [] };
    candidate.members.push(link);
    candidates.set(key, candidate);
  }
  for (const { nodes, members } of candidates.values()) {
    if (members.length < 2) continue;
    const id = `bundle-${model.bundles.length + 1}`;
    model.bundles.push({ id, nodes, members: members.map(link => link.id), owner: { kind: 'bundle', id }, layer: 'routed' });
    for (const link of members) {
      link.bundle = id;
      if (link.technique !== 'merge') link.technique = 'bundle';
    }
  }
  for (const link of model.links) if (link.technique === 'merge' && link.bundle === undefined) {
    report(model, 'MERGE_REQUIRES_BUNDLE', `route: merge on ${link.id} requires membership in a bundle of at least two links`, [link.owner]);
  }
}

/** Resolve document semantics without placement, paths or geometry-dependent route choices. */
export function resolve(input: NormalisedDocument, options: ResolveOptions = {}): LayoutModel {
  const model = createLayoutModel(input);
  model.diagnostics = JSON.parse(JSON.stringify(options.diagnostics ?? []));
  if (input.profile !== 'network') report(model, 'UNSUPPORTED_PROFILE', `M1 does not support profile ${input.profile}`, []);
  stopOnErrors(model);
  const groupOrder = new Map(orderedGroupIds(model.document).map((id, index) => [id, index]));
  for (const id of groupOrder.keys()) {
    const group = model.groups[id]!;
    if (group.flank !== undefined) group.tier = model.groups[group.flank.of]!.tier!;
  }
  validateExpansion(model);
  const explicit = expandEndpoints(model, groupOrder);
  warnAttachmentUsage(model);
  recordAggregations(model, [...explicit, ...findAggregations(model, groupOrder)]);
  groupBundles(model);
  stopOnErrors(model);
  model.stage = 'resolve';
  return model;
}
