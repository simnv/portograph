import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel, Point } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const names = {
  indifferent: 'overlay-links-reorder-an-indifferent-tier',
  crossings: 'an-overlay-reorder-is-refused-for-routed-crossings',
} as const;
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const overlays = (model: LayoutModel): LayoutLink[] => model.links.filter(link => (link.layer ?? link.family) === 'overlay');
const points = (link: LayoutLink): Point[] => [link.path!.segments[0]!.from, ...link.path!.segments.map(segment => segment.to)];
const straight = (model: LayoutModel): number => overlays(model).filter(link => points(link).length === 2).length;
const errors = (model: LayoutModel) => model.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
const refusals = (model: LayoutModel) => model.diagnostics.filter(diagnostic => diagnostic.code === 'OVERLAY_ORDER_REFUSED');
const left = (model: LayoutModel, id: string): number => model.groups[id]!.bounds!.x;
/** What a second run must reproduce: every box, every port anchor, every drawn path. */
const geometry = (model: LayoutModel): unknown => ({
  groups: Object.values(model.groups).map(group => [group.id, group.bounds, group.rowOrder]),
  nodes: Object.values(model.nodes).map(node => [node.id, node.bounds, node.ports.map(port => port.anchor)]),
  paths: model.links.map(link => [link.id, link.path]),
  codes: model.diagnostics.map(diagnostic => diagnostic.code),
});

describe('overlay-weighted order', () => {
  it('swaps the groups of a tier that the routed links leave indifferent, and the overlay links straighten', async () => {
    const model = await run(fixture(names.indifferent));
    expect(errors(model)).toEqual([]);
    // ELK stands P left of Q; the overlay links of q0 and p0 reach the tiers below over the bodies of tier 1.
    expect(left(model, 'Q')).toBeLessThan(left(model, 'P'));
    // One straight link of four without the rule; three of four with it.
    expect(overlays(model)).toHaveLength(4);
    expect(straight(model)).toBe(3);
    // The score counts one crossing with the rule and one without it: the swap does not raise it.
    expect(score(model).snapshot.metrics.crossings.count).toBe(1);
    expect(refusals(model)).toEqual([]);
  });

  it('refuses a re-order that would raise the routed crossings, with one warning for the tier', async () => {
    const model = await run(fixture(names.crossings));
    expect(errors(model)).toEqual([]);
    // The overlay link n2 to n3 pulls g10 to the right; the swap would cross n0-n4 with n3-n7.
    expect(left(model, 'g10')).toBeLessThan(left(model, 'g11'));
    const refused = refusals(model);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.severity).toBe('warning');
    expect(refused[0]!.message).toContain('tier 1');
    expect(refused[0]!.message).toContain('routed crossings would rise from 0 to 1');
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
    expect(straight(model)).toBe(1);
  });

  it.each(Object.values(names))('is idempotent and deterministic on %s', async name => {
    const one = await run(fixture(name)), two = await run(fixture(name));
    expect(geometry(two)).toEqual(geometry(one));
  });

  it('leaves an input with no overlay link as ELK had it', async () => {
    const yaml = fixture(names.crossings).split('\n').filter(line => !line.includes('route: overlay')).join('\n');
    const model = await run(yaml);
    expect(errors(model)).toEqual([]);
    expect(refusals(model)).toEqual([]);
    expect(left(model, 'g10')).toBeLessThan(left(model, 'g11'));
  });
});
