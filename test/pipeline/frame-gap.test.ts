import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { rows } from '../../src/layout/rows.js';
import { lanes } from '../../src/layout/lanes.js';
import { flanks } from '../../src/layout/flanks.js';
import { centre } from '../../src/layout/centre.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { bands } from '../../src/layout/bands.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** The smallest x gap between two top-level frames, as the cells stand now. */
function narrowestGap(model: LayoutModel): number {
  const tops = (deriveFrames(model) ?? []).filter(frame => frame.parent === undefined);
  let least = Infinity;
  for (const [i, frame] of tops.entries()) {
    for (const other of tops.slice(i + 1)) {
      const [left, next] = frame.box.x <= other.box.x ? [frame, other] : [other, frame];
      least = Math.min(least, next.box.x - left.box.x - left.box.width);
    }
  }
  return least;
}

describe('the gap between sibling frames, stage by stage', () => {
  // The skeleton and sides-two packings are ELK's, and rows repairs them (ticket 12); from centring on, the slack is
  // spent and every rule that moves or widens a cell owes the band gap. Ticket 15 found stage 7f's label widening
  // (then `reserveInitialSpace`, through `growthPlan`; `topUpBandClearance` since ticket 57) keeping a band gap between cells and not between frames.
  it('never drops below the band gap from centring to the last stage before routing', async () => {
    const resolved = resolve(parse(fixture('sibling-frames-keep-the-band-gap')));
    sidesOne(resolved); sizeNodes(resolved);
    await skeleton(resolved, { createAttempt });
    let model = rows(sidesTwo(resolved));
    expect(narrowestGap(model), 'rows leaves the columns their slack').toBeGreaterThanOrEqual(bandGap(model) + 2 * 20 - 1e-6);
    model = flanks(lanes(model));
    const stages: [string, (model: LayoutModel) => LayoutModel][] = [['centre', centre], ['bars', bars], ['bundles', bundles], ['bands', bands]];
    for (const [name, stage] of stages) {
      model = stage(model);
      expect(narrowestGap(model), `after ${name}`).toBeGreaterThanOrEqual(bandGap(model) - 1e-6);
    }
  }, 60000);
});
