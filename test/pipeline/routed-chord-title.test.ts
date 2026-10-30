import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { groupLabelObstacles } from '../../src/layout/bands.js';
import { chordKind, crossingRect } from '../../src/layout/frame-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ranked-groups ticket 100 (Q108, docs/design/routed-chords.md, Section 6): a cross-frame chord crosses the title band of its own end beside
 * the title.
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const BESIDE = 'a-routed-chord-crosses-its-own-title-band-beside-the-title';
const NO_ROOM = 'a-routed-chord-leaves-no-room-for-the-title';
const refusals = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'ROUTED_CHORD_REFUSED')
  .map(item => `${item.owners?.map(owner => 'id' in owner ? owner.id : owner.kind).join(',')}:${item.message.replace(/^.*: /, '').replace('.', '')}`);
const gates = (model: LayoutModel): void => {
  for (const [id, gate] of Object.entries(score(model).snapshot.gates)) expect([id, gate.violations]).toEqual([id, []]);
};
const linkOf = (model: LayoutModel, from: string, to: string) => model.links.find(link => link.attachments!.from.node === from && link.attachments!.to.node === to)!;
const label = (model: LayoutModel, text: string) => model.labels.find(item => item.role === 'group' && item.text === text)!.bounds!;
/** The gap in x between the title and a crossing rectangle: negative where they overlap. `crossingRect` carries the 8 px margin, so 0 or more is 8 px clear. */
const gap = (title: { x: number; width: number }, rect: { x: number; width: number }): number =>
  Math.max(rect.x - (title.x + title.width), title.x - (rect.x + rect.width));

// A provider row of three under one router: the chord to the third provider is slanted, so its bounding box covers the title's x while its
// crossing of the band does not.
const SLANTED = `portograph: 2
profile: network
groups:
  upstream: { tier: 1, label: Upstream }
  providers: { tier: 2, label: Providers }
  lower: { tier: 3, label: Lower }
nodes:
  upstream-core: { group: upstream, class: router, label: Upstream core router }
  upstream-router: { group: upstream, class: router, label: Upstream router }
  provider-1: { group: providers, class: provider, label: Provider 1 }
  provider-2: { group: providers, class: provider, label: Provider 2 }
  provider-3: { group: providers, class: provider, label: Provider 3 }
  lower-router: { group: lower, class: router, label: Lower router }
links:
  - [upstream-core, upstream-router]
  - [upstream-router, provider-1, { class: dashed }]
  - [upstream-router, provider-3, { class: dashed }]
  - [provider-1, lower-router, { class: dashed }]
  - [provider-2, lower-router, { class: dashed }]
  - [provider-3, lower-router, { class: dashed }]
`;
// A canton whose title stands on the top edge (the sub-tier `clients` links down, the tie keeps the top). `isp` links to `gw` across the canton band.
const CANTON = `portograph: 2
profile: network
groups:
  west: { label: West }
  upstream: { tier: 0, label: Upstream }
  site: { tier: 1, canton: west, label: Site }
  clients: { tier: 2, canton: west, label: Clients }
  below: { tier: 3, label: Below }
nodes:
  isp: { group: upstream, class: provider, label: ISP }
  gw: { group: site, class: router, label: Gateway }
  srv: { group: site, class: server, label: Server }
  srv2: { group: site, class: server, label: Second server }
  cl: { group: clients, class: router, label: Client }
  lo: { group: below, class: provider, label: Lower ISP }
links:
  - [gw, srv]
  - [gw, srv2]
  - [srv, cl]
  - [isp, gw, { class: dashed }]
  - [cl, lo, { class: dashed }]
`;

