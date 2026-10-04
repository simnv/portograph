import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { alignLinkedGroupGrid } from '../../src/layout/bands.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Architecture ticket 07 (ADR-0012 amendment): the linked grid widens a core and moves its flanks outward, so each keeps one band gap.
it('a core the grid widens keeps one band gap to both flanks', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-grid-keeps-the-flank-gap-of-a-widened-core.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const [upper, core, left, right] = ['upper', 'core', 'side-left', 'side-right'].map(id => model.groups[id]!.bounds!);
  expect(core!.x, 'the grid widened the core to the extent above it').toBeCloseTo(upper!.x, 6);
  expect(core!.width).toBeCloseTo(upper!.width, 6);
  expect(core!.x - (left!.x + left!.width), 'left flank gap').toBeCloseTo(bandGap(model), 6);
  expect(right!.x - (core!.x + core!.width), 'right flank gap').toBeCloseTo(bandGap(model), 6);
  expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
});

it('a widening whose flank cannot move out is refused, and is made when the flank can', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-grid-keeps-the-flank-gap-of-a-widened-core.yaml', import.meta.url), 'utf8');
  const published = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  // Undo the grid: the core stands 30 px narrower on the left, and its left flank stands a band gap from that narrower box.
  const stage = (): LayoutModel => {
    const model = structuredClone(published);
    const core = model.groups['core']!.bounds!;
    core.x += 30; core.width -= 30;
    moveGroup(model, model.groups['side-left']!, 30, 0);
    return model;
  };
  const open = stage();
  expect(alignLinkedGroupGrid(open)).toBe(true);
  expect(open.groups['core']!.bounds!.x).toBeCloseTo(published.groups['core']!.bounds!.x, 6);
  expect(open.groups['side-left']!.bounds!.x).toBeCloseTo(published.groups['side-left']!.bounds!.x, 6);

  // A box stands where the flank would move to: the flank cannot move, so the core is not widened.
  const blocked = stage();
  const flank = blocked.groups['side-left']!.bounds!;
  blocked.groups['blocker'] = { ...blocked.groups['upper']!, id: 'blocker', nodes: [], bounds: { x: flank.x - 40, y: flank.y, width: 40, height: flank.height } };
  const before = JSON.stringify(blocked.groups['core']!.bounds);
  expect(alignLinkedGroupGrid(blocked)).toBe(false);
  expect(JSON.stringify(blocked.groups['core']!.bounds)).toBe(before);
  expect(blocked.groups['side-left']!.bounds!.x).toBeCloseTo(flank.x, 6);
});

// Architecture ticket 11: a frame column the rows rule moves right must not move into a right flank seated beside the tier.
it('a right flank stands a band gap clear of a canton column in its tier', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-canton-next-to-a-flank-keeps-the-flank-gap.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const east = model.groups['east#0']!.bounds!, flank = model.groups['side-right']!.bounds!;
  expect(flank.x - (east.x + east.width), 'flank gap to the canton member').toBeGreaterThanOrEqual(bandGap(model) - 1e-6);
  expect(model.groups['core']!.bounds!.x + model.groups['core']!.bounds!.width).toBeLessThan(east.x);
  expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
});

it('the hold pass does not pull a canton column into a right flank', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-canton-column-is-not-pulled-into-a-flank.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const east = model.groups['east#0']!.bounds!, flank = model.groups['side-right']!.bounds!;
  expect(flank.x - (east.x + east.width), 'the column stands clear of the flank').toBeGreaterThan(0);
});

// Architecture ticket 12: a bundle row stands off a canton frame edge, and a flank box with float residue is not a moved flank.
it('a bundle of parallel links turns clear of a canton frame edge', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-parallel-links-turn-clear-of-a-canton-frame-edge.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const gates = score(model).snapshot.gates;
  expect(gates['G6']!.violations).toEqual([]);
  expect(Object.values(gates).every(gate => gate.passed)).toBe(true);
});

it('bundle rows turn toward the near end when the far end enters a member frame', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-bundle-rows-turn-near-when-the-far-end-enters-a-frame.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(score(model).snapshot.gates['G6']!.violations).toEqual([]);
  expect(model.diagnostics.map(d => d.code)).not.toContain('BUNDLE_ROWS_ALONG_FRAME_EDGE');
});

// Pinned failures of architecture ticket 12 (causes C and D, not fixed): a change to either is noticed here and the ticket is updated.
it('pinned: a flank link around a neighbour runs along the core edge (ticket 12, cause C)', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-flank-link-around-a-neighbour-runs-along-the-core-edge.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(score(model).snapshot.gates['G6']!.violations.map(v => [v.code, ...v.elements])).toEqual([['segment-group-edge', 'link-6', 'core']]);
});

it('pinned: a flank link across a neighbour is removed beside a bundle (ticket 12, cause D)', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-flank-link-across-a-neighbour-enters-a-bundle-envelope.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.links.filter(link => link.removed === true).map(link => link.id)).toEqual(['link-6']);
});

it('a right flank beside a canton bundle lays out and passes every gate', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-right-flank-beside-a-bundle-into-a-canton.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.links.filter(link => link.removed === true)).toEqual([]);
  expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
});
