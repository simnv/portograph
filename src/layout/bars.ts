import { GROUP_EDGE_LINK_CLEARANCE } from '../theme/geometry.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPort, PathSegment, Point, Rect } from '../model/index.js';
import { orderedGroupIds } from '../model/model.js';
import { equal } from '../model/json-equality.js';
import { measureText } from '../text/index.js';
import { NODE_CONTENT_GEOMETRY } from '../theme/content.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { nodeGap, portId } from './skeleton-graph.js';
import { splitUnderJunctions, treeCohorts } from './bundle-geometry.js';
import { groupInsets } from './regions.js';
import { findPort } from './row-paths.js';
import { withLayoutMutation } from './mutation.js';

const EPS = 1e-6;
const BAR_PADDING = 30;
const MIN_STEM = 15;
const FOREIGN_NODE_CLEARANCE = 10;
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const horizontalCapacity = (node: LayoutNode): number => Math.max(...(['top', 'bottom'] as const).map(side =>
  node.ports.filter(port => port.side === side).length * node.sidePitch![side]! + 2 * NODE_CONTENT_GEOMETRY.padding));
const samePoint = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

interface BarLink {
  link: LayoutLink;
  bar: LayoutNode;
  port: LayoutPort;
  external: LayoutPort;
  barAt: 'from' | 'to';
}

interface PortSlot {
  port: LayoutPort;
  desired: number;
  sourceIndex: number;
  documentIndex: number;
  pitch: number;
  links: BarLink[];
  slot: number;
}

function isBarNode(model: LayoutModel, id: string): boolean {
  const node = model.document.nodes[id];
  return node !== undefined && model.document.groups[node.group]?.shape === 'bar';
}

/** A routed link with exactly one endpoint on a bar. */
export function barLink(model: LayoutModel, link: LayoutLink): BarLink | undefined {
  if (link.layer !== 'routed' || link.groupLink !== undefined || !link.attachments || link.technique === 'stub') return undefined;
  const fromBar = isBarNode(model, link.attachments.from.node), toBar = isBarNode(model, link.attachments.to.node);
  if (fromBar === toBar) return undefined;
  const barRef = fromBar ? link.attachments.from : link.attachments.to;
  const externalRef = fromBar ? link.attachments.to : link.attachments.from;
  const port = findPort(model, barRef), external = findPort(model, externalRef);
  if (!port?.anchor || !external?.anchor || (port.side !== 'top' && port.side !== 'bottom')) return undefined;
  return { link, bar: model.nodes[barRef.node]!, port, external, barAt: fromBar ? 'from' : 'to' };
}

function adjacentLaneX(model: LayoutModel, item: BarLink): number | undefined {
  const tier = model.groups[model.document.nodes[item.bar.id]!.group]!.tier!;
  const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === item.link.id)
    .sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier) || a.tier - b.tier);
  return lanes[0]?.x;
}

function desiredX(model: LayoutModel, links: BarLink[], port: LayoutPort): number {
  if (!links.length) return port.anchor!.x;
  const positions = links.map(item => adjacentLaneX(model, item) ?? item.external.anchor!.x);
  return positions.reduce((sum, x) => sum + x, 0) / positions.length;
}

function authorConstrainedOrder(items: PortSlot[]): PortSlot[] {
  const outgoing = new Map<PortSlot, PortSlot[]>(), indegree = new Map(items.map(item => [item, 0]));
  for (const side of ['top', 'bottom'] as const) {
    const authored = items.filter(item => item.port.side === side && item.port.authorOrder !== undefined)
      .sort((a, b) => a.port.authorOrder! - b.port.authorOrder! || a.documentIndex - b.documentIndex);
    for (let index = 1; index < authored.length; index++) {
      const before = authored[index - 1]!, after = authored[index]!;
      const list = outgoing.get(before) ?? [];
      list.push(after); outgoing.set(before, list); indegree.set(after, indegree.get(after)! + 1);
    }
  }
  const result: PortSlot[] = [], pending = new Set(items);
  const compare = (a: PortSlot, b: PortSlot): number => a.desired - b.desired || a.sourceIndex - b.sourceIndex || a.documentIndex - b.documentIndex;
  while (pending.size) {
    const next = [...pending].filter(item => indegree.get(item) === 0).sort(compare)[0];
    if (!next) throw new Error('Bar author order contains a cycle');
    pending.delete(next); result.push(next);
    for (const after of outgoing.get(next) ?? []) indegree.set(after, indegree.get(after)! - 1);
  }
  return result;
}

