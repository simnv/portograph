import type { LayoutModel } from '../model/index.js';
import { drawnOverlays, read, routedBends, routedFamily } from '../layout/objective.js';
import { routed } from './model.js';
import type { ScoreCounts } from './types.js';

/**
 * The raw counts of each link family, beside Q and never inside it (Q reads only the routed layer). Every number comes from a shared
 * reader: `read()` for the overlay family and the routed bends, and the routed crossings that Q already counts (`routedCrossings`).
 * The overlay family is the drawn overlay links: attached, and no mesh-bus member. Mesh-bus overlay links are counted apart
 * (`meshBusLinks`) and take no part in the overlay bent, turns or crossings. The overlay paths are the ones that the ordinary overlay
 * rule draws, as `read()` states.
 */
export function counts(model: LayoutModel, routedCrossings: number): ScoreCounts {
  const overlays = drawnOverlays(model);
  const pairs = read(model, { overlays, crossings: 'pairs' }), points = read(model, { overlays, crossings: 'points' });
  const kept = new Set(model.links.filter(routed).map(link => link.id));
  const family = routedFamily(new Map([...routedBends(model)].filter(([id]) => kept.has(id))));
  return {
    routed: { links: kept.size, bent: family.bent, turns: family.turns, crossings: routedCrossings },
    overlay: {
      links: overlays.length, bent: pairs.overlay.bent, turns: pairs.overlay.turns,
      crossings: { pairs: pairs.crossings(), points: points.crossings() },
      meshBusLinks: model.links.filter(link => link.layer === 'overlay' && link.meshBus !== undefined).length,
    },
  };
}
