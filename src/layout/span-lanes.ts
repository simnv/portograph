import type { Rect } from '../model/geometry.js';
import type { Lane, LayoutLink, LayoutModel } from '../model/layout.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { EPS } from '../geometry/planar.js';
import { SideHintRefusal } from './side-hints.js';
import { straightChord } from './overlay-paths.js';

/**
 * The span corridors of a spanning chord (architecture ticket 22, docs/design/routed-chords.md, Section 14.3). A spanning chord is a hinted routed link on two
 * document tiers that are not consecutive. It owns no transit lane; 7a reserves one **span corridor** per transited band instead: `Lane.kind: 'span'`,
 * id `span:<link>:<sub-tier>`, owner the link. The corridor is the part of the chord between the band's top and bottom, grown by the gate clearances. Its id,
 * owner and band are immutable; its x and width are derived from the two end anchors at every rebuild, as a perimeter lane's x is derived (ADR-0010 amendment of
 * ticket 15). It is no router obstacle: the chord is a fixed path.
 */

/** A placement run cannot reserve a span corridor (a unit or lane stands in it and cannot move aside). The span round refuses the trial; every other error is a bug. */
export class SpanRefusal extends SideHintRefusal {}

export const spanLaneId = (link: string, tier: number): string => `span:${link}:${tier}`;
export const isSpanLane = (lane: Pick<Lane, 'kind'>): boolean => lane.kind === 'span';

/** The vertical extent a lane of this band covers: the band grown by the pad the transit lanes use (`laneExtent`). */
function bandExtent(model: LayoutModel, tier: number): { y: number; height: number } | undefined {
  const box = model.tierBands.find(band => band.tier === tier)?.bounds;
  if (box === undefined) return undefined;
  const pad = 10 + DEFAULT_STROKE_WIDTHS.path / 2;
  return { y: box.y - pad, height: box.height + 2 * pad };
}

/**
 * The corridor of the link's chord in one transited band: the part of the segment between the band's top and bottom, grown in x by the group-edge link margin
 * and the half stroke, taken along the normal of the chord (the factor 1 / cos of the angle to the vertical, as `crossingRect`). The box is the extent of a lane:
 * its y and height are the band's. `extra` widens it on both sides (the half extent of a label whose midpoint falls in the band, phase 4).
 * Undefined where the chord does not reach the band, or when an end has no anchor.
 */
export function spanCorridor(model: LayoutModel, link: LayoutLink, tier: number, extra = 0): Rect | undefined {
  const chord = straightChord(model, link, undefined, true), extent = bandExtent(model, tier);
  if (chord === undefined || extent === undefined) return undefined;
  const dy = chord.to.y - chord.from.y, dx = chord.to.x - chord.from.x;
  if (Math.abs(dy) < EPS) return undefined;
  const top = extent.y, floor = extent.y + extent.height;
  const a = (top - chord.from.y) / dy, b = (floor - chord.from.y) / dy;
  const low = Math.max(0, Math.min(a, b)), high = Math.min(1, Math.max(a, b));
  if (low >= high - EPS) return undefined;
  const xs = [chord.from.x + low * dx, chord.from.x + high * dx];
  const slant = Math.min(50, Math.hypot(dx, dy) / Math.abs(dy));
  const along = (GROUP_EDGE_LINK_CLEARANCE + linkStrokeWidth(link) / 2) * slant + extra;
  const x = Math.min(...xs) - along;
  return { x, y: extent.y, width: Math.max(...xs) + along - x, height: extent.height };
}

/** The hinted links of the model, in link order. */
export const spanLinks = (model: LayoutModel): LayoutLink[] => model.links.filter(link => link.spanHint === true);

/** Put the derived geometry on a span lane: x is the centre of the corridor, the box its bounds. Returns false when the chord has left the band. */
export function replaySpanLane(model: LayoutModel, lane: Lane, link: LayoutLink): boolean {
  const box = spanCorridor(model, link, lane.tier);
  if (box === undefined) return false;
  lane.x = box.x + box.width / 2;
  lane.bounds = { x: lane.x - box.width / 2, width: box.width, y: box.y, height: box.height };
  return true;
}
