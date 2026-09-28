import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutLink, LayoutModel, Point, Rect } from '../../src/index.js';
import { centreDraft, createCentreBudget } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { withLayoutMutation } from '../../src/layout/mutation.js';
import { placeOverlayFree } from '../../src/layout/overlay-place.js';
import { rows } from '../../src/layout/rows.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: Rect): number => box.x + box.width;
const centreX = (box: Rect): number => box.x + box.width / 2;
const nodeX = (model: LayoutModel, id: string): number => centreX(model.nodes[id]!.bounds!);
const groupBox = (model: LayoutModel, id: string): Rect => model.groups[id]!.bounds!;
const overlays = (model: LayoutModel): LayoutLink[] => model.links.filter(link => (link.layer ?? link.family) === 'overlay');
const points = (link: LayoutLink): Point[] => [link.path!.segments[0]!.from, ...link.path!.segments.map(segment => segment.to)];
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const errors = (model: LayoutModel) => model.diagnostics.filter(diagnostic => diagnostic.severity === 'error');

/** Whether two segments cross at a point interior to both. */
function cross(one: [Point, Point], two: [Point, Point]): boolean {
  const side = (a: Point, b: Point, c: Point): number => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  return side(one[0], one[1], two[0]) * side(one[0], one[1], two[1]) < 0 && side(two[0], two[1], one[0]) * side(two[0], two[1], one[1]) < 0;
}

describe('overlay barycentre for the free', () => {
  it('stands each overlay-only group under the mean x of its partners, with every overlay link straight', async () => {
    const model = await run(fixture('overlay-only-groups-stand-under-their-partners'));
    expect(errors(model)).toEqual([]);
    const gap = bandGap(model);
    const target = (partners: string[]): number => mean(partners.map(id => nodeX(model, id)));
    const a = centreX(groupBox(model, 'client-a')), b = centreX(groupBox(model, 'client-b')), c = centreX(groupBox(model, 'client-c'));
    expect(Math.abs(a - target(['n1', 'n2']))).toBeLessThanOrEqual(gap);
    expect(Math.abs(b - target(['s1', 's2']))).toBeLessThanOrEqual(gap);
    expect(Math.abs(c - target(['n2', 's1']))).toBeLessThanOrEqual(gap);
    // a under north, b under south, c between the two.
    expect(a).toBeLessThan(c);
    expect(c).toBeLessThan(b);
    // The middle group keeps north and south wide apart: the clients are not stacked under one group.
    expect(b - a).toBeGreaterThan(2 * gap);
    const drawn = overlays(model);
    expect(drawn).toHaveLength(6);
    for (const link of drawn) expect(points(link), link.id).toHaveLength(2);
  }, 60000);

  it('never moves routed geometry: every routed group and node stands where the rows and lanes left it', async () => {
    const yaml = fixture('overlay-only-groups-stand-under-their-partners');
    const model = flanks(lanes(rows(await placed(yaml))));
    let moved = 0;
    withLayoutMutation(model, 'centre', draft => {
      const routed = ['core', 'north', 'middle', 'south'];
      const nodes = ['c1', 'c2', 'c3', 'n1', 'n2', 'm1', 'm2', 'm3', 's1', 's2'];
      const before = JSON.stringify([routed.map(id => draft.groups[id]), nodes.map(id => draft.nodes[id])]);
      const clients = ['client-a', 'client-b', 'client-c'].map(id => JSON.stringify(draft.groups[id]));
      placeOverlayFree(draft);
      expect(JSON.stringify([routed.map(id => draft.groups[id]), nodes.map(id => draft.nodes[id])])).toBe(before);
      moved = ['client-a', 'client-b', 'client-c'].filter((id, i) => JSON.stringify(draft.groups[id]) !== clients[i]).length;
      centreDraft(draft, createCentreBudget());
    });
    // The rule moved the clients, and only them.
    expect(moved).toBeGreaterThan(0);
  }, 60000);

  it('orders the nodes of an overlay-only group by the x of their partners, so their overlay links do not cross', async () => {
    const model = await run(fixture('overlay-only-nodes-stand-in-the-order-of-their-partners'));
    expect(errors(model)).toEqual([]);
    expect(nodeX(model, 'p2')).toBeLessThan(nodeX(model, 'p1'));
    expect(model.groups['pair']!.rowOrder).toEqual(['p2', 'p1']);
    const drawn = overlays(model);
    expect(drawn).toHaveLength(2);
    for (const link of drawn) expect(points(link), link.id).toHaveLength(2);
    const [one, two] = drawn.map(link => points(link) as [Point, Point]);
    expect(cross(one!, two!)).toBe(false);
    // The group stands under the mean of its partners.
    const partners = mean([nodeX(model, 'w1'), nodeX(model, 'e1')]);
    expect(Math.abs(centreX(groupBox(model, 'pair')) - partners)).toBeLessThanOrEqual(bandGap(model));
  }, 60000);

  it('sweeps two groups with one target apart at the band gap and centres the pair back on it', async () => {
    const model = await run(fixture('two-overlay-only-groups-keep-the-band-gap'));
    expect(errors(model)).toEqual([]);
    const x = groupBox(model, 'client-x'), y = groupBox(model, 'client-y');
    const [left, rightBox] = x.x <= y.x ? [x, y] : [y, x];
    expect(rightBox.x - right(left)).toBeGreaterThanOrEqual(bandGap(model) - 1e-6);
    expect(Math.abs(mean([centreX(x), centreX(y)]) - nodeX(model, 'n2'))).toBeLessThanOrEqual(1);
  }, 60000);

  it('is idempotent: a second pass leaves the layout as the first left it', async () => {
    for (const name of ['overlay-only-groups-stand-under-their-partners', 'overlay-only-nodes-stand-in-the-order-of-their-partners',
      'two-overlay-only-groups-keep-the-band-gap']) {
      const model = flanks(lanes(rows(await placed(fixture(name)))));
      let checked = false;
      withLayoutMutation(model, 'centre', draft => {
        const before = JSON.stringify(draft);
        placeOverlayFree(draft);
        const once = JSON.stringify(draft);
        expect(once, `${name} moves something`).not.toBe(before);
        placeOverlayFree(draft);
        expect(JSON.stringify(draft), name).toBe(once);
        checked = true;
        centreDraft(draft, createCentreBudget());
      });
      expect(checked).toBe(true);
    }
  }, 120000);

  it('runs the whole layout twice to the same JSON', async () => {
    const yaml = fixture('overlay-only-groups-stand-under-their-partners');
    const strip = (model: LayoutModel) => { const copy: Partial<LayoutModel> = { ...model }; delete copy.runtime; return copy; };
    expect(strip(await run(yaml))).toEqual(strip(await run(yaml)));
  }, 120000);
});
