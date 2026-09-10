import type { Rect } from '../model/geometry.js';
import type { LayoutModel, LayoutStage, PlacementSnapshot } from '../model/layout.js';
import { orderedNodeIds, orderedGroupIds } from '../model/model.js';
import { resolve } from '../resolve/index.js';
import { sidesOne, SIDE_TIE_ORDER } from './sides-one.js';
import { sizeNodes } from './size.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { measureText } from '../text/index.js';
import { NODE_CONTENT_GEOMETRY } from '../theme/content.js';
import { nodeGap } from './skeleton-graph.js';
import { rebuildBands, union, validateSkeletonBands } from './skeleton-geometry.js';
import { rebuildRowPaths, rowPathCandidate } from './row-paths.js';

export type PlacementRule = 'rows' | 'lanes' | 'flanks' | 'centre' | 'bars' | 'bundles'
  | 'bands' | 'route' | 'link-labels' | 'validate' | 'emit';
const stages: LayoutStage[] = ['normalised', 'resolve', 'sides-one', 'size', 'skeleton', 'sides-two',
  'rows', 'lanes', 'flanks', 'centre', 'bars', 'bundles', 'bands', 'route', 'link-labels', 'validate', 'emit'];
const protectedModels = new WeakSet<LayoutModel>();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function jsonValue(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Layout requires finite numbers');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('Layout must contain JSON values');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Layout must contain plain JSON objects');
    for (const child of Object.values(value)) jsonValue(child);
  }
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key)
    && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function same(a: unknown, b: unknown, message: string): void { if (!equal(a, b)) throw new Error(message); }
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) as Pick<T, K>;
}
function omit(value: object, keys: readonly string[]): object {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function protect(model: LayoutModel, baseline: LayoutModel): LayoutModel {
  validatePublication(model, baseline);
  const result = clone(model);
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(result); protectedModels.add(result); return result;
}
function semantics(model: LayoutModel) {
  return {
    links: model.links.map(link => pick(link, ['id', 'sourceIndex', 'owner', 'from', 'to', 'attachments', 'family', 'layer', 'bundle', 'groupLink'])),
    bundles: model.bundles.map(bundle => pick(bundle, ['id', 'owner', 'layer', 'nodes', 'members'])),
    groupLinks: model.groupLinks.map(group => pick(group, ['id', 'owner', 'layer', 'groups', 'members'])),
  };
}
function topology(model: LayoutModel) {
  return orderedNodeIds(model.document).map(id => ({ node: id, ports: model.nodes[id]!.ports.map(port => {
    if (!port.side) throw new Error(`Missing final side on ${id}`);
    return { ref: port.ref, side: port.side, ...pick(port, ['authorOrder']) };
  }) }));
}
function structure(model: LayoutModel) {
  return {
    nodes: Object.fromEntries(Object.entries(model.nodes).map(([id, node]) => [id, {
      ...pick(node, ['id', 'owner', 'layer', 'strokeWidth']),
      ports: node.ports.map(port => pick(port, ['ref', 'side', 'authorOrder', 'owner', 'layer', 'unused', 'sizingSide'])),
    }])),
    groups: Object.fromEntries(Object.entries(model.groups).map(([id, group]) => [id, pick(group, ['id', 'owner', 'layer', 'nodes', 'tier', 'flank', 'rowOrder'])])),
    ...pick(model, ['anchorTier', 'fallbackUsed', 'deadlineHit']),
  };
}
function nodeLabels(model: LayoutModel) {
  return model.labels.filter(label => ['node', 'description', 'pill'].includes(label.role ?? ''));
}
function placement(model: LayoutModel): PlacementSnapshot {
  return {
    nodes: Object.fromEntries(Object.entries(model.nodes).map(([id, node]) => [id,
      pick(node, ['bounds', 'size', 'sizeFloor', 'contentSize', 'contentInsets', 'sidePitch', 'ports', 'icon'])])),
    groups: Object.fromEntries(Object.entries(model.groups).map(([id, group]) => [id, pick(group, ['bounds', 'rowOrder', 'nodes', 'tier', 'flank'])])),
    tierBands: model.tierBands, regions: model.regions, lanes: model.lanes, labelBands: model.labelBands,
    labels: model.labels.filter(label => ['node', 'description', 'pill', 'group'].includes(label.role ?? '')),
  };
}
function validateDocument(model: LayoutModel): LayoutModel {
  const resolved = resolve(model.document);
  same(semantics(model), semantics(resolved), 'Resolved semantics differ from document');
  same(Object.keys(model.nodes).sort(), Object.keys(resolved.nodes).sort(), 'Node membership differs from document');
  same(Object.keys(model.groups).sort(), Object.keys(resolved.groups).sort(), 'Group membership differs from document');
  const predicted = sidesOne(resolved);
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!, original = predicted.nodes[id]!;
    same(pick(node, ['id', 'owner', 'layer']), pick(original, ['id', 'owner', 'layer']), 'Node identity differs from document');
    same(node.ports.map(port => pick(port, ['ref', 'authorOrder', 'owner', 'layer', 'unused'])),
      original.ports.map(port => pick(port, ['ref', 'authorOrder', 'owner', 'layer', 'unused'])), 'Port identity differs from document');
    original.ports.forEach((port, index) => { if (port.side) same(node.ports[index]!.side, port.side, 'Semantic or authored side differs from document'); });
  }
  for (const id of orderedGroupIds(model.document)) {
    const group = model.groups[id]!, original = predicted.groups[id]!;
    same(pick(group, ['id', 'owner', 'layer', 'nodes', 'tier']), pick(original, ['id', 'owner', 'layer', 'nodes', 'tier']), 'Group identity differs from document');
    if (original.flank) {
      if (!group.flank) throw new Error('Missing flank');
      same(pick(group.flank, ['align', 'of']), pick(original.flank, ['align', 'of']), 'Flank differs from document');
      for (const peer of [group.flank.primaryPeer, group.flank.proxyPeer]) if (peer !== undefined && !model.groups[group.flank.of]!.nodes.includes(peer)) throw new Error('Invalid flank peer');
    } else if (group.flank) throw new Error('Unexpected flank');
  }
  return resolved;
}
function validateRect(rect: Rect | undefined, name: string, positive = false): asserts rect is Rect {
  if (!rect || !['x', 'y', 'width', 'height'].every(key => typeof rect[key as keyof Rect] === 'number' && Number.isFinite(rect[key as keyof Rect]))
    || (positive ? rect.width <= 0 || rect.height <= 0 : rect.width < 0 || rect.height < 0)) throw new Error(`Invalid ${name} rectangle`);
}
function validatePlacementStructure(model: LayoutModel): void {
  validateRect(model.canvas, 'canvas');
  for (const node of Object.values(model.nodes)) validateRect(node.bounds, `node ${node.id}`, true);
  for (const band of model.tierBands) validateRect(band.bounds, `tier band ${band.tier}`);
  for (const group of Object.values(model.groups)) {
    validateRect(group.bounds, `group ${group.id}`);
    same([...(group.rowOrder ?? [])].sort(), [...group.nodes].sort(), 'Invalid row order');
    if (model.document.groups[group.id]!.shape === 'row') {
      for (let i = 1; i < group.rowOrder!.length; i++) {
        if (model.nodes[group.rowOrder![i - 1]!]!.bounds!.x > model.nodes[group.rowOrder![i]!]!.bounds!.x + 1e-6) throw new Error('Physical row order contradicts rowOrder');
      }
    }
    if (group.flank) {
      const peer = model.groups[group.flank.of];
      if (!peer) throw new Error('Missing flank peer group');
      validateRect(peer.bounds, 'flank peer group');
      const peerCentre = peer.bounds.x + peer.bounds.width / 2;
      for (const bounds of [group.bounds, ...group.nodes.map(id => model.nodes[id]!.bounds!)]) {
        const centre = bounds.x + bounds.width / 2;
        if (group.flank.align === 'left' ? centre >= peerCentre : centre <= peerCentre) throw new Error('Flank placement contradicts its authored side');
      }
    }
  }
}
function validateTechniques(model: LayoutModel, baseline: LayoutModel): void {
  for (const [index, link] of model.links.entries()) {
    const expected = baseline.links[index]!.technique;
    const authored = model.document.links[link.sourceIndex]!.route;
    // Only a rule with a landed validator may select a technique; today that is the rows rule for its candidates.
    const geometrySelected = authored === undefined && link.layer === 'routed' && !link.bundle && !link.groupLink
      && stages.indexOf(model.stage) >= stages.indexOf('rows') && rowPathCandidate(model, link)
      && (expected === undefined || expected === 'straight' || expected === 'orthogonal')
      && (link.technique === 'straight' || link.technique === 'orthogonal');
    if (!geometrySelected) same(pick(link, ['technique']), pick(baseline.links[index]!, ['technique']), 'Link technique contradicts authored route, effective layer or M1 fallback');
  }
}
/** Every protected result passes this same boundary, including direct freeze and restore. */
function validatePublication(model: LayoutModel, baseline: LayoutModel): void {
  jsonValue(model);
  if (hasUnsupportedClaims(model)) throw new Error('Claim validator is not implemented');
  validateTechniques(model, baseline);
  validateGeometry(model, diagnosed(model));
  validateFreeze(model);
  validateRowPaths(model);
}
/** Row paths are derived claims: every candidate must carry exactly the path a fresh rebuild produces. */
function validateRowPaths(model: LayoutModel): void {
  if (stages.indexOf(model.stage) < stages.indexOf('rows')) return;
  const expected = clone(model);
  rebuildRowPaths(expected);
  for (const [index, link] of model.links.entries()) {
    if (!rowPathCandidate(model, link)) continue;
    same(link.path, expected.links[index]!.path, `Row path on ${link.id} contradicts the rows rule`);
    same(link.technique, expected.links[index]!.technique, `Row path technique on ${link.id} contradicts the rows rule`);
  }
}
function validateGeometry(model: LayoutModel, allowNonConvergence = false): void {
  jsonValue(model);
  validatePlacementStructure(model);
  if (model.runtime.stages.some(entry => !stages.includes(entry.stage) || entry.durationMs < 0)
    || (model.runtime.totalMs !== undefined && model.runtime.totalMs < 0)) throw new Error('Invalid runtime measurement');
  const expected = clone(model);
  // Fresh measurement cannot inherit a forged floor, inset, content size or pitch.
  for (const node of Object.values(expected.nodes)) {
    delete node.sizeFloor; delete node.size; delete node.contentSize; delete node.contentInsets; delete node.sidePitch;
  }
  sizeNodes(expected);
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!, measured = expected.nodes[id]!, box = node.bounds;
    if (!box || !node.size || !node.sizeFloor || box.width <= 0 || box.height <= 0) throw new Error(`Missing positive geometry on ${id}`);
    if (stages.indexOf(model.stage) >= stages.indexOf('bars') && model.document.groups[model.document.nodes[id]!.group]!.shape === 'bar') {
      const label = measureText(model.document.nodes[id]!.label, { fontSize: NODE_CONTENT_GEOMETRY.labelFontSize, weight: NODE_CONTENT_GEOMETRY.labelFontWeight });
      if (box.width < label.width + 60) throw new Error(`Bar ${id} violates label-plus-60 floor`);
    }
    same(node.size, { width: box.width, height: box.height }, `Size/bounds disagree on ${id}`);
    same(node.contentInsets, measured.contentInsets, `Content insets differ on ${id}`);
    same(node.contentSize, measured.contentSize, `Content measurement differs on ${id}`);
    const saved = model.freeze?.floors.find(floor => floor.node === id)?.size;
    for (const dim of ['width', 'height'] as const) {
      if ((saved !== undefined && saved[dim] < measured.sizeFloor![dim]) || node.sizeFloor[dim] < measured.sizeFloor![dim] || node.sizeFloor[dim] < (saved?.[dim] ?? 0)
        || node.size[dim] < node.sizeFloor[dim]) throw new Error(`Node ${id} violates ${dim} floor`);
    }
    for (const side of SIDE_TIE_ORDER) {
      const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
      const pitch = node.sidePitch?.[side];
      if (pitch === undefined || pitch < measured.sidePitch![side]!) throw new Error(`Invalid measured pitch on ${id}.${side}`);
      const horizontal = side === 'top' || side === 'bottom';
      const length = horizontal ? box.width : box.height;
      if (length + 1e-6 < ports.length * pitch + 20) throw new Error(`Port capacity exceeds ${id}.${side}`);
      let prior = -Infinity, authored = -Infinity;
      for (const [index, port] of ports.entries()) {
        if (port.engineOrder !== index) throw new Error(`Invalid engine slots on ${id}.${side}`);
        if (!port.anchor) throw new Error(`Missing anchor on ${id}`);
        const coordinate = horizontal ? port.anchor.x : port.anchor.y;
        if (coordinate - prior < pitch - 1e-6) throw new Error(`Port spacing/order violates pitch on ${id}.${side}`);
        prior = coordinate;
        if (port.authorOrder !== undefined) {
          if (!Number.isSafeInteger(port.authorOrder) || port.authorOrder < authored) throw new Error(`Author order reversed on ${id}.${side}`);
          authored = port.authorOrder;
        }
      }
    }
  }
  rebuildNodeGeometry(expected, orderedNodeIds(model.document), 'current');
  same(nodeLabels(model), nodeLabels(expected), 'Node labels must match measured geometry');
  for (const id of orderedNodeIds(model.document)) {
    same(model.nodes[id]!.icon, expected.nodes[id]!.icon, 'Icon bounds must match measured geometry');
    same(model.nodes[id]!.ports, expected.nodes[id]!.ports, 'Pills must match measured geometry');
  }
  for (const group of Object.values(model.groups)) {
    if (!group.bounds || group.bounds.width < 0 || group.bounds.height < 0) throw new Error('Invalid group bounds');
    same([...(group.rowOrder ?? [])].sort(), [...group.nodes].sort(), 'Invalid row order');
    for (const [index, id] of group.nodes.entries()) {
      if (!allowNonConvergence) for (const otherId of group.nodes.slice(index + 1)) {
        const a = model.nodes[id]!.bounds!, b = model.nodes[otherId]!.bounds!, gap = nodeGap(model, id, otherId);
        const dx = Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0);
        const dy = Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0);
        if (Math.hypot(dx, dy) < gap - 1e-6) throw new Error(`Nodes ${id} and ${otherId} violate clearance`);
      }
      const box = model.nodes[id]!.bounds!, outer = group.bounds;
      if (!allowNonConvergence && (box.x < outer.x || box.y < outer.y || box.x + box.width > outer.x + outer.width + 1e-6
        || box.y + box.height > outer.y + outer.height + 1e-6)) throw new Error(`Node ${id} is outside its group`);
    }
  }
  if (!allowNonConvergence && Object.keys(model.groups).length && validateSkeletonBands(model).length) throw new Error('Invalid group or tier geometry');
  if (!model.canvas || model.canvas.width < 0 || model.canvas.height < 0) throw new Error('Invalid canvas');
  same(model.tierBands.map(band => ({ tier: band.tier, groups: [...band.groups].sort() })),
    [...new Set(Object.values(model.groups).map(group => group.tier!))].sort((a, b) => a - b)
      .map(tier => ({ tier, groups: Object.values(model.groups).filter(group => group.tier === tier).map(group => group.id).sort() })),
    'Tier band membership differs from groups');
  if (new Set(model.labels.map(label => label.id)).size !== model.labels.length) throw new Error('Duplicate label IDs');
}
function validateFreeze(model: LayoutModel): void {
  const freeze = model.freeze;
  if (!freeze || freeze.version !== 1) throw new Error('Missing or unsupported topology freeze');
  same(topology(model), freeze.topology, 'Frozen port topology changed');
  same(freeze.floors.map(floor => floor.node), orderedNodeIds(model.document), 'Frozen floors omit or repeat nodes');
  for (const floor of freeze.floors) if (floor.size.width <= 0 || floor.size.height <= 0) throw new Error('Invalid frozen floor');
  if (stages.indexOf(model.stage) >= stages.indexOf('bands')) {
    if (!freeze.placement) throw new Error('Missing final placement freeze');
    same(placement(model), freeze.placement, 'Final placement changed');
  } else if (freeze.placement) throw new Error('Premature placement freeze');
}

