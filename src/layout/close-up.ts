/**
 * The close-up (architecture-2 ticket 69): after the end trim, a leaf top-level group moves toward its sibling on its left by at most the
 * width the trim freed, its order kept, when no guard declines. The move is a decision of the `bands` producer, recorded with the trim
 * (`bodyTrims.shifts`, `bodyTrims.laneShifts`, R1): the centring replay reads the geometry before it (`untrimmedModel`).
 *
 * It runs after the last move in x of 7f (ticket 68): before the chord freeze, every centring replay of the 7f rounds reads a lane's x as its
 * feed's x and moves the group back (experiment `closeup/report.md`, the early variant). So it moves nothing that placement reserved: a move
 * that needs room the gaps, lanes, chords and labels did not reserve is declined whole, and the next group is tried.
 */
import type { LayoutGroup, LayoutLink, LayoutModel, LayoutPort, Rect } from '../model/index.js';
import { orderedNodeIds } from '../model/model.js';
import { findPort } from './row-paths.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { rebuildRegions, right } from './regions.js';
import { moveGroup } from './skeleton-geometry.js';
import { bandGap } from './skeleton-graph.js';
import { occupiedOverhang, validateLanes } from './lanes.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { alignLinkedGroupGrid, forgedRefusals, gapLabelDeficits, roomHolds, syncLabelBands } from './bands.js';
import { blockedChords, edgeLeavers } from './frame-paths.js';
import { holds } from './reservation-checks.js';
import { tierGapPlans } from './gap-plan.js';
import { straightChordIds } from './read/overlay-straight.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** A move shorter than this is not made: it would narrow nothing a reader sees, and every move costs a full set of guards. */
export const CLOSE_UP_MIN = 1;

/** What the close-up decided: the shift of each moved group and of each lane that followed one, and each declined group with its guard. */
export interface CloseUp { groups: Record<string, number>; lanes: Record<string, number>; declined: string[] }

/** The boxes before the trim that a mover keeps its gap to: the group boxes and the frame boxes, by id. */
export interface BeforeTrim { groups: ReadonlyMap<string, Rect>; frames: ReadonlyMap<string, Rect> }

/**
 * Whether `group` may close up: a top-level group (no frame cell, no flank) with no cells of its own and no `bar` shape. One function for the
 * producer and the record check (R1).
 */
export function isCloseUpMover(model: LayoutModel, group: LayoutGroup): boolean {
  return group.frame === undefined && group.flank === undefined && group.tier !== undefined && group.bounds !== undefined
    && model.document.groups[group.id]?.shape !== 'bar' && !Object.values(model.groups).some(other => other.frame === group.id);
}

const overlapsY = (a: Rect, b: Rect): boolean => a.y < b.y + b.height - PLACEMENT_EPS && b.y < a.y + a.height - PLACEMENT_EPS;
const overlaps = (a: Rect, b: Rect): boolean => overlapsY(a, b) && a.x < right(b) - PLACEMENT_EPS && b.x < right(a) - PLACEMENT_EPS;

/** The two ports of a link, read on the model; undefined for an end that names no port with an anchor. */
function ends(model: LayoutModel, link: LayoutLink): (LayoutPort | undefined)[] {
  const refs = link.attachments === undefined ? [link.from, link.to] : [link.attachments.from, link.attachments.to];
  return refs.map(ref => 'node' in ref && typeof ref.node === 'string' ? findPort(model, ref) : undefined).map(port => port?.anchor === undefined ? undefined : port);
}

/** Every pair of boxes (groups and frames) that overlap, keyed `a|b` with `a < b`. */
function overlappingPairs(model: LayoutModel): Set<string> {
  const boxes: [string, Rect][] = [
    ...Object.values(model.groups).flatMap(group => group.bounds === undefined ? [] : [[`group:${group.id}`, group.bounds] as [string, Rect]]),
    ...(model.frames ?? []).map(frame => [`frame:${frame.id}`, frame.box] as [string, Rect]),
  ];
  const found = new Set<string>();
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, p] = boxes[i]!, [b, q] = boxes[j]!;
    if (overlaps(p, q)) found.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return found;
}

/** What a move must not make worse, read on the model as it stands. Every field is a set or a number a guard compares exactly. */
interface Reading {
  /** Frozen chords a body blocks (`STRAIGHT_LINK_BLOCKED`) and frozen chords that leave a frame by a side edge (`STRAIGHT_LINK_EDGE`). */
  blocked: Set<string>; edge: Set<string>;
  /** The reservations that fail, by id. */
  failing: Set<string>;
  /** Per tier gap: the plan's height, its residual parts and its crowded legs, by id. */
  gaps: Map<number, { height: number; residual: Set<string>; crowded: Set<string> }>;
  /** Links whose two port anchors stand on one x. */
  axis: Set<string>;
  /** Overlay links with a straight chord. */
  overlay: Set<string>;
  /** Pairs of boxes that overlap. */
  overlapping: Set<string>;
}

