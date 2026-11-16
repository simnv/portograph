import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, render, score } from '../../src/index.js';
import { alignLinkedGroupGrid } from '../../src/layout/bands.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
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

/**
 * Every pair of sibling frames that stand side by side (top-level frames, or children of one parent, whose y ranges
 * overlap) is a band gap apart, measured on the finished layout. Ticket 09 promised it; ticket 15 found label widening
 * spending it. Returns the pairs it checked, so a fixture can assert it had two frames in one tier.
 */
function expectBandGapBetweenSiblings(model: LayoutModel): number {
  const frames = model.frames!, gap = bandGap(model);
  let pairs = 0;
  for (const [i, frame] of frames.entries()) {
    for (const other of frames.slice(i + 1)) {
      if (frame.parent !== other.parent || frame.box.y >= bottom(other.box) || other.box.y >= bottom(frame.box)) continue;
      const [left, next] = frame.box.x <= other.box.x ? [frame, other] : [other, frame];
      expect(next.box.x - right(left.box), `${left.id} and ${next.id} stand a band gap apart`).toBeGreaterThanOrEqual(gap - 1e-6);
      pairs++;
    }
  }
  return pairs;
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
  expectBandGapBetweenSiblings(model);
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
    // Drawn: a path of at least one segment. A feed whose gateway stands straight under its edge is one vertical
    // segment (ticket 15 moves a frame by its frame gap and no longer by a double push, which lines `b` up with `x-gw2`).
    for (const link of between) expect(link.path?.segments.length, `${link.id} is drawn`).toBeGreaterThan(0);
  }, 60000);

  it('a title-wide cell pushes the frame after it: three locations keep a band gap between frame boxes', async () => {
    // Architecture-2 ticket 54: the zone cells are title-room wide at stage 5, so the flat chord hub -> c-core would enter `c` by its side edge and
    // is refused (`edge`); the course trial then takes link-4 round the outside (one turn) and stands `c` under the course, 134 px after `a`.
    // The claim here is the push, so the run takes no course.
    const model = await layout(parse(fixture('sibling-frames-keep-the-band-gap')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [] });
    expectColumns(model, false);
    // Three locations in one tier: every pair is a sibling pair, and the assertion above ran on all three.
    expect(expectBandGapBetweenSiblings(model)).toBe(3);
    // A frame is pushed once: the gap is spent down to the band gap and no further (a sweep measured on cells that
    // the cell-level push had displaced already moved the frame a second time, 184 px apart).
    const box = (id: string) => model.frames!.find(item => item.id === id)!.box;
    expect(box('c').x - right(box('a')), 'a and c stand no more than a band gap apart').toBeLessThanOrEqual(bandGap(model) + 1e-6);
  }, 60000);

  it('a frame title wider than its host is held by the stage-5 width, so 7f widens nothing and reports nothing (architecture-2 ticket 54)', async () => {
    // Before ticket 54, 7f widened the host for the title, a lane forbade it, and the layout reported GROUP_LABEL_GAP_INFEASIBLE.
    const yaml = fixture('an-own-frame-lane-stands-beside-a-neighbour-frame').replace('label: East }', 'label: East frame with a long title }');
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [] });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(model.diagnostics.map(diagnostic => diagnostic.code)).not.toContain('GROUP_LABEL_GAP_INFEASIBLE');
    const title = model.labels.find(label => label.role === 'group' && label.text === 'East frame with a long title')!;
    const frame = model.frames!.find(item => item.id === 'east')!.box;
    expect(title.bounds!.x).toBeGreaterThanOrEqual(frame.x - 1e-6);
    expect(right(title.bounds!)).toBeLessThanOrEqual(right(frame) + 1e-6);
    expect(title.crossedBy).toEqual([]);
  }, 60000);

  // The linked-group grid (ADR-0012) widens a cell to the extent it shares with the group it is linked to. It
  // reads group boxes and lane windows only, and a frame box is 20 px wider than its cells, so it must
  // refuse a widening that keeps the cells of two frames apart and makes their frame boxes touch. YAML
  // cannot force that pairing (the grid keeps a box within 30 % of its union), so the test sets the boxes
  // it needs on the built model: the gateway cell as wide as the zone cells of its frame, and the ISP
  // group as wide as the frame's cells and `extra` px more, then calls the grid.
  describe('linked-group grid beside frames', () => {
    const west = ['west#0', 'west-zone#1', 'west-zone#2'];
    /** `extra` px beyond the zone cells; a negative `extra` is the room the cells of `east` leave, less that many px. */
    const widened = async (extra: number) => {
      const model = structuredClone(await run('sibling-frames-pack-as-columns'));
      const zone = ['west-zone#1', 'west-zone#2'].map(id => model.groups[id]!.bounds!);
      const low = Math.min(...zone.map(box => box.x)), high = Math.max(...zone.map(right));
      const east = Math.min(...['east#0', 'east-zone#1', 'east-zone#2'].map(id => model.groups[id]!.bounds!.x));
      // The widened cell stands clear of the cells of `east`; only the frame boxes are asked to touch.
      if (extra < 0) extra = east - high + extra;
      expect(high + extra, 'cells stay apart').toBeLessThan(east);
      // The three cells of `west` share one extent already, so the grid has nothing to close inside the frame.
      for (const id of west) Object.assign(model.groups[id]!.bounds!, { x: low, width: high - low });
      Object.assign(model.groups.upstream!.bounds!, { x: low, width: high + extra - low });
      const before = west.map(id => ({ ...model.groups[id]!.bounds! }));
      const changed = alignLinkedGroupGrid(model);
      const [a, b] = ['west', 'east'].map(id => deriveFrames(model)!.find(frame => frame.id === id)!.box);
      return { model, changed, before, clear: !overlaps(a!, b!) };
    };
    it('refuses a widening that would make a frame box overlap another frame box', async () => {
      const { model, changed, before, clear } = await widened(-5);
      expect(changed).toBe(false);
      expect(west.map(id => model.groups[id]!.bounds)).toEqual(before);
      expect(clear).toBe(true);
    });
    it('still widens the cell when the frame boxes stay clear', async () => {
      const { model, changed, before, clear } = await widened(10);
      expect(changed).toBe(true);
      expect(model.groups['west#0']!.bounds!.width).toBeCloseTo(before[0]!.width + 10, 6);
      expect(clear).toBe(true);
    });
  });
});
