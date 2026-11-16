import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// A switch for the last test: 7f refuses every model that holds a stagger, as a publication check of a trial would.
const refuse = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/layout/bands.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/bands.js')>();
  const { PlacementRefusal } = await import('../../src/layout/placement-refusal.js');
  return {
    ...actual,
    bands: (...args: Parameters<typeof actual.bands>) => {
      if (refuse.on && args[0].staggerRows?.length) throw new PlacementRefusal('stagger', 'Stagger chord corridor of link link-1 enters leaf-2', { owners: [{ kind: 'group', id: 'leaves' }] });
      return actual.bands(...args);
    },
  };
});

import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { FAN_WRAP_DECLINED, wrapGateVerdict } from '../../src/layout/stagger.js';
import { aspectGap } from '../../src/layout/aspect.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withLayoutEntry } from '../aspect-fixture.js';

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
});
