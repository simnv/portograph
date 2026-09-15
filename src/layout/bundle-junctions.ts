import type { Bundle, LayoutLink, LayoutModel, LayoutPort, Owner, PathSegment, Point, Rect } from '../model/index.js';
import type { PortRef } from '../model/document.js';
import { portId } from './skeleton-graph.js';
import { MEMBER_GAP, axis, bundleFanRows, clone, coordinate, facing, fanCohorts, fanEnd, fanPitch, fanRows, junctionId, normal, type Member } from './bundle-geometry.js';
import { placementWarning } from './regions.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { nodeObstacleReach, routedStroke, stemReach } from './bands.js';

export interface BundleFans {
  members: Member[];
  a: Map<string, PathSegment[]>;
  b: Map<string, PathSegment[]>;
}
/** Expand shared incidence into distinct channel tracks through explicit nested shared runs. */
export function bundleFans(model: LayoutModel, bundle: Bundle, list: Member[], q: number): BundleFans | undefined {
  const shared = (['a', 'b'] as const).some(end => new Set(list.map(m => portId(m[end].ref))).size < list.length);
  if (!shared && !list.some(m => m.link.sharedRuns?.from?.length || m.link.sharedRuns?.to?.length)) return undefined;
  const result: BundleFans = { members: list.map(m => ({ ...m, a: clone(m.a), b: clone(m.b) })), a: new Map(), b: new Map() };
  for (const end of ['a', 'b'] as const) {
    const far = end === 'a' ? 'b' : 'a';
    const ordered = [...list].sort((a, b) => coordinate(a[end]) - coordinate(b[end]) || coordinate(a[far]) - coordinate(b[far]) || a.link.sourceIndex - b.link.sourceIndex);
    const groups = new Map<LayoutPort, Member[]>();
    for (const item of ordered) { const own = groups.get(item[end]) ?? []; own.push(item); groups.set(item[end], own); }
    const spacing = Math.max(q, ...ordered.map(m => model.nodes[m[end].ref.node]!.sidePitch![m[end].side!]!));
    const base = Math.min(...ordered.map(m => coordinate(m[end])));
    for (const [port, own] of groups) {
      // Fan rows sit 15 px out and then one pitch apart, but never within the edge margin of a group
      // edge they run along (ADR-0013): a row that would, and every row after it, moves outward.
      // Stage 7e reserves this same figure before any path exists (ticket 39).
      const { rows, distance } = bundleFanRows(model, port, own.map(m => m.link), list.length, q);
      const reserved = own.map(m => ({ member: m, runs: m.link.sharedRuns?.[end === 'a' ? m.reversed ? 'to' : 'from' : m.reversed ? 'from' : 'to'] }));
      if (reserved.every(item => item.runs?.length)) {
        for (const item of reserved) {
          result[end].set(item.member.link.id, clone(item.runs!));
          result.members.find(m => m.link.id === item.member.link.id)![end].anchor = { ...item.runs!.at(-1)!.to };
        }
        continue;
      }
      if (!shared || own.length === 1) {
        for (const member of own) result[end].set(member.link.id, []);
        continue;
      }
      const n = normal(port.side!), tangent = axis(port.side!);
      const world = (u: number, v: number): Point => tangent === 'x' ? { x: u, y: port.anchor!.y + n.y * v }
        : { x: port.anchor!.x + n.x * v, y: u };
      // A free bar star can continue each independent peer track straight into its leaf.
      // Do not project through genuine lane/crossed-bar reservations or another port cohort.
      const drops = model.barDrops.filter(drop => own.some(m => m.link.id === drop.link));
      const peers = own.map(m => coordinate(m[far])).sort((a, b) => a - b);
      const memberIds = new Set(own.map(m => m.link.id));
      const project = own.length === list.length && facing(list) && drops.length > 0 && drops.every(drop => !drop.barCross.length)
        && !model.lanes.some(lane => lane.owner.kind === 'link' && memberIds.has(lane.owner.id))
        && peers.slice(1).every((value, index) => value - peers[index]! >= q - 1e-6);
      const outputs = new Map(own.map(m => {
        const tier = model.groups[model.document.nodes[port.ref.node]!.group]!.tier!;
        const lane = tangent === 'x' ? model.lanes.filter(l => l.owner.kind === 'link' && l.owner.id === m.link.id)
          .sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier))[0] : undefined;
        return [m.link.id, lane?.x ?? (project ? coordinate(m[far]) : base + ordered.indexOf(m) * spacing)];
      }));
      const segments = new Map(own.map(m => [m.link.id, [] as PathSegment[]]));
      const push = (id: string, from: Point, to: Point, owner: Owner): void => {
        if (from.x !== to.x || from.y !== to.y) segments.get(id)!.push({ from: { ...from }, to: { ...to }, owner: { ...owner } });
      };
      let active = [...own], current = { ...port.anchor! }, previous: string | undefined;
      let depth = 0;
      while (active.length >= 2) {
        const id = `junction:${portId(port.ref)}:${bundle.id}:${depth}`, owner = { kind: 'shared-stem' as const, id };
        const point = world(coordinate(port), rows[depth]!);
        const stem: PathSegment = { from: { ...current }, to: { ...point }, owner };
        model.junctions.push({ id, owner, layer: 'routed', port: { ...port.ref }, links: active.map(m => m.link.id),
          ...(previous ? { parent: previous } : {}), point, stem });
        for (const member of active) segments.get(member.link.id)!.push(clone(stem));
        // Peel the track farthest from the shared normal. Remaining members continue on the shared normal.
        const leaf = [...active].sort((a, b) => Math.abs(outputs.get(b.link.id)! - coordinate(port)) - Math.abs(outputs.get(a.link.id)! - coordinate(port)))[0]!, output = outputs.get(leaf.link.id)!;
        const elbow = world(output, rows[depth]!), terminal = world(output, distance);
        push(leaf.link.id, point, elbow, owner);
        push(leaf.link.id, elbow, terminal, elbow.x === point.x && elbow.y === point.y ? owner : bundle.owner);
        active = active.filter(m => m !== leaf); current = point; previous = id; depth++;
      }
      const last = active[0]!, output = outputs.get(last.link.id)!;
      const elbow = world(output, previous ? rows[depth - 1]! : rows[0]!);
      const owner: Owner = previous ? { kind: 'shared-stem', id: previous } : bundle.owner;
      push(last.link.id, current, elbow, owner);
      push(last.link.id, elbow, world(output, distance), previous && coordinate(port) === output ? owner : bundle.owner);
      for (const member of own) {
        result[end].set(member.link.id, segments.get(member.link.id)!);
        result.members.find(m => m.link.id === member.link.id)![end].anchor = world(outputs.get(member.link.id)!, distance);
      }
    }
  }
  return result;
}

