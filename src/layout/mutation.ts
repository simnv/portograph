import { validateReservations } from './reservations.js';
import { validateStaggerRows } from './stagger.js';
import { validateGroupLifts } from './lift.js';
import { validateFeedSplits } from './feed-split.js';
import { equal } from '../model/json-equality.js';
import type { Rect, Side, Size } from '../model/geometry.js';
import type { Lane, LayoutFreeze, LayoutModel, LayoutStage, MeshBus, PlacementSnapshot } from '../model/layout.js';
import { orderedNodeIds, orderedGroupIds } from '../model/model.js';
import { resolve } from '../resolve/index.js';
import { filterCss } from '../parse/css.js';
import { Validation } from '../parse/validation.js';
import { portKey, sidesOne, SIDE_TIE_ORDER } from './sides-one.js';
import { sizeNodes } from './size.js';
import { lateralPillInset, portSideCapacity, validatePortCorners } from './port-insets.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { measureText } from '../text/index.js';
import { NODE_CONTENT_GEOMETRY } from '../theme/content.js';
import { nodeGap } from './skeleton-graph.js';
import { groupShape } from './grid.js';
import { hintRefusal } from './side-hints.js';
import { SideHintRefusal } from './placement-refusal.js';
import { PlacementRefusal } from './placement-refusal.js';
import { rebuildBands, span, union, validateSkeletonBands } from './skeleton-geometry.js';
import { rebuildRowPaths, rowPathCandidate } from './row-paths.js';
import { flankPathCandidate, rebuildFlankPaths, normalizePrimaryBundlePorts, flankPair } from './flanks.js';
import { heldSourceGroups, rebuildLaneExtents, validateLanes, transitTiers } from './lanes.js';
import { freezeChords, spanCandidate } from './frame-paths.js';
import { faceKey, laneFaceOrder } from './turn-order.js';
import { isCourseLane, sameCourses, validateCourses } from './courses.js';
import { rebuildFrames } from './frames.js';
import { groupPadding, rebuildRegions } from './regions.js';
import { centreItemLink, publishedCentreViolations, selectAnchorTier } from './centre.js';
import { ALIGNMENT_TARGETS_DIFFER, alignmentTargetsFault } from './alignment-targets.js';
import { givenBackFault } from './given-back.js';
import { checkBodyTrims } from './end-trim.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { barLink, rebuildBarDrops, shapeBars } from './bars.js';
import { rebuildBundlePaths } from './bundle-paths.js';
import { reserveBlockGaps } from './solid-blocks.js';
import { moveBands } from './gap-room.js';
import { produceGroupLabelBands, validateGroupLabelBands } from './bands.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { produceLinkLabels, validateLinkLabels } from './link-labels.js';
import { validateRoutedPaths } from '../route/validate.js';
import { placementAttempt, type AttemptTraceEvent } from './placement-attempt.js';
import { judgePostconditions } from './postconditions.js';
import { columnOf } from './read/arrangement.js';

export type PlacementRule = 'rows' | 'lanes' | 'flanks' | 'centre' | 'bars' | 'bundles'
  | 'bands' | 'route' | 'link-labels' | 'validate' | 'emit';
const stages: LayoutStage[] = ['normalised', 'resolve', 'sides-one', 'size', 'skeleton', 'sides-two',
  'rows', 'lanes', 'flanks', 'centre', 'bars', 'bundles', 'bands', 'route', 'link-labels', 'validate', 'emit'];
const protectedModels = new WeakSet<LayoutModel>();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/**
 * While one publication is validated its model does not change, and each validator clones it. The model is serialized once and every
 * clone parses that text. The one write validation makes to the model (a diagnostic) drops the text.
 */
