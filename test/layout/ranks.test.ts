import { describe, expect, it } from 'vitest';
import { deriveRanks, type RankInput } from '../../src/layout/ranks.js';

const chain = (...ids: string[]) => ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id }));
const input = (over: Partial<RankInput> & Pick<RankInput, 'members'>): RankInput => ({
  group: 'g', routedLinks: [], linksAbove: new Set(), linksBelow: new Set(), overlayPartners: new Map(),
  classRank: () => undefined, children: [], ...over,
});
const table = (values: Record<string, number>) => (node: string) => values[node.replace(/\d+$/, '')];
const asObject = (ranks: Map<string, number>) => Object.fromEntries(ranks);

describe('deriveRanks: layering', () => {
  it('a plain chain takes one rank per link, from the member that links to the tier above', () => {
    const result = deriveRanks(input({ members: ['a', 'b', 'c'], routedLinks: chain('a', 'b', 'c'), linksAbove: new Set(['a']) }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, c: 2 });
    expect(result.rankCount).toBe(3);
    expect(result.anchoredFrom).toBe('above');
    expect(result.spans.size).toBe(0);
  });

  it('a peer pair under one uplink shares one rank when the two class ranks are equal', () => {
    const result = deriveRanks(input({
      members: ['rt', 'sw1', 'sw2'], linksAbove: new Set(['rt']), classRank: table({ rt: 1, sw: 2 }),
      routedLinks: [{ from: 'rt', to: 'sw1' }, { from: 'rt', to: 'sw2' }, { from: 'sw1', to: 'sw2' }],
    }));
    expect(asObject(result.ranks)).toEqual({ rt: 0, sw1: 1, sw2: 1 });
    expect(result.rankCount).toBe(2);
  });

  it('a peer link never lengthens a path', () => {
    const result = deriveRanks(input({
      members: ['rt1', 'rt2', 'sw'], linksAbove: new Set(['rt1']), classRank: table({ rt: 1, sw: 2 }),
      routedLinks: [{ from: 'rt1', to: 'rt2' }, { from: 'rt2', to: 'sw' }],
    }));
    expect(asObject(result.ranks)).toEqual({ rt1: 0, rt2: 0, sw: 1 });
  });

  it('a cycle sw-sw-rt-rt layers as two peer pairs', () => {
    const result = deriveRanks(input({
      members: ['rt1', 'rt2', 'sw1', 'sw2'], linksAbove: new Set(['rt1']), classRank: table({ rt: 1, sw: 2 }),
      routedLinks: [{ from: 'rt1', to: 'rt2' }, { from: 'rt2', to: 'sw1' }, { from: 'sw1', to: 'sw2' }, { from: 'sw2', to: 'rt1' }],
    }));
    expect(asObject(result.ranks)).toEqual({ rt1: 0, rt2: 0, sw1: 1, sw2: 1 });
  });

  it('a back link of a cycle is a peer link for the layering', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'c'], linksAbove: new Set(['a']),
      routedLinks: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, c: 1 });
    expect(result.rankCount).toBe(2);
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

  it('a member cut off from every anchor takes an anchor of its own', () => {
    const result = deriveRanks(input({
      members: ['a', 'b', 'x', 'y'], linksAbove: new Set(['a']), routedLinks: [{ from: 'a', to: 'b' }, { from: 'x', to: 'y' }],
    }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1, x: 0, y: 1 });
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

  it('with no anchor either way, the member with the most links in the group is rank 0', () => {
    const result = deriveRanks(input({
      members: ['leaf1', 'hub', 'leaf2', 'leaf3'],
      routedLinks: [{ from: 'leaf1', to: 'hub' }, { from: 'hub', to: 'leaf2' }, { from: 'hub', to: 'leaf3' }],
    }));
    expect(asObject(result.ranks)).toEqual({ leaf1: 1, hub: 0, leaf2: 1, leaf3: 1 });
    expect(result.anchoredFrom).toBe('none');
  });

  it('a tie for most links goes to the earlier member', () => {
    const result = deriveRanks(input({ members: ['a', 'b'], routedLinks: chain('a', 'b') }));
    expect(asObject(result.ranks)).toEqual({ a: 0, b: 1 });
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
      members: ['p', 'c1', 'c2', 'x'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'p', to: 'x' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1, c2: 2, x: 3 });
    expect(result.spans.get('zone')).toEqual([1, 2]);
    expect(result.rankCount).toBe(4);
  });

  it('a pushed parent member pushes what hangs below it', () => {
    const result = deriveRanks(input({
      members: ['p', 'c1', 'c2', 'x', 'y'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'p', to: 'x' }, { from: 'x', to: 'y' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1, c2: 2, x: 3, y: 4 });
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
      members: ['p', 'c1', 'c2', 'x1', 'x2'], linksAbove: new Set(['p']), classRank: table({ x: 3 }),
      routedLinks: [{ from: 'p', to: 'c1' }, { from: 'c1', to: 'c2' }, { from: 'p', to: 'x1' }, { from: 'x1', to: 'x2' }],
      children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
    expect(result.ranks.get('x1')).toBe(3);
    expect(result.ranks.get('x2')).toBe(3);
  });

  it('two children may share ranks, and a parent member is pushed past both spans', () => {
    const result = deriveRanks(input({
      members: ['p', 'a1', 'a2', 'b1', 'x'], linksAbove: new Set(['p']),
      routedLinks: [{ from: 'p', to: 'a1' }, { from: 'a1', to: 'a2' }, { from: 'p', to: 'b1' }, { from: 'p', to: 'x' }],
      children: [{ group: 'za', members: ['a1', 'a2'] }, { group: 'zb', members: ['b1'] }],
    }));
    expect(result.spans.get('za')).toEqual([1, 2]);
    expect(result.spans.get('zb')).toEqual([1, 1]);
    expect(result.ranks.get('x')).toBe(3);
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
      members: ['p', 'c1', 'c2', 'o'], routedLinks: chain('p', 'c1', 'c2'), linksAbove: new Set(['p']),
      overlayPartners: new Map([['o', ['c1']]]), children: [{ group: 'zone', members: ['c1', 'c2'] }],
    }));
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

  it('an overlay-only child member takes the last rank after the first push, and the span clears again below it', () => {
    const result = deriveRanks(input({
      members: ['p', 'c1', 'x', 'y', 'o'], routedLinks: [{ from: 'p', to: 'c1' }, { from: 'p', to: 'x' }, { from: 'x', to: 'y' }],
      linksAbove: new Set(['p']), children: [{ group: 'zone', members: ['c1', 'o'] }],
    }));
    expect(asObject(result.ranks)).toEqual({ p: 0, c1: 1, x: 4, y: 5, o: 3 });
    expect(result.spans.get('zone')).toEqual([1, 3]);
  });
});
