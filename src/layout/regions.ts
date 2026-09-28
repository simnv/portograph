import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import type { Rect } from '../model/geometry.js';
import { measurePortPill } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { rebuildBands, union } from './skeleton-geometry.js';

export const right = (box: Rect): number => box.x + box.width;
export const bottom = (box: Rect): number => box.y + box.height;
/** Group box beyond node bodies and named pills, all four sides (maintainer M1 visual review: 12 → 20). */
export const GROUP_PADDING = 20;
/**
 * Label bands extend the top inset while ordinary group padding remains below and at both sides.
 * A band reserves its own clearance below itself; that reservation is at least the ordinary padding.
 */
export function groupPadding(model: LayoutModel, group: LayoutGroup): { top: number; right: number; bottom: number; left: number } {
  const padding = { top: GROUP_PADDING, right: GROUP_PADDING, bottom: GROUP_PADDING, left: GROUP_PADDING };
  for (const id of group.nodes) for (const port of model.nodes[id]!.ports) {
    if (port.ref.anonymous === true || port.side === undefined) continue;
    padding[port.side] = Math.max(padding[port.side], GROUP_PADDING
      + measurePortPill(port.ref.name).width / 2 + DEFAULT_STROKE_WIDTHS.pill / 2);
  }
  return padding;
}
/** The label band a group's box holds: its own title's, or the frame title a rank cell hosts. */
export const bandHeldBy = (model: LayoutModel, groupId: string): LayoutModel['labelBands'][number] | undefined =>
  model.labelBands.find(item => (item.host ?? item.group) === groupId);
export function groupInsets(model: LayoutModel, group: LayoutGroup): { top: number; right: number; bottom: number; left: number } {
  const padding = groupPadding(model, group), band = bandHeldBy(model, group.id);
  return band ? { ...padding, [band.side]: band.bounds.height + band.clearance } : padding;
}
export function fitRegionGroup(model: LayoutModel, group: LayoutGroup): void {
  if (!group.nodes.length) return;
  const box = union(group.nodes.map(id => model.nodes[id]!.bounds!)), inset = groupInsets(model, group);
  if (bandHeldBy(model, group.id) === undefined) {
    group.bounds = { x: box.x - inset.left, y: box.y - inset.top,
      width: box.width + inset.left + inset.right, height: box.height + inset.top + inset.bottom };
    return;
  }
  // A band group keeps any extent placement granted it beyond its content: label widening and
  // the linked-group grid (7f) only ever grow a box, and content never leaves it.
  const old = group.bounds!, x = Math.min(old.x, box.x - inset.left), y = Math.min(old.y, box.y - inset.top);
  group.bounds = { x, y, width: Math.max(right(old), right(box) + inset.right) - x,
    height: Math.max(bottom(old), bottom(box) + inset.bottom) - y };
}
export function expandCanvas(model: LayoutModel): void {
  const boxes = [...Object.values(model.groups).map(group => group.bounds!), ...(model.frames ?? []).map(frame => frame.box), ...model.lanes.map(lane => lane.bounds)];
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
