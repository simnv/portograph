import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, PathSegment, Rect } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { nudgingDistance, routedStroke } from '../../src/layout/bands.js';
import { GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { score } from '../../src/score/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 56 (the review finding of ticket 54, not reproducible): a jogged drop under a group title. The tier-gap plan
 * keeps each jog one group-edge margin off every group box (the O5 obstacle of each box, `gap-plan.ts`), so the two verticals of a
 * jogged drop cross a title band only at the x of a port leg, which the title already avoids (`legRects`). A turn of a tier-gap run is
 * placement's, so `ROUTE_TITLE_DETOUR` never names it.
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const EPS = 1e-6;
const right = (box: Rect): number => box.x + box.width, bottom = (box: Rect): number => box.y + box.height;
const vertical = (segment: PathSegment): boolean => Math.abs(segment.from.x - segment.to.x) <= EPS;
const horizontal = (segment: PathSegment): boolean => Math.abs(segment.from.y - segment.to.y) <= EPS;

/** Every jog of a routed path: a horizontal piece shorter than the run clearance between two verticals. */
function jogs(model: LayoutModel): { link: string; y: number; x0: number; x1: number }[] {
  const keep = nudgingDistance(model);
  return model.links.filter(link => link.layer === 'routed' && link.path !== undefined).flatMap(link => {
    const segments = link.path!.segments;
    return segments.flatMap((segment, index) => {
      const before = segments[index - 1], after = segments[index + 1];
      if (!before || !after || !horizontal(segment) || !vertical(before) || !vertical(after)) return [];
      const x0 = Math.min(segment.from.x, segment.to.x), x1 = Math.max(segment.from.x, segment.to.x);
      return x1 - x0 < keep - EPS && x1 - x0 > EPS ? [{ link: link.id, y: segment.from.y, x0, x1 }] : [];
    });
  });
}

const near = (point: { x: number; y: number }, box: Rect, reach: number): boolean =>
  point.x >= box.x - reach && point.x <= right(box) + reach && point.y >= box.y - reach && point.y <= bottom(box) + reach;

describe('a jogged drop under a group title stays in its tier gap (architecture-2 ticket 56)', () => {
  for (const [name, link, title] of [
    ['a-jogged-drop-beside-a-canton-title-stays-in-its-gap', 'link-5', 'label:group:clients#0'],
    ['a-jogged-drop-beside-a-frame-title-stays-in-its-gap', 'link-2', 'label:group:access#0'],
  ] as const) {
    it(`${name}: every jog stands a group-edge margin off every group box; G3 passes; no planned jog is a detour`, async () => {
      const model = await run(fixture(name));
      const margin = GROUP_EDGE_LINK_CLEARANCE + routedStroke(model) / 2;
      const found = jogs(model);
      // The premise: the named drop jogs, and its jog stands within the detour reach (twice the link-free margin) of the title.
      const jog = found.find(item => item.link === link)!;
      expect(jog, `${link} jogs`).toBeDefined();
      const label = model.labels.find(item => item.id === title)!;
      expect(near({ x: jog.x1, y: jog.y }, label.bounds!, 2 * GROUP_LABEL_LINK_CLEARANCE)).toBe(true);
      // The invariant: no jog lies in a group box or within its margin, so no jog stands in a title band.
      for (const item of found) for (const group of Object.values(model.groups)) {
        const box = group.bounds;
        if (box === undefined || !group.nodes.length || item.x1 < box.x - margin || item.x0 > right(box) + margin) continue;
        expect(item.y <= box.y - margin + EPS || item.y >= bottom(box) + margin - EPS, `${item.link} jog at y ${item.y} against ${group.id}`).toBe(true);
      }
      for (const band of model.labelBands) {
        for (const item of found) {
          const over = item.x1 >= band.bounds.x && item.x0 <= right(band.bounds);
          expect(over && item.y > band.bounds.y - EPS && item.y < bottom(band.bounds) + EPS, `${item.link} jog in the band of ${band.group}`).toBe(false);
        }
      }
      // Every title is slid clear, G3 passes, and the planned jog is not named a detour.
      for (const item of model.labels.filter(entry => entry.role === 'group')) expect(item.crossedBy, item.id).toEqual([]);
      expect(score(model).snapshot.gates.G3?.violations ?? []).toEqual([]);
      expect(model.diagnostics.filter(item => item.code === 'ROUTE_TITLE_DETOUR')).toEqual([]);
    }, 120000);
  }
});
