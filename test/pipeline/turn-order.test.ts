import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, restoreLayoutModel, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 24, phase 2: the stage-5 key of a turn-ordered run (`testTurnOrder`) and G5 on the faces it placed. The hand solve 09 has one self
 * crossing today: the two column-gap skirts of Mgmt 1 leave one bottom face in far-end order, and the nearer lane crosses the stem of the farther one.
 */
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const solve09 = (): string => readFileSync(new URL('../../ref/hand-solves/09-flank-link-around-a-neighbour.yaml', import.meta.url), 'utf8');
const counts = (model: LayoutModel) => score(model).snapshot.counts.routed;

describe('the turn order of a forced run (hand solve 09)', () => {
  it('is off by default: no frozen faces and the far-end order', async () => {
    const model = await layout(parse(solve09()), options);
    expect(model.freeze?.turnOrder).toBeUndefined();
    expect(model.turnOrder).toBeUndefined();
  });

  it('removes the self crossing of the two skirts and adds no turn', async () => {
    const plain = await layout(parse(solve09()), options);
    const forced = await layout(parse(solve09()), { ...options, testTurnOrder: true });
    expect(forced.freeze?.turnOrder).toEqual([{ node: 'mg-1', side: 'bottom' }]);
    expect(counts(plain).crossings).toBe(1);
    expect(counts(forced).crossings).toBe(0);
    expect(counts(forced).turns).toBeLessThanOrEqual(counts(plain).turns);
    expect(Object.values(score(forced).snapshot.gates).every(gate => gate.passed)).toBe(true);
    expect(forced.diagnostics.map(item => item.code)).not.toContain('PORT_TURN_MISSED');
  });

  it('restores from JSON with its frozen faces', async () => {
    const forced = await layout(parse(solve09()), { ...options, testTurnOrder: true });
    const restored = restoreLayoutModel(JSON.stringify(forced));
    expect(restored.freeze?.turnOrder).toEqual(forced.freeze?.turnOrder);
    expect(() => restoreLayoutModel(JSON.stringify({ ...forced, turnOrder: undefined }))).toThrow(/turn order/);
  });
});