function reading(model: LayoutModel): Reading {
  const axis = new Set<string>();
  for (const link of model.links) {
    const [a, b] = ends(model, link);
    if (a !== undefined && b !== undefined && Math.abs(a.anchor!.x - b.anchor!.x) <= PLACEMENT_EPS) axis.add(link.id);
  }
  const gaps = new Map<number, { height: number; residual: Set<string>; crowded: Set<string> }>();
  for (const { gap, plan } of tierGapPlans(model)) {
    gaps.set(gap.above, { height: plan.height, residual: new Set(plan.residual.map(part => part.id)), crowded: new Set(plan.crowded.map(item => item.id)) });
  }
  return {
    blocked: new Set(blockedChords(model)), edge: new Set(edgeLeavers(model)),
    failing: new Set(holds(model.reservations ?? [], model).map(failure => failure.id)),
    gaps, axis, overlay: straightChordIds(model), overlapping: overlappingPairs(model),
  };
}

const gained = (before: ReadonlySet<string>, after: ReadonlySet<string>): string | undefined => [...after].find(id => !before.has(id));
const lost = (before: ReadonlySet<string>, after: ReadonlySet<string>): string | undefined => [...before].find(id => !after.has(id));

/**
 * Why the moved model is not one the producer may keep, or undefined. `before` is read on the model before the move; `room` says whether the
 * label room held then, with the tier-gap label deficits it was measured against.
 */
function closeUpRefusal(model: LayoutModel, before: Reading, room: { held: boolean; deficits: ReadonlyMap<number, number> }, bandsChanged: boolean, gridMoved: boolean): string | undefined {
  if (bandsChanged) return 'a label band would change its clearance';
  if (gridMoved) return 'the linked-group grid would move a box';
  const refusals = new Set(model.gridRefusals ?? []), forged = refusals.size ? forgedRefusals(model, refusals) : [];
  if (forged.length) return `the grid refusals ${forged.join(', ')} would no longer hold`;
  const after = reading(model);
  let id: string | undefined;
  if ((id = gained(before.overlapping, after.overlapping)) !== undefined) return `the boxes ${id} would overlap`;
  // R6: a lane that contradicts the boxes is a refusal with its reason, never a skipped check.
  try { validateLanes(model); } catch (error) { return `a lane would contradict the boxes: ${error instanceof Error ? error.message : String(error)}`; }
  if ((id = gained(before.blocked, after.blocked)) !== undefined) return `a body would block the chord ${id}`;
  if ((id = gained(before.edge, after.edge)) !== undefined) return `the chord ${id} would leave its frame by an edge`;
  if ((id = gained(before.failing, after.failing)) !== undefined) return `the reservation ${id} would fail`;
  for (const [above, now] of after.gaps) {
    const was = before.gaps.get(above);
    if (was === undefined) return `the tier gap below ${above} is new`;
    if (now.height > was.height + PLACEMENT_EPS) return `the tier gap below ${above} would need ${(now.height - was.height).toFixed(1)} px more`;
    if ((id = gained(was.residual, now.residual)) !== undefined) return `the part ${id} in the tier gap below ${above} would be residual`;
    if ((id = gained(was.crowded, now.crowded)) !== undefined) return `the leg ${id} in the tier gap below ${above} would be crowded`;
  }
  if ((id = lost(before.axis, after.axis)) !== undefined) return `the link ${id} would leave the axis its two ends share`;
  if ((id = lost(before.overlay, after.overlay)) !== undefined) return `the overlay link ${id} would lose its straight chord`;
  if (room.held && !roomHolds(model, room.deficits)) return 'a link label would lose its room';
  return undefined;
}

/**
 * The close-up, on the trimmed draft (`trimBodies`, after the trim is kept). Tiers from top to bottom, movers from left to right (ties by id):
 * each mover goes left as far as every box on its left that overlaps it in y allows (a group box, a frame cell, a frame, a lane), keeping the
 * gap it had to that box before the trim (`before`), at least the band gap. A lane that stands on a port of the mover on its owner link (a
 * corridor that follows its child) moves with it, and stops the move at the boxes on its left beside it. The node geometry and every
 * rule-owned geometry are derived again with no centring. A move a guard refuses (`closeUpRefusal`) is undone whole.
 */
