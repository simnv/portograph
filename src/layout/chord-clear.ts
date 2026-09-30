import type { Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutLink, LayoutModel } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { EPS } from '../score/geometry.js';
import { parallelClearance, portOrder } from '../score/gates.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import type { Segment } from '../score/model.js';
import { frameColumns, overlayFreeGroups } from './columns.js';
import { groupShape } from './grid.js';
import { deriveFrames } from './frames.js';
import { blockedChords, chordsHold, isFrameStraight } from './frame-paths.js';
import { laneSidesHold, occupiedOverhang, selectAnchorTier } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { saveGroups } from './overlay-order.js';
import { overlayBlockers, overlayPath, straightChord } from './overlay-paths.js';
import { GROUP_PADDING, groupInsets } from './regions.js';
import { findPort } from './row-paths.js';
import { rowGap } from './sides-two.js';
import { moveGroup } from './skeleton-geometry.js';
import { bandGap } from './skeleton-graph.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** How many candidate x a group or a node tries, nearest first, before it stays (ticket 77). */
const CHORD_TRIALS = 24;

/** What a move must not lose or add, read off the geometry as it stands. */
interface Reading {
  /** The overlay links drawn as one segment. */
  overlay: Set<string>;
  /** The routed links that run on one axis, or hold a straight chord: a drop that stays vertical stays straight. */
  routed: Set<string>;
}

/** A reading of a model that has settled: the two above, and the findings the gates and the tier-gap plan would make. */
interface Verdict extends Reading {
  crowded: Set<string>;
  disordered: Set<string>;
  residuals: Set<string>;
}

const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;

const routedLinks = (model: LayoutModel): LayoutLink[] =>
  model.links.filter(link => link.layer === 'routed' && link.attachments && link.removed !== true && link.technique !== 'stub');

function read(model: LayoutModel, overlays: readonly LayoutLink[]): Reading {
  const blockers = overlayBlockers(model);
  const overlay = new Set(overlays.filter(link => overlayPath(model, link, blockers).segments.length === 1).map(link => link.id));
  const routed = new Set(routedLinks(model).filter(link => {
    if (isFrameStraight(model, link)) return true;
    const from = findPort(model, link.attachments!.from)?.anchor, to = findPort(model, link.attachments!.to)?.anchor;
    return from !== undefined && to !== undefined && (Math.abs(from.x - to.x) <= 0.5 || Math.abs(from.y - to.y) <= 0.5);
  }).map(link => link.id));
  return { overlay, routed };
}

/**
 * The pairs of routed links that stand closer than G6 allows, on the paths a placement model states. It is the gate's own predicate
 * (`parallelClearance`), asked of the links that already have a path: the rest are routed later and are no pair yet.
 */
function crowded(model: LayoutModel): Set<string> {
  const found = new Set<string>();
  const routed: Segment[] = routedLinks(model).filter(link => link.path !== undefined)
    .flatMap(link => link.path!.segments.map((segment, index) => ({ segment, link, index, stroke: linkStrokeWidth(link) })));
  parallelClearance(model, routed, (_gate, _code, elements) => { found.add([...elements].sort().join('|')); });
  return found;
}

/** The nodes whose ports stand out of the order of their far ends (G5), on the anchors a placement model states. */
function disordered(model: LayoutModel): Set<string> {
  const found = new Set<string>();
  portOrder(model, Object.values(model.nodes), new Set(routedLinks(model)), (_gate, code, elements) => { found.add(`${code}:${elements.join('|')}`); });
  return found;
}

/** The tier-gap parts the plan declines: the placement proxy for a routed crossing the router would have to make. */
const residuals = (model: LayoutModel): Set<string> => new Set(model.diagnostics
  .filter(item => item.code === 'TIER_GAP_PART_RESIDUAL' || item.code === 'TIER_GAP_ROW_CYCLE')
  .map(item => `${item.code}:${JSON.stringify(item.owners ?? [])}`));

const verdict = (model: LayoutModel, overlays: readonly LayoutLink[]): Verdict =>
  ({ ...read(model, overlays), crowded: crowded(model), disordered: disordered(model), residuals: residuals(model) });

/** Whether every finding `after` states was stated by `before`. */
const nothingNew = (before: ReadonlySet<string>, after: ReadonlySet<string>): boolean => [...after].every(item => before.has(item));

