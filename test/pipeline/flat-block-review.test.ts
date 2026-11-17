import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { flatMemberRefusal } from '../../src/layout/block-checks.js';
import { chordSegment } from '../../src/layout/frame-paths.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import type { LayoutLink, LayoutModel } from '../../src/model/layout.js';
import type { Env } from '../../src/pipeline/env.js';
import { firstState } from '../../src/pipeline/initial.js';
import { place } from '../../src/pipeline/place.js';
import { FAN_ROUNDS, MAX_RERUNS } from '../../src/pipeline/limits.js';
import { PlacementRefusal, SolidBlockRefusal, TrunkBlocked } from '../../src/layout/placement-refusal.js';

// A stub model of the stubbed trials below is no layout model: the copy that carries the stagger gate's declines (dense-16x9 ticket 35) is read
// back as plain JSON, frozen as a restore freezes it. A real model restores as before.
vi.mock('../../src/layout/mutation.js', async original => {
  const real = await original<typeof import('../../src/layout/mutation.js')>();
  return { ...real, restoreLayoutModel: (json: string) => {
    const model = JSON.parse(json) as LayoutModel;
    return model.runtime === undefined ? Object.freeze(model) : real.restoreLayoutModel(json);
  } };
});

// Dense-16x9 ticket 04 slice 3, review 1: the floor reads the drawn chord (finding 1), and the flat-gap trial stands outside the cap (finding 2).
const named = readFileSync(new URL('../../goldens/synthetic/a-flat-block-of-named-ports-keeps-the-floor-on-the-drawn-chord.yaml', import.meta.url), 'utf8');
const degrees = (from: { x: number; y: number }, to: { x: number; y: number }): number => Math.atan2(Math.abs(to.y - from.y), Math.abs(to.x - from.x)) * 180 / Math.PI;

