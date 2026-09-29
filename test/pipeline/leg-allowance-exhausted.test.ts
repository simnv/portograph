import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, restoreFinalLayout } from '../../src/index.js';
import { validateGroupLabelBands } from '../../src/layout/bands.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 66, review 2. A title has one extra growth pass outside the shared budget (`LEG_PASSES_PER_TITLE`). No fixture of the corpus runs
 * past it, so the state is forged: after the extra pass's replay (the call that carries its throwaway budget of one pass) node `m0` is shifted
 * back under the title, its skewed legs stand under the title again, the title asks to widen a second time and the allowance is spent.
 */
const forge = vi.hoisted(() => ({ done: false }));
vi.mock('../../src/layout/region-rebuild.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/region-rebuild.js')>();
  return { ...original, rebuildRegionGeometry: (...args: Parameters<typeof original.rebuildRegionGeometry>): void => {
    const [model, budget] = args, extra = budget?.remaining === 1 && budget.passes === 0;
    original.rebuildRegionGeometry(...args);
    if (forge.done || !extra) return;
    forge.done = true;
    const node = model.nodes.m0!;
    for (const port of node.ports) if (port.anchor) port.anchor.x += 40;
    node.bounds!.x += 40;
    rebuildNodeGeometry(model, ['m0'], 'current');
  } };
});

const run = (): Promise<LayoutModel> => layout(parse(readFileSync(new URL('../../goldens/synthetic/a-one-node-title-over-a-skewed-leg-widens-the-group.yaml', import.meta.url), 'utf8')),
  { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a title past its allowance keeps the soft rule and says so (ticket 66)', () => {
  beforeEach(() => { forge.done = false; });

  it('names the exhausted allowance, leaves the legs to the router, and the model validates and restores', async () => {
    const model = await run();
    expect(forge.done).toBe(true);
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
});
