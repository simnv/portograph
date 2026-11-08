import type { Point, Rect, Side } from '../model/geometry.js';
import type { GroupExit, LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { frameSubtreeCells } from '../model/index.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { groupBoxes } from '../score/model.js';
import { routeObstacles, type RouteObstacle } from '../route/obstacles.js';
import { portId } from './skeleton-graph.js';
import { portStemReach, routedStroke } from './bands.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** Extra distance past the group's edge margin where a reserved exit stops, so the route turns clear of the gate's limit. */
export const EXIT_SLACK = 2;
/** The search stops after this many nodes; the best assignment found by then stands. The order is fixed, so the answer is too. */
const SEARCH_BUDGET = 20000;
/** What an exit left without a strip costs in the search, against the rank (0 to 2) of the direction it takes. */
const REFUSED = 100;

/**
 * Whether `nodeId` stands in the box `boxId` (a group or a frame): in the group itself, in a child of
 * it, or in a cell of the frame or of one of its child frames. Ancestry decides, not the innermost group.
 */
export function standsIn(model: LayoutModel, boxId: string, nodeId: string): boolean {
  const frames = model.document.frames ?? {}, groups = model.document.groups;
  const own = model.document.nodes[nodeId]?.group;
  if (own === undefined) return false;
  const ids = Object.hasOwn(frames, boxId) ? frameSubtreeCells(frames, boxId) : [boxId];
  for (let id: string | undefined = own, depth = 0; id !== undefined && depth < 8; id = groups[id]?.parent, depth++) {
    if (ids.includes(id)) return true;
  }
  return ids.some(id => model.groups[id]?.nodes.includes(nodeId));
}

const inside = (box: Rect, p: Point): boolean =>
  p.x > box.x + PLACEMENT_EPS && p.x < box.x + box.width - PLACEMENT_EPS && p.y > box.y + PLACEMENT_EPS && p.y < box.y + box.height - PLACEMENT_EPS;
const touches = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - PLACEMENT_EPS && b.x < a.x + a.width - PLACEMENT_EPS
  && a.y < b.y + b.height - PLACEMENT_EPS && b.y < a.y + a.height - PLACEMENT_EPS;
const grow = (box: Rect, by: number): Rect => ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
const stripOf = (from: Point, to: Point, width: number): Rect => ({ x: Math.min(from.x, to.x) - width / 2, y: Math.min(from.y, to.y) - width / 2,
  width: Math.abs(to.x - from.x) + width, height: Math.abs(to.y - from.y) + width });
/** Whether the run `a` and the straight run `from`-`to` lie on one line and share length, or cross inside both: a shared stem is met at its ends and nowhere else. */
function overlapsRun(a: PathSegment, from: Point, to: Point, width: number): boolean {
  const aHorizontal = Math.abs(a.from.y - a.to.y) < PLACEMENT_EPS, bHorizontal = Math.abs(from.y - to.y) < PLACEMENT_EPS;
  const span = (p: Point, q: Point, horizontal: boolean): [number, number] => horizontal ? [Math.min(p.x, q.x), Math.max(p.x, q.x)] : [Math.min(p.y, q.y), Math.max(p.y, q.y)];
  const across = (p: Point, horizontal: boolean): number => horizontal ? p.y : p.x;
  const [a0, a1] = span(a.from, a.to, aHorizontal), [b0, b1] = span(from, to, bHorizontal);
  if (aHorizontal === bHorizontal) {
    return Math.abs(across(a.from, aHorizontal) - across(from, bHorizontal)) < width && Math.min(a1, b1) - Math.max(a0, b0) > PLACEMENT_EPS;
  }
  const ax = across(a.from, aHorizontal), bx = across(from, bHorizontal);
  return ax > b0 + PLACEMENT_EPS && ax < b1 - PLACEMENT_EPS && bx > a0 + PLACEMENT_EPS && bx < a1 - PLACEMENT_EPS;
}
/**
 * What tells two parallel links apart without their place in a list: the author's own id when there is one, else the class, label, route
 * and weight of the link as written. Links that agree on all of it are interchangeable, and the order of the document breaks that tie last.
 */
function contentKey(model: LayoutModel, link: LayoutLink): string {
  const written = model.document.links[link.sourceIndex];
  return JSON.stringify([written?.id ?? null, written?.class ?? null, written?.label ?? null, written?.route ?? null, written?.weight ?? null]) + `|${String(link.sourceIndex).padStart(8, '0')}`;
}
const fixed = (n: number): string => (Math.round(n * 1000) / 1000).toFixed(3);

/** The tree a junction id belongs to: the id without its depth. Links on one tree share its stems. */
const treeOf = (id: string): string => id.replace(/:\d+$/, '');

interface Candidate { rank: number; side: Side; to: Point; strip: Rect }
interface Exit {
  link: LayoutLink;
  end: 'from' | 'to';
  terminal: Point;
  exited: string[];
  /** The key that orders exits: endpoints, the side and the boxes, then the link's own content. Never an array index. */
  key: string;
  candidates: Candidate[];
  chosen?: Candidate | undefined;
}

/** A link end whose shared run ends inside a box it leaves: the box holds the terminal and the near end, not the far end. */
export interface ExitNeed { link: LayoutLink; end: 'from' | 'to'; terminal: Point; exited: { id: string; bounds: Rect }[] }

/**
 * Every link end that needs a group exit, read from the geometry alone: a routed link with a shared run whose last point stands inside a box that
 * holds the near end and not the far end. The reservation and the postcondition of 7e and 7f (DR-11) read this one function.
 */
export function exitNeeds(model: LayoutModel, boxes: readonly { id: string; bounds: Rect }[] = groupBoxes(model)): ExitNeed[] {
  const needs: ExitNeed[] = [];
  for (const link of model.links) {
    if (link.layer === 'overlay' || link.technique === 'stub' || link.bundle || link.path?.fixed === true || link.fixedSegments?.length || !link.attachments) continue;
    for (const end of ['from', 'to'] as const) {
      const runs = link.sharedRuns?.[end];
      if (!runs?.length) continue;
      const ref = link.attachments[end], far = link.attachments[end === 'from' ? 'to' : 'from'];
      const terminal = runs.at(-1)!.to;
      const exited = boxes.filter(box => inside(box.bounds, terminal) && standsIn(model, box.id, ref.node) && !standsIn(model, box.id, far.node));
      if (exited.length) needs.push({ link, end, terminal, exited });
    }
  }
  return needs;
}

const exitKey = (link: string, end: 'from' | 'to'): string => `${link}:${end}`;

/**
 * Every shared run that ends inside its own group gets a reserved exit (ticket 13, ADR-0013).
 *
 * The fan's junction row stands in the group padding, and a link attached inside a group is exempt
 * from that group's obstacle, so the router used to find its own way out along the group edge. The
 * exit is one straight run from the terminal, along the junction row (toward the far end first, then
 * away) or along the port normal, to just past the margin of the farthest box it leaves.
 *
 * The exits are allocated together. Each candidate is judged against one immutable snapshot of the
 * placed model: every group box but the ones the link leaves or stands in, every node, label, lane
 * and reserved run of another link, and the checkpoint every port will be approached from. Only the
 * geometry the link owns is exempt, and of its own junction tree only the stems, which it shares.
 * Exits whose candidates conflict form a component; each component takes the assignment of least
 * cost (the sum of the directions' ranks, a refused exit costing most) by a depth-first search in
 * the order of the exits' endpoint keys. The result does not depend on the order of `model.links`.
 * All runs are committed together, each recorded as a `GroupExit` promise on the model; an exit
 * with no candidate left is a placement error, `GROUP_EXIT_BLOCKED`, and keeps its terminal.
 *
 * A recorded exit is a held promise (DR-11, D-Q3): its direction and the boxes it leaves are a stored decision, and only its coordinates follow
 * the box. A later derivation offers a held end its held direction alone while that direction is free and the end leaves the same boxes. Any
 * other outcome for a held end (another direction, other boxes, no exit, no need) is a replan: it is allowed before the final freeze (the
 * placement snapshot of 7f) and refused after it.
 */
export function reserveGroupExits(model: LayoutModel, searchBudget = SEARCH_BUDGET): void {
  const held = new Map((model.groupExits ?? []).map(exit => [exitKey(exit.link, exit.end), exit]));
  delete model.groupExits;
  const boxes = groupBoxes(model), half = routedStroke(model) / 2;
  const margin = half + GROUP_EDGE_LINK_CLEARANCE + EXIT_SLACK;
  // The choice reads what placement reserved, never a route: a model that already carries stage 8's paths must give the same exits.
  const placed = { ...model, links: model.links.map(item => item.path !== undefined && item.path.fixed !== true && !item.bundle ? { ...item, path: undefined } : item) } as LayoutModel;
  const treeObstacles = new Map<string, RouteObstacle[]>();
  const stems = (trees: Set<string>): PathSegment[] => placed.links.flatMap(item => [...(item.sharedRuns?.from ?? []), ...(item.sharedRuns?.to ?? [])])
    .filter(run => run.owner.kind === 'shared-stem' && trees.has(treeOf(run.owner.id)));
  const obstaclesFor = (trees: Set<string>): RouteObstacle[] => {
    const key = [...trees].sort().join('|');
    const cached = treeObstacles.get(key);
    if (cached) return cached;
    // The trees' stems are shared by the links on them: a snapshot without them, and their raw segments instead of their covers.
    const isStem = (segment: PathSegment): boolean => segment.owner.kind === 'shared-stem' && trees.has(treeOf(segment.owner.id));
    const stripped = { ...placed, links: placed.links.map(item => item.sharedRuns === undefined ? item : { ...item, sharedRuns: {
      ...(item.sharedRuns.from ? { from: item.sharedRuns.from.filter(segment => !isStem(segment)) } : {}),
      ...(item.sharedRuns.to ? { to: item.sharedRuns.to.filter(segment => !isStem(segment)) } : {}) } }) } as LayoutModel;
    const result = routeObstacles(stripped);
    treeObstacles.set(key, result);
    return result;
  };
  // The checkpoint every routed port is approached from: a point stage 8 will ask for, so no exit may close it.
  const checkpoints = model.links.filter(item => item.layer !== 'overlay' && item.technique !== 'stub' && item.attachments).flatMap(item =>
    (['from', 'to'] as const).flatMap(end => {
      const ref = item.attachments![end], port = model.nodes[ref.node]?.ports.find(one => portId(one.ref) === portId(ref));
      if (!port?.anchor || !port.side) return [];
      const out = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[port.side], reach = portStemReach(model, port);
      return [{ port: portId(ref), bounds: grow({ x: port.anchor.x + out[0]! * reach, y: port.anchor.y + out[1]! * reach, width: 0, height: 0 }, half + 4) }];
    }));
  const NORMAL: Record<Side, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
  const sideOf = (dx: number, dy: number): Side => dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'bottom' : 'top';
  const exits: Exit[] = [];
  for (const { link, end, terminal, exited } of exitNeeds(model, boxes)) {
    const runs = link.sharedRuns![end]!;
    const ref = link.attachments![end], far = link.attachments![end === 'from' ? 'to' : 'from'];
    const port = model.nodes[ref.node]?.ports.find(item => portId(item.ref) === portId(ref));
    const farPort = model.nodes[far.node]?.ports.find(item => portId(item.ref) === portId(far));
    if (!port?.side || !port.anchor || !farPort?.anchor) throw new Error(`Link ${link.id} has a shared run on a port without a side or an anchor`);
    const reach = (dx: number, dy: number): number => Math.max(...exited.map(({ bounds }) =>
      dx > 0 ? bounds.x + bounds.width + margin - terminal.x : dx < 0 ? terminal.x - bounds.x + margin
        : dy > 0 ? bounds.y + bounds.height + margin - terminal.y : terminal.y - bounds.y + margin));
    const horizontalRow = port.side === 'top' || port.side === 'bottom';
    const toward = horizontalRow ? Math.sign(farPort.anchor.x - terminal.x) || 1 : Math.sign(farPort.anchor.y - terminal.y) || 1;
    const along = (s: number): [number, number] => horizontalRow ? [s, 0] : [0, s];
    const directions: [number, number][] = [along(toward), along(-toward), NORMAL[port.side]];
    const trees = new Set(runs.flatMap(run => run.owner.kind === 'shared-stem' ? [treeOf(run.owner.id)] : []));
    const own = new Set(exited.map(box => box.id));
    const obstacles = obstaclesFor(trees).filter(item => {
      if (item.consumers.includes(link.id) && !item.id.startsWith('group:')) return false;
      if (item.id.startsWith('group:')) { const id = item.id.slice(6); return !own.has(id) && !standsIn(model, id, ref.node); }
      return true;
    });
    const stroke = linkStrokeWidth(link), stemsOfTree = stems(trees);
    const candidates: Candidate[] = [];
    for (const [rank, [dx, dy]] of directions.entries()) {
      const length = reach(dx, dy), to = { x: terminal.x + dx * length, y: terminal.y + dy * length };
      const strip = stripOf(terminal, to, stroke);
      const blocked = obstacles.some(item => touches(item.bounds, strip)) || stemsOfTree.some(run => overlapsRun(run, terminal, to, stroke)) || checkpoints.some(item => item.port !== portId(ref) && touches(item.bounds, strip));
      if (!blocked) candidates.push({ rank, side: sideOf(dx, dy), to, strip });
    }
    // The held promise: the held direction alone, while it is free and the end leaves the same boxes.
    const promise = held.get(exitKey(link.id, end)), owners = exited.map(box => box.id).sort();
    const kept = promise !== undefined && promise.exited.join(',') === owners.join(',') ? candidates.filter(item => item.side === exitSide(promise)) : [];
    exits.push({ link, end, terminal, exited: owners, candidates: kept.length ? kept : candidates,
      key: [fixed(terminal.x), fixed(terminal.y), fixed(port.anchor.x), fixed(port.anchor.y), fixed(farPort.anchor.x), fixed(farPort.anchor.y), port.side, exited.map(box => box.id).sort().join(','), contentKey(model, link)].join('|') });
  }
  exits.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  // Two candidates conflict when the strips, each grown by the clearance a parallel run needs, meet.
  const apart = GROUP_EDGE_LINK_CLEARANCE + half;
  const clash = (a: Candidate, b: Candidate): boolean => touches(grow(a.strip, apart), b.strip);
  const parent = exits.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
  for (let i = 0; i < exits.length; i++) for (let j = i + 1; j < exits.length; j++) {
    if (exits[i]!.candidates.some(a => exits[j]!.candidates.some(b => clash(a, b)))) parent[find(j)] = find(i);
  }
  const components = new Map<number, Exit[]>();
  for (const [i, item] of exits.entries()) components.set(find(i), [...(components.get(find(i)) ?? []), item]);
  for (const component of components.values()) {
    let best = Infinity, bestPick: (Candidate | undefined)[] = [], budget = searchBudget, capped = false;
    const pick: (Candidate | undefined)[] = [];
    const search = (index: number, cost: number): void => {
      if (cost >= best) return;
      if (budget-- <= 0) { capped = true; return; }
      if (index === component.length) { best = cost; bestPick = [...pick]; return; }
      for (const candidate of component[index]!.candidates) {
        if (pick.slice(0, index).some(other => other !== undefined && clash(other, candidate))) continue;
        pick[index] = candidate; search(index + 1, cost + candidate.rank);
      }
      pick[index] = undefined; search(index + 1, cost + REFUSED);
    };
    search(0, 0);
    for (const [index, item] of component.entries()) item.chosen = bestPick[index];
    if (capped) {
      model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'GROUP_EXIT_SEARCH_CAPPED', owners: component.map(item => ({ kind: 'link' as const, id: item.link.id })),
        message: `The search for the group exits of ${component.map(item => item.link.id).join(', ')} stopped after ${searchBudget} steps; the best assignment found stands.` });
    }
  }
  // A held end whose outcome differs from its promise is a replan; after the final freeze the placement is fixed and nothing may replan.
  if (model.freeze?.placement !== undefined) {
    const now = new Map(exits.map(item => [exitKey(item.link.id, item.end), item]));
    for (const [key, promise] of held) {
      const item = now.get(key);
      const outcome = item === undefined ? 'needs no exit' : item.chosen === undefined ? 'has no free direction'
        : item.chosen.side !== exitSide(promise) ? `leaves by ${item.chosen.side}, not ${exitSide(promise)}`
          : item.exited.join(',') !== promise.exited.join(',') ? `leaves ${item.exited.join(', ')}, not ${promise.exited.join(', ')}` : undefined;
      if (outcome !== undefined) throw new Error(`Group exit ${key} cannot be replanned after the final freeze: it ${outcome}`);
    }
  }
  const promised: GroupExit[] = [];
  for (const item of exits) {
    const { link, end, terminal, chosen } = item;
    if (!chosen) {
      model.diagnostics.push({ stage: 'placement', severity: 'error', code: 'GROUP_EXIT_BLOCKED', owners: [{ kind: 'link', id: link.id }],
        message: `${link.id} ends its shared run inside ${item.exited.join(', ')} and no direction out of the group is free of other reservations.` });
      continue;
    }
    link.sharedRuns![end]!.push({ from: { ...terminal }, to: { ...chosen.to }, owner: { ...link.owner } as LayoutLink['owner'] });
    promised.push({ link: link.id, end, exited: item.exited, from: { ...terminal }, to: { ...chosen.to }, clearance: margin });
  }
  if (promised.length) model.groupExits = promised;
}

/** The side of a group a promised exit leaves by, read from its run. */
export function exitSide(exit: GroupExit): Side {
  return Math.abs(exit.to.x - exit.from.x) > Math.abs(exit.to.y - exit.from.y) ? (exit.to.x > exit.from.x ? 'right' : 'left') : (exit.to.y > exit.from.y ? 'bottom' : 'top');
}