describe('a flat block of named ports (review 1, finding 1)', () => {
  it('holds every straight member at 15 degrees or steeper on the drawn chord, and restores', async () => {
    const model = await layout(parse(named), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.blockReservations?.[0]?.mode).toBe('flat');
    const held = model.links.filter(link => link.solidBlock && model.frozenChords?.includes(link.id));
    expect(held.length).toBeGreaterThan(0);
    for (const link of held) {
      const segment = link.path!.segments[0]!;
      expect(degrees(segment.from, segment.to), link.id).toBeGreaterThanOrEqual(15 - 1e-6);
      expect(flatMemberRefusal(model, link), link.id).toBeUndefined();
    }
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 120000);

  it('refuses a member whose drawn chord stands below 15 degrees though its anchors do not', () => {
    // Anchors (180, 60) and (1020, 285.1) stand at 15.0 degrees; the 27 px pills put the drawn chord at (180, 73.5) to (1020, 271.6), 13.3 degrees.
    const port = (node: string, side: string, x: number, y: number) => ({ ref: { node, name: 'p' }, side, anchor: { x, y }, pill: { bounds: { x: x - 5.5, y: y - 13.5, width: 11, height: 27 } } });
    const model = { document: { nodes: { hub: { group: 'up' }, far: { group: 'down' } }, groups: { up: {}, down: {} } },
      groups: { up: { nodes: ['hub'], bounds: { x: 0, y: 0, width: 200, height: 100 } }, down: { nodes: ['far'], bounds: { x: 1000, y: 245, width: 200, height: 100 } } },
      nodes: { hub: { bounds: { x: 160, y: 20, width: 40, height: 40 }, ports: [port('hub', 'bottom', 180, 60)] }, far: { bounds: { x: 1000, y: 285.1, width: 40, height: 40 }, ports: [port('far', 'top', 1020, 285.1)] } },
      blockReservations: [{ family: 'b', mode: 'flat' }] } as unknown as LayoutModel;
    const link = { id: 'l', owner: { kind: 'link', id: 'l' }, solidBlock: true, fanFamily: 'b', attachments: { from: { node: 'hub', name: 'p' }, to: { node: 'far', name: 'p' } } } as LayoutLink;
    const chord = chordSegment(model, link)!;
    expect(degrees(chord.from, chord.to)).toBeLessThan(15);
    expect(flatMemberRefusal(model, link)).toBe('floor');
  });
});

describe('the flat-gap trial and the placement cap (review 1, finding 2)', () => {
  it('starts the trial outside the cap after the initial trunk retries spent the allowance', async () => {
    // Three placements each refuse a trunk; the fourth stands with a flat block at its floor, and the sheet asks for height: the trial is offered
    // with placements = 4 = the cap. It is credited before `place` checks the cap.
    const floor = { document: { layout: { aspect: 2 } }, nodes: { x: { bounds: { x: 0, y: 0, width: 2000, height: 500 } } }, groups: {},
      blockReservations: [{ family: 'a', mode: 'flat', below: 1, chosen: 100, target: 800 }] };
    let calls = 0;
    const env = { document: floor.document, options: {}, maxReruns: MAX_RERUNS, placeCap: Math.max(MAX_RERUNS, FAN_ROUNDS) + 1, placements: 0, reruns: 0,
      blockProbes: 0, gateRuns: 0, farEndRuns: 0, timed: async (_: string, run: () => unknown) => run(),
      place: async (kept: unknown) => {
        calls++;
        if (calls <= MAX_RERUNS) { env.placements++; throw new TrunkBlocked(`trunk-${calls}`, 'blocked at placement'); }
        if (calls === MAX_RERUNS + 1) { env.placements++; return floor; }
        // The production cap check, before any geometry.
        return place(env, kept as never);
      }, bands: async (model: unknown) => ({ model, moved: false }) } as unknown as Env;
    let error: unknown;
    try { await firstState(env); } catch (caught) { error = caught; }
    // The trial ran past the cap check (its geometry is no real model, so it may refuse later; never on the budget).
    expect(String(error ?? '')).not.toMatch(/most it may/);
    expect(env.gateRuns).toBeGreaterThanOrEqual(1);
    expect(env.exemptPlacing ?? 0).toBe(0);
  });
});

describe('a placement started inside an exempt trial is credited once (review 2)', () => {
  // The production `place` and retry loop; the step throws the injected refusal, and a geometry the probe returns stands for the placed model.
  const reached = Symbol('reached geometry');
  const charge = (env: Env): number => env.placements - env.blockProbes - env.gateRuns - env.farEndRuns;
  const stub = (first: object, later: object, refuseAt: number, extra: object = {}): Env => {
    let calls = 0;
    const env = { document: { layout: { aspect: 2 } }, options: {}, maxReruns: 3, placeCap: 4, placements: 0, reruns: 0, blockProbes: 0, gateRuns: 0,
      farEndRuns: 0, timed: async (_: string, run: () => unknown) => run(), ...extra,
      step: () => { if (calls === refuseAt) throw new SolidBlockRefusal(new Map([['b', 'refused in the trial']])); throw reached; },
      place: async (kept: unknown) => {
        calls++;
        if (calls === 1) { env.placements++; return first; }
        try { return await place(env, kept as never); } catch (error) { if (error === reached) return later; throw error; }
      } } as unknown as Env & { bands: unknown };
    return env;
  };

  it('keeps the flat-gap trial whose block retry stood, and the floor placement stays the one ordinary charge', async () => {
    // The reviewer's state: two flat records share a gap; the trial refuses block b, its retry stands without b at 2000 x 1000, nearer aim 2.
    const records = [{ family: 'a', mode: 'flat', below: 1, chosen: 100, target: 800 }, { family: 'b', mode: 'flat', below: 1, chosen: 100, target: 700 }];
    const floor = { document: { layout: { aspect: 2 } }, nodes: { x: { bounds: { x: 0, y: 0, width: 2000, height: 500 } } }, groups: {}, blockReservations: records };
    const chosen = { ...floor, nodes: { x: { bounds: { x: 0, y: 0, width: 2000, height: 1000 } } }, blockReservations: [records[0]] };
    const env = stub(floor, chosen, 2, { bands: async (model: unknown) => ({ model, moved: false }) });
    await firstState(env);
    expect(env.declinedSolidBlocks?.has('b')).toBe(true);
    expect(env.placements).toBe(3);
    expect(env.gateRuns).toBe(2);
    expect(env.exemptPlacing ?? 0).toBe(0);
    expect(charge(env)).toBe(1);
  });

  it('keeps the stagger gate\'s plain trial whose block retry stood, and the first placement stays the one ordinary charge', async () => {
    // The first run chose a stagger for g; its lines are refused at 7f, so the gate keeps the plain trial, whose first placement refused block b.
    const first = { document: { layout: { aspect: 2 } }, nodes: {}, groups: {}, staggerRows: [{ group: 'g' }], groupArrangements: { g: { chosen: 'stagger' } } };
    const plain = { document: { layout: { aspect: 2 } }, nodes: {}, groups: {} };
    const env = stub(first, plain, 2, { arrangedRows: ['g'],
      bands: async (model: unknown) => { if (model === first) throw new PlacementRefusal('stagger', 'the lines of g are refused at 7f'); return { model, moved: false }; } });
    const state = await firstState(env);
    // The kept plain trial, with the gate's decline of g in its ledger.
    expect(state.base).toMatchObject(plain);
    expect(state.base.reservations?.map(entry => [entry.kind, entry.owner])).toEqual([['staggerDeclined', { kind: 'group', id: 'g' }]]);
    expect(env.declinedSolidBlocks?.has('b')).toBe(true);
    expect(env.placements).toBe(3);
    expect(env.gateRuns).toBe(2);
    expect(env.exemptPlacing ?? 0).toBe(0);
    expect(charge(env)).toBe(1);
  });
});
