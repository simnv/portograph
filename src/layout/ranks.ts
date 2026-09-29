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
 * Steps 3 and 4. Peer components are contracted to one node. Breadth-first levels from the anchors
 * decide which way an edge points: between two levels it points down. An edge inside one level is
 * oriented by class rank where both classes have one and differ (the lower class rank is upstream),
 * else as the author wrote it; if that would close a cycle it is the back link of the cycle and
 * counts as a peer link for the layering only, so it never lengthens a path. An edge into an anchor
 * is dropped, since an anchor stays at depth 0. The depth of a member is then the longest path from
 * an anchor over the oriented edges, which is what lets a link that skips a rank leave the chain intact.
 */
function layer(input: RankInput, members: string[], links: Link[], comp: Map<string, string>, anchors: string[]):
{ depth: Map<string, number>; dag: Link[] } {
  const adjacent = new Map<string, string[]>();
  for (const link of links) {
    const a = comp.get(link.a)!, b = comp.get(link.b)!;
    if (link.peer || a === b) continue;
    adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
    adjacent.set(b, [...(adjacent.get(b) ?? []), a]);
  }
  const level = new Map<string, number>(), sources = new Set<string>();
  const spread = (from: string[]): void => {
    let frontier = [...new Set(from.map(id => comp.get(id)!))].filter(id => !level.has(id));
    frontier.forEach(id => { level.set(id, 0); sources.add(id); });
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
  const out = new Map<string, Set<string>>();
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>(), stack = [from];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(out.get(id) ?? []));
    }
    return false;
  };
  const dag: Link[] = [];
  const point = (upstream: string, downstream: string): void => {
    dag.push({ a: upstream, b: downstream, peer: false });
    const from = comp.get(upstream)!;
    out.set(from, (out.get(from) ?? new Set()).add(comp.get(downstream)!));
  };
  const sameLevel: Link[] = [];
  for (const link of links) {
    const a = comp.get(link.a)!, b = comp.get(link.b)!;
    if (link.peer || a === b) continue;
    const la = level.get(a)!, lb = level.get(b)!;
    if (la < lb) point(link.a, link.b); else if (lb < la) point(link.b, link.a); else sameLevel.push(link);
  }
  for (const link of sameLevel) {
    const ra = input.classRank(link.a), rb = input.classRank(link.b);
    const swap = ra !== undefined && rb !== undefined && rb < ra;
    const [up, down] = swap ? [link.b, link.a] : [link.a, link.b];
    if (sources.has(comp.get(down)!) || reaches(comp.get(down)!, comp.get(up)!)) continue;
    point(up, down);
  }
  // Longest path over the oriented edges, in topological order.
  const depth = new Map<string, number>(), indegree = new Map<string, number>();
  for (const targets of out.values()) for (const to of targets) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  const ready = [...level.keys()].filter(id => !indegree.has(id));
  ready.forEach(id => depth.set(id, 0));
  for (let id = ready.shift(); id !== undefined; id = ready.shift()) {
    for (const to of out.get(id) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 0, depth.get(id)! + 1));
      indegree.set(to, indegree.get(to)! - 1);
      if (indegree.get(to) === 0) ready.push(to);
    }
  }
  return { depth: new Map(members.filter(id => level.has(comp.get(id)!)).map(id => [id, depth.get(comp.get(id)!)!])), dag };
}

interface Edges { lateral: Link[]; forward: Link[] }

/** Peer links keep their two ends level; the oriented edges push the far end down. */
function edgesOf(links: Link[], dag: Link[], ranks: Map<string, number>, below: boolean): Edges {
  const has = (link: Link): boolean => ranks.has(link.a) && ranks.has(link.b);
  return {
    lateral: links.filter(link => link.peer && has(link)),
    forward: dag.filter(has).map(link => below ? { ...link, a: link.b, b: link.a } : link),
  };
}

