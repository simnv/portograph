import type { Rect } from '../model/geometry.js';
import type { Lane, LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { EPS } from '../geometry/planar.js';
import { spanLaneId } from './lane-kind.js';
import { SideHintRefusal } from './side-hints.js';
import { straightChord } from './overlay-paths.js';
import { candidateBox, haloSize, isDirect, lineAngle, LINK_LABEL_GEOMETRY, turnedBox } from './link-labels.js';
import { measureText } from '../text/index.js';

/**
 * The span corridors of a spanning chord (architecture ticket 22, docs/design/routed-chords.md, Section 14.3). A spanning chord is a hinted routed link on two
 * document tiers that are not consecutive. It owns no transit lane; 7a reserves one **span corridor** per transited band instead: `Lane.kind: 'span'`,
 * id `span:<link>:<sub-tier>`, owner the link. The corridor is the part of the chord between the band's top and bottom, grown by the gate clearances. Its id,
 * owner and band are immutable; its x and width are derived from the two end anchors at every rebuild, as a perimeter lane's x is derived (ADR-0010 amendment of
 * ticket 15). It is no router obstacle: the chord is a fixed path.
 */

/** A placement run cannot reserve a span corridor (a unit or lane stands in it and cannot move aside). The span round refuses the trial; every other error is a bug. */
export class SpanRefusal extends SideHintRefusal {}
/** The 7a reservation (`reserveSpanCorridors`) cannot open a corridor. It is thrown before any later stage has run, so the round that asked gives the re-run back; a refusal of 7c to 7e (`SpanRefusal`) comes after most of the placement and gives nothing back. */
export class SpanReservationRefusal extends SpanRefusal {}

export { spanLaneId };
export const isSpanLane = (lane: Pick<Lane, 'kind'>): boolean => lane.kind === 'span';

/** The vertical extent a lane of this band covers: the band grown by the pad the transit lanes use (`laneExtent`). */
function bandExtent(model: LayoutModel, tier: number): { y: number; height: number } | undefined {
  const box = model.tierBands.find(band => band.tier === tier)?.bounds;
  if (box === undefined) return undefined;
  const pad = 10 + DEFAULT_STROKE_WIDTHS.path / 2;
  return { y: box.y - pad, height: box.height + 2 * pad };
}

/**
 * The room the label of a spanning chord needs (ticket 16; docs/design/routed-chords.md, Section 14.5), as the boxes stage 9 would put it: a label on a direct line lies on
 * it, centred at the midpoint, turned to the line's angle, with its halo; a label on a line with an axis stands beside it, on either side. A line too short for the text carries
 * the text shortened to its length less the two margins. Reserved here, in 7a, with the corridor, so that no unit stands where stage 9 puts the label.
 */
export function spanLabelRooms(model: LayoutModel, link: LayoutLink): Rect[] {
  const text = model.document.links[link.sourceIndex]?.label, chord = straightChord(model, link, undefined, true);
  if (text === undefined || text === '' || chord === undefined) return [];
  const segment: PathSegment = { from: chord.from, to: chord.to, owner: { ...link.owner }, straight: true };
  const length = Math.hypot(chord.to.x - chord.from.x, chord.to.y - chord.from.y);
  const measured = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });
  const size = { width: Math.min(measured.width, Math.max(0, length - 2 * LINK_LABEL_GEOMETRY.shortenMargin)), height: measured.height };
  if (isDirect(segment)) return [turnedBox({ x: (chord.from.x + chord.to.x) / 2, y: (chord.from.y + chord.to.y) / 2 }, haloSize(size), lineAngle(segment))];
  const half = linkStrokeWidth(link) / 2;
  return [false, true].map(second => candidateBox(segment, half, size, second).bounds);
}

/**
 * The corridor of the link's chord in one transited band: the part of the segment between the band's top and bottom, grown in x by the group-edge link margin
 * and the half stroke, taken along the normal of the chord (the factor 1 / cos of the angle to the vertical, as `crossingRect`). The box is the extent of a lane:
 * its y and height are the band's. Where the room of the chord's label (`spanLabelRooms`) meets the band, the corridor is widened to hold it with its halo.
 * Undefined where the chord does not reach the band, or when an end has no anchor.
 */
export function spanCorridor(model: LayoutModel, link: LayoutLink, tier: number): Rect | undefined {
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
  const along = (GROUP_EDGE_LINK_CLEARANCE + linkStrokeWidth(link) / 2) * slant;
  let x0 = Math.min(...xs) - along, x1 = Math.max(...xs) + along;
  for (const room of spanLabelRooms(model, link)) {
    if (room.y >= floor - EPS || room.y + room.height <= top + EPS) continue;
    x0 = Math.min(x0, room.x - LINK_LABEL_GEOMETRY.halo);
    x1 = Math.max(x1, room.x + room.width + LINK_LABEL_GEOMETRY.halo);
  }
  return { x: x0, y: extent.y, width: x1 - x0, height: extent.height };
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
