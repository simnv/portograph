/**
 * The end trim (architecture-2 ticket 68, user 2026-11-04): after the last x move of 7f, a node body is trimmed to the span of its ports with
 * their end insets, plus its label, icon and padding, never below its stage-3 size. Ports keep their x, no node moves; the group boxes, the
 * linked-group grid, the tier bands, the frames, the regions and the label bands are derived again, and the titles are placed after it.
 *
 * The trim is decided once and recorded (`LayoutModel.bodyTrims`, R1): the body and the box each trimmed node and group had at the end of 7f.
 * The centring replay of the publication check reads that geometry (`untrimmedModel`), the one its producer decided on, and never the narrower
 * bodies the trim left: a narrower sibling would let a replay keep a target the producer could not keep.
 */
import type { LayoutGroup, LayoutModel, Rect } from '../model/index.js';
import { orderedNodeIds } from '../model/model.js';
import { contentBox, groupInsets, rebuildRegions, right } from './regions.js';
import { union } from './skeleton-geometry.js';
import { portEndInsets, portSideCapacity } from './port-insets.js';
import { measureNodeContent } from './size.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { alignLinkedGroupGrid, forgedRefusals, syncLabelBands } from './bands.js';
import { validateLanes } from './lanes.js';
import { PLACEMENT_EPS } from './tolerance.js';

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

/**
 * The box of a group after the trim: as wide as its content (`contentBox`: the bodies, the insets and the title floor), inside the box it had,
 * and holding the bodies with their insets. The content box stands centred on the bodies; where that would leave the old box, it slides in.
 * Undefined when the content is not narrower than the box.
 */
function shrunkBox(model: LayoutModel, group: LayoutGroup): Rect | undefined {
  const old = group.bounds!, content = contentBox(model, group);
  if (content.width >= old.width - PLACEMENT_EPS) return undefined;
  const bodies = union(group.nodes.map(id => model.nodes[id]!.bounds!)), inset = groupInsets(model, group);
  const low = Math.max(old.x, right(bodies) + inset.right - content.width), high = Math.min(right(old) - content.width, bodies.x - inset.left);
  if (high < low - PLACEMENT_EPS) return undefined;
  const x = Math.min(Math.max(content.x, low), high);
  return { x, y: old.y, width: content.width, height: old.height };
}

/** The geometry derived from the group boxes: the tier bands, frames and regions, the label bands on them, and the regions again. Returns
 * whether a label band changed its clearance, which asks for a reservation the trim does not make. */
function deriveRegions(model: LayoutModel): boolean {
  rebuildRegions(model);
  const changed = syncLabelBands(model);
  rebuildRegions(model);
  return changed;
}

/** Why the trimmed draft would not publish as the transaction leaves it, or undefined: the checks of what the trim moves no further (R2). */
function trimRefusal(draft: LayoutModel, boxes: ReadonlyMap<string, Rect>, bodies: ReadonlyMap<string, Rect>, bandsChanged: boolean): string | undefined {
  // The grid may grow a box onto the extent of a linked partner (ADR-0012, its own guards hold), but it may move no node and widen no drawing.
  const moved = [...bodies].find(([id, old]) => !within(draft.nodes[id]!.bounds!, old));
  if (moved !== undefined) return `the linked-group grid would move the node ${moved[0]}`;
  const taller = [...boxes].find(([id, old]) => { const now = draft.groups[id]!.bounds!; return Math.abs(now.y - old.y) > PLACEMENT_EPS || Math.abs(now.height - old.height) > PLACEMENT_EPS; });
  if (taller !== undefined) return `the linked-group grid would change the height of ${taller[0]}`;
  const extent = (rects: Iterable<Rect>): [number, number] => { let low = Infinity, high = -Infinity; for (const rect of rects) { low = Math.min(low, rect.x); high = Math.max(high, right(rect)); } return [low, high]; };
  const [low, high] = extent(boxes.values()), [nowLow, nowHigh] = extent([...boxes.keys()].map(id => draft.groups[id]!.bounds!));
  if (nowLow < low - PLACEMENT_EPS || nowHigh > high + PLACEMENT_EPS) return 'the linked-group grid would widen the drawing';
  if (bandsChanged) return 'a label band would change its clearance';
  const refusals = new Set(draft.gridRefusals ?? []), forged = refusals.size ? forgedRefusals(draft, refusals) : [];
  if (forged.length) return `the grid refusals ${forged.join(', ')} would no longer hold`;
  // A lane whose x a box derives (a trunk, a bypass stem) would contradict the narrower boxes; the lanes do not move.
  try { validateLanes(draft); } catch (error) { return `a lane would contradict the boxes: ${error instanceof Error ? error.message : String(error)}`; }
  return undefined;
}

