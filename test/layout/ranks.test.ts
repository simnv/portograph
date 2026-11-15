import { describe, expect, it } from 'vitest';
import { deriveRanks, type RankInput } from '../../src/layout/ranks.js';

const chain = (...ids: string[]) => ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id }));
const input = (over: Partial<RankInput> & Pick<RankInput, 'members'>): RankInput => ({
  group: 'g', routedLinks: [], linksAbove: new Set(), linksBelow: new Set(), overlayPartners: new Map(),
  children: [], ...over,
});
// Six members of one class (ticket 27): two anchors, a pair below them, then two pairs side by side, then two pairs, then servers.
const SIX_BODIES = {
  members: ['crt1', 'crt2', 'crt3', 'crt4', 'srt1', 'srt2', 'rrt1', 'rrt2', 'ssw1', 'ssw2', 'rsw1', 'rsw2', 'ntp1', 'ntp2', 'slb1', 'rlb1'],
  links: [
    ...['crt3', 'crt4'].flatMap(id => ['crt1', 'crt2'].map(top => ({ from: top, to: id }))),
    ...['srt1', 'srt2', 'rrt1', 'rrt2'].flatMap(id => ['crt3', 'crt4'].map(top => ({ from: top, to: id }))),
    ...['ssw1', 'ssw2'].flatMap(id => ['srt1', 'srt2'].map(top => ({ from: top, to: id }))),
    ...['rsw1', 'rsw2'].flatMap(id => ['rrt1', 'rrt2'].map(top => ({ from: top, to: id }))),
    { from: 'crt3', to: 'crt4' }, { from: 'srt1', to: 'srt2' }, { from: 'rrt1', to: 'rrt2' }, { from: 'ssw1', to: 'ssw2' }, { from: 'rsw1', to: 'rsw2' },
    { from: 'ssw1', to: 'ntp1' }, { from: 'ssw2', to: 'ntp2' }, { from: 'ntp1', to: 'slb1' }, { from: 'ntp2', to: 'rlb1' },
  ],
  ranks: {
    crt1: 0, crt2: 0, crt3: 1, crt4: 1, srt1: 2, srt2: 2, rrt1: 2, rrt2: 2,
    ssw1: 3, ssw2: 3, rsw1: 3, rsw2: 3, ntp1: 4, ntp2: 4, slb1: 5, rlb1: 5,
  },
};
const asObject = (ranks: Map<string, number>) => Object.fromEntries(ranks);