/** Publish a clone. The caller must retain this immutable return value. */
export function freezePortTopology(model: LayoutModel): LayoutModel {
  if (model.stage !== 'sides-two' || model.freeze) throw new Error('Topology can freeze only once at sides-two');
  jsonValue(model);
  const baseline = validateDocument(model);
  const result = clone(model);
  result.freeze = { version: 1, topology: clone(topology(model)),
    floors: orderedNodeIds(model.document).map(id => ({ node: id, size: { ...model.nodes[id]!.sizeFloor! } })) };
  return protect(result, baseline);
}

/** Resume serialized output through this API; JSON.parse alone returns unprotected data. */
export function restoreLayoutModel(json: string): LayoutModel {
  const model = JSON.parse(json) as LayoutModel;
  jsonValue(model);
  if (!model || !stages.includes(model.stage) || !model.runtime || !Array.isArray(model.runtime.stages)) throw new Error('Invalid layout model');
  if (stages.indexOf(model.stage) < stages.indexOf('sides-two')) {
    if (model.freeze) throw new Error('Premature topology freeze');
    resolve(model.document);
    return model;
  }
  const baseline = validateDocument(model);
  return protect(model, baseline);
}

const permissions: Record<PlacementRule, { move: boolean; reorder: boolean }> = {
  rows: { move: true, reorder: false }, lanes: { move: true, reorder: false },
  flanks: { move: true, reorder: false }, centre: { move: true, reorder: false },
  bars: { move: true, reorder: true }, bundles: { move: true, reorder: true }, bands: { move: true, reorder: false },
  route: { move: false, reorder: false }, 'link-labels': { move: false, reorder: false },
  validate: { move: false, reorder: false }, emit: { move: false, reorder: false },
};
function diagnosed(model: LayoutModel): boolean {
  return model.diagnostics.some(d => d.stage === 'placement' && d.code === 'PLACEMENT_NON_CONVERGENCE');
}
function claims(model: LayoutModel) {
  return { links: model.links, lanes: model.lanes, bundles: model.bundles, junctions: model.junctions,
    labelBands: model.labelBands, barDrops: model.barDrops, obstacles: model.obstacles,
    labels: model.labels.filter(label => !['node', 'description', 'pill'].includes(label.role ?? '')) };
}
function hasUnsupportedClaims(model: LayoutModel): boolean {
  const rowStage = stages.indexOf(model.stage) >= stages.indexOf('rows');
  return model.links.some(link => link.path !== undefined && !(rowStage && rowPathCandidate(model, link)))
    || model.lanes.length > 0 || model.barDrops.length > 0
    || model.regions.length > 0 || model.junctions.length > 0
    || model.bundles.some(b => b.rows !== undefined || b.centreline !== undefined || b.envelope !== undefined || b.memberGap !== undefined || b.inversions !== undefined)
    || model.obstacles.length > 0 || model.labelBands.length > 0 || claims(model).labels.length > 0;
}
function rebuildBoxes(model: LayoutModel): void {
  for (const group of Object.values(model.groups)) {
    if (!group.nodes.length) continue;
    const box = union(group.nodes.map(id => model.nodes[id]!.bounds!)), old = group.bounds!;
    const x = Math.min(old.x, box.x - 12), y = Math.min(old.y, box.y - 12);
    group.bounds = { x, y, width: Math.max(old.x + old.width, box.x + box.width + 12) - x,
      height: Math.max(old.y + old.height, box.y + box.height + 12) - y };
  }
  rebuildBands(model);
  if (Object.keys(model.groups).length) {
    const box = union(Object.values(model.groups).map(group => group.bounds!)), old = model.canvas ?? box;
    const x = Math.min(old.x, box.x), y = Math.min(old.y, box.y);
    model.canvas = { x, y, width: Math.max(old.x + old.width, box.x + box.width) - x,
      height: Math.max(old.y + old.height, box.y + box.height) - y };
  }
}

