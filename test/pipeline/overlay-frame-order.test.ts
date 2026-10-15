import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel, Point, Rect } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const names = {
  reorder: 'overlay-links-reorder-two-locations',
  refused: 'an-overlay-frame-reorder-is-refused-for-routed-crossings',
  blocked: 'an-overlay-frame-reorder-is-refused-for-a-blocked-routed-link',
  six: 'an-overlay-frame-reorder-is-refused-with-six-sync-links',
} as const;
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string, extra: { testMaxReruns?: number } = {}): Promise<LayoutModel> => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...extra });
/** The same layout with the order of frames switched off: what ELK and the packing leave. */
async function runWithoutRule(name: string, extra: { testMaxReruns?: number } = {}): Promise<{ model: LayoutModel; metrics: ReturnType<typeof score>['snapshot']['metrics'] }> {
  vi.resetModules();
  vi.doMock('../../src/layout/overlay-order.js', async importOriginal => ({
    ...await importOriginal<typeof import('../../src/layout/overlay-order.js')>(), orderFramesByOverlay: () => false,
  }));
  try {
    const api = await import('../../src/internal.js');
    const model = await api.layout(api.parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...extra });
    return { model, metrics: api.score(model).snapshot.metrics };
  } finally {
    vi.doUnmock('../../src/layout/overlay-order.js');
    vi.resetModules();
  }
}
/** The overlay links that are more than one segment. */
const bent = (model: LayoutModel): LayoutLink[] => model.links.filter(link => link.layer === 'overlay' && link.path!.segments.length > 1);
const errors = (model: LayoutModel) => model.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
const refusals = (model: LayoutModel) => model.diagnostics.filter(diagnostic => diagnostic.code === 'OVERLAY_ORDER_REFUSED');
const points = (link: LayoutLink): Point[] => [link.path!.segments[0]!.from, ...link.path!.segments.map(segment => segment.to)];
const right = (box: Rect): number => box.x + box.width;
const frame = (model: LayoutModel, id: string): Rect => model.frames!.find(item => item.id === id)!.box;
/** The sync links: the overlay links between the second ranks of A and C. */
const syncs = (model: LayoutModel): LayoutLink[] => model.links.filter(link => link.layer === 'overlay'
  && [link.attachments!.from.node, link.attachments!.to.node].sort().join() === 'a-sync1,c-sync1');
const geometry = (model: LayoutModel): unknown => ({
  groups: Object.values(model.groups).map(group => [group.id, group.bounds, group.rowOrder]),
  frames: model.frames,
  nodes: Object.values(model.nodes).map(node => [node.id, node.bounds, node.ports.map(port => port.anchor)]),
  paths: model.links.map(link => [link.id, link.path]),
  codes: model.diagnostics.map(diagnostic => diagnostic.code),
});
/** Frames are disjoint columns, and the sheet passes G9. */
function expectColumns(model: LayoutModel): void {
  for (const [i, one] of model.frames!.entries()) {
    for (const other of model.frames!.slice(i + 1)) {
      // A child frame lies inside its parent; every other pair of frames is disjoint.
      if (one.parent === other.id || other.parent === one.id) continue;
      expect(one.box.x < right(other.box) - 1e-6 && other.box.x < right(one.box) - 1e-6, `${one.id} and ${other.id} share an x range`).toBe(false);
    }
  }
  const report = score(model);
  expect(report.snapshot.gates.G9.violations).toEqual([]);
  expect(report.snapshot.gates.G9.passed).toBe(true);
}

