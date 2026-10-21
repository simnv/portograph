import type { Bundle, LayoutLink, LayoutModel, LayoutPort, Owner, PathSegment, Point, Rect } from '../model/index.js';
import type { PortRef } from '../model/document.js';
import { portId } from './skeleton-graph.js';
import { reserveGroupExits } from './group-exits.js';
import { MEMBER_GAP, axis, bundleFanRows, clone, coordinate, facing, fanCohorts, fanEnd, fanPitch, fanRows, junctionId, normal, type Member } from './bundle-geometry.js';
import { placementWarning } from './regions.js';
import { STRAIGHT_PATH_CLEARANCE, findPort } from './row-paths.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { GROUP_LABEL_GEOMETRY, nodeObstacleReach, nudgingDistance, routedStroke, stemReach } from './bands.js';
import { stemCache, stemPlan } from './sides-two.js';
import { groupBoxes, groupConsumers } from '../score/model.js';
import { segmentRectDistance } from '../geometry/planar.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../theme/geometry.js';
import { PLACEMENT_EPS, SIGN_EPS } from './tolerance.js';

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
        && peers.slice(1).every((value, index) => value - peers[index]! >= q - PLACEMENT_EPS);
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
 * The reach is `routeObstacles`' own — the widest routed stroke, and the enclosing rectangle of the
 * expanded body and of every expanded pill, since the router owns the corners between them — so the
 * room the fan reserves is the room stage 8 and the gates then measure. The fan's own node is left
 * out: a branch leaves that node's port, and G2 exempts that one outward stem.
 *
 * The spans are merged, so they are disjoint and no two of them touch. A track stepped to the edge
 * of one can then never land inside another, which is what makes the step terminate and makes the
 * answer independent of the order the nodes were read in.
 */
