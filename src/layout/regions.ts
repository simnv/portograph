import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import type { Rect, Side } from '../model/geometry.js';
import { measurePortPill } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { rebuildBands, union } from './skeleton-geometry.js';
import { heldBusRoom } from './bus-room.js';
import { paddingRows, rowsInset, rowsInsetUnderTitle } from './course-rows.js';

export const right = (box: Rect): number => box.x + box.width;
export const bottom = (box: Rect): number => box.y + box.height;
/** Group box beyond node bodies and named pills, all four sides (maintainer M1 visual review: 12 → 20). */
export const GROUP_PADDING = 20;
/**
 * Label bands extend the top inset while ordinary group padding remains below and at both sides.
 * A band reserves its own clearance below itself; that reservation is at least the ordinary padding.
 * `withLabelRoom` false leaves out the room across a run (`labelPadding`): the edge's ordinary padding, which the validator compares a
 * recorded room with.
 */
export function groupPadding(model: LayoutModel, group: LayoutGroup, withLabelRoom = true): { top: number; right: number; bottom: number; left: number } {
  const padding = { top: GROUP_PADDING, right: GROUP_PADDING, bottom: GROUP_PADDING, left: GROUP_PADDING };
  for (const id of group.nodes) for (const port of model.nodes[id]!.ports) {
    if (port.ref.anonymous === true || port.side === undefined) continue;
    padding[port.side] = Math.max(padding[port.side], GROUP_PADDING
      + measurePortPill(port.ref.name).width / 2 + DEFAULT_STROKE_WIDTHS.pill / 2);
  }
  // The padding rows of the courses that end in this group (ticket 15): the edge holds the stem, the rows and the edge margin.
  for (const [side, rows] of Object.entries(paddingRows(model, group)) as ['top' | 'bottom', NonNullable<ReturnType<typeof paddingRows>['top']>][]) padding[side] = Math.max(padding[side], rowsInset(rows));
  // The room a link label beside a run in this padding needs (ticket 21): the record 7f wrote, read by every rebuild (R1).
  if (withLabelRoom) for (const [side, entry] of Object.entries(model.labelPadding?.[group.id] ?? {}) as [Side, { room: number }][]) padding[side] = Math.max(padding[side], entry.room);
  return group.frame === undefined ? padding : cellPadding(model, group, padding);
}
/**
 * A rank cell carries no padding of its own (ranked-groups spec, section 2): the frame grows around
 * its cells. Two margins are still held in the cell box, because tier bands, gap rows and lanes are
 * measured on cell boxes and must see them: the frame's margin on its top and bottom edge. An
 * interior edge, shared with the next rank of the frame, holds nothing, so two ranks of one frame
 * stand one band gap apart body to body. The sides hold only the pill reach beyond the ordinary
 * margin; the frame adds the ordinary margin itself (`rebuildFrames`).
 */
function cellPadding(model: LayoutModel, group: LayoutGroup, padding: Record<Side, number>): Record<Side, number> {
  const frames = model.document.frames!, frame = group.frame!;
  let lowest = Infinity, highest = -Infinity;
  for (const id in frames) {
    const item = frames[id]!;
    if (id !== frame && item.parent !== frame) continue;
    for (const cell of item.cells) {
      const tier = model.groups[cell]?.tier ?? group.tier!;
      lowest = Math.min(lowest, tier);
      highest = Math.max(highest, tier);
    }
  }
  return {
    top: group.tier! <= lowest ? padding.top : 0,
    bottom: group.tier! >= highest ? padding.bottom : 0,
    left: padding.left - GROUP_PADDING, right: padding.right - GROUP_PADDING,
  };
}
/** The label band a group's box holds: its own title's, or the frame title a rank cell hosts. */
export const bandHeldBy = (model: LayoutModel, groupId: string): LayoutModel['labelBands'][number] | undefined =>
  model.labelBands.find(item => (item.host ?? item.group) === groupId);
export function groupInsets(model: LayoutModel, group: LayoutGroup): { top: number; right: number; bottom: number; left: number } {
  const padding = groupPadding(model, group), band = bandHeldBy(model, group.id);
  const inset = band ? { ...padding, [band.side]: band.bounds.height + band.clearance } : padding;
  const rows = band === undefined || (band.side !== 'top' && band.side !== 'bottom') ? undefined : paddingRows(model, group)[band.side];
  if (band !== undefined && rows !== undefined) inset[band.side] = Math.max(inset[band.side], rowsInsetUnderTitle(rows, band.bounds.height));
  // An in-frame bus band lies against the padding on its edge (mesh-bus.md, section 4). On the title edge it is
  // already in the band's clearance.
  const bus = heldBusRoom(model, group);
  for (const side of ['top', 'bottom'] as const) if (bus[side] > 0 && band?.side !== side) inset[side] = Math.max(padding[side], bus[side]);
  return inset;
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