describe('overlay-weighted order of frames', () => {
  it('moves a location as a column, so the two locations that share the dense sync links stand side by side and the links straighten', async () => {
    const model = await run(names.reorder);
    expect(errors(model)).toEqual([]);
    // The key is the mean x of the partners outside the frame and outside its sub-tier: A and C have the
    // hub alone (a tie, so ELK's order A, C stands); B has the hub and ntp1, the left end of the feed row,
    // so its key is the smallest and B takes the left end. ELK had B between A and C.
    const [a, b, c] = ['a', 'b', 'c'].map(id => frame(model, id));
    expect(b!.x).toBeLessThan(a!.x);
    expect(right(b!)).toBeLessThanOrEqual(a!.x);
    expect(a!.x).toBeLessThan(c!.x);
    // A and C are neighbours: nothing stands between them.
    expect(right(a!)).toBeLessThanOrEqual(c!.x);
    // Every cell of a frame moved with it: the cells stand inside their frame.
    for (const owner of model.frames!) {
      for (const cell of owner.cells) {
        const box = model.groups[cell]!.bounds!;
        expect(box.x, cell).toBeGreaterThanOrEqual(owner.box.x - 1e-6);
        expect(right(box), cell).toBeLessThanOrEqual(right(owner.box) + 1e-6);
      }
    }
    // Both sync links are one straight segment.
    expect(syncs(model)).toHaveLength(2);
    for (const link of syncs(model)) expect(points(link), link.id).toHaveLength(2);
    expect(refusals(model)).toEqual([]);
    expectColumns(model);
  }, 60000);

  it('is a gain on the score before the side round: no routed link is worse, and fewer overlay links are bent than with the rule off', async () => {
    // The side round is off in both arms: it takes lateral sides in the arm without the rule (bends 6 to 0) and refuses them in the arm with it, and this test
    // compares the rule alone (ticket 117).
    const model = await run(names.reorder, { testMaxReruns: 0 }), off = await runWithoutRule(names.reorder, { testMaxReruns: 0 });
    const on = score(model).snapshot.metrics;
    // The rule moved B: with it off, B stands between A and C.
    const [a, b, c] = ['a', 'b', 'c'].map(id => off.model.frames!.find(item => item.id === id)!.box);
    expect(a!.x < b!.x && b!.x < c!.x).toBe(true);
    expect(on.crossings.count).toBeLessThanOrEqual(off.metrics.crossings.count);
    expect(on.bends.total).toBeLessThanOrEqual(off.metrics.bends.total);
    expect(on.continuity.value).toBeGreaterThanOrEqual(off.metrics.continuity.value);
    expect(bent(model).length).toBeLessThan(bent(off.model).length);
  }, 120000);

  it('refuses a re-order of frames that would raise the routed crossings, with one warning', async () => {
    const model = await run(names.refused);
    expect(errors(model)).toEqual([]);
    // The key of B is the smallest again, but B at the left end would cross ntp3 to A with hub to B.
    const [a, b, c] = ['a', 'b', 'c'].map(id => frame(model, id));
    expect(a!.x).toBeLessThan(b!.x);
    expect(b!.x).toBeLessThan(c!.x);
    const refused = refusals(model);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.severity).toBe('warning');
    expect(refused[0]!.message).toContain('routed crossings would rise from 0 to 1');
    expect(score(model).snapshot.metrics.crossings.count).toBe(0);
    expectColumns(model);
  }, 60000);

  it('refuses a re-order that would put a body between the ends of a routed link inside a sub-tier, with one warning', async () => {
    const model = await run(names.blocked), off = await runWithoutRule(names.blocked);
    expect(errors(model)).toEqual([]);
    // The move would straighten the two sync links, and it would block the routed link b-edge to c-sync1.
    const [a, b, c] = ['a', 'b', 'c'].map(id => frame(model, id));
    expect(a!.x).toBeLessThan(b!.x);
    expect(b!.x).toBeLessThan(c!.x);
    const refused = refusals(model);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('routed links with a body between their ends would rise from 0 to 1');
    // ELK's order stands, so the score is the one of the layout without the rule.
    const metrics = score(model).snapshot.metrics;
    expect(metrics.bends.total).toBe(off.metrics.bends.total);
    expect(metrics.continuity.value).toBe(off.metrics.continuity.value);
    expectColumns(model);
  }, 120000);

  it('refuses the same re-order with six sync links: the height of the ports is read, and the routed link is still blocked', async () => {
    const model = await run(names.six);
    expect(errors(model)).toEqual([]);
    const [a, b, c] = ['a', 'b', 'c'].map(id => frame(model, id));
    expect(a!.x).toBeLessThan(b!.x);
    expect(b!.x).toBeLessThan(c!.x);
    const refused = refusals(model);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('routed links with a body between their ends would rise from 0 to 1');
    expect(syncs(model)).toHaveLength(6);
    // The overlay link from ntp1 to b-edge stays one straight segment; the move would have bent it.
    const ntp = model.links.find(link => link.layer === 'overlay' && [link.attachments!.from.node, link.attachments!.to.node].sort().join() === 'b-edge,ntp1')!;
    expect(points(ntp)).toHaveLength(2);
    expectColumns(model);
  }, 60000);

  it.each(Object.values(names))('is idempotent and deterministic on %s', async name => {
    const one = await run(name), two = await run(name);
    expect(geometry(two)).toEqual(geometry(one));
  }, 60000);
});
