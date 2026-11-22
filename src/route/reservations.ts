import type { Rect } from '../model/geometry.js';
import type { LayoutLink, LayoutModel } from '../model/layout.js';
import { routedStroke } from '../layout/bands.js';
import { PLACEMENT_EPS } from '../layout/tolerance.js';
import { GROUP_EDGE_LINK_CLEARANCE, GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import { groupConsumers } from '../score/model.js';

/** Minimum port stem, the same number G5 enforces on final geometry. */
export const MIN_STEM = 15;
export const TOLERANCE = PLACEMENT_EPS;

export const shrink = (bounds: Rect, by: number): Rect => ({
  x: bounds.x + by, y: bounds.y + by, width: bounds.width - 2 * by, height: bounds.height - 2 * by,
});

/** One group box stage 8 keeps links out of: a top group, a rank cell or a frame, grown by the edge margin, and the links it lets through. */
export interface GroupReservation { id: string; kind: 'group' | 'cell' | 'frame'; bounds: Rect; consumers: readonly string[] }

/**
 * The one producer of the group boxes of stage 8, their edge margin and their consumers (`groupConsumers`: a link attached inside, or
 * owning a lane in the margin), so the router and the stitch read one list (R1; field-2026-11 ticket 05, review 1). Each reader keeps its
 * own rule: the router reads the top groups and the frames, and takes the links that left a box by a reserved exit out of its consumers
 * (`routeObstacles`); the stitch reads the top groups and the cells (`reservations`); the cell retry of stage 8 reads the cells.
 * Order: the groups of the model in their order, then the frames.
 */
export function groupReservations(model: LayoutModel): GroupReservation[] {
  const margin = routedStroke(model) / 2 + GROUP_EDGE_LINK_CLEARANCE;
  const grow = (box: Rect): Rect => ({ x: box.x - margin, y: box.y - margin, width: box.width + 2 * margin, height: box.height + 2 * margin });
  const result: GroupReservation[] = [];
  for (const [id, group] of Object.entries(model.groups)) {
    if (!group.bounds || !group.nodes.length) continue;
    result.push({ id, kind: group.frame === undefined ? 'group' : 'cell', bounds: grow(group.bounds), consumers: groupConsumers(model, id) });
  }
  for (const frame of model.frames ?? []) result.push({ id: frame.id, kind: 'frame', bounds: grow(frame.box), consumers: groupConsumers(model, frame.id) });
  return result;
}

/**
 * Reserved rectangles a newly routed segment may not enter. Nodes, pills, labels and fixed paths
 * are judged by the public gates; lane and bundle reservations are not, so stage 8 asserts them
 * directly. A label band's unused space is traversable; its actual label remains protected.
 */
export function reservations(model: LayoutModel, link: LayoutLink): { id: string; bounds: Rect }[] {
  const half = routedStroke(model) / 2, result: { id: string; bounds: Rect }[] = [];
  const expand = (bounds: Rect): Rect => ({ x: bounds.x - half, y: bounds.y - half, width: bounds.width + 2 * half, height: bounds.height + 2 * half });
  for (const label of model.labels) {
    // A group title is no reservation to a link it yields to (`crossedBy`, architecture-2 ticket 54).
    if (label.role === 'group' && !label.omitted && label.bounds && label.layer !== 'overlay' && label.crossedBy?.includes(link.id) !== true) {
      const m = half + GROUP_LABEL_LINK_CLEARANCE, b = label.bounds;
      result.push({ id: label.id, bounds: { x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m } });
    }
  }
  for (const lane of model.lanes) {
    // A span corridor is no router obstacle: its chord is a fixed path (architecture ticket 22).
    if (lane.layer === 'overlay' || lane.kind === 'span') continue;
    const owner = lane.owner;
    const owns = owner.kind === 'link' ? owner.id === link.id
      : owner.kind === 'bundle' && model.bundles.some(bundle => bundle.id === owner.id && bundle.members.includes(link.id));
    if (!owns) result.push({ id: lane.id, bounds: expand(lane.bounds) });
  }
  // The stitch reads the top groups and the rank cells, never a frame (a frame stands for its cells).
  for (const item of groupReservations(model)) {
    if (item.kind === 'frame' || item.consumers.includes(link.id)) continue;
    result.push({ id: `group:${item.id}`, bounds: item.bounds });
  }
  for (const bundle of model.bundles) {
    if (bundle.layer === 'overlay' || bundle.members.includes(link.id)) continue;
    const parts = bundle.envelopeParts?.length ? bundle.envelopeParts : bundle.envelope ? [bundle.envelope] : [];
    for (const [index, part] of parts.entries()) result.push({ id: `${bundle.id}:envelope:${index}`, bounds: expand(part) });
  }
  for (const obstacle of model.obstacles) {
    if (obstacle.layer === 'overlay' || (obstacle.owner.kind === 'link' && obstacle.owner.id === link.id)) continue;
    result.push({ id: obstacle.id, bounds: expand(obstacle.bounds) });
  }
  return result;
}

