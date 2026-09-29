import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { CANVAS_MARGIN } from '../../src/theme/geometry.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const EPS = 1e-6;

describe('tier gaps compact (ranked-groups ticket 18)', () => {
  it('a sync mesh and a same-tier peer link do not stack the cells of one sub-tier', async () => {
    const model = await layout(parse(fixture('sync-links-do-not-stack-a-tier')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const bands = [...model.tierBands].sort((a, b) => a.bounds!.y - b.bounds!.y);
    expect(bands.map(band => band.tier)).toEqual([0, 1, 2]);
    // The allocation the pipeline records: each TIER_GAP_GROWN warning names the groups of the band below the gap.
    const grown = new Map<number, number>();
    for (const diagnostic of model.diagnostics.filter(item => item.code === 'TIER_GAP_GROWN')) {
      const px = Number(/grew ([\d.]+) px/.exec(diagnostic.message)![1]);
      const owner = diagnostic.owners![0]!;
      const band = bands.find(item => item.groups.includes(('id' in owner ? owner.id : '').replace(/^group:/, '')))!;
      grown.set(band.tier, (grown.get(band.tier) ?? 0) + px);
    }
    const gap = bandGap(model);
    for (const [i, band] of bands.slice(1).entries()) {
      const above = bands[i]!.bounds!, actual = band.bounds!.y - (above.y + above.height);
      expect(actual, `gap above tier ${band.tier}`).toBeCloseTo(gap + (grown.get(band.tier) ?? 0), 1);
    }
    // The gateways stand in one row, and so do the switches.
    const y = (id: string): number => model.nodes[id]!.bounds!.y;
    expect(y('gw2')).toBeCloseTo(y('gw1'), 6); expect(y('gw3')).toBeCloseTo(y('gw1'), 6);
    expect(y('sw2')).toBeCloseTo(y('sw1'), 6); expect(y('sw3')).toBeCloseTo(y('sw1'), 6);
    // The canvas is the bands, the gaps and the margins, and nothing else: the one thing the diagram
    // draws below the last band is the generated legend, which stage 9 seats under it.
    const first = bands[0]!.bounds!, last = bands[bands.length - 1]!.bounds!;
    const gaps = bands.slice(1).reduce((sum, band, i) => sum + band.bounds!.y - (bands[i]!.bounds!.y + bands[i]!.bounds!.height), 0);
    const heights = bands.reduce((sum, band) => sum + band.bounds!.height, 0);
    expect(Math.abs(last.y + last.height - first.y - (heights + gaps))).toBeLessThan(EPS);
    const canvas = model.canvas!, floor = model.legend ? model.legend.bounds.y + model.legend.bounds.height : last.y + last.height;
    expect(Math.abs(canvas.y + canvas.height - (floor + CANVAS_MARGIN))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(first.y - canvas.y - CANVAS_MARGIN)).toBeLessThanOrEqual(0.5);
  }, 60000);

  it('a re-seated band carries its bar and its flank, icons included', async () => {
    const model = await layout(parse(fixture('a-re-seated-band-carries-its-bar-and-flank')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const bands = [...model.tierBands].sort((a, b) => a.bounds!.y - b.bounds!.y);
    expect(bands.length).toBeGreaterThanOrEqual(5);
    // The bar and the flank stand where their bands stand: the flank's box lies in the band of its tier.
    for (const id of ['rails', 'side']) {
      const band = bands.find(item => item.groups.includes(id))!;
      expect(model.groups[id]!.bounds!.y).toBeGreaterThanOrEqual(band.bounds!.y - EPS);
    }
    expect(model.nodes.rail!.icon).toBeDefined();
    expect(model.nodes.s1!.icon).toBeDefined();
    const gap = bandGap(model);
    for (const [i, band] of bands.slice(1).entries()) {
      const above = bands[i]!.bounds!;
      expect(band.bounds!.y - (above.y + above.height) - gap, `gap above tier ${band.tier}`).toBeGreaterThanOrEqual(-EPS);
    }
  }, 60000);
});
