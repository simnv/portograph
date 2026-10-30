import type { LayoutModel, ParentSpread } from '../../model/layout.js';
import type { Side } from '../../model/geometry.js';

/**
 * The spread a parent below the anchor tier took over its children (`LayoutModel.parentSpreads`, architecture-2 ticket 32): the centre rule
 * decides it once, before its first step, and every later rule reads it here. `undefined` when the node did not spread.
 *
 * The one reader of the record (R1). The spread is geometry once made: the steps, the parent stand, the wall-move give-back and the
 * publication check read the ports and the boxes it left, and none of them decides a spread again. The face recentring after centring
 * reads the record, so that it holds a spread face where the spread put it (`recentreSeatedFaces`).
 */
export function parentSpread(model: LayoutModel, node: string): ParentSpread | undefined {
  return model.parentSpreads?.[node];
}

/** Whether `side` of `node` is a face a parent spread over its children: the bottom face of a spread parent. */
export function isSpreadFace(model: LayoutModel, node: string, side: Side): boolean {
  return side === 'bottom' && parentSpread(model, node) !== undefined;
}
