import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel, Point, Rect } from '../../src/index.js';
import { orderByOverlay } from '../../src/layout/overlay-order.js';
import { placeOverlayFree } from '../../src/layout/overlay-place.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const names = {
  indifferent: 'overlay-links-reorder-an-indifferent-tier',
  crossings: 'an-overlay-reorder-is-refused-for-routed-crossings',
  bend: 'an-overlay-reorder-is-refused-when-a-link-would-bend',
  partners: 'a-row-orders-its-nodes-by-overlay-partners',
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
    // One straight link of four without the rule; three of four with it, and four of four since ticket 66 (a hard leg under a title widens its group).
    // Three of four again since ticket 162: the feed q0 to k0 is a chord over the title of Rack N, so no leg widens the group, Group M stands
    // further left, and m2 stands on the line from q0 to a1. The routed feed lost its two bends; the overlay link took two.
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

  it('keeps the straight overlay links of a free group whose barycentre would put a body on a line', async () => {
    const model = await run(fixture(names.bend));
    expect(errors(model)).toEqual([]);
    expect(overlays(model)).toHaveLength(4);
    expect(straight(model)).toBe(4);
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
  });

  describe('the partners of a row (ticket 78)', () => {
    const nodeLeft = (model: LayoutModel, id: string): number => model.nodes[id]!.bounds!.x;
    it('stands the linked nodes of a row next to each other, and both overlay links are one straight segment', async () => {
      const model = await run(fixture(names.partners));
      expect(errors(model)).toEqual([]);
      const order = ['n1', 'n2', 'n3', 'n4'].sort((a, b) => nodeLeft(model, a) - nodeLeft(model, b));
      // n1 stands next to n3 and n2 next to n4; the author wrote n1 n2 n3 n4.
      expect(Math.abs(order.indexOf('n1') - order.indexOf('n3'))).toBe(1);
      expect(Math.abs(order.indexOf('n2') - order.indexOf('n4'))).toBe(1);
      expect(overlays(model)).toHaveLength(2);
      expect(straight(model)).toBe(2);
      expect(model.groups.R!.rowOrder).toEqual(order);
      expect(score(model).snapshot.metrics.crossings.count).toBe(0);
      expect(refusals(model)).toEqual([]);
    });

    it('keeps the order of a row whose partners are already neighbours', async () => {
      // n1-n2 and n3-n4 already stand next to each other: nothing gains, so the order the author wrote stands.
      const yaml = fixture(names.partners).replace('[n1, n3, { route: overlay }]', '[n1, n2, { route: overlay }]').replace('[n2, n4, { route: overlay }]', '[n3, n4, { route: overlay }]');
      const model = await run(yaml);
      expect(straight(model)).toBe(2);
      expect(['n1', 'n2', 'n3', 'n4'].map(id => nodeLeft(model, id))).toEqual([...['n1', 'n2', 'n3', 'n4'].map(id => nodeLeft(model, id))].sort((a, b) => a - b));
    });

    it('is deterministic', async () => {
      expect(geometry(await run(fixture(names.partners)))).toEqual(geometry(await run(fixture(names.partners))));
    });
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
  describe('the width of a re-ordered row', () => {
    // Tier 1 (four bodies) is the anchor. Tier 2 holds row A (a1, a0) and, 10 px to its right, group S.
    // The overlay links p0-a0 and q0-a1 cross each other and both run over m0, so the swap of a0 and a1
    // is a gain on the draft. Bodies are put by hand: ELK would not give this placement.
    const yaml = `portograph: 2
groups: { T: { tier: 0 }, M: { tier: 1 }, A: { tier: 2 }, S: { tier: 2 } }
nodes:
  p0: { group: T, class: server }
  q0: { group: T, class: server }
  m0: { group: M, class: server }
  m1: { group: M, class: server }
  m2: { group: M, class: server }
  m3: { group: M, class: server }
  a0: { group: A, class: server }
  a1: { group: A, class: server }
  s0: { group: S, class: server }
links:
  - [p0, a0, { route: overlay }]
  - [q0, a1, { route: overlay }]
`;
    const draft = async (stroke?: number): Promise<LayoutModel> => {
      const model = structuredClone(await placed(yaml));
      const put = (id: string, x: number, y: number): void => { model.nodes[id]!.bounds = { x, y, width: 50, height: 35 }; };
      const box = (id: string, x: number, y: number, width: number): void => { model.groups[id]!.bounds = { x, y, width, height: 75 }; };
      put('p0', 20, 12); put('q0', 120, 12); box('T', 8, 12, 174);
      put('m0', 75, 147); put('m1', 300, 147); put('m2', 370, 147); put('m3', 440, 147); box('M', 63, 127, 440);
      put('a1', 20, 282); put('a0', 120, 282); box('A', 8, 262, 174);
      put('s0', 204, 282); box('S', 192, 262, 74);
      model.groups.A!.rowOrder = ['a1', 'a0'];
      if (stroke) model.nodes.a0!.strokeWidth = stroke;
      return model;
    };

    it('swaps the nodes of the row when the row does not grow', async () => {
      const model = await draft();
      orderByOverlay(model);
      expect(model.groups.A!.rowOrder).toEqual(['a0', 'a1']);
      expect(model.groups.A!.bounds!.x + model.groups.A!.bounds!.width).toBeLessThanOrEqual(model.groups.S!.bounds!.x);
    });

    it('refuses the swap when the wider row would run into the group to its right', async () => {
      // A stroke of 100 px on a0 widens the gap of the repacked row by 20.75 px, and S is 10 px away.
      const model = await draft(100);
      const before = structuredClone(model.groups.A!);
      orderByOverlay(model);
      expect(model.groups.A!.rowOrder).toEqual(['a1', 'a0']);
      expect(model.groups.A!.bounds).toEqual(before.bounds);
      expect(model.nodes.a0!.bounds!.x).toBe(120);
      expect(model.nodes.a1!.bounds!.x).toBe(20);
    });
  });

  it('measures the straight overlay links of a tier from fresh pills, not from the pills a move left behind', async () => {
    // `centre` moves groups without moving their pills. The guard of `placeOverlayFree` rebuilds them
    // before it counts, so stale pills, put here where they would block, change nothing.
    // (Not red-first: no fixture showed a divergence before the rebuild was added.)
    const base = await run(fixture(names.bend));
    const settle = (model: LayoutModel): unknown => Object.values(model.groups).map(group => [group.id, group.bounds]);
    const reference = structuredClone(base);
    placeOverlayFree(reference);
    for (const [id, dx, dy] of [['f0', 1000, 0], ['f0', -1000, 0], ['f0', 0, -300], ['r0', 500, 0], ['y0', 300, 0]] as const) {
      const model = structuredClone(base);
      for (const port of model.nodes[id]?.ports ?? []) if (port.pill) { port.pill.bounds.x += dx; port.pill.bounds.y += dy; }
      placeOverlayFree(model);
      expect(settle(model)).toEqual(settle(reference));
    }
  });
});

