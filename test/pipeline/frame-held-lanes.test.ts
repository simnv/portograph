import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import { bands } from '../../src/layout/bands.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { rows } from '../../src/layout/rows.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { createAttempt } from '../layout/phase-two-fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
/** Stages 4 to 7 of the pipeline: everything placement decides before the router runs. */
async function placement(name: string): Promise<LayoutModel> {
  const model = sizeNodes(sidesOne(resolve(parse(fixture(name)))));
  await skeleton(model, { createAttempt });
  return [rows, lanes, flanks, centre, bars, bundles, bands].reduce((current, stage) => stage(current), sidesTwo(model));
}
const overlap = (a: { x: number; width: number }, b: { x: number; width: number }): boolean =>
  a.x < b.x + b.width - 1e-6 && a.x + a.width > b.x + 1e-6;

describe('a frame holds the lanes of the links that end in it', () => {
  it('sibling frames stand apart and no foreign lane stands inside a frame box', async () => {
    const model = await placement('a-frame-holds-its-lanes-beside-its-siblings');
    const frames = model.frames!;
    expect(frames.map(frame => frame.id).sort()).toEqual(['east', 'mid', 'west']);
    for (const a of frames) for (const b of frames) if (a.id < b.id) expect(overlap(a.box, b.box), `${a.id} overlaps ${b.id}`).toBe(false);
    const nodesOf = (id: string): string[] => frames.find(frame => frame.id === id)!.cells.flatMap(cell => model.groups[cell]!.nodes);
    let foreign = 0;
    for (const lane of model.lanes) {
      const link = model.links.find(item => item.id === (lane.owner as { id: string }).id)!;
      for (const frame of frames) {
        const inside = nodesOf(frame.id);
        const ends = [link.attachments!.from.node, link.attachments!.to.node];
        if (ends.some(node => inside.includes(node))) {
          // A link that ends in a frame keeps its lane inside the frame box, which grew to hold it.
          if (ends.every(node => inside.includes(node))) {
            expect(lane.bounds.x, `${lane.id} leaves frame ${frame.id}`).toBeGreaterThanOrEqual(frame.box.x - 1e-6);
            expect(lane.bounds.x + lane.bounds.width, `${lane.id} leaves frame ${frame.id}`).toBeLessThanOrEqual(frame.box.x + frame.box.width + 1e-6);
          }
          continue;
        }
        foreign++;
        expect(overlap(lane.bounds, frame.box), `${lane.id} stands inside frame ${frame.id}`).toBe(false);
      }
    }
    // Four foreign links, three crossed sub-tiers each, against the three frames.
    expect(foreign).toBeGreaterThanOrEqual(4 * 3 * 2);
  }, 60000);
});