/** One synchronous checked commit per stage. Future producers extend the closed validators here. */
export function withLayoutMutation(model: LayoutModel, rule: PlacementRule, edit: (draft: LayoutModel) => void): LayoutModel {
  if (!protectedModels.has(model)) throw new Error('Mutation requires a protected snapshot; use restoreLayoutModel');
  if (!Object.hasOwn(permissions, rule) || stages[stages.indexOf(model.stage) + 1] !== rule) throw new Error(`Incorrect predecessor stage for ${rule}`);
  const started = Date.now(), draft = clone(model), permission = permissions[rule];
  const returned = edit(draft);
  if (returned !== undefined) throw new Error('Mutation callback must be synchronous and return void');
  jsonValue(draft);
  validateRect(draft.canvas, 'canvas');
  same(omit(draft, ['nodes', 'groups', 'tierBands', 'labels', 'canvas', 'diagnostics', 'runtime', 'links', 'lanes', 'bundles', 'junctions', 'labelBands', 'barDrops', 'obstacles', 'regions']),
    omit(model, ['nodes', 'groups', 'tierBands', 'labels', 'canvas', 'diagnostics', 'runtime', 'links', 'lanes', 'bundles', 'junctions', 'labelBands', 'barDrops', 'obstacles', 'regions']), 'Undeclared model field changed');
  same(draft.stage, model.stage, 'Transaction owns the stage marker');
  same(draft.document, model.document, 'Document changed'); same(draft.freeze, model.freeze, 'Freeze metadata changed');
  same(structure(draft), structure(model), 'Topology or membership changed');
  same(semantics(draft), semantics(model), 'Resolved semantics changed');
  for (const [index, link] of draft.links.entries()) {
    if (rowPathCandidate(model, link) && !equal(pick(link, ['path', 'technique']), pick(model.links[index]!, ['path', 'technique']))) {
      throw new Error(`Row path on ${link.id} is derived by the transaction from final anchors; callbacks cannot edit it`);
    }
  }
  same(claims(draft), claims(model), `${rule} claim validator/rebuild is not implemented`);
  same(draft.regions, model.regions, `${rule} region rebuild is not implemented`);
  const before = placement(model), after = placement(draft);
  const changed = !equal(before, after);
  if (changed && !permission.move) throw new Error(`${rule} cannot change placement`);
  if (changed && hasUnsupportedClaims(model)) throw new Error(`${rule} requires an unimplemented claim rebuild`);
  // Rebuild containing boxes and node content first, so every rule check below sees the final geometry.
  if (changed) { rebuildBoxes(draft); rebuildNodeGeometry(draft, orderedNodeIds(draft.document), 'current'); }
  const bundledPorts = new Set(model.links.filter(link => link.bundle).flatMap(link => [JSON.stringify(link.attachments!.from), JSON.stringify(link.attachments!.to)]));
  const flankSides = new Map<string, Set<string>>();
  for (const group of Object.values(model.groups).filter(group => group.flank)) {
    const flank = group.flank!;
    for (const id of group.nodes) { const sides = flankSides.get(id) ?? new Set(); sides.add(flank.align === 'left' ? 'right' : 'left'); flankSides.set(id, sides); }
    if (flank.primaryPeer) { const sides = flankSides.get(flank.primaryPeer) ?? new Set(); sides.add(flank.align); flankSides.set(flank.primaryPeer, sides); }
  }
  for (const [id, group] of Object.entries(draft.groups)) {
    same(omit(group, ['bounds']), omit(model.groups[id]!, ['bounds']), 'Undeclared group field changed');
    if (rule === 'rows' && group.flank) same(group, model.groups[id], 'Rows cannot move flank groups');
    if (rule === 'rows' && !group.flank && draft.document.groups[id]!.shape !== 'row') same(group, model.groups[id], 'Rows cannot change non-row groups');
    if (rule === 'flanks' && group.flank) same(group.bounds!.x, model.groups[id]!.bounds!.x, 'Flanks cannot translate groups horizontally');
    if (rule === 'bars' && draft.document.groups[id]!.shape !== 'bar') same(group, model.groups[id], 'Bars cannot move another group');
    if (rule === 'flanks' && !group.flank && !Object.values(model.groups).some(g => g.flank?.of === id)) same(group, model.groups[id], 'Flanks cannot move another group');
  }
  if (model.canvas && draft.canvas && (draft.canvas.x > model.canvas.x || draft.canvas.y > model.canvas.y
    || draft.canvas.x + draft.canvas.width < model.canvas.x + model.canvas.width
    || draft.canvas.y + draft.canvas.height < model.canvas.y + model.canvas.height)) throw new Error('Canvas may only expand');
  const flankNodes = new Set(Object.values(model.groups).filter(group => group.flank).flatMap(group => [...group.nodes, ...(group.flank!.primaryPeer ? [group.flank!.primaryPeer] : [])]));
  for (const id of orderedNodeIds(model.document)) {
    const old = model.nodes[id]!, node = draft.nodes[id]!;
    same(omit(node, ['bounds', 'size', 'sidePitch', 'ports', 'icon']), omit(old, ['bounds', 'size', 'sidePitch', 'ports', 'icon']), 'Undeclared node field changed');
    node.ports.forEach((port, index) => {
      same(omit(port, ['engineOrder', 'anchor', 'pill']), omit(old.ports[index]!, ['engineOrder', 'anchor', 'pill']), 'Undeclared port field changed');
      if (rule === 'bundles' && !bundledPorts.has(JSON.stringify(port.ref))) same(port.engineOrder, old.ports[index]!.engineOrder, 'Bundles cannot reorder unrelated ports');
    });
    same(node.sizeFloor, old.sizeFloor, 'Stored content floor changed');
    same(node.contentSize, old.contentSize, 'Measured content changed');
    same(node.contentInsets, old.contentInsets, 'Content insets changed');
    if (!permission.reorder) same(node.ports.map(port => port.engineOrder), old.ports.map(port => port.engineOrder), `${rule} cannot reorder ports`);
    for (const side of SIDE_TIE_ORDER) {
      if (node.sidePitch![side]! < old.sidePitch![side]!) throw new Error('Pitch cannot decrease');
      if (rule !== 'flanks' || !flankSides.get(id)?.has(side)) same(node.sidePitch![side], old.sidePitch![side], `${rule} cannot change pitch`);
    }
    if (rule === 'bars' && draft.document.groups[draft.document.nodes[id]!.group]!.shape !== 'bar') same(node, old, 'Bars cannot change non-bar nodes');
    if (rule === 'flanks' && !flankNodes.has(id)) same(node, old, 'Flanks cannot change unrelated nodes');
    if (rule === 'rows') {
      same(node.size, old.size, 'Rows cannot resize nodes');
      if (model.groups[model.document.nodes[id]!.group]!.flank) same(node, old, 'Rows cannot move flank nodes');
      if (draft.document.groups[draft.document.nodes[id]!.group]!.shape !== 'row') same(node, old, 'Rows cannot move bar nodes');
    }
    if (rule === 'lanes') same(node, old, 'Lanes cannot move node geometry');
    if (rule === 'centre') {
      same(node.bounds!.y, old.bounds!.y, 'Centring cannot change y');
      same(node.size!.height, old.size!.height, 'Centring cannot change height');
      if (node.size!.width < old.size!.width) throw new Error('Centring cannot shrink width');
      const group = model.groups[model.document.nodes[id]!.group]!;
      if (group.tier === model.anchorTier || group.flank) same(node, old, 'Centring cannot move anchor tier or flanks');
    }
    if (rule === 'bundles') {
      same(node.size, old.size, 'Bundles cannot resize nodes');
      same(node.bounds!.x, old.bounds!.x, 'Bundles cannot translate nodes horizontally');
      const dy = node.bounds!.y - old.bounds!.y;
      if (dy < 0) throw new Error('Bundles may only grow tier gaps');
      node.ports.forEach((port, index) => {
        const prior = old.ports[index]!;
        if (!bundledPorts.has(JSON.stringify(port.ref))) same(port.anchor, { x: prior.anchor!.x, y: prior.anchor!.y + dy }, 'Bundles must translate unrelated anchors with nodes');
      });
    }
    if (rule === 'flanks') {
      if (node.size!.width < old.size!.width || node.size!.height < old.size!.height) throw new Error('Flanks cannot shrink nodes');
      const group = model.groups[model.document.nodes[id]!.group]!;
      same(node.bounds!.x, old.bounds!.x, 'Flanks cannot translate nodes horizontally');
      if (!group.flank) same(pick(node.bounds!, ['x', 'y']), pick(old.bounds!, ['x', 'y']), 'Flanks cannot translate primary peer');
    }
  }
  // The rows rule produces row paths; any later movement replaces them from the final anchors.
  if (changed || rule === 'rows') rebuildRowPaths(draft);
  draft.stage = rule;
  draft.runtime.stages.push({ stage: rule, durationMs: Date.now() - started });
  if (rule === 'bands') draft.freeze!.placement = clone(placement(draft));
  return protect(draft, model);
}
