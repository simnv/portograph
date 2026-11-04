/**
 * The end trim (architecture-2 ticket 68, user 2026-11-04): after the last x move of 7f, a node body is trimmed to the span of its ports with
 * their end insets, plus its label, icon and padding, never below its stage-3 size. Ports keep their x, no node moves; the group boxes, the
 * linked-group grid, the tier bands, the frames, the regions and the label bands are derived again, and the titles are placed after it.
 *
 * The trim is decided once and recorded (`LayoutModel.bodyTrims`, R1): the body and the box each trimmed node and group had at the end of 7f.
 * The centring replay of the publication check reads that geometry (`untrimmedModel`), the one its producer decided on, and never the narrower
 * bodies the trim left: a narrower sibling would let a replay keep a target the producer could not keep.
 */
import type { LayoutModel, Rect } from '../model/index.js';
import { orderedNodeIds } from '../model/model.js';
import { contentBox, rebuildRegions, right } from './regions.js';
import { portEndInsets, portSideCapacity } from './port-insets.js';
import { measureNodeContent } from './size.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { alignLinkedGroupGrid, syncLabelBands } from './bands.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** The fields the trim writes besides the node bodies and their content: a declined trim puts them back. */
const TRIM_FIELDS = ['groups', 'tierBands', 'regions', 'frames', 'labelBands', 'busBands', 'meshBuses', 'canvas', 'diagnostics', 'gridRefusals'] as const;

const isBarNode = (model: LayoutModel, id: string): boolean => model.document.groups[model.document.nodes[id]!.group]!.shape === 'bar';

/**
 * The body the trim gives node `id` when it stood at `box` at the end of 7f, or undefined when the trim leaves it as it is. One function for the
 * producer and the validator (R1).
 *
 * The floor is the stage-3 size read on the final faces: the size floor (theme minimum, measured content, author `size:`, a grid chain), the
 * content measured again with the stored insets (what the node geometry checks), the capacity of each horizontal face at its pitch, and the
 * floor a side hint froze (ADR-0022). The span is that of the top and bottom ports with the stored end insets (`portEndInsets`, corners
 * included). A face with lateral ports keeps its x. The body stays inside `box`, holds the span, and stands centred on it where it can.
 */
export function trimmedBody(model: LayoutModel, id: string, box: Rect): Rect | undefined {
  const node = model.nodes[id]!;
  if (node.contentInsets === undefined || node.sidePitch === undefined || isBarNode(model, id)) return undefined;
  let floor = Math.max(node.sizeFloor?.width ?? 0, node.contentSize?.width ?? 0,
    measureNodeContent(model.document.nodes[id]!, model.document, node.contentInsets).width,
    model.freeze?.nodeFloors?.find(item => item.node === id)?.size.width ?? 0);
  let low = Infinity, high = -Infinity;
  for (const side of ['top', 'bottom'] as const) {
    const ports = node.ports.filter(port => port.side === side);
    if (!ports.length) continue;
    floor = Math.max(floor, portSideCapacity(node, side, ports.length));
    if (ports.some(port => port.anchor === undefined)) return undefined;
    const inset = portEndInsets(node, side), xs = ports.map(port => port.anchor!.x);
    low = Math.min(low, Math.min(...xs) - inset.low);
    high = Math.max(high, Math.max(...xs) + inset.high);
  }
  // A lateral face keeps its x: its ports stand on it, so the span reaches it.
  const leftFace = node.ports.some(port => port.side === 'left'), rightFace = node.ports.some(port => port.side === 'right');
  if (leftFace && rightFace) return undefined;
  if (leftFace) low = Math.min(low, box.x);
  if (rightFace) high = Math.max(high, right(box));
  const spanned = Number.isFinite(low) && Number.isFinite(high);
  const width = Math.max(floor, spanned ? high - low : 0);
  if (width >= box.width - PLACEMENT_EPS) return undefined;
  // Centred on the port span (on the body when it has none), inside the old body, holding the span; a lateral face keeps its x.
  const centre = spanned ? (low + high) / 2 : box.x + box.width / 2;
  let x = Math.max(box.x, Math.min(centre - width / 2, right(box) - width));
  if (spanned) x = Math.max(Math.min(x, low), high - width);
  if (leftFace) x = box.x;
  if (rightFace) x = right(box) - width;
  if (x < box.x - PLACEMENT_EPS || x + width > right(box) + PLACEMENT_EPS) return undefined;
  return { x, y: box.y, width, height: box.height };
}

const within = (inner: Rect, outer: Rect): boolean => inner.x >= outer.x - PLACEMENT_EPS && right(inner) <= right(outer) + PLACEMENT_EPS
  && Math.abs(inner.y - outer.y) <= PLACEMENT_EPS && Math.abs(inner.height - outer.height) <= PLACEMENT_EPS;
const sameRect = (a: Rect, b: Rect): boolean => within(a, b) && within(b, a);

/** The geometry derived from the group boxes: the tier bands, frames and regions, the label bands on them, and the regions again. */
function deriveRegions(model: LayoutModel): void {
  rebuildRegions(model);
  syncLabelBands(model);
  rebuildRegions(model);
}

/** Put back the bodies `nodes` holds, their content, and the fields `trimBodies` saved as text before it changed anything. */
function restoreFields(draft: LayoutModel, nodes: Readonly<Record<string, Rect>>, saved: string): void {
  for (const [id, box] of Object.entries(nodes)) { const node = draft.nodes[id]!; node.bounds = { ...box }; node.size = { width: box.width, height: box.height }; }
  rebuildNodeGeometry(draft, orderedNodeIds(draft.document), 'current');
  const back = JSON.parse(saved) as Record<string, unknown>;
  for (const key of TRIM_FIELDS) { if (key in back) (draft as unknown as Record<string, unknown>)[key] = back[key]; else delete draft[key]; }
}