describe('deriveRanks: layering', () => {
  it('a plain chain takes one rank per link, from the member that links to the tier above', () => {
    const result = deriveRanks(input({ members: ['a', 'b', 'c'], routedLinks: chain('a', 'b', 'c'), linksAbove: new Set(['a']) }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, c: 2 });
    expect(result.rankCount).toBe(3);
    expect(result.anchoredFrom).toBe('above');
    expect(result.spans.size).toBe(0);
  });

  it('a peer pair under one uplink shares one rank: the two ends are of equal depth', () => {
    const result = deriveRanks(input({
      members: ['rt', 'sw1', 'sw2'], linksAbove: new Set(['rt']),
      routedLinks: [{ from: 'rt', to: 'sw1' }, { from: 'rt', to: 'sw2' }, { from: 'sw1', to: 'sw2' }],
    }));
    expect(asObject(result.ranks)).toEqual({ rt: 0, sw1: 1, sw2: 1 });
    expect(result.rankCount).toBe(2);
  });

  it('a peer link never lengthens a path: members of equal depth share a rank and feed the next one together', () => {
    const result = deriveRanks(input({
      members: ['a', 'x', 'y', 'z'], linksAbove: new Set(['a']),
      routedLinks: [{ from: 'a', to: 'x' }, { from: 'a', to: 'y' }, { from: 'x', to: 'y' }, { from: 'y', to: 'z' }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, x: 1, y: 1, z: 2 });
  });

  it('a cycle rt-rt-sw-sw layers by hops: the member farthest from the anchor stands last', () => {
    // Ticket 27: the ring has no inherent order, so class no longer pairs the ends. sw2 and rt2 are one hop
    // from rt1 and sw1 is two hops away, whichever way round.
    const result = deriveRanks(input({
      members: ['rt1', 'rt2', 'sw1', 'sw2'], linksAbove: new Set(['rt1']),
      routedLinks: [{ from: 'rt1', to: 'rt2' }, { from: 'rt2', to: 'sw1' }, { from: 'sw1', to: 'sw2' }, { from: 'sw2', to: 'rt1' }],
    }));
    expect(asObject(result.ranks)).toEqual({ rt1: 0, rt2: 1, sw1: 2, sw2: 1 });
  });

  it('a triangle a-b, b-c, a-c puts b and c on one rank as peers', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'c'], linksAbove: new Set(['a']),
      routedLinks: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, c: 1 });
    expect(result.rankCount).toBe(2);
  });

  it('a chain with a skip link reads the skip as a shorter path: the far end takes the depth of one hop', () => {
    // a-b, b-c, c-d and a-d: d is one hop from a, so it stands beside b and c is the only member at depth 2.
    const result = deriveRanks(input({
      members: ['a', 'b', 'c', 'd'], linksAbove: new Set(['a']),
      routedLinks: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'a', to: 'd' }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, c: 2, d: 1 });
  });

  it('the reference location: two routers on the anchor, a switch pair, a server pair, six members, three ranks', () => {
    const routedLinks = [
      { from: 'rt1', to: 'rt2' }, { from: 'rt1', to: 'sw1' }, { from: 'rt1', to: 'sw2' }, { from: 'rt2', to: 'sw1' }, { from: 'rt2', to: 'sw2' },
      { from: 'sw1', to: 'sw2' }, { from: 'sw1', to: 'ntp1' }, { from: 'sw2', to: 'ntp2' },
    ];
    const result = deriveRanks(input({ members: ['rt1', 'rt2', 'sw1', 'sw2', 'ntp1', 'ntp2'], linksAbove: new Set(['rt1', 'rt2']), routedLinks }));
    expect(asObject(result.ranks)).toEqual({ rt1: 0, rt2: 0, sw1: 1, sw2: 1, ntp1: 2, ntp2: 2 });
    // A skip link rt1-ntp1 puts ntp1 one hop from the anchor, in the switches' rank; ntp2 stays below.
    const skip = deriveRanks(input({
      members: ['rt1', 'rt2', 'sw1', 'sw2', 'ntp1', 'ntp2'], linksAbove: new Set(['rt1', 'rt2']), routedLinks: [...routedLinks, { from: 'rt1', to: 'ntp1' }],
    }));
    expect(asObject(skip.ranks)).toEqual({ rt1: 0, rt2: 0, sw1: 1, sw2: 1, ntp1: 1, ntp2: 2 });
  });

  it('the six-body collapse: members of one class rank take the reference rows by depth (ticket 27)', () => {
    const result = deriveRanks(input({ members: SIX_BODIES.members, linksAbove: new Set(['crt1', 'crt2']), routedLinks: SIX_BODIES.links }));
    expect(asObject(result.ranks)).toEqual(SIX_BODIES.ranks);
    expect(result.rankCount).toBe(6);
  });

  it('a left/right-fixed peer link is no shortcut: its two ends share a depth, and what hangs from them stands below', () => {
    // a-b-c-d chain with b and d fixed left/right: b and d are one node for the depth, c is one hop below both.
    const result = deriveRanks(input({
      members: ['a', 'b', 'c', 'd'], linksAbove: new Set(['a']),
      routedLinks: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'b', to: 'd', fromSide: 'right', toSide: 'left' }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, c: 2, d: 1 });
  });

  it('a diamond keeps both middle members on one rank', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'c', 'd'], linksAbove: new Set(['a']),
      routedLinks: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, c: 1, d: 2 });
  });

  it('a link whose two ports the author fixed to left and right is a peer link', () => {
    const side = (fromSide?: 'left' | 'right' | 'top', toSide?: 'left' | 'right' | 'top') => asObject(deriveRanks(input({
      members: ['a', 'b'], linksAbove: new Set(['a']),
      routedLinks: [{ from: 'a', to: 'b', ...(fromSide ? { fromSide } : {}), ...(toSide ? { toSide } : {}) }],
    })).ranks);
    expect(side('right', 'left')).toEqual({ a: 0, b: 0 });
    expect(side('right', 'right')).toEqual({ a: 0, b: 0 });
    expect(side('right')).toEqual({ a: 0, b: 1 });
    expect(side('right', 'top')).toEqual({ a: 0, b: 1 });
  });

  it('a member no anchor reaches takes the last rank, whatever routed links it has among the unreachable', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'x', 'y'], linksAbove: new Set(['a']), routedLinks: [{ from: 'a', to: 'b' }, { from: 'x', to: 'y' }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, x: 1, y: 1 });
    // An overlay partner that has a rank wins over the last rank.
    const overlay = deriveRanks(input({
      members: ['a', 'b', 'x', 'y'], linksAbove: new Set(['a']), routedLinks: [{ from: 'a', to: 'b' }, { from: 'x', to: 'y' }],
      overlayPartners: new Map([['x', ['a']]]),
    }));
    expect(asObject(overlay.ranks)).toEqual({ a: 0, b: 1, x: 0, y: 1 });
  });

  it('ignores a link that leaves the group and a link from a member to itself', () => {
    const result = deriveRanks(input({
      members: ['a', 'b'], linksAbove: new Set(['a']), routedLinks: [{ from: 'a', to: 'far' }, { from: 'b', to: 'b' }, { from: 'a', to: 'b' }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1 });
  });
});

