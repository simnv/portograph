import { describe, expect, it } from 'vitest';
import { differences, firstDifference, reversed } from '../../scripts/r3-lib.mjs';

describe('reversed', () => {
  const sheet = ['portograph: 2', 'nodes:', '  a: { group: g }', '  b: { group: g }', '  c: { group: g }', 'links:', '  - [a, b]', '  - [b, c]', '  - [c, a]', ''].join('\n');

  it('reverses the entries of one block and leaves the rest', () => {
    expect(reversed(sheet, 'links')).toBe(['portograph: 2', 'nodes:', '  a: { group: g }', '  b: { group: g }', '  c: { group: g }', 'links:', '  - [c, a]', '  - [b, c]', '  - [a, b]', ''].join('\n'));
    expect(reversed(sheet, 'nodes')).toContain('  c: { group: g }\n  b: { group: g }\n  a: { group: g }\nlinks:');
  });

  it('moves a record that spans lines whole; a comment line goes with the entry above it', () => {
    const text = 'nodes:\n  a:\n    group: g\n    label: A # first\n  # after a\n  b:\n    group: g\nlinks: []\n';
    expect(reversed(text, 'nodes')).toBe('nodes:\n  b:\n    group: g\n  a:\n    group: g\n    label: A # first\n  # after a\nlinks: []\n');
  });

  it('reads a block whose items stand at column 0 and keeps what follows the block', () => {
    expect(reversed('links:\n- [a, b]\n- [b, c]\n\n# end\nlegend: x\n', 'links')).toBe('links:\n- [b, c]\n- [a, b]\n\n# end\nlegend: x\n');
  });

  it('keeps the comments before the first entry in place', () => {
    expect(reversed('links:\n  # the flows\n  - [a, b]\n  - [b, c]\n', 'links')).toBe('links:\n  # the flows\n  - [b, c]\n  - [a, b]\n');
  });

  it('refuses a reversal that would change nothing', () => {
    expect(() => reversed('nodes:\n  a: {}\n', 'nodes')).toThrow(/fewer than two entries/);
    expect(() => reversed('nodes:\n  a: {}\n', 'links')).toThrow(/no top-level `links:` block/);
    expect(() => reversed('links: [[a, b], [b, c]]\n', 'links')).toThrow(/no top-level/);
    expect(() => reversed('links:\nnodes:\n', 'links')).toThrow(/no entry/);
  });
});

describe('firstDifference', () => {
  it('is undefined for equal values and float noise', () => {
    expect(firstDifference({ a: [1, { b: 'x' }], c: 23.372072312499995 }, { a: [1, { b: 'x' }], c: 23.372072312500002 })).toBeUndefined();
  });

  it('names the first differing path in document order', () => {
    expect(firstDifference({ nodes: { a: { x: 1, y: 2 } }, z: 1 }, { nodes: { a: { x: 1, y: 3 } }, z: 2 })).toBe('$.nodes.a.y: 2 != 3');
    expect(firstDifference({ list: [1, 2, 3] }, { list: [1, 5, 3] })).toBe('$.list[1]: 2 != 5');
    expect(firstDifference({ list: [1, 2] }, { list: [1, 2, 3] })).toBe('$.list: length 2 != 3');
    expect(firstDifference({ a: 1 }, { a: 1, b: 2 })).toBe('$.b: absent != present');
    expect(firstDifference({ a: [] }, { a: {} })).toBe('$.a: [] != {}');
  });

  it('compares a list whose elements all have a unique id or node name as a set', () => {
    const labels = [{ id: 'l1', x: 1 }, { id: 'l2', x: 2 }];
    expect(firstDifference({ labels }, { labels: [...labels].reverse() })).toBeUndefined();
    expect(firstDifference({ labels }, { labels: [{ id: 'l2', x: 2 }, { id: 'l1', x: 9 }] })).toBe('$.labels[id l1].x: 1 != 9');
    expect(firstDifference({ labels }, { labels: [labels[0]] })).toBe('$.labels[id l2]: present != absent');
    const topology = [{ node: 'a', n: 1 }, { node: 'b', n: 2 }];
    expect(firstDifference({ topology }, { topology: [...topology].reverse() })).toBeUndefined();
  });

  it('keeps a list order when the names repeat or are missing', () => {
    expect(firstDifference({ s: [{ id: 'p' }, { id: 'p' }, { id: 'q' }] }, { s: [{ id: 'q' }, { id: 'p' }, { id: 'p' }] })).toBe('$.s[0].id: "p" != "q"');
    expect(firstDifference({ s: [{ x: 1 }, { x: 2 }] }, { s: [{ x: 2 }, { x: 1 }] })).toBe('$.s[0].x: 1 != 2');
  });

  it('lists every difference', () => {
    expect([...differences({ a: 1, b: 2 }, { a: 2, b: 3 })]).toEqual(['$.a: 1 != 2', '$.b: 2 != 3']);
  });
});