/**
 * The trim, on the 7f draft, after the tier-gap solve and before the titles. It writes `bodyTrims` when it narrows a body, and leaves the
 * model as it is otherwise. The trim never widens anything: a linked-group grid that would widen a box past the box it had declines the whole
 * trim (`END_TRIM_DECLINED`). A held chord that now leaves a narrower frame by a side edge is not refused: like every 7f move after the
 * freeze, it is named by `STRAIGHT_LINK_EDGE` (`edgeLeavers`, read after the trim) and the gates judge it.
 */
export function trimBodies(draft: LayoutModel): void {
  // Every body is read on the geometry 7f left: no trim reads another.
  const trims: [string, Rect, Rect][] = [];
  for (const id of orderedNodeIds(draft.document)) {
    const box = draft.nodes[id]!.bounds;
    const next = box === undefined ? undefined : trimmedBody(draft, id, box);
    if (next !== undefined) trims.push([id, { ...box! }, next]);
  }
  if (!trims.length) return;
  const saved = JSON.stringify(Object.fromEntries(TRIM_FIELDS.map(key => [key, draft[key]])));
  const boxes = new Map(Object.values(draft.groups).flatMap(group => group.bounds === undefined ? [] : [[group.id, { ...group.bounds }] as const]));
  const nodes: Record<string, Rect> = {};
  for (const [id, box, next] of trims) {
    nodes[id] = box;
    draft.nodes[id]!.bounds = next;
    draft.nodes[id]!.size = { width: next.width, height: next.height };
  }
  rebuildNodeGeometry(draft, orderedNodeIds(draft.document), 'current');
  for (const group of Object.values(draft.groups)) {
    if (!group.nodes.length || group.bounds === undefined || group.nodes.some(id => isBarNode(draft, id))) continue;
    const content = contentBox(draft, group), old = group.bounds;
    const x = Math.max(old.x, content.x), end = Math.min(right(old), right(content));
    if (end - x < old.width - PLACEMENT_EPS) group.bounds = { x, y: old.y, width: end - x, height: old.height };
  }
  // The linked-group grid (ADR-0012) again on the narrower boxes, honouring the pairs it refused: the validator reads the grid on the published model.
  alignLinkedGroupGrid(draft, new Set(draft.gridRefusals ?? []));
  const wider = [...boxes].find(([id, old]) => !within(draft.groups[id]!.bounds!, old));
  if (wider !== undefined) {
    restoreFields(draft, nodes, saved);
    draft.diagnostics.push({ stage: 'placement', severity: 'info', code: 'END_TRIM_DECLINED', owners: [{ kind: 'group', id: wider[0] }],
      message: `The end trim is declined: the linked-group grid would widen the box of ${wider[0]} past the box it had.` });
    return;
  }
  const groups: Record<string, Rect> = {};
  for (const [id, old] of boxes) {
    // A box the trim and the grid left within the placement tolerance keeps its old value exactly: the record names every box that changed.
    if (sameRect(draft.groups[id]!.bounds!, old)) draft.groups[id]!.bounds = old;
    else groups[id] = old;
  }
  deriveRegions(draft);
  draft.bodyTrims = { nodes, groups };
}

/**
 * The geometry the producer decided, for the centring replay: the bodies and boxes `bodyTrims` records, with the geometry derived from them.
 * A model with no record is that geometry already and is returned as it is. The copy has no record and no freeze block (the replay reads neither).
 */
export function untrimmedModel(model: LayoutModel): LayoutModel {
  const trims = model.bodyTrims;
  if (trims === undefined) return model;
  const { freeze: _freeze, bodyTrims: _trims, ...rest } = model;
  void _freeze; void _trims;
  const copy = JSON.parse(JSON.stringify(rest)) as LayoutModel;
  for (const [id, box] of Object.entries(trims.nodes)) { const node = copy.nodes[id]!; node.bounds = { ...box }; node.size = { width: box.width, height: box.height }; }
  rebuildNodeGeometry(copy, orderedNodeIds(copy.document), 'current');
  for (const [id, box] of Object.entries(trims.groups)) copy.groups[id]!.bounds = { ...box };
  deriveRegions(copy);
  return copy;
}

/**
 * Why the record of the trim is not true of the model, or undefined (R5). The record is read, never decided again: each recorded node stands at
 * the body `trimmedBody` gives its recorded body, and each recorded group box holds its box now. Absent = no body was trimmed (a model before 7f
 * publishes, or one the trim left as it was); a present record names at least one node.
 */
export function bodyTrimsFault(model: LayoutModel, beforeBands: boolean): string | undefined {
  const trims = model.bodyTrims;
  if (trims === undefined) return undefined;
  if (beforeBands) return 'a record before 7f';
  if (typeof trims !== 'object' || trims === null || typeof trims.nodes !== 'object' || typeof trims.groups !== 'object' || !Object.keys(trims.nodes).length) return 'malformed';
  const valid = (box: Rect | undefined): box is Rect => box !== undefined && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
  for (const [id, box] of Object.entries(trims.nodes)) {
    const node = model.nodes[id];
    if (node?.bounds === undefined || !valid(box)) return `node ${id}`;
    const next = trimmedBody(model, id, box);
    if (next === undefined || !sameRect(next, node.bounds)) return `node ${id} is not the trim of its recorded body`;
  }
  for (const [id, box] of Object.entries(trims.groups)) {
    const group = model.groups[id];
    if (group?.bounds === undefined || !valid(box) || !within(group.bounds, box) || sameRect(group.bounds, box)) return `group ${id}`;
  }
  return undefined;
}
