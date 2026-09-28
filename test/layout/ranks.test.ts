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