/**
 * The trim, on the 7f draft, after the tier-gap solve and before the titles. It writes `bodyTrims` when it narrows a body, and leaves the
 * model as it is otherwise. The linked-group grid may grow a box onto the extent of a linked partner, as its rule says (ADR-0012). The trim
 * moves nothing further: a trim whose grid would move a node or widen the drawing, or that would change a label band's clearance, end a grid
 * refusal or contradict a lane, is declined whole (`END_TRIM_DECLINED`, with the reason) and the draft is the one 7f left. A held chord that now
 * leaves a narrower frame by a side edge is not refused: like every 7f move after the freeze, it is named by `STRAIGHT_LINK_EDGE`
 * (`edgeLeavers`, read after the trim) and the gates judge it.
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
  // The draft as 7f left it, put back whole when the trim is declined: the grid may move a flank, its nodes and its lanes.
  const saved = JSON.stringify(draft);
  const boxes = new Map(Object.values(draft.groups).flatMap(group => group.bounds === undefined ? [] : [[group.id, { ...group.bounds }] as const]));
  const bodies = new Map(Object.values(draft.nodes).flatMap(node => node.bounds === undefined ? [] : [[node.id, { ...node.bounds }] as const]));
  const nodes: Record<string, Rect> = {};
  for (const [id, box, next] of trims) {
    nodes[id] = box;
    draft.nodes[id]!.bounds = next;
    draft.nodes[id]!.size = { width: next.width, height: next.height };
  }
  rebuildNodeGeometry(draft, orderedNodeIds(draft.document), 'current');
  for (const group of Object.values(draft.groups)) {
    if (!group.nodes.length || group.bounds === undefined || group.nodes.some(id => isBarNode(draft, id))) continue;
    const next = shrunkBox(draft, group);
    if (next !== undefined) group.bounds = next;
  }
  // The linked-group grid (ADR-0012) again on the narrower boxes, honouring the pairs it refused: the validator reads the grid on the published model.
  alignLinkedGroupGrid(draft, new Set(draft.gridRefusals ?? []));
  const groups: Record<string, Rect> = {};
  for (const [id, old] of boxes) {
    // A box the trim and the grid left within the placement tolerance keeps its old value exactly: the record names every box that changed.
    if (sameRect(draft.groups[id]!.bounds!, old)) draft.groups[id]!.bounds = old;
    else groups[id] = old;
  }
  const refusal = trimRefusal(draft, boxes, bodies, deriveRegions(draft));
  if (refusal !== undefined) {
    const back = JSON.parse(saved) as Record<string, unknown>, target = draft as unknown as Record<string, unknown>;
    for (const key of Object.keys(target)) if (!(key in back)) delete target[key];
    Object.assign(target, back);
    draft.diagnostics.push({ stage: 'placement', severity: 'info', code: 'END_TRIM_DECLINED', message: `The end trim is declined: ${refusal}.` });
    return;
  }
  draft.bodyTrims = { nodes, groups };
}

/**
 * The geometry the producer decided, for the centring replay and the validator: the bodies and boxes `bodyTrims` records, with the geometry
 * derived from them. A model with no record is that geometry already and is returned as it is. The copy has no record; it shares the freeze
 * block of the model (no reader writes it).
 */
