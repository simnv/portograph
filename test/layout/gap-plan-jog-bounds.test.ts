import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { planGap, tierGapPlan, type PlanFrame, type PlanInput } from '../../src/layout/gap-plan.js';
import { tierGaps } from '../../src/layout/gap-runs.js';
import { moveBands } from '../../src/layout/gap-room.js';
import { rebuildLaneExtents } from '../../src/layout/lanes.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { rebuildRegions } from '../../src/layout/regions.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../../src/theme/geometry.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 52, review 1: a jogged drop holds both sides of its interval. A 60 px gap has a frame above it that ends 30.75 px below the
 * gap's top (its margin included) and a frame below it that starts 30.75 px above the gap's bottom; both span the drop. The jog must stand at
 * least 30.75 px below the top and 30.75 px above the bottom, so the gap grows by 1.5 px, whichever x the jog stands on. Before, a jog on the
 * upper x read only the lower bound (and the upper tip), and a jog on the lower x read only the upper bound (and the lower tip): no growth,
 * and the jog stood 1.5 px inside the other frame's margin.
 */
const frame = (blocks: PlanFrame['blocks'] = []): PlanFrame => ({
  low: 0, bandTop: 60, floor: 60, keep: 11.5, pitch: 11.5, edge: 10.75, tips: [], lowerTips: [], residual: [], blocks,
  obstacles: [{ x0: 50, x1: 150, anchor: 'above', bound: 30.75 }, { x0: 50, x1: 150, anchor: 'below', bound: 30.75 }],
} as PlanFrame);
const drop: PlanInput = { id: 'p#0', link: 'p', order: 0, stroke: 1.5, upper: { x: 100, y: 15, kind: 'tip', source: 'u' }, lower: { x: 106, y: 45, kind: 'tip', source: 'd' } } as PlanInput;

describe('a jogged drop holds the frames on both sides of the gap', () => {
  for (const [stand, blocks] of [['upper', []], ['lower', [{ x0: 95, x1: 103, anchor: 'below', bound: 40 }]]] as const) {
    it(`grows the gap to hold the jog clear of both frames (the jog on the ${stand} x)`, () => {
      const plan = planGap([drop], frame([...blocks]));
      const part = plan.parts[0] as { shape: string; stand?: string; jog?: number };
      expect(part.shape).toBe('drop');
      expect(part.stand).toBe(stand);
      expect(plan.growth).toBeCloseTo(1.5, 6);
      // The jog in the grown gap: the band below moves down by the growth, so a jog measured from it (on the upper x) moves with it.
      const jog = stand === 'upper' ? part.jog! + plan.growth : part.jog!;
      expect(jog).toBeGreaterThanOrEqual(30.75 - 1e-6);
      expect(jog).toBeLessThanOrEqual(60 + plan.growth - 30.75 + 1e-6);
    });
  }
});

describe('a jogged drop holds the frame edges on both sides of its gap, on a sheet (dense-16x9 ticket 52, review 1)', () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-jogged-drop-holds-the-frame-edges-on-both-sides-of-its-gap.yaml', import.meta.url), 'utf8');
  for (const on of [false, true]) {
    for (const [name, text] of [['as written', yaml], ['nodes reversed', reversed(yaml, 'nodes') as string]] as const) {
      it(`clears G6 and grows the gap by name (${name}, moveBeforeGrow ${on ? 'on' : 'off'})`, async () => {
        // The off form writes the opt-out: since dense-16x9 ticket 45 a sheet that writes nothing runs with the option on.
        const parsed = parse(text), document = { ...parsed, layout: { ...parsed.layout, moveBeforeGrow: on } };
        const model = await layout(document, { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
        expect(model.document.layout?.moveBeforeGrow === true).toBe(on);
        expect(score(model).snapshot.gates.G6.violations).toEqual([]);
        expect(model.removedLinks ?? []).toEqual([]);
        const north = model.frames!.find(item => item.id === 'north')!, south = model.frames!.find(item => item.id === 'south')!;
        const link = model.links.find(item => item.attachments!.from.node === 'y' && item.attachments!.to.node === 'b')!;
        const margin = GROUP_EDGE_LINK_CLEARANCE + linkStrokeWidth(link) / 2;
        const top = north.box.y + north.box.height, foot = south.box.y;
        // Every horizontal segment of the link in the gap between the two cantons keeps the margin from both edges.
        const rows = link.path!.segments.filter(segment => Math.abs(segment.from.y - segment.to.y) < 1e-6 && segment.from.y > top - 1e-6 && segment.from.y < foot + 1e-6);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.from.y - top).toBeGreaterThanOrEqual(margin - 1e-6);
          expect(foot - row.from.y).toBeGreaterThanOrEqual(margin - 1e-6);
        }
        expect(model.diagnostics.some(item => item.code === 'TIER_GAP_GROWN' && item.message.includes(`set by ${link.id}#`))).toBe(true);
      }, 120000);
    }
  }
});

