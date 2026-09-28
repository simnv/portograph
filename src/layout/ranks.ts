import type { Side } from '../model/geometry.js';

/**
 * Rank derivation for one document group (docs/design/ranked-groups.md, section 1). Pure: plain
 * data in, plain data out, no geometry and no model mutation.
 */
export interface RankInput {
  group: string;
  parent?: string;
  /** Every member of the group, in declaration order. Child-group members are members of the parent. */
  members: string[];
  /** Routed links with at least one end in the group; a link with an end outside is ignored here. */
  routedLinks: { from: string; to: string; fromSide?: Side; toSide?: Side }[];
  /** Members with a routed link to the tier above. */
  linksAbove: Set<string>;
  /** Members with a routed link to the tier below. */
  linksBelow: Set<string>;
  /** Overlay partners of a member, in author order; a partner outside the group is ignored. */
  overlayPartners: Map<string, string[]>;
  /** The profile's class rank of a node, or undefined where its class has none. */
  classRank: (node: string) => number | undefined;
  children: { group: string; members: string[] }[];
}

export interface RankResult {
  ranks: Map<string, number>;
  rankCount: number;
  /** Which tier edge rank 0 (`above`, `none`) or the last rank (`below`) hangs from. */
  anchoredFrom: 'above' | 'below' | 'none';
  spans: Map<string, [number, number]>;
}

interface Link { a: string; b: string; peer: boolean }

const isFixedLateral = (side: Side | undefined): boolean => side === 'left' || side === 'right';

/** Step 2: a link between equal class ranks, or with both ports author-fixed to left/right, is a peer link. */
function peerLinks(input: RankInput, inGroup: Set<string>): Link[] {
  const result: Link[] = [];
  for (const link of input.routedLinks) {
    if (link.from === link.to || !inGroup.has(link.from) || !inGroup.has(link.to)) continue;
    const from = input.classRank(link.from), to = input.classRank(link.to);
    const peer = (from !== undefined && from === to) || (isFixedLateral(link.fromSide) && isFixedLateral(link.toSide));
    result.push({ a: link.from, b: link.to, peer });
  }
  return result;
}

/** Union-find over peer links: the members of one component always share a rank. */
function components(members: string[], links: Link[]): Map<string, string> {
  const parent = new Map(members.map(id => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let node = id; node !== root;) { const next = parent.get(node)!; parent.set(node, root); node = next; }
    return root;
  };
  for (const link of links) if (link.peer) {
    const a = find(link.a), b = find(link.b);
    if (a !== b) parent.set(b, a);
  }
  return new Map(members.map(id => [id, find(id)]));
}

/**
 * Step 3 and 4. Levels are breadth-first depths from the anchors over the non-peer links, with
 * every peer component contracted to one node. An edge between two levels is a layering edge; an
 * edge inside one level is a back link (or a cross link of a cycle) and counts as a peer link, so a
 * cycle cannot lengthen any path. Longest path over the layering edges is the level itself.
 */
function levels(members: string[], links: Link[], comp: Map<string, string>, anchors: string[]): Map<string, number> {
  const adjacent = new Map<string, string[]>();
  for (const link of links) {
    const a = comp.get(link.a)!, b = comp.get(link.b)!;
    if (link.peer || a === b) continue;
    adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
    adjacent.set(b, [...(adjacent.get(b) ?? []), a]);
  }
  const level = new Map<string, number>();
  const spread = (sources: string[]): void => {
    let frontier = [...new Set(sources.map(id => comp.get(id)!))].filter(id => !level.has(id));
    frontier.forEach(id => level.set(id, 0));
    for (let depth = 1; frontier.length; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) for (const other of adjacent.get(id) ?? []) if (!level.has(other)) { level.set(other, depth); next.push(other); }
      frontier = next;
    }
  };
  spread(anchors);
  const degree = new Map<string, number>();
  for (const link of links) for (const id of [link.a, link.b]) degree.set(id, (degree.get(id) ?? 0) + 1);
  for (;;) {
    let best: string | undefined;
    for (const id of members) if (!level.has(comp.get(id)!) && (degree.get(id) ?? 0) > 0 && (best === undefined || degree.get(id)! > degree.get(best)!)) best = id;
    if (best === undefined) break;
    spread([best]);
  }
  return new Map(members.filter(id => level.has(comp.get(id)!)).map(id => [id, level.get(comp.get(id)!)!]));
}