describe('an overlay link between level side ports (ticket 86)', () => {
  it('goes round a same-row body that ordering cannot move, and no segment enters a body', async () => {
    const model = await run(fixture('a-straight-overlay-between-level-side-ports-goes-round-a-same-row-body'));
    expect(errors(model)).toEqual([]);
    const [a, m, c] = ['a', 'm', 'c'].map(id => model.nodes[id]!.bounds!) as [Rect, Rect, Rect];
    expect(a.x).toBeLessThan(m.x);
    expect(m.x).toBeLessThan(c.x);
    const path = points(overlays(model)[0]!);
    expect(path.length).toBeGreaterThan(2);
    for (const [index, from] of path.slice(0, -1).entries()) {
      const to = path[index + 1]!;
      for (const body of Object.values(model.nodes).map(node => node.bounds!)) {
        const inside = Math.max(from.x, to.x) > body.x + 1e-6 && Math.min(from.x, to.x) < body.x + body.width - 1e-6
          && Math.max(from.y, to.y) > body.y + 1e-6 && Math.min(from.y, to.y) < body.y + body.height - 1e-6;
        expect(inside).toBe(false);
      }
    }
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('goes round the pills that hang off the body it passes, too', async () => {
    const model = await run(fixture('an-overlay-between-level-side-ports-goes-round-the-pills-of-a-same-row-body'));
    expect(errors(model)).toEqual([]);
    const path = points(overlays(model)[0]!);
    expect(path.length).toBeGreaterThan(2);
    const shapes = [...Object.values(model.nodes).map(node => node.bounds!),
      ...Object.values(model.nodes).flatMap(node => node.ports.flatMap(port => port.pill ? [port.pill.bounds] : []))];
    const own = (box: Rect): boolean => ['a', 'c'].some(id => model.nodes[id]!.ports.some(port => port.pill?.bounds === box));
    for (const [index, from] of path.slice(0, -1).entries()) {
      const to = path[index + 1]!;
      for (const body of shapes.filter(box => !own(box))) {
        const inside = Math.max(from.x, to.x) > body.x + 1e-6 && Math.min(from.x, to.x) < body.x + body.width - 1e-6
          && Math.max(from.y, to.y) > body.y + 1e-6 && Math.min(from.y, to.y) < body.y + body.height - 1e-6;
        expect(inside).toBe(false);
      }
    }
  }, 60000);
});
