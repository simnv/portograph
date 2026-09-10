import type { Bundle, LayoutModel, PathSegment, Point, Rect } from '../model/index.js';
import { segmentRect, segmentRectDistance } from '../score/geometry.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { coordinate, normal, type Member } from './bundle-geometry.js';
import { BundleFeasibilityError, pathBounds, polyline } from './bundle-paths.js';

const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
const segment = (from: Point, to: Point, bundle: Bundle): PathSegment => ({ from, to, owner: bundle.owner });
function rects(model: LayoutModel, bundle: Bundle, halfWidth: number): Rect[] {
  const obstacles = Object.values(model.nodes).map(node => inflate(node.bounds!, halfWidth + 10 + (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) / 2));
  for (const lane of model.lanes) obstacles.push(inflate(lane.bounds, halfWidth + 0.001));
  for (const label of model.labels) if (label.bounds && !label.omitted && label.layer !== 'overlay') obstacles.push(inflate(label.bounds, halfWidth + 0.001));
  for (const link of model.links) {
    if (!link.path || link.bundle === bundle.id || link.layer !== 'routed') continue;
    for (const s of link.path.segments) obstacles.push(inflate(pathBounds([s]), halfWidth + 10 + (link.path.strokeWidth ?? DEFAULT_STROKE_WIDTHS.path) / 2));
  }
  return obstacles;
}
/** Axis visibility graph for the full swept channel, with bounded deterministic shortest-path work. */
function route(start: Point, end: Point, obstacles: Rect[], bundle: Bundle): Point[] {
  const xs = [...new Set([start.x, end.x, ...obstacles.flatMap(r => [r.x - 0.001, r.x + r.width + 0.001])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...obstacles.flatMap(r => [r.y - 0.001, r.y + r.height + 0.001])])].sort((a, b) => a - b);
  if (xs.length * ys.length > 40000) throw new BundleFeasibilityError('BUNDLE_CHANNEL_SEARCH_LIMIT', bundle.id, 'The envelope visibility grid exceeds 40000 vertices.');
  const id = (x: number, y: number): number => y * xs.length + x;
  const first = id(xs.indexOf(start.x), ys.indexOf(start.y)), last = id(xs.indexOf(end.x), ys.indexOf(end.y));
  const point = (index: number): Point => ({ x: xs[index % xs.length]!, y: ys[Math.floor(index / xs.length)]! });
  const distances = new Map<number, number>([[first, 0]]), previous = new Map<number, number>(), pending = new Set([first]), visited = new Set<number>();
  while (pending.size) {
    let current = -1, distance = Infinity;
    for (const candidate of pending) if (distances.get(candidate)! < distance) { current = candidate; distance = distances.get(candidate)!; }
    if (current === last) {
      const points = [end]; let cursor = current;
      while (cursor !== first) { cursor = previous.get(cursor)!; points.push(point(cursor)); }
      return points.reverse();
    }
    pending.delete(current); visited.add(current);
    const x = current % xs.length, y = Math.floor(current / xs.length), from = point(current);
    const candidates = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of candidates) {
      if (nx! < 0 || nx! >= xs.length || ny! < 0 || ny! >= ys.length) continue;
      const next = id(nx!, ny!); if (visited.has(next)) continue;
      const to = point(next), run = segment(from, to, bundle);
      if (obstacles.some(r => segmentRect(run, r))) continue;
      const candidate = distance + Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
      if (candidate >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, candidate); previous.set(next, current); pending.add(next);
    }
  }
  throw new BundleFeasibilityError('BUNDLE_CHANNEL_BLOCKED', bundle.id, 'No clear envelope-width centreline connects the fixed endpoint normals.');
}
function offset(points: Point[], distance: number, bundle: Bundle): PathSegment[] {
  const lines = points.slice(1).map((to, i) => {
    const from = points[i]!, dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
    return { from: { x: from.x - dy * distance, y: from.y + dx * distance }, to: { x: to.x - dy * distance, y: to.y + dx * distance } };
  });
  const result = [lines[0]!.from];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!, b = lines[i]!;
    result.push(a.from.x === a.to.x ? { x: a.from.x, y: b.from.y } : { x: b.from.x, y: a.from.y });
  }
  result.push(lines.at(-1)!.to);
  return polyline(result, bundle.owner);
}
/** Route a centreline with full channel width, then offset every member through the same turns. */
export function routeBundleChannel(model: LayoutModel, bundle: Bundle, list: Member[]): { centreline: PathSegment[]; paths: Map<string, PathSegment[]> } | undefined {
  if (list.length < 2) return undefined;
  const n = normal(list[0]!.a.side!), m = normal(list[0]!.b.side!);
  if (n.x !== -m.x || n.y !== -m.y) return undefined;
  const mean = (end: 'a' | 'b'): Point => ({ x: list.reduce((sum, item) => sum + item[end].anchor!.x, 0) / list.length,
    y: list.reduce((sum, item) => sum + item[end].anchor!.y, 0) / list.length });
  const a = mean('a'), b = mean('b'), tangent = n.x !== 0 ? 'y' : 'x';
  if (list.some(item => Math.abs(item.a.anchor![tangent] - a[tangent] - item.b.anchor![tangent] + b[tangent]) > 1e-6)) return undefined;
  const halfWidth = Math.max(...list.map(item => Math.abs(item.a.anchor![tangent] - a[tangent]))) + DEFAULT_STROKE_WIDTHS.path / 2;
  const obstacles = rects(model, bundle, halfWidth), stem = halfWidth + 15;
  const start = { x: a.x + n.x * stem, y: a.y + n.y * stem }, end = { x: b.x + m.x * stem, y: b.y + m.y * stem };
  const points = [a, ...route(start, end, obstacles, bundle), b];
  const centreline = polyline(points, bundle.owner), reduced = [centreline[0]!.from, ...centreline.map(s => s.to)];
  const paths = new Map(list.map(item => [item.link.id, offset(reduced, (coordinate(item.a) - a[tangent]) * (n.x !== 0 ? n.x : -n.y), bundle)]));
  return { centreline, paths };
}
export function clearBundleMembers(model: LayoutModel, bundle: Bundle, paths: PathSegment[][]): boolean {
  for (const segments of paths) for (const [index, segment] of segments.entries()) {
    for (const node of Object.values(model.nodes)) {
      if (index === 0 && bundle.nodes.includes(node.id) || index === segments.length - 1 && bundle.nodes.includes(node.id)) continue;
      if (segmentRectDistance(segment, node.bounds!) < 10 + (DEFAULT_STROKE_WIDTHS.path + (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2 - 1e-6) return false;
    }
  }
  return true;
}
