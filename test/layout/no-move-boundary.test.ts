import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutGroup, LayoutModel } from '../../src/model/layout.js';
import { holdsMove, holdsNodeMove, type MoveKind } from '../../src/layout/move-reservations.js';
import { riserPenetrations } from '../../src/layout/lanes.js';
import { NO_MOVE_EPS, RISER_DEPTH_EPS } from '../../src/layout/tolerance.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * One no-move tolerance for the move guards (decision review 2026-11, D-Q6; audit P-06-F7). Before, the riser kind and `holdsNodeMove`
 * judged a shift above 1e-9 as a move and the side-alignment kind only a shift above 1e-6, so a shift of 1e-8 had two verdicts in one
 * guard set. Now every kind reads `NO_MOVE_EPS`.
 */
const KINDS: readonly MoveKind[] = ['riserKeepOut', 'trunkExtension', 'laneSide', 'sideAlignment', 'spanCorridor', 'groupExit'];
const SHEET = 'goldens/synthetic/a-mesh-over-two-rows-joins-its-bars-with-one-riser.yaml';

/** A member-row group with a routed port on its facing edge, and the riser moved to stand 2 px from that port: the port is in the keep-out. */
function portInKeepOut(model: LayoutModel): LayoutGroup {
  const upper = model.meshBuses!.find(bus => bus.riser !== undefined && bus.cross !== undefined)!;
  for (const group of Object.values(model.groups)) for (const id of group.nodes) for (const port of model.nodes[id]!.ports) {
    if (port.anchor === undefined || riserPenetrations(model, group, upper.riser!.x - port.anchor.x).size === 0) continue;
    upper.riser!.x = port.anchor.x + 2;
    if (riserPenetrations(model, group).size > 0) return group;
  }
  throw new Error('no facing routed port in the fixture');
}

describe('one no-move tolerance for the move guards', () => {
  it('a shift of 1e-8 is no move for all six kinds; a shift of 1 px deeper is refused', async () => {
    const published = await layout(parse(readFileSync(SHEET, 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    // The published model is frozen; the probe moves the riser on a copy.
    const model = JSON.parse(JSON.stringify(published)) as LayoutModel;
    const group = portInKeepOut(model);
    const shifted = (dx: number) => [{ group, bounds: { ...group.bounds!, x: group.bounds!.x + dx } }];
    expect(1e-8).toBeLessThanOrEqual(NO_MOVE_EPS);
    expect(1e-8).toBeGreaterThan(RISER_DEPTH_EPS);
    // The setup bites: a real shift toward the riser takes the port deeper, and the riser kind refuses it.
    expect(holdsMove(model, shifted(1), false, ['riserKeepOut'])).toBe(false);
    expect(KINDS.map(kind => holdsMove(model, shifted(1e-8), false, [kind]))).toEqual(KINDS.map(() => true));
    expect(holdsNodeMove(model, group, group.nodes, 1e-8)).toBe(true);
  }, 120000);
});