/** Step 5: a span is `[min, max]` of the ranks of one child's members; an empty child has none. */
function spanOf(ranks: Map<string, number>, child: { members: string[] }): [number, number] | undefined {
  const own = child.members.map(id => ranks.get(id)).filter((rank): rank is number => rank !== undefined);
  return own.length ? [Math.min(...own), Math.max(...own)] : undefined;
}

/**
 * Step 5. Every member is ranked once before this runs, and the spans are read from those ranks and
 * then held fixed: a child member never moves here. Each non-child member whose rank lies inside a
 * span is pushed to the rank after it. A pushed member drags what hangs below it down by longest
 * path over the non-child part of the graph, and peers among non-child members keep one rank; a
 * link from a pushed member into a child moves nothing, since the child is fixed. Only non-child
 * ranks grow, and by a bounded amount, so the loop ends; the round bound is a guard.
 */
function clearSpans(input: RankInput, members: string[], edges: Edges, ranks: Map<string, number>, spans: [number, number][]): void {
  const owner = new Set(input.children.flatMap(child => child.members));
  const { lateral, forward } = edges;
  for (let round = 0; round < 4 * members.length + 4; round += 1) {
    let changed = false;
    const raise = (id: string, rank: number): void => { if (!owner.has(id) && rank > ranks.get(id)!) { ranks.set(id, rank); changed = true; } };
    for (const link of forward) raise(link.b, ranks.get(link.a)! + 1);
    for (const link of lateral) { const top = Math.max(ranks.get(link.a)!, ranks.get(link.b)!); raise(link.a, top); raise(link.b, top); }
    for (const [from, to] of spans) for (const id of members) if (ranks.get(id)! >= from && ranks.get(id)! <= to) raise(id, to + 1);
    if (!changed) return;
  }
}

/**
 * Step 5, the leaf rule. A child is a leaf child when none of its members has a routed link to a
 * member outside it (a parent member or a member of a sibling child) of a deeper rank, none of its
 * members is an anchor, and none shares a peer component with a member that is not itself in a leaf
 * child: it feeds nothing below itself, hangs from nothing above the group and leaves no peer
 * behind. Ranks are those before any push.
 */
function leafChildren(input: RankInput, ranks: Map<string, number>, anchors: Set<string>, comp: Map<string, string>): Set<RankInput['children'][number]> {
  const leaves = new Set<RankInput['children'][number]>();
  for (const child of input.children) {
    const inside = new Set(child.members);
    if (!spanOf(ranks, child) || child.members.some(id => anchors.has(id))) continue;
    const feeds = input.routedLinks.some(link => [[link.from, link.to], [link.to, link.from]].some(([mine, other]) =>
      inside.has(mine!) && ranks.has(other!) && !inside.has(other!) && ranks.get(other!)! > ranks.get(mine!)!));
    if (!feeds) leaves.add(child);
  }
  // A peer partner outside every leaf child pins the child; dropping one child can pin another.
  for (let changed = true; changed;) {
    changed = false;
    const inLeaf = new Set([...leaves].flatMap(child => child.members));
    for (const child of leaves) {
      const roots = new Set(child.members.map(id => comp.get(id)));
      const pinned = [...ranks.keys()].some(id => roots.has(comp.get(id)) && !child.members.includes(id) && !inLeaf.has(id));
      if (pinned) { leaves.delete(child); changed = true; break; }
    }
  }
  return leaves;
}

/** Leaf children joined by a peer link share one origin, so their peers keep one rank after the shift. */
function leafOrigins(leaves: Set<RankInput['children'][number]>, ranks: Map<string, number>, comp: Map<string, string>): Map<RankInput['children'][number], number> {
  const origin = new Map([...leaves].map(child => [child, spanOf(ranks, child)![0]]));
  const roots = (child: RankInput['children'][number]) => new Set(child.members.map(id => comp.get(id)));
  for (let changed = true; changed;) {
    changed = false;
    for (const one of leaves) for (const other of leaves) {
      if (one === other || ![...roots(one)].some(root => roots(other).has(root))) continue;
      const least = Math.min(origin.get(one)!, origin.get(other)!);
      if (origin.get(one) !== least || origin.get(other) !== least) { origin.set(one, least); origin.set(other, least); changed = true; }
    }
  }
  return origin;
}

