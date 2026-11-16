import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createEnv } from '../../src/pipeline/env.js';
import { firstState } from '../../src/pipeline/initial.js';
import { restoreLayoutModel } from '../../src/internal.js';
import { declineStagger, RESERVATION_CHECKS, reserve } from '../../src/layout/reservations.js';
import { holds } from '../../src/layout/reservation-checks.js';
import { createAttempt } from '../layout/phase-two-fixture.js';

/**
 * Dense-16x9 ticket 22, review 4: every reservation kind is listed once with its per-entry predicate (`RESERVATION_CHECKS`), and the round check,
 * the restore of a frozen model and the restore of a model before the freeze each read that list. A kind left out does not compile (a mapped type);
 * the list below fails too, so a new kind is named in this test with its readers.
 */
const KINDS = ['bundleNeighbours', 'corridorSide', 'course', 'farEndOrder', 'groupExit', 'groupOrder', 'labelRoom', 'laneOwner', 'laneSide', 'nodeFloor',
  'pairFloor', 'pitchFloor', 'riserKeepOut', 'rowOrder', 'sideAlignment', 'sideFace', 'spanChord', 'spanCorridor', 'staggerDeclined', 'trunkDeclined',
  'trunkExtension', 'turnOrder'];
const yaml = readFileSync(new URL('../../goldens/synthetic/a-top-row-staggers-when-a-lower-tier-sets-the-stage-5-width.yaml', import.meta.url), 'utf8');

describe('one check table for every reservation kind (dense-16x9 ticket 22, review 4)', () => {
  it('lists every kind once, and each reader either calls the kind\'s predicate or says how it reads the kind instead', () => {
    expect(Object.keys(RESERVATION_CHECKS).sort()).toEqual(KINDS);
    for (const [kind, check] of Object.entries(RESERVATION_CHECKS)) {
      for (const [reader, at] of Object.entries(check.at)) {
        if (typeof at === 'string') expect(at.length, `${kind} ${reader}`).toBeGreaterThan(0);
        else expect(check.predicate, `${kind} ${reader} calls a predicate`).toBeTypeOf('function');
      }
    }
    // A declined stagger is checked by all three readers.
    expect(RESERVATION_CHECKS.staggerDeclined.at).toEqual({ round: true, final: true, early: true });
  });

  it('refuses at an early restore a declined stagger that the carried stagger contradicts', async () => {
    const env = createEnv(parse(yaml), { createElkAttempt: createAttempt }), s = await firstState(env), step = env.step;
    let early: LayoutModel | undefined;
    env.step = ((stage, run) => {
      const result = step(stage, run);
      if (stage === 'size') early = structuredClone(result) as LayoutModel;
      return result;
    }) as typeof env.step;
    await env.place(s.kept);
    expect(early!.stage).toBe('size');
    expect(early!.staggerRows?.map(row => row.group)).toContain('leaves');
    expect(() => restoreLayoutModel(JSON.stringify(early))).not.toThrow();
    const forged = { ...early!, reservations: reserve(early!.reservations ?? [], declineStagger('leaves', 'test refusal', 'fan', 1)) };
    expect(holds(forged.reservations, forged).map(failure => failure.kind)).toContain('staggerDeclined');
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow('does not hold: the row leaves stands on two lines although its stagger is declined');
  }, 60000);
});
