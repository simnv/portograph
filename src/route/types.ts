import type { Point, Rect } from '../model/geometry.js';

/**
 * The serializable stage-8 router contract. Everything here is plain JSON: the host decides all
 * geometry and ownership, the worker only drives libavoid. No libavoid class, enum object, WASM
 * handle or asset URL ever reaches the layout model.
 */

/** libavoid `ConnDirFlags`: the side of a point through which a connector enters or leaves. */
export const DIRECTION_BITS = { top: 1, bottom: 2, left: 4, right: 8 } as const;
export const ALL_DIRECTIONS = 15;

export interface RoutePin {
  /** Non-zero pin class, unique per node shape. */
  classId: number;
  x: number;
  y: number;
  directions: number;
  /** False when more than one link end uses the port, including ends already fixed by a rule. */
  exclusive: boolean;
}
export interface RouteShape {
  id: string;
  /** Already expanded by its clearance; the worker keeps `shapeBufferDistance` at 0. */
  bounds: Rect;
  pins?: RoutePin[];
}
export interface RouteCheckpoint extends Point {
  arrival: number;
  departure: number;
}
export type RouteEndpoint =
  | { kind: 'pin'; shape: string; classId: number }
  | { kind: 'point'; x: number; y: number };
export interface RouteConnector {
  id: string;
  from: RouteEndpoint;
  to: RouteEndpoint;
  checkpoints: RouteCheckpoint[];
}
export interface RouteBatch {
  id: string;
  shapeBufferDistance: number;
  parameters: Record<string, number>;
  shapes: RouteShape[];
  connectors: RouteConnector[];
}
export interface RoutedConnector {
  connector: string;
  points: Point[];
}
