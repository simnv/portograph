import type { Endpoint, GroupContent, NormalisedDocument, NormalisedLink, NormalisedNode, NormalisedPort, Side } from '../model/index.js';
import { orderedGroupIds, orderedNodeIds } from '../model/index.js';
import { filterCss } from './css.js';
import { own, ParseError, put, Validation } from './validation.js';
import type { SourceDiagnostic } from './validation.js';

export { ParseError } from './validation.js';
export type { SourceDiagnostic } from './validation.js';

export interface ParseOptions {
  /** Overrides the >1000 node refusal only (ADR-0006). */
  force?: boolean;
  onDiagnostic?: (diagnostic: SourceDiagnostic) => void;
}

export type ParseResult =
  | { ok: true; document: NormalisedDocument; diagnostics: SourceDiagnostic[] }
  | { ok: false; diagnostics: SourceDiagnostic[] };

const sides = ['top', 'right', 'bottom', 'left'] as const;
const routes = ['orthogonal', 'straight', 'bundle', 'merge', 'overlay', 'stub', 'group-link'] as const;

function optionalStrings<T extends object, K extends keyof T & string>(input: Map<string, unknown>, output: T, keys: readonly K[], path: string, v: Validation): void {
  for (const key of keys) if (input.has(key)) {
    const value = v.string(input.get(key), `${path}.${key}`);
    if (value !== undefined) Object.assign(output, { [key]: value });
  }
}

function groups(input: Map<string, unknown>, doc: NormalisedDocument, v: Validation): Map<string, number | undefined> {
  const ranks = new Map<string, number | undefined>();
  for (const [id, value] of input) {
    const path = `$.groups.${id}`;
    if (v.identifier(id, path) === undefined) continue;
    const fields = v.map(value, path);
    v.keys(fields, ['tier', 'align', 'of', 'label', 'shape', 'class', 'collapsed', 'layout'], path);
    const content: GroupContent = { label: id, shape: 'row' };
    optionalStrings(fields, content, ['label', 'class'], path, v);
    if (fields.has('shape')) {
      const shape = v.choice(fields.get('shape'), ['row', 'bar', 'grid', 'ring', 'free'], `${path}.shape`);
      if (shape === 'row' || shape === 'bar') content.shape = shape;
      else if (shape !== undefined) v.report('UNSUPPORTED_SHAPE', `${path}.shape`, `M1 does not support ${shape} groups`);
    }
    if (fields.has('collapsed')) {
      if (typeof fields.get('collapsed') !== 'boolean') v.report('INVALID_TYPE', `${path}.collapsed`, 'Expected a boolean');
      else v.report('COLLAPSED_UNSUPPORTED', `${path}.collapsed`, 'M1 ignores collapsed', 'warning', 'model');
    }
    if (fields.has('layout')) {
      const layout: Record<string, string | number | boolean> = {};
      for (const [key, option] of v.map(fields.get('layout'), `${path}.layout`)) {
        if (typeof option === 'string' || typeof option === 'boolean' || (typeof option === 'number' && Number.isFinite(option))) put(layout, key, option);
        else v.report('INVALID_TYPE', `${path}.layout.${key}`, 'Expected an ELK scalar option');
      }
      content.layout = layout;
    }
    const rank = fields.has('tier') ? v.number(fields.get('tier'), `${path}.tier`, true, 0) : undefined;
    if (fields.has('align')) {
      if (fields.has('tier')) v.report('TIER_ALIGN_CONFLICT', path, 'tier and align are mutually exclusive');
      const align = v.choice(fields.get('align'), ['left', 'right'], `${path}.align`);
      if (!fields.has('of')) v.report('FLANK_OF_REQUIRED', `${path}.of`, 'A flank requires of');
      const target = fields.has('of') ? v.identifier(fields.get('of'), `${path}.of`) : undefined;
      if (align !== undefined && target !== undefined) put(doc.groups, id, { ...content, align, of: target });
    } else {
      if (fields.has('of')) v.report('OF_WITHOUT_ALIGN', `${path}.of`, 'of requires align');
      put(doc.groups, id, { ...content, tier: rank ?? 0 });
      ranks.set(id, rank);
    }
  }
  const occupied = new Set<string>();
  for (const [id, group] of Object.entries(doc.groups)) if (group.align !== undefined) {
    const target = own(doc.groups, group.of);
    if (target === undefined) v.report('UNKNOWN_REFERENCE', `$.groups.${id}.of`, `Unknown group ${group.of}`);
    else if (group.of === id || target.align !== undefined) v.report('FLANK_OF_TIER', `$.groups.${id}.of`, 'of must name another tier group');
    const key = `${group.of}.${group.align}`;
    if (occupied.has(key)) v.report('DUPLICATE_FLANK', `$.groups.${id}.align`, 'Only one flank per side of a tier group is allowed');
    occupied.add(key);
  }
  return ranks;
}