/**
 * Review 2: the edge of a lower frame bounds a jog whatever the sign of its bound. The staged draft is the 7e output (`bundles`) of the sheet
 * above without the canton `south` (generic names): the replay puts the last cell of `u` in its child frame, raises the sibling group `other` by
 * 55 px and draws every link 24 px wide, so the margin is 22. `north` ends at 457.50 and the frame `d` starts at 500, 22.50 below the band top of
 * tier 3 (477.50): its bound is -0.50. Dropped, the jog of link-4 stood at 498 (2 px from `d`) with no growth and no residual; held, the plan
 * grows the gap 1.50 px by name and the jog stands 22 px from each edge.
 */
describe('a jogged drop holds a lower frame that starts past its band top (dense-16x9 ticket 52, review 2)', () => {
  it('grows the gap by name and seats the jog the margin from both frame edges', () => {
    const model = JSON.parse(readFileSync(new URL('../fixtures/staged/a-jog-between-a-frame-and-a-lower-frame-past-its-band-top.draft.json', import.meta.url), 'utf8')) as LayoutModel;
    const frames = model.document.frames!;
    frames['u']!.cells = ['uc#0']; frames['uc']!.cells = ['u#2', 'uc#1'];
    model.groups['uc#0']!.frame = 'u'; model.groups['u#2']!.frame = 'uc';
    for (const link of model.links) link.strokeWidth = 24;
    moveGroup(model, model.groups['other']!, 0, -55);
    rebuildNodeGeometry(model, model.groups['other']!.nodes, 'current');
    rebuildRegions(model); rebuildLaneExtents(model);
    const read = () => tierGapPlan(model, tierGaps(model).find(gap => gap.above === 2 && gap.below === 3)!);
    const before = model.frames!.find(item => item.id === 'd')!.box.y, band = model.tierBands.find(item => item.tier === 3)!.bounds!.y;
    // The edge of `d` stands past the band top by more than the margin (`d` starts 22.50 below it): a bound of -0.50 below the band.
    expect(before - band).toBeGreaterThan(22);
    // The plan grows the gap as 7f applies it, until it asks for nothing (a bounded replay).
    const plans: ReturnType<typeof read>[] = [];
    for (let round = 0; round < 3; round++) {
      const plan = read();
      plans.push(plan);
      if (plan.growth <= 1e-9) break;
      moveBands(model, new Map([[3, plan.growth]]));
    }
    expect(plans.at(-1)!.growth).toBeCloseTo(0, 6);
    expect(plans.some(plan => plan.setBy === 'link-4#1' && plan.growth > 0)).toBe(true);
    for (const plan of plans) expect(plan.residual).toEqual([]);
    const north = model.frames!.find(item => item.id === 'north')!.box, top = north.y + north.height, foot = model.frames!.find(item => item.id === 'd')!.box.y;
    const jog = (plans.at(-1)!.parts.find(part => part.id === 'link-4#1') as { jog?: number }).jog!;
    expect(jog - top).toBeGreaterThanOrEqual(22 - 1e-6);
    expect(foot - jog).toBeGreaterThanOrEqual(22 - 1e-6);
  });
});
