/**
 * The joint order of two rows (dense-16x9 ticket 32): an upper row and the row directly below it that only it feeds are ordered together, to
 * the fewest crossings of the links between them. An exact search, bounded: the orders of both rows are enumerated, interchangeable members
 * merged, and a pair with more than `PAIR_ORDER_BOUND` orders is not searched. Pure: the caller reads the rows off the model and records the
 * choice (`feed-order.ts`).
 */

/**
 * The most joint orders of one pair the search enumerates (R4, per pair): a pair with more keeps today's order, and the caller names it (R6,
 * `FEED_ORDER_PAIR_BOUND`). Why 10000: the competition case of ticket 30's review (four upper members, two fed, and six lower members that
 * no rule merges) has 12 x 720 = 8640 orders, and the corpus pairs have 100 or fewer; one order costs one pass over the pairs of links.
 */
export const PAIR_ORDER_BOUND = 10000;

export interface RowPair {
  /** The upper row's members, and the lower row's, in the order today's rules give them (`today`). */
  upper: readonly string[];
  lower: readonly string[];
  /** One entry per routed link between the rows: the upper member, then the lower member. */
  links: readonly (readonly [string, string])[];
  /** One entry per routed link inside one of the two rows (a peer link). */
  peers: readonly (readonly [string, string])[];
  /**
   * The rank of the feed key of each upper member that the row above feeds (0 for the smallest key; members whose keys are one key share a
   * rank, `feed-order.ts` decides that); an unfed member has none.
   */
  keys: ReadonlyMap<string, number>;
  /** For each node of the row above that links to two or more upper members: those members. */
  above: readonly (readonly string[])[];
  /** For each node outside the two rows that links to members of either: those members (a member once per link). */
  feeders: readonly (readonly string[])[];
  /** The declaration index of every member. */
  declared: ReadonlyMap<string, number>;
  /** An earlier joint choice for this pair (the previous round, or the ledger): it stays while it is still a minimum. */
  previous?: { upper: readonly string[]; lower: readonly string[] };
}

export type PairChoice =
  /** Today's order is a minimum, or there is nothing to choose: today's rules order the rows. */
  | { kind: 'kept' }
  /** The earlier joint choice is still a minimum: it stays. */
  | { kind: 'stays'; upper: readonly string[]; lower: readonly string[] }
  /** More orders than the bound (`orders`, a count the search reached past it): nothing searched. */
  | { kind: 'bound'; orders: number }
  /** No order keeps the feed keys of the upper row (a peer block that straddles two keys): nothing searched. */
  | { kind: 'infeasible' }
  | { kind: 'chosen'; upper: string[]; lower: string[]; crossings: number; was: number };

/**
 * The joint order of a pair of rows.
 *
 * 1. **Exact search, bounded.** Every order of the upper row that keeps its feed keys (a member with a smaller key stands left of one with a
 *    larger key; members with one key, and unfed members, are free), times every order of the lower row. The cost is the number of pairs of
 *    links between the rows that cross, plus, for each peer link whose ends do not stand side by side, the links between the rows of the
 *    members that stand between its ends. A run of peer neighbours as it stands is one unit. Members that no rule can tell apart (one row, the
 *    same links, key and feeders, no peer link) are merged: their orders cost the same, and they stand in declaration order.
 * 2. **The order the rows have stays when it is a minimum:** the earlier choice first, then today's order.
 * 3. **Among the minima:** the fewest members between the members that one node of the row above links to; then the smallest spread of each
 *    outside feeder's links over each row; then the smallest total span of the links between the rows (`span`); then
 *    declaration order (the upper row's, then the lower row's).
 */
