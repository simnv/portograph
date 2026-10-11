import type { PortRef } from '../model/document.js';
import type { LayoutModel } from '../model/layout.js';
import { portId } from './skeleton-graph.js';
import { COURSE_STEM, endMode } from './course-rows.js';

/**
 * The order of the ports of one face from the planned first turn of their links (architecture ticket 24, `docs/design/turn-order.md`).
 *
 * `turn` is the direction of the first turn of a planned route, read from a reservation that exists before routing: `low` (up on a lateral face, left on a
 * horizontal one), `high`, or `none`. `shape` is `return` when the second turn goes back toward the node's side of the face line, else `onward`.
 * `reach` is the coordinate, along the face, of the second turn.
 */
export type Turn = 'low' | 'high' | 'none';
export interface TurnPort {
  /** The coordinate along the face that the run goes to, the key of today's order. */
  far: number;
  turn?: Turn | undefined;
  shape?: 'return' | 'onward' | undefined;
  reach?: number | undefined;
}

/** The five groups from the low end (spec, Section 3). */
function group(port: TurnPort): 1 | 2 | 3 | 4 | 5 {
  if (port.turn === undefined || port.turn === 'none' || port.reach === undefined) return 3;
  if (port.turn === 'low') return port.shape === 'return' ? 1 : 2;
  return port.shape === 'return' ? 5 : 4;
}

/**
 * One comparator on one scale. Low-turn `return` (reach descending), low-turn `onward` (reach ascending), no turn (far end), high-turn `onward` (reach
 * ascending), high-turn `return` (reach descending). A port with no turn that stands next to low-turn returns (overlay brackets) keeps the place ticket 15
 * gives it: above them when its far end lies before their least reach, else in group 3. Total: group, then one number.
 */
export function turnOrder(ports: readonly TurnPort[]): (a: TurnPort, b: TurnPort) => number {
  const reaches = ports.flatMap(port => (group(port) === 1 ? [port.reach!] : []));
  const edge = reaches.length === 0 ? Infinity : Math.min(...reaches);
  const rank = (port: TurnPort): number => {
    const g = group(port);
    return g === 3 && reaches.length > 0 && port.far < edge ? 0 : g;
  };
  const key = (port: TurnPort): number => {
    const g = group(port);
    return g === 1 || g === 5 ? -port.reach! : g === 3 ? port.far : port.reach!;
  };
  return (a, b) => rank(a) - rank(b) || (key(a) === key(b) ? 0 : key(a) - key(b));
}

/** What a reservation says about the first turn at one end of a link. */
export interface PlannedTurn { turn: Turn; shape: 'return' | 'onward'; reach: number }

/**
 * The planned first turn of every port end that a reservation fixes before routing, by port key. Phase 1 reads the overlay courses only (ticket 15): a
 * bracket leaves a lateral face, turns toward its margin and returns to the far end's row, beyond it by a padding row, short of it by a drop.
 */
export function plannedTurns(model: LayoutModel): Map<string, PlannedTurn> {
  const planned = new Map<string, PlannedTurn>();
  const anchor = (ref: PortRef): { x: number; y: number } | undefined => model.nodes[ref.node]?.ports.find(port => portId(port.ref) === portId(ref))?.anchor;
  for (const course of model.courses ?? []) {
    const link = course.kind === 'overlay' ? model.links.find(item => item.id === course.link) : undefined;
    if (link?.attachments === undefined) continue;
    for (const [mine, other, which] of [[link.attachments.from, link.attachments.to, 'to'], [link.attachments.to, link.attachments.from, 'from']] as const) {
      const mode = endMode(course, which);
      const bias = mode === 'padding' ? COURSE_STEM : mode === 'natural' ? -2 * COURSE_STEM : 0;
      const here = anchor(mine), there = anchor(other);
      if (here === undefined || there === undefined) continue;
      planned.set(portId(mine), { turn: 'low', shape: 'return', reach: there.y + Math.sign(there.y - here.y) * bias });
    }
  }
  return planned;
}
