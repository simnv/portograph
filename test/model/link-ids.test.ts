import { describe, expect, it } from 'vitest';
import type { Endpoint, NormalisedLink } from '../../src/model/index.js';
import { endpointId, linkIds } from '../../src/model/link-ids.js';
import { parse } from '../../src/parse/index.js';

const named = (node: string, name: string, ordinal = 1): Endpoint => ({ node, name, ordinal });
const anonymous = (node: string, ordinal = 1): Endpoint => ({ node, anonymous: true, ordinal });
const link = (from: Endpoint, to: Endpoint, id?: string): NormalisedLink => ({ ...(id === undefined ? {} : { id }), from, to });

describe('endpointId', () => {
  it('names a named port node:port', () => expect(endpointId(named('a', 'p'))).toBe('a:p'));
  it('adds #n for the n-th port of one name when n is above 1', () => {
    expect(endpointId(named('a', 'p', 2))).toBe('a:p#2');
    expect(endpointId(named('a', 'p', 3))).toBe('a:p#3');
  });
  it('names an anonymous port by its node and leaves out the ordinal', () => {
    expect(endpointId(anonymous('a'))).toBe('a');
    expect(endpointId(anonymous('a', 2))).toBe('a');
  });
  it('names a group end by the group id', () => expect(endpointId({ group: 'edge' })).toBe('edge'));
});

describe('linkIds', () => {
  it('derives <from>-><to> from the two ends', () => {
    expect(linkIds({ links: [link(named('a', 'p'), named('b', 'q')), link(anonymous('a'), { group: 'g' })] }))
      .toEqual(['a:p->b:q', 'a->g']);
  });

  it('lets an explicit id win', () => {
    expect(linkIds({ links: [link(named('a', 'p'), named('b', 'q'), 'uplink')] })).toEqual(['uplink']);
  });

  it('moves a derived id that equals an explicit id to @2, wherever the explicit link stands', () => {
    const derived = link(named('a', 'p'), named('b', 'q'));
    const explicit = link(named('c', 'p'), named('d', 'q'), 'a:p->b:q');
    expect(linkIds({ links: [derived, explicit] })).toEqual(['a:p->b:q@2', 'a:p->b:q']);
    expect(linkIds({ links: [explicit, derived] })).toEqual(['a:p->b:q', 'a:p->b:q@2']);
  });

  it('gives parallel anonymous links the base, @2 and @3 in document order', () => {
    const parallel = (): NormalisedLink => link(anonymous('a'), anonymous('b'));
    expect(linkIds({ links: [parallel(), parallel(), parallel()] })).toEqual(['a->b', 'a->b@2', 'a->b@3']);
  });

  it('skips a suffix that an explicit id already holds', () => {
    const parallel = (): NormalisedLink => link(anonymous('a'), anonymous('b'));
    expect(linkIds({ links: [parallel(), parallel(), link(anonymous('c'), anonymous('d'), 'a->b@2')] }))
      .toEqual(['a->b', 'a->b@3', 'a->b@2']);
  });

  it('treats the reverse direction as another link', () => {
    expect(linkIds({ links: [link(anonymous('a'), anonymous('b')), link(anonymous('b'), anonymous('a'))] }))
      .toEqual(['a->b', 'b->a']);
  });

  describe('YAML order', () => {
    const yaml = (links: string[]): string => `portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes:
  a: {group: g, ports: [p, q]}
  b: {group: h, ports: [p, q]}
  c: {group: h, ports: [p]}
links:
${links.map(item => `  - ${item}`).join('\n')}
`;
    const byEnds = (text: string): Map<string, string> => {
      const document = parse(text);
      const ids = linkIds(document);
      return new Map(document.links.map((item, index) => [`${endpointId(item.from)}>${endpointId(item.to)}`, ids[index]!]));
    };

    it('keeps the id of two non-parallel links when their order is swapped', () => {
      const one = byEnds(yaml(['[a.p, b.p]', '[a.q, c.p]']));
      const two = byEnds(yaml(['[a.q, c.p]', '[a.p, b.p]']));
      expect(one).toEqual(two);
      expect(one.get('a:p>b:p')).toBe('a:p->b:p');
      expect(one.get('a:q>c:p')).toBe('a:q->c:p');
    });

    it('keeps the id of a link that stands before a parallel pair when the pair moves', () => {
      const one = byEnds(yaml(['[a.p, b.p]', '[a.q, c.p]', '[a.q, c.p]']));
      const two = byEnds(yaml(['[a.q, c.p]', '[a.q, c.p]', '[a.p, b.p]']));
      expect(one.get('a:p>b:p')).toBe(two.get('a:p>b:p'));
    });
  });

  it('keeps links apart whose node ids hold hyphens, in either order', () => {
    // `a` to `b--c` and `a--b` to `c` would both read `a--b--c` with a hyphen separator.
    const one = link(anonymous('a'), anonymous('b--c')), two = link(anonymous('a--b'), anonymous('c'));
    expect(linkIds({ links: [one, two] })).toEqual(['a->b--c', 'a--b->c']);
    expect(linkIds({ links: [two, one] })).toEqual(['a--b->c', 'a->b--c']);
  });
});
