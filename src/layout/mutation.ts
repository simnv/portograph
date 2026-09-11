import { equal } from '../model/json-equality.js';
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
import { flankPathCandidate, rebuildFlankPaths, normalizePrimaryBundlePorts, flankPair } from './flanks.js';
import { rebuildLaneExtents, validateLanes, transitTiers } from './lanes.js';
import { rebuildRegions } from './regions.js';
import { selectAnchorTier } from './centre.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { barLink, rebuildBarDrops, shapeBars } from './bars.js';
import { rebuildBundlePaths } from './bundle-paths.js';
import { produceGroupLabelBands, validateGroupLabelBands } from './bands.js';
import { produceLinkLabels, validateLinkLabels } from './link-labels.js';
import { validateRoutedPaths } from '../route/validate.js';

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
    ...pick(model, ['fallbackUsed', 'deadlineHit']),
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
    sharedRuns: model.links.filter(link => link.sharedRuns !== undefined).map(link => ({ link: link.id, runs: link.sharedRuns! })),
    fixedSegments: model.links.filter(link => link.fixedSegments !== undefined).map(link => ({ link: link.id, segments: link.fixedSegments! })),
    labels: model.labels.filter(label => ['node', 'description', 'pill', 'group'].includes(label.role ?? '')),
  };
}
function nonBarHorizontalPlacement(model: LayoutModel): unknown {
  const groups = Object.values(model.groups).filter(group => model.document.groups[group.id]!.shape !== 'bar');
  const nodes = groups.flatMap(group => group.nodes).map(id => model.nodes[id]!);
  return {
    groups: groups.map(group => ({ id: group.id, x: group.bounds!.x, width: group.bounds!.width })),
    nodes: nodes.map(node => ({ id: node.id, x: node.bounds!.x, width: node.bounds!.width,
      ports: node.ports.map(port => port.anchor!.x) })),
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
      && ((stages.indexOf(model.stage) >= stages.indexOf('rows') && rowPathCandidate(model, link))
        || (stages.indexOf(model.stage) >= stages.indexOf('flanks') && flankPathCandidate(model, link))
        || (stages.indexOf(model.stage) >= stages.indexOf('bars') && barLink(model, link) !== undefined))
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
  validateRegionClaims(model);
}
/** The same ordered producers validate every publication, including restored JSON. */
function validateRegionClaims(model: LayoutModel): void {
  const expected = clone(model);
  const barStage = stages.indexOf(model.stage) >= stages.indexOf('bars');
  const bundleStage = stages.indexOf(model.stage) >= stages.indexOf('bundles');
  if (barStage) {
    shapeBars(expected);
    for (const id of orderedGroupIds(model.document)) if (model.document.groups[id]!.shape === 'bar') {
      same(model.groups[id], expected.groups[id], `Bar group ${id} contradicts declaration-order geometry`);
      for (const nodeId of model.groups[id]!.nodes) same(model.nodes[nodeId], expected.nodes[nodeId], `Bar ${nodeId} contradicts source slots or span rules`);
    }
  }
  if (stages.indexOf(model.stage) >= stages.indexOf('lanes')) {
    validateLanes(model);
    rebuildRegions(expected);
    same(model.regions, expected.regions, 'Region geometry contradicts current groups');
  }
  if (stages.indexOf(model.stage) >= stages.indexOf('centre')) same(model.anchorTier, selectAnchorTier(model), 'Anchor tier contradicts node count or tie rule');
  else if (model.anchorTier !== undefined) throw new Error('Premature anchor tier');
  if (stages.indexOf(model.stage) < stages.indexOf('rows')) return;
  // Clear both kinds together so stale paths cannot suppress their replacements.
  for (const link of expected.links) if (rowPathCandidate(expected, link) || flankPathCandidate(expected, link)) delete link.path;
  rebuildRowPaths(expected);
  const flankStage = stages.indexOf(model.stage) >= stages.indexOf('flanks');
  if (flankStage) {
    if (!bundleStage) {
      const ordered = clone(model); normalizePrimaryBundlePorts(ordered);
      for (const id of Object.keys(model.nodes)) same(model.nodes[id]!.ports.map(port => port.engineOrder), ordered.nodes[id]!.ports.map(port => port.engineOrder), 'Primary bundle facing order contradicts normalization');
    }
    rebuildFlankPaths(expected);
  }
  if (barStage) rebuildBarDrops(expected);
  if (bundleStage) {
    rebuildBundlePaths(expected);
    same(model.bundles, expected.bundles, 'Bundle reservations contradict final paths');
    same(model.junctions, expected.junctions, 'Junctions contradict shared incidence');
    same(model.links.map(l => l.sharedRuns), expected.links.map(l => l.sharedRuns), 'Shared runs contradict port incidence');
    for (const [index, link] of model.links.entries()) if (link.bundle) same(link.path, expected.links[index]!.path, `Bundle path on ${link.id} contradicts final anchors`);
  }
  // A candidate its rule declined to pin is unclaimed geometry; stage 8 owns it from then on, and
  // validateRoutedPaths judges what the router produced. A pinned path is still exactly the rule's.
  const routeStage = stages.indexOf(model.stage) >= stages.indexOf('route');
  const ruled = (index: number): boolean => !routeStage || expected.links[index]!.path !== undefined;
  // `fixed` means "a region rule produced this", so only a rule that really pinned this link may
  // set it. Without this check a forged fixed path would skip the whole stage-8 contract,
  // reservation avoidance included. Every rule below rebuilds its own paths into `expected`.
  const ruleOwned = (link: LayoutModel['links'][number]): boolean => link.bundle !== undefined
    || rowPathCandidate(model, link) || (flankStage && flankPathCandidate(model, link))
    || (barStage && barLink(model, link) !== undefined);
  if (routeStage) for (const [index, link] of model.links.entries()) {
    if (link.path?.fixed === true && !(ruleOwned(link) && expected.links[index]!.path !== undefined)) {
      throw new Error(`Path on ${link.id} claims a region rule fixed it`);
    }
  }
  for (const [index, link] of model.links.entries()) {
    if (!rowPathCandidate(model, link) && !(flankStage && flankPathCandidate(model, link))) continue;
    const name = rowPathCandidate(model, link) ? 'Row' : 'Flank';
    if (ruled(index)) same(link.path, expected.links[index]!.path, `${name} path on ${link.id} contradicts the region rule`);
    same(link.technique, expected.links[index]!.technique, `${name} path technique on ${link.id} contradicts the region rule`);
  }
  if (barStage) {
    same(model.barDrops, expected.barDrops, 'Bar drop reservations contradict current bars and fixed lanes');
    for (const [index, link] of model.links.entries()) if (barLink(model, link)) {
      if (ruled(index)) same(link.path, expected.links[index]!.path, `Bar path on ${link.id} contradicts its reservation`);
      same(link.technique, expected.links[index]!.technique, `Bar path technique on ${link.id} contradicts its reservation`);
    }
  }
  if (stages.indexOf(model.stage) >= stages.indexOf('bands')) validateGroupLabelBands(model);
  // Route geometry cannot be re-derived without the router, so its claims are checked structurally.
  if (stages.indexOf(model.stage) >= stages.indexOf('route')) validateRoutedPaths(model, stages.indexOf(model.stage) > stages.indexOf('route'));
  if (stages.indexOf(model.stage) >= stages.indexOf('link-labels')) validateLinkLabels(model);
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
      const group = model.document.groups[model.document.nodes[id]!.group]!;
      const text = node.ports.length ? model.document.nodes[id]!.label : group.label;
      const label = measureText(text, { fontSize: NODE_CONTENT_GEOMETRY.labelFontSize, weight: NODE_CONTENT_GEOMETRY.labelFontWeight });
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
  flanks: { move: true, reorder: true }, centre: { move: true, reorder: false },
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
  const laneStage = stages.indexOf(model.stage) >= stages.indexOf('lanes');
  const flankStage = stages.indexOf(model.stage) >= stages.indexOf('flanks');
  const barStage = stages.indexOf(model.stage) >= stages.indexOf('bars');
  const bundleStage = stages.indexOf(model.stage) >= stages.indexOf('bundles');
  const bandsStage = stages.indexOf(model.stage) >= stages.indexOf('bands');
  // Stage 8 owns every remaining path; validateRoutedPaths then judges the geometry it produced.
  const routeStage = stages.indexOf(model.stage) >= stages.indexOf('route');
  // Stage 9 owns link and multiplicity labels; validateLinkLabels re-derives the ones it published.
  const labelStage = stages.indexOf(model.stage) >= stages.indexOf('link-labels');
  const nonNodeLabels = claims(model).labels;
  return model.links.some(link => (link.path !== undefined && !(routeStage || (rowStage && rowPathCandidate(model, link)) || (flankStage && flankPathCandidate(model, link))
      || (barStage && barLink(model, link) !== undefined) || (bundleStage && link.bundle !== undefined)))
      || (link.stubCandidate !== undefined && !routeStage)
      || (link.fixedSegments !== undefined && !laneStage) || (link.sharedRuns !== undefined && !bundleStage))
    || (!laneStage && (model.lanes.length > 0 || model.regions.length > 0)) || (!barStage && model.barDrops.length > 0)
    || (!bundleStage && model.junctions.length > 0)
    || (!bundleStage && model.bundles.some(b => b.rows !== undefined || b.centreline !== undefined || b.envelope !== undefined || b.envelopeParts !== undefined || b.memberGap !== undefined || b.inversions !== undefined || b.memberPitch !== undefined || b.mergeRuns !== undefined))
    || model.obstacles.length > 0 || (!bandsStage && model.labelBands.length > 0)
    || nonNodeLabels.some(label => !(bandsStage && label.role === 'group') && !(labelStage && label.role === 'link'));
}
function rebuildBoxes(model: LayoutModel): void {
  const EPS = 1e-6;
  for (const group of Object.values(model.groups)) {
    if (!group.nodes.length) continue;
    const box = union(group.nodes.map(id => model.nodes[id]!.bounds!)), old = group.bounds!;
    const derivedLeft = box.x - 12, derivedTop = box.y - 12;
    const oldRight = old.x + old.width, oldBottom = old.y + old.height;
    const derivedRight = box.x + box.width + 12, derivedBottom = box.y + box.height + 12;
    const x = derivedLeft < old.x - EPS ? derivedLeft : old.x;
    const y = derivedTop < old.y - EPS ? derivedTop : old.y;
    const farX = derivedRight > oldRight + EPS ? derivedRight : oldRight;
    const farY = derivedBottom > oldBottom + EPS ? derivedBottom : oldBottom;
    group.bounds = { x, y, width: farX - x, height: farY - y };
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
  same(omit(draft, ['nodes', 'groups', 'tierBands', 'labels', 'canvas', 'diagnostics', 'runtime', 'links', 'lanes', 'bundles', 'junctions', 'labelBands', 'barDrops', 'obstacles', 'regions', 'anchorTier']),
    omit(model, ['nodes', 'groups', 'tierBands', 'labels', 'canvas', 'diagnostics', 'runtime', 'links', 'lanes', 'bundles', 'junctions', 'labelBands', 'barDrops', 'obstacles', 'regions', 'anchorTier']), 'Undeclared model field changed');
  same(draft.stage, model.stage, 'Transaction owns the stage marker');
  same(draft.document, model.document, 'Document changed'); same(draft.freeze, model.freeze, 'Freeze metadata changed');
  same(structure(draft), structure(model), 'Topology or membership changed');
  if (rule === 'centre') {
    if (draft.anchorTier !== undefined) same(draft.anchorTier, selectAnchorTier(draft), 'Invalid anchor tier');
    const anchor = selectAnchorTier(draft);
    if (anchor !== undefined) draft.anchorTier = anchor;
  } else same(draft.anchorTier, model.anchorTier, 'Anchor tier can initialize only in centre');
  same(semantics(draft), semantics(model), 'Resolved semantics changed');
  for (const [index, link] of draft.links.entries()) {
    // A candidate its rule declined to pin stays unclaimed, and stage 8 may complete it.
    const unpinned = rule === 'route' && model.links[index]!.path === undefined;
    const owned = unpinned ? (['technique'] as const) : (['path', 'technique'] as const);
    if ((rowPathCandidate(model, link) || (stages.indexOf(model.stage) >= stages.indexOf('flanks') && flankPathCandidate(model, link))
      || (stages.indexOf(model.stage) >= stages.indexOf('bars') && barLink(model, link)))
      && !equal(pick(link, owned), pick(model.links[index]!, owned))) {
      throw new Error(`Path on ${link.id} is derived by the transaction from final anchors; callbacks cannot edit it`);
    }
  }
  // The route rule owns exactly the remaining paths and their stub marks; nothing else may move.
  const linkFields = rule === 'route' ? ['fixedSegments', 'path', 'stubCandidate'] : ['fixedSegments'];
  const otherClaims = (value: LayoutModel) => ({ ...claims(value), lanes: [], links: value.links.map(link => omit(link, linkFields)) });
  // Stage 9's producer owns every link and multiplicity label, exactly as 7f owns group labels.
  if (rule === 'link-labels') same(draft.labels, model.labels, 'Link-label callback cannot author labels');
  same(otherClaims(draft), otherClaims(model), `${rule} claim validator/rebuild is not implemented`);
  if (rule === 'route') {
    for (const [index, link] of draft.links.entries()) {
      const prior = model.links[index]!;
      if (prior.path !== undefined) same(link.path, prior.path, `Route cannot change the path a rule already fixed on ${link.id}`);
    }
  }
  if (rule !== 'lanes') {
    same(draft.lanes.map(lane => ({ ...lane, bounds: pick(lane.bounds, ['x', 'width']) })),
      model.lanes.map(lane => ({ ...lane, bounds: pick(lane.bounds, ['x', 'width']) })), 'Established lane identity, owner, x and width cannot change');
  } else if (model.lanes.length) throw new Error('Lanes cannot be reallocated');
  const supplied = clone(draft);
  rebuildRegions(supplied); rebuildLaneExtents(supplied);
  if (!equal(draft.regions, model.regions)) same(draft.regions, supplied.regions, 'Callback regions contradict current geometry');
  if (rule !== 'lanes') {
    for (const [index, link] of draft.links.entries()) if (!equal(link.fixedSegments, model.links[index]!.fixedSegments)) {
      same(link.fixedSegments, supplied.links[index]!.fixedSegments, 'Callback fixed segments contradict lane extents');
    }
    for (const [index, lane] of draft.lanes.entries()) if (!equal(lane.bounds, model.lanes[index]!.bounds)) same(lane.bounds, supplied.lanes[index]!.bounds, 'Callback lane extent contradicts current geometry');
  }
  const before = placement(model), after = placement(draft);
  if (rule === 'bands') same(after, before, 'Bands callback cannot author placement or derived claims');
  const changed = !equal(before, after);
  if (changed && !permission.move) throw new Error(`${rule} cannot change placement`);
  if (changed && hasUnsupportedClaims(model)) throw new Error(`${rule} requires an unimplemented claim rebuild`);
  // Rebuild containing boxes and node content first, so every rule check below sees the final geometry.
  if (changed) { rebuildBoxes(draft); rebuildNodeGeometry(draft, orderedNodeIds(draft.document), 'current'); }
  const flankOrder = clone(model);
  if (rule === 'flanks') normalizePrimaryBundlePorts(flankOrder);
  const bundledPorts = new Set(model.links.filter(link => link.bundle).flatMap(link => [JSON.stringify(link.attachments!.from), JSON.stringify(link.attachments!.to)]));
  const flankSides = new Map<string, Set<string>>();
  for (const link of model.links) {
    const pair = flankPair(model, link);
    if (!pair) continue;
    for (const port of [pair.own, pair.peer]) {
      const sides = flankSides.get(port.ref.node) ?? new Set<string>();
      sides.add(port.side!); flankSides.set(port.ref.node, sides);
    }
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
    if (rule === 'flanks') same(node.ports.map(port => port.engineOrder), flankOrder.nodes[id]!.ports.map(port => port.engineOrder), 'Flanks may reorder only the compatible primary bundle block');
    if (!permission.reorder) same(node.ports.map(port => port.engineOrder), old.ports.map(port => port.engineOrder), `${rule} cannot reorder ports`);
    for (const side of SIDE_TIE_ORDER) {
      const authored = node.ports.filter(p => p.side === side && p.authorOrder !== undefined);
      for (const ordered of [[...authored].sort((a, b) => a.engineOrder! - b.engineOrder!),
        [...authored].sort((a, b) => side === 'top' || side === 'bottom' ? a.anchor!.x - b.anchor!.x : a.anchor!.y - b.anchor!.y)]) {
        if (ordered.some((p, i) => i > 0 && p.authorOrder! < ordered[i - 1]!.authorOrder!)) throw new Error(`Author order reversed on ${id}.${side}`);
      }
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
    if (rule === 'lanes') {
      same(node.size, old.size, 'Lanes cannot resize nodes');
      const group = model.groups[model.document.nodes[id]!.group]!;
      const dx = draft.groups[group.id]!.bounds!.x - group.bounds!.x;
      same(node.bounds, { ...old.bounds!, x: old.bounds!.x + dx }, 'Lanes permit only whole-group horizontal translation');
      node.ports.forEach((port, i) => same(port.anchor, { x: old.ports[i]!.anchor!.x + dx, y: old.ports[i]!.anchor!.y }, 'Lane translation must preserve relative anchors'));
      if (dx && !model.links.some(link => transitTiers(model, link).includes(group.tier!))) throw new Error('Lanes may expand only occupied intermediate tiers');
      if (dx && model.links.some(link => transitTiers(model, link).length && model.document.nodes[link.attachments!.from.node]!.group === group.id)) throw new Error('Lanes cannot move transit source anchors');
    }
    if (rule === 'centre') {
      same(node.bounds!.y, old.bounds!.y, 'Centring cannot change y');
      same(node.size!.height, old.size!.height, 'Centring cannot change height');
      if (node.size!.width < old.size!.width) throw new Error('Centring cannot shrink width');
      const group = model.groups[model.document.nodes[id]!.group]!;
      if (group.tier === draft.anchorTier || group.flank) same(node, old, 'Centring cannot move anchor tier or flanks');
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
      const dy = node.bounds!.y - old.bounds!.y;
      if (group.flank) same(dy, draft.groups[group.id]!.bounds!.y - group.bounds!.y, 'Flank nodes require a common vertical translation with their group');
      const dw = node.size!.width - old.size!.width, dh = node.size!.height - old.size!.height;
      node.ports.forEach((port, index) => {
        if (flankSides.get(id)?.has(port.side!)) return;
        const prior = old.ports[index]!.anchor!;
        same(port.anchor, { x: prior.x + (port.side === 'right' ? dw : 0), y: prior.y + dy + (port.side === 'bottom' ? dh : 0) },
          'Flanks cannot change an unrelated anchor except for common translation or boundary growth');
      });
    }
  }
  // The rows rule produces row paths; any later movement replaces them from the final anchors.
  if (stages.indexOf(rule) >= stages.indexOf('lanes') && permission.move) {
    rebuildRegions(draft);
    if (rule !== 'lanes') rebuildLaneExtents(draft);
  }
  if (rule === 'bands') produceGroupLabelBands(draft);
  else if (rule === 'link-labels') produceLinkLabels(draft);
  else if (changed || ['rows', 'lanes', 'flanks', 'centre', 'bundles'].includes(rule)) {
    if (stages.indexOf(rule) >= stages.indexOf('flanks')) {
      rebuildRegionGeometry(draft, undefined, rule === 'bars' ? model.tierBands : undefined, rule === 'bundles' || stages.indexOf(model.stage) >= stages.indexOf('bundles'));
      if (rule === 'bars') same(nonBarHorizontalPlacement(draft), nonBarHorizontalPlacement(model),
        'Bars may translate downstream tiers only vertically');
    }
    else rebuildRowPaths(draft);
  }
  if (rule === 'bars') rebuildBarDrops(draft);
  draft.stage = rule;
  draft.runtime.stages.push({ stage: rule, durationMs: Date.now() - started });
  if (rule === 'bands') draft.freeze!.placement = clone(placement(draft));
  return protect(draft, model);
}
