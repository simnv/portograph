import type { LayoutModel } from '../model/index.js';
import { withLayoutMutation } from './mutation.js';

/** Stage 7e. The checked finalizer plans capacity and derives all bundle geometry atomically. */
export function bundles(model: LayoutModel): LayoutModel {
  return withLayoutMutation(model, 'bundles', () => {});
}
export { prepareBundleGeometry } from './bundle-geometry.js';
export { rebuildBundlePaths, BundleFeasibilityError } from './bundle-paths.js';