export function closeUpSiblings(model: LayoutModel, before: BeforeTrim): CloseUp {
  const gap = bandGap(model), result: CloseUp = { groups: {}, lanes: {}, declined: [] };
  const tiers = [...new Set(Object.values(model.groups).flatMap(group => group.tier === undefined ? [] : [group.tier]))].sort((a, b) => a - b);
  for (const tier of tiers) {
    // Read by id each time: an undone move replaces the objects. Last key: the id.
    const movers = Object.values(model.groups).filter(group => group.tier === tier && isCloseUpMover(model, group))
      .sort((a, b) => a.bounds!.x - b.bounds!.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(group => group.id);
    for (const id of movers) {
      const group = model.groups[id]!, box = group.bounds!, was = before.groups.get(id) ?? box;
      // The lanes that follow a port of the group: the lane of a link with an end on the group, at that end's x.
      const own = new Set<LayoutPort>(group.nodes.flatMap(node => model.nodes[node]!.ports));
      const following = model.lanes.filter(lane => {
        const owner = lane.owner;
        if (owner.kind !== 'link' || lane.kind === 'span' || lane.kind === 'perimeter') return false;
        const link = model.links.find(item => item.id === owner.id);
        return link !== undefined && ends(model, link).some(port => port !== undefined && own.has(port) && Math.abs(port.anchor!.x - lane.x) <= PLACEMENT_EPS);
      }).map(lane => lane.id);
      const followingSet = new Set(following);
      // The walls on the left: each keeps the gap it had to the group before the trim, at least the band gap.
      let low = -Infinity;
      const keep = (now: Rect, then: Rect): void => { low = Math.max(low, right(now) + Math.max(gap, was.x - right(then))); };
      for (const other of Object.values(model.groups)) {
        if (other.id === id || other.bounds === undefined || !overlapsY(other.bounds, box) || right(other.bounds) > box.x + PLACEMENT_EPS) continue;
        keep(other.bounds, before.groups.get(other.id) ?? other.bounds);
      }
      for (const frame of model.frames ?? []) {
        if (!overlapsY(frame.box, box) || right(frame.box) > box.x + PLACEMENT_EPS) continue;
        keep(frame.box, before.frames.get(frame.id) ?? frame.box);
      }
      // A lane does not move in the trim: the gap it had is the one it has, less what the group's own trim opened.
      for (const lane of model.lanes) {
        if (followingSet.has(lane.id) || !overlapsY(lane.bounds, box) || right(lane.bounds) > box.x + PLACEMENT_EPS) continue;
        keep(lane.bounds, lane.bounds);
      }
      // A group with nothing on its left in its rows has no sibling to close up to.
      if (!Number.isFinite(low)) continue;
      let dx = low - box.x;
      // A following lane stops at the boxes on its left beside it: a group's occupied box, a frame, another lane.
      for (const laneId of following) {
        const lane = model.lanes.find(item => item.id === laneId)!;
        const stop = (edge: number): void => { if (edge <= lane.bounds.x + PLACEMENT_EPS) dx = Math.max(dx, edge - lane.bounds.x); };
        for (const other of Object.values(model.groups)) if (other.id !== id && other.bounds !== undefined && overlapsY(other.bounds, lane.bounds)) stop(right(other.bounds) + occupiedOverhang(model, other).right);
        for (const frame of model.frames ?? []) if (overlapsY(frame.box, lane.bounds)) stop(right(frame.box));
        for (const other of model.lanes) if (other.id !== laneId && overlapsY(other.bounds, lane.bounds)) stop(right(other.bounds));
      }
      if (dx > -CLOSE_UP_MIN) continue;
      const was0 = reading(model), deficits = gapLabelDeficits(model), room = { held: roomHolds(model, deficits), deficits };
      const saved = JSON.stringify(model), freeze = model.freeze;
      moveGroup(model, group, dx, 0);
      for (const laneId of following) {
        const lane = model.lanes.find(item => item.id === laneId)!;
        lane.x += dx;
        lane.bounds.x += dx;
      }
      // A read cached by the identity of `model.lanes` (ticket 60) reads the moved lanes again.
      if (following.length) model.lanes = [...model.lanes];
      // Every rule-owned geometry is derived again on the moved ports, with no centring: the node geometry, the regions, the lane runs, the
      // row, flank and bundle paths and the bar drops; then the label bands and the regions on them, and the grid, which may move nothing.
      rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
      rebuildRegionGeometry(model, undefined, undefined, undefined, false);
      rebuildRegions(model);
      const bandsChanged = syncLabelBands(model);
      rebuildRegions(model);
      const boxes = JSON.stringify(Object.values(model.groups).map(item => item.bounds));
      alignLinkedGroupGrid(model, new Set(model.gridRefusals ?? []));
      const refusal = closeUpRefusal(model, was0, room, bandsChanged, JSON.stringify(Object.values(model.groups).map(item => item.bounds)) !== boxes);
      if (refusal !== undefined) {
        const back = JSON.parse(saved) as Record<string, unknown>, target = model as unknown as Record<string, unknown>;
        for (const key of Object.keys(target)) if (!(key in back)) delete target[key];
        Object.assign(target, back);
        // The freeze block is shared and frozen: it keeps its identity.
        if (freeze !== undefined) model.freeze = freeze;
        result.declined.push(`${id} (${refusal})`);
        continue;
      }
      result.groups[id] = dx;
      for (const laneId of following) result.lanes[laneId] = (result.lanes[laneId] ?? 0) + dx;
    }
  }
  return result;
}
