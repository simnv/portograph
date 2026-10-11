import type { PortRef } from '../model/document.js';
import type { Side } from '../model/geometry.js';
import type { Bundle, LayoutModel } from '../model/layout.js';

/**
 * Chains: how a grid group stands the bundles it holds both ends of (architecture ticket 23,
 * `docs/design/grid-bundles.md`).
 *
 * Everything here is read from the document alone: no size, no placed geometry, no route. So the
 * answer is the same at stage 1 (the diagnostic), at stage 2 (the member sides), at stage 4 (the
 * packer) and when a layout is restored, and a grid that is declined is declined for one reason
 * everywhere.
 */

/** The side the author fixed on the port `ref` names, read from the document so no stage can move it. */
export function authoredSide(model: LayoutModel, ref: PortRef): Side | undefined {
  return model.document.nodes[ref.node]?.ports.find(port => port.ordinal === ref.ordinal
    && (port.name ?? undefined) === (ref.name ?? undefined)
    && (port.anonymous ?? false) === (ref.anonymous ?? false))?.side;
}

/** Why a grid group cannot stand its enclosed bundles. The first reason of this order is the one reported. */
export type StackDecline = 'authored-side' | 'branch' | 'shared-port' | 'merge' | 'cycle' | 'exits' | 'rows';

/** A simple path of nodes joined by enclosed bundles, top to bottom: one column, consecutive rows. */
export interface Chain {
  /** Top to bottom. */
  nodes: string[];
  /** Every bundle id of the chain, top to bottom. */
  bundles: string[];
  /** The bundle ids between neighbours, top to bottom: `edges[i]` joins `nodes[i]` and `nodes[i + 1]`, and holds every parallel bundle of that pair. */
  edges: string[][];
}

export type StackChains = { chains: Chain[] } | { decline: StackDecline; bundle: Bundle };

/** The bundles whose two ends are both nodes of group `id`. */
export function enclosedBundles(model: LayoutModel, id: string): Bundle[] {
  return model.bundles.filter(bundle => bundle.nodes.every(node => model.document.nodes[node]?.group === id));
}

/** The nodes of group `id` that have a link leaving the group upward and downward, read from the document. */
export interface GroupExits { readonly up: ReadonlySet<string>; readonly down: ReadonlySet<string> }

/**
 * How the nodes of group `id` leave it: the author's side where one is written, else the tier of the
 * peer's group against the group's own (the rule of stage 2 for a port with no lateral vote). A
 * lateral peer, a stub and a link inside the group leave neither way.
 */
export function groupExits(model: LayoutModel, id: string): GroupExits {
  const members = new Set(model.groups[id]?.nodes ?? []);
  const up = new Set<string>(), down = new Set<string>();
  const tier = (node: string): number | undefined => model.groups[model.document.nodes[node]?.group ?? '']?.tier;
  for (const link of model.links) {
    const ends = link.attachments;
    if (!ends || link.technique === 'stub') continue;
    for (const [own, peer] of [[ends.from, ends.to], [ends.to, ends.from]] as const) {
      if (!members.has(own.node) || members.has(peer.node)) continue;
      const from = tier(own.node), to = tier(peer.node);
      const side = authoredSide(model, own)
        ?? (from === undefined || to === undefined || from === to ? undefined : to > from ? 'bottom' : 'top');
      if (side === 'top') up.add(own.node);
      if (side === 'bottom') down.add(own.node);
    }
  }
  return { up, down };
}

/** One piece of a grid: a chain (k nodes in one column, top to bottom) or a single node. */
export interface GridUnit { nodes: readonly string[]; up: boolean; down: boolean }

/**
 * Seat `units` in `columns` columns, or `undefined` when the grid rules leave no seat.
 *
 * A column is a corridor (Q75): at most one unit that exits upward, in the first row, and one that
 * exits downward, in the last. A chain takes a column of its own and k consecutive rows of it; the
 * rest of its column holds only nodes that exit neither way. The rows are `max(longest chain,
 * ceil(n / columns))`, and exactly k where a chain exits upward at its top and downward at its
 * bottom. The cells are filled in the order `units` has, which is the order of the caller's ranked
 * node order, so ELK's order survives where nothing forces a node elsewhere.
 */
