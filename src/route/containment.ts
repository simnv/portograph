import { bottom, right } from '../geometry/planar.js';
import type { RouteShape } from './types.js';

function bound(values: number[], value: number, inclusive = false): number {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value || (inclusive && values[middle] === value)) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface Bucket {
  tops: number[];
  /** Indices of retained shapes, with the greatest bottom edge in each prefix. */
  maxima: number[];
}

/**
 * A left-edge sweep supplies x <= candidate.x. The remaining containment query is
 * right >= candidate.right, top <= candidate.top, bottom >= candidate.bottom.
 * Two compressed Fenwick dimensions index -right and top; their prefix maximum
 * supplies the bottom edge and a concrete surviving container. No removals occur.
 */
class ContainerIndex {
  private readonly rights: number[];
  private readonly bottoms: number[];
  private readonly buckets: Bucket[];

  constructor(private readonly shapes: RouteShape[]) {
    this.rights = [...new Set(shapes.map(shape => -right(shape.bounds)))].sort((a, b) => a - b);
    this.bottoms = shapes.map(shape => bottom(shape.bounds));
    this.buckets = Array.from({ length: this.rights.length + 1 }, () => ({ tops: [], maxima: [] }));
    // Offline coordinate collection makes every later update/query O(log² n),
    // using O(n log n) space even for long, coincident, or densely nested boxes.
    for (const shape of shapes) {
      for (let i = bound(this.rights, -right(shape.bounds)) + 1; i < this.buckets.length; i += i & -i) {
        this.buckets[i]!.tops.push(shape.bounds.y);
      }
    }
    for (const bucket of this.buckets) {
      bucket.tops = [...new Set(bucket.tops)].sort((a, b) => a - b);
      bucket.maxima = Array<number>(bucket.tops.length + 1).fill(-1);
    }
  }

  private greatest(a: number, b: number): number {
    if (a < 0) return b;
    if (b < 0) return a;
    const difference = this.bottoms[a]! - this.bottoms[b]!;
    return difference > 0 ? a : difference < 0 ? b : Math.min(a, b);
  }

  add(index: number): void {
    const box = this.shapes[index]!.bounds;
    for (let i = bound(this.rights, -right(box)) + 1; i < this.buckets.length; i += i & -i) {
      const bucket = this.buckets[i]!;
      for (let j = bound(bucket.tops, box.y) + 1; j < bucket.maxima.length; j += j & -j) {
        bucket.maxima[j] = this.greatest(bucket.maxima[j]!, index);
      }
    }
  }

  covering(index: number): number {
    const box = this.shapes[index]!.bounds;
    let found = -1;
    for (let i = bound(this.rights, -right(box), true); i > 0; i -= i & -i) {
      const bucket = this.buckets[i]!;
      for (let j = bound(bucket.tops, box.y, true); j > 0; j -= j & -j) {
        found = this.greatest(found, bucket.maxima[j]!);
      }
    }
    return found >= 0 && this.bottoms[found]! >= bottom(box) ? found : -1;
  }
}

/**
 * Remove only exactly contained rectangles before libavoid's visibility sweep.
 * Collision EPS is intentionally not used: approximate containment is neither
 * transitive nor acyclic, and dropping by it can erase the obstacle union.
 * Partially overlapping rectangles retain their original coordinates.
 */
export function disjointShapes(shapes: RouteShape[]): RouteShape[] {
  const order = shapes.map((shape, index) => ({ shape, index })).sort((a, b) =>
    a.shape.bounds.x - b.shape.bounds.x
    || right(b.shape.bounds) - right(a.shape.bounds)
    || a.shape.bounds.y - b.shape.bounds.y
    || bottom(b.shape.bounds) - bottom(a.shape.bounds)
    || a.index - b.index);
  const index = new ContainerIndex(shapes);
  const kept = new Set<number>();
  for (const item of order) {
    const container = index.covering(item.index);
    if (container >= 0) {
      if (item.shape.pins?.length) {
        throw new Error(`Router obstacle ${shapes[container]!.id} contains the attachment shape ${item.shape.id}`);
      }
      continue;
    }
    // A true container sorts before its contents. Exact transitivity means this
    // retained shape will also cover any descendants of a rectangle it removes.
    kept.add(item.index);
    index.add(item.index);
  }
  // Preserve libavoid's input order; coincident duplicates retain their first id.
  return shapes.filter((_, i) => kept.has(i));
}
