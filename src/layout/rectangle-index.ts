import type { Rect } from '../model/geometry.js';

type Coordinates = [number, number, number, number];
export type RectangleBounds = Rect | { left: number; top: number; right: number; bottom: number };
interface Entry<T> { point: Coordinates; value: T }
interface Tree<T> { minimum: Coordinates; entries?: Entry<T>[]; left?: Tree<T>; right?: Tree<T> }
interface Block<T> { entries: Entry<T>[]; tree: Tree<T> }

/** Optional counters for scale probes; counts tree visits separately from exact candidate tests. */
export interface RectangleQueryWork { nodes: number; items: number }

const bits = new DataView(new ArrayBuffer(8));
/** Adjacent representable value toward +Infinity, including zeros and overflow. */
function up(value: number): number {
  if (value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + (value > 0 ? 1n : -1n));
  return bits.getFloat64(0);
}
const down = (value: number): number => -up(-value);

// Keep padded edges directly: rebuilding right as (left - pad) + (width + 2*pad)
// can erase clearance through cancellation at large coordinates.
function coordinates(bounds: RectangleBounds, padding: number): Coordinates {
  const left = 'left' in bounds ? bounds.left : bounds.x;
  const top = 'top' in bounds ? bounds.top : bounds.y;
  const right = 'right' in bounds ? bounds.right : bounds.x + bounds.width;
  const bottom = 'bottom' in bounds ? bounds.bottom : bounds.y + bounds.height;
  return padding === 0 ? [left, top, -right, -bottom]
    : [down(left - padding), down(top - padding), -up(right + padding), -up(bottom + padding)];
}

// Rectangles intersect iff (left, top, -right, -bottom) lies below the query's four thresholds.
function entry<T>(bounds: RectangleBounds, value: T, padding = 0): Entry<T> {
  return { point: coordinates(bounds, padding), value };
}

function build<T>(entries: Entry<T>[], depth = 0): Tree<T> {
  const minimum: Coordinates = [Infinity, Infinity, Infinity, Infinity];
  for (const item of entries) for (let axis = 0; axis < 4; axis++) {
    minimum[axis] = Math.min(minimum[axis]!, item.point[axis]!);
  }
  if (entries.length <= 8) return { minimum, entries };
  const axis = depth % 4;
  entries.sort((a, b) => a.point[axis]! < b.point[axis]! ? -1 : a.point[axis]! > b.point[axis]! ? 1 : 0);
  const middle = Math.floor(entries.length / 2);
  return { minimum, left: build(entries.slice(0, middle), depth + 1), right: build(entries.slice(middle), depth + 1) };
}

/**
 * Inclusive rectangle queries in a balanced four-dimensional tree. Each rectangle is one point,
 * so long runs, coincident stems and large queries never enumerate coordinate cells. Subtree
 * minima reject disjoint rectangles before visiting members. Queries stop at the first accepted
 * predicate, without collecting or sorting a candidate list.
 *
 * Initial obstacles build one tree. Accepted labels form a forest of power-of-two blocks; an
 * insertion merges equal-sized blocks, keeping every tree balanced without rebuilding the static
 * obstacles. Query work depends on visited bounds and actual rectangle hits, not pixel extent.
 */
export class RectangleIndex<T> {
  private readonly base: Tree<T> | undefined;
  private readonly additions: (Block<T> | undefined)[] = [];

  constructor(initial: readonly { bounds: RectangleBounds; value: T; padding?: number }[] = []) {
    this.base = initial.length ? build(initial.map(item => entry(item.bounds, item.value, item.padding))) : undefined;
  }

  add(bounds: RectangleBounds, value: T, padding = 0): void {
    let entries = [entry(bounds, value, padding)], level = 0;
    while (this.additions[level]) {
      entries = this.additions[level]!.entries.concat(entries);
      this.additions[level] = undefined;
      level++;
    }
    this.additions[level] = { entries, tree: build(entries) };
  }

  some(bounds: RectangleBounds, predicate: (value: T) => boolean, work?: RectangleQueryWork, padding = 0): boolean {
    const point = coordinates(bounds, padding);
    const limit: Coordinates = [-point[2], -point[3], -point[0], -point[1]];
    const visit = (tree: Tree<T>): boolean => {
      if (work) work.nodes++;
      if (tree.minimum.some((value, axis) => value > limit[axis]!)) return false;
      if (tree.entries) {
        for (const item of tree.entries) {
          if (item.point.some((value, axis) => value > limit[axis]!)) continue;
          if (work) work.items++;
          if (predicate(item.value)) return true;
        }
        return false;
      }
      return visit(tree.left!) || visit(tree.right!);
    };
    // New labels often reject a later candidate immediately, before touching static segments.
    for (const block of this.additions) if (block && visit(block.tree)) return true;
    return this.base ? visit(this.base) : false;
  }
}