export function choosePairOrder(pair: RowPair): PairChoice {
  const upperUnits = units(pair.upper, pair), lowerUnits = units(pair.lower, pair);
  const upperClasses = classes(upperUnits, pair, 'upper'), lowerClasses = classes(lowerUnits, pair, 'lower');
  const lowerCount = multinomial(lowerClasses.map(item => item.length));
  if (lowerCount > PAIR_ORDER_BOUND) return { kind: 'bound', orders: lowerCount };
  // The orders of the upper row are walked with the keys as a prefix test, and the walk stops past the bound.
  const most = Math.floor(PAIR_ORDER_BOUND / lowerCount), found = arrangements(upperClasses, prefix => keepsKeys(prefix, pair.keys), most);
  if (found === undefined) return { kind: 'bound', orders: (most + 1) * lowerCount };
  const uppers = found.map(flat);
  if (!uppers.length) return { kind: 'infeasible' };
  const lowers = arrangements(lowerClasses, () => true, PAIR_ORDER_BOUND)!.map(flat);
  const cost = costOf(pair);
  let best = Infinity;
  for (const upper of uppers) for (const lower of lowers) best = Math.min(best, cost(upper, lower));
  const { previous } = pair;
  if (previous !== undefined && sameMembers(previous, pair) && keepsKeys(units(previous.upper, pair), pair.keys)
    && cost(previous.upper, previous.lower) === best) return { kind: 'stays', upper: previous.upper, lower: previous.lower };
  const was = cost(pair.upper, pair.lower);
  if (was === best || uppers.length * lowers.length === 1) return { kind: 'kept' };
  let chosen: { upper: string[]; lower: string[]; rank: number[] } | undefined;
  for (const upper of uppers) for (const lower of lowers) {
    if (cost(upper, lower) !== best) continue;
    // Last key: declaration order (R3: content keys first, so a reversed declaration changes only a choice that nothing else separates).
    const rank = [between(upper, pair.above), spread(upper, lower, pair.feeders), span(upper, lower, pair.links), ...[...upper, ...lower].map(node => pair.declared.get(node)!)];
    if (chosen === undefined || before(rank, chosen.rank)) chosen = { upper, lower, rank };
  }
  return { kind: 'chosen', upper: chosen!.upper, lower: chosen!.lower, crossings: best, was };
}

/** The runs of a row whose neighbours a peer link joins, as they stand: one unit each. */
function units(order: readonly string[], pair: RowPair): string[][] {
  const joined = (a: string, b: string): boolean => pair.peers.some(([x, y]) => x === a && y === b || x === b && y === a);
  const result: string[][] = [];
  for (const [i, node] of order.entries()) if (i > 0 && joined(order[i - 1]!, node)) result[result.length - 1]!.push(node); else result.push([node]);
  return result;
}

/**
 * The units merged where no rule tells them apart: a lone member with no peer link, and the same links to the other row, the same key, the
 * same nodes of the row above and the same outside feeders. Each class is a list of units in declaration order.
 */
function classes(list: readonly string[][], pair: RowPair, side: 'upper' | 'lower'): string[][][] {
  const signature = (unit: readonly string[]): string => {
    const node = unit[0]!;
    if (unit.length > 1 || pair.peers.some(([x, y]) => x === node || y === node)) return `unit:${node}`;
    const partners = pair.links.flatMap(([upper, lower]) => side === 'upper' ? upper === node ? [lower] : [] : lower === node ? [upper] : []).sort();
    const tag = (lists: readonly (readonly string[])[]): number[] => lists.flatMap((members, at) => members.filter(item => item === node).map(() => at));
    return JSON.stringify([partners, pair.keys.get(node) ?? null, tag(pair.above), tag(pair.feeders)]);
  };
  const groups = new Map<string, string[][]>();
  for (const unit of list) groups.set(signature(unit), [...(groups.get(signature(unit)) ?? []), unit]);
  return [...groups.values()].map(items => [...items].sort((a, b) => pair.declared.get(a[0]!)! - pair.declared.get(b[0]!)!));
}

const factorial = (n: number): number => n <= 1 ? 1 : n * factorial(n - 1);
const multinomial = (sizes: readonly number[]): number => factorial(sizes.reduce((sum, size) => sum + size, 0)) / sizes.reduce((product, size) => product * factorial(size), 1);

/**
 * Every sequence of the units in which the units of one class keep their order (each multiset permutation once) and every prefix passes
 * `accept`; undefined when there are more than `most`.
 */
