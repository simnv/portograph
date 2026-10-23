import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { orderedGroupIds } from '../model/model.js';
import { EPS, samePoint } from '../geometry/planar.js';
import { overlayTrackPitch } from '../theme/geometry.js';
import { bandHeldBy } from './regions.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * Two overlay detours never share a track (architecture-2 ticket 23). The one predicate: the overlay path derivation separates the
 * runs it finds (`overlay-paths.ts`), and the scorer counts the pairs that remain (`overlayTrackShares`). Two readers, one function (R1).
 */

/** One overlay path as the predicate reads it: its points, and the stroke the pitch is read from. */
export interface TrackPath { readonly points: readonly Point[]; readonly strokeWidth: number }

/** An axis-aligned run of a path: `horizontal` runs along x at `at` = y, a vertical one along y at `at` = x, over `[low, high]`. */
export interface TrackRun {
  readonly path: number; readonly index: number; readonly horizontal: boolean; readonly at: number; readonly low: number; readonly high: number;
}

/** The axis-aligned runs of one path, zero-length and diagonal runs left out. */
export function trackRuns(points: readonly Point[], path: number): TrackRun[] {
  const runs: TrackRun[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const from = points[index]!, to = points[index + 1]!;
    const horizontal = Math.abs(from.y - to.y) <= EPS, vertical = Math.abs(from.x - to.x) <= EPS;
    if (horizontal === vertical) continue;
    runs.push(horizontal
      ? { path, index, horizontal, at: from.y, low: Math.min(from.x, to.x), high: Math.max(from.x, to.x) }
      : { path, index, horizontal, at: from.x, low: Math.min(from.y, to.y), high: Math.max(from.y, to.y) });
  }
  return runs;
}

/**
 * Whether two runs of two paths lie on one track: on one axis, nearer than the track pitch across it, and overlapping or meeting end to
 * end within the pitch along it.
 */
export function onOneTrack(one: TrackRun, two: TrackRun, pitch: number): boolean {
  if (one.horizontal !== two.horizontal || Math.abs(one.at - two.at) >= pitch - EPS) return false;
  return Math.max(one.low, two.low) - Math.min(one.high, two.high) < pitch - EPS;
}

/**
 * Whether two runs on one track are a **fork**, not a shared track: two paths that leave one port (a shared end point) draw the same
 * vertices from it until they part. A run of that common stretch is drawn once, and the two runs that leave its last vertex the opposite
 * ways meet only there, as a branch does. Neither can part without moving the port. Runs that leave the fork the same way, or meet
 * anywhere else, share a track.
 */
export function forks(one: readonly Point[], first: number, two: readonly Point[], second: number): boolean {
  for (const reverseOne of [false, true]) for (const reverseTwo of [false, true]) {
    const a = reverseOne ? [...one].reverse() : one, b = reverseTwo ? [...two].reverse() : two;
    let common = 0;
    while (common < a.length && common < b.length && samePoint(a[common]!, b[common]!)) common++;
    if (common === 0) continue;
    const runA = reverseOne ? one.length - 2 - first : first, runB = reverseTwo ? two.length - 2 - second : second;
    // Both on the common stretch, or both its first run (the stubs out of the port, of any length).
    if (runA < common - 1 && runB < common - 1 || runA === 0 && runB === 0 && common === 1) return true;
    // Both leave the last common vertex, the opposite ways.
    if (runA === common - 1 && runB === common - 1 && common >= 2) {
      const fork = a[common - 1]!, toA = a[common]!, toB = b[common]!;
      if ((toA.x - fork.x) * (toB.x - fork.x) + (toA.y - fork.y) * (toB.y - fork.y) < 0) return true;
    }
  }
  return false;
}

/** One pair of runs on one track: `[path, run index]` of each. */
export type TrackShare = readonly [readonly [number, number], readonly [number, number]];

/**
 * Every pair of runs of two different paths that share a track: on one track (`onOneTrack`) and no fork (`forks`). Runs are swept per
 * axis in order of `at`, so a pair farther apart than the widest pitch is never compared. Order: by the first run's path and index,
 * then the second's.
 */