function ports(value: unknown, path: string, v: Validation): NormalisedPort[] {
  let list = value;
  let listPath = path;
  let inherited: Side | undefined;
  if (value instanceof Map) {
    const fields = v.map(value, path);
    v.keys(fields, ['side', 'list'], path);
    if (fields.has('side')) inherited = v.choice(fields.get('side'), sides, `${path}.side`);
    list = fields.get('list');
    listPath = `${path}.list`;
  }
  const count = new Map<string, number>();
  const result: NormalisedPort[] = [];
  for (const [index, item] of v.list(list, listPath).entries()) {
    const itemPath = `${listPath}[${index}]`;
    const fields = typeof item === 'string' ? new Map<string, unknown>([['name', item]]) : v.map(item, itemPath);
    v.keys(fields, ['name', 'side', 'order'], itemPath);
    const name = v.identifier(fields.get('name'), `${itemPath}.name`);
    const side = fields.has('side') ? v.choice(fields.get('side'), sides, `${itemPath}.side`) : inherited;
    const order = fields.has('order') ? v.number(fields.get('order'), `${itemPath}.order`, true) : undefined;
    if (name === undefined) continue;
    const ordinal = (count.get(name) ?? 0) + 1;
    count.set(name, ordinal);
    const port: NormalisedPort = { name, ordinal };
    if (side !== undefined) port.side = side;
    if (order !== undefined) port.order = order;
    result.push(port);
  }
  return result;
}

function nodes(input: Map<string, unknown>, doc: NormalisedDocument, v: Validation): void {
  for (const [id, value] of input) {
    const path = `$.nodes.${id}`;
    if (v.identifier(id, path) === undefined) continue;
    if (own(doc.groups, id) !== undefined) v.report('NAMESPACE_COLLISION', path, `${id} names both a node and a group`);
    const fields = v.map(value, path);
    v.keys(fields, ['group', 'class', 'label', 'description', 'icon', 'ports', 'size'], path);
    if (!fields.has('group')) v.report('NODE_GROUP_REQUIRED', `${path}.group`, 'A node requires group');
    const group = fields.has('group') ? v.identifier(fields.get('group'), `${path}.group`) : undefined;
    if (group === undefined) continue;
    if (own(doc.groups, group) === undefined) v.report('UNKNOWN_REFERENCE', `${path}.group`, `Unknown group ${group}`);
    const node: NormalisedNode = { group, label: id, ports: fields.has('ports') ? ports(fields.get('ports'), `${path}.ports`, v) : [] };
    optionalStrings(fields, node, ['label', 'class', 'description', 'icon'], path, v);
    if (fields.has('size')) {
      const size = v.map(fields.get('size'), `${path}.size`);
      v.keys(size, ['width', 'height'], `${path}.size`);
      const width = v.number(size.get('width'), `${path}.size.width`, false, 0);
      const height = v.number(size.get('height'), `${path}.size.height`, false, 0);
      if (width !== undefined && height !== undefined) node.size = { width, height };
    }
    put(doc.nodes, id, node);
  }
}

