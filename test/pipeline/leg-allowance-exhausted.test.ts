import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, restoreFinalLayout } from '../../src/index.js';
import { validateGroupLabelBands } from '../../src/layout/bands.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 66, review 2. A title has one extra growth pass outside the shared budget (`LEG_PASSES_PER_TITLE`). No fixture of the corpus runs
 * past it, so the state is forged: after the extra pass's replay (the first call that carries a budget of its own) node `m0` is shifted
 * back under the title, its skewed legs stand under the title again, the title asks to widen a second time and the allowance is spent.
 */
const forge = vi.hoisted(() => ({ done: false, shared: undefined as object | undefined, replays: 0, entry: undefined as { remaining: number; passes: number } | undefined }));
vi.mock('../../src/layout/region-rebuild.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/region-rebuild.js')>();
  return { ...original, rebuildRegionGeometry: (...args: Parameters<typeof original.rebuildRegionGeometry>): void => {
    const [model, budget] = args;
    // The shared budget is the first one the loop replays with; the extra pass replays with a fresh one of its own.
    forge.shared ??= budget;
    const extra = budget !== undefined && budget !== forge.shared && budget.passes === 0;
    if (extra) forge.replays++;
    if (extra && !forge.entry) forge.entry = { remaining: budget.remaining, passes: budget.passes };
    original.rebuildRegionGeometry(...args);
    if (forge.done || !extra) return;
    forge.done = true;
    const node = model.nodes.m0!;
    for (const port of node.ports) if (port.anchor) port.anchor.x += 40;
    node.bounds!.x += 40;
    rebuildNodeGeometry(model, ['m0'], 'current');
  } };
});

const run = (name = 'a-one-node-title-over-a-skewed-leg-widens-the-group'): Promise<LayoutModel> => layout(parse(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')),
  { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a title past its allowance keeps the soft rule and says so (ticket 66)', () => {
  beforeEach(() => { forge.done = false; forge.shared = undefined; forge.entry = undefined; forge.replays = 0; });

  it('names the exhausted allowance, leaves the legs to the router, and the model validates and restores', async () => {
    const model = await run();
    expect(forge.done).toBe(true);
    // Ticket 71: the extra pass replays with a real budget, so centring cannot report the throwaway one as a stall.
    expect(forge.entry).toEqual({ remaining: 8, passes: 0 });
    const exhausted = model.diagnostics.filter(item => item.code === 'GROUP_LABEL_LEG_ALLOWANCE_EXHAUSTED');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.owners).toEqual([{ kind: 'group', id: 'mid' }]);
    // The shared-budget warning is not the one raised for this leg.
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE' && (item.owners ?? []).some(owner => 'id' in owner && owner.id === 'mid'))).toEqual([]);
    // The soft rule: the title stands over a leg, and the row plan leaves both legs to the router.
    const title = model.labels.find(label => label.id === 'label:group:mid')!.bounds!;
    const legs = model.nodes.m0!.ports.filter(port => port.side === 'top' && port.anchor).map(port => port.anchor!.x);
    expect(legs.some(x => x >= title.x && x <= title.x + title.width)).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'TIER_GAP_PART_RESIDUAL' && /a leg would pass through a label/.test(item.message))).toHaveLength(2);
    // The fallback of `validateGroupLabelBands` accepts the stalled titles, and a serialised model restores.
    expect(() => validateGroupLabelBands(structuredClone(model))).not.toThrow();
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 120000);

  it('an exhausted title does not stop the next one (ticket 71)', async () => {
    const model = await run('two-titles-over-skewed-legs-each-widen-their-group');
    expect(forge.done).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'GROUP_LABEL_LEG_ALLOWANCE_EXHAUSTED').map(item => item.owners)).toEqual([[{ kind: 'group', id: 'mid' }]]);
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE' && (item.owners ?? []).some(owner => 'id' in owner && owner.id.startsWith('mid')))).toEqual([]);
    // Each extra pass is two replays: `mid` spent one pass (the forge sent it back under the title) and `mid2` took one of its own.
    expect(forge.replays).toBe(4);
    // `mid` keeps the soft rule; `mid2` still gets its own pass and widens.
    const wide = model.groups.mid2!.bounds!, node = model.nodes.n0!.bounds!;
    expect(wide.width).toBeGreaterThan(node.width + 2 * GROUP_LABEL_LINK_CLEARANCE);
    // Both titles face one tier gap, and the gap's titles are nudged together or not at all, so the title of `mid2` keeps its place over the legs.
    expect(() => validateGroupLabelBands(structuredClone(model))).not.toThrow();
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 120000);
});
