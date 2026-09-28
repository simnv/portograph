import {
  createLayoutModel, groupNodeIds, orderedGroupIds, orderedNodeIds, unsupportedMessage,
  type Diagnostic, type Endpoint, type Layer, type LayoutLink, type LayoutModel,
  type NormalisedDocument, type Owner, type PortRef,
} from '../model/index.js';
import { enclosedBundle } from '../layout/grid.js';
import { expandRankedGroups } from '../layout/rank-cells.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';

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

/**
 * The author's `weight` is a line-weight multiplier on the theme's base path stroke. It is resolved
 * here, in stage 1, so every rule that reserves stroke-aware space during placement — bundle pitch,
 * lane width, label bands, the G6 clearances — sees the real width before any path exists, and the
 * scorer and the renderer read the same number. The shared default is left implicit.
 */
function strokeWidth(weight: number | undefined): number | undefined {
  if (weight === undefined) return undefined;
  const width = DEFAULT_STROKE_WIDTHS.path * weight;
  if (!Number.isFinite(width) || width < 0) throw new Error('Link weight must produce a finite, nonnegative stroke width');
  return width === DEFAULT_STROKE_WIDTHS.path ? undefined : width;
}

function orderedPair(a: string, b: string, order: Map<string, number>): [string, string] {
  return order.get(a)! <= order.get(b)! ? [a, b] : [b, a];
}

