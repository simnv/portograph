import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// Switches for the last two tests: 7f refuses every model that holds a stagger (`on`), or only one that also holds the fan round's pair floors
// (`fan`), as a publication check would.
const refuse = vi.hoisted(() => ({ on: false, fan: false }));
vi.mock('../../src/layout/bands.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/bands.js')>();
  const { PlacementRefusal } = await import('../../src/layout/placement-refusal.js');
  return {
    ...actual,
    bands: (...args: Parameters<typeof actual.bands>) => {
      const fanned = (args[0].reservations ?? []).some(entry => entry.kind === 'pairFloor');
      if ((refuse.on || (refuse.fan && fanned)) && args[0].staggerRows?.length) throw new PlacementRefusal('stagger', 'Stagger chord corridor of link link-1 enters leaf-2', { owners: [{ kind: 'group', id: 'leaves' }] });
      return actual.bands(...args);
    },
  };
});

import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { FAN_WRAP_DECLINED, wrapGateVerdict } from '../../src/layout/stagger.js';
import { aspectGap } from '../../src/layout/aspect.js';
import { plannedBends } from '../../src/layout/side-measure.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withLayoutEntry } from '../aspect-fixture.js';
import { restoreFinalLayout } from '../../src/internal.js';
import { declineStagger } from '../../src/layout/reservations.js';
import { holds } from '../../src/layout/reservation-checks.js';

// Dense-16x9 ticket 22: the acceptance gate judges each stagger on the complete placement, aspect aim first; the stage-5 canvas judges nothing.
const yaml = readFileSync(new URL('../../goldens/synthetic/a-top-row-staggers-when-a-lower-tier-sets-the-stage-5-width.yaml', import.meta.url), 'utf8');
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const AIM = 16 / 9;
const gap = (model: LayoutModel): number => aspectGap(model.canvas!.width, model.canvas!.height, AIM);
const failed = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);

describe('a top row staggers when a lower tier sets the stage-5 width (dense-16x9 ticket 22)', () => {
  it('keeps the two lines: the complete placement stands nearer the aim, with no bend and no crossing more', async () => {
    const [lines, one] = await Promise.all([run(yaml), run(withLayoutEntry(yaml, 'autoArrange: false'))]);
    expect(lines.groupArrangements?.leaves).toEqual({ chosen: 'stagger' });
    expect(lines.diagnostics.filter(item => item.code === FAN_WRAP_DECLINED)).toEqual([]);
    expect(gap(lines)).toBeLessThan(gap(one));
    const [a, b] = [score(lines).snapshot.metrics, score(one).snapshot.metrics];
    expect(a.crossings.count).toBeLessThanOrEqual(b.crossings.count);
    expect(a.bends.total).toBeLessThanOrEqual(b.bends.total);
    expect(failed(lines)).toEqual([]);
  }, 180000);

  it('judges the aim first: the one-line placement is farther from the aim than the two-line one', async () => {
    const [lines, one] = await Promise.all([run(yaml), run(withLayoutEntry(yaml, 'autoArrange: false'))]);
    expect(wrapGateVerdict(lines, one, 'aspect')).toBeUndefined();
    expect(wrapGateVerdict(one, lines, 'aspect')).toMatch(/farther from the aim 1\.778/);
    expect(wrapGateVerdict(one, one, 'aspect')).toMatch(/as near the aim 1\.778 as .* and not less area/);
  }, 180000);

  // Review 1 of ticket 22: the gate trades no turn that placement can see. Planned bends are placement data (CONTEXT.md), a lower bound.
  it('declines two lines whose planned bends add up to more than without them', async () => {
    const [lines, one] = await Promise.all([run(yaml), run(withLayoutEntry(yaml, 'autoArrange: false'))]);
    const total = (model: LayoutModel): number => model.links.reduce((sum, link) => sum + plannedBends(model, link), 0);
    expect(total(lines)).toBeLessThanOrEqual(total(one));
    // The two-line placement read with site groups one tier lower: each of their links is planned over two tier gaps (four bends, not two).
    // Nothing else the gate reads changes, so the planned bends alone decline the lines.
    const forged = structuredClone(lines);
    for (const id of Object.keys(forged.groups).filter(group => group.startsWith('site-')).sort()) {
      if (total(forged) > total(one)) break;
      const group = forged.groups[id]!;
      group.tier = (group.tier ?? 0) + 1;
    }
    expect(total(forged)).toBeGreaterThan(total(one));
    expect(wrapGateVerdict(forged, one, 'aspect')).toBe(`the planned bends rise from ${total(one)} to ${total(forged)} with two lines`);
  }, 180000);

  it('checks a declined stagger in the ledger: a model that still stands the row on two lines does not hold it (R5)', async () => {
    const [lines, one] = await Promise.all([run(yaml), run(withLayoutEntry(yaml, 'autoArrange: false'))]);
    const ledger = declineStagger('leaves', 'a named refusal', 'fan', 1);
    expect(holds(ledger, lines).map(failure => failure.why)).toEqual(['the row leaves stands on two lines although its stagger is declined']);
    expect(holds(ledger, one)).toEqual([]);
  }, 180000);

  it('declines a row by name when its trial fails a publication check in 7f, and never throws', async () => {
    refuse.on = true;
    try {
      const model = await run(yaml);
      expect(model.groupArrangements?.leaves).toMatchObject({ chosen: 'row' });
      expect(model.staggerRows ?? []).toEqual([]);
      expect(model.diagnostics.filter(item => item.code === FAN_WRAP_DECLINED).map(item => item.message))
        .toEqual(['The two lines of leaves are declined: 7f refused them: Stagger chord corridor of link link-1 enters leaf-2.']);
    } finally { refuse.on = false; }
  }, 180000);

  // Reviews 1 and 2 of ticket 22: the fan round is unrouted and committed its 7e with no 7f, so the next baseline threw the refusal (review 1);
  // the fix of review 1 then cut the fan round and kept the stagger without the fan pitch (review 2). A stagger row is kept only when the
  // placement that follows from it can be kept.
  it('declines a kept stagger by name when the fan round\'s 7f trial refuses it, and places the baseline again without it', async () => {
    refuse.fan = true;
    try {
      const [model, one] = await Promise.all([run(yaml), run(withLayoutEntry(yaml, 'autoArrange: false'))]);
      const reason = 'Stagger chord corridor of link link-1 enters leaf-2';
      expect(model.groupArrangements?.leaves).toEqual({ chosen: 'row', reason: `a later placement refused the two lines: ${reason}` });
      expect(model.staggerRows ?? []).toEqual([]);
      expect((model.reservations ?? []).filter(entry => entry.kind === 'staggerDeclined').map(entry => entry.payload)).toEqual([{ group: 'leaves', reason }]);
      // The fan round goes on on the baseline without the row: its floors stand, as in the one-line run.
      const floors = (item: LayoutModel): number => (item.reservations ?? []).filter(entry => entry.kind === 'pairFloor').length;
      expect(floors(model)).toBe(floors(one));
      expect(floors(model)).toBeGreaterThan(0);
      expect(model.diagnostics.filter(item => item.code === 'FAN_SPREAD_CUT')).toEqual([]);
      expect(model.diagnostics.filter(item => item.code === FAN_WRAP_DECLINED).map(item => item.message))
        .toEqual([`The two lines of leaves are declined: a later placement refused them: ${reason}.`]);
      expect(failed(model)).toEqual(failed(one));
      expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
    } finally { refuse.fan = false; }
  }, 180000);
});
