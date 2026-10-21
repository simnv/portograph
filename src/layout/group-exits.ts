import type { Point, Rect, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel } from '../model/layout.js';
import { frameSubtreeCells } from '../model/index.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { groupBoxes } from '../score/model.js';
import { routeObstacles } from '../route/obstacles.js';
import { portId } from './skeleton-graph.js';
import { routedStroke } from './bands.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** Extra distance past the group's edge margin where a reserved exit stops, so the route turns clear of the gate's limit. */
const EXIT_SLACK = 2;

/**
 * Whether `nodeId` stands in the box `boxId` (a group or a frame): in the group itself, in a child of
 * it, or in a cell of the frame or of one of its child frames. Ancestry decides, not the innermost group.
 */
function standsIn(model: LayoutModel, boxId: string, nodeId: string): boolean {
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
const hit = (box: Rect, p: Point): boolean =>
  p.x >= box.x - PLACEMENT_EPS && p.x <= box.x + box.width + PLACEMENT_EPS && p.y >= box.y - PLACEMENT_EPS && p.y <= box.y + box.height + PLACEMENT_EPS;

/**
 * A shared run that ends inside its own group gets a reserved exit (ticket 13, ADR-0013).
 *
 * The fan's junction row stands in the group padding, and a link attached inside a group is exempt
 * from that group's obstacle, so the router used to find its own way out along the group edge. The
 * exit is chosen here, before the placement freeze: one straight run from the terminal, along the
 * junction row (toward the far end first, then away) or along the port normal, to just past the
 * group's edge margin. It is appended to the link's shared run, so it is a reserved run owned by
 * that link and every other link must respect it. A group the far end also stands in is no
 * obstacle to leave; a nested far end is read by ancestry. When no direction is free the link
 * keeps its terminal and `GROUP_EXIT_BLOCKED` is raised as a placement error.
 */
export function reserveGroupExits(model: LayoutModel): void {
  const boxes = groupBoxes(model), half = routedStroke(model) / 2;
  // The choice reads what placement reserved, never a route: a model that already carries stage 8's paths must give the same exits.
  const placed = { ...model, links: model.links.map(item => item.path !== undefined && item.path.fixed !== true && !item.bundle ? { ...item, path: undefined } : item) } as LayoutModel;
  // A branch the fan gave up to leave the far port's approach open keeps only its stems: reserving past them would close what the release opened.
  const hemmed = new Set(model.diagnostics.filter(item => item.code === 'FAN_BRANCH_HEMMED' || item.code === 'FAN_BRANCH_UNRESERVED')
    .flatMap(item => (item.owners ?? []).flatMap(owner => 'id' in owner ? [owner.id] : [])));
  for (const link of model.links) {
    if (hemmed.has(link.id)) continue;
    if (link.layer === 'overlay' || link.technique === 'stub' || link.bundle || link.path?.fixed === true || link.fixedSegments?.length || !link.attachments) continue;
    for (const end of ['from', 'to'] as const) {
      const runs = link.sharedRuns?.[end];
      if (!runs?.length) continue;
      const ref = link.attachments[end], far = link.attachments[end === 'from' ? 'to' : 'from'];
      const terminal = runs.at(-1)!.to;
      // Every box that holds the terminal and not the far end is left; the largest sets the length.
      const left = boxes.filter(box => inside(box.bounds, terminal) && standsIn(model, box.id, ref.node) && !standsIn(model, box.id, far.node));
      if (!left.length) continue;
      const port = model.nodes[ref.node]?.ports.find(item => portId(item.ref) === portId(ref));
      const farPort = model.nodes[far.node]?.ports.find(item => portId(item.ref) === portId(far));
      if (!port?.side || !farPort?.anchor) continue;
      const margin = half + GROUP_EDGE_LINK_CLEARANCE + EXIT_SLACK;
      const reach = (dx: number, dy: number): number => Math.max(...left.map(({ bounds }) =>
        dx > 0 ? bounds.x + bounds.width + margin - terminal.x : dx < 0 ? terminal.x - bounds.x + margin
          : dy > 0 ? bounds.y + bounds.height + margin - terminal.y : terminal.y - bounds.y + margin));
      const horizontalRow = port.side === 'top' || port.side === 'bottom';
      const toward = horizontalRow ? Math.sign(farPort.anchor.x - terminal.x) || 1 : Math.sign(farPort.anchor.y - terminal.y) || 1;
      const NORMAL: Record<Side, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
      const along = (s: number): [number, number] => horizontalRow ? [s, 0] : [0, s];
      const options: [number, number][] = [along(toward), along(-toward), NORMAL[port.side]];
      const stroke = linkStrokeWidth(link);
      const obstacles = routeObstacles(placed).filter(item => !item.id.startsWith('group:') && !item.consumers.includes(link.id));
      const chosen = options.find(([dx, dy]) => {
        const length = reach(dx, dy), to = { x: terminal.x + dx * length, y: terminal.y + dy * length };
        const strip: Rect = { x: Math.min(terminal.x, to.x) - stroke / 2, y: Math.min(terminal.y, to.y) - stroke / 2,
          width: Math.abs(to.x - terminal.x) + stroke, height: Math.abs(to.y - terminal.y) + stroke };
        return !obstacles.some(item => !hit(item.bounds, terminal) && touches(item.bounds, strip));
      });
      if (!chosen) {
        model.diagnostics.push({ stage: 'placement', severity: 'error', code: 'GROUP_EXIT_BLOCKED', owners: [{ kind: 'link', id: link.id }],
          message: `${link.id} ends its shared run inside ${left[0]!.id} and no direction out of the group is free of other reservations.` });
        continue;
      }
      const length = reach(chosen[0], chosen[1]);
      runs.push({ from: { ...terminal }, to: { x: terminal.x + chosen[0] * length, y: terminal.y + chosen[1] * length }, owner: { ...link.owner } as LayoutLink['owner'] });
    }
  }
}