function blockedTracks(model: LayoutModel, port: LayoutPort, band: { from: number; to: number },
  exempt: ReadonlySet<string>): { lo: number; hi: number }[] {
  const n = normal(port.side!), tangent = axis(port.side!), stroke = routedStroke(model);
  const low = Math.min(band.from, band.to), high = Math.max(band.from, band.to);
  const pillGap = (stroke + DEFAULT_STROKE_WIDTHS.pill) / 2;
  const grow = (box: Rect, by: number): Rect =>
    ({ x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by });
  const found: { lo: number; hi: number }[] = [];
  const span = (box: { x: number; y: number; right: number; bottom: number }): void => {
    const depths = tangent === 'y' ? [n.x * (box.x - port.anchor!.x), n.x * (box.right - port.anchor!.x)]
      : [n.y * (box.y - port.anchor!.y), n.y * (box.bottom - port.anchor!.y)];
    if (Math.max(...depths) <= low + PLACEMENT_EPS || Math.min(...depths) >= high - PLACEMENT_EPS) return;
    found.push(tangent === 'y' ? { lo: box.y, hi: box.bottom } : { lo: box.x, hi: box.right });
  };
  // Every routed attachment holds an outward stem, whether a rule has claimed its path or not
  // (ADR-0015, sixth amendment). A fan branch may not turn inside one: the link that owns that stem
  // would then have no route to its own port, and stage 8 fails outright rather than failing a gate.
  // The two ports the branch itself uses are its own and are left out.
  const margin = GROUP_LABEL_GEOMETRY.nodeClearance + stroke;
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const end of ['from', 'to'] as const) {
      const ref = link.attachments[end], at = findPort(model, ref);
      if (!at?.anchor || at.side === undefined || exempt.has(portId(ref))) continue;
      const out = normal(at.side), reach = stemReach(model, model.nodes[ref.node]!);
      const tip = { x: at.anchor.x + out.x * reach, y: at.anchor.y + out.y * reach };
      span({ x: Math.min(at.anchor.x, tip.x) - margin, y: Math.min(at.anchor.y, tip.y) - margin,
        right: Math.max(at.anchor.x, tip.x) + margin, bottom: Math.max(at.anchor.y, tip.y) + margin });
    }
  }
  for (const node of Object.values(model.nodes)) {
    if (!node.bounds || node.layer === 'overlay' || node.id === port.ref.node) continue;
    const boxes = [grow(node.bounds, nodeObstacleReach(model, node, stroke)),
      ...node.ports.filter(item => item.pill && item.pill.layer !== 'overlay').map(item => grow(item.pill!.bounds, pillGap))];
    const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
    // The box mapped onto the side's own two axes: how deep it reaches out of the side, and where it
    // stands along it.
    span({ x, y, right: Math.max(...boxes.map(box => box.x + box.width)), bottom: Math.max(...boxes.map(box => box.y + box.height)) });
  }
  const result: { lo: number; hi: number }[] = [];
  for (const span of found.sort((a, b) => a.lo - b.lo || a.hi - b.hi)) {
    const last = result.at(-1);
    if (last && span.lo <= last.hi + PLACEMENT_EPS) last.hi = Math.max(last.hi, span.hi);
    else result.push({ ...span });
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
      `${link.id} keeps a path an earlier rule fixed, so the shared stem at ${port.ref.node}.${port.ref.name ?? '*'} does not cover it; its own stem overlaps the tree root.`,
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
    /**
     * Whether another link's reserved run already covers the checkpoint this member's far port must
     * be approached from. Nothing this fan reserves can then reach that checkpoint: the run is a
     * wall stage 8 may not cross, and the route fails outright instead of failing a gate. Such a
     * member keeps the plain coordinate and the tree's common end — what the fan drew before
     * ADR-0018 rule 3 — and the gates report what is left. A gate failure is recoverable.
     *
     * Only runs already reserved are seen, so the fan built first keeps its geometry and the one
     * built after it gives way, exactly as a lane gives way to the corridor reserved before it.
     */
    const mine = new Set(items.map(one => one.link.id));
    const checkpoint = (port: LayoutPort): Point => {
      const out = normal(port.side!), stem = stemReach(model, model.nodes[port.ref.node]!);
      return { x: port.anchor!.x + out.x * stem, y: port.anchor!.y + out.y * stem };
    };
    const owed = (item: typeof items[number]): boolean => {
      const half = routedStroke(model) / 2, at = checkpoint(item.far);
      return model.links.some(other => {
        if (other.layer === 'overlay' || mine.has(other.id)) return false;
        const margin = linkStrokeWidth(other) / 2 + half + STRAIGHT_PATH_CLEARANCE.path;
        return [...(other.path?.fixed === true ? other.path.segments : []), ...(other.fixedSegments ?? []),
          ...(other.sharedRuns?.from ?? []), ...(other.sharedRuns?.to ?? [])].some(run =>
          at.x > Math.min(run.from.x, run.to.x) - margin - PLACEMENT_EPS && at.x < Math.max(run.from.x, run.to.x) + margin + PLACEMENT_EPS
          && at.y > Math.min(run.from.y, run.to.y) - margin - PLACEMENT_EPS && at.y < Math.max(run.from.y, run.to.y) + margin + PLACEMENT_EPS);
      });
    };
    const blocked = new Set(items.filter(owed).map(item => item.link.id));
    // Where a member's own approach starts. A far port that faces this side stands at its own
    // coordinate along it. A far port whose normal runs *along* this side stands on its node's edge
    // instead, so a branch that turned there would run along that node: the coordinate such a
    // member wants is its outward checkpoint, where its own approach begins (ADR-0018 rule 3).
    const approach = (item: typeof items[number]): number => {
      const side = item.far.side!;
      if (axis(side) === tangent || blocked.has(item.link.id)) return item.far.anchor![tangent];
      return item.far.anchor![tangent] + normal(side)[tangent] * stemReach(model, model.nodes[item.far.ref.node]!);
    };
    /** How deep out of this side a world point stands. */
    const depthOf = (p: Point): number => tangent === 'y' ? n.x * (p.x - port.anchor!.x) : n.y * (p.y - port.anchor!.y);
    /**
     * How deep out of the side a branch's own run goes. A branch reaches the tree's common end, but
     * never past the depth at which its far port's **own approach** begins: beyond that the run
     * covers the piece stage 8 has to come back along, and the router either retraces the reserved
     * run or loops round it. Never short of the branch's own peel row either, since that is where it
     * leaves the tree.
     *
     * The approach begins at the far port's outward checkpoint where that checkpoint moves along
     * this side's normal — a port facing this side, or one turned the same way as it — and at the
     * far port's own depth where it moves along the tangent instead, which is the whole of the
     * branch's travel in that direction.
     *
     * An approach that begins *behind* the branch's peel row cannot be reached by travelling outward
     * at all. Such a branch hands over on its peel row, where it arrives travelling along the side —
     * but only while its own track has not passed the far port's coordinate, so that travelling on
     * is still travelling towards it. Where the track has passed it, the branch keeps the tree's
     * common end instead and hands over pointing outward, with room to turn; handing over on the
     * corner of its own descent there leaves the router no way on but back along it.
     */
    const reachOf = (item: typeof items[number]): number => {
      const out = normal(item.far.side!);
      const facing = tangent === 'y' ? n.x * out.x : n.y * out.y;
      return depthOf(item.far.anchor!) + facing * stemReach(model, model.nodes[item.far.ref.node]!);
    };
    const stop = (item: typeof items[number], row: number, track: number): number => {
      if (item.link.path?.fixed === true || blocked.has(item.link.id)) return end;
      const reach = reachOf(item);
      if (reach > row + PLACEMENT_EPS) return Math.min(end, reach);
      const onward = (track - coordinate(port)) * (item.far.anchor![tangent] - track);
      return onward > PLACEMENT_EPS ? row : end;
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
    // The row each member peels at, which is the depth its own run leaves the tree from. The peel
    // loop below takes the farthest track first and the fixed member last; it reads the tracks this
    // pass is about to choose, so the rank is taken from the coordinates they are chosen for.
    const peelRank = new Map([...ordered]
      .sort((a, b) => (Number(a === fixedItem) - Number(b === fixedItem))
        || Math.abs(wanted(b) - coordinate(port)) - Math.abs(wanted(a) - coordinate(port)))
      .map((item, index) => [item, index] as const));
    let prior = -Infinity;
    for (const item of ordered) {
      if (item === fixedItem) continue;
      const own = linkStrokeWidth(item.link);
      // Re-check every row after any move: a step taken for one row can carry the slot onto another
      // it already passed. Bounded, since each pass only moves the slot away from the target's side.
      const clearOfRows = (start: number): number => {
        let slot = start;
        for (let guard = 0; guard < occupied.length + 1; guard++) {
          const hit = occupied.find(row => Math.abs(slot - row.at) < MEMBER_GAP + (own + row.stroke) / 2 - PLACEMENT_EPS);
          if (!hit) break;
          const clearance = MEMBER_GAP + (own + hit.stroke) / 2;
          const keep = wanted(item) <= hit.at ? hit.at - clearance : hit.at + clearance;
          slot = keep >= prior + q - PLACEMENT_EPS ? keep : hit.at + clearance;
        }
        return slot;
      };
      // ADR-0018 rule 3 (ticket 45): a track is measured against the nodes beside the side as well
      // as against the rows on it. The corridor a branch's own run occupies is the band from the row
      // it peels at to where that run stops, and every node standing in it is a wall the track steps
      // past, to the edge of it nearer the coordinate the member wanted.
      const peel = rows[Math.min(peelRank.get(item) ?? 0, rows.length - 1)]!;
      const walls = blockedTracks(model, port, { from: peel, to: stop(item, peel, wanted(item)) },
        new Set([portId(port.ref), portId(item.far.ref)]));
      const base = clearOfRows(Math.max(wanted(item), prior + q));
      let slot = base;
      for (let guard = 0; guard < walls.length + 1; guard++) {
        const wall = walls.find(span => slot > span.lo + PLACEMENT_EPS && slot < span.hi - PLACEMENT_EPS);
        if (!wall) break;
        const keep = Math.abs(wanted(item) - wall.lo) <= Math.abs(wanted(item) - wall.hi) ? wall.lo : wall.hi;
        const next = clearOfRows(keep >= prior + q - PLACEMENT_EPS ? keep : wall.hi);
        if (Math.abs(next - slot) < PLACEMENT_EPS) break;
        slot = next;
      }
      // A step that carries the track past another port's row on this side reorders the members
      // against their endpoints, which is the topology change rule 2 exists to prevent. Where the
      // corridor leaves no slot on the near side of that row, the fan keeps the track rule 2 gave
      // it and the gates report the node it meets.
      if (occupied.some(row => (row.at - base) * (row.at - slot) < -SIGN_EPS)) slot = base;
      target.set(item.link.id, slot); prior = slot;
    }
    const isFixed = (id: string): boolean => links.find(link => link.id === id)?.path?.fixed === true;
    /**
     * Whether a branch's own run would leave stage 8 no way on but back along it. The branch hands
     * over at its own depth on its own track; where its far port's checkpoint stands *shallower*
     * than that, the route has to come back the way it was handed, on that same line, and the
     * router retraces the reserved run rather than failing a gate.
     *
     * Such a member keeps the tree's stems and nothing else. Stage 8 routes the whole of it, as it
     * did before this rule, and the gates report what that costs: a gate failure is recoverable and
     * a throw is not. Measuring the run itself rather than the corner it turns at is ticket 48.
     */
    const hemmed = (item: typeof items[number], row: number, track: number): boolean => {
      const depth = stop(item, row, track);
      // With no outward run there is nothing for the route to come back along; and a far port
      // *behind* the fan is reached by leaving the corridor altogether, with the fan's own node in
      // the way of any line back. Only a far port standing in the corridor can be overshot.
      if (depth <= row + PLACEMENT_EPS || depthOf(item.far.anchor!) <= row + PLACEMENT_EPS) return false;
      return depthOf(checkpoint(item.far)) < depth - PLACEMENT_EPS;
    };
    const release = (item: typeof items[number]): void => placementWarning(model, 'FAN_BRANCH_UNRESERVED',
      `${item.link.id} keeps only the shared stem at ${port.ref.node}.${port.ref.name ?? '*'}: a branch to `
      + `${item.far.ref.node}.${item.far.ref.name ?? '*'} would hand over beyond that port's own approach, `
      + 'and the router would come back along the reserved run.', [item.link.id]);
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
      const at = target.get(leaf.link.id)!, elbow = world(at, rows[depth]!);
      if (hemmed(leaf, rows[depth]!, at)) release(leaf);
      else {
        push(leaf.link.id, point, elbow, owner);
        push(leaf.link.id, elbow, world(at, stop(leaf, rows[depth]!, at)), leaf.link.owner);
        peeled = at;
      }
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
    const shares = goal !== here && peeled !== undefined && Math.sign(goal - here) === Math.sign(peeled - here);
    if (hemmed(last, rows[shares ? depth : Math.max(depth - 1, 0)]!, goal)) release(last);
    else if (shares) {
      const turn = world(here, rows[depth]!), elbow = world(goal, rows[depth]!);
      // The extension leaves the last junction's point along the shared normal, so it claims that
      // junction like every other branch there; G6 excuses a branch at a tree vertex, not a stray run.
      push(last.link.id, cursor, turn, owner);
      push(last.link.id, turn, elbow, last.link.owner);
      push(last.link.id, elbow, world(goal, stop(last, rows[depth]!, goal)), last.link.owner);
    } else {
      const elbow = world(goal, rows[depth - 1]!);
      push(last.link.id, cursor, elbow, owner);
      push(last.link.id, elbow, world(goal, stop(last, rows[depth - 1] ?? rows[0]!, goal)), goal === here ? owner : last.link.owner);
    }
    for (const item of items) {
      item.link.sharedRuns ??= {};
      // A fixed member's runs are the same stems and straight continuation 7d wrote into its path.
      item.link.sharedRuns[item.end] = paths.get(item.link.id)!;
    }
  }
  releaseHemmedFans(model);
  reserveGroupExits(model);
}

