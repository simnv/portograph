import { frameSubtreeCells } from '../model/model.js';
import type { Rect } from '../model/geometry.js';
import type { Frame, Lane, LayoutLink, LayoutModel } from '../model/layout.js';
import { GROUP_PADDING, groupPadding } from './regions.js';
import { union } from './skeleton-geometry.js';
import { laneRunKind } from './lane-kind.js';

/**
 * The gap between a child frame and a cell that stands beside it on a row, a cell of its parent or of a sibling child frame
 * (`besideWalls` reads both): the child's box ends `GROUP_PADDING` from the cell's `cellReach` (`packBesideRows`), not from the cell box. `cellReach` already grows the bodies by the cell's own
 * padding and `GROUP_PADDING` on each side, so the gap from the cell *box* to the child frame is 40 px where the cell box stands
 * tight to its bodies (`four-locations-each-with-a-zone`) and 20 px where a grid or a label made the box wider than its bodies
 * (loc4 and loc5 of the NTP sheet). One value, two measured gaps: the shadow-solver probe found neither in the code, and read
 * 20 and 40 off the published model.
 */
/** A lane with no `kind` is a transit lane (a riser lane too, read by its owner). Side, gap and perimeter lanes grow no frame. */
export const isTransitKind = (lane: Lane): boolean => laneRunKind(lane) === 'transit';
export const CELL_TO_CHILD_FRAME_GAP = GROUP_PADDING;

/**
 * The gap between two frame boxes side by side inside one parent, a canton included: each box keeps `GROUP_PADDING` of margin, and
 * the margins do not overlap, so the boxes end `2 * GROUP_PADDING` apart. `packBesideRows` packs two children by it, and the member
 * walls of a canton (`memberSpace`, the 7f slide guard) keep it from the member frames of their sub-tier. A frame beside a plain
 * group keeps a band gap instead (`runSpacing` in `columns.ts`).
 */
export const FRAME_TO_FRAME_GAP = 2 * GROUP_PADDING;

/**
 * A cell as its frame sees it: its nodes grown by the ordinary margin (and any pill reach) on the two
 * sides, and its own vertical extent, because the top and bottom margins are held inside the cell box.
 * A cell box that is wider than that (the linked-group grid, ADR-0012, widens cells) widens the frame
 * too, so the frame always holds its cells; otherwise the frame edge stands 20 px from the outermost body.
 */
export function cellReach(model: LayoutModel, id: string): Rect {
  const group = model.groups[id]!, box = group.bounds!, pad = groupPadding(model, group);
  const bodies = group.nodes.map(node => model.nodes[node]!.bounds!);
  if (!bodies.length) return { x: box.x - GROUP_PADDING, y: box.y, width: box.width + 2 * GROUP_PADDING, height: box.height };
  // A cell box wider than its bodies (the linked-group grid, a label) is part of the frame; the column
  // clearance of `columnReach` moves boxes and never widens them, so it stays out.
  const x = Math.min(box.x, Math.min(...bodies.map(body => body.x)) - pad.left - GROUP_PADDING);
  const end = Math.max(box.x + box.width, Math.max(...bodies.map(body => body.x + body.width)) + pad.right + GROUP_PADDING);
  return { x, y: box.y, width: end - x, height: box.height };
}
const grow = (box: Rect, by: number): Rect => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });

/**
 * Derive `model.frames` from cell geometry, the way `rebuildBands` derives tier bands
 * (docs/design/ranked-groups.md, section 2). One frame per `document.frames` entry, in document order.
 *
 * A cell carries no padding of its own. The frame margin (20 px) stands on the frame's two sides here,
 * and on its top and bottom edge inside the first and the last cell, where tier bands and gap rows
 * see it; the label band of the title lives in one own cell (`labelBands[].host`) and widens that
 * margin. A child frame is the union of its span's cells; the parent's box holds its own cells and
 * the child's box grown by group padding.
 * `tier` is the sub-tier of the frame's top cell.
 *
 * Nothing happens for a document without `frames`. Call it wherever group boxes move; `rebuildBands`
 * does, so every producer that rebuilds bands rebuilds frames with them.
 */
