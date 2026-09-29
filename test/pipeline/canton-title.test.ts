import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, render, score } from '../../src/index.js';
import { drawio } from '../../src/render/drawio.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../../src/theme/geometry.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (text: string) => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const bottom = (box: Rect): number => box.y + box.height;
const frameOf = (model: LayoutModel, id: string) => model.frames!.find(frame => frame.id === id)!;
const bandOf = (model: LayoutModel, id: string) => model.labelBands.find(band => band.group === id)!;
const titleOf = (model: LayoutModel, id: string) => model.labels.find(label => label.role === 'group' && label.owner.kind === 'group' && label.owner.id === id)!;
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < bottom(b) && b.y < bottom(a);
const tierBand = (model: LayoutModel, tier: number) => model.tierBands.find(band => band.tier === tier)!;
const clean = (model: LayoutModel): void => {
  expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
  expect(model.diagnostics.map(item => item.code)).not.toContain('FRAME_TITLE_UNHOSTED');
  const report = score(model);
  expect(report.snapshot.gates.G9.violations).toEqual([]);
  for (const [id, gate] of Object.entries(report.snapshot.gates)) if (gate.severity !== 'warning') expect(gate.passed, id).toBe(true);
};

describe('canton title band (canton-groups ticket 3)', () => {
  it('a canton fed from above holds its title at the bottom and pushes the tier below (fixture 7)', async () => {
    const model = await run(fixture('a-canton-with-a-tier-below'));
    clean(model);
    const west = frameOf(model, 'west'), band = bandOf(model, 'west'), title = titleOf(model, 'west');
    // Held by the sub-tier: no host cell, and no frame title of a member is keyed by the canton.
    expect(band.host).toBeUndefined();
    expect(band.side).toBe('bottom');
    // The frame holds the band on its bottom edge and the members above it.
    expect(bottom(west.box)).toBeCloseTo(bottom(band.bounds), 6);
    expect(band.bounds.x).toBeCloseTo(west.box.x, 6);
    expect(band.bounds.width).toBeCloseTo(west.box.width, 6);
    for (const member of ['site', 'clients']) expect(bottom(frameOf(model, member).box) + 20).toBeLessThanOrEqual(band.bounds.y + 1e-6);
    // The title stands in the band.
    expect(title.bounds!.y).toBeGreaterThanOrEqual(band.bounds.y);
    expect(bottom(title.bounds!)).toBeLessThanOrEqual(bottom(band.bounds));
    // The gap under the last tier of the canton holds 20 + band + 20, more than the band gap, so the tier below moved.
    const last = tierBand(model, 3), below = tierBand(model, 4);
    const gap = below.bounds!.y - bottom(last.bounds!), need = 20 + band.bounds.height + 20;
    expect(need).toBeGreaterThan(bandGap(model));
    expect(gap).toBeCloseTo(need, 6);
    expect(below.bounds!.y).toBeGreaterThanOrEqual(bottom(west.box) + 20 - 1e-6);
    expect(gap - bandGap(model)).toBeCloseTo(need - bandGap(model), 6);
  }, 60000);

  it('a canton with no feed from above keeps its title at the top and the tier above gives way (fixture 1, top edge)', async () => {
    const model = await run(fixture('a-canton-title-on-the-top-edge'));
    clean(model);
    const west = frameOf(model, 'west'), band = bandOf(model, 'west'), site = frameOf(model, 'site');
    expect(band.host).toBeUndefined();
    expect(band.side).toBe('top');
    expect(west.box.y).toBeCloseTo(band.bounds.y, 6);
    expect(site.box.y - 20).toBeGreaterThanOrEqual(bottom(band.bounds) - 1e-6);
    const upper = tierBand(model, 0), first = tierBand(model, 1);
    const gap = first.bounds!.y - bottom(upper.bounds!), need = 20 + band.bounds.height + 20;
    expect(gap).toBeCloseTo(need, 6);
    expect(west.box.y).toBeGreaterThanOrEqual(bottom(upper.bounds!) + 20 - 1e-6);
  }, 60000);

  it('a member title and the canton title on one edge do not collide', async () => {
    const model = await run(fixture('a-canton-title-on-the-top-edge'));
    const canton = bandOf(model, 'west'), member = bandOf(model, 'site');
    // `site` holds its own band in its own cell on the same edge (the top).
    expect(member.side).toBe('top');
    expect(member.host).toBe('site#0');
    expect(overlap(canton.bounds, member.bounds)).toBe(false);
    expect(overlap(titleOf(model, 'west').bounds!, titleOf(model, 'site#0').bounds!)).toBe(false);
    expect(bottom(canton.bounds) + 20).toBeLessThanOrEqual(member.bounds.y + 1e-6);
  }, 60000);

  it('the title is drawn in the SVG and the draw.io export at the band', async () => {
    for (const name of ['a-canton-with-a-tier-below', 'a-canton-title-on-the-top-edge']) {
      const model = await run(fixture(name));
      const title = titleOf(model, 'west'), band = bandOf(model, 'west');
      const svg = render(model);
      expect(svg).toMatch(/<text class="group-label[^"]*" data-owner="west"[^>]*><tspan [^>]*>West<\/tspan>/);
      // The label's line is centred in its box, `y` is its baseline: it lies inside the band.
      const at = Number(/data-owner="west"[^>]*><tspan x="([^"]+)" y="([^"]+)">West/.exec(svg)![2]);
      expect(at).toBeGreaterThan(band.bounds.y);
      expect(at).toBeLessThanOrEqual(bottom(band.bounds) + title.bounds!.height);
      const xml = drawio(model);
      // The band spans the canton edge to edge and holds the centred title, so it is a swimlane head on that edge.
      expect(xml).toMatch(/swimlane[^"]*startSize=22/);
      expect(xml).toContain('West');
      if (band.side === 'bottom') expect(xml).toContain('flipV=1');
    }
  }, 60000);

  it('a canton on the first tier with a top title lies inside the canvas', async () => {
    const text = `portograph: 2
groups:
  west: { label: West }
  site: { tier: 0, canton: west, label: Site }
  clients: { tier: 1, canton: west, label: Clients }
nodes:
  gw: { group: site, class: router, label: Gateway }
  cl: { group: clients, class: server, label: Client }
links:
  - { from: gw, to: cl, class: flow }
`;
    const model = await run(text);
    clean(model);
    const west = frameOf(model, 'west'), canvas = model.canvas!;
    expect(bandOf(model, 'west').side).toBe('top');
    expect(canvas.y).toBeLessThanOrEqual(west.box.y + 1e-6);
    expect(canvas.x).toBeLessThanOrEqual(west.box.x + 1e-6);
  }, 60000);

  it('a title wider than its members grows the widest cell on the title edge and the frame follows', async () => {
    const base = await run(fixture('a-canton-with-a-tier-below'));
    const text = fixture('a-canton-with-a-tier-below').replace('label: West', 'label: The Western Regional Operations Canton');
    const model = await run(text);
    clean(model);
    const band = bandOf(model, 'west'), title = titleOf(model, 'west'), west = frameOf(model, 'west');
    expect(title.bounds!.x).toBeGreaterThanOrEqual(band.bounds.x - 1e-6);
    expect(title.bounds!.x + title.bounds!.width).toBeLessThanOrEqual(band.bounds.x + band.bounds.width + 1e-6);
    // The cell on the title edge (the last sub-tier, `clients#0`) grew, and the frame follows the cell.
    expect(model.groups['clients#0']!.bounds!.width).toBeGreaterThan(base.groups['clients#0']!.bounds!.width + 1);
    expect(west.box.width).toBeGreaterThan(frameOf(base, 'west').box.width + 1);
    // Gates that `clean` skips as warnings are asserted whole: G9 has no violation.
    const report = score(model);
    expect(report.snapshot.gates.G9.violations).toEqual([]);
    expect(report.snapshot.gates.G9.passed).toBe(true);
    // Members stay inside the canton, and no group of tier 3 stands nearer than the 40 px beside gap (a band gap plus slack).
    for (const member of ['site', 'clients']) {
      const box = frameOf(model, member).box;
      expect(box.x).toBeGreaterThanOrEqual(west.box.x + 20 - 1e-6);
      expect(box.x + box.width).toBeLessThanOrEqual(west.box.x + west.box.width - 20 + 1e-6);
    }
  }, 60000);

  it('the row plan keeps its rows off the canton band and its margin (review B1)', async () => {
    const model = await run(fixture('a-canton-band-holds-the-rows-off'));
    clean(model);
    expect(model.removedLinks ?? []).toEqual([]);
    const west = frameOf(model, 'west'), band = bandOf(model, 'west');
    expect(band.side).toBe('bottom');
    const edge = tierBand(model, 2);
    let rows = 0;
    // The two links between `site` and `edge` are the last two of the document.
    for (const link of model.links.filter(item => item.sourceIndex >= 5)) {
      for (const seg of link.path?.segments ?? []) {
        if (seg.from.y !== seg.to.y || seg.from.x === seg.to.x) continue;
        // A horizontal run inside the gap between the canton and `edge`.
        if (seg.from.y <= bottom(west.box) || seg.from.y >= edge.bounds!.y) continue;
        rows++;
        expect(seg.from.y).toBeGreaterThanOrEqual(bottom(west.box) + GROUP_EDGE_LINK_CLEARANCE + linkStrokeWidth(link) / 2 - 1e-6);
      }
    }
    // Two links cross orthogonally, so at least two rows are planned in the gap.
    expect(rows).toBeGreaterThanOrEqual(2);
    for (const gate of Object.values(score(model).snapshot.gates)) expect(gate.violations.filter(item => item.code === 'segment-group-edge')).toEqual([]);
  }, 60000);

  it('a canton title layout is idempotent', async () => {
    for (const name of ['a-canton-band-holds-the-rows-off', 'a-canton-with-a-tier-below', 'a-canton-title-on-the-top-edge']) {
      const strip = (model: LayoutModel): unknown => JSON.parse(JSON.stringify(model, (key, value) => key === 'durationMs' ? undefined : value));
      expect(strip(await run(fixture(name)))).toEqual(strip(await run(fixture(name))));
    }
  }, 60000);
});