/** How many leading segments of a reserved fan run are the tree's stems: those along the port's own normal. */
function stemCount(port: LayoutPort, runs: readonly PathSegment[]): number {
  const tangent = axis(port.side!);
  let count = 0;
  for (const run of runs) {
    const across = tangent === 'x' ? Math.abs(run.to.x - run.from.x) : Math.abs(run.to.y - run.from.y);
    if (across > PLACEMENT_EPS || run.owner.kind !== 'shared-stem') break;
    count++;
  }
  return count;
}

/**
 * Release every fan branch that hems another link's approach, and the branch of the link it hems.
 *
 * A fan reserves its branches one cohort at a time, so the run one cohort lays can close the
 * checkpoint another link's port has to be approached from. The two runs need not meet: it is enough
 * that they leave the router less room than it nudges a route by. Neither link can then be routed
 * and stage 8 fails outright, where a diagram that reserved nothing would have failed a gate.
 *
 * Both give way, down to their trees' shared stems, because the pair is symmetric: the fan built
 * first has no way to see the one built after it. Ports on the hemming fan's own node side are left
 * out — a fan's own siblings stand a pitch away by construction (ADR-0018 rules 1 and 2), and
 * treating them as hemmed would undo the tracks those rules reserve. A member whose path a rule
 * fixed keeps its run, since its `sharedRuns` are the prefix of that path (ADR-0016).
 *
 * **Only an end that reserved nothing can be hemmed.** An end whose own fan reserved a run is not
 * approached at the port at all: stage 8 stitches that run back and starts the gap at the run's
 * terminal (`endpointFor`), so the port's own outward checkpoint stands inside a reservation the
 * link owns and closing it costs the link nothing. Such an end can still be shut at the terminal —
 * of 1 099 corpus inputs, 35 hold a reserved terminal inside a foreign reserved run's margin and 27
 * of the 35 fail the pipeline — but a release does not open it. Measured over those 35, releasing on
 * a closed terminal as well repaired none of them and broke 8 (stress ticket 11 owns the shape, with
 * `wide-t3-p3-f2-s1` for its reproducer). An end that reserved nothing is the one case a release
 * does answer: nothing there was placed, so giving the router the whole approach is the only move
 * left, and that is the throw this pass exists to prevent.
 *
 * Measuring the port at every end released branches whose approaches were never shut, and the links
 * the release then handed to the router walled each other in: the route of the first laid across the
 * only way to the second one's own stem terminal, libavoid dropped that endpoint without a word and
 * answered with a diagonal, and `gapSegments` threw `Routed gap … is not orthogonal` on five inputs
 * that published before the rule (stress ticket 10). A release must leave the router a gap it can
 * answer orthogonally; where nothing is closed there is nothing to release.
 */
