import type { PortRef } from '../model/document.js';
import type { Side } from '../model/geometry.js';
import type { LayoutGroup, LayoutModel, LayoutPort } from '../model/layout.js';
import { orderedGroupIds, orderedNodeIds } from '../model/model.js';
import { busOfPort, busSide, meshBuses } from './bus.js';
import { chainSides } from './grid-chains.js';
import { gridChains } from './grid.js';
import { checkSideHints, NO_SIDE_HINTS, SideHintRefusal, type SideHints } from './side-hints.js';

/** Complete tie priority for direction votes and unused-port allocation. */
export const SIDE_TIE_ORDER: readonly Side[] = ['bottom', 'right', 'top', 'left'];
type Votes = Record<Side, number>;
const emptyVotes = (): Votes => ({ bottom: 0, right: 0, top: 0, left: 0 });
/** Port identity as `[node, anonymous, name, ordinal]`; the key `tiedPortComponents` is indexed by. */
export const portKey = (ref: PortRef): string => JSON.stringify([ref.node, ref.anonymous === true, ref.name, ref.ordinal]);

function winner(votes: Votes, fewest = false): Side {
  return SIDE_TIE_ORDER.reduce((best, side) =>
    (fewest ? votes[side] < votes[best] : votes[side] > votes[best]) ? side : best, 'bottom');
}

function tierSide(source: LayoutGroup, peer: LayoutGroup): Side | undefined {
  if (source.tier === undefined || peer.tier === undefined) throw new Error('Phase-one sides require resolved tiers');
  if (peer.tier > source.tier) return 'bottom';
  if (peer.tier < source.tier) return 'top';
  if (peer.flank !== undefined && source.flank === undefined) return peer.flank.align;
  if (source.flank !== undefined && peer.flank === undefined) return source.flank.align === 'left' ? 'right' : 'left';
  return undefined;
}

/**
 * Ports a bundle ties together at a node — its members' ports on that node — and, through a port
 * that belongs to two bundles, both bundles' ports: one component that has to leave the node on one
 * side, since parallel runs cannot start on two sides of one box (ticket 35). Keyed by `portKey`;
 * every tied port maps to its component root, and a port in no bundle is absent.
 */
export function tiedPortComponents(model: LayoutModel): Map<string, string> {
  const parent = new Map<string, string>(), seen = new Set<string>();
  const find = (id: string): string => { const up = parent.get(id) ?? id; if (up === id) return id; const root = find(up); parent.set(id, root); return root; };
  const byBundle = new Map<string, LayoutModel['links']>();
  for (const link of model.links) if (link.bundle !== undefined) byBundle.set(link.bundle, [...(byBundle.get(link.bundle) ?? []), link]);
  for (const bundle of model.bundles) {
    const links = byBundle.get(bundle.id) ?? [];
    for (const nodeId of bundle.nodes) {
      const keys = links.flatMap(link => [link.attachments!.from, link.attachments!.to]).filter(ref => ref.node === nodeId).map(portKey);
      for (const id of keys) seen.add(id);
      for (const other of keys.slice(1)) { const a = find(keys[0]!), b = find(other); if (a !== b) parent.set(a, b); }
    }
  }
  const roots = new Map<string, string>();
  for (const id of seen) roots.set(id, find(id));
  return roots;
}

/**
 * Assign semantic sides in place. Same-tier estimates affect capacity, never final topology.
 * A side hint (docs/design/side-faces.md, Section 7) ranks below an author `side:` and above this rule: the port takes the hinted lateral
 * side and records the side the rule gives as `naturalSide`. For a port the rule leaves undecided that is the capacity estimate, kept in
 * `sizingSide` for stage 5, which replaces it with the side its vote gives.
 * A course face (architecture ticket 15, Section 1) ranks above a hint: the port takes the face and records the side the rule gives as `naturalSide`, with `courseHint`.
 * The face may be any side but the natural one (it may point away from the peer); an author `side:` still wins, and the plan never offers a face on such a port.
 */