export function rebuildFrames(model: LayoutModel): void {
  const frames = deriveFrames(model);
  if (frames !== undefined) model.frames = frames;
}

/** The frames `rebuildFrames` would store, read off the cells as they stand; `undefined` while a cell has no box. */
export function deriveFrames(model: LayoutModel, withBands = true): Frame[] | undefined {
  const entries = Object.entries(model.document.frames ?? {});
  if (!entries.length) return undefined;
  // Cells are placed a tier at a time in stage 4; frames wait for every cell to have its box.
  if (entries.some(([, item]) => item.cells.some(cell => model.groups[cell]?.bounds === undefined))) return undefined;
  const derived = new Map<string, Frame>();
  const build = (id: string): Frame => {
    const known = derived.get(id);
    if (known) return known;
    const source = model.document.frames![id]!;
    const cells = source.cells;
    const children = entries.filter(([, item]) => item.parent === id).map(([child]) => build(child));
    const boxes = [...cells.map(cell => cellReach(model, cell)), ...children.map(child => grow(child.box, GROUP_PADDING)), ...transitLanes(model, id)];
    const tiers = [...cells.map(cell => model.groups[cell]!.tier!), ...children.map(child => child.tier)];
    // A canton's title band is held by its sub-tier, not by a cell (canton-groups ticket 3): the frame is the
    // union of its members grown by the margin, plus the band on the title edge.
    const band = withBands && source.kind === 'canton' ? model.labelBands.find(item => item.group === id && item.host === undefined) : undefined;
    let box = union(boxes);
    // An across-frames bus band on the canton's outer edge lies between the member frames and the canton's title band (mesh-bus.md,
    // section 4): the canton box grows by it, and the title band moves out by it.
    if (source.kind === 'canton') {
      const all = frameSubtreeCells(model.document.frames ?? {}, id).map(cell => model.groups[cell]!.tier!);
      for (const held of model.busBands ?? []) {
        const bus = model.meshBuses?.find(item => item.id === held.bus);
        if (bus?.placement !== 'across-frames' || bus.row !== (held.side === 'top' ? Math.min(...all) : Math.max(...all))) continue;
        if (held.bounds.x >= box.x + box.width || held.bounds.x + held.bounds.width <= box.x) continue;
        box = held.side === 'top' ? { ...box, y: box.y - held.bounds.height, height: box.height + held.bounds.height } : { ...box, height: box.height + held.bounds.height };
      }
    }
    if (band !== undefined) {
      const room = band.bounds.height;
      box = band.side === 'top' ? { ...box, y: box.y - room, height: box.height + room } : { ...box, height: box.height + room };
    }
    const frame: Frame = { id, label: source.label, ...(source.class !== undefined ? { class: source.class } : {}),
      ...(source.kind !== undefined ? { kind: source.kind } : {}), ...(source.parent !== undefined ? { parent: source.parent } : {}), cells: [...source.cells],
      box, tier: Math.min(...tiers) };
    derived.set(id, frame);
    return frame;
  };
  return entries.map(([id]) => build(id));
}

/**
 * The lanes a frame holds (ticket 04, transit through a frame). A link that ends in a cell of the
 * frame, or of a child frame, is not foreign to it (ADR-0013), so the lane it owns beside one of the
 * frame's cells is part of the frame: the frame grows to hold it. A lane of a link foreign to the frame
 * stands outside the frame (`frameReach`) and never enters here. Each lane is a rectangle as high as the
 * cell it stands beside, so it widens the frame and never lengthens it.
 */
