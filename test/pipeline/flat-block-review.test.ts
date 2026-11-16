import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
import { TrunkBlocked } from '../../src/layout/placement-refusal.js';

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