/** Steps 5: a span is `[min, max]` of the ranks of one child's members; an empty child has none. */
function spanOf(ranks: Map<string, number>, child: { members: string[] }): [number, number] | undefined {
  const own = child.members.map(id => ranks.get(id)).filter((rank): rank is number => rank !== undefined);
  return own.length ? [Math.min(...own), Math.max(...own)] : undefined;
}

/**
 * Step 5. A parent member whose rank falls inside a child's span and who is not a child member is
 * pushed to the rank after the span; whatever hangs below it moves down with it, and peers keep
 * sharing a rank. Ranks only grow, and every layering edge points from a lower base rank to a
 * higher one, so the loop ends; the bound is a guard, not a limit anyone should reach.
 */
function clearSpans(input: RankInput, members: string[], links: Link[], ranks: Map<string, number>): void {
  const owner = new Set(input.children.flatMap(child => child.members));
  const lateral: Link[] = [], forward: Link[] = [];
  for (const link of links) {
    const a = ranks.get(link.a)!, b = ranks.get(link.b)!;
    if (link.peer || a === b) lateral.push(link);
    else if (Math.abs(a - b) === 1) forward.push(a < b ? link : { ...link, a: link.b, b: link.a });
  }
  for (let round = 0; round < 4 * members.length + 4; round += 1) {
    let changed = false;
    const raise = (id: string, rank: number): void => { if (rank > ranks.get(id)!) { ranks.set(id, rank); changed = true; } };
    for (const link of forward) raise(link.b, ranks.get(link.a)! + 1);
    for (const link of lateral) { const top = Math.max(ranks.get(link.a)!, ranks.get(link.b)!); raise(link.a, top); raise(link.b, top); }
    for (const child of input.children) {
      const span = spanOf(ranks, child);
      if (!span) continue;
      for (const id of members) if (!owner.has(id) && ranks.get(id)! >= span[0] && ranks.get(id)! <= span[1]) raise(id, span[1] + 1);
    }
    if (!changed) return;
  }
}

export function deriveRanks(input: RankInput): RankResult {
  const members = [...new Set([...input.members, ...input.children.flatMap(child => child.members)])];
  const inGroup = new Set(members);
  const links = peerLinks(input, inGroup);
  const comp = components(members, links);
  const above = members.filter(id => input.linksAbove.has(id)), below = members.filter(id => input.linksBelow.has(id));
  // Step 1: an anchor above wins; else the members that link below anchor the last rank and the
  // layering runs upward; else the most-linked member is the anchor (chosen inside `levels`).
  const anchoredFrom = above.length ? 'above' : below.length ? 'below' : 'none';
  const depth = levels(members, links, comp, anchoredFrom === 'above' ? above : anchoredFrom === 'below' ? below : []);
  const deepest = depth.size ? Math.max(...depth.values()) : 0;
  const ranks = new Map([...depth].map(([id, level]) => [id, anchoredFrom === 'below' ? deepest - level : level]));
  const layered = links.filter(link => ranks.has(link.a) && ranks.has(link.b));
  clearSpans(input, [...ranks.keys()], layered, ranks);
  const rankCount = ranks.size ? Math.max(...ranks.values()) + 1 : 1;
  for (const id of members) if (!ranks.has(id)) ranks.set(id, rankCount - 1);
  const spans = new Map<string, [number, number]>();
  for (const child of input.children) { const span = spanOf(ranks, child); if (span) spans.set(child.group, span); }
  return { ranks, rankCount, anchoredFrom, spans };
}
