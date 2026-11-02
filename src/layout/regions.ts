import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import type { Rect, Side } from '../model/geometry.js';
import { measurePortPill } from '../text/index.js';
import { DEFAULT_STROKE_WIDTHS } from '../theme/geometry.js';
import { rebuildBands, union } from './skeleton-geometry.js';
import { heldBusRoom } from './bus-room.js';
import { paddingRows, rowsInset, rowsInsetUnderTitle } from './course-rows.js';
import { ownTitleFloor, titleRoom } from './title-room.js';
import { frameSubtreeCells } from '../model/model.js';
import { readCache } from '../model/read-cache.js';
import { isCantonFrame } from './read/canton.js';
import { frameTitleEdge } from './read/title-edge.js';

export const right = (box: Rect): number => box.x + box.width;
export const bottom = (box: Rect): number => box.y + box.height;
import { GROUP_PADDING } from './group-padding.js';
export { GROUP_PADDING };
/**
 * Label bands extend the top inset while ordinary group padding remains below and at both sides.
 * A band reserves its own clearance below itself; that reservation is at least the ordinary padding.
 * `withLabelRoom` false leaves out the room across a run (`labelPadding`: a label's room and a separated overlay track's room): the
 * edge's ordinary padding, which the validator compares a recorded room with.
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
 * The lowest and highest tier of the cells of a frame and its child frames, per model and frame (architecture-2 ticket 60). The key is the
 * identity of `model.document`: a group's tier is written only while the model is built (parse, stage 2, `createLayoutModel`), and every later
 * writer of `model.groups` copies the tier. A frame with a missing cell group reads the asking group's tier for it, so its span is not stored.
 */
const tierSpans = new WeakMap<LayoutModel, { document: LayoutModel['document']; spans: Map<string, { lowest: number; highest: number }> }>();
const tierSpanCache = readCache('cellPadding');
function frameTierSpan(model: LayoutModel, group: LayoutGroup): { lowest: number; highest: number } {
  let known = tierSpans.get(model);
  if (known === undefined || known.document !== model.document) tierSpans.set(model, known = { document: model.document, spans: new Map() });
  const frame = group.frame!, span = known.spans.get(frame);
  if (span !== undefined) return tierSpanCache.hit(model, span, () => computeTierSpan(model, group).span);
  tierSpanCache.miss();
  const computed = computeTierSpan(model, group);
  if (computed.complete) known.spans.set(frame, computed.span);
  return computed.span;
}
function computeTierSpan(model: LayoutModel, group: LayoutGroup): { span: { lowest: number; highest: number }; complete: boolean } {
  const frames = model.document.frames!, frame = group.frame!;
  let lowest = Infinity, highest = -Infinity, complete = true;
  for (const id in frames) {
    const item = frames[id]!;
    if (id !== frame && item.parent !== frame) continue;
    for (const cell of item.cells) {
      const own = model.groups[cell]?.tier;
      if (own === undefined) complete = false;
      const tier = own ?? group.tier!;
      lowest = Math.min(lowest, tier);
      highest = Math.max(highest, tier);
    }
  }
  return { span: { lowest, highest }, complete };
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
  const { lowest, highest } = frameTierSpan(model, group);
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
/**
 * The box a group's content asks for: its nodes and the group insets (the title band, padding rows and bus room among them), at least as wide
 * as its own title and the two title insets (`ownTitleFloor`), centred on the nodes. `fitRegionGroup` fits a group to it, so the title width is
 * reserved from stage 5 on, before 7a stands a lane beside the box (snack-theme ticket 157).
 */
export function contentBox(model: LayoutModel, group: LayoutGroup): Rect {
  const box = union(group.nodes.map(id => model.nodes[id]!.bounds!)), inset = groupInsets(model, group);
  const width = box.width + inset.left + inset.right, extra = Math.max(0, ownTitleFloor(model, group) - width, cantonTitleFloor(model, group) - width);
  return { x: box.x - inset.left - extra / 2, y: box.y - inset.top, width: width + extra, height: box.height + inset.top + inset.bottom };
}
/** The width of a group's nodes and insets, without a title floor. */
function bareWidth(model: LayoutModel, group: LayoutGroup): number {
  const inset = groupInsets(model, group);
  return union(group.nodes.map(id => model.nodes[id]!.bounds!)).width + inset.left + inset.right;
}
/**
 * The width floor a canton's title sets on its union (architecture-2 ticket 54), held by one cell: the widest cell of the canton's title-edge
 * sub-tier (then the id), the cell a title too wide for the canton widens. The canton box holds every cell of that sub-tier and at least
 * `GROUP_PADDING` beyond them on each side (`cellReach`, `deriveFrames`), so the floor is the title room less the other cells' bare widths
 * and the two margins: the canton band then holds the title from stage 5 on. 0 for any other cell.
 */
function cantonTitleFloor(model: LayoutModel, group: LayoutGroup): number {
  const frames = model.document.frames;
  if (frames === undefined || group.frame === undefined || !group.nodes.length) return 0;
  let id: string | undefined = group.frame;
  while (id !== undefined && !isCantonFrame(model, id)) id = frames[id]?.parent;
  const label = id === undefined ? undefined : frames[id]!.label;
  if (id === undefined || !label) return 0;
  const cells = frameSubtreeCells(frames, id).map(cell => model.groups[cell]!).filter(cell => cell.nodes.length && cell.tier !== undefined);
  const tiers = cells.map(cell => cell.tier!), edge = frameTitleEdge(model, id) === 'top' ? Math.min(...tiers) : Math.max(...tiers);
  const row = cells.filter(cell => cell.tier === edge).map(cell => ({ id: cell.id, width: bareWidth(model, cell) }))
    .sort((a, b) => b.width - a.width || a.id.localeCompare(b.id));
  if (row[0]?.id !== group.id) return 0;
  return titleRoom(label) - 2 * GROUP_PADDING - row.slice(1).reduce((sum, cell) => sum + cell.width, 0);
}
export function fitRegionGroup(model: LayoutModel, group: LayoutGroup): void {
  if (!group.nodes.length) return;
  const content = contentBox(model, group);
  if (bandHeldBy(model, group.id) === undefined) { group.bounds = content; return; }
  // A band group keeps any extent placement granted it beyond its content: label widening and
  // the linked-group grid (7f) only ever grow a box, and content never leaves it.
  const old = group.bounds!, x = Math.min(old.x, content.x), y = Math.min(old.y, content.y);
  group.bounds = { x, y, width: Math.max(right(old), right(content)) - x, height: Math.max(bottom(old), bottom(content)) - y };
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