/**
 * The spans along `port`'s side at which a fan branch may not turn: for every node whose routing
 * obstacle stands in the corridor the branch's outward run crosses, the span that node occupies
 * along the side (ADR-0018 rule 3, ticket 45). Rule 2 spaces a track against the rows on its own
 * side; this is what spaces it against the nodes beside it.
 *
 * The reach is `routeObstacles`' own — the enclosing rectangle of the expanded body and of every
 * expanded pill, since the router owns the corners between them — so the room the fan reserves is
 * the room the gates then measure. The fan's own node is left out: a branch leaves that node's port,
 * and G2 exempts that one outward stem.
 */
function blockedTracks(model: LayoutModel, port: LayoutPort, band: { from: number; to: number },
  stroke: number): { lo: number; hi: number }[] {
  const n = normal(port.side!), tangent = axis(port.side!);
  const low = Math.min(band.from, band.to), high = Math.max(band.from, band.to);
  const pillGap = (stroke + DEFAULT_STROKE_WIDTHS.pill) / 2;
  const grow = (box: Rect, by: number): Rect =>
    ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
  const result: { lo: number; hi: number }[] = [];
  for (const node of Object.values(model.nodes)) {
    if (!node.bounds || node.layer === 'overlay' || node.id === port.ref.node) continue;
    const boxes = [grow(node.bounds, nodeObstacleReach(model, node, stroke)),
      ...node.ports.filter(item => item.pill && item.pill.layer !== 'overlay').map(item => grow(item.pill!.bounds, pillGap))];
    const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
    const box = { x, y, right: Math.max(...boxes.map(box => box.x + box.width)), bottom: Math.max(...boxes.map(box => box.y + box.height)) };
    // The box mapped onto the side's own two axes: how deep it reaches out of the side, and where it
    // stands along it.
    const depths = tangent === 'y' ? [n.x * (box.x - port.anchor!.x), n.x * (box.right - port.anchor!.x)]
      : [n.y * (box.y - port.anchor!.y), n.y * (box.bottom - port.anchor!.y)];
    if (Math.max(...depths) <= low + 1e-6 || Math.min(...depths) >= high - 1e-6) continue;
    result.push(tangent === 'y' ? { lo: box.y, hi: box.bottom } : { lo: box.x, hi: box.right });
  }
  return result;
}