export function sidesOne(model: LayoutModel, hints: SideHints = NO_SIDE_HINTS, laneHints: ReadonlySet<string> = new Set(), courseFaces: ReadonlyMap<string, Side> = new Map()): LayoutModel {
  if (model.stage !== 'resolve') throw new Error('Phase-one sides require the resolve stage');
  if (hints.size) checkSideHints(model, hints);
  // A chain of a grid (architecture ticket 23) stands one bundle end over the other: its member ports take
  // `bottom` (upper end) and `top` (lower end), fixed here like an authored side, so the tied component
  // binds and stage 5 never overturns them.
  const stacked = chainSides(model, gridChains(model));
  const components = tiedPortComponents(model);
  const ports = new Map<string, { port: LayoutPort; known: Votes; predicted: Votes; unresolved: number; links: number }>();
  const rank = new Map<string, number>();
  for (const groupId of orderedGroupIds(model.document)) {
    for (const id of model.groups[groupId]!.nodes) rank.set(id, rank.size);
  }
  for (const id of orderedNodeIds(model.document)) {
    for (const port of model.nodes[id]!.ports) {
      ports.set(portKey(port.ref), { port, known: emptyVotes(), predicted: emptyVotes(), unresolved: 0, links: 0 });
    }
  }
  const count = (from: PortRef, to: PortRef): void => {
    const entry = ports.get(portKey(from));
    if (entry === undefined) throw new Error(`Missing resolved port on ${from.node}`);
    const source = model.groups[model.document.nodes[from.node]!.group]!;
    const peer = model.groups[model.document.nodes[to.node]!.group]!;
    const side = tierSide(source, peer);
    entry.links++;
    if (side !== undefined) {
      entry.known[side]++;
      entry.predicted[side]++;
    } else {
      entry.unresolved++;
      const predicted = rank.get(to.node)! < rank.get(from.node)! ? 'left' : 'right';
      entry.predicted[predicted]++;
    }
  };
  for (const link of model.links) {
    const from = link.attachments?.from ?? (link.from.node !== undefined ? link.from : undefined);
    const to = link.attachments?.to ?? (link.to.node !== undefined ? link.to : undefined);
    if (from === undefined || to === undefined) throw new Error('Phase-one sides require concrete link attachments');
    count(from, to);
    if (portKey(from) !== portKey(to)) count(to, from);
  }
  // Tied ports vote as one: their known, predicted and unresolved counts are summed, an authored
  // side among them binds the whole component, and two different authored sides cannot occur
  // (stage 1 never bundles them).
  const sum = (values: Votes[]): Votes => values.reduce((total, votes) => {
    for (const side of SIDE_TIE_ORDER) total[side] += votes[side];
    return total;
  }, emptyVotes());
  const byRoot = new Map<string, string[]>();
  for (const [id, root] of components) byRoot.set(root, [...(byRoot.get(root) ?? []), id]);
  const tied = (port: LayoutPort): { port: LayoutPort; known: Votes; predicted: Votes; unresolved: number; links: number; authored?: Side } => {
    const root = components.get(portKey(port.ref));
    const own = ports.get(portKey(port.ref))!;
    if (root === undefined) return own;
    const group = byRoot.get(root)!.map(id => ports.get(id)!);
    const authoredSides = new Set(group.map(entry => entry.port.side).filter((side): side is Side => side !== undefined));
    if (authoredSides.size > 1) throw new Error(`Bundle members at ${port.ref.node} leave on different authored sides`);
    return { port, known: sum(group.map(entry => entry.known)), predicted: sum(group.map(entry => entry.predicted)),
      unresolved: group.reduce((n, entry) => n + entry.unresolved, 0), links: own.links, ...(authoredSides.size ? { authored: [...authoredSides][0] } : {}) };
  };
  for (const { ref, side } of stacked) {
    const port = model.nodes[ref.node]?.ports.find(item => portKey(item.ref) === portKey(ref));
    if (port !== undefined && port.side === undefined) port.side = side;
  }
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!;
    const capacity = emptyVotes();
    const unused: LayoutPort[] = [];
    for (const port of node.ports) {
      const entry = tied(port);
      if (entry.links === 0) port.unused = true;
      if (port.side === undefined && entry.authored !== undefined) port.side = entry.authored;
      if (port.side !== undefined) {
        capacity[port.side]++;
      } else if (busOfPort(model, port.ref)?.mesh !== undefined) {
        // A bar of a trunk join stands on the edge that stage 5 gives it (mesh-bus.md, section 12.4): the votes of its cross links, which reach rows above and below, decide nothing.
      } else if (entry.links === 0) {
        unused.push(port);
      } else {
        const selected = winner(entry.known);
        // A known winner is safe only if either possible lateral total cannot displace it.
        const safe = entry.known[selected] > 0 && (['left', 'right'] as const).every(side =>
          winner({ ...entry.known, [side]: entry.known[side] + entry.unresolved }) === selected);
        const hint = hints.get(portKey(port.ref)), face = courseFaces.get(portKey(port.ref));
        if (face !== undefined) {
          const natural = safe ? selected : winner(entry.predicted);
          if (face === natural) throw new SideHintRefusal(`Course face on ${port.ref.node}.${port.ref.name ?? '#'}${port.ref.ordinal} refused: it is the natural side ${natural}`);
          port.courseHint = true; port.naturalSide = natural; port.side = face;
          if (!safe) port.sizingSide = natural;
          capacity[natural]++;
        } else if (hint !== undefined) {
          const natural = safe ? selected : winner(entry.predicted);
          if (safe && natural !== 'top' && natural !== 'bottom') throw new SideHintRefusal(`Side hint on ${port.ref.node}.${port.ref.name ?? '#'}${port.ref.ordinal} refused: its natural side is ${natural}`);
          port.sideHint = true; port.naturalSide = natural; port.side = hint;
          if (laneHints.has(portKey(port.ref))) port.laneHint = true;
          if (!safe) port.sizingSide = natural;
          capacity[natural]++; // the natural side: an unused port is placed by the stage-2 rule, which no hint may change
        } else {
          if (safe) port.side = selected;
          else port.sizingSide = winner(entry.predicted);
          capacity[port.side ?? port.sizingSide!]++;
        }
      }
    }
    for (const port of unused) {
      port.side = winner(capacity, true);
      capacity[port.side]++;
    }
  }
  // A mesh bus port stands on the bus edge, never on a lateral side. Stage 2 gives it a provisional bus side
  // for sizing, read from the stage-2 sides of every node of the row (mesh-bus.md, section 4).
  for (const bus of meshBuses(model)) {
    const side = busSide(model, bus, true);
    for (const ref of bus.ports) {
      const port = model.nodes[ref.node]!.ports.find(item => portKey(item.ref) === portKey(ref));
      if (port !== undefined && port.side === undefined) port.sizingSide = side;
    }
  }
  model.stage = 'sides-one';
  return model;
}