export function seatUnits(units: readonly GridUnit[], columns: number, ends: ReadonlyMap<string, 'left' | 'right'> = new Map()): (string | undefined)[][] | undefined {
  const count = units.reduce((sum, unit) => sum + unit.nodes.length, 0);
  const chains = units.filter(unit => unit.nodes.length > 1), singles = units.filter(unit => unit.nodes.length === 1);
  const longest = Math.max(1, ...chains.map(unit => unit.nodes.length));
  if (columns < 1 || singles.some(unit => unit.up && unit.down)) return undefined;
  const tall = new Set(chains.filter(unit => unit.up && unit.down).map(unit => unit.nodes.length));
  if (tall.size > 1) return undefined;
  const rows = tall.size ? [...tall][0]! : Math.max(longest, Math.ceil(count / columns));
  if (rows < longest || rows * columns < count || (chains.length > 0 && rows < 2)) return undefined;
  const cells: (string | undefined)[][] = Array.from({ length: rows }, () => new Array<string | undefined>(columns).fill(undefined));
  const chainColumns = new Set<number>(), verticalColumns = new Set<number>();
  const put = (unit: GridUnit, column: number, row: number): void => unit.nodes.forEach((id, index) => { cells[row + index]![column] = id; });
  for (const unit of chains.filter(item => item.up || item.down)) {
    const column = Array.from({ length: columns }, (_, index) => index).find(index => !chainColumns.has(index));
    if (column === undefined) return undefined;
    chainColumns.add(column);
    put(unit, column, unit.up ? 0 : rows - unit.nodes.length);
  }
  const open = Array.from({ length: columns }, (_, index) => index).filter(index => !chainColumns.has(index));
  const up = singles.filter(unit => unit.up), down = singles.filter(unit => unit.down);
  if (up.length > open.length || down.length > open.length) return undefined;
  up.forEach((unit, index) => { put(unit, open[index]!, 0); verticalColumns.add(open[index]!); });
  down.forEach((unit, index) => { put(unit, open[index]!, rows - 1); verticalColumns.add(open[index]!); });
  for (const unit of chains.filter(item => !item.up && !item.down)) {
    const column = open.find(index => !chainColumns.has(index) && !verticalColumns.has(index));
    if (column === undefined) return undefined;
    let start = -1;
    for (let row = 0; row + unit.nodes.length <= rows && start < 0; row++) {
      if (unit.nodes.every((_, index) => cells[row + index]![column] === undefined)) start = row;
    }
    if (start < 0) return undefined;
    chainColumns.add(column);
    put(unit, column, start);
  }
  const free: [number, number][] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) if (cells[row]![column] === undefined) free.push([row, column]);
  const rest = singles.filter(unit => !unit.up && !unit.down);
  if (rest.length > free.length) return undefined;
  rest.forEach((unit, index) => { const [row, column] = free[index]!; cells[row]![column] = unit.nodes[0]; });
  // A flank's primary peer takes the outer end of its own row, the end its lateral link runs from. It swaps with the
  // cell there when that cell is empty or holds a node that leaves neither way, and never into or out of a chain column.
  const vertical = new Set(singles.filter(unit => unit.up || unit.down).map(unit => unit.nodes[0]!));
  for (const [id, align] of ends) {
    const row = cells.findIndex(item => item.includes(id));
    if (row < 0) continue;
    const column = cells[row]!.indexOf(id), target = align === 'left' ? 0 : columns - 1;
    const other = cells[row]![target];
    if (column === target || chainColumns.has(column) || chainColumns.has(target) || vertical.has(id)) continue;
    if (other !== undefined && (vertical.has(other) || ends.has(other))) continue;
    cells[row]![target] = id; cells[row]![column] = other;
  }
  if (cells.some(row => row.every(id => id === undefined))) return undefined;
  if (Array.from({ length: columns }, (_, column) => cells.every(row => row[column] === undefined)).some(Boolean)) return undefined;
  return cells;
}

/**
 * The units of a grid group in `order`: each chain once, at the place of its first node, and every
 * other node alone. A chain's exits are its top node's upward exit and its bottom node's downward one.
 */
export function gridUnits(order: readonly string[], chains: readonly Chain[], exits: GroupExits): GridUnit[] {
  const chainOf = new Map(chains.flatMap(chain => chain.nodes.map(id => [id, chain] as const)));
  const done = new Set<Chain>();
  const units: GridUnit[] = [];
  for (const id of order) {
    const chain = chainOf.get(id);
    if (chain === undefined) { units.push({ nodes: [id], up: exits.up.has(id), down: exits.down.has(id) }); continue; }
    if (done.has(chain)) continue;
    done.add(chain);
    units.push({ nodes: chain.nodes, up: exits.up.has(chain.nodes[0]!), down: exits.down.has(chain.nodes.at(-1)!) });
  }
  return units;
}

