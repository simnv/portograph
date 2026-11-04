/**
 * The close-up (architecture-2 ticket 69): after the end trim, a leaf top-level group moves toward its sibling on its left by at most the
 * width the trim freed, its order kept, when no guard declines. The move is a decision of the `bands` producer, recorded with the trim
 * (`bodyTrims.shifts`, `bodyTrims.laneShifts`, R1): the centring replay reads the geometry before it (`untrimmedModel`).
 *
 * It runs after the last move in x of 7f (ticket 68): before the chord freeze, every centring replay of the 7f rounds reads a lane's x as its
 * feed's x and moves the group back (experiment `closeup/report.md`, the early variant). So it moves nothing that placement reserved: a move
 * that needs room the gaps, lanes, chords and labels did not reserve is declined whole, and the next group is tried.
 */
import type { Lane, LayoutGroup, LayoutLink, LayoutModel, LayoutPort, Rect } from '../model/index.js';
import { orderedNodeIds } from '../model/model.js';
import { findPort } from './row-paths.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { rebuildRegions, right } from './regions.js';
import { moveGroup } from './skeleton-geometry.js';
import { bandGap } from './skeleton-graph.js';
import { occupiedOverhang, validateLanes } from './lanes.js';
import { rebuildRuleGeometry } from './rule-geometry-hook.js';
import { alignLinkedGroupGrid, forgedRefusals, gapLabelDeficits, roomHolds, syncLabelBands } from './bands.js';
import { blockedChords, edgeLeavers } from './frame-paths.js';
import { holds } from './reservation-checks.js';
import { tierGapPlans } from './gap-plan.js';
import { straightChordIds } from './read/overlay-straight.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { stemDepthsFault } from './sides-two.js';

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
  // A group a flank stands beside keeps it beside it: the flank does not move with it.
  return group.frame === undefined && group.flank === undefined && group.tier !== undefined && group.bounds !== undefined
    && model.document.groups[group.id]?.shape !== 'bar' && !Object.values(model.groups).some(other => other.frame === group.id || other.flank?.of === group.id);
}

/**
 * Moves a lane by `dx`. A lane box centred on its x (`validateLanes` compares it exactly) is derived from the x again, so a shift and its undo
 * leave no float drift between the two; another box moves by the same sum. One function for the producer and the replay (R1).
 */
