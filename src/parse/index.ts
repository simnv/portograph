import type { Endpoint, GroupContent, Meta, NormalisedDocument, NormalisedLink, NormalisedNode, NormalisedPort, Side } from '../model/index.js';
import { orderedGroupIds, orderedNodeIds, unsupportedMessage } from '../model/index.js';
import { BOTTOM_CLASSES, TOP_CLASSES } from '../profiles/network/tiers.js';
import { filterCss } from './css.js';
import { own, ParseError, put, Validation } from './validation.js';
import type { LocateDiagnostic, SourceDiagnostic, SourceLocation } from './validation.js';

export { ParseError } from './validation.js';
export type { LocateDiagnostic, SourceDiagnostic, SourceLocation } from './validation.js';

export interface ParseOptions {
  /** Overrides the >1000 node refusal only (ADR-0006). */
  force?: boolean;
  /** The second argument is where the diagnostic points in the authored text, when it is known. */
  onDiagnostic?: (diagnostic: SourceDiagnostic, location?: SourceLocation) => void;
}

export type ParseResult =
  | { ok: true; document: NormalisedDocument; diagnostics: SourceDiagnostic[]; locate: LocateDiagnostic }
  | { ok: false; diagnostics: SourceDiagnostic[]; locate: LocateDiagnostic };

const sides = ['top', 'right', 'bottom', 'left'] as const;
const routes = ['orthogonal', 'straight', 'bundle', 'merge', 'overlay', 'stub', 'group-link'] as const;

function optionalStrings<T extends object, K extends keyof T & string>(input: Map<string, unknown>, output: T, keys: readonly K[], path: string, v: Validation): void {
  for (const key of keys) if (input.has(key)) {
    const value = v.string(input.get(key), `${path}.${key}`);
    if (value !== undefined) Object.assign(output, { [key]: value });
  }
}

/** A meta key is an XML attribute name a draw.io cell can carry without a namespace. */
const META_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Keys draw.io or the binding contract own on a cell (docs/drawio-binding-contract.md). */
const RESERVED_META = /^(?:pg-.*|id|label|placeholders|xml.*)$/i;

/** `meta:` on the root, a node, a port or a link: a flat map of scalars that only the draw.io export reads. */
function meta(value: unknown, path: string, v: Validation): Meta | undefined {
  const result: Meta = {};
  for (const [key, item] of v.map(value, path)) {
    const at = `${path}.${key}`;
    if (!META_KEY.test(key)) v.report('BAD_META_KEY', at, 'A meta key starts with a letter or an underscore and contains letters, digits, underscores or hyphens');
    else if (RESERVED_META.test(key)) v.report('RESERVED_META_KEY', at, `The meta key ${key} is reserved; the pg- prefix, id, label, placeholders and xml are not available`);
    else if (typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) put(result, key, item);
    else v.report('INVALID_TYPE', at, 'Expected a string, a finite number or a boolean');
  }
  return Object.keys(result).length ? result : undefined;
}

