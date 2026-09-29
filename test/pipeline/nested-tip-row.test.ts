import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { allocateGapRuns, bands, bars, bundles, centre, flanks, layout, lanes, parse, rows } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import { stemReach } from '../../src/layout/bands.js';
import { stemCache, stemPlan } from '../../src/layout/sides-two.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const read = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** One run clearance: the band the rule keeps free of allocated rows around a nested tip row. */
const CLEARANCE = 11.5;
const FIXTURE = 'a-nested-tip-row-holds-no-allocated-row';

interface Row { link: string; y: number; x0: number; x1: number }
interface Tip { node: string; x: number; y: number; links: Set<string> }

/** Every allocated row (a horizontal run segment) of every gap, with the link that owns it. */
function allocatedRows(model: LayoutModel): Row[] {
  const found: Row[] = [];
  for (const run of allocateGapRuns(model)) {
    for (const { from, to } of run.segments) {
      if (Math.abs(from.y - to.y) < 1e-9 && Math.abs(from.x - to.x) > 1e-9) {
        found.push({ link: run.link, y: from.y, x0: Math.min(from.x, to.x), x1: Math.max(from.x, to.x) });
      }
    }
  }
  return found;
}

/** Every stem tip that lies deeper than the flat stem, with the links that leave its port. */
function nestedTips(model: LayoutModel): Tip[] {
  const cache = stemCache(), found: Tip[] = [];
  for (const [id, node] of Object.entries(model.nodes)) {
    for (const port of node.ports) {
      if (!port.anchor || (port.side !== 'top' && port.side !== 'bottom')) continue;
      const depth = stemPlan(model, port, cache).depth;
      if (depth <= stemReach(model, node) + 1e-9) continue;
      const key = portId(port.ref);
      const links = new Set(model.links
        .filter(link => link.attachments && [link.attachments.from, link.attachments.to].some(ref => ref.node === id && portId(ref) === key))
        .map(link => link.id));
      found.push({ node: id, x: port.anchor.x, y: port.anchor.y + (port.side === 'top' ? -depth : depth), links });
    }
  }
  return found;
}

it('keeps every allocated row one run clearance off every nested stem tip, and routes every link (ranked-groups ticket 31)', async () => {
  const model = bands(bundles(bars(centre(flanks(lanes(rows(await placed(read(FIXTURE)))))))));
  const tips = nestedTips(model);
  expect(tips.length).toBeGreaterThanOrEqual(2);
  const found = allocatedRows(model);
  expect(found.length).toBeGreaterThan(0);
  for (const tip of tips) {
    for (const row of found) {
      if (tip.links.has(row.link) || tip.x < row.x0 - CLEARANCE || tip.x > row.x1 + CLEARANCE) continue;
      expect(Math.abs(row.y - tip.y), `${row.link} row at ${row.y} against the tip of ${tip.node} at ${tip.y}`).toBeGreaterThanOrEqual(CLEARANCE - 1e-9);
    }
  }
  const routed = await layout(parse(read(FIXTURE)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(routed.removedLinks ?? []).toEqual([]);
}, 120000);