/** Whether some column count seats `units`. */
export const seatable = (units: readonly GridUnit[]): boolean => {
  const count = units.reduce((sum, unit) => sum + unit.nodes.length, 0);
  for (let columns = 1; columns <= count; columns++) if (seatUnits(units, columns) !== undefined) return true;
  return false;
};

/**
 * The chains of group `id`, or the first reason the group cannot stand its enclosed bundles.
 *
 * One predicate, read by `groupShape`, by stage 1 for the diagnostic, by stage 2 for the member
 * sides and by the packer, so none of them can disagree (the property `declineStackedShapes` had).
 * A group with no enclosed bundle has no chain: `{ chains: [] }`.
 */
export function stackChains(model: LayoutModel, id: string): StackChains {
  const bundles = enclosedBundles(model, id);
  if (bundles.length === 0) return { chains: [] };
  const links = new Map(model.links.map(link => [link.id, link] as const));
  const ends = (bundle: Bundle): PortRef[] => bundle.members.flatMap(member => {
    const attached = links.get(member)?.attachments;
    return attached ? [attached.from, attached.to] : [];
  });
  // 1. authored sides a vertical stack cannot honour
  for (const bundle of bundles) {
    const sides = bundle.nodes.map(node => new Set(ends(bundle).filter(ref => ref.node === node)
      .map(ref => authoredSide(model, ref)).filter((side): side is Side => side !== undefined)));
    if (sides.some(set => set.has('left') || set.has('right'))) return { decline: 'authored-side', bundle };
    if (bundle.nodes[0] !== bundle.nodes[1] && (['top', 'bottom'] as const).some(side => sides.every(set => set.has(side)))) return { decline: 'authored-side', bundle };
  }
  // 2. the graph of partners: a pair of bundles between the same two nodes is one edge
  const partners = new Map<string, Map<string, Bundle[]>>();
  const link = (one: string, other: string, bundle: Bundle): void => {
    const row = partners.get(one) ?? new Map<string, Bundle[]>();
    row.set(other, [...(row.get(other) ?? []), bundle]);
    partners.set(one, row);
  };
  for (const bundle of bundles) if (bundle.nodes[0] !== bundle.nodes[1]) { link(bundle.nodes[0], bundle.nodes[1], bundle); link(bundle.nodes[1], bundle.nodes[0], bundle); }
  for (const bundle of bundles) if ((partners.get(bundle.nodes[0])?.size ?? 0) >= 3 || (partners.get(bundle.nodes[1])?.size ?? 0) >= 3) return { decline: 'branch', bundle };
  // A port that two bundles share (to two different partners) cannot face both ways.
  for (const [node, row] of partners) {
    if (row.size < 2) continue;
    const owner = new Map<string, Bundle>();
    for (const bundle of [...row.values()].flat()) for (const ref of ends(bundle)) {
      if (ref.node !== node) continue;
      const key = JSON.stringify([ref.name ?? null, ref.ordinal, ref.anonymous ?? false]);
      const other = owner.get(key);
      if (other !== undefined && other.id !== bundle.id && !row.get(bundle.nodes.find(item => item !== node)!)!.includes(other)) return { decline: 'branch', bundle };
      owner.set(key, bundle);
    }
  }
  const selfLoop = bundles.find(bundle => bundle.nodes[0] === bundle.nodes[1]);
  if (selfLoop) return { decline: 'cycle', bundle: selfLoop };
  // A merge trunk needs rows between the stems that `stackedChannelNeed` does not reserve.
  const merging = bundles.find(bundle => bundle.members.some(member => links.get(member)?.technique === 'merge'));
  if (merging !== undefined) return { decline: 'merge', bundle: merging };
  // A member port that also carries a link outside the chain bundles would be fixed to `bottom` or `top` against that
  // link's own direction: the grid cannot stand the bundle vertically.
  const memberIds = new Set(bundles.flatMap(bundle => bundle.members));
  const portKey = (ref: PortRef): string => JSON.stringify([ref.node, ref.name ?? null, ref.ordinal, ref.anonymous ?? false]);
  const owner = new Map(bundles.flatMap(bundle => ends(bundle).map(ref => [portKey(ref), bundle] as const)));
  for (const other of model.links) {
    if (memberIds.has(other.id) || !other.attachments) continue;
    for (const ref of [other.attachments.from, other.attachments.to]) {
      const found = owner.get(portKey(ref));
      if (found !== undefined) return { decline: 'shared-port', bundle: found };
    }
  }
  const members = model.groups[id]?.nodes ?? [];
  const seen = new Set<string>();
  const paths: { nodes: string[]; bundles: Bundle[]; edges: Bundle[][] }[] = [];
  for (const start of members) {
    if (seen.has(start) || !partners.has(start)) continue;
    const component: string[] = [], queue = [start];
    seen.add(start);
    for (const node of queue) { component.push(node); for (const next of partners.get(node)!.keys()) if (!seen.has(next)) { seen.add(next); queue.push(next); } }
    const edges = component.reduce((sum, node) => sum + partners.get(node)!.size, 0) / 2;
    const first = bundles.find(bundle => component.includes(bundle.nodes[0]))!;
    if (edges >= component.length) return { decline: 'cycle', bundle: first };
    const end = component.find(node => partners.get(node)!.size === 1)!;
    const nodes = [end], used: Bundle[] = [], edgesUsed: Bundle[][] = [];
    while (nodes.length < component.length) {
      const [next, via] = [...partners.get(nodes.at(-1)!)!].find(([other]) => !nodes.includes(other))!;
      nodes.push(next); used.push(via[0]!); edgesUsed.push(via);
    }
    paths.push({ nodes, bundles: used, edges: edgesUsed });
  }
  // 3. orientation: authored sides, then exits, then the direction the first bundle is written in
  const exits = groupExits(model, id);
  const oriented: Chain[] = [];
  let exitFault: Bundle | undefined;
  for (const path of paths) {
    const votes = new Set<'forward' | 'backward'>();
    path.edges.forEach((edge, index) => {
      const upper = path.nodes[index]!, lower = path.nodes[index + 1]!;
      for (const ref of edge.flatMap(ends)) {
        const side = authoredSide(model, ref);
        if (side === undefined) continue;
        const above = side === 'bottom' ? ref.node : side === 'top' ? (ref.node === upper ? lower : upper) : undefined;
        if (above !== undefined) votes.add(above === upper ? 'forward' : 'backward');
      }
    });
    if (votes.size > 1) return { decline: 'authored-side', bundle: path.bundles[0]! };
    const valid = (nodes: readonly string[]): boolean => nodes.every((node, index) =>
      (index === 0 || !exits.up.has(node)) && (index === nodes.length - 1 || !exits.down.has(node)));
    const forward = path.nodes, backward = [...path.nodes].reverse();
    let choice: string[] | undefined;
    if (votes.size === 1) choice = [...votes][0] === 'forward' ? forward : backward;
    else {
      const fits = [forward, backward].filter(valid);
      if (fits.length === 2) choice = writtenFirst(model, path, links) ? forward : backward;
      else choice = fits[0];
      if (choice === undefined) { exitFault ??= path.bundles[0]; continue; }
    }
    if (!valid(choice)) { exitFault ??= path.bundles[0]; continue; }
    const edges = path.edges.map(edge => edge.map(bundle => bundle.id));
    if (choice !== forward) edges.reverse();
    oriented.push({ nodes: choice, bundles: edges.flat(), edges });
  }
  if (exitFault) return { decline: 'exits', bundle: exitFault };
  if (!seatable(gridUnits(members, oriented, exits))) return { decline: 'rows', bundle: bundles[0]! };
  return { chains: oriented };
}