function inferTiers(doc: NormalisedDocument, ranks: Map<string, number | undefined>, v: Validation): void {
  const top: string[] = [], middle: string[] = [], bottom: string[] = [];
  const explicit = new Map<number, string[]>();
  const classes = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const id of orderedNodeIds(doc)) {
    const node = own(doc.nodes, id);
    if (!node) continue;
    counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
    const set = classes.get(node.group) ?? new Set<string>();
    if (node.class !== undefined) set.add(node.class);
    classes.set(node.group, set);
  }
  for (const id of orderedGroupIds(doc)) {
    const group = own(doc.groups, id);
    if (!group || group.align !== undefined) continue;
    const rank = ranks.get(id);
    if (rank !== undefined) { explicit.set(rank, [...(explicit.get(rank) ?? []), id]); continue; }
    const set = classes.get(id) ?? new Set<string>();
    const hasTop = ['provider', 'internet', 'wan'].some(c => set.has(c));
    const hasBottom = ['backbone', 'core'].some(c => set.has(c));
    if (hasTop && hasBottom) v.report('MIXED_TIER_CLASSES', `$.groups.${id}`, 'Mixed top and bottom classes infer a middle tier', 'warning', 'model');
    const category = hasTop && !hasBottom ? top : hasBottom && !hasTop ? bottom : middle;
    category.push(id);
  }
  const bands = [top, ...[...explicit.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids), ...middle.map(id => [id]), bottom].filter(ids => ids.length);
  bands.forEach((ids, tier) => {
    for (const id of ids) {
      const group = own(doc.groups, id);
      if (!group || group.align !== undefined) continue;
      group.tier = tier;
      if (ranks.get(id) === undefined) v.report('TIER_INFERRED', `$.groups.${id}.tier`, `Inferred effective tier ${tier}`, 'info', 'model');
    }
    const flankIds = orderedGroupIds(doc).filter(id => { const group = own(doc.groups, id); return group?.of !== undefined && ids.includes(group.of); });
    if (![...ids, ...flankIds].some(id => (counts.get(id) ?? 0) > 0)) v.report('EMPTY_TIER', `$.groups.${ids[0] ?? ''}`, `Tier ${tier} has no nodes`, 'warning', 'model');
  });
}