export function untrimmedModel(model: LayoutModel): LayoutModel {
  const trims = model.bodyTrims;
  if (trims === undefined) return model;
  const { freeze, bodyTrims: _trims, ...rest } = model;
  void _trims;
  const copy = JSON.parse(JSON.stringify(rest)) as LayoutModel;
  if (freeze !== undefined) copy.freeze = freeze;
  for (const [id, box] of Object.entries(trims.nodes)) { const node = copy.nodes[id]; if (node !== undefined) { node.bounds = { ...box }; node.size = { width: box.width, height: box.height }; } }
  rebuildNodeGeometry(copy, orderedNodeIds(copy.document), 'current');
  for (const [id, box] of Object.entries(trims.groups)) { const group = copy.groups[id]; if (group !== undefined) group.bounds = { ...box }; }
  deriveRegions(copy);
  return copy;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < right(b) - PLACEMENT_EPS && b.x < right(a) - PLACEMENT_EPS
  && a.y < b.y + b.height - PLACEMENT_EPS && b.y < a.y + a.height - PLACEMENT_EPS;

/**
 * Why the record of the trim is not true of the model, or undefined (R5). The record is read, never decided again; it is checked as a whole:
 * - its shape, and a record before 7f is refused;
 * - the untrimmed geometry is a placement: each recorded body stands inside its group's box there, and no two bodies overlap;
 * - it is the fixed point of the producer: the trim of the untrimmed geometry gives this record again, name for name, and the bodies and boxes
 *   that publish.
 * Absent = no body was trimmed (a model before 7f publishes, one whose bodies need no trim, or a declined trim); a present record names at
 * least one node.
 */
export function bodyTrimsFault(model: LayoutModel, beforeBands: boolean): string | undefined {
  return checkBodyTrims(model, beforeBands).fault;
}
/** `bodyTrimsFault`, and the untrimmed geometry it built, for the centring replay of the same publication to read (one copy, not two). */
export function checkBodyTrims(model: LayoutModel, beforeBands: boolean): { fault?: string; untrimmed?: LayoutModel } {
  const fault = (text: string): { fault: string } => ({ fault: text });
  const trims = model.bodyTrims;
  if (trims === undefined) return {};
  if (beforeBands) return fault('a record before 7f');
  if (typeof trims !== 'object' || trims === null || typeof trims.nodes !== 'object' || trims.nodes === null || typeof trims.groups !== 'object'
    || trims.groups === null || !Object.keys(trims.nodes).length) return fault('malformed');
  const valid = (box: Rect | undefined): boolean => typeof box === 'object' && box !== null && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
  for (const [id, box] of Object.entries(trims.nodes)) if (model.nodes[id]?.bounds === undefined || !valid(box)) return fault(`node ${id}`);
  for (const [id, box] of Object.entries(trims.groups)) if (model.groups[id]?.bounds === undefined || !valid(box)) return fault(`group ${id}`);
  // A recorded body that does not hold its node's ports or content cannot be built: that is a finding, named (R6).
  let back: LayoutModel;
  try { back = untrimmedModel(model); } catch (error) { return fault(`the recorded geometry cannot be built: ${error instanceof Error ? error.message : String(error)}`); }
  const bodies = orderedNodeIds(model.document).map(id => [id, back.nodes[id]!.bounds!] as const);
  for (const [id, body] of bodies) {
    if (!(id in trims.nodes)) continue;
    const group = Object.values(back.groups).find(item => item.nodes.includes(id))?.bounds;
    if (group !== undefined && !(body.x >= group.x - PLACEMENT_EPS && right(body) <= right(group) + PLACEMENT_EPS)) return fault(`node ${id} stands outside its group box before the trim`);
    for (const [other, box] of bodies) if (other !== id && overlaps(body, box)) return fault(`node ${id} overlaps ${other} before the trim`);
  }
  // A recorded box overlaps no box it stands apart from in the published model.
  for (const id of Object.keys(trims.groups)) {
    const box = back.groups[id]!.bounds!, now = model.groups[id]!.bounds!;
    for (const other of Object.values(model.groups)) {
      if (other.id === id || other.bounds === undefined || overlaps(now, other.bounds)) continue;
      if (overlaps(box, back.groups[other.id]!.bounds!)) return fault(`group ${id} overlaps ${other.id} before the trim`);
    }
  }
  const again = JSON.parse(JSON.stringify(back)) as LayoutModel;
  if (model.freeze !== undefined) again.freeze = model.freeze;
  trimBodies(again);
  const names = (record: Record<string, Rect> | undefined): string => JSON.stringify(Object.keys(record ?? {}).sort());
  if (names(again.bodyTrims?.nodes) !== names(trims.nodes)) return fault('the trim of the untrimmed geometry names other nodes');
  if (names(again.bodyTrims?.groups) !== names(trims.groups)) return fault('the trim of the untrimmed geometry names other groups');
  for (const id of Object.keys(model.nodes)) if (!sameRect(again.nodes[id]!.bounds!, model.nodes[id]!.bounds!)) return fault(`node ${id} is not the trim of its recorded body`);
  for (const id of Object.keys(model.groups)) if (!sameRect(again.groups[id]!.bounds!, model.groups[id]!.bounds!)) return fault(`group ${id} is not the trim of its recorded box`);
  return { untrimmed: back };
}