/** A push can leave a rank empty; ranks are dense, so the members below it close up. */
function compact(ranks: Map<string, number>): void {
  const used = [...new Set(ranks.values())].sort((a, b) => a - b);
  for (const [id, rank] of ranks) ranks.set(id, used.indexOf(rank));
}

export function deriveRanks(input: RankInput): RankResult {
  const members = [...new Set([...input.members, ...input.children.flatMap(child => child.members)])];
  const inGroup = new Set(members);
  const links = peerLinks(input, inGroup);
  const comp = components(members, links);
  const above = members.filter(id => input.linksAbove.has(id)), below = members.filter(id => input.linksBelow.has(id));
  // Step 1: an anchor above wins; else the members that link below anchor the last rank and the
  // layering runs upward; else the group has one rank (returned above).
  const anchoredFrom = above.length ? 'above' : below.length ? 'below' : 'none';
  // Spec section 1, step 1: a group with no anchor has one rank. Its internal links are peer links.
  if (anchoredFrom === 'none') {
    const spans = new Map<string, [number, number]>();
    for (const child of input.children) if (spanOf(new Map(members.map(id => [id, 0])), child)) spans.set(child.group, [0, 0]);
    return { ranks: new Map(members.map(id => [id, 0])), rankCount: 1, anchoredFrom, spans };
  }
  const { depth, dag } = layer(input, members, links, comp, anchoredFrom === 'above' ? above : anchoredFrom === 'below' ? below : []);
  const deepest = depth.size ? Math.max(...depth.values()) : 0;
  const ranks = new Map([...depth].map(([id, level]) => [id, anchoredFrom === 'below' ? deepest - level : level]));
  const edges = edgesOf(links, dag, ranks, anchoredFrom === 'below');
  // Step 6: a member the layering did not reach has no routed link inside the group. It takes the
  // rank of its first overlay partner that has one, else the last rank. All members are ranked
  // before step 5 reads the spans.
  const lastRank = ranks.size ? Math.max(...ranks.values()) : 0;
  const routed = new Set(ranks.keys());
  for (const id of members) if (!routed.has(id)) {
    const partner = (input.overlayPartners.get(id) ?? []).find(other => routed.has(other));
    ranks.set(id, partner === undefined ? lastRank : ranks.get(partner)!);
  }
  // Step 5. `max(own, first rank of the child)` from the spec is a no-op here: the first rank of a
  // child is the least rank of its members, so no member is below it. A leaf child pushes nothing;
  // it takes the ranks after the last rank of the rest of the group, keeping its own internal order.
  // Only a group hung from above has the rule: below-anchored, the last rank belongs to the members
  // that link below, and a child moved past it would take that place.
  const leaves = anchoredFrom === 'above' ? leafChildren(input, ranks, new Set(above), comp) : new Set<RankInput['children'][number]>();
  const held = input.children.filter(child => !leaves.has(child)).map(child => spanOf(ranks, child)).filter((span): span is [number, number] => span !== undefined);
  const origins = leafOrigins(leaves, ranks, comp);
  clearSpans(input, members, edges, ranks, held);
  const leafMembers = new Set([...leaves].flatMap(child => child.members));
  const rest = [...ranks].filter(([id]) => !leafMembers.has(id)).map(([, rank]) => rank);
  if (rest.length) for (const [child, origin] of origins) for (const id of child.members) if (ranks.has(id)) ranks.set(id, ranks.get(id)! - origin + Math.max(...rest) + 1);
  compact(ranks);
  const rankCount = Math.max(...ranks.values(), 0) + 1;
  const spans = new Map<string, [number, number]>();
  for (const child of input.children) { const span = spanOf(ranks, child); if (span) spans.set(child.group, span); }
  return { ranks, rankCount, anchoredFrom, spans };
}