describe('a cross-frame chord crosses the title band of its own end', () => {
  it('draws both chords through the title band of the provider row, and the title stands 8 px clear of each crossing', async () => {
    const model = await run(fixture(BESIDE));
    const chords = ['provider-1', 'provider-2'].map(id => linkOf(model, 'upstream-router', id));
    for (const link of chords) {
      expect(chordKind(model, link)).toBe('cross');
      expect(link.technique, link.id).toBe('straight');
      expect(link.path!.segments).toHaveLength(1);
    }
    expect(refusals(model)).toEqual([]);
    expect(model.diagnostics.some(item => item.code === 'ROUTED_CHORD_TITLE')).toBe(false);
    const band = model.labelBands.find(item => item.group === 'providers')!;
    expect(band.side).toBe('top');
    const title = label(model, 'Providers');
    for (const link of chords) {
      const crossing = crossingRect(link.path!.segments[0]!, band.bounds.y, band.bounds.y + band.bounds.height, 0)!;
      expect(crossing, link.id).toBeDefined();
      expect(gap(title, crossing), link.id).toBeGreaterThanOrEqual(-1e-6);
    }
    // The title stands between the two crossings.
    const [left, right] = chords.map(link => link.path!.segments[0]!.to.x).sort((a, b) => a - b);
    expect(title.x).toBeGreaterThan(left!);
    expect(title.x + title.width).toBeLessThan(right!);
    expect(model.removedLinks ?? []).toEqual([]);
    gates(model);
  }, 60000);

  it('reserves the crossing rectangle of the chord for the label planner, not the box of the whole run', async () => {
    const model = await run(SLANTED);
    const slanted = linkOf(model, 'upstream-router', 'provider-3'), chord = slanted.path!.segments[0]!;
    expect(slanted.technique).toBe('straight');
    expect(Math.abs(chord.from.x - chord.to.x)).toBeGreaterThan(20);
    const band = model.labelBands.find(item => item.group === 'providers')!;
    const mine = groupLabelObstacles(model).filter(item => item.id.startsWith(`${slanted.id}:`));
    expect(mine.map(item => item.id)).toEqual([`${slanted.id}:chord:providers`]);
    const crossing = mine[0]!.bounds;
    // The rectangle stands inside the band's y-range (grown by the half stroke), not over the whole run from port to port.
    expect(crossing.y).toBeGreaterThanOrEqual(band.bounds.y - 1);
    expect(crossing.y + crossing.height).toBeLessThanOrEqual(band.bounds.y + band.bounds.height + 1);
    // The bounding box of the whole run would cover the title's x; the crossing does not.
    const title = label(model, 'Providers');
    const box = { x: Math.min(chord.from.x, chord.to.x), width: Math.abs(chord.to.x - chord.from.x) };
    expect(gap(title, box)).toBeLessThan(0);
    expect(gap(title, crossing)).toBeGreaterThanOrEqual(-1e-6);
    expect(model.diagnostics.some(item => item.code === 'ROUTED_CHORD_TITLE')).toBe(false);
    gates(model);
  }, 60000);

  it('reads the crossing again from the chord as it stands after a move', async () => {
    const model = structuredClone(await run(fixture(BESIDE)));
    const link = linkOf(model, 'upstream-router', 'provider-1'), id = `${link.id}:chord:providers`;
    const before = groupLabelObstacles(model).find(item => item.id === id)!.bounds;
    for (const point of [link.path!.segments[0]!.from, link.path!.segments[0]!.to]) point.x += 30;
    const after = groupLabelObstacles(model).find(item => item.id === id)!.bounds;
    expect(after.x).toBeCloseTo(before.x + 30, 6);
    expect(after.width).toBeCloseTo(before.width, 6);
  }, 60000);

  it('crosses the title band of a canton beside the canton title', async () => {
    const model = await run(CANTON);
    const chord = linkOf(model, 'isp', 'gw');
    expect(chordKind(model, chord)).toBe('cross');
    expect(chord.technique).toBe('straight');
    const band = model.labelBands.find(item => item.group === 'west')!;
    expect(band.side).toBe('top');
    const crossing = crossingRect(chord.path!.segments[0]!, band.bounds.y, band.bounds.y + band.bounds.height, 0)!;
    expect(crossing).toBeDefined();
    expect(groupLabelObstacles(model).some(item => item.id === `${chord.id}:chord:west`)).toBe(true);
    expect(gap(label(model, 'West'), crossing)).toBeGreaterThanOrEqual(-1e-6);
    gates(model);
  }, 60000);

  it('keeps the orthogonal route where the title has no room beside the crossing (title)', async () => {
    const model = await run(fixture(NO_ROOM));
    const link = linkOf(model, 'upstream-router', 'provider-1');
    expect(chordKind(model, link)).toBe('cross');
    expect(link.technique).toBe('orthogonal');
    expect(refusals(model)).toEqual([`${link.id}:title`]);
    expect(model.removedLinks ?? []).toEqual([]);
    gates(model);
    // The same input with a short title holds the chord: the refusal is the room, not the strip.
    const short = await run(fixture(NO_ROOM).replace('Providers of the upstream transit service', 'P'));
    expect(linkOf(short, 'upstream-router', 'provider-1').technique).toBe('straight');
    expect(refusals(short)).toEqual([]);
  }, 60000);

  it('widens the crossing rectangle by the slant of the chord: the full layout of a canton band passes G3 (label-collision)', async () => {
    // Measured: with the widening left out (`slant = 1`) this layout fails G3 `label-collision` on a slanted chord.
    const model = await run(fixture('a-canton-band-holds-the-rows-off'));
    expect(model.links.some(link => chordKind(model, link) === 'cross' && link.path!.segments[0]!.from.x !== link.path!.segments[0]!.to.x)).toBe(true);
    gates(model);
  }, 60000);
});