function groups(input: Map<string, unknown>, doc: NormalisedDocument, v: Validation): Map<string, number | undefined> {
  const ranks = new Map<string, number | undefined>();
  // A canton is any existing group that a member names in `canton:`.
  const cantonNames = new Set<string>();
  for (const value of input.values()) {
    const named = value instanceof Map ? value.get('canton') : undefined;
    if (typeof named === 'string' && input.has(named)) cantonNames.add(named);
  }
  for (const [id, value] of input) {
    const path = `$.groups.${id}`;
    if (v.identifier(id, path) === undefined) continue;
    const fields = v.map(value, path);
    v.keys(fields, ['tier', 'align', 'of', 'parent', 'canton', 'label', 'shape', 'class', 'collapsed', 'layout'], path);
    const content: GroupContent = { label: id, shape: 'ranked' };
    optionalStrings(fields, content, ['label', 'class'], path, v);
    if (cantonNames.has(id)) {
      for (const key of ['tier', 'align', 'of', 'parent', 'shape', 'layout', 'collapsed']) if (fields.has(key)) v.report('CANTON_KEYS', `${path}.${key}`, `A canton takes a label and a class only, not ${key}`);
      if (fields.has('canton')) v.report('CANTON_NESTED', `${path}.canton`, 'A canton is not a member of a canton; the depth is canton, member, child');
      put(doc.groups, id, { ...content, members: [] });
      continue;
    }
    let member: string | undefined;
    if (fields.has('canton')) {
      const ref = v.identifier(fields.get('canton'), `${path}.canton`);
      if (ref !== undefined && !input.has(ref)) v.report('UNKNOWN_REFERENCE', `${path}.canton`, `Unknown group ${ref}`);
      else if (ref !== undefined && (fields.has('parent') || fields.has('align'))) v.report('CANTON_MEMBER_KIND', `${path}.canton`, 'A member is a tier group: a child group takes the canton of its parent and a flank has none');
      else member = ref;
    }
    if (fields.has('shape')) {
      const shape = v.choice(fields.get('shape'), ['ranked', 'row', 'bar', 'grid', 'ring', 'free'], `${path}.shape`);
      if (shape === 'ranked' || shape === 'row' || shape === 'bar' || shape === 'grid') content.shape = shape;
      else if (shape !== undefined) v.report('UNSUPPORTED_SHAPE', `${path}.shape`, `${shape} groups are not supported`);
    }
    if (fields.has('collapsed')) {
      if (typeof fields.get('collapsed') !== 'boolean') v.report('INVALID_TYPE', `${path}.collapsed`, 'Expected a boolean');
      else v.report('COLLAPSED_UNSUPPORTED', `${path}.collapsed`, 'collapsed is ignored', 'warning', 'model');
    }
    if (fields.has('layout')) {
      const layout: Record<string, string | number | boolean> = {};
      for (const [key, option] of v.map(fields.get('layout'), `${path}.layout`)) {
        if (typeof option === 'string' || typeof option === 'boolean' || (typeof option === 'number' && Number.isFinite(option))) put(layout, key, option);
        else v.report('INVALID_TYPE', `${path}.layout.${key}`, 'Expected an ELK scalar option');
      }
      content.layout = layout;
    }
    if (fields.has('parent')) {
      const parent = v.identifier(fields.get('parent'), `${path}.parent`);
      if (fields.has('tier')) v.report('CHILD_TIER', `${path}.tier`, 'A child group takes the tier of its parent');
      if (fields.has('shape')) v.report('CHILD_SHAPE', `${path}.shape`, 'A child group always expands into rank cells and takes no shape');
      if (fields.has('align') || fields.has('of')) v.report('CHILD_FLANK', path, 'A child group cannot be a flank');
      if (parent !== undefined) put(doc.groups, id, { ...content, tier: 0, parent });
      continue;
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
      put(doc.groups, id, { ...content, tier: rank ?? 0, ...(member === undefined ? {} : { canton: member }) });
      ranks.set(id, rank);
    }
  }
  for (const [id, group] of Object.entries(doc.groups)) if (group.parent !== undefined) {
    const parent = own(doc.groups, group.parent);
    const path = `$.groups.${id}.parent`;
    if (parent === undefined) v.report('UNKNOWN_REFERENCE', path, `Unknown group ${group.parent}`);
    else if (parent.members !== undefined) v.report('CANTON_KEYS', path, 'A canton has no child groups; a member holds them');
    else if (group.parent === id || parent.parent !== undefined) v.report('NESTED_CHILD', path, 'A parent group cannot itself have a parent; groups nest one level');
    else if (parent.align !== undefined) v.report('PARENT_FLANK', path, 'A flank cannot have child groups');
    else if (parent.shape !== 'ranked') v.report('PARENT_SHAPE', path, `A group with a child is ranked, not ${parent.shape}`);
  }
  const occupied = new Set<string>();
  for (const [id, group] of Object.entries(doc.groups)) if (group.align !== undefined) {
    const target = own(doc.groups, group.of);
    if (target === undefined) v.report('UNKNOWN_REFERENCE', `$.groups.${id}.of`, `Unknown group ${group.of}`);
    else if (target.members !== undefined) v.report('CANTON_KEYS', `$.groups.${id}.of`, 'A canton has no flank');
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
    v.keys(fields, ['name', 'side', 'order', 'class', 'meta'], itemPath);
    const name = v.identifier(fields.get('name'), `${itemPath}.name`);
    const side = fields.has('side') ? v.choice(fields.get('side'), sides, `${itemPath}.side`) : inherited;
    const order = fields.has('order') ? v.number(fields.get('order'), `${itemPath}.order`, true) : undefined;
    if (name === undefined) continue;
    const ordinal = (count.get(name) ?? 0) + 1;
    count.set(name, ordinal);
    const port: NormalisedPort = { name, ordinal };
    if (side !== undefined) port.side = side;
    if (order !== undefined) port.order = order;
    optionalStrings(fields, port, ['class'], itemPath, v);
    const data = fields.has('meta') ? meta(fields.get('meta'), `${itemPath}.meta`, v) : undefined;
    if (data !== undefined) port.meta = data;
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
    v.keys(fields, ['group', 'class', 'label', 'description', 'icon', 'ports', 'size', 'meta'], path);
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
    const data = fields.has('meta') ? meta(fields.get('meta'), `${path}.meta`, v) : undefined;
    if (data !== undefined) node.meta = data;
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
    // A child group has no tier: its members count for the parent, which is the tier group.
    const owner = own(doc.groups, node.group)?.parent ?? node.group;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
    const set = classes.get(owner) ?? new Set<string>();
    if (node.class !== undefined) set.add(node.class);
    classes.set(owner, set);
  }
  for (const id of orderedGroupIds(doc)) {
    const group = own(doc.groups, id);
    if (!group || group.align !== undefined || group.parent !== undefined || group.members !== undefined) continue;
    const rank = ranks.get(id);
    if (rank !== undefined) { explicit.set(rank, [...(explicit.get(rank) ?? []), id]); continue; }
    const set = classes.get(id) ?? new Set<string>();
    const hasTop = TOP_CLASSES.some(c => set.has(c));
    const hasBottom = BOTTOM_CLASSES.some(c => set.has(c));
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
  for (const id of orderedGroupIds(doc)) {
    const group = own(doc.groups, id);
    const parent = group?.parent === undefined ? undefined : own(doc.groups, group.parent);
    if (group && parent?.tier !== undefined) group.tier = parent.tier;
  }
}

/** Canton rules that read effective tiers, so they run after `inferTiers` (docs/design/canton-groups.md, Section 1). */
function cantons(doc: NormalisedDocument, v: Validation): void {
  for (const id of orderedNodeIds(doc)) {
    const node = own(doc.nodes, id);
    if (node && own(doc.groups, node.group)?.members !== undefined) v.report('CANTON_KEYS', `$.nodes.${id}.group`, `${node.group} is a canton and holds no node; a member holds it`);
  }
  const flanked = new Map<string, string>();
  for (const id of orderedGroupIds(doc)) { const group = own(doc.groups, id); if (group?.of !== undefined) flanked.set(group.of, id); }
  for (const id of orderedGroupIds(doc)) {
    const group = own(doc.groups, id);
    const canton = group?.canton === undefined ? undefined : own(doc.groups, group.canton);
    if (!group || !canton?.members) continue;
    const path = `$.groups.${id}.canton`;
    if (group.shape === 'bar' || group.shape === 'grid') { v.report('CANTON_MEMBER_SHAPE', path, `A member is ranked or row, not ${group.shape}`); continue; }
    if (flanked.has(id)) { v.report('CANTON_MEMBER_FLANK', `$.groups.${flanked.get(id)}.of`, `A flank cannot stand beside ${id}, a member of a canton`); continue; }
    const holders = new Set([id, ...orderedGroupIds(doc).filter(child => own(doc.groups, child)?.parent === id)]);
    if (!orderedNodeIds(doc).some(node => holders.has(own(doc.nodes, node)?.group ?? ''))) { v.report('CANTON_MEMBER_EMPTY', `$.groups.${id}`, `A member holds a node, and ${id} holds none`); continue; }
    canton.members.push(id);
  }
  for (const id of orderedGroupIds(doc)) {
    const canton = own(doc.groups, id);
    if (!canton?.members) continue;
    if (canton.members.length === 0) { v.report('CANTON_EMPTY', `$.groups.${id}`, `Canton ${id} has no member`); continue; }
    const tiers = [...new Set(canton.members.map(m => own(doc.groups, m)?.tier ?? 0))].sort((a, b) => a - b);
    if (tiers.some((tier, i) => i > 0 && tier !== (tiers[i - 1] ?? 0) + 1)) v.report('CANTON_TIER_GAP', `$.groups.${id}`, `The members of canton ${id} stand on tiers ${tiers.join(', ')}; a canton holds consecutive tiers`);
  }
}

/** A link end that names a canton is refused in this version: stage 1 has no frame to read it through (a later ticket). */
function groupEnd(id: string, path: string, doc: NormalisedDocument, v: Validation): Endpoint | undefined {
  if (own(doc.groups, id)?.members !== undefined) { v.report('CANTON_KEYS', path, 'A link endpoint cannot name a canton in this version; name a member or a node'); return undefined; }
  return { group: id };
}

function endpoint(value: unknown, path: string, doc: NormalisedDocument, used: Map<NormalisedPort, Set<number>>, index: number, v: Validation): Endpoint | undefined {
  let nodeId: string | undefined, name: string | undefined, ordinal: number | undefined;
  if (typeof value === 'string') {
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\.([A-Za-z0-9][A-Za-z0-9_-]*|\*)(?:#([1-9][0-9]*))?)?$/.exec(value);
    if (!match) { v.report('BAD_ENDPOINT', path, 'Invalid compact endpoint'); return undefined; }
    nodeId = match[1]; name = match[2];
    if (match[3] !== undefined) ordinal = Number(match[3]);
    if (nodeId !== undefined && name === undefined && own(doc.groups, nodeId) !== undefined) return groupEnd(nodeId, path, doc, v);
  } else {
    const fields = v.map(value, path);
    v.keys(fields, ['node', 'port', 'ordinal', 'group'], path);
    if (fields.has('group')) {
      if (fields.has('node') || fields.has('port') || fields.has('ordinal')) { v.report('BAD_ENDPOINT', path, 'A group endpoint has only group'); return undefined; }
      const id = v.identifier(fields.get('group'), `${path}.group`);
      if (id === undefined) return undefined;
      if (own(doc.groups, id) === undefined) { v.report('UNKNOWN_REFERENCE', path, `Unknown group ${id}`); return undefined; }
      return groupEnd(id, path, doc, v);
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
  const ids = new Set<string>();
  for (const [index, item] of v.list(value, '$.links').entries()) {
    const path = `$.links[${index}]`;
    let fields: Map<string, unknown>, fromValue: unknown, toValue: unknown;
    if (Array.isArray(item)) {
      if (item.length < 2 || item.length > 3) v.report('LINK_ENDPOINTS', path, 'Expected two endpoints and optional options');
      fromValue = item[0]; toValue = item[1];
      fields = item.length > 2 ? v.map(item[2], `${path}.options`) : new Map<string, unknown>();
      v.keys(fields, ['id', 'class', 'label', 'route', 'weight', 'meta'], path);
    } else {
      fields = v.map(item, path);
      v.keys(fields, ['id', 'from', 'to', 'class', 'label', 'route', 'weight', 'meta'], path);
      if (!fields.has('from') || !fields.has('to')) v.report('LINK_ENDPOINTS', path, 'Expected from and to endpoints');
      fromValue = fields.get('from'); toValue = fields.get('to');
    }
    const from = endpoint(fromValue, `${path}.from`, doc, used, index, v);
    const to = endpoint(toValue, `${path}.to`, doc, used, index, v);
    const options: Partial<NormalisedLink> = {};
    if (fields.has('id')) {
      const id = v.identifier(fields.get('id'), `${path}.id`);
      if (id !== undefined && ids.has(id)) v.report('DUPLICATE_LINK_ID', `${path}.id`, `Another link already has the id ${id}`);
      else if (id !== undefined) { ids.add(id); options.id = id; }
    }
    optionalStrings(fields, options, ['class', 'label'], path, v);
    if (fields.has('route')) {
      const route = v.choice(fields.get('route'), routes, `${path}.route`);
      if (route !== undefined) options.route = route;
      if (route === 'group-link' && (from?.group === undefined || to?.group === undefined)) v.report('GROUP_LINK_ENDPOINTS', `${path}.route`, 'group-link requires two group endpoints');
      if (route === 'stub' || route === 'group-link') v.report('ROUTE_UNSUPPORTED', `${path}.route`, unsupportedMessage(route), 'warning', 'model');
    }
    if (fields.has('weight')) {
      const weight = v.number(fields.get('weight'), `${path}.weight`, false, 0);
      if (weight !== undefined) options.weight = weight;
    }
    const data = fields.has('meta') ? meta(fields.get('meta'), `${path}.meta`, v) : undefined;
    if (data !== undefined) options.meta = data;
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

/** `locate` is a method of the result, not data: it stays out of enumeration, so two results of one text compare equal. */
function withLocate<T extends object>(result: T, locate: LocateDiagnostic): T & { locate: LocateDiagnostic } {
  return Object.defineProperty(result, 'locate', { value: locate, enumerable: false }) as T & { locate: LocateDiagnostic };
}

export function parseWithDiagnostics(text: string, options: ParseOptions = {}): ParseResult {
  const v = new Validation();
  const parsedYaml = v.yaml(text);
  // A syntax error leaves nothing to check: the schema pass would only repeat it as a pile of
  // "missing key" errors, so stop at the first thing the author has to fix.
  if (v.failed) {
    for (const diagnostic of v.diagnostics) options.onDiagnostic?.(diagnostic, v.locate(diagnostic));
    return withLocate({ ok: false, diagnostics: v.diagnostics }, v.locate);
  }
  const root = v.map(parsedYaml, '$');
  v.keys(root, ['portograph', 'profile', 'title', 'css', 'layout', 'render', 'meta', 'groups', 'nodes', 'links', 'overlays'], '$');
  if (root.get('portograph') !== 2) v.report('VERSION', '$.portograph', 'portograph: 2 is required');
  if (root.has('profile')) {
    const profile = v.string(root.get('profile'), '$.profile');
    if (profile !== undefined && profile !== 'network') v.report('UNSUPPORTED_PROFILE', '$.profile', `Profile ${profile} is not supported; use network`);
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
  if (root.has('layout')) {
    // Document settings (ticket 152). Only written when the author states them, so a document without the key is unchanged.
    const settings: NonNullable<NormalisedDocument['layout']> = {};
    for (const [key, value] of v.map(root.get('layout'), '$.layout')) {
      if (key !== 'overlayOverBodies' && key !== 'corridorRowOrder') v.report('UNKNOWN_KEY', `$.layout.${key}`, `Unknown key ${key}`);
      else if (typeof value !== 'boolean') v.report('INVALID_TYPE', `$.layout.${key}`, 'Expected a boolean');
      else settings[key] = value;
    }
    if (Object.keys(settings).length) doc.layout = settings;
  }
  if (root.has('render')) {
    // Paint-only settings: nothing here reaches layout or score. Written only when the author states them.
    const settings: NonNullable<NormalisedDocument['render']> = {};
    for (const [key, value] of v.map(root.get('render'), '$.render')) {
      if (key !== 'anonymousPortMarker') { v.report('UNKNOWN_KEY', `$.render.${key}`, `Unknown key ${key}`); continue; }
      const marker = v.choice(value, ['dot', 'none'], `$.render.${key}`);
      if (marker !== undefined) settings.anonymousPortMarker = marker;
    }
    if (Object.keys(settings).length) doc.render = settings;
  }
  if (root.has('meta')) { const data = meta(root.get('meta'), '$.meta', v); if (data !== undefined) doc.meta = data; }
  const groupInput = v.map(root.get('groups'), '$.groups');
  const nodeInput = v.map(root.get('nodes'), '$.nodes');
  const ranks = groups(groupInput, doc, v);
  nodes(nodeInput, doc, v);
  const groupOrder = [...groupInput.keys()].filter(id => Object.hasOwn(doc.groups, id));
  const nodeOrder = [...nodeInput.keys()].filter(id => Object.hasOwn(doc.nodes, id));
  if (JSON.stringify(groupOrder) !== JSON.stringify(Object.keys(doc.groups))) doc.groupOrder = groupOrder;
  if (JSON.stringify(nodeOrder) !== JSON.stringify(Object.keys(doc.nodes))) doc.nodeOrder = nodeOrder;
  inferTiers(doc, ranks, v);
  cantons(doc, v);
  if (root.has('links')) links(root.get('links'), doc, v);
  const linkInput = root.get('links');
  limits(doc, Array.isArray(linkInput) ? linkInput.length : 0, options, v);
  for (const diagnostic of v.diagnostics) options.onDiagnostic?.(diagnostic, v.locate(diagnostic));
  return withLocate(v.failed ? { ok: false, diagnostics: v.diagnostics } : { ok: true, document: doc, diagnostics: v.diagnostics }, v.locate);
}

/** Parse to stage-0 JSON. Use the result variant or callback to retain diagnostics. */
export function parse(text: string, options: ParseOptions = {}): NormalisedDocument {
  const result = parseWithDiagnostics(text, options);
  if (!result.ok) throw new ParseError(result.diagnostics, result.locate);
  return result.document;
}