function endpointNodes(model: LayoutModel, endpoint: Endpoint): string[] {
  return endpoint.group === undefined ? [endpoint.node] : groupNodeIds(model, endpoint.group);
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
  // The same work bound as the parser, restated after expansion (ADR-0006). A Cartesian endpoint
  // can cross it where the authored counts did not, and it warns for the same reason: it bounds
  // work, it does not define a legal document. Only the node count refuses without --force.
  if (linkCount > 10 * counts.size) {
    report(model, 'LINK_LIMIT', `Expanded links (${linkCount}) exceed 10 times the node count; continuing best effort`, [], 'warning');
  }
  for (const [id, count] of counts) if (count > 20) {
    report(model, 'PORT_LIMIT', `Node ${id} has ${count} ports after expansion, above the 20 that bound work; continuing best effort`, [{ kind: 'node', id }], 'warning');
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
  report(model, 'ROUTE_UNSUPPORTED', unsupportedMessage(technique), owners, 'warning');
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
    // `overlay` names a layer, and every other routed technique implies one. `group-link` names an
    // aggregation — how many lines stand for the set — and decides nothing about which layer they
    // are drawn on, so the class's family still does (Q30: overrides → aggregation, and aggregation
    // is not a layer decision). `stub` is a visibility decision and keeps its M1 routed fallback.
    link.layer = authored.route === undefined || authored.route === 'group-link' ? link.family
      : authored.route === 'overlay' ? 'overlay' : 'routed';
    const width = strokeWidth(authored.weight);
    if (width !== undefined) link.strokeWidth = width;
    if (authored.route !== undefined) link.technique = authored.route;
    else if (link.family === 'overlay') link.technique = 'overlay';
    if (authored.route === 'stub' || authored.route === 'group-link') {
      link.technique = link.layer === 'overlay' ? 'overlay' : 'orthogonal';
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
    // Expanding a group endpoint multiplies the line, it does not change what the line is: an
    // overlay-family member keeps its layer and its derived path. A routed one takes the M1
    // orthogonal fallback rather than a geometry-selected technique.
    if (authored.route === undefined && link.layer === 'routed') {
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
    // A group-link is one line standing for the whole set, so it is drawn on the set's own layer:
    // a set of overlay members is an overlay group-link. Aggregation decides how many lines are
    // drawn, never on which layer — the class chose that, and only an authored `route:` moves it.
    //
    // That "the set's own layer" is single-valued is an eligibility invariant, not an arithmetic
    // one: `findAggregations` refuses a set whose members differ in class or family, and an
    // explicit group-link expands one authored link. Loosening eligibility — to admit a member
    // carrying `route: overlay` because overrides win, say — would otherwise record a routed
    // group-link over overlay members, the exact contradiction this rule exists to remove. State
    // it here so the next change to eligibility fails loudly instead of drawing the wrong layer.
    const layer: Layer | undefined = members[0]!.layer;
    if (layer === undefined || members.some(link => link.layer !== layer)) {
      throw new Error(`Group-link ${id} aggregates members that do not share one settled layer`);
    }
    model.groupLinks.push({ id, groups, members: members.map(link => link.id), owner: { kind: 'group-link', id }, layer });
    for (const link of members) {
      link.groupLink = id;
      if (link.layer === 'overlay') continue;
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
  // The authored side of a port, or `*` for one the engine will choose. A bundle's members must
  // leave each shared node on one side — parallel runs cannot start on two sides of one box — so
  // links between one node pair whose authored sides differ at either node form separate cohorts
  // (ticket 35). Engine-chosen sides are decided from the same peers and land together.
  const authoredSide = (ref: PortRef): string => model.nodes[ref.node]!.ports
    .find(port => port.ref.name === ref.name && port.ref.ordinal === ref.ordinal && port.ref.anonymous === ref.anonymous)?.side ?? '*';
  // Per node pair: how many links it has and which side cohorts they fell into, built in one pass.
  const pairs = new Map<string, { nodes: [string, string]; count: number; cohorts: Set<string> }>();
  for (const link of model.links) {
    const route = model.document.links[link.sourceIndex]!.route;
    if (link.layer !== 'routed' || route === 'straight' || route === 'orthogonal' || route === 'overlay') continue;
    const ends = link.attachments!;
    const nodes = orderedPair(ends.from.node, ends.to.node, nodeOrder);
    const ordered = nodes[0] === ends.from.node ? [ends.from, ends.to] : [ends.to, ends.from];
    const key = JSON.stringify([nodes, authoredSide(ordered[0]!), authoredSide(ordered[1]!)]);
    const candidate = candidates.get(key) ?? { nodes, members: [] };
    candidate.members.push(link);
    candidates.set(key, candidate);
    const pairKey = JSON.stringify(nodes), pair = pairs.get(pairKey) ?? { nodes, count: 0, cohorts: new Set<string>() };
    pair.count++; pair.cohorts.add(key); pairs.set(pairKey, pair);
  }
  for (const { nodes, count, cohorts } of pairs.values()) {
    if (count < 2) continue;
    const single = [...cohorts].map(key => candidates.get(key)!).filter(candidate => candidate.members.length < 2).flatMap(candidate => candidate.members);
    if (!single.length) continue;
    report(model, 'BUNDLE_MIXED_SIDES', `${single.map(link => link.id).join(', ')} between ${nodes[0]} and ${nodes[1]} attach on a different side of a shared node than the other links of the pair; left out of the bundle`, single.map(link => link.owner), 'warning');
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

/**
 * Say, once and in the model, where a group's authored shape is declined because the group holds
 * both ends of a bundle whose channel a stacked arrangement cannot promise (`enclosedBundle`). The
 * shape is read back through `groupShape`, which asks that same question of the same document, so
 * the diagnostic and the geometry cannot disagree — this reports the answer, it does not decide it.
 *
 * Stage 1 reads a layout module here. That is the wrong way round for the layering, and it is
 * deliberate: the predicate has exactly one definition, and `grid.ts` is where the shape rules
 * live. `grid.ts` imports nothing from `resolve`, so there is no cycle; if one ever appears, move
 * the predicate to `model/` rather than copying it.
 */
function declineStackedShapes(model: LayoutModel): void {
  for (const id of orderedGroupIds(model.document)) {
    if (model.document.groups[id]!.shape !== 'grid') continue;
    const bundle = enclosedBundle(model, id);
    if (!bundle) continue;
    report(model, 'GROUP_SHAPE_DECLINED', `${id} keeps the row shape instead of grid: it holds both ends of ${bundle.id}, between ${bundle.nodes[0]} and ${bundle.nodes[1]}, and a stacked arrangement gives that bundle's channel no room`,
      [{ kind: 'group', id }, bundle.owner], 'warning');
  }
}

/**
 * Everything stage 1 does except the expansion of ranked groups: the model of the document as
 * written. The rank derivation reads this model, and only this one, because it needs the links
 * resolved and the groups still whole.
 */
export function resolveBeforeExpansion(input: NormalisedDocument, options: ResolveOptions = {}): LayoutModel {
  const model = createLayoutModel(input);
  model.diagnostics = JSON.parse(JSON.stringify(options.diagnostics ?? []));
  if (input.profile !== 'network') report(model, 'UNSUPPORTED_PROFILE', `M1 does not support profile ${input.profile}`, []);
  stopOnErrors(model);
  const groupOrder = new Map(orderedGroupIds(model.document).map((id, index) => [id, index]));
  for (const id of groupOrder.keys()) {
    const group = model.groups[id]!;
    if (group.flank !== undefined) group.tier = model.groups[group.flank.of]!.tier!;
  }
  // A frame stands where its first cell stands, so a link between two frames orders like their cells.
  for (const [frame, { cells }] of Object.entries(model.document.frames ?? {})) {
    const first = Math.min(...cells.map(cell => groupOrder.get(cell) ?? Infinity));
    if (!groupOrder.has(frame) && Number.isFinite(first)) groupOrder.set(frame, first);
  }
  validateExpansion(model);
  const explicit = expandEndpoints(model, groupOrder);
  warnAttachmentUsage(model);
  recordAggregations(model, [...explicit, ...findAggregations(model, groupOrder)]);
  groupBundles(model);
  declineStackedShapes(model);
  stopOnErrors(model);
  model.stage = 'resolve';
  return model;
}

/**
 * Stage 1: document semantics without placement, paths or geometry-dependent route choices, then the
 * expansion of ranked groups into rank cells (docs/design/ranked-groups.md, section 2). The expanded
 * document is resolved again from the top, so the model is the product of its own document: resolving
 * `model.document` reproduces it, which `mutation.ts` relies on.
 */
export function resolve(input: NormalisedDocument, options: ResolveOptions = {}): LayoutModel {
  const model = resolveBeforeExpansion(input, options);
  const expanded = expandRankedGroups(model);
  return expanded === undefined ? model : resolveBeforeExpansion(expanded, options);
}