function slotsForNode(model: LayoutModel, node: LayoutNode, links: BarLink[]): PortSlot[] {
  const byPort = new Map<string, BarLink[]>();
  for (const item of links) {
    const key = portId(item.port.ref), list = byPort.get(key) ?? [];
    list.push(item); byPort.set(key, list);
  }
  const items = node.ports.flatMap((port, documentIndex) => port.side === 'top' || port.side === 'bottom' ? [{
    port,
    desired: desiredX(model, byPort.get(portId(port.ref)) ?? [], port),
    sourceIndex: Math.min(...(byPort.get(portId(port.ref)) ?? []).map(item => item.link.sourceIndex), Number.MAX_SAFE_INTEGER),
    documentIndex,
    pitch: node.sidePitch![port.side]!,
    links: byPort.get(portId(port.ref)) ?? [],
    slot: 0,
  }] : []);
  let prior: PortSlot | undefined;
  for (const item of authorConstrainedOrder(items)) {
    const gap = prior !== undefined && prior.port.side === item.port.side ? Math.max(prior.pitch, item.pitch) : 12;
    item.slot = prior === undefined ? item.desired : Math.max(item.desired, prior.slot + gap);
    if (item.links.length && item.slot > item.desired + EPS) {
      const owners = item.links.map(link => link.link.owner);
      if (!model.diagnostics.some(diagnostic => diagnostic.code === 'BAR_SOURCE_FAN'
        && equal(diagnostic.owners, owners))) model.diagnostics.push({
        stage: 'placement', severity: 'warning', code: 'BAR_SOURCE_FAN', owners,
        message: `Fanned ${item.port.ref.node}.${item.port.ref.name ?? 'anonymous'}#${item.port.ref.ordinal} from x=${item.desired} to pitch-safe x=${item.slot}.`,
      });
    }
    prior = item;
  }
  return items;
}

function overlapMoreThanHalf(a: { min: number; max: number }, b: { min: number; max: number }): boolean {
  const overlap = Math.min(a.max, b.max) - Math.max(a.min, b.min);
  return overlap > Math.min(a.max - a.min, b.max - b.min) / 2 + EPS;
}

function mergedSpans(spans: Map<string, { min: number; max: number }>): void {
  const ids = [...spans.keys()], parent = new Map(ids.map(id => [id, id]));
  const root = (id: string): string => {
    let value = id;
    while (parent.get(value)! !== value) value = parent.get(value)!;
    return value;
  };
  const join = (a: string, b: string): void => { const ra = root(a), rb = root(b); if (ra !== rb) parent.set(rb, ra); };
  for (let i = 0; i < ids.length; i++) for (const other of ids.slice(i + 1)) {
    if (overlapMoreThanHalf(spans.get(ids[i]!)!, spans.get(other)!)) join(ids[i]!, other);
  }
  const unions = new Map<string, { min: number; max: number }>();
  for (const id of ids) {
    const key = root(id), span = spans.get(id)!, current = unions.get(key);
    unions.set(key, current ? { min: Math.min(current.min, span.min), max: Math.max(current.max, span.max) } : { ...span });
  }
  for (const id of ids) spans.set(id, { ...unions.get(root(id))! });
}

function peerSide(item: BarLink): 'top' | 'bottom' {
  return item.external.anchor!.y < item.port.anchor!.y ? 'top' : 'bottom';
}

function oppositeApproach(item: BarLink): boolean {
  return peerSide(item) !== item.port.side;
}

