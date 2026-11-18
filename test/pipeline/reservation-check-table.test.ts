import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createEnv } from '../../src/pipeline/env.js';
import { firstState } from '../../src/pipeline/initial.js';
import { restoreLayoutModel } from '../../src/internal.js';
import { declineStagger, RESERVATION_CHECKS, reserve, type Reservation } from '../../src/layout/reservations.js';
import { holds } from '../../src/layout/reservation-checks.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withTheOldDefault } from '../layout/move-before-grow.js';

/**
 * Dense-16x9 ticket 22, review 4: every reservation kind is listed once with its per-entry predicate (`RESERVATION_CHECKS`), and the round check,
 * the restore of a frozen model and the restore of a model before the freeze each read that list. A kind left out does not compile (a mapped type);
 * the list below fails too, so a new kind is named in this test with its readers.
 */
const KINDS = ['bundleNeighbours', 'corridorSide', 'course', 'farEndDecision', 'farEndOrder', 'groupExit', 'groupOrder', 'labelRoom', 'laneOwner', 'laneSide', 'nodeFloor',
  'pairFloor', 'pitchFloor', 'refusedChord', 'riserKeepOut', 'rowOrder', 'seatSet', 'seatSetDeclined', 'sideAlignment', 'sideFace', 'spanChord', 'spanCorridor', 'staggerDeclined', 'trunkDeclined',
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
    // So is a chord the publication step refused (dense-16x9 ticket 04 slice 2, review 2).
    expect(RESERVATION_CHECKS.refusedChord.at).toEqual({ round: true, final: true, early: true });
  });

  it('refuses at an early restore a declined stagger that the carried stagger contradicts', async () => {
    const env = createEnv(withTheOldDefault(parse(yaml)), { createElkAttempt: createAttempt }), s = await firstState(env), step = env.step;
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
    const forged = { ...early!, reservations: reserve(early!.reservations ?? [], declineStagger('leaves', 'test refusal', 'later-placement', 'fan', 1)) };
    expect(holds(forged.reservations, forged).map(failure => failure.kind)).toContain('staggerDeclined');
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow('does not hold: the row leaves stands on two lines although its stagger is declined');
  }, 60000);

  // Review 1 of dense-16x9 ticket 35: the decline names its evidence, and restore checks it. A held-straight decline names at least one link, and
  // only it names links; every link it names is a link of the model. Each forgery is refused at an early restore and at a final one, and the
  // round check names the unknown link.
  it('refuses at both restores a decline that names no link, an unknown link, or links on another clause', async () => {
    const env = createEnv(withTheOldDefault(parse(yaml)), { createElkAttempt: createAttempt }), s = await firstState(env), step = env.step;
    let early: LayoutModel | undefined;
    env.step = ((stage, run) => {
      const result = step(stage, run);
      if (stage === 'size') early = structuredClone(result) as LayoutModel;
      return result;
    }) as typeof env.step;
    await env.place(s.kept);
    const final = await layout(withTheOldDefault(parse(yaml)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    for (const model of [early!, final]) {
      const row = Object.keys(model.groups).find(id => !(model.staggerRows ?? []).some(item => item.group === id) && model.groupArrangements?.[id]?.chosen !== 'stagger')!;
      const link = model.links[0]!.id;
      const [good] = declineStagger(row, 'a test decline', 'held-straight', 'initial', 1, [link]);
      const entry = (payload: Record<string, unknown>): Reservation => ({ ...good!, payload: { group: row, reason: 'a test decline', ...payload } }) as unknown as Reservation;
      const forged = (item: Reservation): string => JSON.stringify({ ...model, reservations: reserve(model.reservations ?? [], [item]) });
      expect(() => restoreLayoutModel(forged(good!)), model.stage).not.toThrow();
      expect(() => restoreLayoutModel(forged(entry({ clause: 'held-straight' }))), model.stage).toThrow('Reservation is malformed');
      expect(() => restoreLayoutModel(forged(entry({ clause: 'area', links: [link] }))), model.stage).toThrow('Reservation is malformed');
      const unknown = entry({ clause: 'held-straight', links: ['not-a-link'] });
      expect(() => restoreLayoutModel(forged(unknown)), model.stage).toThrow(`the decline of ${row} names the link not-a-link, which the model does not have`);
      expect(holds([unknown], model).map(failure => failure.kind)).toEqual(['staggerDeclined']);
    }
  }, 120000);
});