let publishing: { model: LayoutModel; text?: string | undefined } | undefined;
function cloneModel(model: LayoutModel): LayoutModel {
  if (publishing?.model !== model) return clone(model);
  return JSON.parse(publishing.text ??= JSON.stringify(model)) as LayoutModel;
}
function jsonValue(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Layout requires finite numbers');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('Layout must contain JSON values');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Layout must contain plain JSON objects');
    for (const child of Object.values(value)) jsonValue(child);
  }
}
/** A box with its y left out: what a vertical translation keeps. */
function verticalOnly(box: Rect): Omit<Rect, 'y'> { return { x: box.x, width: box.width, height: box.height }; }
function same(a: unknown, b: unknown, message: string): void { if (!equal(a, b)) throw new Error(message); }
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) as Pick<T, K>;
}
function omit(value: object, keys: readonly string[]): object {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function protect(model: LayoutModel, baseline: LayoutModel, intermediate = false): LayoutModel {
  const outer = publishing;
  let result: LayoutModel;
  publishing = { model };
  try {
    validatePublication(model, baseline, intermediate);
    result = cloneModel(model);
  } finally { publishing = outer; }
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(result); protectedModels.add(result); return result;
}
function semantics(model: LayoutModel) {
  return {
    links: model.links.map(link => pick(link, ['id', 'sourceIndex', 'owner', 'from', 'to', 'attachments', 'family', 'layer', 'bundle', 'groupLink', 'meshBus', 'fanFamily', 'solidBlock', 'strokeWidth'])),
    bundles: model.bundles.map(bundle => pick(bundle, ['id', 'owner', 'layer', 'nodes', 'members'])),
    groupLinks: model.groupLinks.map(group => pick(group, ['id', 'owner', 'layer', 'groups', 'members'])),
    meshBuses: (model.meshBuses ?? []).map(bus => pick(bus, ['id', 'owner', 'layer', 'class', 'row', 'placement', 'frames', 'nodes', 'ports', 'members', 'dissolved', 'joined', 'cross', 'meshNodes', 'mesh', 'labelled'])),
    // Stage 1 decides the fan families from the document alone; a stored record must be the one the document gives (architecture-2 ticket 40, R1).
    fanFamilies: model.fanFamilies ?? [],
    declinedSolidBlocks: model.declinedSolidBlocks ?? [],
  };
}
function topology(model: LayoutModel) {
  return orderedNodeIds(model.document).map(id => ({ node: id, ports: model.nodes[id]!.ports.map(port => {
    if (!port.side) throw new Error(`Missing final side on ${id}`);
    return { ref: port.ref, side: port.side, ...pick(port, ['authorOrder', 'sideHint', 'laneHint', 'courseHint', 'naturalSide']) };
  }), ...pick(model.nodes[id]!, ['portCorners']) }));
}
/**
 * What may not change under a rule. `ordered` lifts the row order of a group: the centre rule may
 * order the nodes of a group in which no node has a routed link (ranked-groups spec 3.1); the check
 * for that sits beside the group loop below.
 */
function structure(model: LayoutModel, ordered = false) {
  return {
    nodes: Object.fromEntries(Object.entries(model.nodes).map(([id, node]) => [id, {
      ...pick(node, ['id', 'owner', 'layer', 'strokeWidth', 'portCorners']),
      ports: node.ports.map(port => pick(port, ['ref', 'class', 'side', 'authorOrder', 'owner', 'layer', 'unused', 'sizingSide', 'sideHint', 'laneHint', 'courseHint', 'naturalSide'])),
    }])),
    groups: Object.fromEntries(Object.entries(model.groups).map(([id, group]) => [id, pick(group, ordered ? ['id', 'owner', 'layer', 'nodes', 'tier', 'frame', 'flank'] : ['id', 'owner', 'layer', 'nodes', 'tier', 'frame', 'flank', 'rowOrder'])])),
    ...pick(model, ['fallbackUsed', 'deadlineHit']),
  };
}
function nodeLabels(model: LayoutModel) {
  return model.labels.filter(label => ['node', 'description', 'pill'].includes(label.role ?? ''));
}
function placement(model: LayoutModel): PlacementSnapshot {
  return {
    nodes: Object.fromEntries(Object.entries(model.nodes).map(([id, node]) => [id,
      pick(node, ['bounds', 'size', 'sizeFloor', 'contentSize', 'contentInsets', 'sidePitch', 'portCorners', 'ports', 'icon'])])),
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
/**
 * A restored document must carry the CSS the parser would have produced, and no more.
 *
 * The renderer appends `document.css` after its generated geometry locks, so an author rule of the
 * same specificity and importance wins on the properties it is allowed to change. The parser is
 * what makes that safe: it strips every geometry-changing declaration from `css:` with a warning.
 * A hand-written layout JSON never went through the parser, so without this check
 * `.node-body { stroke-width: 40px !important }` reaches the SVG while `score` still measures 1.5 px
 * — the drawing and the gates would describe different geometry. The check is the *same* policy,
 * not a second one: it re-runs `filterCss` and requires it to remove nothing, so every vendor,
 * custom and palette declaration the parser keeps is still accepted here.
 */
function validateDocumentCss(model: LayoutModel): void {
  const css = model.document.css;
  if (css === undefined) return;
  if (typeof css !== 'string') throw new Error('Document css must be a string');
  const validation = new Validation();
  filterCss(css, validation);
  if (!validation.diagnostics.length) return;
  const codes = validation.diagnostics.map(diagnostic => diagnostic.message).join('; ');
  throw new Error(`Document css is not normalised: ${codes}`);
}

function validateDocument(model: LayoutModel): LayoutModel {
  validateDocumentCss(model);
  const resolved = resolve(model.document, {
    ...(model.declinedTrunks === undefined ? {} : { declinedTrunks: new Map(model.declinedTrunks.map(key => [key, 'declined'] as const)) }),
    ...(model.declinedSolidBlocks === undefined ? {} : { declinedSolidBlocks: new Map(model.declinedSolidBlocks.map(item => [item.family, item.reason])) }),
    // D-Q5: the lifted bands are the document's bands moved by the record; `applyLifts` refuses a record the document does not give.
    ...(Array.isArray(model.groupLifts) ? { groupLifts: model.groupLifts } : {}),
  });
  same(semantics(model), semantics(resolved), 'Resolved semantics differ from document');
  same(Object.keys(model.nodes).sort(), Object.keys(resolved.nodes).sort(), 'Node membership differs from document');
  same(Object.keys(model.groups).sort(), Object.keys(resolved.groups).sort(), 'Group membership differs from document');
  const predicted = sidesOne(resolved);
  validateSideHints(model, resolved);
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!, original = predicted.nodes[id]!;
    same(pick(node, ['id', 'owner', 'layer']), pick(original, ['id', 'owner', 'layer']), 'Node identity differs from document');
    same(node.ports.map(port => pick(port, ['ref', 'class', 'authorOrder', 'owner', 'layer', 'unused'])),
      original.ports.map(port => pick(port, ['ref', 'class', 'authorOrder', 'owner', 'layer', 'unused'])), 'Port identity differs from document');
    // A hinted port stands on the hinted side; the side the document gives is its natural side (ADR-0022).
    original.ports.forEach((port, index) => {
      const stored = node.ports[index]!;
      if (port.side) same(stored.sideHint === true || stored.courseHint === true ? stored.naturalSide : stored.side, port.side, 'Semantic or authored side differs from document');
    });
  }
  for (const id of orderedGroupIds(model.document)) {
    const group = model.groups[id]!, original = predicted.groups[id]!;
    same(pick(group, ['id', 'owner', 'layer', 'nodes', 'tier', 'frame']), pick(original, ['id', 'owner', 'layer', 'nodes', 'tier', 'frame']), 'Group identity differs from document');
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
    if (groupShape(model, group.id) === 'row') {
      const position = (id: string): number => {
        const box = model.nodes[id]!.bounds!;
        return box.x + (model.staggerRows?.some(row => row.group === group.id) || columnOf(model, group.id) ? box.width / 2 : 0);
      };
      for (let i = 1; i < group.rowOrder!.length; i++) {
        if (position(group.rowOrder![i - 1]!) > position(group.rowOrder![i]!) + PLACEMENT_EPS) throw new Error('Physical row order contradicts rowOrder');
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
/**
 * A side hint is an input of placement, so restore checks what it stored, not the round that chose it (side-faces.md, Section 13, review L2):
 * `sideHint` and `naturalSide` come together; the natural side is `top` or `bottom` and is not the port's side; the port is a candidate
 * under Section 4, items 2 to 6, read from the document; and the natural side is the one the stage-5 rule gives. Whether the hint still faces its peer is
 * not checked: restore accepts every layout the pipeline publishes, and 7f names a hint that faces away (`SIDE_HINT_FACES_AWAY`).
 */
function validateSideHints(model: LayoutModel, resolved: LayoutModel): void {
  for (const id of orderedNodeIds(model.document)) for (const port of model.nodes[id]!.ports) {
    const name = `${id}.${port.ref.name ?? '#'}${port.ref.ordinal}`;
    if (port.courseHint !== undefined && (port.courseHint !== true || port.sideHint === true || port.naturalSide === undefined || port.naturalSide === port.side)) throw new SideHintRefusal(`Course face on ${name} is not recorded with its natural side`);
    if (port.courseHint === true) continue;
    if ((port.sideHint === true) !== (port.naturalSide !== undefined) || (port.sideHint !== undefined && port.sideHint !== true)) throw new SideHintRefusal(`Side hint on ${name} is not recorded with its natural side`);
    if (port.laneHint !== undefined && (port.laneHint !== true || port.sideHint !== true)) throw new SideHintRefusal(`Lane hint on ${name} is not a side hint`);
    if (port.sideHint !== true) continue;
    if (port.side !== 'left' && port.side !== 'right') throw new SideHintRefusal(`Side hint on ${name} is not a lateral side`);
    if (port.naturalSide !== 'top' && port.naturalSide !== 'bottom') throw new SideHintRefusal(`Side hint on ${name} has a lateral natural side`);
    const why = hintRefusal(resolved, port.ref);
    if (why !== undefined) throw new SideHintRefusal(`Side hint on ${name} is not allowed: ${why}`);
    // The natural side is the one the run's rule gives a single-link candidate: `bottom` for a peer on a later tier, `top` for an earlier one.
    const link = model.links.find(item => [item.attachments!.from, item.attachments!.to].some(end => portKey(end) === portKey(port.ref)))!;
    const peer = portKey(link.attachments!.from) === portKey(port.ref) ? link.attachments!.to.node : link.attachments!.from.node;
    const own = model.groups[model.document.nodes[id]!.group]!.tier!, other = model.groups[model.document.nodes[peer]!.group]!.tier!;
    if (own === other) throw new SideHintRefusal(`Side hint on ${name} joins two ports of one tier`);
    same(port.naturalSide, other > own ? 'bottom' : 'top', 'Semantic or authored side differs from document');
  }
}
function validateTechniques(model: LayoutModel, baseline: LayoutModel): void {
  for (const [index, link] of model.links.entries()) {
    const expected = baseline.links[index]!.technique;
    const authored = model.document.links[link.sourceIndex]!.route;
    // Only a rule with a landed validator may select a technique; today that is the rows rule for its candidates.
    const geometrySelected = authored === undefined && link.layer === 'routed' && !link.bundle
      && ((stages.indexOf(model.stage) >= stages.indexOf('rows') && rowPathCandidate(model, link))
        || (stages.indexOf(model.stage) >= stages.indexOf('flanks') && flankPathCandidate(model, link))
        || (stages.indexOf(model.stage) >= stages.indexOf('bars') && barLink(model, link) !== undefined))
      && (expected === undefined || expected === 'straight' || expected === 'orthogonal')
      && (link.technique === 'straight' || link.technique === 'orthogonal');
    if (!geometrySelected) same(pick(link, ['technique']), pick(baseline.links[index]!, ['technique']), 'Link technique contradicts authored route, effective layer or M1 fallback');
  }
}
/** A trunk join (mesh-bus.md, section 12): three buses or more of one class on as many rows, named by the head bus, which lists the cross links. */
function validateTrunkJoin(buses: readonly MeshBus[], bus: MeshBus): void {
  const head = buses.find(item => item.id === bus.mesh);
  if (head === undefined || head.trunk === undefined || head.mesh !== head.id || !head.trunk.buses.includes(bus.id)) throw new Error(`Mesh bus ${bus.id} names a trunk head that does not list it`);
  if (bus.joined !== undefined || bus.riser !== undefined) throw new Error(`Mesh bus ${bus.id} is in a trunk join and in a riser join`);
  if ((bus.trunk === undefined) !== (bus.id !== head.id) || (bus.cross === undefined) !== (bus.id !== head.id)) throw new Error(`Only the head bus ${head.id} of a trunk join holds the trunk and the cross links`);
  if (bus.id !== head.id) return;
  const members = head.trunk.buses.map(id => buses.find(item => item.id === id));
  if (members.length < 3 || members.some(item => item === undefined || item.mesh !== head.id || (item.class ?? '') !== (head.class ?? ''))) throw new Error(`Trunk ${head.id} does not join three buses or more of one class`);
  const rows = members.map(item => item!.row);
  if (members[0] !== head || rows.some((row, index) => index > 0 && row <= rows[index - 1]!)) throw new Error(`Trunk ${head.id} does not list its buses top row first`);
  const total = members.reduce((sum, item) => sum + item!.nodes.length, 0);
  if (members.some(item => item!.meshNodes !== total)) throw new Error(`Trunk ${head.id} counts the nodes of its mesh wrongly`);
}
/** A join is two buses that name each other; the upper bus lists its cross links, which carry its id and are not members (mesh-bus.md, section 11.6). */
function validateJoins(model: LayoutModel): void {
  const buses = model.meshBuses ?? [];
  const byId = new Map(model.links.map(link => [link.id, link]));
  for (const bus of buses) {
    const partner = bus.joined === undefined ? undefined : buses.find(item => item.id === bus.joined);
    if (bus.joined !== undefined) {
      if (bus.joined === bus.id || partner?.joined !== bus.id) throw new Error(`Mesh bus ${bus.id} is joined to ${bus.joined}, which does not name it back`);
      if ((partner.class ?? '') !== (bus.class ?? '')) throw new Error(`Mesh buses ${bus.id} and ${partner.id} are joined across two classes`);
      if ((bus.cross === undefined) === (partner.cross === undefined)) throw new Error(`Exactly one of the joined buses ${bus.id} and ${partner.id} lists the cross links`);
    }
    const listed = new Set(bus.cross ?? []);
    if (bus.mesh !== undefined || bus.trunk !== undefined) validateTrunkJoin(buses, bus);
    if (bus.cross !== undefined && bus.trunk !== undefined) {
      for (const id of bus.cross) {
        const link = byId.get(id);
        if (link?.meshBus !== bus.id || buses.some(item => item.members.includes(id))) throw new Error(`Cross link ${id} of ${bus.id} is not a link of the trunk join`);
      }
    } else if (bus.cross !== undefined) {
      if (partner === undefined || partner.row <= bus.row) throw new Error(`Mesh bus ${bus.id} lists cross links but is not the upper bus of a join`);
      for (const id of bus.cross) {
        const link = byId.get(id);
        if (link?.meshBus !== bus.id || bus.members.includes(id) || partner.members.includes(id)) throw new Error(`Cross link ${id} of ${bus.id} is not a link of the join`);
      }
    }
    for (const link of model.links) {
      if (link.meshBus === bus.id && !bus.members.includes(link.id) && !listed.has(link.id)) throw new Error(`Link ${link.id} carries ${bus.id} but is neither a member nor a cross link`);
    }
  }
}
/** Every protected result passes this same boundary, including direct freeze and restore. */
function validatePublication(model: LayoutModel, baseline: LayoutModel, intermediate = false): void {
  jsonValue(model);
  validateStaggerRows(model);
  validateGroupLifts(model);
  if (hasUnsupportedClaims(model)) throw new Error('Claim validator is not implemented');
  validateTechniques(model, baseline);
  validateJoins(model);
  validateGeometry(model);
  validateFreeze(model);
  validateRegionClaims(model, intermediate);
}
/** The same ordered producers validate every publication, including restored JSON. */
function validateRegionClaims(model: LayoutModel, intermediate = false): void {
  const expected = cloneModel(model);
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
  // The record of the end trim is read by the centring replay below, so it is checked first (architecture-2 ticket 68, R5).
  const trims = checkBodyTrims(model, stages.indexOf(model.stage) < stages.indexOf('bands'));
  if (trims.fault !== undefined) throw new Error(`The end trim record is forged: ${trims.fault}`);
  if (stages.indexOf(model.stage) >= stages.indexOf('centre')) {
    same(model.anchorTier, selectAnchorTier(model), 'Anchor tier contradicts node count or tie rule');
    // The record of the alignment targets is read, never decided again (architecture-2 ticket 66, R1); a malformed one is refused (R5).
    const targets = alignmentTargetsFault(model);
    if (targets !== undefined) throw new Error(`The alignment target record is forged: ${targets}`);
    // The record of the growths the centre rule gave back is read by the replay below (architecture-2 ticket 71, R1); a malformed one is refused (R5).
    const back = givenBackFault(model);
    if (back !== undefined) throw new Error(`The given-back growth record is forged: ${back}`);
    const all = publishedCentreViolations(model, false, trims.untrimmed);
    // A replay that declines a target the record does not is a contradiction of the record, not an alignment a spent budget left unverified:
    // no diagnostic excuses it (R5; ADR-0010 covers the alignments only).
    const differ = all.filter(item => item.startsWith(ALIGNMENT_TARGETS_DIFFER));
    if (differ.length) throw new PlacementRefusal('centring', `The alignment target record contradicts its replay: ${differ.join('; ')}`, { stage: model.stage });
    const centring = all;
    if (centring.length) {
      // A spent shared budget is producer state geometry cannot witness (ADR-0010). A model that
      // reports it keeps its last state and is judged by the final gates; the unverified alignments
      // are recorded on it. Every other model must hold the invariant exactly.
      if (!diagnosed(model, centring)) throw new PlacementRefusal('centring', `Centring invariant violated: ${centring.join('; ')}`, { stage: model.stage });
      const message = `Centring invariant unverified after a spent budget: ${centring.join('; ')}`;
      if (!model.diagnostics.some(d => d.code === 'CENTRE_INVARIANT_UNVERIFIED' && d.message === message)) {
        model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'CENTRE_INVARIANT_UNVERIFIED', message });
        if (publishing?.model === model) publishing.text = undefined;
      }
    }
  }
  else if (model.anchorTier !== undefined) throw new Error('Premature anchor tier');
  else if (givenBackFault(model, true) !== undefined) throw new Error(`The given-back growth record is forged: ${givenBackFault(model, true)}`);
  if (stages.indexOf(model.stage) < stages.indexOf('rows')) return;
  // A snapshot of the stages before the bundles skips the second derivation of the paths below (`withStageMutation`), but not the facing-order check:
  // it runs only before the bundle stage, so no later check reads it.
  if (intermediate) {
    if (stages.indexOf(model.stage) >= stages.indexOf('flanks') && stages.indexOf(model.stage) < stages.indexOf('bundles')) {
      const ordered = cloneModel(model); normalizePrimaryBundlePorts(ordered);
      for (const id of Object.keys(model.nodes)) same(model.nodes[id]!.ports.map(port => port.engineOrder), ordered.nodes[id]!.ports.map(port => port.engineOrder), 'Primary bundle facing order contradicts normalization');
    }
    return;
  }
  // Clear both kinds together so stale paths cannot suppress their replacements.
  for (const link of expected.links) if (rowPathCandidate(expected, link) || flankPathCandidate(expected, link)) delete link.path;
  // The draft decides the rows rule before it derives the bundles (`rebuildRegionGeometry` clears the member paths and the zones first): no member
  // path and no zone stand yet. The re-derivation reads the same state, or a chord decided without them would be refused with them (ticket 99).
  if (bundleStage) {
    for (const link of expected.links) if (link.bundle) delete link.path;
    for (const bundle of expected.bundles) { delete bundle.rows; delete bundle.envelope; delete bundle.centreline; delete bundle.envelopeParts; }
  }
  rebuildRowPaths(expected);
  const flankStage = stages.indexOf(model.stage) >= stages.indexOf('flanks');
  if (flankStage) {
    if (!bundleStage) {
      const ordered = cloneModel(model); normalizePrimaryBundlePorts(ordered);
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
    same(model.groupExits, expected.groupExits, 'Group exits contradict shared runs');
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
  // The linked-group grid is validated by replaying it with the guards of the producer (`validateGroupLabelBands`): equality with the producer is the proof (ticket 16).
  if (stages.indexOf(model.stage) >= stages.indexOf('bands')) {
    validateGroupLabelBands(model);
  }
  // Route geometry cannot be re-derived without the router, so its claims are checked structurally.
  if (stages.indexOf(model.stage) >= stages.indexOf('route')) validateRoutedPaths(model, stages.indexOf(model.stage) > stages.indexOf('route'));
  if (stages.indexOf(model.stage) >= stages.indexOf('link-labels')) validateLinkLabels(model);
}
function validateGeometry(model: LayoutModel): void {
  jsonValue(model);
  validatePlacementStructure(model);
  if (model.runtime.stages.some(entry => !stages.includes(entry.stage) || entry.durationMs < 0)
    || (model.runtime.totalMs !== undefined && model.runtime.totalMs < 0)) throw new Error('Invalid runtime measurement');
  const expected = cloneModel(model);
  // Fresh measurement cannot inherit a forged floor, inset, content size or pitch.
  for (const node of Object.values(expected.nodes)) {
    delete node.sizeFloor; delete node.size; delete node.contentSize; delete node.contentInsets; delete node.sidePitch;
  }
  sizeNodes(expected);
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!, measured = expected.nodes[id]!, box = node.bounds;
    validatePortCorners(node);
    if (!box || !node.size || !node.sizeFloor || box.width <= 0 || box.height <= 0) throw new Error(`Missing positive geometry on ${id}`);
    if (stages.indexOf(model.stage) >= stages.indexOf('bars') && model.document.groups[model.document.nodes[id]!.group]!.shape === 'bar') {
      const group = model.document.groups[model.document.nodes[id]!.group]!;
      const text = node.ports.length ? model.document.nodes[id]!.label : group.label;
      const label = measureText(text, { fontSize: NODE_CONTENT_GEOMETRY.labelFontSize, weight: NODE_CONTENT_GEOMETRY.labelFontWeight });
      if (box.width < label.width + 60 - PLACEMENT_EPS) throw new Error(`Bar ${id} violates label-plus-60 floor: width ${box.width} < ${label.width + 60}`);
    }
    same(node.size, { width: box.width, height: box.height }, `Size/bounds disagree on ${id}`);
    same(node.contentInsets, measured.contentInsets, `Content insets differ on ${id}`);
    same(node.contentSize, measured.contentSize, `Content measurement differs on ${id}`);
    const saved = model.freeze?.floors.find(floor => floor.node === id)?.size;
    const hinted = model.freeze?.nodeFloors?.find(floor => floor.node === id)?.size;
    if (hinted !== undefined) for (const dim of ['width', 'height'] as const) {
      if (hinted[dim] < measured.sizeFloor![dim] - PLACEMENT_EPS) throw new SideHintRefusal(`Node floor of ${id} is below its content: ${dim} ${hinted[dim]} < ${measured.sizeFloor![dim]}`);
      if (node.size[dim] < hinted[dim] - PLACEMENT_EPS) throw new SideHintRefusal(`Node ${id} is smaller than its node floor: ${dim} ${node.size[dim]} < ${hinted[dim]}`);
    }
    for (const dim of ['width', 'height'] as const) {
      if ((saved !== undefined && saved[dim] < measured.sizeFloor![dim]) || node.sizeFloor[dim] < measured.sizeFloor![dim] || node.sizeFloor[dim] < (saved?.[dim] ?? 0)
        || node.size[dim] < node.sizeFloor[dim]) throw new Error(`Node ${id} violates ${dim} floor: size ${node.size[dim]}, floor ${node.sizeFloor[dim]}, measured ${measured.sizeFloor![dim]}, frozen ${saved?.[dim] ?? 'none'}`);
    }
    for (const side of SIDE_TIE_ORDER) {
      const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
      const pitch = node.sidePitch?.[side];
      if (pitch === undefined || pitch < measured.sidePitch![side]!) throw new Error(`Invalid measured pitch on ${id}.${side}`);
      const horizontal = side === 'top' || side === 'bottom';
      const length = horizontal ? box.width : box.height;
      if (length + PLACEMENT_EPS < portSideCapacity(node, side, ports.length, pitch)) throw new Error(`Port capacity exceeds ${id}.${side}`);
      const corner = lateralPillInset(node, side);
      let prior = -Infinity, authored = -Infinity;
      for (const [index, port] of ports.entries()) {
        if (port.engineOrder !== index) throw new Error(`Invalid engine slots on ${id}.${side}`);
        if (!port.anchor) throw new Error(`Missing anchor on ${id}`);
        const coordinate = horizontal ? port.anchor.x : port.anchor.y;
        if (!horizontal && (coordinate < box.y + corner - PLACEMENT_EPS || coordinate > box.y + box.height - corner + PLACEMENT_EPS)) {
          throw new Error(`Port corner clearance violated on ${id}.${side}`);
        }
        if (coordinate - prior < pitch - PLACEMENT_EPS) throw new Error(`Port spacing/order violates pitch on ${id}.${side}`);
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
      for (const otherId of group.nodes.slice(index + 1)) {
        const a = model.nodes[id]!.bounds!, b = model.nodes[otherId]!.bounds!, gap = nodeGap(model, id, otherId);
        const dx = Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0);
        const dy = Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0);
        if (Math.hypot(dx, dy) < gap - PLACEMENT_EPS) throw new Error(`Nodes ${id} and ${otherId} violate clearance`);
      }
      const box = model.nodes[id]!.bounds!, outer = group.bounds;
      if ((box.x < outer.x || box.y < outer.y || box.x + box.width > outer.x + outer.width + PLACEMENT_EPS
        || box.y + box.height > outer.y + outer.height + PLACEMENT_EPS)) throw new Error(`Node ${id} is outside its group`);
    }
  }
  if (Object.keys(model.groups).length) {
    // Report what the check found. A fixed sentence hid its own diagnosis and cost three rebuilds.
    const bandErrors = validateSkeletonBands(model);
    if (bandErrors.length) throw new Error(`Invalid group or tier geometry: ${bandErrors.join('; ')}`);
  }
  if (!model.canvas || model.canvas.width < 0 || model.canvas.height < 0) throw new Error('Invalid canvas');
  same(model.tierBands.map(band => ({ tier: band.tier, groups: [...band.groups].sort() })),
    [...new Set(Object.values(model.groups).map(group => group.tier!))].sort((a, b) => a - b)
      .map(tier => ({ tier, groups: Object.values(model.groups).filter(group => group.tier === tier).map(group => group.id).sort() })),
    'Tier band membership differs from groups');
  if (new Set(model.labels.map(label => label.id)).size !== model.labels.length) throw new Error('Duplicate label IDs');
}
/**
 * A span hint is an input of placement (architecture ticket 22): `freeze.spans` lists the hinted links in link order, and each is a spanning-chord
 * candidate under Section 14.1 (tiers two apart or more, facing ports, no lane hint). Whether the chord is still clear is not checked: restore accepts every
 * layout the pipeline publishes, and 7f names a chord that a move closed (`SPAN_CHORD_BLOCKED`).
 */
function validateSpans(model: LayoutModel, frozen: readonly string[] | undefined): void {
  const hinted = model.links.filter(link => link.spanHint !== undefined);
  for (const link of hinted) {
    if (link.spanHint !== true) throw new SideHintRefusal(`Span hint on ${link.id} is not true`);
    if (!spanCandidate(model, link)) throw new SideHintRefusal(`Span hint on ${link.id}, which is no spanning-chord candidate`);
  }
  same(hinted.map(link => link.id), frozen ?? [], 'Frozen span hints changed');
  if (frozen !== undefined && new Set(frozen).size !== frozen.length) throw new Error('Span hints name a link twice');
}
function validateFreeze(model: LayoutModel): void {
  const freeze = model.freeze;
  if (!freeze || freeze.version !== 1) throw new Error('Missing or unsupported topology freeze');
  same(model.staggerRows, freeze.staggerRows, 'Frozen stagger reservation changed');
  same(model.feedSplits, freeze.feedSplits, 'Frozen feed splits changed');
  validateFeedSplits(model);
  same(topology(model), freeze.topology, 'Frozen port topology changed');
  if (!sameCourses(model.courses, freeze.courses)) throw new Error('Frozen courses changed');
  validateSpans(model, freeze.spans);
  if (freeze.turnOrder !== undefined && (model.turnOrder !== true || freeze.turnOrder.some(face => model.nodes[face.node] === undefined))) throw new Error('Frozen turn order names a face the model does not carry');
  validateCourses(model);
  same(freeze.floors.map(floor => floor.node), orderedNodeIds(model.document), 'Frozen floors omit or repeat nodes');
  for (const floor of freeze.floors) if (floor.size.width <= 0 || floor.size.height <= 0) throw new Error('Invalid frozen floor');
  if (freeze.nodeFloors !== undefined) {
    const ids = orderedNodeIds(model.document).filter(id => freeze.nodeFloors!.some(floor => floor.node === id));
    same(freeze.nodeFloors.map(floor => floor.node), ids, 'Node floors name a node twice, out of order, or not at all');
    for (const floor of freeze.nodeFloors) {
      if (!(floor.size.width > 0) || !(floor.size.height > 0)) throw new SideHintRefusal(`Invalid node floor on ${floor.node}`);
      if (!model.nodes[floor.node]!.ports.some(port => port.sideHint === true || port.courseHint === true)) throw new SideHintRefusal(`Node floor on ${floor.node}, which has no hinted port`);
    }
  }
  validateReservations(model);
  if (stages.indexOf(model.stage) >= stages.indexOf('bands')) {
    if (!freeze.placement) throw new Error('Missing final placement freeze');
    same(placement(model), freeze.placement, 'Final placement changed');
  } else if (freeze.placement) throw new Error('Premature placement freeze');
}

/** Publish a clone. The caller must retain this immutable return value. */
export function freezePortTopology(model: LayoutModel, nodeFloors?: ReadonlyMap<string, Size>, turnFaces: readonly { node: string; side: Side }[] = []): LayoutModel {
  if (model.stage !== 'sides-two' || model.freeze) throw new Error('Topology can freeze only once at sides-two');
  jsonValue(model);
  const baseline = validateDocument(model);
  const result = clone(model);
  result.freeze = { version: 1, topology: clone(topology(model)),
    floors: orderedNodeIds(model.document).map(id => ({ node: id, size: { ...model.nodes[id]!.sizeFloor! } })) };
  const floored = orderedNodeIds(model.document).filter(id => nodeFloors?.has(id));
  if (model.courses !== undefined) result.freeze.courses = clone(model.courses);
  if (model.staggerRows !== undefined) result.freeze.staggerRows = clone(model.staggerRows);
  if (model.feedSplits !== undefined) result.freeze.feedSplits = clone(model.feedSplits);
  const spans = model.links.filter(link => link.spanHint === true).map(link => link.id);
  if (spans.length) result.freeze.spans = spans;
  if (turnFaces.length) result.freeze.turnOrder = turnFaces.map(face => ({ ...face }));
  if (floored.length) result.freeze.nodeFloors = floored.map(id => ({ node: id, size: { ...nodeFloors!.get(id)! } }));
  return protect(result, baseline);
}

/** Resume serialized output through this API; JSON.parse alone returns unprotected data. */
export function restoreLayoutModel(json: string): LayoutModel {
  const model = JSON.parse(json) as LayoutModel;
  jsonValue(model);
  if (!model || !stages.includes(model.stage) || !model.runtime || !Array.isArray(model.runtime.stages)) throw new Error('Invalid layout model');
  if (stages.indexOf(model.stage) < stages.indexOf('sides-two')) {
    if (model.freeze) throw new Error('Premature topology freeze');
    validateDocumentCss(model);
    resolve(model.document);
    return model;
  }
  const baseline = validateDocument(model);
  return protect(model, baseline);
}

/** The stages at which a layout is complete: stage 9 has published labels and the legend. */
export const FINAL_STAGES: readonly LayoutStage[] = ['link-labels', 'validate', 'emit'];

/**
 * Restore a *final* layout, for `score` and `render`. It is `restoreLayoutModel` plus the one
 * question those two need answered: is this geometry finished? A model still at `rows` or `route`
 * has no link labels and no legend, so scoring it would report gates on a diagram that does not
 * exist yet, and rendering it would omit labels the author wrote. Refusing here is what keeps the
 * CLI from casting an incomplete stage into a final one.
 */
export function restoreFinalLayout(json: string): LayoutModel {
  const model = restoreLayoutModel(json);
  if (!FINAL_STAGES.includes(model.stage)) {
    throw new Error(`Layout is at stage ${model.stage}; a final layout is one of ${FINAL_STAGES.join(', ')}`);
  }
  if (!model.canvas) throw new Error('A final layout requires a canvas');
  return model;
}

const permissions: Record<PlacementRule, { move: boolean; reorder: boolean }> = {
  rows: { move: true, reorder: false }, lanes: { move: true, reorder: false },
  flanks: { move: true, reorder: true }, centre: { move: true, reorder: true },
  // 7e and 7f give an empty callback: their producers run after the checks below, so a rule check here reads only what a caller authored.
  // The producer postconditions (`postconditions.ts`) judge the producer output; publication (`protect`) is the second boundary (D-Q3, DR-11).
  bars: { move: true, reorder: true }, bundles: { move: true, reorder: true }, bands: { move: true, reorder: false },
  route: { move: false, reorder: false }, 'link-labels': { move: false, reorder: false },
  validate: { move: false, reorder: false }, emit: { move: false, reorder: false },
};
/**
 * Whether the stored placement diagnostics excuse every centring item (DR-15, R5). An item is excused only for a link that a placement-stage
 * `PLACEMENT_NON_CONVERGENCE` names in its owners, as the centre emitter writes them; the message text is never read, and a code with no
 * such owner (another emitter, or a forged one) excuses nothing.
 */
function diagnosed(model: LayoutModel, items: readonly string[]): boolean {
  const named = new Set(model.diagnostics.filter(d => d.stage === 'placement' && d.code === 'PLACEMENT_NON_CONVERGENCE')
    .flatMap(d => (d.owners ?? []).flatMap(o => o.kind === 'link' ? [o.id] : [])));
  return items.every(item => { const link = centreItemLink(model, item); return link !== undefined && named.has(link); });
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
  // Stage 9 owns link, multiplicity and generated legend labels, and the legend itself;
  // validateLinkLabels re-derives everything it published.
  const labelStage = stages.indexOf(model.stage) >= stages.indexOf('link-labels');
  const nonNodeLabels = claims(model).labels;
  return model.links.some(link => (link.path !== undefined && !(routeStage || (rowStage && rowPathCandidate(model, link)) || (flankStage && flankPathCandidate(model, link))
      || (barStage && barLink(model, link) !== undefined) || (bundleStage && link.bundle !== undefined)))
      || (link.stubCandidate !== undefined && !routeStage)
      || (link.fixedSegments !== undefined && !laneStage) || (link.sharedRuns !== undefined && !bundleStage))
    || (!laneStage && (model.lanes.length > 0 || model.regions.length > 0)) || (!barStage && model.barDrops.length > 0)
    || (!bundleStage && model.junctions.length > 0)
    || (!bundleStage && model.bundles.some(b => b.rows !== undefined || b.centreline !== undefined || b.envelope !== undefined || b.envelopeParts !== undefined || b.memberGap !== undefined || b.inversions !== undefined || b.memberPitch !== undefined || b.mergeRuns !== undefined || b.lead !== undefined))
    || model.obstacles.length > 0 || (!bandsStage && model.labelBands.length > 0)
    || (!labelStage && model.legend !== undefined)
    || nonNodeLabels.some(label => !(bandsStage && label.role === 'group')
      && !(labelStage && (label.role === 'link' || label.role === 'legend' || label.role === 'mesh-bus')));
}
function rebuildBoxes(model: LayoutModel): void {
  for (const group of Object.values(model.groups)) {
    if (!group.nodes.length) continue;
    const box = union(group.nodes.map(id => model.nodes[id]!.bounds!)), old = group.bounds!;
    // A rank cell holds no side padding (the frame adds it), so its floor is its own insets.
    const floor = group.frame === undefined ? { top: 12, right: 12, bottom: 12, left: 12 } : groupPadding(model, group);
    const derivedLeft = box.x - floor.left, derivedTop = box.y - floor.top;
    const oldRight = old.x + old.width, oldBottom = old.y + old.height;
    const derivedRight = box.x + box.width + floor.right, derivedBottom = box.y + box.height + floor.bottom;
    const x = derivedLeft < old.x - PLACEMENT_EPS ? derivedLeft : old.x;
    const y = derivedTop < old.y - PLACEMENT_EPS ? derivedTop : old.y;
    const farX = derivedRight > oldRight + PLACEMENT_EPS ? derivedRight : oldRight;
    const farY = derivedBottom > oldBottom + PLACEMENT_EPS ? derivedBottom : oldBottom;
    group.bounds = { x, y, width: farX - x, height: farY - y };
  }
  rebuildBands(model);
  if (Object.keys(model.groups).length) {
    const box = union(Object.values(model.groups).map(group => group.bounds!)), old = model.canvas ?? box;
    const x = Math.min(old.x, box.x), y = Math.min(old.y, box.y);
    // `span`, not a subtraction: this canvas is what `Canvas may only expand` below reads, and a
    // width recovered from an absolute edge can land one ULP inside the canvas it was built from.
    model.canvas = { x, y, width: span(x, Math.max(old.x + old.width, box.x + box.width)),
      height: span(y, Math.max(old.y + old.height, box.y + box.height)) };
  }
}

/** One synchronous checked commit per stage. Future producers extend the closed validators here. */
export function withLayoutMutation(model: LayoutModel, rule: PlacementRule, edit: (draft: LayoutModel) => void, abortAt?: () => void, trace?: (event: AttemptTraceEvent) => void, moves?: boolean): LayoutModel {
  return mutate(model, rule, edit, false, abortAt, trace, moves);
}
/**
 * The placement stages before the bundles (rows to bars) as the pipeline runs them. Their result is a snapshot the next stage reads, and the bundles
 * stage (the last before 7f freezes the chords), 7f, the route rule and stage 9 each validate the whole model again, in full, on the geometry they
 * publish. So a snapshot skips the one check that those later stages repeat on their own result: the second derivation of the row, flank, bar and bundle paths (`validateRegionClaims`). Every
 * other check stays, among them the centring invariant, whose error is the refusal signal of the course, turn and overlay rounds
 * (`Centring invariant violated`), and the side-hint checks, whose `SideHintRefusal` is the signal of the side rounds. `withLayoutMutation` itself
 * always validates in full.
 */
export function withStageMutation(model: LayoutModel, rule: PlacementRule, edit: (draft: LayoutModel) => void): LayoutModel {
  return mutate(model, rule, edit, true);
}
const INTERMEDIATE_RULES: ReadonlySet<PlacementRule> = new Set<PlacementRule>(['rows', 'lanes', 'flanks', 'centre', 'bars']);
function mutate(model: LayoutModel, rule: PlacementRule, edit: (draft: LayoutModel) => void, intermediate: boolean, abortAt?: () => void, trace?: (event: AttemptTraceEvent) => void, moves?: boolean): LayoutModel {
  if (!protectedModels.has(model)) throw new Error('Mutation requires a protected snapshot; use restoreLayoutModel');
  if (!Object.hasOwn(permissions, rule) || stages[stages.indexOf(model.stage) + 1] !== rule) throw new Error(`Incorrect predecessor stage for ${rule}`);
  const started = Date.now(), draft = clone(model), permission = permissions[rule];
  const returned = edit(draft);
  if (returned !== undefined) throw new Error('Mutation callback must be synchronous and return void');
  jsonValue(draft);
  validateRect(draft.canvas, 'canvas');
  // The lanes rule alone fixes the riser of a joined pair (mesh-bus.md, section 11.5) and the x of a trunk (section 12.5); nothing else of a bus changes in it.
  // Stage 7a may add the faces it ordered by a transit lane to `freeze.turnOrder` (ticket 24); the faces are checked against the reorders below.
  const unfaced = (value: LayoutModel): LayoutModel => rule === 'lanes' && value.freeze?.turnOrder !== undefined ? { ...value, freeze: omit(value.freeze, ['turnOrder']) as LayoutFreeze } : value;
  const unriser = (value: LayoutModel): LayoutModel => unfaced(rule === 'lanes' && value.meshBuses ? { ...value, meshBuses: value.meshBuses.map(bus => omit(bus, ['riser', 'trunk']) as MeshBus) } : value);
  const declared = ['nodes', 'groups', 'tierBands', 'labels', 'canvas', 'diagnostics', 'runtime', 'links', 'lanes', 'bundles', 'junctions', 'labelBands', 'barDrops', 'obstacles', 'regions', 'anchorTier', 'frames', 'removedLinks',
    // The centre rule decides the aligned extents of the canton members once (architecture-2 ticket 31); every later rule keeps them.
    // It also gives back, once at its end, the growths no kept target uses (`givenBack`, architecture-2 ticket 71).
    // It also records and withdraws the parent port moves it took at a frame-column wall (`parentWallMoves`, `standPortsOverChildren`),
    // and decides once which parents below the anchor tier spread their ports over their children (`parentSpreads`, architecture-2 ticket 32).
    ...(rule === 'centre' ? ['alignedExtents', 'parentWallMoves', 'parentSpreads', 'givenBack'] : []),
    // The centring steps of 7c to 7f write the record of their alignment targets; the route rule drops it, after the publication of 7f has
    // compared it with its replay (architecture-2 ticket 66).
    ...(['centre', 'bars', 'bundles', 'bands', 'route'].includes(rule) ? ['alignmentTargets'] : []),
    // The end trim of 7f records the bodies and boxes it narrowed (architecture-2 ticket 68); every later rule keeps the record.
    ...(rule === 'bands' ? ['bodyTrims'] : []),
    // D-Q5: the publication writes the command's lift record (`decideLifts`); the entries it adds after the kept run are declined and move no band.
    ...(rule === 'link-labels' ? ['groupLifts'] : [])];
  same(omit(unriser(draft), declared), omit(unriser(model), declared), 'Undeclared model field changed');
  // Stage 8 alone removes links (`ROUTE_CHECKPOINT_SKIPPED`, `ROUTE_GAP_REJECTED`); every later stage keeps the list.
  if (rule !== 'route') same(draft.removedLinks, model.removedLinks, 'Only the route rule may remove a link');
  same(draft.stage, model.stage, 'Transaction owns the stage marker');
  same(draft.document, model.document, 'Document changed'); same(unfaced(draft).freeze, unfaced(model).freeze, 'Freeze metadata changed');
  same(structure(draft, rule === 'centre'), structure(model, rule === 'centre'), 'Topology or membership changed');
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
  const linkFields = rule === 'route' ? ['fixedSegments', 'path', 'stubCandidate', 'removed'] : ['fixedSegments'];
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
    // A course lane's x is derived from the boxes at each replay (ticket 15, Section 2); its id, owner, side, ring, span and width are fixed.
    const identity = (lane: Lane) => lane.kind === 'span' ? { ...lane, x: 0, bounds: {} } : isCourseLane(lane) ? { ...lane, x: 0, bounds: pick(lane.bounds, ['width']) } : { ...lane, bounds: pick(lane.bounds, ['x', 'width']) };
    same(draft.lanes.map(identity), model.lanes.map(identity), 'Established lane identity, owner, x and width cannot change');
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
  const changed = !equal(before, after);
  if (changed && !permission.move) throw new Error(`${rule} cannot change placement`);
  if (changed && hasUnsupportedClaims(model)) throw new Error(`${rule} requires an unimplemented claim rebuild`);
  // Rebuild containing boxes and node content first, so every rule check below sees the final geometry.
  if (changed) { rebuildBoxes(draft); rebuildNodeGeometry(draft, orderedNodeIds(draft.document), 'current'); }
  // Frames are derived from cell boxes, like tier bands: a callback may not leave them off the cells.
  const derived = { ...draft } as LayoutModel;
  delete derived.frames;
  rebuildFrames(derived);
  same(draft.frames, derived.frames, 'Frames contradict the cell geometry they derive from');
  // Only the flanks rule reads the normalized order, so only it pays for the copy.
  const flankOrder = rule === 'flanks' ? clone(model) : undefined;
  if (flankOrder !== undefined) normalizePrimaryBundlePorts(flankOrder);
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
    same(omit(group, rule === 'centre' ? ['bounds', 'rowOrder'] : ['bounds']), omit(model.groups[id]!, rule === 'centre' ? ['bounds', 'rowOrder'] : ['bounds']), 'Undeclared group field changed');
    // Centring may reorder the row of a group only where no node has a routed link: nothing routed
    // then reads the order, and the overlay barycentre is the one rule that asks for it.
    if (rule === 'centre' && !equal(group.rowOrder, model.groups[id]!.rowOrder)
      && group.nodes.some(node => model.links.some(link => link.layer === 'routed' && link.attachments
        && (link.attachments.from.node === node || link.attachments.to.node === node)))) throw new Error(`Centring cannot reorder ${id}: a node of it has a routed link`);
    // Rows may re-seat a whole band (ranked-groups ticket 18), so a flank or a non-row group may translate vertically with it.
    // `rebuildBoxes` re-derives the box of an unmoved flank from its nodes (`farX - x`), which leaves 1e-14 on its width. Fixing it there changes
    // 1e-13 digits in 8 published sheets and the verdict digests of `objective-differential`, so the check reads within the placement tolerance.
    if (rule === 'rows' && group.flank) {
      const now = verticalOnly(group.bounds!), was = verticalOnly(model.groups[id]!.bounds!);
      if (!(['x', 'width', 'height'] as const).every(key => Math.abs(now[key] - was[key]) <= PLACEMENT_EPS)) throw new Error('Rows cannot move flank groups');
    }
    if (rule === 'rows' && !group.flank && groupShape(draft, id) !== 'row') same(verticalOnly(group.bounds!), verticalOnly(model.groups[id]!.bounds!), 'Rows cannot change non-row groups');
    // `fitRegionGroup` re-derives the box of a flank from its nodes, which leaves 1e-14 on x: a flank is moved when it is off by more than the placement tolerance.
    if (rule === 'flanks' && group.flank && Math.abs(group.bounds!.x - model.groups[id]!.bounds!.x) > PLACEMENT_EPS) throw new Error('Flanks cannot translate groups horizontally');
    if (rule === 'bars' && draft.document.groups[id]!.shape !== 'bar') same(group, model.groups[id], 'Bars cannot move another group');
    if (rule === 'flanks' && !group.flank && !Object.values(model.groups).some(g => g.flank?.of === id)) same(group, model.groups[id], 'Flanks cannot move another group');
  }
  // Rows may re-seat a band, and the relaxation above is bounded by it: every flank and non-row group of a
  // band takes one shift, the shift of the band itself (a row group's own box also refits to its nodes).
  if (rule === 'rows') {
    for (const band of model.tierBands) {
      const now = draft.tierBands.find(item => item.tier === band.tier)!;
      const shifts = band.groups.filter(id => model.groups[id]!.flank || groupShape(draft, id) !== 'row')
        .map(id => draft.groups[id]!.bounds!.y - model.groups[id]!.bounds!.y);
      if (shifts.some(shift => Math.abs(shift - (now.bounds!.y - band.bounds!.y)) > PLACEMENT_EPS)) {
        throw new Error(`Rows must re-seat every flank and non-row group of tier band ${band.tier} by the band's own shift`);
      }
    }
  }
  if (model.canvas && draft.canvas && (draft.canvas.x > model.canvas.x || draft.canvas.y > model.canvas.y
    || draft.canvas.x + draft.canvas.width < model.canvas.x + model.canvas.width
    || draft.canvas.y + draft.canvas.height < model.canvas.y + model.canvas.height)) throw new Error('Canvas may only expand');
  const flankNodes = new Set(Object.values(model.groups).filter(group => group.flank).flatMap(group => [...group.nodes, ...(group.flank!.primaryPeer ? [group.flank!.primaryPeer] : [])]));
  const reordered: string[] = [];
  for (const id of orderedNodeIds(model.document)) {
    const old = model.nodes[id]!, node = draft.nodes[id]!;
    same(omit(node, ['bounds', 'size', 'sidePitch', 'ports', 'icon']), omit(old, ['bounds', 'size', 'sidePitch', 'ports', 'icon']), 'Undeclared node field changed');
    node.ports.forEach((port, index) => {
      same(omit(port, ['engineOrder', 'anchor', 'pill']), omit(old.ports[index]!, ['engineOrder', 'anchor', 'pill']), 'Undeclared port field changed');
      if (rule === 'centre' && !bundledPorts.has(JSON.stringify(port.ref))) same(port.engineOrder, old.ports[index]!.engineOrder, 'Centring cannot reorder unrelated ports');
    });
    same(node.sizeFloor, old.sizeFloor, 'Stored content floor changed');
    same(node.contentSize, old.contentSize, 'Measured content changed');
    same(node.contentInsets, old.contentInsets, 'Content insets changed');
    if (flankOrder !== undefined) same(node.ports.map(port => port.engineOrder), flankOrder.nodes[id]!.ports.map(port => port.engineOrder), 'Flanks may reorder only the compatible primary bundle block');
    const seated = new Map<string, { x: number; y: number }>();
    if (!permission.reorder && rule === 'lanes' && model.turnOrder === true) {
      // Stage 7a reorders a face only to the order the turn order gives it (ticket 24, Section 5), and records the face.
      for (const side of SIDE_TIE_ORDER) {
        const refs = (list: typeof node.ports): string[] => list.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => portKey(port.ref));
        if (refs(node.ports).join('|') === refs(old.ports).join('|')) continue;
        const expected = laneFaceOrder(draft, id, side)?.map(port => portKey(port.ref));
        if (expected === undefined || expected.join('|') !== refs(node.ports).join('|')) throw new Error(`${rule} cannot reorder ports`);
        reordered.push(faceKey(id, side));
        // The ports exchange the slots of the face: the anchors stay where they were.
        const seats = old.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => port.anchor!);
        node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!).forEach((port, index) => seated.set(portKey(port.ref), seats[index]!));
      }
    } else if (!permission.reorder) same(node.ports.map(port => port.engineOrder), old.ports.map(port => port.engineOrder), `${rule} cannot reorder ports`);
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
      // A flank or non-row node moves only with its band: the vertical shift of its own group, anchors with it.
      const seatedWithBand = (): void => {
        const dy = node.bounds!.y - old.bounds!.y;
        same(node, { ...old, bounds: { ...old.bounds!, y: old.bounds!.y + dy }, ports: old.ports.map(port => ({ ...port,
          ...(port.anchor ? { anchor: { x: port.anchor.x, y: port.anchor.y + dy } } : {}),
          ...(port.pill ? { pill: { ...port.pill, bounds: { ...port.pill.bounds, y: port.pill.bounds.y + dy } } } : {}) })),
          ...(old.icon ? { icon: { ...old.icon, bounds: { ...old.icon.bounds, y: old.icon.bounds.y + dy } } } : {}) }, 'Rows can only translate a flank or non-row node with its band');
        same(dy, draft.groups[model.document.nodes[id]!.group]!.bounds!.y - model.groups[model.document.nodes[id]!.group]!.bounds!.y, 'A flank or non-row node moves with its group');
      };
      if (model.groups[model.document.nodes[id]!.group]!.flank) seatedWithBand();
      else if (groupShape(draft, draft.document.nodes[id]!.group) !== 'row') seatedWithBand();
    }
    if (rule === 'lanes') {
      same(node.size, old.size, 'Lanes cannot resize nodes');
      const group = model.groups[model.document.nodes[id]!.group]!;
      const dx = draft.groups[group.id]!.bounds!.x - group.bounds!.x;
      same(node.bounds, { ...old.bounds!, x: old.bounds!.x + dx }, 'Lanes permit only whole-group horizontal translation');
      node.ports.forEach((port, i) => { const seat = seated.get(portKey(port.ref)) ?? old.ports[i]!.anchor!; same(port.anchor, { x: seat.x + dx, y: seat.y }, 'Lane translation must preserve relative anchors'); });
      if (dx && !model.links.some(link => transitTiers(model, link).includes(group.tier!))) throw new Error('Lanes may expand only occupied intermediate tiers');
      if (dx && heldSourceGroups(model).has(group.id)) throw new Error('Lanes cannot move transit source anchors');
    }
    if (rule === 'centre') {
      same(node.bounds!.y, old.bounds!.y, 'Centring cannot change y');
      same(node.size!.height, old.size!.height, 'Centring cannot change height');
      if (node.size!.width < old.size!.width) throw new Error(`Centring cannot shrink ${id}: width ${node.size!.width} < ${old.size!.width}`);
      const group = model.groups[model.document.nodes[id]!.group]!;
      if (group.tier === draft.anchorTier || group.flank) {
        // Bundle order, decided before the first seat (ticket 12), may exchange the slots of bundled ports: the set of anchors of each face stays,
        // an unbundled port stays where it is, and a pill travels with its anchor.
        const faces = (list: typeof node.ports): string => JSON.stringify(list.map(port => [port.side, port.anchor]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
        same(faces(node.ports), faces(old.ports), 'Centring cannot move anchor tier or flanks');
        const relative = (port: (typeof node.ports)[number]): unknown => port.pill === undefined ? undefined : { ...port.pill, bounds: { ...port.pill.bounds, x: port.pill.bounds.x - port.anchor!.x, y: port.pill.bounds.y - port.anchor!.y } };
        node.ports.forEach((port, index) => {
          const prior = old.ports[index]!;
          if (!bundledPorts.has(JSON.stringify(port.ref))) same({ anchor: port.anchor, pill: port.pill }, { anchor: prior.anchor, pill: prior.pill }, 'Centring cannot move anchor tier or flanks');
          same(relative(port), relative(prior), 'Centring cannot move anchor tier or flanks');
        });
        same({ ...node, ports: node.ports.map(port => omit(port, ['engineOrder', 'anchor', 'pill'])) }, { ...old, ports: old.ports.map(port => omit(port, ['engineOrder', 'anchor', 'pill'])) }, 'Centring cannot move anchor tier or flanks');
      }
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
  if (rule === 'lanes') {
    const was = (model.freeze?.turnOrder ?? []).map(face => faceKey(face.node, face.side)), now = (draft.freeze?.turnOrder ?? []).map(face => faceKey(face.node, face.side));
    same(now, [...was, ...reordered], 'Stage 7a must record the faces it reordered in the turn order, and only those');
  }
  // The rows rule produces row paths; any later movement replaces them from the final anchors.
  if (stages.indexOf(rule) >= stages.indexOf('lanes') && permission.move) {
    rebuildRegions(draft);
    if (rule !== 'lanes') rebuildLaneExtents(draft);
  }
  if (rule === 'bands') placementAttempt(draft, { abortAt, trace, moves });
  else if (rule === 'link-labels') produceLinkLabels(draft);
  else if (changed || ['rows', 'lanes', 'flanks', 'centre', 'bundles'].includes(rule)) {
    if (stages.indexOf(rule) >= stages.indexOf('flanks')) {
      rebuildRegionGeometry(draft, undefined, rule === 'bars' ? model.tierBands : undefined, rule === 'bundles' || stages.indexOf(model.stage) >= stages.indexOf('bundles'));
      if (rule === 'bundles' && draft.fanFamilies?.some(family => family.kind === 'solid')) {
        // Forecast mandatory label/grid packing on a disposable draft; reserve its entry demand
        // before freezing the real placement. No tentative label claim is published at 7e.
        const packed = clone(draft);
        freezeChords(packed);
        produceGroupLabelBands(packed);
        reserveBlockGaps(draft, moveBands, packed);
        rebuildRegionGeometry(draft, undefined, undefined, true, false);
      }
      // The geometry rebuild can move a port (the stems of a fan, 7e): a span corridor is derived from the two end anchors, so it is read again (architecture ticket 22).
      if (draft.lanes.some(lane => lane.kind === 'span')) rebuildLaneExtents(draft);
      if (rule === 'bars') same(nonBarHorizontalPlacement(draft), nonBarHorizontalPlacement(model),
        'Bars may translate downstream tiers only vertically');
    }
    else rebuildRowPaths(draft);
  }
  if (rule === 'bars') rebuildBarDrops(draft);
  // The last centring reading that reads the record is the publication of 7f: the routed layout publishes without it (architecture-2 ticket 66).
  if (rule === 'route') delete draft.alignmentTargets;
  // The producers of 7e and 7f write after the rule checks above: their output is judged here, on the net draft after every dependent rebuild
  // and before commit (DR-11). Publication (`protect`) stays the second boundary.
  if (rule === 'bundles' || rule === 'bands') judgePostconditions(model, draft, rule);
  draft.stage = rule;
  draft.runtime.stages.push({ stage: rule, durationMs: Date.now() - started });
  if (rule === 'bands') draft.freeze!.placement = clone(placement(draft));
  return protect(draft, model, intermediate && INTERMEDIATE_RULES.has(rule));
}
