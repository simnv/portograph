import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { drawio, render } from '../../src/index.js';
import { bands } from '../../src/layout/bands.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { linkLabels } from '../../src/layout/link-labels.js';
import { rows } from '../../src/layout/rows.js';
import { groupShapes } from '../../src/render/frame-order.js';
import { route } from '../../src/route/index.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

async function pipeline(yaml: string): Promise<LayoutModel> {
  const placedModel = bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
  return linkLabels(await route(placedModel, { createAttempt: createAvoidAttempt }));
}

const FLANK = 'a-flank-frame-stands-in-front-of-the-frame-it-flanks';

describe('group draw order (architecture 20)', () => {
  it('puts the flank after the ranked frame it overlaps', async () => {
    const model = await pipeline(fixture(FLANK));
    const main = model.frames!.find(frame => frame.label === 'Main')!;
    const side = model.groups['side']!;
    // The fixture really overlaps: that is what the order is about.
    expect(side.bounds!.x).toBeLessThan(main.box.x + main.box.width);
    expect(side.bounds!.y + side.bounds!.height).toBeGreaterThan(main.box.y);
    const order = groupShapes(model).map(shape => shape.id);
    expect(order.indexOf('side')).toBeGreaterThan(order.indexOf(main.id));
  });

  it('draws the flank after the ranked frame in the SVG', async () => {
    const model = await pipeline(fixture(FLANK));
    const main = model.frames!.find(frame => frame.label === 'Main')!;
    const ids = [...render(model).matchAll(/<g class="group[^"]*" data-id="([^"]+)"/g)].map(match => match[1]!);
    expect(ids.indexOf('side')).toBeGreaterThan(ids.indexOf(main.id));
  });

  it('emits the flank cell after the ranked frame cell in draw.io', async () => {
    const model = await pipeline(fixture(FLANK));
    const main = model.frames!.find(frame => frame.label === 'Main')!;
    const xml = drawio(model, { theme: 'light' });
    const at = (cell: string): number => xml.indexOf(`id="pg-group${'~'}${cell}"`);
    expect(at(main.id)).toBeGreaterThan(-1);
    expect(at('side')).toBeGreaterThan(at(main.id));
    // The flank's node hangs under the flank, so it goes in front with it.
    expect(xml.indexOf(`id="pg-node${'~'}edge"`)).toBeGreaterThan(at('side'));
  });

  it('keeps the start order where no boxes overlap, and a frame after its holder', async () => {
    for (const name of ['sibling-frames-pack-as-columns', 'a-child-frame-stands-inside-its-parent']) {
      const model = await pipeline(fixture(name));
      const frames = model.frames ?? [];
      const depth = (frame: { parent?: string }): number => frame.parent === undefined ? 0
        : 1 + depth(frames.find(item => item.id === frame.parent)!);
      const plain = Object.values(model.groups).filter(group => group.frame === undefined).map(group => group.id);
      const expected = [...plain, ...[...frames].sort((a, b) => depth(a) - depth(b)).map(frame => frame.id)];
      const shapes = groupShapes(model);
      const lies = (a: typeof shapes[number], b: typeof shapes[number]): boolean => a.parent !== b.id && b.parent !== a.id
        && Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) - Math.max(a.bounds.x, b.bounds.x) > 0.5
        && Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) - Math.max(a.bounds.y, b.bounds.y) > 0.5;
      // Siblings that share no area: the start order stands.
      const free = shapes.filter(a => a.parent === undefined && shapes.every(b => b === a || !lies(a, b)));
      expect(free.map(shape => shape.id), name).toEqual(expected.filter(id => free.some(shape => shape.id === id)));
      for (const shape of shapes) if (shape.parent !== undefined) {
        expect(shapes.findIndex(item => item.id === shape.parent), name).toBeLessThan(shapes.indexOf(shape));
      }
    }
  });
});
