import { describe, expect, it } from 'vitest';
import { parse } from '../../src/index.js';
import { resolve } from '../../src/internal.js';
import { chainSides, groupExits, seatUnits, stackChains, type GridUnit } from '../../src/layout/grid-chains.js';

/** A tier-1 grid `farm`, a core above and a rail below, the given nodes and links. */
const model = (nodes: string, links: string[]) => resolve(parse(`
portograph: 2
profile: network
groups:
  top: { tier: 0 }
  farm: { tier: 1, shape: grid }
  low: { tier: 2 }
nodes:
  core: { group: top }
  rail: { group: low }
${nodes}
links:
${links.map(link => `  - ${link}`).join('\n')}
`));
const n = (names: string[]) => names.map(name => `  ${name}: { group: farm }`).join('\n');
const plain = n(['a', 'b', 'c', 'd', 'e']);
const ids = (result: ReturnType<typeof stackChains>) => 'chains' in result ? result.chains.map(chain => chain.nodes.join('')) : result.decline;

describe('stackChains', () => {
  it('a group with no enclosed bundle has no chain', () => {
    expect(stackChains(model(plain, ['[core, a]']), 'farm')).toEqual({ chains: [] });
  });

  it('a pair of bundles between two nodes is one edge, and a case-10 pair is a chain of two', () => {
    expect(ids(stackChains(model(plain, ['[a, b]', '[a, b]', '[core, c]']), 'farm'))).toEqual(['ab']);
  });

  it('two bundles that share a node are a chain of three', () => {
    expect(ids(stackChains(model(plain, ['[a, b]', '[a, b]', '[b, c]', '[b, c]']), 'farm'))).toEqual(['abc']);
  });

  it('reports each reason, and the first of the order', () => {
    expect(ids(stackChains(model(plain, ['[a, b]', '[a, b]', '[a, c]', '[a, c]', '[a, d]', '[a, d]']), 'farm'))).toBe('branch');
    expect(ids(stackChains(model(plain, ['[a, b]', '[a, b]', '[b, c]', '[b, c]', '[c, a]', '[c, a]']), 'farm'))).toBe('cycle');
    // Both ends leave upward.
    expect(ids(stackChains(model(plain, ['[core, a]', '[core, b]', '[a, b]', '[a, b]']), 'farm'))).toBe('exits');
    // An interior node leaves downward.
    expect(ids(stackChains(model(plain, ['[a, b]', '[a, b]', '[b, c]', '[b, c]', '[b, rail]']), 'farm'))).toBe('exits');
    // A node that leaves both ways forces one row, and a chain needs two.
    expect(ids(stackChains(model(plain, ['[core, c]', '[c, rail]', '[a, b]', '[a, b]']), 'farm'))).toBe('rows');
    // A lateral member port.
    const lateral = n(['b', 'c', 'd', 'e']) + '\n  a: { group: farm, ports: [{ name: p, side: right }] }';
    expect(ids(stackChains(model(lateral, ['[a.p, b]', '[a.p, b]']), 'farm'))).toBe('authored-side');
    // Both ends of one bundle authored top.
    const both = n(['c']) + '\n  a: { group: farm, ports: [{ name: p, side: top }] }\n  b: { group: farm, ports: [{ name: p, side: top }] }';
    expect(ids(stackChains(model(both, ['[a.p, b.p]', '[a.p, b.p]']), 'farm'))).toBe('authored-side');
    // The order: authored-side is reported before a cycle and exits elsewhere in the group.
    const mixed = model(lateral, ['[a.p, b]', '[a.p, b]', '[core, c]', '[core, d]', '[c, d]', '[c, d]']);
    expect(ids(stackChains(mixed, 'farm'))).toBe('authored-side');
  });
});

describe('review findings', () => {
  const ports = (extra: string) => `  a: { group: farm, ports: [{ name: p }, { name: q }${extra}] }\n  b: { group: farm, ports: [{ name: p }, { name: q }] }\n  c: { group: farm }`;

  it('declines a member port that also carries a link outside the chain bundles (shared-port)', () => {
    expect(ids(stackChains(model(ports(''), ['[b.p, a.p]', '[b.p, a.p]', '[core, a.p]']), 'farm'))).toBe('shared-port');
    // The same port on a link inside the bundle only is fine.
    expect(ids(stackChains(model(ports(''), ['[b.p, a.p]', '[b.p, a.p]', '[core, a.q]']), 'farm'))).toEqual(['ab']);
  });

  it('carries every parallel bundle of a pair: all sides, and a conflict between them declines', () => {
    const pair = (q: string, r: string) => `  a: { group: farm, ports: [{ name: p, side: bottom }, { name: q${q} }] }\n  b: { group: farm, ports: [{ name: p, side: top }, { name: q${r} }] }`;
    const links = ['[a.p, b.p]', '[a.p, b.p]', '[a.q, b.q]', '[a.q, b.q]'];
    // The authored sides split the pair into two bundles; the second has sides of its own and none of them is lost.
    const both = model(pair('', ''), links);
    const found = stackChains(both, 'farm');
    expect('chains' in found && found.chains[0]!.edges).toEqual([['bundle-1', 'bundle-2']]);
    expect('chains' in found && chainSides(both, found.chains).map(item => `${item.ref.node}.${item.ref.name}:${item.side}`).sort())
      .toEqual(['a.p:bottom', 'a.p:bottom', 'a.q:bottom', 'a.q:bottom', 'b.p:top', 'b.p:top', 'b.q:top', 'b.q:top']);
    expect(ids(stackChains(model(pair(', side: top', ', side: bottom'), links), 'farm'))).toBe('authored-side');
  });
});

