import type { LayoutModel } from '../model/layout.js';
import { frameSubtreeCells } from '../model/model.js';
import { busBandHeight } from './bus-room.js';
import { GROUP_PADDING } from './group-padding.js';
import { isCantonFrame } from './read/canton.js';
import { frameTitleEdge } from './read/title-edge.js';
import { GROUP_LABEL_GEOMETRY, measureTitle } from './title-room.js';

/**
 * The height the bands that stand in one tier gap ask of it (architecture-2 ticket 57): a canton title band on the gap's edge and an
 * across-frames mesh bus band in it. Each band is held by its sub-tier, not by a group box, so the gap holds the frame margin, the band
 * and a margin more: 20 + band + 20. Two bus bands that face each other in one gap (the bars of a join on adjacent rows) are added, never
 * compared: 20 + upper band + lower band + 20 (mesh-bus.md, section 11.5); a canton band on the same edge as a bus band is added to it.
 * Every input is fixed at stage 5 (the title edge, the bus side, the title text), so stage 6 seats the gap with it, and the tier-gap plan
 * reads the same figure as its floor. 0 where no band stands in the gap.
 */
export function gapBandDemand(model: LayoutModel, above: number, below: number): number {
  const edge = edgeNeeds(model);
  const lower = edge.below.get(above), upper = edge.above.get(below);
  if (edge.busBelow.has(above) && edge.busAbove.has(below)) return lower! + upper! - 2 * GROUP_PADDING;
  return Math.max(lower ?? 0, upper ?? 0);
}

/**
 * The needs of each edge: `below` keyed by the last sub-tier of a canton titled at the bottom (or the row of a bus on its bottom edge),
 * `above` by the first sub-tier of one titled at the top (or the row of a bus on its top edge).
 */
function edgeNeeds(model: LayoutModel): { below: Map<number, number>; above: Map<number, number>; busBelow: Set<number>; busAbove: Set<number> } {
  const below = new Map<number, number>(), above = new Map<number, number>();
  const busBelow = new Set<number>(), busAbove = new Set<number>();
  const frames = model.document.frames ?? {};
  for (const id of Object.keys(frames)) {
    if (!isCantonFrame(model, id)) continue;
    const side = frameTitleEdge(model, id), tiers = frameSubtreeCells(frames, id).map(cell => model.groups[cell]!.tier!);
    const tier = side === 'top' ? Math.min(...tiers) : Math.max(...tiers);
    const need = GROUP_PADDING + measureTitle(frames[id]!.label).height + GROUP_LABEL_GEOMETRY.bandExtra + GROUP_PADDING;
    const map = side === 'top' ? above : below;
    map.set(tier, Math.max(map.get(tier) ?? 0, need));
  }
  for (const bus of model.meshBuses ?? []) {
    if (bus.placement !== 'across-frames' || bus.side === undefined) continue;
    const map = bus.side === 'top' ? above : below, height = busBandHeight(bus), known = map.get(bus.row);
    map.set(bus.row, known === undefined ? GROUP_PADDING + height + GROUP_PADDING : known + height);
    (bus.side === 'top' ? busAbove : busBelow).add(bus.row);
  }
  return { below, above, busBelow, busAbove };
}