function transitLanes(model: LayoutModel, id: string): Rect[] {
  if (!model.lanes.length) return [];
  const cells = new Set(frameCells(model, id)), inside = new Set(frameNodes(model, id));
  const boxes: Rect[] = [];
  for (const lane of model.lanes) {
    // A riser lane stands inside the frames that hold a member of either bus; the frame grows to hold it (mesh-bus.md, section 11.5).
    if (lane.kind === 'perimeter' || lane.kind === 'gap') continue;
    if (lane.owner.kind === 'mesh-bus' && cells.has(lane.group)) {
      const ownerId = lane.owner.id, bus = model.meshBuses?.find(item => item.id === ownerId);
      const other = model.meshBuses?.find(item => item.id === bus?.joined);
      if (bus && [...bus.nodes, ...(other?.nodes ?? [])].some(node => inside.has(node))) {
        const box = model.groups[lane.group]!.bounds!;
        boxes.push({ x: lane.bounds.x, y: box.y, width: lane.bounds.width, height: box.height });
      }
      continue;
    }
    // A side, column-gap or perimeter lane stands outside the frame of its end and never grows it (side-faces.md, Section 10; ticket 15): this reader serves transit lanes only.
    if (!cells.has(lane.group) || lane.owner.kind !== 'link' || !isTransitKind(lane)) continue;
    const owner = lane.owner.id;
    const link = model.links.find(item => item.id === owner);
    if (!link?.attachments || ![link.attachments.from.node, link.attachments.to.node].some(node => inside.has(node))) continue;
    const box = model.groups[lane.group]!.bounds!;
    boxes.push({ x: lane.bounds.x, y: box.y, width: lane.bounds.width, height: box.height });
  }
  return boxes;
}

/**
 * The cells of every frame a link ends in (ticket 04): the cells that may host the link's own transit
 * lane, because `transitLanes` grows a frame only for a lane hosted in one of its cells.
 */
export function ownFrameCells(model: LayoutModel, link: LayoutLink): Set<string> {
  const ends = link.attachments ? [link.attachments.from.node, link.attachments.to.node] : [];
  const cells = new Set<string>();
  for (const id of Object.keys(model.document.frames ?? {})) {
    const nodes = new Set(frameNodes(model, id));
    if (ends.some(node => nodes.has(node))) for (const cell of frameCells(model, id)) cells.add(cell);
  }
  return cells;
}

/** The frame's own cells and the cells of every frame below it (a canton reads its members' and their children's). */
function frameCells(model: LayoutModel, frame: string): string[] {
  return frameSubtreeCells(model.document.frames ?? {}, frame);
}

/**
 * The x-extent a link that is foreign to a cell's frame must stay outside: where the edge of the
 * outermost frame the link is foreign to stands beside the cell (ADR-0013, ticket 04). That edge is the
 * cell's own sides, plus one margin more for each parent frame around it. A link that ends inside the
 * outermost frame is foreign to none, so nothing is reserved beyond the bodies: its lane may stand inside
 * the frame, and `rebuildFrames` grows the frame to hold it. Per cell, so it moves with the cell when a
 * lane pushes the cell aside. The x of a foreign lane is one x for the whole frame, decided by the lane
 * allocation over every cell of the frame (`foreignRoot`), so a wider cell at another sub-tier is already
 * outside it. Undefined for a group that is no cell, or a link with no foreign frame.
 */
export function foreignReach(model: LayoutModel, cell: string, link: LayoutLink): Rect | undefined {
  const found = foreignFrame(model, cell, link);
  if (!found) return undefined;
  const own = cellReach(model, cell);
  return { ...own, x: own.x - found.outer * GROUP_PADDING, width: own.width + 2 * found.outer * GROUP_PADDING };
}

/**
 * The outermost frame a link is foreign to, seen from one cell, and how many parents that frame stands
 * above the cell's own frame. Undefined for a group that is no cell, or a link with no foreign frame.
 */