function releaseHemmedFans(model: LayoutModel): void {
  // The room the *router* insists on beside a route it still has to draw, read from the one figure
  // `routeParameters` hands libavoid. A literal here would drift from it: an unrelated heavy link
  // widens what the router demands and would leave this pass looking at the wrong distance.
  const margin = nudgingDistance(model);
  // The outward depth stage 8 really asks for at a bare port, which is `stemCheckpoint`'s own: the
  // 15 px stem, unless the node's expanded obstacle reaches further, and deeper still where a side's
  // stems nest. One plan per row gap for the whole pass, because recomputing it per link end is
  // cubic in the size of a turning cohort.
  const gaps = stemCache();
  const drawn = (link: LayoutLink): boolean => link.layer === 'routed' && link.technique !== 'stub' && link.attachments !== undefined;
  const branches: { link: LayoutLink; end: 'from' | 'to'; port: LayoutPort; runs: PathSegment[] }[] = [];
  for (const link of model.links) {
    if (!drawn(link) || link.path?.fixed === true || link.bundle !== undefined) continue;
    for (const end of ['from', 'to'] as const) {
      const runs = link.sharedRuns?.[end], port = findPort(model, link.attachments![end]);
      if (!runs?.length || !port?.anchor || port.side === undefined) continue;
      const beyond = runs.slice(stemCount(port, runs));
      if (beyond.length) branches.push({ link, end, port, runs: beyond });
    }
  }
  if (!branches.length) return;
  const release = new Set<string>();
  // A reserved branch that a gate would fail is released to the router as well (ticket 99): a run through a foreign group box (G2), or along a
  // box edge inside the edge margin (G6). A branch that only meets a group at a right angle stays. Nothing else checks a branch against group
  // boxes: `a-claimed-run-clears-a-shared-run` kept its branch through a neighbour group only because another link's stem happened to hem it,
  // and a chord that removed that stem exposed it. Follow-up: ticket 113 keeps the planner's branches clear of foreign groups.
  const boxes = groupBoxes(model);
  const failsGate = (run: PathSegment, box: Rect, stroke: number): boolean => {
    if (segmentRectDistance(run, box) <= PLACEMENT_EPS && Math.min(run.from.x, run.to.x) < box.x + box.width - PLACEMENT_EPS && Math.max(run.from.x, run.to.x) > box.x + PLACEMENT_EPS
      && Math.min(run.from.y, run.to.y) < box.y + box.height - PLACEMENT_EPS && Math.max(run.from.y, run.to.y) > box.y + PLACEMENT_EPS) return true;
    const margin = GROUP_EDGE_LINK_CLEARANCE + stroke / 2;
    const bottomEdge = box.y + box.height, rightEdge = box.x + box.width;
    const along = (edge: number, low: number, high: number, at: number, from: number, to: number, inner: [number, number]): boolean =>
      !(at > inner[0] + PLACEMENT_EPS && at < inner[1] - PLACEMENT_EPS) && Math.abs(at - edge) < margin - PLACEMENT_EPS && Math.min(from, to) < high - PLACEMENT_EPS && Math.max(from, to) > low + PLACEMENT_EPS;
    if (Math.abs(run.from.y - run.to.y) < PLACEMENT_EPS) return [box.y, bottomEdge].some(edge => along(edge, box.x, rightEdge, run.from.y, run.from.x, run.to.x, [box.y, bottomEdge]));
    return Math.abs(run.from.x - run.to.x) < PLACEMENT_EPS && [box.x, rightEdge].some(edge => along(edge, box.y, bottomEdge, run.from.x, run.from.y, run.to.y, [box.x, rightEdge]));
  };
  for (const item of branches) {
    const stroke = linkStrokeWidth(item.link);
    const foreign = boxes.find(({ id, bounds }) => item.runs.some(run => failsGate(run, bounds, stroke)) && !groupConsumers(model, id).includes(item.link.id));
    if (!foreign) continue;
    release.add(`${item.link.id}:${item.end}`);
    placementWarning(model, 'FAN_BRANCH_THROUGH_GROUP',
      `${item.link.id}'s reserved branch would fail a gate at the group ${foreign.id}; it keeps its shared stem and the router routes the rest.`, [item.link.id]);
  }
  for (const link of model.links) {
    // Stage 8 approaches a port only for a link it routes, and `planRoute` passes over every link
    // that already holds a complete path — one a rule pinned, and a bundle member, whose path
    // `rebuildBundlePaths` deletes just before this pass and assigns again straight after it.
    // Neither is ever given a checkpoint at its port, so neither can be hemmed at one. That is the
    // exclusion the branch loop above already makes, and it is read the same way: `fixed` and
    // `bundle` hold whatever stage the model is restored at, where the presence of a `path` does
    // not — after stage 8 every link carries one, and a guard on that would make this pass answer
    // differently on the re-derivation `checkedLayoutMutation` compares against.
    if (!drawn(link) || link.path?.fixed === true || link.bundle !== undefined) continue;
    for (const end of ['from', 'to'] as const) {
      const ref = link.attachments![end], port = findPort(model, ref);
      if (!port?.anchor || port.side === undefined) continue;
      // An end whose own fan reserved a run is approached at that run's terminal, not at the port,
      // so the port's checkpoint stands inside the link's own reservation and nothing closes it.
      if (link.sharedRuns?.[end]?.length) continue;
      const out = normal(port.side), reach = stemPlan(model, port, gaps).depth;
      const at = { x: port.anchor.x + out.x * reach, y: port.anchor.y + out.y * reach };
      for (const branch of branches) {
        if (branch.link.id === link.id) continue;
        if (branch.port.ref.node === port.ref.node && branch.port.side === port.side) continue;
        // The boundary counts: the router refuses a corridor exactly this wide, so a checkpoint at
        // the distance itself is closed, not clear.
        if (!branch.runs.some(run => at.x > Math.min(run.from.x, run.to.x) - margin - PLACEMENT_EPS
          && at.x < Math.max(run.from.x, run.to.x) + margin + PLACEMENT_EPS
          && at.y > Math.min(run.from.y, run.to.y) - margin - PLACEMENT_EPS
          && at.y < Math.max(run.from.y, run.to.y) + margin + PLACEMENT_EPS)) continue;
        release.add(`${branch.link.id}:${branch.end}`);
        // The hemmed link gives way at whichever end its own fan reserved, which is never this one:
        // the end that was hemmed reserved nothing, or the pass would not have measured its port.
        for (const own of ['from', 'to'] as const) release.add(`${link.id}:${own}`);
        placementWarning(model, 'FAN_BRANCH_HEMMED',
          `${branch.link.id}'s reserved branch closes the approach to ${ref.node}.${ref.name ?? '*'}; `
          + 'both keep their shared stems and the router routes the rest.', [branch.link.id, link.id]);
      }
    }
  }
  for (const item of branches) {
    if (!release.has(`${item.link.id}:${item.end}`)) continue;
    const runs = item.link.sharedRuns![item.end]!;
    item.link.sharedRuns![item.end] = runs.slice(0, stemCount(item.port, runs));
  }
}
