import type { BlockBoxPad, BlockRowGap, LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { groupBoxes } from '../score/model.js';
import { chordHolders } from './chord-boxes.js';
import { memberChord } from './block-checks.js';
import { SIDE_EDGE_SLACK } from './frame-paths.js';
import { findPort, STRAIGHT_PATH_CLEARANCE } from './row-paths.js';

/**
 * The side room of a box for the own-box exit of flat block members (dense-16x9 ticket 04, slice 3, step 2).
 *
 * A member of a flat block leaves (or enters) each box that holds one of its ends through the horizontal edge its port faces, at least the
 * margin from the corner, or through the side edge toward its other end, at least the margin below (above) that corner (`chordBoxRefusal`
 * with `sideExit`). Between the two lies a band of angles where the chord meets the corner: the member falls back (`edge`). Its angle stands
 * anywhere from its angle at the block's floor (the flattest it can become) to its angle at the block's 34 degree demand (the steepest).
 * Where the side exit holds at the steepest angle, it holds at every angle and the box asks for nothing. Elsewhere the box takes a side
 * padding on the wall toward the other end so that the chord leaves through the horizontal edge at the floor angle, which holds it at every
 * steeper angle too: the reservation survives any gap the aspect choice takes.
 *
 * Read on a complete placement (`initial.ts`), recorded as `model.blockBoxPads` (a placement input, like `flatBlockGaps`) and consumed from
 * stage 5 on: a free group's insets (`groupInsets`) and a frame's box (`deriveFrames`) hold it. After the freeze the box clearance of every
 * straight member is checked by `blockReservationsFault` (`flatMemberRefusal`), the one judge of the movers (ticket 31).
 */

/** The padding of one box on its two sides (0 where none is recorded). */
export function blockBoxPad(model: Pick<LayoutModel, 'blockBoxPads'>, box: string): { left: number; right: number } {
  let left = 0, right = 0;
  for (const item of model.blockBoxPads ?? []) {
    if (item.box !== box) continue;
    if (item.side === 'left') left = item.pad; else right = item.pad;
  }
  return { left, right };
}

/**
 * The paddings a placed model asks for: the recorded ones, each grown by the largest deficit any member of a flat block still shows on that
 * side of that box (sorted by box, then side; R3). Equal to the record when nothing is short.
 */
export function blockBoxPadsAsked(model: LayoutModel): BlockBoxPad[] {
  // The largest deficit per box and side, over every member; the record grows by it.
  const short = new Map<string, { box: string; side: 'left' | 'right'; deficit: number }>();
  const margin = GROUP_EDGE_LINK_CLEARANCE;
  const boxes = new Map(groupBoxes(model).map(item => [item.id, item.bounds]));
  for (const record of model.blockReservations ?? []) {
    if (record.mode !== 'flat' || record.floor === undefined) continue;
    const upper = model.tierBands.find(band => band.tier === record.above)?.bounds, lower = model.tierBands.find(band => band.tier === record.below)?.bounds;
    if (!upper || !lower) continue;
    const gap = lower.y - upper.y - upper.height;
    for (const link of model.links) {
      if (link.fanFamily !== record.family || !link.attachments) continue;
      // The drawn chord, face point to face point (`memberChord`): the one segment the admission and the restore judge (R1).
      const chord = memberChord(model, link);
      if (chord === undefined) continue;
      const ends = (['from', 'to'] as const).map(end => ({ ref: link.attachments![end], port: findPort(model, link.attachments![end]), at: end === 'from' ? chord.from : chord.to }));
      if (ends.some(end => end.port?.side === undefined)) continue;
      const [a, b] = ends.map(end => end.at);
      const dx = Math.abs(b!.x - a!.x), dy = Math.abs(b!.y - a!.y);
      // The vertical at the floor gap and at the 34 degree demand; the in-band offsets of the two ends do not change with the gap.
      const floorDy = dy - (gap - record.floor), steepDy = dy + Math.max(0, record.target - gap);
      if (dx < EPS || floorDy < EPS) continue;
      const holders = ends.map(end => chordHolders(model, end.ref.node));
      for (const [index, end] of ends.entries()) {
        const other = ends[1 - index]!, side = end.port!.side;
        if (side !== 'top' && side !== 'bottom') continue;
        const anchor = end.at, toward = other.at.x > anchor.x ? 'right' as const : 'left' as const;
        for (const id of holders[index]!) {
          const bounds = boxes.get(id);
          if (bounds === undefined || holders[1 - index]!.has(id)) continue;
          const offset = side === 'bottom' ? bounds.y + bounds.height - anchor.y : anchor.y - bounds.y;
          const wall = toward === 'right' ? bounds.x + bounds.width - anchor.x : anchor.x - bounds.x;
          if (offset < 0 || wall < 0) continue;
          // The side exit at the steepest angle holds at every angle: the box asks for nothing.
          if (offset - wall * steepDy / dx >= margin) continue;
          // A box that is short takes the margin and `SIDE_EDGE_SLACK` more: a placement with the room moves the members a little (the boxes
          // it widens move the far ends), and the slack keeps the next reading from asking again for that drift (the rounds end).
          if (margin + offset * dx / floorDy - wall <= EPS) continue;
          const deficit = margin + SIDE_EDGE_SLACK + offset * dx / floorDy - wall;
          const key = `${id}\0${toward}`;
          if (deficit > (short.get(key)?.deficit ?? 0)) short.set(key, { box: id, side: toward, deficit });
        }
      }
    }
  }
  const asked = new Map((model.blockBoxPads ?? []).map(item => [`${item.box}\0${item.side}`, { ...item }]));
  for (const [key, item] of short) {
    // A small step above the deficit keeps the margin through float noise.
    asked.set(key, { box: item.box, side: item.side, pad: (asked.get(key)?.pad ?? 0) + item.deficit + 2 * EPS });
  }
  return [...asked.values()].sort((x, y) => x.box < y.box ? -1 : x.box > y.box ? 1 : x.side < y.side ? -1 : x.side > y.side ? 1 : 0);
}

/** What a validator checks on `model.blockBoxPads` (R5): sorted by box then side, one entry per pair, a finite positive pad. */
export function blockBoxPadsFault(model: LayoutModel): string | undefined {
  const record = model.blockBoxPads;
  if (record === undefined) return undefined;
  if (!record.length) return 'the block box paddings are recorded empty';
  for (const [index, item] of record.entries()) {
    if (typeof item.box !== 'string' || (item.side !== 'left' && item.side !== 'right') || !Number.isFinite(item.pad) || item.pad <= 0) return `the block box padding of ${item.box} is unreadable`;
    const previous = record[index - 1];
    if (previous !== undefined && (previous.box > item.box || (previous.box === item.box && previous.side >= item.side))) return 'the block box paddings are out of order';
  }
  return undefined;
}

/**
 * The row gap a flat block member asks between its end node and the next node of that row toward its other end (dense-16x9 ticket 04, slice
 * 3, step 2). A neighbour that reaches past the end's block face (a taller hub beside it, its bottom below the face) has a corner the chord
 * passes: at the member's floor angle t the corner stands `D sin t - drop cos t` from the chord, D the run from the port to the corner along
 * the face. The gap holds the node clearance there: `gap >= (clearance + drop cos t) / sin t - inset`, the inset the run from the port to its
 * own node's edge. At any steeper angle the corner stands farther. Read on the complete placement with the box paddings; recorded as
 * `model.blockRowGaps` and consumed by `rowGap` from stage 6 on. Sorted by the left node, then the right one; the record grows only.
 */
export function blockRowGapsAsked(model: LayoutModel): BlockRowGap[] {
  const asked = new Map((model.blockRowGaps ?? []).map(item => [`${item.left}\0${item.right}`, { ...item }]));
  for (const record of model.blockReservations ?? []) {
    if (record.mode !== 'flat' || record.floor === undefined) continue;
    const upper = model.tierBands.find(band => band.tier === record.above)?.bounds, lower = model.tierBands.find(band => band.tier === record.below)?.bounds;
    if (!upper || !lower) continue;
    const gap = lower.y - upper.y - upper.height;
    for (const link of model.links) {
      if (link.fanFamily !== record.family || !link.attachments) continue;
      // The drawn chord, face point to face point (`memberChord`): the one segment the admission and the restore judge (R1).
      const chord = memberChord(model, link);
      if (chord === undefined) continue;
      const ends = (['from', 'to'] as const).map(end => ({ ref: link.attachments![end], port: findPort(model, link.attachments![end]), at: end === 'from' ? chord.from : chord.to }));
      if (ends.some(end => end.port?.side === undefined)) continue;
      const [a, b] = ends.map(end => end.at);
      const dx = Math.abs(b!.x - a!.x), floorDy = Math.abs(b!.y - a!.y) - (gap - record.floor);
      if (dx < EPS || floorDy < EPS) continue;
      const length = Math.hypot(dx, floorDy), sin = floorDy / length, cos = dx / length;
      for (const [index, end] of ends.entries()) {
        const face = end.port!.side, node = model.nodes[end.ref.node]!, body = node.bounds;
        if ((face !== 'top' && face !== 'bottom') || body === undefined) continue;
        const anchor = end.at, toward = ends[1 - index]!.at.x > anchor.x ? 1 : -1;
        const group = model.document.nodes[end.ref.node]?.group, row = group === undefined ? [] : model.groups[group]?.nodes ?? [];
        // The next node of the row toward the other end: overlapping the node's height, nearest beyond its edge.
        const edge = toward > 0 ? body.x + body.width : body.x;
        let next: { id: string; gap: number } | undefined;
        for (const id of row) {
          const other = model.nodes[id]?.bounds;
          if (id === end.ref.node || other === undefined || other.y > body.y + body.height || other.y + other.height < body.y) continue;
          const between = toward > 0 ? other.x - edge : edge - other.x - other.width;
          if (between >= -EPS && (next === undefined || between < next.gap)) next = { id, gap: between };
        }
        if (next === undefined) continue;
        const other = model.nodes[next.id]!.bounds!;
        // The corner's reach past the point the chord starts from (the face point: the anchor, or a pill's outer edge).
        const drop = face === 'bottom' ? other.y + other.height - anchor.y : anchor.y - other.y;
        const inset = toward > 0 ? edge - anchor.x : anchor.x - edge;
        const clearance = STRAIGHT_PATH_CLEARANCE.node + (linkStrokeWidth(link) + (model.nodes[next.id]!.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node)) / 2;
        if ((clearance + drop * cos) / sin - inset <= next.gap + EPS) continue;
        // A short gap takes `SIDE_EDGE_SLACK` more in the clearance, for the same drift as the box room.
        const need = (clearance + SIDE_EDGE_SLACK + drop * cos) / sin - inset;
        const [left, right] = toward > 0 ? [end.ref.node, next.id] : [next.id, end.ref.node];
        const key = `${left}\0${right}`, known = asked.get(key);
        // A small step above the need keeps the clearance through float noise.
        if (known === undefined || need + 2 * EPS > known.gap) asked.set(key, { left, right, gap: Math.max(need + 2 * EPS, known?.gap ?? 0) });
      }
    }
  }
  return [...asked.values()].sort((x, y) => x.left < y.left ? -1 : x.left > y.left ? 1 : x.right < y.right ? -1 : x.right > y.right ? 1 : 0);
}

/** What a validator checks on `model.blockRowGaps` (R5): sorted by the left node then the right one, one entry per pair, a finite positive gap. */
export function blockRowGapsFault(model: LayoutModel): string | undefined {
  const record = model.blockRowGaps;
  if (record === undefined) return undefined;
  if (!record.length) return 'the block row gaps are recorded empty';
  for (const [index, item] of record.entries()) {
    if (typeof item.left !== 'string' || typeof item.right !== 'string' || !Number.isFinite(item.gap) || item.gap <= 0) return `the block row gap of ${item.left} and ${item.right} is unreadable`;
    const previous = record[index - 1];
    if (previous !== undefined && (previous.left > item.left || (previous.left === item.left && previous.right >= item.right))) return 'the block row gaps are out of order';
  }
  return undefined;
}

/** The row gap the record asks between two neighbours, `a` left of `b` (0 where none). */
export function blockRowGap(model: Pick<LayoutModel, 'blockRowGaps'>, a: string, b: string): number {
  return model.blockRowGaps?.find(item => item.left === a && item.right === b)?.gap ?? 0;
}