/**
 * A straight overlay chord between two tiers is a reservation for the tiers between them (ticket 77, Q64). Run in 7f, after the
 * growth and the close-up have settled the columns. A group or a node on a tier strictly between the two ends of a chord that stands
 * on it moves along its tier to the nearest x that clears the chord; the chords that count are the ones straight without the mover.
 *
 * A group moves whole, inside its tier: it keeps the band gap to the groups, columns and lanes, stays inside its canton (less the group
 * margin) when it is a member of one, and stays inside the box of the whole layout, so the canvas does not widen. A group with a routed
 * link keeps its place in the order of its tier, so the move creates no crossing among the links it holds. A node moves inside the
 * box of its group, in the row it stands in, keeping the row gap to its neighbours.
 *
 * A candidate is kept only when both of these hold:
 * - on the geometry after the move, `laneSidesHold` (a lane keeps its side, a frozen chord stays clear of every body), and the
 *   straight overlay count rises (a move that bends one link and straightens two is a trade that counts);
 * - on a copy of the model that `follow` has run, which is what the pipeline does next (the replays of the regions, the grid and
 *   the labels, then a round of the growth and the close-up), against the copy of the model without the move: the straight overlay
 *   count still rises, no routed link that ran on one axis or held a chord stops doing so, and no pair of routed links (G6), no
 *   port out of the order of its far ends (G5) and no tier-gap part the plan declines appears that was not there before.
 * Otherwise the mover goes back and the next candidate is tried. A mover that has moved in an earlier round (`history`) is left
 * where it stands, so the rounds converge. Returns whether anything stayed moved.
 */