export function shiftLane(lane: Lane, dx: number): void {
  const centred = lane.bounds.x === lane.x - lane.bounds.width / 2;
  lane.x += dx;
  lane.bounds.x = centred ? lane.x - lane.bounds.width / 2 : lane.bounds.x + dx;
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

interface GapReading { height: number; residual: Set<string>; crowded: Set<string>; slant: Set<string>; crossings: number }

/** What a move must not make worse, read on the model as it stands. Every field is a set or a number a guard compares exactly. */
interface Reading {
  /** Frozen chords a body blocks (`STRAIGHT_LINK_BLOCKED`) and frozen chords that leave a frame by a side edge (`STRAIGHT_LINK_EDGE`). */
  blocked: Set<string>; edge: Set<string>;
  /** The reservations that fail, by id. */
  failing: Set<string>;
  /** Per tier gap: the plan's height, its residual parts, crowded legs and slant-limited units by id, and the count of its planned crossings. */
  gaps: Map<number, GapReading>;
  /** Links whose two port anchors stand on one x. */
  axis: Set<string>;
  /** Overlay links with a straight chord. */
  overlay: Set<string>;
  /** Pairs of boxes that overlap. */
  overlapping: Set<string>;
  /** The x of every port anchor, keyed `node#index`. */
  anchors: Map<string, number>;
}

function reading(model: LayoutModel): Reading {
  const axis = new Set<string>();
  for (const link of model.links) {
    const [a, b] = ends(model, link);
    if (a !== undefined && b !== undefined && Math.abs(a.anchor!.x - b.anchor!.x) <= PLACEMENT_EPS) axis.add(link.id);
  }
  const gaps = new Map<number, GapReading>();
  for (const { gap, plan } of tierGapPlans(model)) {
    gaps.set(gap.above, { height: plan.height, residual: new Set(plan.residual.map(part => part.id)), crowded: new Set(plan.crowded.map(item => item.id)),
      slant: new Set((plan.slantLimited ?? []).map(item => item.id)), crossings: plan.crossings.length });
  }
  return {
    blocked: new Set(blockedChords(model)), edge: new Set(edgeLeavers(model)),
    failing: new Set(holds(model.reservations ?? [], model).map(failure => failure.id)),
    gaps, axis, overlay: straightChordIds(model), overlapping: overlappingPairs(model),
    anchors: new Map(Object.values(model.nodes).flatMap(node => node.ports.flatMap((port, index) => port.anchor === undefined ? [] : [[`${node.id}#${index}`, port.anchor.x] as [string, number]]))),
  };
}

/**
 * The lanes that follow a port of `group`: a lane (not a span or perimeter lane) of a link with an end on the group, standing at that end's x.
 * They move with the group. One function for the producer and the record check, which reads it on the published model (R1).
 */
export function followingLanes(model: LayoutModel, group: LayoutGroup): string[] {
  const own = new Set<LayoutPort>(group.nodes.flatMap(node => model.nodes[node]!.ports));
  return model.lanes.filter(lane => {
    const owner = lane.owner;
    if (owner.kind !== 'link' || lane.kind === 'span' || lane.kind === 'perimeter') return false;
    const link = model.links.find(item => item.id === owner.id);
    return link !== undefined && ends(model, link).some(port => port !== undefined && own.has(port) && Math.abs(port.anchor!.x - lane.x) <= PLACEMENT_EPS);
  }).map(lane => lane.id);
}

const gained = (before: ReadonlySet<string>, after: ReadonlySet<string>): string | undefined => [...after].find(id => !before.has(id));
const lost = (before: ReadonlySet<string>, after: ReadonlySet<string>): string | undefined => [...before].find(id => !after.has(id));

/**
 * Why the moved model is not one the producer may keep, or undefined. `before` is read on the model before the move; `room` holds the tier-gap
 * label deficits the room was measured against before it.
 */
function closeUpRefusal(model: LayoutModel, before: Reading, room: { deficits: ReadonlyMap<number, number> }, bandsChanged: boolean, gridMoved: boolean,
  move: { nodes: ReadonlySet<string>; dx: number }): string | undefined {
  // The move is a translation: every port of the group moves by dx with its node, and no other port moves. A rule that seats a port again
  // (a bundle's ends agree) would leave it where the replay cannot put it back by the record.
  for (const [key, x] of before.anchors) {
    const [node, index] = key.split('#') as [string, string], now = model.nodes[node]?.ports[Number(index)]?.anchor?.x;
    if (now === undefined || Math.abs(now - (x + (move.nodes.has(node) ? move.dx : 0))) > PLACEMENT_EPS) return `the port ${index} of ${node} would not move with its node`;
  }
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
    if ((id = gained(was.slant, now.slant)) !== undefined) return `the row of ${id} in the tier gap below ${above} would be slant-limited`;
    if (now.crossings > was.crossings) return `the tier gap below ${above} would plan ${now.crossings - was.crossings} more crossings`;
  }
  // The stem depths were decided before the tier-gap solve (ticket 57) and the gaps were grown for them: a move that changes how a node side
  // nests its stems (a leg now clears or meets a neighbour) would publish a record the geometry contradicts (architecture-2 ticket 71).
  const stems = stemDepthsFault(model);
  if (stems !== undefined) return 'a node side would nest its stems otherwise than the stem depth record says';
  if ((id = lost(before.axis, after.axis)) !== undefined) return `the link ${id} would leave the axis its two ends share`;
  if ((id = lost(before.overlay, after.overlay)) !== undefined) return `the overlay link ${id} would lose its straight chord`;
  // The room held before the move (the caller refuses otherwise, R6); a move after which the validator's reading no longer holds, or a tier gap
  // asks more of a label than it did, is refused.
  if (!roomHolds(model, room.deficits)) return 'a link label would lose its room';
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
      const following = followingLanes(model, group);
      const followingSet = new Set(following);
      // The walls on the left: each keeps the gap it had to the group before the trim, at least the band gap.
      let low = -Infinity, sibling = false;
      const keep = (now: Rect, then: Rect): void => { low = Math.max(low, right(now) + Math.max(gap, was.x - right(then))); };
      for (const other of Object.values(model.groups)) {
        if (other.id === id || other.bounds === undefined || !overlapsY(other.bounds, box) || right(other.bounds) > box.x + PLACEMENT_EPS) continue;
        keep(other.bounds, before.groups.get(other.id) ?? other.bounds);
        sibling = true;
      }
      for (const frame of model.frames ?? []) {
        if (!overlapsY(frame.box, box) || right(frame.box) > box.x + PLACEMENT_EPS) continue;
        keep(frame.box, before.frames.get(frame.id) ?? frame.box);
        sibling = true;
      }
      // A lane does not move in the trim: the gap it had is the one it has, less what the group's own trim opened.
      for (const lane of model.lanes) {
        if (followingSet.has(lane.id) || !overlapsY(lane.bounds, box) || right(lane.bounds) > box.x + PLACEMENT_EPS) continue;
        keep(lane.bounds, lane.bounds);
      }
      // A group with no box on its left in its rows has no sibling to close up to: a lane alone holds it where it stands.
      if (!sibling) continue;
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
      const saved = JSON.stringify(model), freeze = model.freeze;
      const undo = (): void => {
        const back = JSON.parse(saved) as Record<string, unknown>, target = model as unknown as Record<string, unknown>;
        for (const key of Object.keys(target)) if (!(key in back)) delete target[key];
        Object.assign(target, back);
        // The freeze block is shared and frozen: it keeps its identity.
        if (freeze !== undefined) model.freeze = freeze;
      };
      const deficits = gapLabelDeficits(model);
      // R6: a guard that cannot read the model before the move refuses it. The label room holds on a model 7f publishes; when it does not,
      // the label-room guard has nothing to compare with.
      if (!roomHolds(model, deficits)) { result.declined.push(`${id} (the link label room did not hold before the move)`); continue; }
      const was0 = reading(model);
      let refusal: string | undefined;
      try {
        moveGroup(model, group, dx, 0);
        for (const laneId of following) shiftLane(model.lanes.find(item => item.id === laneId)!, dx);
        // A read cached by the identity of `model.lanes` (ticket 60) reads the moved lanes again.
        if (following.length) model.lanes = [...model.lanes];
        // Every rule-owned geometry is derived again on the moved ports, with no centring: the node geometry, the regions, the lane runs, the
        // row, flank and bundle paths and the bar drops; then the label bands and the regions on them, and the grid, which may move nothing.
        rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
        rebuildRuleGeometry(model);
        rebuildRegions(model);
        const bandsChanged = syncLabelBands(model);
        rebuildRegions(model);
        const boxes = JSON.stringify(Object.values(model.groups).map(item => item.bounds));
        alignLinkedGroupGrid(model, new Set(model.gridRefusals ?? []));
        refusal = closeUpRefusal(model, was0, { deficits }, bandsChanged, JSON.stringify(Object.values(model.groups).map(item => item.bounds)) !== boxes, { nodes: new Set(group.nodes), dx });
      } catch (error) {
        // A programming error is no refusal: it is thrown on (the draft is put back first).
        if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) { undo(); throw error; }
        // A rule that cannot derive its geometry on the moved ports refuses the move (R6): the move was only tried.
        refusal = `a rule could not derive the moved geometry: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (refusal !== undefined) {
        undo();
        result.declined.push(`${id} (${refusal})`);
        continue;
      }
      result.groups[id] = dx;
      for (const laneId of following) result.lanes[laneId] = (result.lanes[laneId] ?? 0) + dx;
    }
  }
  return result;
}

/**
 * t73 Step 0 prototype P1 (the group slide): after the close-up, each mover may translate along its tier toward its feeds, inside the room its
 * tier has (the band gap to every box beside it in its rows, the lanes it does not own), to the one offset that stands the most of its feeds
 * vertical (ties: the smaller move, then the left one). Its nodes keep their trimmed width. A move must stand more feeds vertical than it
 * found, and pass every guard of the close-up (`closeUpRefusal`); otherwise it is undone whole.
 */
export function slideTowardFeeds(model: LayoutModel): CloseUp {
  const gap = bandGap(model), result: CloseUp = { groups: {}, lanes: {}, declined: [] };
  const tiers = [...new Set(Object.values(model.groups).flatMap(group => group.tier === undefined ? [] : [group.tier]))].sort((a, b) => a - b);
  for (const tier of tiers) {
    const movers = Object.values(model.groups).filter(group => group.tier === tier && isCloseUpMover(model, group))
      .sort((a, b) => a.bounds!.x - b.bounds!.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(group => group.id);
    for (const id of movers) {
      const group = model.groups[id]!, box = group.bounds!;
      const own = new Set(group.nodes);
      const following = followingLanes(model, group), followingSet = new Set(following);
      // The feed offsets: per link with one end on a top or bottom port of the group and the other end on a facing port outside it (or on the
      // link's own lane that does not follow the group), the far x less the port x.
      const offsets: number[] = [];
      for (const link of model.links) {
        const [a, b] = ends(model, link);
        if (a === undefined || b === undefined) continue;
        const aIn = own.has(link.attachments?.from.node ?? (link.from as { node: string }).node), bIn = own.has(link.attachments?.to.node ?? (link.to as { node: string }).node);
        if (aIn === bIn) continue;
        const near = aIn ? a : b, far = aIn ? b : a;
        if (near.side !== 'top' && near.side !== 'bottom') continue;
        const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id && !followingSet.has(lane.id) && lane.kind !== 'perimeter');
        let farX: number | undefined;
        if (lanes.length) {
          const nearest = lanes.reduce((best, lane) => Math.abs(lane.bounds.y + lane.bounds.height / 2 - near.anchor!.y) < Math.abs(best.bounds.y + best.bounds.height / 2 - near.anchor!.y) ? lane : best);
          farX = nearest.x;
        } else if ((far.side === 'top' || far.side === 'bottom') && far.side !== near.side) farX = far.anchor!.x;
        if (farX !== undefined) offsets.push(farX - near.anchor!.x);
      }
      if (!offsets.length) continue;
      const standing = (dx: number): number => offsets.filter(offset => Math.abs(offset - dx) <= 0.5).length;
      // The room: every box beside the group in its rows keeps the band gap; a lane it does not own keeps its own box clear.
      let low = -Infinity, high = Infinity;
      const wall = (rect: Rect, pad: number): void => {
        if (!overlapsY(rect, box)) return;
        if (right(rect) <= box.x + PLACEMENT_EPS) low = Math.max(low, right(rect) + pad - box.x);
        else if (rect.x >= right(box) - PLACEMENT_EPS) high = Math.min(high, rect.x - pad - right(box));
      };
      for (const other of Object.values(model.groups)) if (other.id !== id && other.bounds !== undefined && other.frame === undefined) wall(other.bounds, gap);
      for (const frame of model.frames ?? []) wall(frame.box, gap);
      for (const lane of model.lanes) if (!followingSet.has(lane.id)) wall(lane.bounds, 0);
      const found = standing(0);
      let best: number | undefined, bestScore = found;
      for (const dx of [...new Set(offsets.map(offset => Math.round(offset * 1000) / 1000))].sort((p, q) => Math.abs(p) - Math.abs(q) || p - q)) {
        if (Math.abs(dx) < CLOSE_UP_MIN || dx < low - PLACEMENT_EPS || dx > high + PLACEMENT_EPS) continue;
        const score = standing(dx);
        if (score > bestScore) { best = dx; bestScore = score; }
      }
      if (best === undefined) {
        if (offsets.some(offset => Math.abs(offset) > 0.5)) result.declined.push(`${id} (no room: ${low.toFixed(1)}..${high.toFixed(1)}, offsets ${offsets.map(o => o.toFixed(1)).join(' ')})`);
        continue;
      }
      const dx = best;
      const saved = JSON.stringify(model), freeze = model.freeze;
      const undo = (): void => {
        const back = JSON.parse(saved) as Record<string, unknown>, target = model as unknown as Record<string, unknown>;
        for (const key of Object.keys(target)) if (!(key in back)) delete target[key];
        Object.assign(target, back);
        if (freeze !== undefined) model.freeze = freeze;
      };
      const deficits = gapLabelDeficits(model);
      if (!roomHolds(model, deficits)) { result.declined.push(`${id} (the link label room did not hold before the move)`); continue; }
      const was0 = reading(model);
      let refusal: string | undefined;
      try {
        moveGroup(model, group, dx, 0);
        for (const laneId of following) shiftLane(model.lanes.find(item => item.id === laneId)!, dx);
        if (following.length) model.lanes = [...model.lanes];
        rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
        rebuildRuleGeometry(model);
        rebuildRegions(model);
        const bandsChanged = syncLabelBands(model);
        rebuildRegions(model);
        const boxes = JSON.stringify(Object.values(model.groups).map(item => item.bounds));
        alignLinkedGroupGrid(model, new Set(model.gridRefusals ?? []));
        refusal = closeUpRefusal(model, was0, { deficits }, bandsChanged, JSON.stringify(Object.values(model.groups).map(item => item.bounds)) !== boxes, { nodes: new Set(group.nodes), dx });
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) { undo(); throw error; }
        refusal = `a rule could not derive the moved geometry: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (refusal !== undefined) { undo(); result.declined.push(`${id} (${refusal})`); continue; }
      result.groups[id] = dx;
      for (const laneId of following) result.lanes[laneId] = (result.lanes[laneId] ?? 0) + dx;
    }
  }
  return result;
}