describe('orientation', () => {
  it('an authored side fixes the upper end: bottom is on top', () => {
    const nodes = '  a: { group: farm, ports: [{ name: p, side: top }] }\n  b: { group: farm, ports: [{ name: p, side: bottom }] }';
    expect(ids(stackChains(model(nodes, ['[a.p, b.p]', '[a.p, b.p]']), 'farm'))).toEqual(['ba']);
  });

  it('the exits come before the written direction: the end that leaves upward is on top', () => {
    // Written lower to upper (`from` is b), but `a` leaves upward.
    expect(ids(stackChains(model(plain, ['[core, a]', '[b, a]', '[b, a]']), 'farm'))).toEqual(['ab']);
    // `b` leaves downward, so it is at the bottom although it is written first.
    expect(ids(stackChains(model(plain, ['[b, rail]', '[b, a]', '[b, a]']), 'farm'))).toEqual(['ab']);
  });

  it('with no exit and no authored side the from end of the first member is on top', () => {
    expect(ids(stackChains(model(plain, ['[a, b]', '[a, b]']), 'farm'))).toEqual(['ab']);
    expect(ids(stackChains(model(plain, ['[b, a]', '[b, a]']), 'farm'))).toEqual(['ba']);
  });

  it('reads the group exits from the document', () => {
    const found = groupExits(model(plain, ['[core, a]', '[b, rail]']), 'farm');
    expect([...found.up]).toEqual(['a']);
    expect([...found.down]).toEqual(['b']);
  });
});

describe('seatUnits', () => {
  const one = (id: string, up = false, down = false): GridUnit => ({ nodes: [id], up, down });
  const chain = (nodes: string[], up = false, down = false): GridUnit => ({ nodes, up, down });

  it('seats a chain of two in one column and consecutive rows, beside nodes that leave upward (case 10)', () => {
    const units = [one('s1', true), one('s4', true), chain(['s2', 's3']), one('s5'), one('s6')];
    expect(seatUnits(units, 3)).toEqual([['s1', 's4', 's2'], ['s5', 's6', 's3']]);
    // Two columns leave no column for the chain: the upward exits fill them.
    expect(seatUnits(units, 2)).toBeUndefined();
  });

  it('a count with too few rows is dropped', () => {
    expect(seatUnits([chain(['a', 'b', 'c']), one('d')], 4)).toBeUndefined();
    expect(seatUnits([chain(['a', 'b', 'c']), one('d')], 2)).toEqual([['a', 'd'], ['b', undefined], ['c', undefined]]);
  });

  it('a chain that leaves both ways takes exactly its own height', () => {
    const units = [chain(['a', 'b'], true, true), one('c'), one('d'), one('e')];
    expect(seatUnits(units, 2)).toBeUndefined();
    expect(seatUnits(units, 3)).toEqual([['a', 'c', 'd'], ['b', 'e', undefined]]);
    expect(seatUnits([...units, one('f'), one('g'), one('h')], 3)).toBeUndefined();
  });

  it('the rest of a chain column holds only nodes that leave neither way', () => {
    expect(seatUnits([chain(['a', 'b']), one('c', false, true), one('d', true), one('e'), one('f')], 3))
      .toEqual([['d', 'a', 'e'], ['c', 'b', 'f']]);
  });

  it('seats a flank peer at the outer end of its own row, but never into a chain column', () => {
    const units = [chain(['x', 'y']), one('p'), one('q'), one('r')];
    expect(seatUnits(units, 3, new Map([['p', 'right' as const]]))).toEqual([['x', 'q', 'p'], ['y', 'r', undefined]]);
    expect(seatUnits(units, 3, new Map([['p', 'left' as const]]))).toEqual([['x', 'p', 'q'], ['y', 'r', undefined]]);
    // The left end is the chain column: the peer stays put.
    expect(seatUnits(units, 3, new Map([['q', 'left' as const]]))).toEqual([['x', 'p', 'q'], ['y', 'r', undefined]]);
  });
});
