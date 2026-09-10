import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import type { Rect } from '../model/geometry.js';
import { rebuildBands, union } from './skeleton-geometry.js';

export const right = (box: Rect): number => box.x + box.width;
export const bottom = (box: Rect): number => box.y + box.height;
export function fitRegionGroup(model: LayoutModel, group: LayoutGroup): void {
  if (!group.nodes.length) return;
  const box = union(group.nodes.map(id => model.nodes[id]!.bounds!));
  group.bounds = { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 };
}
export function expandCanvas(model: LayoutModel): void {
  const boxes = [...Object.values(model.groups).map(group => group.bounds!), ...model.lanes.map(lane => lane.bounds)];
  if (model.canvas) boxes.push(model.canvas);
  if (boxes.length) model.canvas = union(boxes);
}
/** Replace region bounds after group movement; IDs and membership derive from the document. */
export function rebuildRegions(model: LayoutModel): void {
  rebuildBands(model);
  model.regions = [];
  for (let i = 1; i < model.tierBands.length; i++) {
    const upper = model.tierBands[i - 1]!, lower = model.tierBands[i]!, a = upper.bounds!, b = lower.bounds!;
    const x = Math.min(a.x, b.x);
    model.regions.push({ id: `tiers:${upper.tier}:${lower.tier}`, kind: 'tiers', upperTier: upper.tier, lowerTier: lower.tier,
      bounds: { x, y: bottom(a), width: Math.max(right(a), right(b)) - x, height: Math.max(0, b.y - bottom(a)) } });
  }
  for (const group of Object.values(model.groups)) {
    if (!group.flank) continue;
    const peer = model.groups[group.flank.of]!, a = group.bounds!, b = peer.bounds!;
    const y = Math.min(a.y, b.y), x = group.flank.align === 'left' ? right(a) : right(b);
    model.regions.push({ id: `flank:${JSON.stringify(group.id)}`, kind: 'flank', flank: group.id, group: peer.id,
      bounds: { x, y, width: Math.max(0, (group.flank.align === 'left' ? b.x : a.x) - x), height: Math.max(bottom(a), bottom(b)) - y } });
  }
  expandCanvas(model);
}
export function placementWarning(model: LayoutModel, code: string, message: string, ids: string[], kind: 'link' | 'group' = 'link'): void {
  if (model.diagnostics.some(d => d.code === code && d.message === message)) return;
  model.diagnostics.push({ stage: 'placement', severity: 'warning', code, message, owners: ids.map(id => ({ kind, id })) });
}
