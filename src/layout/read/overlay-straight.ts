import type { Point } from '../../model/geometry.js';
import type { LayoutModel, PathSegment } from '../../model/layout.js';
import { sharedBlockers, overlayBasePath, straightChord, type ShapeQuery } from '../overlay-paths.js';

/**
 * Shared readers: "is this overlay link straight?" The question has two answers, and both are named modes. They differ on one
 * input: a link that the overlay rule cannot draw (two pills overlap on both axes, or the diagram blocks every way round) keeps
 * the one segment between its two faces. That segment is one segment, so it is straight as drawn, and it is no straight chord.
 * On the published NTP model the two modes agree (38 of 54), so the difference is latent; it is a known difference, left to
 * ticket 74, which unifies it.
 *
 * Both modes read the ordinary overlay (`overlayBasePath`, which straightens exactly the links `overlayPath` does, and `straightChord`), never `publishedOverlayPath`: under the opt-in
 * `layout.overlayOverBodies` only stage 8 lets a link pass over a body, and placement must not take that option as a reason to
 * stand differently. A mesh bus member is neither straight nor bent, and both modes skip it.
 */

/** Whether a drawn overlay path is one segment. Mode `as drawn`. */
export function isOneSegment(segments: readonly PathSegment[]): boolean {
  return segments.length === 1;
}

/**
 * Mode `chord`: the overlay links that have a straight chord between their faces in the model as it stands, by id. A link the overlay
 * rule cannot draw is not in the set. Read by the centring step (`centreGroupStep`) to keep what 7e reserved.
 */
export function straightChordIds(model: LayoutModel): Set<string> {
  const blockers = sharedBlockers(model);
  return new Set(model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && straightChord(model, link, blockers) !== undefined).map(link => link.id));
}

/** An overlay link that stands as one straight segment, with the groups at its ends and the two points of the segment. */
export interface DrawnStraight { id: string; ends: Set<string>; from: Point; to: Point }

/**
 * Mode `as drawn`: the attached overlay links that stand as one segment now, with the groups at their ends. A link the overlay rule
 * cannot draw counts, as its face-to-face segment is one. `only` narrows the links asked. Read by the column pull, the close-up
 * and the keep-out in 7f (`columns.ts`, `bands.ts`). The blocker index is built once per call and not once per link.
 */
export function straightOverlaysAsDrawn(model: LayoutModel, only?: ReadonlySet<string>): DrawnStraight[] {
  const found: DrawnStraight[] = [];
  let blockers: ShapeQuery | undefined;
  for (const link of model.links) {
    if (link.layer !== 'overlay' || link.meshBus !== undefined || !link.attachments || (only && !only.has(link.id))) continue;
    const { segments } = overlayBasePath(model, link, blockers ??= sharedBlockers(model));
    if (!isOneSegment(segments)) continue;
    found.push({ id: link.id, ends: new Set([link.attachments.from.node, link.attachments.to.node].map(node => model.document.nodes[node]!.group)), from: segments[0]!.from, to: segments[0]!.to });
  }
  return found;
}