function foreignFrame(model: LayoutModel, cell: string, link: LayoutLink): { frame: string; outer: number } | undefined {
  if (!link.attachments) return undefined;
  return foreignFrameOf(model, cell, [link.attachments.from.node, link.attachments.to.node]);
}
/** The same for any set of nodes: a frame is foreign to a set that has no node inside it (the riser's ends are the members of both buses). */
function foreignFrameOf(model: LayoutModel, cell: string, ends: string[]): { frame: string; outer: number } | undefined {
  const frames = model.document.frames;
  const first = model.document.groups[cell]?.frame;
  if (!frames || first === undefined) return undefined;
  const chain: string[] = [];
  for (let id: string | undefined = first; id !== undefined; id = frames[id]?.parent) chain.push(id);
  // A parent holds every node of its child, so a link foreign to a parent is foreign to the child too.
  let outer = -1;
  chain.forEach((id, index) => { if (!ends.some(node => frameNodes(model, id).includes(node))) outer = index; });
  return outer < 0 ? undefined : { frame: chain[outer]!, outer };
}

/** `foreignReach` for a mesh bus riser: the frames that hold no member of either bus are foreign to it (mesh-bus.md, section 11.5). */
export function riserForeignReach(model: LayoutModel, cell: string, members: string[]): Rect | undefined {
  const found = foreignFrameOf(model, cell, members);
  if (!found) return undefined;
  const own = cellReach(model, cell);
  return { ...own, x: own.x - found.outer * GROUP_PADDING, width: own.width + 2 * found.outer * GROUP_PADDING };
}

/**
 * The frame a link must stay outside at this cell: the outermost frame the link is foreign to. The
 * lane allocation reserves one x per such frame for the whole crossing (ticket 04), not one per cell.
 */
export function foreignRoot(model: LayoutModel, cell: string, link: LayoutLink): string | undefined {
  return foreignFrame(model, cell, link)?.frame;
}

/**
 * The room a lane of another link already takes in the frame a link must stay outside (ticket 14). A link
 * that ends in a frame keeps its lane beside one of that frame's cells, and `transitLanes` grows the frame
 * to hold it, so a later link foreign to the frame must stand outside the frame as it will be, not as the
 * bare cells make it. The lane's rectangle, plus one margin for every parent frame between the frame that
 * holds it and the outermost frame the link is foreign to, is that room. Undefined when the link is foreign
 * to no frame of the cell, or `lane` stands in no frame the link is foreign to.
 */
export function heldLaneReach(model: LayoutModel, cell: string, link: LayoutLink, lane: Lane, laneOwner: LayoutLink | undefined): Rect | undefined {
  const frames = model.document.frames, first = model.document.groups[cell]?.frame;
  // A side, column-gap or perimeter lane grows no frame, so no foreign lane keeps a frame's room for it.
  if (!frames || first === undefined || lane.group !== cell || !isTransitKind(lane) || !laneOwner?.attachments || laneOwner.id === link.id) return undefined;
  const found = foreignFrame(model, cell, link);
  if (!found) return undefined;
  const ends = [laneOwner.attachments.from.node, laneOwner.attachments.to.node], chain: string[] = [];
  for (let id: string | undefined = first; id !== undefined; id = frames[id]?.parent) chain.push(id);
  const holder = chain.findIndex(id => ends.some(node => frameNodes(model, id).includes(node)));
  if (holder < 0 || holder > found.outer) return undefined;
  const margin = (found.outer - holder) * GROUP_PADDING;
  return { x: lane.bounds.x - margin, y: lane.bounds.y, width: lane.bounds.width + 2 * margin, height: lane.bounds.height };
}

/** The frames of a model, empty when no group was replaced by cells. */
export const framesOf = (model: LayoutModel): readonly Frame[] => model.frames ?? [];

/** Every node a frame holds: its own cells' and those of every frame below it. */
export function frameNodes(model: LayoutModel, frame: string): string[] {
  return frameCells(model, frame).flatMap(cell => model.groups[cell]?.nodes ?? []);
}