function barGap(model: LayoutModel, upper: LayoutNode, lower: LayoutNode, links: BarLink[]): number {
  let gap = nodeGap(model, upper.id, lower.id);
  // The drop that has to pass between these bars carries its own resolved width.
  const pathStroke = Math.max(DEFAULT_STROKE_WIDTHS.path, ...links.map(item => linkStrokeWidth(item.link)));
  if (links.some(item => item.bar.id === upper.id && item.port.side === 'bottom' && oppositeApproach(item))) {
    gap = Math.max(gap, MIN_STEM + FOREIGN_NODE_CLEARANCE
      + (pathStroke + (lower.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2);
  }
  if (links.some(item => item.bar.id === lower.id && item.port.side === 'top' && oppositeApproach(item))) {
    gap = Math.max(gap, MIN_STEM + FOREIGN_NODE_CLEARANCE
      + (pathStroke + (upper.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2);
  }
  return gap;
}

/** Shape bar nodes from current source anchors. This producer changes geometry but creates no paths or claims. */
export function shapeBars(model: LayoutModel): void {
  const allLinks = model.links.map(link => barLink(model, link)).filter((item): item is BarLink => item !== undefined);
  for (const groupId of orderedGroupIds(model.document)) {
    if (model.document.groups[groupId]!.shape !== 'bar') continue;
    const group = model.groups[groupId]!, nodes = group.nodes.map(id => model.nodes[id]!);
    const slots = new Map<string, PortSlot[]>(), spans = new Map<string, { min: number; max: number }>(), floors = new Map<string, number>();
    for (const node of nodes) {
      const nodeSlots = slotsForNode(model, node, allLinks.filter(item => item.bar.id === node.id));
      slots.set(node.id, nodeSlots);
      const xs = nodeSlots.map(item => item.slot);
      const labelText = node.ports.length ? model.document.nodes[node.id]!.label : model.document.groups[groupId]!.label;
      const label = measureText(labelText, { fontSize: NODE_CONTENT_GEOMETRY.labelFontSize, weight: NODE_CONTENT_GEOMETRY.labelFontWeight });
      const capacity = horizontalCapacity(node);
      const floor = Math.max(node.sizeFloor!.width, label.width + 2 * BAR_PADDING, capacity);
      const centre = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : node.bounds!.x + node.bounds!.width / 2;
      const width = Math.max(floor, xs.length ? Math.max(...xs) - Math.min(...xs) + 2 * BAR_PADDING : 0);
      // Keep the exact floor: `max - min` of a centred span can lose a bit and fall under it.
      floors.set(node.id, floor);
      spans.set(node.id, { min: centre - width / 2, max: centre + width / 2 });
    }
    mergedSpans(spans);
    const gaps = nodes.slice(0, -1).map((node, index) => barGap(model, node, nodes[index + 1]!, allLinks));
    const originalGroup = { ...group.bounds! }, inset = groupInsets(model, group);
    let y = group.bounds!.y + inset.top;
    for (const [index, node] of nodes.entries()) {
      const old = node.bounds!, span = spans.get(node.id)!, height = Math.max(node.sizeFloor!.height, old.height);
      const capacity = horizontalCapacity(node);
      const next = { x: span.min, y, width: Math.max(node.sizeFloor!.width, capacity, floors.get(node.id)!, span.max - span.min), height };
      const dx = next.x - old.x, dy = next.y - old.y, dw = next.width - old.width, dh = next.height - old.height;
      node.bounds = next; node.size = { width: next.width, height: next.height };
      const nodeSlots = slots.get(node.id)!;
      for (const port of node.ports) {
        const assigned = nodeSlots.find(item => item.port === port);
        if (assigned) port.anchor = { x: assigned.slot, y: port.side === 'top' ? next.y : bottom(next) };
        else if (port.anchor) port.anchor = {
          x: port.anchor.x + dx + (port.side === 'right' ? dw : 0),
          y: port.anchor.y + dy + (port.side === 'bottom' ? dh : 0),
        };
      }
      for (const side of ['top', 'bottom'] as const) node.ports.filter(port => port.side === side)
        .sort((a, b) => a.anchor!.x - b.anchor!.x || a.ref.ordinal - b.ref.ordinal)
        .forEach((port, engineOrder) => { port.engineOrder = engineOrder; });
      y = bottom(next) + (gaps[index] ?? 0);
    }
    if (nodes.length) {
      const minX = Math.min(...nodes.map(node => node.bounds!.x)), maxX = Math.max(...nodes.map(node => right(node.bounds!)));
      const x = model.labelBands.some(item => item.group === group.id)
        ? Math.min(originalGroup.x, minX - inset.left) : minX - inset.left;
      const far = model.labelBands.some(item => item.group === group.id)
        ? Math.max(right(originalGroup), maxX + inset.right) : maxX + inset.right;
      group.bounds = { x, y: nodes[0]!.bounds!.y - inset.top, width: far - x,
        height: bottom(nodes.at(-1)!.bounds!) - nodes[0]!.bounds!.y + inset.top + inset.bottom };
    }
  }
}

function outward(anchor: Point, side: LayoutPort['side'], length: number): Point {
  return side === 'top' ? { x: anchor.x, y: anchor.y - length }
    : side === 'bottom' ? { x: anchor.x, y: anchor.y + length }
      : side === 'left' ? { x: anchor.x - length, y: anchor.y }
        : { x: anchor.x + length, y: anchor.y };
}

function orientedLaneRuns(model: LayoutModel, item: BarLink): PathSegment[] {
  const fixed = item.link.fixedSegments ?? [];
  if (item.barAt === 'to') return fixed.map(segment => ({ ...segment, from: { ...segment.from }, to: { ...segment.to }, owner: { ...segment.owner } }));
  return [...fixed].reverse().map(segment => ({ ...segment, from: { ...segment.to }, to: { ...segment.from }, owner: { ...segment.owner } }));
}

function hintLaneRuns(model: LayoutModel, item: BarLink): PathSegment[] {
  if (!item.link.bundle) return orientedLaneRuns(model, item);
  const fromTier = model.groups[model.document.nodes[item.external.ref.node]!.group]!.tier!;
  const targetTier = model.groups[model.document.nodes[item.bar.id]!.group]!.tier!;
  const downward = fromTier < targetTier;
  return model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === item.link.id)
    .sort((a, b) => downward ? a.tier - b.tier : b.tier - a.tier)
    .map(lane => {
      const top = { x: lane.x, y: lane.bounds.y }, low = { x: lane.x, y: bottom(lane.bounds) };
      return { from: downward ? top : low, to: downward ? low : top, owner: item.link.owner, lane: lane.id };
    });
}

function appendConnector(segments: PathSegment[], from: Point, to: Point, owner: LayoutLink['owner']): void {
  if (samePoint(from, to)) return;
  const push = (segment: PathSegment): void => {
    const prior = segments.at(-1);
    const vertical = Math.abs(segment.from.x - segment.to.x) <= EPS;
    const collinear = prior && prior.lane === undefined && segment.lane === undefined && samePoint(prior.to, segment.from)
      && (vertical ? Math.abs(prior.from.x - prior.to.x) <= EPS && Math.abs(prior.from.x - segment.from.x) <= EPS
        : Math.abs(prior.from.y - prior.to.y) <= EPS && Math.abs(prior.from.y - segment.from.y) <= EPS);
    if (collinear) prior.to = { ...segment.to };
    else segments.push(segment);
  };
  if (Math.abs(from.x - to.x) <= EPS || Math.abs(from.y - to.y) <= EPS) {
    push({ from: { ...from }, to: { ...to }, owner: { ...owner } });
    return;
  }
  const elbow = { x: to.x, y: from.y };
  push({ from: { ...from }, to: elbow, owner: { ...owner } });
  push({ from: elbow, to: { ...to }, owner: { ...owner } });
}

function crossesBar(segment: PathSegment, box: Rect): boolean {
  return Math.abs(segment.from.x - segment.to.x) <= EPS
    && segment.from.x >= box.x - EPS && segment.from.x <= right(box) + EPS
    && Math.max(segment.from.y, segment.to.y) > box.y + EPS
    && Math.min(segment.from.y, segment.to.y) < bottom(box) - EPS;
}

function crosses(model: LayoutModel, segments: PathSegment[], endpoint: string): string[] {
  return orderedGroupIds(model.document).flatMap(groupId => model.document.groups[groupId]!.shape === 'bar'
    ? model.groups[groupId]!.nodes : []).filter(id => {
    if (id === endpoint) return false;
    return segments.some(segment => crossesBar(segment, model.nodes[id]!.bounds!));
  });
}

function sourceStemLength(model: LayoutModel, item: BarLink, slotX: number): number {
  if (item.external.side !== 'top' && item.external.side !== 'bottom') return MIN_STEM;
  const x = item.external.anchor!.x, destination = adjacentLaneX(model, item) ?? slotX;
  const direction = Math.sign(destination - x);
  if (!direction) return MIN_STEM;
  const peers = model.links.map(link => barLink(model, link)).filter((other): other is BarLink => other !== undefined
    && other.external.ref.node === item.external.ref.node && other.external.side === item.external.side
    && Math.sign((adjacentLaneX(model, other) ?? other.port.anchor!.x) - other.external.anchor!.x) === direction
    && direction * (other.external.anchor!.x - x) > EPS);
  // Staggered drops run parallel to each other, so the pitch carries the widest resolved stroke of
  // this drop and the peers it is staggered against, not the theme default.
  const stroke = Math.max(linkStrokeWidth(item.link), ...peers.map(peer => linkStrokeWidth(peer.link)));
  const spacing = (item.link.bundle || peers.some(peer => peer.link.bundle) ? 16 : 10) + stroke;
  return MIN_STEM + new Set(peers.map(peer => portId(peer.external.ref))).size * spacing;
}

function physicalPath(model: LayoutModel, item: BarLink, slotX: number, useHints: boolean): PathSegment[] {
  const external = item.external.anchor!, target = item.port.anchor!;
  const barNodes = Object.values(model.nodes).filter(node => isBarNode(model, node.id));
  // Approach rows and bypass tracks sit one stem outside the bars — and, if that lands within the
  // edge margin of the bar group's box, outside the box by the margin instead (ADR-0013).
  const groupBox = model.groups[model.document.nodes[item.bar.id]!.group]!.bounds!;
  const margin = GROUP_EDGE_LINK_CLEARANCE + linkStrokeWidth(item.link) / 2;
  const offEdge = (value: number, edge: number, outward: 1 | -1): number =>
    Math.abs(value - edge) < margin ? edge + outward * margin : value;
  const topY = offEdge(Math.min(...barNodes.map(node => node.bounds!.y)) - MIN_STEM, groupBox.y, -1);
  const bottomY = offEdge(Math.max(...barNodes.map(node => bottom(node.bounds!))) + MIN_STEM, bottom(groupBox), 1);
  const externalSide = peerSide(item);
  const targetSide = item.port.side as 'top' | 'bottom';
  const peerY = externalSide === 'top' ? topY : bottomY;
  const targetOut = outward(target, targetSide, MIN_STEM);
  const mandatory = useHints ? hintLaneRuns(model, item) : orientedLaneRuns(model, item);
  const segments: PathSegment[] = [];
  const startStem = outward(external, item.external.side, sourceStemLength(model, item, slotX));
  appendConnector(segments, external, startStem, item.link.owner);
  let cursor = startStem;
  for (const run of mandatory) {
    appendConnector(segments, cursor, run.from, item.link.owner);
    segments.push(run); cursor = run.to;
  }
  if (externalSide === targetSide) {
    const targetY = targetSide === 'top' ? topY : bottomY;
    appendConnector(segments, cursor, { x: slotX, y: targetY }, item.link.owner);
    appendConnector(segments, { x: slotX, y: targetY }, targetOut, item.link.owner);
  } else {
    const minX = offEdge(Math.min(...barNodes.map(node => node.bounds!.x)) - MIN_STEM, groupBox.x, -1);
    const maxX = offEdge(Math.max(...barNodes.map(node => right(node.bounds!))) + MIN_STEM, right(groupBox), 1);
    const bypassX = Math.abs(cursor.x - minX) <= Math.abs(cursor.x - maxX) ? minX : maxX;
    appendConnector(segments, cursor, { x: bypassX, y: peerY }, item.link.owner);
    appendConnector(segments, { x: bypassX, y: peerY }, { x: bypassX, y: targetOut.y }, item.link.owner);
    appendConnector(segments, { x: bypassX, y: targetOut.y }, targetOut, item.link.owner);
  }
  appendConnector(segments, targetOut, target, item.link.owner);
  // Preserve the exact fixed run; its collinear approaches also touch the closed lane rectangle.
  for (const run of mandatory) for (const segment of segments) {
    if (segment === run || segment.lane !== undefined || segment.from.x !== run.from.x || segment.to.x !== run.from.x) continue;
    if ([segment.from, segment.to].some(point => samePoint(point, run.from) || samePoint(point, run.to))) segment.lane = run.lane!;
  }
  return segments;
}

function annotateCrossings(model: LayoutModel, segments: PathSegment[], crossed: string[]): void {
  for (const segment of segments) {
    if (segment.lane !== undefined) {
      const lane = model.lanes.find(lane => lane.id === segment.lane)!;
      if (Math.min(segment.from.y, segment.to.y) === lane.bounds.y && Math.max(segment.from.y, segment.to.y) === bottom(lane.bounds)) continue;
    }
    const actual = crossed.filter(id => crossesBar(segment, model.nodes[id]!.bounds!));
    if (actual.length) segment.barCross = actual;
  }
}

function traversalPath(item: BarLink, physical: PathSegment[]): PathSegment[] {
  if (item.barAt === 'to') return physical;
  return [...physical].reverse().map(segment => ({ ...segment, from: { ...segment.to }, to: { ...segment.from }, owner: { ...segment.owner },
    ...(segment.barCross ? { barCross: [...segment.barCross] } : {}) }));
}

function points(segments: PathSegment[]): Point[] {
  return segments.length ? [{ ...segments[0]!.from }, ...segments.map(segment => ({ ...segment.to }))] : [];
}

function dropId(link: LayoutLink, crossed?: string): string {
  return crossed === undefined ? `bar-drop:${link.id}` : `bar-drop:${link.id}:cross:${crossed}`;
}

/** Replace every bar-owned path and drop reservation from final anchors and fixed lane corridors. */
export function rebuildBarDrops(model: LayoutModel): void {
  const candidates = model.links.map(link => barLink(model, link)).filter((item): item is BarLink => item !== undefined);
  for (const item of candidates) delete item.link.path;
  model.barDrops = [];
  // Every drop's traversal first: a drop that leaves a port shared with other routed links is split
  // under the fan tree's junction ids (ADR-0016), and the cohort that decides the rows needs every
  // drop's path at once.
  const built = new Map<string, { item: BarLink; slotX: number; physical: PathSegment[]; crossed: string[]; traversed: PathSegment[] }>();
  for (const item of candidates) {
    const slotX = item.port.anchor!.x;
    const physical = physicalPath(model, item, slotX, item.link.bundle !== undefined);
    const crossed = crosses(model, physical, item.bar.id);
    annotateCrossings(model, physical, crossed);
    built.set(item.link.id, { item, slotX, physical, crossed, traversed: traversalPath(item, physical) });
  }
  const pending = new Map([...built.values()].filter(entry => !entry.item.link.bundle)
    .map(entry => [entry.item.link.id, { ports: [portId(entry.item.external.ref)], segments: entry.traversed }] as const));
  const cohorts = treeCohorts(model, pending);
  for (const entry of built.values()) {
    const { item, slotX, crossed } = entry;
    let traversed = entry.traversed;
    if (!item.link.bundle) {
      const cohort = cohorts.find(c => portId(c.port.ref) === portId(item.external.ref) && c.links.includes(item.link));
      if (cohort) traversed = splitUnderJunctions(model, cohort.port, cohort.links, item.link, traversed, pending);
    }
    const span = { min: item.bar.bounds!.x, max: right(item.bar.bounds!) };
    const hint = points(traversed);
    const base = {
      layer: 'routed' as const, link: item.link.id,
      source: { ...item.link.attachments!.from }, port: { ...item.link.attachments!.to },
      slotX, span, hint, barCross: crossed,
    };
    if (crossed.length) for (const node of crossed) model.barDrops.push({
      ...base, id: dropId(item.link, node), owner: { kind: 'barCross', node, link: item.link.id },
    });
    else model.barDrops.push({ ...base, id: dropId(item.link), owner: { ...item.link.owner } });
    if (!item.link.bundle) item.link.path = { owner: { ...item.link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(item.link), segments: traversed };
    if (model.document.links[item.link.sourceIndex]!.route === undefined && !item.link.bundle) item.link.technique = 'orthogonal';
  }
}

/** Stage 7d. Geometry is edited in the callback; the transaction rebuilds all derived paths. */
export function bars(model: LayoutModel): LayoutModel {
  return withLayoutMutation(model, 'bars', shapeBars);
}

export { BAR_PADDING };
