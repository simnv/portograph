import { linkStrokeWidth } from '../theme/geometry.js';
import type { Bundle, LayoutModel, LayoutPort, Owner, PathSegment, Point } from '../model/index.js';
import { portId } from './skeleton-graph.js';
import { axis, clearOfGroupEdges, clone, coordinate, edgeMargin, facing, groupDepthPairs, normal, treeCohorts, type Member } from './bundle-geometry.js';

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
      const nrm = normal(port.side!);
      const toDepth = (p: Point): number => axis(port.side!) === 'y' ? nrm.x * (p.x - port.anchor!.x) : nrm.y * (p.y - port.anchor!.y);
      const pairs = groupDepthPairs(model, [model.document.nodes[port.ref.node]!.group], toDepth);
      const clearDepth = (depth: number): number => clearOfGroupEdges(depth, pairs, 1, edgeMargin(Math.max(...own.map(m => linkStrokeWidth(m.link)))));
      const rows: number[] = [];
      for (let i = 0; i < list.length; i++) rows.push(clearDepth(Math.max(15 + i * q, (rows[i - 1] ?? -Infinity) + q)));
      const distance = clearDepth(Math.max(15 + q * list.length, rows[rows.length - 1]! + q));
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
  for (const { port, links } of treeCohorts(model)) {
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
    const q = Math.max(17.5, 16 + Math.max(...items.map(i => linkStrokeWidth(i.link))));
    const world = (u: number, v: number): Point => tangent === 'x' ? { x: u, y: port.anchor!.y + n.y * v }
      : { x: port.anchor!.x + n.x * v, y: u };
    // A member that owns a lane in the adjacent tier must end its leaf on that lane's x, exactly as
    // a bundle fan does: placement knows the lane, so stage 8 never has to find it sideways.
    const tier = model.groups[model.document.nodes[port.ref.node]!.group]!.tier!;
    const laneX = (id: string): number | undefined => tangent === 'x' ? model.lanes
      .filter(l => l.owner.kind === 'link' && l.owner.id === id)
      .sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier))[0]?.x : undefined;
    const wanted = (item: typeof items[number]): number => laneX(item.link.id) ?? item.far.anchor![tangent];
    const ordered = [...items].sort((a, b) => wanted(a) - wanted(b) || a.link.sourceIndex - b.link.sourceIndex);
    const target = new Map<string, number>();
    let prior = -Infinity;
    for (const item of ordered) { prior = Math.max(wanted(item), prior + q); target.set(item.link.id, prior); }
    // Rows one pitch apart from a 15 px stem, each moved off the port group's edge margin (ADR-0013).
    const toDepth = (p: Point): number => tangent === 'y' ? n.x * (p.x - port.anchor!.x) : n.y * (p.y - port.anchor!.y);
    const pairs = groupDepthPairs(model, [model.document.nodes[port.ref.node]!.group], toDepth);
    const rows: number[] = [];
    const margin = edgeMargin(Math.max(...items.map(i => linkStrokeWidth(i.link))));
    for (let i = 0; i <= items.length; i++) rows.push(clearOfGroupEdges(Math.max(15 + i * q, (rows[i - 1] ?? -Infinity) + q), pairs, 1, margin));
    let active = [...ordered], cursor = { ...port.anchor! }, parent: string | undefined, depth = 0;
    const paths = new Map(items.map(item => [item.link.id, [] as PathSegment[]]));
    const push = (id: string, from: Point, to: Point, owner: Owner): void => {
      if (from.x !== to.x || from.y !== to.y) paths.get(id)!.push({ from: { ...from }, to: { ...to }, owner: { ...owner } });
    };
    while (active.length > 1) {
      const id = `junction:${portId(port.ref)}:shared:${depth}`, owner = { kind: 'shared-stem' as const, id };
      const point = world(coordinate(port), rows[depth]!), stem: PathSegment = { from: cursor, to: point, owner };
      model.junctions.push({ id, owner, layer: 'routed', port: { ...port.ref }, links: active.map(i => i.link.id),
        ...(parent ? { parent } : {}), point, stem });
      for (const item of active) paths.get(item.link.id)!.push(clone(stem));
      const leaf = [...active].sort((a, b) => Math.abs(target.get(b.link.id)! - coordinate(port)) - Math.abs(target.get(a.link.id)! - coordinate(port)))[0]!;
      const elbow = world(target.get(leaf.link.id)!, rows[depth]!);
      push(leaf.link.id, point, elbow, owner);
      push(leaf.link.id, elbow, world(target.get(leaf.link.id)!, rows[items.length]!), leaf.link.owner);
      active = active.filter(i => i !== leaf); cursor = point; parent = id; depth++;
    }
    const last = active[0]!, owner = { kind: 'shared-stem' as const, id: parent! };
    const elbow = world(target.get(last.link.id)!, rows[depth - 1]!);
    push(last.link.id, cursor, elbow, owner);
    push(last.link.id, elbow, world(target.get(last.link.id)!, rows[items.length]!), target.get(last.link.id) === coordinate(port) ? owner : last.link.owner);
    for (const item of items) {
      item.link.sharedRuns ??= {};
      item.link.sharedRuns[item.end] = paths.get(item.link.id)!;
    }
  }
}
