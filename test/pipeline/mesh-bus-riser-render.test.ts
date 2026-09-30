import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, render, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { validateRoutedPaths } from '../../src/route/validate.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
// The side round is off on the riser fixture: it frees link-6 as a chord (ticket 117), and these tests read the riser.
const RISER = fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...(yaml === RISER ? { testMaxReruns: 0 } : {}) });
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;
const thaw = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

const JOINED = [
  'a-mesh-over-two-rows-joins-its-bars-with-one-riser',
  'a-riser-joins-two-bars-in-one-gap',
  'a-riser-between-cantons-crosses-no-canton-edge',
] as const;

describe('the riser publishes paths, renders and exports (ticket 97)', () => {
  it('publishes each cross path as stub, bar run, riser, bar run, stub, and draws no cross link line', async () => {
    const model = await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser'));
    const [upper, lower] = model.meshBuses!;
    expect(upper!.cross).toHaveLength(15);
    for (const id of upper!.cross!) {
      const link = model.links.find(item => item.id === id)!;
      expect(link.technique).toBe('mesh-bus');
      const segments = link.path!.segments;
      expect(segments.length).toBeGreaterThanOrEqual(3);
      expect(segments.length).toBeLessThanOrEqual(5);
      // Orthogonal, and joined end to end.
      for (const [index, segment] of segments.entries()) {
        expect(segment.from.x === segment.to.x || segment.from.y === segment.to.y).toBe(true);
        if (index > 0) expect(segment.from).toEqual(segments[index - 1]!.to);
      }
      // The path crosses from one bar to the other at the riser x.
      expect(segments.some(segment => segment.from.x === upper!.riser!.x && segment.to.x === upper!.riser!.x && segment.from.y !== segment.to.y)).toBe(true);
    }
    expect(model.links.filter(link => link.layer === 'overlay' && link.technique !== 'mesh-bus')).toHaveLength(0);
    const svg = render(model);
    for (const id of upper!.cross!) expect(svg).not.toContain(`data-id="${id}"`);
    expect(count(svg, /<g class="mesh-bus/g)).toBe(2);
    expect(count(svg, /class="[^"]*riser[^"]*"/g)).toBe(1);
    expect(count(svg, /data-joined="/g)).toBe(2);
    expect(svg).toContain('data-joined="mesh-bus-2"');
    expect(count(svg, /sync mesh \(8 nodes\)<\/tspan>/g)).toBe(1);
    expect(svg).toContain('cross links: ');
    expect(lower!.label).toBeDefined();
    expect(gates(model)).toEqual([]);
    const counters = score(model).snapshot.counters;
    expect(counters.meshBusRisers).toBe(1);
    expect(counters.meshBuses).toBe(2);
  }, 60000);

  it('keeps two buses, two labels and 15 plain cross links when a label differs', async () => {
    const model = await run(fixture('a-cross-link-with-another-label-keeps-two-buses'));
    const svg = render(model);
    expect(count(svg, /<g class="mesh-bus/g)).toBe(2);
    expect(count(svg, /class="[^"]*riser[^"]*"/g)).toBe(0);
    expect(count(svg, /data-joined="/g)).toBe(0);
    expect(model.labels.filter(label => label.role === 'mesh-bus')).toHaveLength(2);
    expect(model.links.filter(link => link.layer === 'overlay' && link.technique === 'overlay')).toHaveLength(15);
    expect('meshBusRisers' in score(model).snapshot.counters).toBe(false);
  }, 60000);

  it('hides both buses and the riser with the class', async () => {
    const model = thaw(await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser')));
    model.document.overlays = { sync: 'hidden' };
    const svg = render(model);
    expect(count(svg, /<g class="mesh-bus/g)).toBe(0);
    expect(count(svg, /riser/g)).toBe(0);
    // The same layout with the class shown draws the riser, so the hidden count above is the class hiding it.
    model.document.overlays = {};
    expect(count(render(model), /class="[^"]*riser[^"]*"/g)).toBe(1);
  }, 60000);

  it('names the authored label of every cross link in the upper bus tooltip when all the links share it', async () => {
    const yaml = fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser').replace(/class: sync \}/g, 'class: sync, label: Sync }');
    const model = await run(yaml);
    const upper = model.meshBuses![0]!;
    expect(upper.cross).toHaveLength(15);
    const svg = render(model);
    for (const id of upper.cross!) expect(svg).toContain(`${id}: Sync`);
  }, 60000);

  it('refuses a stale riser end', async () => {
    const model = thaw(await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser')));
    model.meshBuses![0]!.riser!.from!.x += 3;
    expect(() => validateRoutedPaths(model)).toThrow(/riser/);
  }, 60000);

  it('restores a joined layout as a fixed point', async () => {
    const model = await run(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser'));
    expect(JSON.stringify(restoreLayoutModel(JSON.stringify(model)))).toBe(JSON.stringify(model));
  }, 60000);

  for (const name of [...JOINED, 'a-cross-link-with-another-label-keeps-two-buses'] as const) {
    it(`snapshots the SVG and the draw.io export of ${name}`, async () => {
      const model = await run(fixture(name));
      expect(render(model)).toMatchSnapshot('svg');
      const xml = drawio(model);
      expect(xml).toMatchSnapshot('drawio');
      const joined = model.meshBuses!.some(bus => bus.riser !== undefined);
      expect(count(xml, /id="pg-busRiser~/g)).toBe(joined ? 1 : 0);
      for (const bus of model.meshBuses!) expect(count(xml, new RegExp(`id="pg-busStub~${bus.id}~`, 'g'))).toBe(bus.stubs!.length);
      for (const bus of model.meshBuses!.filter(item => item.cross !== undefined)) for (const id of bus.cross!) expect(xml).not.toContain(`id="pg-link~${id}"`);
    }, 60000);
  }
});