export function stepOverChords(model: LayoutModel, follow: ((probe: LayoutModel) => unknown) | undefined, history: Set<string> = new Set()): boolean {
  const anchor = selectAnchorTier(model);
  // A member of a mesh bus is not a chord: it is neither straight nor bent, and the step does not read it (mesh-bus.md, section 4).
  const overlays = model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && link.attachments);
  if (anchor === undefined || !overlays.length) return false;
  const columns = frameColumns(model), movable = overlayFreeGroups(model, anchor, true), free = overlayFreeGroups(model, anchor);
  const tierOf = (node: string): number => model.groups[model.document.nodes[node]!.group]!.tier!;
  const linked = new Set<string>();
  for (const link of model.links) if (link.attachments) for (const end of [link.attachments.from.node, link.attachments.to.node]) linked.add(model.document.nodes[end]!.group);
  const gap = bandGap(model);
  const all = Object.values(model.groups).filter(group => group.bounds);
  const world = { low: Math.min(...all.map(group => group.bounds!.x)), high: Math.max(...all.map(group => group.bounds!.x + group.bounds!.width)) };
  const tiers = [...new Set(all.map(group => group.tier!))].sort((a, b) => a - b);
  /** Whether any trial ran: each one rebuilds labels a group at a time and so moves them to the end of the list. */
  let tried = false, moved = false;
  /** The verdict on the settled copy of the model as it stands, without a move. It holds until a move stays. */
  let baseline: Verdict | undefined;

  /** The verdict on a settled copy of the model as it stands now, or `undefined` when the copy cannot be settled. */
  const settled = (): Verdict | undefined => {
    try {
      const probe = copy(model);
      follow!(probe);
      return verdict(probe, overlays);
    } catch {
      return undefined;
    }
  };
  /** Whether the settled copy of the model with the move made stands better than the settled copy without it. */
  const holdsSettled = (redo: () => void, undo: () => void, nodes: readonly string[]): boolean => {
    if (follow === undefined) return true;
    const after = settled();
    if (baseline === undefined) {
      undo();
      rebuildNodeGeometry(model, nodes, 'current');
      baseline = settled();
      redo();
      rebuildNodeGeometry(model, nodes, 'current');
    }
    return after !== undefined && baseline !== undefined && after.overlay.size > baseline.overlay.size
      && [...baseline.routed].every(id => after.routed.has(id))
      && nothingNew(baseline.crowded, after.crowded) && nothingNew(baseline.disordered, after.disordered) && nothingNew(baseline.residuals, after.residuals);
  };

  /** The moves `dx` of a set of shapes that put one of them on a chord: open intervals. */
  const bannedFor = (chords: readonly { from: { x: number; y: number }; to: { x: number; y: number } }[], shapes: readonly Rect[]): { low: number; high: number }[] =>
    chords.flatMap(({ from, to }) => shapes.flatMap(shape => {
      const top = shape.y + EPS, floor = shape.y + shape.height - EPS, dy = to.y - from.y;
      let t0 = 0, t1 = 1;
      if (Math.abs(dy) <= EPS) { if (from.y <= top || from.y >= floor) return []; }
      else {
        const a = (top - from.y) / dy, b = (floor - from.y) / dy;
        t0 = Math.max(0, Math.min(a, b)); t1 = Math.min(1, Math.max(a, b));
        if (t1 - t0 <= 0) return [];
      }
      const xs = [from.x + (to.x - from.x) * t0, from.x + (to.x - from.x) * t1];
      return [{ low: Math.min(...xs) - shape.x - shape.width, high: Math.max(...xs) - shape.x }];
    }));
  const shapesOf = (ids: readonly string[]): Rect[] => ids.flatMap(id => {
    const node = model.nodes[id]!;
    return [node.bounds!, ...node.ports.flatMap(port => port.pill && port.ref.anonymous !== true ? [port.pill.bounds] : [])];
  });
  /** The chords that pass over `tier` and are straight without `skip`: the reservations a mover must not stand on. */
  const chordsOver = (tier: number, skip: ReadonlySet<string>): { from: { x: number; y: number }; to: { x: number; y: number } }[] => {
    const bare = overlayBlockers(model, skip);
    return overlays.flatMap(link => {
      const ends = [tierOf(link.attachments!.from.node), tierOf(link.attachments!.to.node)];
      if (!(Math.min(...ends) < tier && tier < Math.max(...ends))) return [];
      const chord = straightChord(model, link, bare);
      return chord ? [chord] : [];
    });
  };
  const groupOfNodes = (nodes: readonly string[]): LayoutGroup[] => [...new Set(nodes.map(id => model.groups[model.document.nodes[id]!.group]!))];
  const saveGroupsOf = (nodes: readonly string[]): (() => void) => saveGroups(model, groupOfNodes(nodes));

  /**
   * Try the candidates nearest first. `place(dx)` moves the mover by dx, `undo` takes it back. Returns whether one stayed.
   * A frozen chord a candidate would put a body on is a wall (`holds` for a group, the check below for a node).
   */
  const attempt = (key: string, candidates: readonly number[], at: number, place: (dx: number) => void, undo: () => void, nodes: readonly string[],
    holds: (x: number) => boolean): boolean => {
    const before = read(model, overlays), blocked = new Set(blockedChords(model));
    for (const target of candidates.slice(0, CHORD_TRIALS)) {
      if (!holds(target)) continue;
      tried = true;
      place(target - at);
      rebuildNodeGeometry(model, nodes, 'current');
      const after = read(model, overlays);
      if (after.overlay.size > before.overlay.size && [...before.routed].every(id => after.routed.has(id)) && blockedChords(model).every(id => blocked.has(id))
        && holdsSettled(saveGroupsOf(nodes), undo, nodes)) {
        baseline = undefined;
        history.add(key);
        return true;
      }
      undo();
      rebuildNodeGeometry(model, nodes, 'current');
    }
    return false;
  };
  const nearest = (edges: readonly number[], at: number, ok: (x: number) => boolean): number[] => edges
    .filter((x, index, list) => ok(x) && Math.abs(x - at) > PLACEMENT_EPS && list.findIndex(other => Math.abs(other - x) <= PLACEMENT_EPS) === index)
    .sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || a - b);

  for (const tier of tiers) {
    const groups = all.filter(group => group.tier === tier);
    const over = overlays.some(link => {
      const ends = [tierOf(link.attachments!.from.node), tierOf(link.attachments!.to.node)];
      return Math.min(...ends) < tier && tier < Math.max(...ends);
    });
    if (!over) continue;
    for (const group of groups.filter(item => movable.has(item.id) && linked.has(item.id))) {
      // Whole group.
      const box = { ...group.bounds! };
      const banned = bannedFor(chordsOver(tier, new Set(group.nodes)), shapesOf(group.nodes));
      const reach = occupiedOverhang(model, group);
      const routedGroup = !free.has(group.id);
      let placed = false;
      if (!history.has(group.id) && banned.some(({ low, high }) => low < -PLACEMENT_EPS && high > PLACEMENT_EPS)) {
        // The walls, as moves of the group: the run of x a move may not put the group's occupied extent into.
        const walls: { low: number; high: number }[] = [];
        let inside = { low: world.low + reach.left, high: world.high - box.width - reach.right };
        const cell = group.frame === undefined ? undefined : columns.find(column => column.cells.has(group.id));
        let skip = false;
        if (group.frame !== undefined) {
          const frames = model.document.frames!, derived = deriveFrames(model);
          const frame = derived?.find(item => item.id === group.frame);
          if (cell?.wall === undefined || frame === undefined) skip = true;
          else {
            // A member of a canton stands inside the canton, less the group margin, and 2 * GROUP_PADDING from the other frames of its sub-tier.
            const cellsOf = (id: string): string[] => [...frames[id]!.cells, ...Object.keys(frames).filter(child => frames[child]!.parent === id).flatMap(cellsOf)];
            const lead = box.x - frame.box.x, span = frame.box.width;
            inside = { low: Math.max(world.low, cell.wall.x + GROUP_PADDING + lead), high: Math.min(world.high - box.width, cell.wall.x + cell.wall.width - GROUP_PADDING - span + lead) };
            for (const other of derived!) {
              if (other.id === group.frame || frames[other.id]!.parent !== cell.id || !cellsOf(other.id).some(id => model.groups[id]!.tier === tier)) continue;
              walls.push({ low: other.box.x - 2 * GROUP_PADDING - span + lead, high: other.box.x + other.box.width + 2 * GROUP_PADDING + lead });
            }
            for (const lane of model.lanes.filter(item => item.tier === tier)) walls.push({ low: lane.bounds.x - span + lead, high: lane.bounds.x + lane.bounds.width + lead });
          }
        } else {
          const width = box.width + reach.left + reach.right;
          const wall = (low: number, high: number, space: number): void => { walls.push({ low: low - space - width + reach.left, high: high + space + reach.left }); };
          for (const item of groups) {
            if (item === group) continue;
            const one = occupiedOverhang(model, item);
            wall(item.bounds!.x - one.left, item.bounds!.x + item.bounds!.width + one.right, gap);
          }
          for (const column of columns.filter(item => item.from <= tier && tier <= item.to)) wall(column.x, column.x + column.width, gap);
          for (const lane of model.lanes.filter(item => item.tier === tier)) wall(lane.bounds.x, lane.bounds.x + lane.bounds.width, 0);
        }
        if (!skip) {
          // A group that holds a routed link keeps its place in the order of its tier: the run between its neighbours' walls. A wall
          // that already holds the group's place is a wall on both sides, and the group stays.
          if (routedGroup) {
            if (walls.some(wall => wall.low < box.x - PLACEMENT_EPS && wall.high > box.x + PLACEMENT_EPS)) inside = { low: box.x, high: box.x };
            const below = walls.filter(wall => wall.high <= box.x + PLACEMENT_EPS).map(wall => wall.high);
            const above = walls.filter(wall => wall.low >= box.x - PLACEMENT_EPS).map(wall => wall.low);
            inside = { low: Math.max(inside.low, ...below), high: Math.min(inside.high, ...above) };
          }
          const feasible = (x: number): boolean => x >= inside.low - PLACEMENT_EPS && x <= inside.high + PLACEMENT_EPS
            && !walls.some(({ low, high }) => x > low + PLACEMENT_EPS && x < high - PLACEMENT_EPS);
          const candidates = nearest([...banned.flatMap(({ low, high }) => [box.x + low, box.x + high]), ...walls.flatMap(({ low, high }) => [low, high])], box.x, feasible);
          const undo = saveGroups(model, [group]);
          // The candidates ask without a report; a frozen chord is named once, for the nearest candidate it refused, when no candidate stays.
          let refusal: { group: LayoutGroup; bounds: Rect }[] | undefined;
          placed = attempt(group.id, candidates, box.x, dx => moveGroup(model, group, dx, 0), undo, group.nodes, x => {
            const proposed = [{ group, bounds: { ...box, x } }];
            if (laneSidesHold(model, proposed, false)) return true;
            if (refusal === undefined && !chordsHold(model, proposed, false)) refusal = proposed;
            return false;
          });
          if (placed) moved = true;
          else if (refusal !== undefined) chordsHold(model, refusal, true);
        }
      }
      if (placed) continue;
      // A node inside its group: the row stays in its order, and the node stays inside the box the group has (its slack).
      if (groupShape(model, group.id) !== 'row') continue;
      const order = [...(group.rowOrder ?? group.nodes)].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x);
      const inset = groupInsets(model, group);
      for (const [index, id] of order.entries()) {
        if (history.has(`node:${id}`)) continue;
        const node = model.nodes[id]!, body = { ...node.bounds! };
        const lowest = index === 0 ? group.bounds!.x + inset.left : model.nodes[order[index - 1]!]!.bounds!.x + model.nodes[order[index - 1]!]!.bounds!.width + rowGap(model, order[index - 1]!, id);
        const highest = index === order.length - 1 ? group.bounds!.x + group.bounds!.width - inset.right - body.width
          : model.nodes[order[index + 1]!]!.bounds!.x - rowGap(model, id, order[index + 1]!) - body.width;
        if (highest - lowest < PLACEMENT_EPS) continue;
        const own = bannedFor(chordsOver(tier, new Set([id])), shapesOf([id]));
        if (!own.some(({ low, high }) => low < -PLACEMENT_EPS && high > PLACEMENT_EPS)) continue;
        const candidates = nearest(own.flatMap(({ low, high }) => [body.x + low, body.x + high]), body.x, x => x >= lowest - PLACEMENT_EPS && x <= highest + PLACEMENT_EPS);
        const undo = saveGroups(model, [group]);
        const shift = (dx: number): void => {
          node.bounds!.x += dx;
          for (const port of node.ports) if (port.anchor) port.anchor.x += dx;
        };
        // A frozen chord is a wall for a node as for a group: `attempt` refuses a candidate that puts a body on one.
        if (attempt(`node:${id}`, candidates, body.x, shift, undo, [id], () => true)) moved = true;
      }
    }
  }
  if (tried) rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
  return moved;
}
