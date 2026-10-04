import type { LayoutModel } from '../model/index.js';
import { drawnOverlays, routedBends, routedFamily } from '../layout/objective.js';
import { drawn, overlayCrossingPairs, overlayCrossingPoints, portKey, type Drawn } from '../layout/read/crossings.js';
import { routed } from './model.js';
import type { ScoreCounts } from './types.js';

/**
 * The raw counts of each link family, beside Q and never inside it (Q reads only the routed layer). The score evaluates the published
 * geometry and never repairs it, so every count reads the links' published `path.segments` (an overlay drawn over a body by
 * `layout.overlayOverBodies` counts as drawn). The shared readers do the counting: `routedBends`/`routedFamily` for the routed turns,
 * `overlayCrossingPairs` and `overlayCrossingPoints` for the overlay crossings, and the routed crossings that Q already counts
 * (`routedCrossings`).
 * The overlay family is the attached overlay links that carry a path and are no mesh-bus member. Mesh-bus overlay links are counted apart
 * (`meshBusLinks`) and take no part in the overlay bent, turns or crossings.
 */
export function counts(model: LayoutModel, routedCrossings: number): ScoreCounts {
  const overlays = drawnOverlays(model).flatMap(link => link.path === undefined || link.removed === true ? [] : [{ link, segments: link.path.segments }]);
  const kept = new Set(model.links.filter(routed).map(link => link.id));
  const family = routedFamily(new Map([...routedBends(model)].filter(([id]) => kept.has(id))));
  const open = overlays.filter(path => path.segments.length > 0);
  return {
    routed: { links: kept.size, bent: family.bent, turns: family.turns, crossings: routedCrossings },
    overlay: {
      links: overlays.length, bent: overlays.filter(path => path.segments.length > 1).length,
      turns: overlays.reduce((sum, path) => sum + Math.max(0, path.segments.length - 1), 0),
      crossings: {
        pairs: overlayCrossingPairs(open.map(path => path.segments)),
        points: overlayCrossingPoints(open.map(({ link, segments }): Drawn => drawn([segments[0]!.from, ...segments.map(segment => segment.to)],
          [portKey(link.attachments!.from), portKey(link.attachments!.to)]))),
      },
      meshBusLinks: model.links.filter(link => link.layer === 'overlay' && link.meshBus !== undefined).length,
    },
  };
}