function arrangements(groups: readonly (readonly string[][])[], accept: (prefix: readonly (readonly string[])[]) => boolean, most: number): string[][][] | undefined {
  const result: string[][][] = [], taken = groups.map(() => 0), total = groups.reduce((sum, items) => sum + items.length, 0), current: string[][] = [];
  const walk = (): boolean => {
    if (current.length === total) { result.push([...current]); return result.length <= most; }
    for (const [at, items] of groups.entries()) {
      if (taken[at]! >= items.length) continue;
      current.push(items[taken[at]!]!); taken[at]!++;
      const going = !accept(current) || walk();
      taken[at]!--; current.pop();
      if (!going) return false;
    }
    return true;
  };
  return walk() ? result : undefined;
}
const flat = (order: readonly (readonly string[])[]): string[] => order.flat();

/** Whether a sequence of units keeps the feed keys: no member stands left of a member with a smaller key. */
function keepsKeys(order: readonly (readonly string[])[], keys: ReadonlyMap<string, number>): boolean {
  let most = -Infinity;
  for (const unit of order) {
    const mine = unit.map(node => keys.get(node)).filter((key): key is number => key !== undefined);
    if (mine.some(key => key < most)) return false;
    // Inside a unit the members keep the order they stand in; a unit whose members' keys fall breaks the keys.
    if (mine.some((key, i) => i > 0 && key < mine[i - 1]!)) return false;
    if (mine.length) most = Math.max(most, ...mine);
  }
  return true;
}

/** The cost of a pair of orders: the crossings of the links between the rows, and the links between the rows that a peer link passes. */
function costOf(pair: RowPair): (upper: readonly string[], lower: readonly string[]) => number {
  return (upper, lower) => {
    const at = new Map([...upper.map((node, i) => [node, i] as const), ...lower.map((node, i) => [node, i] as const)]);
    let count = 0;
    for (let i = 0; i < pair.links.length; i++) for (let j = i + 1; j < pair.links.length; j++) {
      const [a, b] = pair.links[i]!, [c, d] = pair.links[j]!;
      if ((at.get(a)! - at.get(c)!) * (at.get(b)! - at.get(d)!) < 0) count++;
    }
    const upperSet = new Set(upper);
    for (const [x, y] of pair.peers) {
      const low = Math.min(at.get(x)!, at.get(y)!), high = Math.max(at.get(x)!, at.get(y)!), side = upperSet.has(x) ? 0 : 1;
      if (high - low > 1) count += pair.links.filter(link => { const p = at.get(link[side])!; return p > low && p < high; }).length;
    }
    return count;
  };
}

/** How many members stand between the members one node of the row above links to, and are not linked to it. */
function between(upper: readonly string[], above: readonly (readonly string[])[]): number {
  return above.reduce((sum, members) => {
    const at = members.map(node => upper.indexOf(node));
    return sum + upper.slice(Math.min(...at), Math.max(...at) + 1).filter(node => !members.includes(node)).length;
  }, 0);
}

/** The spread of each outside feeder's links over each row, summed: the slots from its leftmost member to its rightmost. */
function spread(upper: readonly string[], lower: readonly string[], feeders: readonly (readonly string[])[]): number {
  return feeders.reduce((sum, members) => sum + [upper, lower].reduce((part, row) => {
    const at = members.map(node => row.indexOf(node)).filter(index => index >= 0);
    return part + (at.length > 1 ? Math.max(...at) - Math.min(...at) : 0);
  }, 0), 0);
}

/**
 * The total span of the links between the rows: the slots between the two ends of each, summed. A slot counts the members with a link
 * between the rows only (a member with none takes no part in it), and each row is read from its middle, so a mirrored pair has the mirrored
 * span (R3).
 */
function span(upper: readonly string[], lower: readonly string[], links: readonly (readonly [string, string])[]): number {
  const up = upper.filter(node => links.some(([a]) => a === node)), down = lower.filter(node => links.some(([, b]) => b === node));
  const shift = (up.length - down.length) / 2;
  return links.reduce((sum, [a, b]) => sum + Math.abs(up.indexOf(a) - down.indexOf(b) - shift), 0);
}
const before = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
};
const sameMembers = (orders: { upper: readonly string[]; lower: readonly string[] }, pair: RowPair): boolean =>
  orders.upper.length === pair.upper.length && orders.lower.length === pair.lower.length
  && orders.upper.every(node => pair.upper.includes(node)) && orders.lower.every(node => pair.lower.includes(node));
