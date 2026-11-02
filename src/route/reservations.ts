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
  for (const [id, group] of Object.entries(model.groups)) {
    if (!group.bounds || !group.nodes.length || groupConsumers(model, id).includes(link.id)) continue;
    const margin = half + GROUP_EDGE_LINK_CLEARANCE, box = group.bounds;
    result.push({ id: `group:${id}`, bounds: { x: box.x - margin, y: box.y - margin, width: box.width + 2 * margin, height: box.height + 2 * margin } });
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

