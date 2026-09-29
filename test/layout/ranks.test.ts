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
