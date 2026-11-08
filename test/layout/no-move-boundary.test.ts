import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutGroup, LayoutModel, LayoutPort } from '../../src/model/layout.js';
import { holdsMove, holdsNodeMove, type MoveKind } from '../../src/layout/move-reservations.js';
import { riserKeepOutBreaches, riserPenetrations } from '../../src/layout/lanes.js';
import { NO_MOVE_EPS } from '../../src/layout/tolerance.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * One no-move tolerance for the move guards (decision review 2026-11, D-Q6; audit P-06-F7). Before, the riser kind and `holdsNodeMove`
 * judged a shift above 1e-9 as a move and the side-alignment kind only a shift above 1e-6, so a shift of 1e-8 had two verdicts in one
 * guard set. Now every kind reads `NO_MOVE_EPS`, and it is strict: a shift above it is judged by every kind.
 */
const KINDS: readonly MoveKind[] = ['riserKeepOut', 'trunkExtension', 'laneSide', 'sideAlignment', 'spanCorridor', 'groupExit'];
const SHEET = 'goldens/synthetic/a-mesh-over-two-rows-joins-its-bars-with-one-riser.yaml';

interface Probe { model: LayoutModel; group: LayoutGroup; port: LayoutPort; keep: number; setRiser: (x: number) => void }

/** A copy of the published model (it is frozen), with a member-row group, a routed port on its facing edge, and the keep-out distance. */
async function probe(): Promise<Probe> {
  const published = await layout(parse(readFileSync(SHEET, 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const model = JSON.parse(JSON.stringify(published)) as LayoutModel;
  const upper = model.meshBuses!.find(bus => bus.riser !== undefined && bus.cross !== undefined)!;
  const setRiser = (x: number): void => { upper.riser!.x = x; };
  for (const group of Object.values(model.groups)) for (const id of group.nodes) for (const port of model.nodes[id]!.ports) {
    if (port.anchor === undefined) continue;
    setRiser(port.anchor.x + 2);
    const depth = Math.max(0, ...riserPenetrations(model, group).values());
    if (depth > 0) return { model, group, port, keep: depth + 2, setRiser };
  }
  throw new Error('no facing routed port in the fixture');
}
const shifted = (group: LayoutGroup, dx: number) => [{ group, bounds: { ...group.bounds!, x: group.bounds!.x + dx } }];
const verdicts = (model: LayoutModel, group: LayoutGroup, dx: number): boolean[] => KINDS.map(kind => holdsMove(model, shifted(group, dx), false, [kind]));

describe('one no-move tolerance for the move guards', () => {
  it('every kind judges a shift of 1e-8 as a move, and holds a shift at or below NO_MOVE_EPS', async () => {
    const { model, group, port, setRiser } = await probe();
    // The port stands 2 px inside the keep-out, left of the riser: a shift right takes it deeper.
    setRiser(port.anchor!.x + 2);
    expect(1e-8).toBeGreaterThan(NO_MOVE_EPS);
    expect(verdicts(model, group, 1e-8)).toEqual(KINDS.map(kind => kind !== 'riserKeepOut'));
    expect(holdsNodeMove(model, group, group.nodes, 1e-8)).toBe(false);
    expect(verdicts(model, group, NO_MOVE_EPS / 2)).toEqual(KINDS.map(() => true));
    expect(holdsNodeMove(model, group, group.nodes, NO_MOVE_EPS / 2)).toBe(true);
  }, 120000);

  it('refuses a shift of 9e-7 that takes a port 5e-7 px outside the keep-out line into it (DR-12 review F1)', async () => {
    const { model, group, port, keep, setRiser } = await probe();
    setRiser(port.anchor!.x + keep + 5e-7);
    expect(riserKeepOutBreaches(model)).toEqual([]);
    expect(riserPenetrations(model, group, 9e-7).size).toBe(1);
    expect(holdsMove(model, shifted(group, 9e-7), false, ['riserKeepOut'])).toBe(false);
    expect(holdsNodeMove(model, group, group.nodes, 9e-7)).toBe(false);
  }, 120000);
});