function endpoint(value: unknown, path: string, doc: NormalisedDocument, used: Map<NormalisedPort, Set<number>>, index: number, v: Validation): Endpoint | undefined {
  let nodeId: string | undefined, name: string | undefined, ordinal: number | undefined;
  if (typeof value === 'string') {
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\.([A-Za-z0-9][A-Za-z0-9_-]*|\*)(?:#([1-9][0-9]*))?)?$/.exec(value);
    if (!match) { v.report('BAD_ENDPOINT', path, 'Invalid compact endpoint'); return undefined; }
    nodeId = match[1]; name = match[2];
    if (match[3] !== undefined) ordinal = Number(match[3]);
    if (nodeId !== undefined && name === undefined && own(doc.groups, nodeId) !== undefined) return { group: nodeId };
  } else {
    const fields = v.map(value, path);
    v.keys(fields, ['node', 'port', 'ordinal', 'group'], path);
    if (fields.has('group')) {
      if (fields.has('node') || fields.has('port') || fields.has('ordinal')) { v.report('BAD_ENDPOINT', path, 'A group endpoint has only group'); return undefined; }
      const id = v.identifier(fields.get('group'), `${path}.group`);
      if (id === undefined) return undefined;
      if (own(doc.groups, id) === undefined) { v.report('UNKNOWN_REFERENCE', path, `Unknown group ${id}`); return undefined; }
      return { group: id };
    }
    nodeId = v.identifier(fields.get('node'), `${path}.node`);
    if (fields.has('port')) name = fields.get('port') === '*' ? '*' : v.identifier(fields.get('port'), `${path}.port`);
    if (fields.has('ordinal')) ordinal = v.number(fields.get('ordinal'), `${path}.ordinal`, true, 1);
  }
  if (ordinal !== undefined && (name === undefined || name === '*' || !Number.isSafeInteger(ordinal))) {
    v.report('BAD_ENDPOINT', path, 'ordinal requires a named port and a positive safe integer'); return undefined;
  }
  if (nodeId === undefined) return undefined;
  const node = own(doc.nodes, nodeId);
  if (!node) { v.report('UNKNOWN_REFERENCE', path, `Unknown node ${nodeId}`); return undefined; }
  let port: NormalisedPort | undefined;
  if (name === '*') port = node.ports.find(p => !used.has(p));
  else if (name !== undefined) {
    const named = node.ports.filter(p => p.name === name);
    port = ordinal === undefined ? named.find(p => !used.has(p)) ?? named[0] : named.find(p => p.ordinal === ordinal);
    if (!port) { v.report('UNKNOWN_REFERENCE', path, `Unknown port ${nodeId}.${name}${ordinal === undefined ? '' : `#${ordinal}`}`); return undefined; }
  }
  if (!port) {
    if (name === '*' && node.ports.some(p => p.name !== undefined)) v.report('WILDCARD_ANONYMOUS', path, `No free named ports on ${nodeId}; created an anonymous port`, 'warning', 'model');
    port = { anonymous: true, ordinal: node.ports.filter(p => p.anonymous).length + 1 };
    node.ports.push(port);
  }
  const links = used.get(port) ?? new Set<number>();
  if (!links.has(index) && links.size > 0) v.report('SHARED_PORT', path, `More than one link shares a port on ${nodeId}`, 'warning', 'model');
  links.add(index); used.set(port, links);
  return port.anonymous ? { node: nodeId, anonymous: true, ordinal: port.ordinal } : { node: nodeId, name: port.name, ordinal: port.ordinal };
}

function links(value: unknown, doc: NormalisedDocument, v: Validation): void {
  const used = new Map<NormalisedPort, Set<number>>();
  for (const [index, item] of v.list(value, '$.links').entries()) {
    const path = `$.links[${index}]`;
    let fields: Map<string, unknown>, fromValue: unknown, toValue: unknown;
    if (Array.isArray(item)) {
      if (item.length < 2 || item.length > 3) v.report('LINK_ENDPOINTS', path, 'Expected two endpoints and optional options');
      fromValue = item[0]; toValue = item[1];
      fields = item.length > 2 ? v.map(item[2], `${path}.options`) : new Map<string, unknown>();
      v.keys(fields, ['class', 'label', 'route', 'weight'], path);
    } else {
      fields = v.map(item, path);
      v.keys(fields, ['from', 'to', 'class', 'label', 'route', 'weight'], path);
      if (!fields.has('from') || !fields.has('to')) v.report('LINK_ENDPOINTS', path, 'Expected from and to endpoints');
      fromValue = fields.get('from'); toValue = fields.get('to');
    }
    const from = endpoint(fromValue, `${path}.from`, doc, used, index, v);
    const to = endpoint(toValue, `${path}.to`, doc, used, index, v);
    const options: Partial<NormalisedLink> = {};
    optionalStrings(fields, options, ['class', 'label'], path, v);
    if (fields.has('route')) {
      const route = v.choice(fields.get('route'), routes, `${path}.route`);
      if (route !== undefined) options.route = route;
      if (route === 'group-link' && (from?.group === undefined || to?.group === undefined)) v.report('GROUP_LINK_ENDPOINTS', `${path}.route`, 'group-link requires two group endpoints');
      if (route === 'stub' || route === 'group-link') v.report('ROUTE_UNSUPPORTED', `${path}.route`, `M1 falls back to routed for ${route}`, 'warning', 'model');
    }
    if (fields.has('weight')) {
      const weight = v.number(fields.get('weight'), `${path}.weight`, false, 0);
      if (weight !== undefined) options.weight = weight;
    }
    // Bundle cardinality for merge is owned by stage 1, after grouping.
    if (from !== undefined && to !== undefined) doc.links.push({ ...options, from, to });
  }
}

function limits(doc: NormalisedDocument, inputLinkCount: number, options: ParseOptions, v: Validation): void {
  const ids = orderedNodeIds(doc);
  if (ids.length > 1000 && !options.force) v.report('NODE_LIMIT', '$.nodes', 'More than 1000 nodes requires force');
  if (ids.length > 30) v.report('LARGE_DIAGRAM', '$.nodes', 'More than 30 nodes; consider collapsed groups', 'warning', 'model');
  // ADR-0006: links, ports and degree *bound work*, they do not define a legal document. Beyond
  // them the tool warns and continues best effort; only the node count refuses without --force.
  if (inputLinkCount > 10 * ids.length) v.report('LINK_LIMIT', '$.links', `Links (${inputLinkCount}) exceed 10 times the node count; continuing best effort`, 'warning', 'model');
  const degree = new Map<string, Set<number>>();
  doc.links.forEach((link, index) => {
    for (const end of [link.from, link.to]) if (end.node !== undefined) {
      const set = degree.get(end.node) ?? new Set<number>(); set.add(index); degree.set(end.node, set);
    }
  });
  for (const id of ids) {
    const node = own(doc.nodes, id);
    if (node && node.ports.length > 20) v.report('PORT_LIMIT', `$.nodes.${id}.ports`, `Node ${id} has ${node.ports.length} ports, above the 20 that bound work; continuing best effort`, 'warning', 'model');
    if ((degree.get(id)?.size ?? 0) > 64) v.report('HIGH_DEGREE', `$.nodes.${id}`, 'Node degree exceeds 64', 'warning', 'model');
  }
}

export function parseWithDiagnostics(text: string, options: ParseOptions = {}): ParseResult {
  const v = new Validation();
  const root = v.map(v.yaml(text), '$');
  v.keys(root, ['portograph', 'profile', 'title', 'css', 'groups', 'nodes', 'links', 'overlays'], '$');
  if (root.get('portograph') !== 2) v.report('VERSION', '$.portograph', 'portograph: 2 is required');
  if (root.has('profile')) {
    const profile = v.string(root.get('profile'), '$.profile');
    if (profile !== undefined && profile !== 'network') v.report('UNSUPPORTED_PROFILE', '$.profile', `M1 does not support profile ${profile}`);
  }
  const doc: NormalisedDocument = { portograph: 2, profile: 'network', groups: {}, nodes: {}, links: [] };
  optionalStrings(root, doc, ['title'], '$', v);
  if (root.has('css')) { const css = v.string(root.get('css'), '$.css'); if (css !== undefined) doc.css = filterCss(css, v); }
  if (root.has('overlays')) {
    doc.overlays = {};
    for (const [key, value] of v.map(root.get('overlays'), '$.overlays')) {
      if (v.identifier(key, `$.overlays.${key}`) === undefined) continue;
      const state = v.choice(value, ['hidden', 'visible'], `$.overlays.${key}`);
      if (state !== undefined) put(doc.overlays, key, state);
    }
  }
  const groupInput = v.map(root.get('groups'), '$.groups');
  const nodeInput = v.map(root.get('nodes'), '$.nodes');
  const ranks = groups(groupInput, doc, v);
  nodes(nodeInput, doc, v);
  const groupOrder = [...groupInput.keys()].filter(id => Object.hasOwn(doc.groups, id));
  const nodeOrder = [...nodeInput.keys()].filter(id => Object.hasOwn(doc.nodes, id));
  if (JSON.stringify(groupOrder) !== JSON.stringify(Object.keys(doc.groups))) doc.groupOrder = groupOrder;
  if (JSON.stringify(nodeOrder) !== JSON.stringify(Object.keys(doc.nodes))) doc.nodeOrder = nodeOrder;
  inferTiers(doc, ranks, v);
  if (root.has('links')) links(root.get('links'), doc, v);
  const linkInput = root.get('links');
  limits(doc, Array.isArray(linkInput) ? linkInput.length : 0, options, v);
  for (const diagnostic of v.diagnostics) options.onDiagnostic?.(diagnostic);
  return v.failed ? { ok: false, diagnostics: v.diagnostics } : { ok: true, document: doc, diagnostics: v.diagnostics };
}

/** Parse to stage-0 JSON. Use the result variant or callback to retain diagnostics. */
export function parse(text: string, options: ParseOptions = {}): NormalisedDocument {
  const result = parseWithDiagnostics(text, options);
  if (!result.ok) throw new ParseError(result.diagnostics);
  return result.document;
}