/** Whether the first bundle of `path` is written from its upper end (rule 3: the `from` end of the first member goes on top). */
function writtenFirst(model: LayoutModel, path: { nodes: string[]; bundles: Bundle[] }, links: ReadonlyMap<string, LayoutModel['links'][number]>): boolean {
  const order = new Map(model.bundles.map((bundle, index) => [bundle.id, index] as const));
  let index = 0;
  path.bundles.forEach((bundle, at) => { if (order.get(bundle.id)! < order.get(path.bundles[index]!.id)!) index = at; });
  const first = links.get(path.bundles[index]!.members[0]!)?.attachments?.from.node;
  return first === undefined || first === path.nodes[index];
}

/**
 * The side every member port of a chain takes: `bottom` on the upper end of each bundle, `top` on the
 * lower end. Fixed at stage 2 like an authored side, so no later stage overturns it.
 */
export function chainSides(model: LayoutModel, chains: readonly Chain[]): { ref: PortRef; side: Side }[] {
  const links = new Map(model.links.map(link => [link.id, link] as const));
  const bundles = new Map(model.bundles.map(bundle => [bundle.id, bundle] as const));
  const found: { ref: PortRef; side: Side }[] = [];
  for (const chain of chains) chain.edges.forEach((edge, index) => {
    const upper = chain.nodes[index]!;
    for (const id of edge) for (const member of bundles.get(id)?.members ?? []) {
      const attached = links.get(member)?.attachments;
      if (!attached) continue;
      for (const ref of [attached.from, attached.to]) found.push({ ref, side: ref.node === upper ? 'bottom' : 'top' });
    }
  });
  return found;
}
