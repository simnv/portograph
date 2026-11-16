import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse as parseDocument, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { laneRunKind } from '../../src/layout/lane-kind.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from './joint-off.js';
import { withMoveBeforeGrow } from './move-before-grow.js';

// The seat (ADR-0027) is an opt-in until ticket 15: every sheet of this file is read with `layout.moveBeforeGrow: true`.
const parse = (text: string): ReturnType<typeof parseDocument> => parseDocument(withMoveBeforeGrow(text));

/**
 * The acceptance set of the seat (ADR-0027 and its addendum: a step is judged where it ends). These tests came from architecture-2 ticket 71
 * (`given-back.test.ts`, its record removed with dense-16x9 ticket 02, note 4) and keep their old pins, which are main's numbers or better. A test
 * the branch does not meet stands as expected-fail (`it.fails`) with one line: the old value, the value now, and the ticket that owns it (ticket 15,
 * the joint alignment plan of a group; ticket 09, the step window). An expected-fail that starts to pass fails: then the pin is met again and the
 * mark goes.
 */
const source = (name: string): string => withoutJointOrder(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
const runText = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const run = (name: string): Promise<LayoutModel> => runText(source(name));
const spent = (model: LayoutModel): boolean => model.diagnostics.some(item => item.code === 'PLACEMENT_NON_CONVERGENCE');
const bends = (model: LayoutModel): number => { const counts = score(model).snapshot.counts; return (counts.routed?.turns ?? 0) + (counts.overlay?.turns ?? 0); };
const failing = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed && gate.severity === 'error').map(([id]) => id).sort();

describe('a growth no target uses does not stay (a-stranded-growth-is-given-back)', () => {
  it('srv0 stands at its own width', async () => {
    const model = await run('a-stranded-growth-is-given-back');
    expect(model.nodes['srv0']!.bounds!.width).toBeLessThan(70);
  }, 120000);
  it('keeps the bends of main (6), narrows the canvas (668 px on main) and settles', async () => {
    const model = await run('a-stranded-growth-is-given-back');
    expect(bends(model)).toBe(6);
    expect(model.canvas!.width).toBeLessThan(500);
    expect(spent(model)).toBe(false);
  }, 120000);
});

describe('the user\'s tier-gap sheet', () => {
  // Expected to fail: 8 bends, settled on main; now 16 bends with G5 and a spent budget, `isp1` 397 px across the feeds of `isp0` (ticket 15).
  it.fails('srv0 is at most 70 px and the sheet has at most 8 bends (12 on main)', async () => {
    // DR-04: the copy that declares `access` before `src`, so the canonical link order lays the user's shape out again.
    const model = await run('a-tier-gap-plan-orders-every-part-middle-tier-first');
    expect(model.nodes['srv0']!.bounds!.width).toBeLessThanOrEqual(70);
    expect(bends(model)).toBeLessThanOrEqual(8);
  }, 120000);
});

// The three regression classes of the per-step prototype (verdict sideface-fable, section 2): each sheet as main or better.
describe('the three regression classes of a per-step decline', () => {
  // Expected to fail: 2 transit lanes and 8 bends before, now 1 transit lane and 7 bends with G5; the step that grows `snk1` is declined (ticket 15).
  it.fails('transit corridor: a-face keeps both transit lanes (bends 8, crossings 7)', async () => {
    // DR-04: the copy with `access` first. Under the alignment cap (ADR-0027) a 56 px `snk1` cannot hold its three feeds, and its link from src1 takes a
    // perimeter lane, so the transit corridor of the premise is gone. A longer label makes `snk1` need 258 px: the corridor stands again.
    const plain = source('a-face-aligns-one-port-and-leaves-a-chord-port-in-place-middle-tier-first');
    const text = plain.replace('snk1: { group: edge-far, class: server, ports: [] }', 'snk1: { group: edge-far, class: server, label: "snk1 server of the far edge group", ports: [] }');
    expect(text).not.toBe(plain);
    const model = await runText(text);
    expect(model.lanes.filter(lane => lane.owner.kind === 'link' && laneRunKind(lane) === 'transit')).toHaveLength(2); // both links keep a transit lane, none a perimeter one
    expect(bends(model)).toBe(8);
    expect(score(model).snapshot.metrics.crossings.count).toBe(7);
  }, 120000);

  // Expected to fail: bends 5 with G5 alone before, now 12 with G5 (ticket 09: the step window of this copy).
  it.fails('sibling cascade: a-group-shift keeps bends 5 and G5 alone', async () => {
    const model = await run('a-group-shift-leaves-a-chord-clear-of-a-lane-middle-tier-first'); // DR-04: the copy with `access` first
    expect(bends(model)).toBe(5);
    expect(failing(model)).toEqual(['G5']);
  }, 120000);

  // Expected to fail: bends 8 and crossings 14 before, now 11 and 13 with G5 (ticket 15).
  it.fails('transit corridor: a-shared-end keeps bends 8 and crossings 14', async () => {
    const model = await run('a-shared-end-reads-its-port-order');
    expect(bends(model)).toBe(8);
    expect(score(model).snapshot.metrics.crossings.count).toBe(14);
  }, 120000);

  // Under the alignment cap (ADR-0027) `w1` of `widened-child-packs-tier` stays 52 px wide: its two parents stand more than five times its need
  // apart. The premise, a child that the passes widen, is rebuilt with a label that makes the body need more: `w1` then stood 272 px wide over
  // both parents, with the 2 bends the test pinned.
  // Expected to fail: 2 bends before, now 5; `w1` stays 139 px, the step that grows it is declined (ticket 15).
  it.fails('pass order: widened-child-packs-tier keeps the growth a later pass completes (bends 2)', async () => {
    const widenedChild = source('widened-child-packs-tier').replace('label: "w1"', 'label: "w1 route reflector wide"');
    expect(widenedChild).not.toBe(source('widened-child-packs-tier'));
    expect(bends(await runText(widenedChild))).toBe(2);
  }, 120000);

  // 6 bends before, 7 after ticket 15, 6 again since dense-16x9 ticket 04 (slice 2).
  it('pass order: a-hub-tiers-fan-draws-straight-and-crosses-itself keeps the growth a later pass completes (bends 6)', async () => {
    expect(bends(await run('a-hub-tiers-fan-draws-straight-and-crosses-itself'))).toBe(6);
  }, 120000);
});