describe('deriveRanks: anchors', () => {
  it('with no anchor above, the members that link below are anchors at the last rank', () => {
    const result = deriveRanks(input({ members: ['a', 'b', 'c'], routedLinks: chain('a', 'b', 'c'), linksBelow: new Set(['c']) }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, c: 2 });
    expect(result.anchoredFrom).toBe('below');
    const upward = deriveRanks(input({
      members: ['a', 'b', 'c', 'd'], linksBelow: new Set(['a']),
      routedLinks: [{ from: 'c', to: 'b' }, { from: 'a', to: 'b' }, { from: 'd', to: 'c' }],
    }));
    expect(asObject(upward.ranks)).toEqual({ a: 3, b: 2, c: 1, d: 0 });
    expect(upward.rankCount).toBe(4);
  });

  it('an anchor above wins over an anchor below', () => {
    const result = deriveRanks(input({ members: ['a', 'b'], routedLinks: chain('a', 'b'), linksAbove: new Set(['a']), linksBelow: new Set(['b']) }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1 });
    expect(result.anchoredFrom).toBe('above');
  });

  it('with no anchor either way, the group is one rank however its members are linked', () => {
    const result = deriveRanks(input({
      members: ['leaf1', 'hub', 'leaf2', 'leaf3'],
      routedLinks: [{ from: 'leaf1', to: 'hub' }, { from: 'hub', to: 'leaf2' }, { from: 'hub', to: 'leaf3' }],
    }));
    expect(asObject(result.ranks)).toEqual({ leaf1: 0, hub: 0, leaf2: 0, leaf3: 0 });
    expect(result.rankCount).toBe(1);
    expect(result.anchoredFrom).toBe('none');
  });

  it('a group with no anchor gives every child a span of rank 0 to 0', () => {
    const result = deriveRanks(input({
      members: ['a', 'b'], routedLinks: chain('a', 'b', 'c'), children: [{ group: 'kid', members: ['c'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 0, c: 0 });
    expect(result.rankCount).toBe(1);
    expect(result.spans.get('kid')).toEqual([0, 0]);
  });

  it('an anchored group whose two switches are peers and both link up to the router stays two ranks', () => {
    const result = deriveRanks(input({
      members: ['rt', 'sw1', 'sw2'], linksAbove: new Set(['rt']),
      routedLinks: [{ from: 'rt', to: 'sw1' }, { from: 'rt', to: 'sw2' }, { from: 'sw1', to: 'sw2' }],
    }));
    expect(asObject(result.ranks)).toEqual({ rt: 0, sw1: 1, sw2: 1 });
    expect(result.rankCount).toBe(2);
  });

  it('a group with no routed link at all is one rank', () => {
    const result = deriveRanks(input({ members: ['a', 'b'] }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 0 });
    expect(result.rankCount).toBe(1);
    expect(result.anchoredFrom).toBe('none');
  });
});

describe('deriveRanks: child groups', () => {
  it('a child span covers whole ranks, and a parent member inside it is pushed to the rank after it', () => {
    const result = deriveRanks(input({
      members: ['p', 'c1', 'c2', 'x', 't'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'p', to: 'x' }, { from: 'c2', to: 't' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    // The child feeds a deeper parent member (c2 -> t), so it keeps its longest-path position (ticket 19).
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1, c2: 2, x: 3, t: 3 });
    expect(result.spans.get('zone')).toEqual([1, 2]);
    expect(result.rankCount).toBe(4);
  });

  it('a pushed parent member pushes what hangs below it', () => {
    const result = deriveRanks(input({
      members: ['p', 'c1', 'c2', 'x', 'y', 't'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'p', to: 'x' }, { from: 'x', to: 'y' }, { from: 'c2', to: 't' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    // The child feeds t, so it is not a leaf child (ticket 19) and still pushes x and y.
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1, c2: 2, x: 3, y: 4, t: 3 });
  });

  it('a parent member between two child members is pushed once, and the empty rank it leaves closes up', () => {
    const result = deriveRanks(input({
      members: ['c1', 'p', 'c2'], linksAbove: new Set(['c1']),
      routedLinks: [{ from: 'c1', to: 'p' }, { from: 'p', to: 'c2' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ c1: 0, c2: 1, p: 2 });
    expect(result.spans.get('zone')).toEqual([0, 1]);
    expect(result.rankCount).toBe(3);
  });

  it('a link from a pushed member into the child never moves a child member', () => {
    const result = deriveRanks(input({
      members: ['c1', 'p', 'q', 'c2'], linksAbove: new Set(['c1']),
      routedLinks: [{ from: 'c1', to: 'p' }, { from: 'p', to: 'q' }, { from: 'q', to: 'c2' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    // c1 0, p 1, q 2, c2 3 before the push; p and q sit inside [0, 3], so both go past it.
    expect(result.spans.get('zone')).toEqual([0, 1]);
    expect(result.ranks.get('c1')).toBe(0);
    expect(result.ranks.get('c2')).toBe(1);
    expect(result.ranks.get('p')! < result.ranks.get('q')!).toBe(true);
    expect(Math.min(result.ranks.get('p')!, result.ranks.get('q')!)).toBeGreaterThan(1);
  });

  it('a parent member outside the span stays where it is', () => {
    const result = deriveRanks(input({
      members: ['p', 'c1', 'c2', 'x'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'c2', to: 'x' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1, c2: 2, x: 3 });
    expect(result.spans.get('zone')).toEqual([1, 2]);
  });

  it('child members that are not listed as members of the parent are still ranked', () => {
    const result = deriveRanks(input({
      members: ['p'], linksAbove: new Set(['p']), routedLinks: [{ from: 'p', to: 'c1' }],
      children: [{ group: 'zone', members: ['c1'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1 });
    expect(result.spans.get('zone')).toEqual([1, 1]);
  });

  it('a child with no members has no span', () => {
    const result = deriveRanks(input({ members: ['p'], children: [{ group: 'zone', members: [] }] }));
    expect(result.spans.has('zone')).toBe(false);
  });

  it('a peer of a pushed member goes with it', () => {
    const result = deriveRanks(input({
      members: ['p', 'c1', 'c2', 'x1', 'x2', 't'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'p', to: 'x1' }, { from: 'p', to: 'x2' }, { from: 'x1', to: 'x2' }, { from: 'c2', to: 't' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    expect(result.ranks.get('x1')).toBe(3);
    expect(result.ranks.get('x2')).toBe(3);
  });

  it('two children may share ranks, and a parent member is pushed past both spans', () => {
    const result = deriveRanks(input({
      members: ['p', 'a1', 'a2', 'b1', 'x', 't', 'u'], linksAbove: new Set(['p']),
      // Both children feed a deeper member (`u`, `t`), so neither is a leaf child (ticket 28) and both push.
      routedLinks: [{ from: 'p', to: 'a1' }, { from: 'a1', to: 'a2' }, { from: 'p', to: 'b1' }, { from: 'p', to: 'x' }, { from: 'a2', to: 'u' }, { from: 'b1', to: 't' }],
      children: [{ group: 'za', members: ['a1', 'a2'] }, { group: 'zb', members: ['b1'] }],
    }));
    expect(result.spans.get('za')).toEqual([1, 2]);
    expect(result.spans.get('zb')).toEqual([1, 1]);
    expect(result.ranks.get('x')).toBe(3);
  });
});

describe('deriveRanks: a leaf child stands beside the parent members of its ranks', () => {
  const shape = (extra: { from: string; to: string }[] = []) => input({
    members: ['rt', 'sw', 'crt', 'sw2', 'srv'], linksAbove: new Set(['rt']),
    routedLinks: [...chain('rt', 'sw'), { from: 'sw', to: 'ntp' }, { from: 'ntp', to: 'fw' }, ...chain('sw', 'crt', 'sw2', 'srv'), ...extra],
    children: [{ group: 'zone', members: ['ntp', 'fw'] }],
  });

  it('the NTP shape: a child that feeds no deeper parent member keeps its depth ranks and pushes nothing', () => {
    const result = deriveRanks(shape());
    // The parent members `crt` and `sw2` stand in the span [2, 3] beside the child (ticket 28).
    expect(asObject(result.ranks)).toEqual({ rt: 0, sw: 1, crt: 2, sw2: 3, srv: 4, ntp: 2, fw: 3 });
    expect(result.spans.get('zone')).toEqual([2, 3]);
    expect(result.rankCount).toBe(5);
  });

  it('a child that feeds a deeper parent member keeps its longest-path position and pushes the others', () => {
    const result = deriveRanks(shape([{ from: 'fw', to: 'srv' }]));
    expect(result.spans.get('zone')).toEqual([2, 3]);
    expect(result.ranks.get('ntp')).toBe(2);
    expect(result.ranks.get('fw')).toBe(3);
    expect(result.ranks.get('fw')!).toBeLessThan(result.ranks.get('srv')!);
    expect(result.ranks.get('crt')!).toBeGreaterThan(3);
  });

  it('a child that holds an anchor stays where it is', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'x'], linksAbove: new Set(['a']), routedLinks: [{ from: 'a', to: 'b' }, { from: 'a', to: 'x' }, { from: 'x', to: 'y' }],
      children: [{ group: 'zone', members: ['a', 'b'] }],
    }));
    expect(result.ranks.get('a')).toBe(0);
    expect(result.spans.get('zone')![0]).toBe(0);
  });

  it('two leaf children keep their depth ranks side by side, and the parent member stays', () => {
    const result = deriveRanks(input({
      members: ['p', 'x'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'a1' }, { from: 'a1', to: 'a2' }, { from: 'p', to: 'b1' }, { from: 'p', to: 'x' }],
      children: [{ group: 'za', members: ['a1', 'a2'] }, { group: 'zb', members: ['b1'] }],
    }));
    expect(result.ranks.get('x')).toBe(1);
    expect(result.spans.get('za')).toEqual([1, 2]);
    expect(result.spans.get('zb')).toEqual([1, 1]);
  });

  it('a parent member inside a leaf child\'s span keeps its rank and pushes nothing below it', () => {
    const result = deriveRanks(input({
      members: ['p', 'x', 'y'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'p', to: 'x' }, { from: 'x', to: 'y' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1, c2: 2, x: 1, y: 2 });
    expect(result.rankCount).toBe(3);
  });

  it('an overlay-only leaf child still goes after the last rank of the rest', () => {
    const result = deriveRanks(input({
      members: ['p', 'q'], linksAbove: new Set(['p']), routedLinks: [{ from: 'p', to: 'q' }],
      overlayPartners: new Map([['z1', ['p']]]), children: [{ group: 'zone', members: ['z1'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ p: 0, q: 1, z1: 2 });
    expect(result.spans.get('zone')).toEqual([2, 2]);
  });

  it('a child that feeds a sibling child keeps its position, and the sibling stands after it', () => {
    const result = deriveRanks(input({
      members: ['p'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'a1' }, { from: 'a1', to: 'a2' }, { from: 'a2', to: 'b1' }, { from: 'b1', to: 'b2' }],
      children: [{ group: 'za', members: ['a1', 'a2'] }, { group: 'zb', members: ['b1', 'b2'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ p: 0, a1: 1, a2: 2, b1: 3, b2: 4 });
    expect(result.spans.get('za')).toEqual([1, 2]);
    expect(result.spans.get('zb')).toEqual([3, 4]);
  });

  it('a child member that is a peer of a parent member is not a leaf child, so it stays in the peer\'s rank', () => {
    const result = deriveRanks(input({
      members: ['rt', 'sw1', 'x', 'y'], linksAbove: new Set(['rt']),
      routedLinks: [{ from: 'rt', to: 'sw1' }, { from: 'rt', to: 'sw2' }, { from: 'sw1', to: 'sw2' }, { from: 'sw1', to: 'x' }, { from: 'x', to: 'y' }],
      children: [{ group: 'zone', members: ['sw2'] }],
    }));
    expect(result.ranks.get('sw2')).toBe(1);
    expect(result.spans.get('zone')).toEqual([1, 1]);
  });

  it('two leaf children joined by a peer link start on the same rank', () => {
    const result = deriveRanks(input({
      members: ['p'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'a0' }, { from: 'a0', to: 'a1' }, { from: 'p', to: 'b0' }, { from: 'b0', to: 'b1' }, { from: 'a1', to: 'b1' }],
      children: [{ group: 'za', members: ['a0', 'a1'] }, { group: 'zb', members: ['b0', 'b1'] }],
    }));
    expect(result.ranks.get('a1')).toBe(result.ranks.get('b1'));
    expect(result.spans.get('za')).toEqual([1, 2]);
    expect(result.spans.get('zb')).toEqual([1, 2]);
  });

  it('a group anchored from below has no leaf rule: the last rank stays with the member that links below', () => {
    const result = deriveRanks(input({
      members: ['p', 'q', 'c1'], linksBelow: new Set(['p']), routedLinks: [{ from: 'q', to: 'p' }],
      children: [{ group: 'zone', members: ['c1'] }],
    }));
    // The old push rule holds: p stands in c1's span and goes past it, so p keeps the last rank.
    expect(asObject(result.ranks)).toEqual({ q: 0, c1: 1, p: 2 });
    expect(result.rankCount).toBe(3);
  });

  it('a leaf child alone in its group is not moved', () => {
    const result = deriveRanks(input({
      members: ['p'], linksAbove: new Set(['p']), routedLinks: [{ from: 'p', to: 'c1' }], children: [{ group: 'zone', members: ['c1'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1 });
  });
});

describe('deriveRanks: overlay-only members', () => {
  it('an overlay-only member takes the rank of its overlay partner in the group', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'c', 'o'], routedLinks: chain('a', 'b', 'c'), linksAbove: new Set(['a']),
      overlayPartners: new Map([['o', ['outside', 'b']]]),
    }));
    expect(result.ranks.get('o')).toBe(1);
    expect(result.rankCount).toBe(3);
  });

  it('an overlay-only member with no partner in the group takes the last rank', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'o', 'n'], routedLinks: chain('a', 'b'), linksAbove: new Set(['a']),
      overlayPartners: new Map([['o', ['outside']]]),
    }));
    expect(result.ranks.get('o')).toBe(1);
    expect(result.ranks.get('n')).toBe(1);
    expect(result.rankCount).toBe(2);
  });

  it('an overlay-only member never adds a rank', () => {
    const result = deriveRanks(input({ members: ['a', 'o'], linksAbove: new Set(['a']), overlayPartners: new Map([['o', ['a']]]) }));
    expect(asObject(result.ranks)).toEqual({ a: 0, o: 0 });
    expect(result.rankCount).toBe(1);
  });

  it('an anchor with no link inside the group is an anchor, not an overlay-only member', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'o'], routedLinks: chain('a', 'b'), linksAbove: new Set(['a', 'o']),
      overlayPartners: new Map([['o', ['b']]]),
    }));
    expect(result.ranks.get('o')).toBe(0);
  });

  it('an overlay-only member whose partner stands in a child span is pushed past the span', () => {
    const result = deriveRanks(input({
      members: ['p', 'c1', 'c2', 't', 'o'], routedLinks: chain('p', 'c1', 'c2', 't'), linksAbove: new Set(['p']),
      overlayPartners: new Map([['o', ['c1']]]), children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    // The child feeds t (ticket 19), so it keeps its span [1, 2] and pushes o.
    expect(result.ranks.get('o')).toBe(3);
    expect(result.rankCount).toBe(4);
  });

  it('an overlay-only child member stays in its own span', () => {
    const result = deriveRanks(input({
      members: ['p', 'c1', 'o'], routedLinks: chain('p', 'c1'), linksAbove: new Set(['p']),
      overlayPartners: new Map([['o', ['c1']]]), children: [{ group: 'zone', members: ['c1', 'o'] }],
    }));
    expect(result.ranks.get('o')).toBe(1);
    expect(result.spans.get('zone')).toEqual([1, 1]);
  });

  it('an overlay-only member takes a group that is anchored from below to the rank of its partner', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'o'], routedLinks: chain('a', 'b'), linksBelow: new Set(['b']),
      overlayPartners: new Map([['o', ['a']]]),
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, o: 0 });
  });

  it('an overlay-only child member takes the last rank before the span is set, so the span takes it in', () => {
    const result = deriveRanks(input({
      members: ['p', 'c1', 'x', 'y', 'o', 't'],
      routedLinks: [{ from: 'p', to: 'c1' }, { from: 'p', to: 'x' }, { from: 'x', to: 'y' }, { from: 'c1', to: 't' }],
      linksAbove: new Set(['p']), children: [{ group: 'zone', members: ['c1', 'o'] }],
    }));
    // c1 feeds t (ticket 19), so the child is not a leaf child and keeps its span.
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1, x: 3, y: 4, o: 2, t: 3 });
    expect(result.spans.get('zone')).toEqual([1, 2]);
  });
});

// ADR-0026: a group with anchors on both sides has two poles.
describe('deriveRanks: two poles', () => {
  const both = (over: Partial<RankInput> & Pick<RankInput, 'members'>) =>
    deriveRanks(input({ linksAbove: new Set(['u']), linksBelow: new Set(['d']), ...over }));

  it('a leaf of the downward anchor stands above it, so nothing stands between the anchor and the tier below', () => {
    const result = both({ members: ['u', 'm', 'd', 'leaf'], routedLinks: [...chain('u', 'm', 'd'), { from: 'd', to: 'leaf' }] });
    expect(asObject(result.ranks)).toEqual({ u: 0, m: 1, d: 2, leaf: 1 });
    expect(result.rankCount).toBe(3);
    expect(result.anchoredFrom).toBe('above');
  });

  it('the downward anchors take the last rank, the routed distance between the poles', () => {
    const result = both({ members: ['u', 'a', 'b', 'd'], routedLinks: chain('u', 'a', 'b', 'd') });
    expect(asObject(result.ranks)).toEqual({ u: 0, a: 1, b: 2, d: 3 });
  });

  it('a member between the poles takes the rank its nearer pole gives it', () => {
    // u - a - b - c - d, L = 4. x hangs from a (du 2, dd 4); y hangs from c (du 4, dd 2).
    const result = both({
      members: ['u', 'a', 'b', 'c', 'd', 'x', 'y'],
      routedLinks: [...chain('u', 'a', 'b', 'c', 'd'), { from: 'a', to: 'x' }, { from: 'c', to: 'y' }],
    });
    expect(asObject(result.ranks)).toEqual({ u: 0, a: 1, b: 2, c: 3, d: 4, x: 2, y: 2 });
  });

  it('a tie takes the upper of the two results, min(du, L - dd)', () => {
    // t hangs from b: three links from each pole, L = 4. From the upper pole it is rank 3, from the lower pole rank 1: it takes 1.
    const result = both({
      members: ['u', 'a', 'b', 'c', 'd', 't'],
      routedLinks: [...chain('u', 'a', 'b', 'c', 'd'), { from: 'b', to: 't' }],
    });
    expect(result.ranks.get('t')).toBe(1);
  });

  it('a member two links from each pole, with one rank between them, stands beside the upward anchors; one link from each stays between', () => {
    // u - p - d (L = 2). e links only to p and q: du = dd = 2, so min(2, 0) = 0. p is one link from each pole: rank 1.
    const result = both({
      members: ['u', 'p', 'q', 'e', 'd'],
      routedLinks: [...chain('u', 'p', 'd'), { from: 'd', to: 'q' }, { from: 'p', to: 'e' }, { from: 'q', to: 'e' }],
    });
    expect(asObject(result.ranks)).toEqual({ u: 0, p: 1, q: 1, e: 0, d: 2 });
    expect(result.rankCount).toBe(3);
  });

  it('no rank lies outside 0..L: with the poles side by side (L = 1) a member counts from its nearer pole and is held to the two ranks', () => {
    const result = both({
      members: ['u', 'd', 'near-u', 'near-d', 'tie'],
      routedLinks: [...chain('u', 'd'), { from: 'u', to: 'near-u' }, { from: 'd', to: 'near-d' }, { from: 'near-u', to: 'tie' }, { from: 'near-d', to: 'tie' }],
    });
    expect(asObject(result.ranks)).toEqual({ u: 0, d: 1, 'near-u': 1, 'near-d': 0, tie: 0 });
    expect(result.rankCount).toBe(2);
  });

  it('a member that links both ways takes the first rank, and its leaf stands beside it', () => {
    const result = deriveRanks(input({
      members: ['gate', 'leaf', 'mid', 'd'], linksAbove: new Set(['gate']), linksBelow: new Set(['gate', 'd']),
      routedLinks: [...chain('gate', 'mid', 'd'), { from: 'gate', to: 'leaf' }],
    }));
    expect(asObject(result.ranks)).toEqual({ gate: 0, leaf: 0, mid: 1, d: 2 });
  });

  it('with no downward anchor but a member that links both ways, the depth stands and that member keeps its leaf beside it', () => {
    const result = deriveRanks(input({
      members: ['gate', 'leaf', 'm1', 'm2'], linksAbove: new Set(['gate']), linksBelow: new Set(['gate']),
      routedLinks: [...chain('gate', 'm1', 'm2', 'gate'), { from: 'gate', to: 'leaf' }],
    }));
    expect(asObject(result.ranks)).toEqual({ gate: 0, leaf: 0, m1: 1, m2: 1 });
  });

  it('a leaf chain of a both-way member stands beside it however long the chain', () => {
    const result = deriveRanks(input({
      members: ['gate', 'l1', 'l2', 'l3', 'mid', 'd'], linksAbove: new Set(['gate']), linksBelow: new Set(['gate', 'd']),
      routedLinks: [...chain('gate', 'mid', 'd'), ...chain('gate', 'l1', 'l2', 'l3')],
    }));
    expect(asObject(result.ranks)).toEqual({ gate: 0, l1: 0, l2: 0, l3: 0, mid: 1, d: 2 });
  });

  it('a leaf chain longer than the distance between the poles stands on one rank, joined by peer links', () => {
    // L = 2. The chain from the downward anchor counts L - dd and stops at rank 0; the chain from the upward anchor counts du and stops at rank 2.
    const result = both({
      members: ['u', 'm', 'd', 'c1', 'c2', 'c3', 'c4', 'e1', 'e2', 'e3'],
      routedLinks: [...chain('u', 'm', 'd'), ...chain('d', 'c1', 'c2', 'c3', 'c4'), ...chain('u', 'e1', 'e2', 'e3')],
    });
    expect(asObject(result.ranks)).toEqual({ u: 0, m: 1, d: 2, c1: 1, c2: 0, c3: 0, c4: 0, e1: 1, e2: 2, e3: 2 });
    expect(result.rankCount).toBe(3);
  });

  it('a group with an upward anchor only keeps the depth ranks, a leaf below its member', () => {
    const result = deriveRanks(input({
      members: ['u', 'm', 'leaf'], linksAbove: new Set(['u']), routedLinks: [...chain('u', 'm'), { from: 'm', to: 'leaf' }],
    }));
    expect(asObject(result.ranks)).toEqual({ u: 0, m: 1, leaf: 2 });
  });

  it('a group with a downward anchor only keeps the ranks counted up from it', () => {
    const result = deriveRanks(input({
      members: ['d', 'm', 'leaf'], linksBelow: new Set(['d']), routedLinks: [...chain('d', 'm'), { from: 'm', to: 'leaf' }],
    }));
    expect(asObject(result.ranks)).toEqual({ d: 2, m: 1, leaf: 0 });
    expect(result.anchoredFrom).toBe('below');
  });

  it('poles that no routed link joins keep the depth ranks: the downward anchors and the unreached members take the last rank, step 6', () => {
    const result = both({ members: ['u', 'a', 'd', 'b', 'o'], routedLinks: [...chain('u', 'a'), ...chain('d', 'b')] });
    expect(asObject(result.ranks)).toEqual({ u: 0, a: 1, d: 1, b: 1, o: 1 });
  });

  it('a peer component that holds both poles keeps the depth ranks', () => {
    const result = both({
      members: ['u', 'd', 'x'],
      routedLinks: [{ from: 'u', to: 'd', fromSide: 'right', toSide: 'left' }, { from: 'd', to: 'x' }],
    });
    expect(asObject(result.ranks)).toEqual({ u: 0, d: 0, x: 1 });
  });
});
