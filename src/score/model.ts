import type { Junction, Layer, LayoutLink, LayoutModel, LayoutPort, PathSegment, PortRef, Rect } from '../model/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { EPS, bottom, contains, horizontal, length, near, pointRect, right, samePoint, vertical } from './geometry.js';

export interface Segment { segment: PathSegment; link: LayoutLink; index: number; stroke: number }
export const refEqual = (a: PortRef, b: PortRef): boolean => a.node === b.node && a.ordinal === b.ordinal && a.name === b.name && a.anonymous === b.anonymous;
export const endpoints = (link: LayoutLink): { from: PortRef; to: PortRef } => {
  if (link.attachments) return link.attachments;
  if (link.from.node !== undefined && link.to.node !== undefined) return { from: link.from, to: link.to };
  throw new Error(`Link ${link.id} requires concrete port attachments`);
};
export function port(model: LayoutModel, ref: PortRef): LayoutPort | undefined { return model.nodes[ref.node]?.ports.find(candidate => refEqual(candidate.ref, ref)); }
export function effectiveLayer(link: LayoutLink): Layer {
  return link.layer ?? (link.technique !== undefined ? link.technique === 'overlay' ? 'overlay' : 'routed' : link.family ?? link.path?.layer ?? 'routed');
}
export const routed = (link: LayoutLink): boolean => effectiveLayer(link) === 'routed' && link.technique !== 'stub';
export function segments(model: LayoutModel): Segment[] {
  return model.links.filter(routed).flatMap(link => link.path!.segments.map((segment, index) => ({ segment, link, index, stroke: link.path!.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path })));
}
export function validate(model: LayoutModel): void {
  const finite = (value: unknown, at: string): void => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${at} must be finite`);
    if (Array.isArray(value)) value.forEach((item, i) => finite(item, `${at}[${i}]`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { if (key !== 'runtime') finite(item, `${at}.${key}`); });
  };
  finite(model, 'layout');
  const rect = (value: Rect | undefined, at: string): void => {
    if (!value || !['x', 'y', 'width', 'height'].every(key => typeof value[key as keyof Rect] === 'number')) throw new Error(`${at} requires final bounds`);
    if (value.width < 0 || value.height < 0) throw new Error(`${at} bounds must have nonnegative size`);
    if (!Number.isFinite(value.x + value.width) || !Number.isFinite(value.y + value.height)) throw new Error(`${at} bounds must have finite extents`);
  };
  if (Object.keys(model.nodes).length || Object.keys(model.groups).length || model.links.length || model.labels.some(l => !l.omitted)) rect(model.canvas, 'canvas');
  if (model.canvas) rect(model.canvas, 'canvas');
  for (const node of Object.values(model.nodes)) {
    rect(node.bounds, `node ${node.id}`);
    if (node.strokeWidth !== undefined && node.strokeWidth < 0) throw new Error(`node ${node.id} strokeWidth must be nonnegative`);
    for (const p of node.ports) {
      if (!p.anchor || typeof p.anchor.x !== 'number' || typeof p.anchor.y !== 'number' || !p.side) throw new Error(`port on ${node.id} requires final anchor and side`);
      if (p.pill) rect(p.pill.bounds, `pill on ${node.id}`);
    }
  }
  for (const group of Object.values(model.groups)) { rect(group.bounds, `group ${group.id}`); if (!Number.isInteger(group.tier)) throw new Error(`group ${group.id} requires final tier`); }
  model.tierBands.forEach(band => rect(band.bounds, `tier ${band.tier}`));
  model.labels.filter(l => !l.omitted).forEach(label => rect(label.bounds, `label ${label.id}`));
  model.lanes.forEach(lane => rect(lane.bounds, `lane ${lane.id}`));
  for (const link of model.links) {
    endpoints(link);
    if (link.path && link.path.layer !== effectiveLayer(link)) throw new Error(`link ${link.id} path layer conflicts with its effective layer`);
    if (link.technique !== 'stub' && (!link.path || !link.path.segments.length)) throw new Error(`link ${link.id} requires final path`);
    if (link.path?.strokeWidth !== undefined && link.path.strokeWidth < 0) throw new Error(`link ${link.id} strokeWidth must be nonnegative`);
    for (const s of link.path?.segments ?? []) {
      if (!s.from || !s.to || ![s.from.x, s.from.y, s.to.x, s.to.y].every(n => typeof n === 'number')) throw new Error(`link ${link.id} requires finite segment endpoints`);
    }
  }
}
export function anchorOnBoundary(p: LayoutPort, rect: Rect): boolean {
  const a = p.anchor!;
  if (!contains(rect, pointRect(a))) return false;
  return p.side === 'top' ? near(a.y, rect.y) : p.side === 'bottom' ? near(a.y, bottom(rect)) : p.side === 'left' ? near(a.x, rect.x) : near(a.x, right(rect));
}
export function outward(p: LayoutPort, segment: PathSegment, first: boolean): boolean {
  const a = first ? segment.from : segment.to, b = first ? segment.to : segment.from;
  if (!samePoint(a, p.anchor!)) return false;
  return p.side === 'top' ? near(a.x, b.x) && b.y < a.y - EPS
    : p.side === 'bottom' ? near(a.x, b.x) && b.y > a.y + EPS
      : p.side === 'left' ? near(a.y, b.y) && b.x < a.x - EPS
        : near(a.y, b.y) && b.x > a.x + EPS;
}
export function incident(model: LayoutModel, s: Segment, node: string): boolean {
  const ends = endpoints(s.link);
  return ([['from', 0, true], ['to', s.link.path!.segments.length - 1, false]] as const).some(([end, index, first]) => {
    const p = port(model, ends[end]);
    return ends[end].node === node && s.index === index && p !== undefined && outward(p, s.segment, first);
  });
}
export function barContact(model: LayoutModel, s: Segment, nodeId: string): boolean {
  const ends = endpoints(s.link), node = model.nodes[nodeId];
  if (!node || ends.from.node === nodeId || ends.to.node === nodeId || !s.segment.barCross?.includes(nodeId) || !vertical(s.segment)) return false;
  if (node.owner.kind !== 'group' || model.document.groups[node.owner.id]?.shape !== 'bar') return false;
  const source = port(model, ends.from)?.anchor, target = port(model, ends.to)?.anchor;
  if (!source || !target) return false;
  const minY = Math.min(source.y, target.y), maxY = Math.max(source.y, target.y);
  return model.barDrops.some(drop => drop.link === s.link.id && drop.barCross.includes(nodeId)
    && drop.owner.kind === 'barCross' && drop.owner.node === nodeId && drop.owner.link === s.link.id
    && refEqual(drop.source, ends.from) && refEqual(drop.port, ends.to)
    && near(drop.slotX, s.segment.from.x) && drop.slotX >= drop.span.min - EPS && drop.slotX <= drop.span.max + EPS
    && Math.min(s.segment.from.y, s.segment.to.y) >= minY - EPS && Math.max(s.segment.from.y, s.segment.to.y) <= maxY + EPS);
}
function claimed(s: Segment, kind: 'bundle' | 'shared-stem', id: string): boolean { return s.segment.owner.kind === kind && s.segment.owner.id === id; }
/** Bundle exemptions cover only explicitly owned runs inside their reserved geometry. */
export function bundlePair(model: LayoutModel, a: Segment, b: Segment, extent?: PathSegment): boolean {
  if (a.link.id === b.link.id || !a.link.bundle || a.link.bundle !== b.link.bundle) return false;
  const bundle = model.bundles.find(item => item.id === a.link.bundle);
  if (!bundle || bundle.owner.kind !== 'bundle' || bundle.owner.id !== bundle.id || !bundle.members.includes(a.link.id) || !bundle.members.includes(b.link.id) || !claimed(a, 'bundle', bundle.id) || !claimed(b, 'bundle', bundle.id)) return false;
  const zone = bundle.envelope ?? bundle.rows;
  return zone !== undefined && (extent ? [extent.from, extent.to] : [a.segment.from, a.segment.to, b.segment.from, b.segment.to]).every(p => contains(zone, pointRect(p)));
}
/** The exact root-to-vertex chain, checked against each declared member's authored traversal. */
export function junctionChain(model: LayoutModel, junction: Junction): Junction[] | undefined {
  const chain: Junction[] = [], seen = new Set<string>();
  let current: Junction | undefined = junction;
  while (current) {
    if (seen.has(current.id) || model.junctions.filter(j => j.id === current!.id).length !== 1) return undefined;
    seen.add(current.id); chain.unshift(current);
    if (!current.stem || !current.point || current.owner.kind !== 'shared-stem' || current.owner.id !== current.id
      || current.stem.owner.kind !== 'shared-stem' || current.stem.owner.id !== current.id
      || current.layer !== 'routed' || current.links.length < 2 || new Set(current.links).size !== current.links.length
      || !samePoint(current.stem.to, current.point) || length(current.stem) <= EPS
      || !horizontal(current.stem) && !vertical(current.stem)) return undefined;
    if (!current.parent) break;
    const parent = model.junctions.find(j => j.id === current!.parent);
    if (!parent?.point || !refEqual(parent.port, current.port) || !samePoint(current.stem.from, parent.point)
      || current.links.length >= parent.links.length || current.links.some(id => !parent.links.includes(id))) return undefined;
    current = parent;
  }
  const root = chain[0]!, p = port(model, root.port);
  if (!p || !root.stem || !outward(p, root.stem, true) || length(root.stem) < 15 - EPS) return undefined;
  for (const [depth, j] of chain.entries()) {
    for (const id of j.links) {
      const link = model.links.find(l => l.id === id);
      if (!link) return undefined;
      const ends = endpoints(link), source = refEqual(ends.from, j.port), target = refEqual(ends.to, j.port);
      if (source === target) return undefined;
      for (let i = 0; i <= depth; i++) {
        const vertex = chain[i]!, partial = !link.path ? link.sharedRuns?.[source ? 'from' : 'to'] : undefined;
        const run = partial ? partial[i] : link.path?.segments[source ? i : link.path.segments.length - 1 - i];
        if (!run || run.owner.kind !== 'shared-stem' || run.owner.id !== vertex.id
          || !samePoint(source || partial ? run.from : run.to, vertex.stem!.from)
          || !samePoint(source || partial ? run.to : run.from, vertex.stem!.to)) return undefined;
      }
    }
    const children = model.junctions.filter(child => child.parent === j.id);
    for (let i = 0; i < children.length; i++) if (children.slice(i + 1).some(child => child.links.some(id => children[i]!.links.includes(id)))) return undefined;
  }
  return chain;
}
function junctionPosition(model: LayoutModel, j: Junction, s: Segment, depth: number): number | undefined {
  if (!j.links.includes(s.link.id)) return undefined;
  const ends = endpoints(s.link);
  if (refEqual(ends.from, j.port)) return s.index - depth;
  if (refEqual(ends.to, j.port)) return s.link.path!.segments.length - 1 - s.index - depth;
  return undefined;
}
export function sharedStem(model: LayoutModel, a: Segment, b: Segment, overlap: PathSegment): boolean {
  return model.junctions.some(j => {
    const chain = junctionChain(model, j);
    if (!chain || !claimed(a, 'shared-stem', j.id) || !claimed(b, 'shared-stem', j.id)
      || [a, b].some(s => junctionPosition(model, j, s, chain.length - 1) !== 0)) return false;
    const stem = j.stem!;
    return (horizontal(stem) ? horizontal(overlap) && near(overlap.from.y, stem.from.y)
      : vertical(overlap) && near(overlap.from.x, stem.from.x))
      && [overlap.from, overlap.to].every(p => contains({ x: Math.min(stem.from.x, stem.to.x), y: Math.min(stem.from.y, stem.to.y),
        width: Math.abs(stem.to.x - stem.from.x), height: Math.abs(stem.to.y - stem.from.y) }, pointRect(p)));
  });
}
/** Only the incident run and immediately outgoing branches at one verified tree vertex qualify. */
export function junctionFan(model: LayoutModel, a: Segment, b: Segment): boolean {
  return model.junctions.some(j => {
    const chain = junctionChain(model, j);
    if (!chain) return false;
    return [a, b].every(s => {
      const position = junctionPosition(model, j, s, chain.length - 1);
      if (position === 0) return claimed(s, 'shared-stem', j.id);
      if (position !== 1) return false;
      const ends = endpoints(s.link), start = refEqual(ends.from, j.port) ? s.segment.from : s.segment.to;
      if (!samePoint(start, j.point!)) return false;
      if (claimed(s, 'shared-stem', j.id)) return true;
      return model.junctions.some(child => child.parent === j.id && child.links.includes(s.link.id)
        && claimed(s, 'shared-stem', child.id) && junctionChain(model, child) !== undefined);
    });
  });
}

/** A merged overlap must be covered by actual, counted runs for the exact selected members. */
export function mergedRun(model: LayoutModel, a: Segment, b: Segment, overlap: PathSegment): boolean {
  if (!bundlePair(model, a, b, overlap) || a.link.technique !== 'merge' || b.link.technique !== 'merge') return false;
  const bundle = model.bundles.find(item => item.id === a.link.bundle)!;
  const h = horizontal(overlap), at = (p: { x: number; y: number }): number => h ? p.x : p.y;
  const low = Math.min(at(overlap.from), at(overlap.to)), high = Math.max(at(overlap.from), at(overlap.to));
  const intervals: [number, number][] = [];
  for (const run of bundle.mergeRuns ?? []) {
    if (run.count < 2 || run.count !== run.members.length || new Set(run.members).size !== run.count
      || !run.members.includes(a.link.id) || !run.members.includes(b.link.id)
      || run.path.owner.kind !== 'bundle' || run.path.owner.id !== bundle.id || run.path.layer !== 'routed') continue;
    for (const segment of run.path.segments) {
      if (segment.owner.kind !== 'bundle' || segment.owner.id !== bundle.id
        || !(h ? horizontal(segment) && near(segment.from.y, overlap.from.y) : vertical(segment) && near(segment.from.x, overlap.from.x))) continue;
      const lo = Math.min(at(segment.from), at(segment.to)), hi = Math.max(at(segment.from), at(segment.to));
      if (!run.members.every(id => {
        const link = model.links.find(link => link.id === id);
        return link?.technique === 'merge' && link.bundle === bundle.id && link.path?.segments.some(s => s.owner.kind === 'bundle' && s.owner.id === bundle.id
          && (h ? horizontal(s) && near(s.from.y, segment.from.y) : vertical(s) && near(s.from.x, segment.from.x))
          && Math.min(at(s.from), at(s.to)) <= lo + EPS && Math.max(at(s.from), at(s.to)) >= hi - EPS);
      })) continue;
      intervals.push([lo, hi]);
    }
  }
  let covered = low;
  for (const [lo, hi] of intervals.sort((a, b) => a[0] - b[0])) {
    if (lo > covered + EPS) return false;
    if (hi > covered) covered = hi;
    if (covered >= high - EPS) return true;
  }
  return false;
}