/**
 * A port can belong to several bundles, to a plain fan of routed links, or to a bundle and a later
 * routing remainder. One junction tree owns it: every link leaves the anchor on one shared stem and
 * peels off at its own row, so stage 8 starts each remainder at its leaf instead of drawing the same
 * first 15 px twice (ticket 20). A port whose links all belong to one bundle is that bundle's own
 * fan (`bundleFans`) and is left alone.
 */
export function crossBundleFans(model: LayoutModel): void {
  for (const link of model.links) delete link.sharedRuns;
  // Eligibility is `treeCohorts`' (shared with 7e's capacity reservation); this producer adds only
  // the ends and far ports it needs, and leaves a port whose links all belong to one bundle to that
  // bundle's own fan (`bundleFans`).
  const { cohorts, excluded } = fanCohorts(model);
  for (const { port, link } of excluded) {
    placementWarning(model, 'FAN_MEMBER_UNRESERVED',
      `${link.id} keeps a path an earlier rule fixed, so the shared stem at ${port.ref.node}.${port.ref.name ?? '*'} does not cover it; its own stem overlaps the tree root (ticket 37).`,
      [link.id]);
  }
  for (const { port, links } of cohorts) {
    const bundles = new Set(links.map(link => link.bundle));
    if (bundles.size === 1 && !bundles.has(undefined)) continue;
    const items = links.map(link => {
      const end: 'from' | 'to' = portId(link.attachments!.from) === portId(port.ref) ? 'from' : 'to';
      const farRef = link.attachments![end === 'from' ? 'to' : 'from'];
      const far = model.nodes[farRef.node]!.ports.find(p => portId(p.ref) === portId(farRef))!;
      return { link, end, far };
    });
    const tangent = axis(port.side!), n = normal(port.side!);
    // Rows and tracks one pitch apart: 16 px of visible clearance plus the widest member stroke.
    const q = fanPitch(links);
    const world = (u: number, v: number): Point => tangent === 'x' ? { x: u, y: port.anchor!.y + n.y * v }
      : { x: port.anchor!.x + n.x * v, y: u };
    // A member that owns a lane in the adjacent tier must end its leaf on that lane's x, exactly as
    // a bundle fan does: placement knows the lane, so stage 8 never has to find it sideways.
    const tier = model.groups[model.document.nodes[port.ref.node]!.group]!.tier!;
    const laneX = (id: string): number | undefined => tangent === 'x' ? model.lanes
      .filter(l => l.owner.kind === 'link' && l.owner.id === id)
      .sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier))[0]?.x : undefined;
    // Rows one pitch apart from a 15 px stem, each moved off the port group's edge margin (ADR-0013);
    // the same rows 7d used to split a fixed member's path. The tracks are spaced inside the corridor
    // these rows name, so both are known before either is used.
    const rows = fanRows(model, port, links), end = fanEnd(model, port, links);
    // Where a member's own approach starts. A far port that faces this side stands at its own
    // coordinate along it. A far port whose normal runs *along* this side stands on its node's edge
    // instead, so a branch that turned there would run along that node: the coordinate such a
    // member wants is its outward checkpoint, where its own approach begins (ADR-0018 rule 3).
    const approach = (item: typeof items[number]): number => {
      const side = item.far.side!;
      if (axis(side) === tangent) return item.far.anchor![tangent];
      return item.far.anchor![tangent] + normal(side)[tangent] * stemReach(model, model.nodes[item.far.ref.node]!);
    };
    // How deep out of the side a branch's own run goes. Every branch reaches the tree's common end,
    // except one whose far port's normal runs along this side: that branch turns out of the fan and
    // then travels along the far port's own normal, so its run stops where that normal stands. Ending
    // it at the common end beyond that would make stage 8 retrace the reserved run to come back.
    const stop = (item: typeof items[number], row: number): number => {
      const side = item.far.side!;
      if (item.link.path?.fixed === true || axis(side) === tangent) return end;
      const depth = tangent === 'y' ? n.x * (item.far.anchor!.x - port.anchor!.x) : n.y * (item.far.anchor!.y - port.anchor!.y);
      return Math.min(end, Math.max(row, depth));
    };
    // A member whose path a rule fixed is the straight-through leaf (ADR-0016): its target is the
    // port's own coordinate, so it is peeled last and its stems are its path's leading segments.
    const wanted = (item: typeof items[number]): number => item.link.path?.fixed === true ? coordinate(port) : laneX(item.link.id) ?? approach(item);
    const ordered = [...items].sort((a, b) => wanted(a) - wanted(b) || a.link.sourceIndex - b.link.sourceIndex);
    const target = new Map<string, number>();
    // A fixed member owns the port's own track exactly, since its path runs straight there (7d);
    // the pitch pass spaces every other member around that track, never onto it.
    const fixedItem = items.find(item => item.link.path?.fixed === true);
    const reserved = fixedItem ? coordinate(port) : undefined;
    if (fixedItem) target.set(fixedItem.link.id, reserved!);
    // Every other port on this side sends its own links out along its own coordinate, so a track
    // laid on one of those rows runs beside them for the whole width of the fan (ADR-0018 rule 2,
    // ticket 42). The side's rows are steps the pitch pass takes, exactly as a fixed member's own
    // track already is. `sidePitch` is what holds the room between them, reserved at sizing.
    // Every other port on this side sends its own links out along its own coordinate, each needing
    // the clearance its own stroke asks for. A track must stay on the side of that row its far end
    // is on: stepping *past* a sibling reorders the members against their endpoints, which is the
    // topology change rule 2 exists to prevent, and lands the track where that sibling's own links
    // run — inside the envelope when the sibling is bundled.
    const atPort = (ref: PortRef): LayoutLink[] => model.links.filter(link => link.layer === 'routed'
      && link.technique !== 'stub' && link.attachments
      && [link.attachments.from, link.attachments.to].some(other => portId(other) === portId(ref)));
    const siblings = model.nodes[port.ref.node]!.ports
      .filter(other => other.side === port.side && portId(other.ref) !== portId(port.ref)
        && other.anchor && atPort(other.ref).length > 0)
      .map(other => ({ at: other.anchor![tangent], stroke: Math.max(...atPort(other.ref).map(linkStrokeWidth)) }));
    const occupied = [...(reserved === undefined ? [] : [{ at: reserved, stroke: routedStroke(model) }]), ...siblings]
      .sort((x, y) => x.at - y.at);
    let prior = -Infinity;
    for (const item of ordered) {
      if (item === fixedItem) continue;
      const own = linkStrokeWidth(item.link);
      // ADR-0018 rule 3 (ticket 45): a track is measured against the nodes beside the side as well
      // as against the rows on it. The corridor a branch's outward run crosses is the band from the
      // fan's first row to its end, and every node standing in that band is a wall the track steps
      // past, on the side its own far end is on.
      const walls = blockedTracks(model, port, { from: rows[0]!, to: stop(item, rows[0]!) }, own);
      let slot = Math.max(wanted(item), prior + q);
      // Re-check every row after any move: a step taken for one row can carry the slot onto another
      // it already passed. Bounded, since each pass only moves the slot away from the target's side.
      for (let guard = 0; guard < occupied.length + walls.length + 1; guard++) {
        const hit = occupied.find(row => Math.abs(slot - row.at) < MEMBER_GAP + (own + row.stroke) / 2 - 1e-6);
        if (hit) {
          const clearance = MEMBER_GAP + (own + hit.stroke) / 2;
          const keep = wanted(item) <= hit.at ? hit.at - clearance : hit.at + clearance;
          slot = keep >= prior + q - 1e-6 ? keep : hit.at + clearance;
          continue;
        }
        const wall = walls.find(span => slot > span.lo - 1e-6 && slot < span.hi + 1e-6);
        if (!wall) break;
        const keep = Math.abs(wanted(item) - wall.lo) <= Math.abs(wanted(item) - wall.hi) ? wall.lo : wall.hi;
        slot = keep >= prior + q - 1e-6 ? keep : wall.hi;
      }
      target.set(item.link.id, slot); prior = slot;
    }
    const isFixed = (id: string): boolean => links.find(link => link.id === id)?.path?.fixed === true;
    let active = [...ordered], cursor = { ...port.anchor! }, parent: string | undefined, depth = 0;
    let peeled: number | undefined;
    const paths = new Map(items.map(item => [item.link.id, [] as PathSegment[]]));
    const push = (id: string, from: Point, to: Point, owner: Owner): void => {
      if (from.x !== to.x || from.y !== to.y) paths.get(id)!.push({ from: { ...from }, to: { ...to }, owner: { ...owner } });
    };
    while (active.length > 1) {
      const id = junctionId(port, depth), owner = { kind: 'shared-stem' as const, id };
      const point = world(coordinate(port), rows[depth]!), stem: PathSegment = { from: cursor, to: point, owner };
      model.junctions.push({ id, owner, layer: 'routed', port: { ...port.ref }, links: active.map(i => i.link.id),
        ...(parent ? { parent } : {}), point, stem });
      for (const item of active) paths.get(item.link.id)!.push(clone(stem));
      // Farthest track first; a fixed member is never peeled while another member remains.
      const leaf = [...active].sort((a, b) => (Number(isFixed(a.link.id)) - Number(isFixed(b.link.id)))
        || Math.abs(target.get(b.link.id)! - coordinate(port)) - Math.abs(target.get(a.link.id)! - coordinate(port)))[0]!;
      const elbow = world(target.get(leaf.link.id)!, rows[depth]!);
      push(leaf.link.id, point, elbow, owner);
      push(leaf.link.id, elbow, world(target.get(leaf.link.id)!, stop(leaf, rows[depth]!)), leaf.link.owner);
      peeled = target.get(leaf.link.id)!;
      active = active.filter(i => i !== leaf); cursor = point; parent = id; depth++;
    }
    // The member left over turns at the last junction's own row, which the branch that peeled there
    // also used. Two branches that leave the point the same way therefore run along one line
    // (ticket 41). Only then does the member left over take a row of its own (ticket 20, ADR-0016):
    // it keeps the shared normal out to `rows[depth]`, which `fanRows` already holds and `fanEnd`
    // already lies beyond, and turns there. Branches leaving the point opposite ways never meet, and
    // a straight-through leaf turns nowhere, so both keep the shorter path they had.
    const last = active[0]!, owner = { kind: 'shared-stem' as const, id: parent! };
    const goal = target.get(last.link.id)!, here = coordinate(port);
    const shares = goal !== here && Math.sign(goal - here) === Math.sign(peeled! - here);
    if (shares) {
      const turn = world(here, rows[depth]!), elbow = world(goal, rows[depth]!);
      // The extension leaves the last junction's point along the shared normal, so it claims that
      // junction like every other branch there; G6 excuses a branch at a tree vertex, not a stray run.
      push(last.link.id, cursor, turn, owner);
      push(last.link.id, turn, elbow, last.link.owner);
      push(last.link.id, elbow, world(goal, stop(last, rows[depth]!)), last.link.owner);
    } else {
      const elbow = world(goal, rows[depth - 1]!);
      push(last.link.id, cursor, elbow, owner);
      push(last.link.id, elbow, world(goal, stop(last, rows[depth - 1] ?? rows[0]!)), goal === here ? owner : last.link.owner);
    }
    for (const item of items) {
      item.link.sharedRuns ??= {};
      // A fixed member's runs are the same stems and straight continuation 7d wrote into its path.
      item.link.sharedRuns[item.end] = paths.get(item.link.id)!;
    }
  }
}
