/**
 * The rebuild of the rule-owned geometry with no centring (`rebuildRegionGeometry(model, ..., false)`), for the close-up and its replay
 * (architecture-2 ticket 69). `region-rebuild.ts` registers it when it loads. A hook and not an import: `end-trim.ts` is read by `centre.ts`, and
 * an import of `region-rebuild.ts` from there would close the cycle centre -> end-trim -> region-rebuild -> centre, which evaluates the rebuild
 * module before `centre.ts` (a module mock of `centre.ts` in a test then binds the original).
 */
import type { LayoutModel } from '../model/index.js';

const hook: { rebuild?: (model: LayoutModel) => void } = {};

/** Registers the rebuild; called once by `region-rebuild.ts`. */
export function registerRuleGeometryRebuild(rebuild: (model: LayoutModel) => void): void { hook.rebuild = rebuild; }

/** Derives the rule-owned geometry again with no centring. Throws when no rebuild is registered (R6: never a silent skip). */
export function rebuildRuleGeometry(model: LayoutModel): void {
  if (hook.rebuild === undefined) throw new Error('No rule geometry rebuild is registered (region-rebuild.ts is not loaded)');
  hook.rebuild(model);
}