export function sharedTrackPairs(paths: readonly TrackPath[]): TrackShare[] {
  const runs = paths.flatMap((path, index) => trackRuns(path.points, index));
  const widest = Math.max(0, ...paths.map(path => path.strokeWidth));
  const reach = overlayTrackPitch(widest, widest);
  const found: TrackShare[] = [];
  for (const horizontal of [true, false]) {
    // Last key: the path's position in `paths`, then the run index; the caller's order is its own.
    const axis = runs.filter(run => run.horizontal === horizontal).sort((a, b) => a.at - b.at || a.path - b.path || a.index - b.index);
    for (let i = 0; i < axis.length; i++) {
      const one = axis[i]!;
      for (let j = i + 1; j < axis.length && axis[j]!.at - one.at < reach; j++) {
        const two = axis[j]!;
        if (one.path === two.path) continue;
        if (!onOneTrack(one, two, overlayTrackPitch(paths[one.path]!.strokeWidth, paths[two.path]!.strokeWidth))) continue;
        const [first, second] = one.path < two.path ? [one, two] : [two, one];
        if (forks(paths[first.path]!.points, first.index, paths[second.path]!.points, second.index)) continue;
        found.push([[first.path, first.index], [second.path, second.index]]);
      }
    }
  }
  return found.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1] || a[1][0] - b[1][0] || a[1][1] - b[1][1]);
}

/** Where an axis-aligned run lies in a group's padding (`paddingOf`): the group, the edge, and whether its title band holds that edge. */
export interface PaddingSide { group: string; side: Side; title: boolean }

/**
 * The padding a run lies in (architecture-2 tickets 21 and 23): the first plain group, in group order (`orderedGroupIds`, the last key),
 * whose box holds the run, when the run lies beyond the group's node bodies on one side. `undefined` when the run has no axis, lies in
 * no box of a plain group (outside every group, or in a rank cell, whose border the frame draws), or lies in the first such box between
 * two node rows. The room across a run (`acrossRunPadding`) and the overlay track room both read it (R1).
 */
export function paddingOf(model: LayoutModel, from: Point, to: Point): PaddingSide | undefined {
  const horizontal = Math.abs(to.y - from.y) <= PLACEMENT_EPS, vertical = Math.abs(to.x - from.x) <= PLACEMENT_EPS;
  if (horizontal === vertical) return undefined;
  const low = (axis: 'x' | 'y'): number => Math.min(from[axis], to[axis]), high = (axis: 'x' | 'y'): number => Math.max(from[axis], to[axis]);
  for (const id of orderedGroupIds(model.document)) {
    const group = model.groups[id];
    if (group === undefined || group.frame !== undefined || !group.nodes.length || group.bounds === undefined) continue;
    const box = group.bounds;
    const inside = horizontal
      ? from.y > box.y + PLACEMENT_EPS && from.y < box.y + box.height - PLACEMENT_EPS && low('x') >= box.x - PLACEMENT_EPS && high('x') <= box.x + box.width + PLACEMENT_EPS
      : from.x > box.x + PLACEMENT_EPS && from.x < box.x + box.width - PLACEMENT_EPS && low('y') >= box.y - PLACEMENT_EPS && high('y') <= box.y + box.height + PLACEMENT_EPS;
    if (!inside) continue;
    const bodies = bodiesOf(model, group.nodes);
    const side: Side | undefined = horizontal
      ? from.y < bodies.y - PLACEMENT_EPS ? 'top' : from.y > bodies.y + bodies.height + PLACEMENT_EPS ? 'bottom' : undefined
      : from.x < bodies.x - PLACEMENT_EPS ? 'left' : from.x > bodies.x + bodies.width + PLACEMENT_EPS ? 'right' : undefined;
    return side === undefined ? undefined : { group: id, side, title: bandHeldBy(model, id)?.side === side };
  }
  return undefined;
}

/** The box of a group's node bodies. */
export function bodiesOf(model: LayoutModel, nodes: readonly string[]): Rect {
  const boxes = nodes.map(id => model.nodes[id]!.bounds!);
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}

/** How far a point stands beyond the bodies on one edge: the reach a run takes out of the room across it. */
export function reachBeyond(bodies: Rect, side: Side, at: Point): number {
  return side === 'top' ? bodies.y - at.y : side === 'bottom' ? at.y - (bodies.y + bodies.height)
    : side === 'left' ? bodies.x - at.x : at.x - (bodies.x + bodies.width);
}
