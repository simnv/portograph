import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, restoreFinalLayout } from '../../src/index.js';
import { produceGroupLabelBands, validateGroupLabelBands } from '../../src/layout/bands.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
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
    // Ticket 75: centring ends at a fixed point and no longer burns the shared budget, so the growth the allowance guards is
    // paid for by the shared budget first. The premise of this file (a spent budget) is forged: the first replay spends it.
    const first = forge.shared === undefined && budget !== undefined;
    forge.shared ??= budget;
    const extra = budget !== undefined && budget !== forge.shared && budget.passes === 0;
    if (extra) forge.replays++;
    if (extra && !forge.entry) forge.entry = { remaining: budget.remaining, passes: budget.passes };
    original.rebuildRegionGeometry(...args);
    if (first) { budget!.remaining = 0; budget!.passes = 8; }
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

  it('an exhausted title does not widen a gap-mate for legs its plan no longer avoids (ticket 71)', async () => {
    const model = await run('two-titles-over-skewed-legs-each-widen-their-group');
    expect(forge.done).toBe(true);
    expect(model.diagnostics.filter(item => item.code === 'GROUP_LABEL_LEG_ALLOWANCE_EXHAUSTED').map(item => item.owners)).toEqual([[{ kind: 'group', id: 'mid' }]]);
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE' && (item.owners ?? []).some(owner => 'id' in owner && owner.id.startsWith('mid')))).toEqual([]);
    // `mid` spent its one pass (two replays). Its failed row puts the whole gap on the soft rule, so the growth `mid2` asks for is moot: no pass, no width.
    expect(forge.replays).toBe(2);
    expect(model.groups.mid2!.bounds!.width).toBeCloseTo(315.171875, 3);
    expect(model.canvas!.width).toBeCloseTo(1159.513673875, 3);
    expect(() => validateGroupLabelBands(structuredClone(model))).not.toThrow();
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 120000);

  it('a second producer call owns its diagnostics: no duplicate, no stale entry (ticket 71)', async () => {
    const model = await run();
    const count = (m: LayoutModel): number => m.diagnostics.filter(item => item.code === 'GROUP_LABEL_LEG_ALLOWANCE_EXHAUSTED').length;
    expect(count(model)).toBe(1);
    // Exhausts again (the forge is spent, so the title stands over its legs as the run left it or widens): never more than one entry, and the model validates.
    const again = structuredClone(model);
    produceGroupLabelBands(again);
    expect(count(again)).toBeLessThanOrEqual(1);
    expect(() => validateGroupLabelBands(structuredClone(again))).not.toThrow();
    // A stale entry the call does not reproduce is dropped.
    const stale = structuredClone(model);
    stale.diagnostics.push({ ...model.diagnostics.find(item => item.code === 'GROUP_LABEL_LEG_ALLOWANCE_EXHAUSTED')!, owners: [{ kind: 'group', id: 'top' }] });
    produceGroupLabelBands(stale);
    expect(stale.diagnostics.some(item => item.code === 'GROUP_LABEL_LEG_ALLOWANCE_EXHAUSTED' && item.owners?.some(owner => 'id' in owner && owner.id === 'top'))).toBe(false);
  }, 120000);
});
