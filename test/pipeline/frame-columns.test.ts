import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, render, score } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const overlaps = (a: Rect, b: Rect): boolean => a.x < right(b) - 1e-6 && b.x < right(a) - 1e-6 && a.y < bottom(b) - 1e-6 && b.y < bottom(a) - 1e-6;
const holdsX = (outer: Rect, inner: Rect): boolean => outer.x <= inner.x + 1e-6 && right(outer) >= right(inner) - 1e-6;

/** The x extent of a cell as its frame reads it: the bodies of its nodes and 20 px each side, or the cell box when wider. */
function reach(model: LayoutModel, cell: string): Rect {
  const box = model.groups[cell]!.bounds!, bodies = model.groups[cell]!.nodes.map(id => model.nodes[id]!.bounds!);
  const x = Math.min(box.x, ...bodies.map(body => body.x - 20)), end = Math.max(right(box), ...bodies.map(body => right(body) + 20));
  return { x, y: box.y, width: end - x, height: box.height };
}

/** Assertions every fixture of this ticket shares: disjoint frames, cells and children inside their frames, a sheet. */
function expectColumns(model: LayoutModel, converges = true): void {
  expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
  // A column is a wall, so a lower cell whose port stands beyond the column of the cell above it leaves that
  // alignment to routing, as it does at baseline; the fixture that has no such port converges.
  if (converges) expect(model.diagnostics.map(diagnostic => diagnostic.code)).not.toContain('PLACEMENT_NON_CONVERGENCE');
  const frames = model.frames!;
  for (const [i, frame] of frames.entries()) {
    for (const other of frames.slice(i + 1)) {
      // A child lies inside its parent; every other pair of frames is disjoint.
      if (frame.parent === other.id || other.parent === frame.id) continue;
      expect(overlaps(frame.box, other.box), `${frame.id} and ${other.id} overlap`).toBe(false);
    }
    for (const cell of frame.cells) expect(holdsX(frame.box, reach(model, cell)), `${cell} inside ${frame.id}`).toBe(true);
    expect(frame.box.x, `${frame.id} on the sheet`).toBeGreaterThanOrEqual(0);
    const parent = frames.find(item => item.id === frame.parent);
    if (parent) expect(holdsX(parent.box, frame.box), `${frame.id} inside ${parent.id}`).toBe(true);
  }
  const report = score(model);
  expect(report.snapshot.gates.G9.violations).toEqual([]);
  expect(report.snapshot.gates.G9.passed).toBe(true);
  expect(() => render(model)).not.toThrow();
  expect(render(model)).toContain('<svg');
}

describe('frame columns', () => {
  it('sibling frames of one tier pack as disjoint columns, children inside their parents', async () => {
    const model = await run('sibling-frames-pack-as-columns');
    expectColumns(model);
    const frame = (id: string) => model.frames!.find(item => item.id === id)!;
    expect(overlaps(frame('west').box, frame('east').box)).toBe(false);
    expect(holdsX(frame('west').box, frame('west-zone').box)).toBe(true);
    expect(holdsX(frame('east').box, frame('east-zone').box)).toBe(true);
    // Left to right, one band gap or more apart.
    expect(right(frame('west').box)).toBeLessThanOrEqual(frame('east').box.x - 60 + 1e-6);
    for (const link of model.links) expect(link.path, link.id).toBeDefined();
  }, 60000);

  it('locations of two tiers stack as columns over columns, every routed link drawn', async () => {
    const model = await run('locations-stack-as-columns-over-columns');
    expectColumns(model, false);
    const top = ['a', 'b', 'c'].map(id => model.frames!.find(item => item.id === id)!);
    const low = ['x', 'y'].map(id => model.frames!.find(item => item.id === id)!);
    // The frames of one tier stand side by side: their x ranges are disjoint.
    for (const tier of [top, low]) {
      for (const [i, frame] of tier.entries()) {
        for (const other of tier.slice(i + 1)) expect(frame.box.x < right(other.box) && other.box.x < right(frame.box), `${frame.id} and ${other.id} share an x range`).toBe(false);
      }
    }
    for (const link of model.links) expect(link.path, link.id).toBeDefined();
    const between = model.links.filter(link => ['a-edge', 'b-edge', 'c-edge'].includes(link.attachments!.from.node) && /-gw2?$/.test(link.attachments!.to.node));
    expect(between).toHaveLength(3);
    for (const link of between) expect(link.path?.segments.length, `${link.id} is drawn`).toBeGreaterThan(1);
  }, 60000);
});
