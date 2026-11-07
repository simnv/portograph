import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MEMBER_ORDER, checkSheet, differences, firstDifference, reversed } from '../../scripts/r3-lib.mjs';

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

describe('reversed: flow style, comments on the key line, anchors', () => {
  // The file of the solid-blocks sheet: nodes as a block, links as one flow list.
  const flow = 'nodes:\n  a: { group: g }\n  b: { group: g }\nlinks: [[a, c], [a, d], [b, c]]\n';

  it('reverses a flow list through the document: the same entries in the other order, the rest unchanged', () => {
    const out = parse(reversed(flow, 'links'));
    expect(out.links).toEqual([['b', 'c'], ['a', 'd'], ['a', 'c']]);
    expect(out.nodes).toEqual(parse(flow).nodes);
  });

  it('reverses a flow map and a list with a trailing comment on the key line', () => {
    expect(Object.keys(parse(reversed('nodes: { a: { group: g }, b: { group: g } }\nlinks: []\n', 'nodes')).nodes)).toEqual(['b', 'a']);
    expect(reversed('links:  # the flows\n  - [a, b]\n  - [b, c]\n', 'links')).toBe('links:  # the flows\n  - [b, c]\n  - [a, b]\n');
  });

  it('refuses a flow list with fewer than two entries for the true reason', () => {
    expect(() => reversed('links: [[a, b]]\n', 'links')).toThrow(/fewer than two entries/);
    expect(() => reversed('links: 3\n', 'links')).toThrow(/not a list or a map/);
  });

  it('skips a block whose reversal puts an alias before its anchor, with a named reason', () => {
    expect(() => reversed('nodes:\n  a: &box { tier: 1 }\n  b: *box\n', 'nodes')).toThrow(/alias before its anchor/);
    expect(() => reversed('links: [&l [a, b], *l]\n', 'links')).toThrow(/alias before its anchor/);
  });

  it('reverses a block whose alias stands outside it, or whose anchor is set before it', () => {
    const out = parse(reversed('base: &box { tier: 1 }\nnodes:\n  a: *box\n  b: *box\n', 'nodes'));
    expect(Object.keys(out.nodes)).toEqual(['b', 'a']);
  });
});

describe('firstDifference with the allowed group member order', () => {
  const left = { groups: { g: { nodes: ['a', 'b'], rowOrder: ['a', 'b'], rowOrderDecision: { before: ['a', 'b'] }, bounds: { x: 1 } } }, nodes: { a: { x: 1 } } };

  it('looks past groups.*.nodes, rowOrder and rowOrderDecision to a real difference', () => {
    const right = { groups: { g: { nodes: ['b', 'a'], rowOrder: ['b', 'a'], rowOrderDecision: { before: ['b', 'a'] }, bounds: { x: 1 } } }, nodes: { a: { x: 7 } } };
    expect(firstDifference(left, right)).toBe('$.groups.g.nodes[0]: "a" != "b"');
    expect(firstDifference(left, right, MEMBER_ORDER)).toBe('$.nodes.a.x: 1 != 7');
  });

  it('is undefined when the member order is the only difference, and still reports a change of a group bound', () => {
    const mirrored = { ...left, groups: { g: { ...left.groups.g, nodes: ['b', 'a'], rowOrder: ['b', 'a'] } } };
    expect(firstDifference(left, mirrored, MEMBER_ORDER)).toBeUndefined();
    expect(firstDifference(left, { ...left, groups: { g: { ...mirrored.groups.g, bounds: { x: 2 } } } }, MEMBER_ORDER)).toBe('$.groups.g.bounds.x: 1 != 2');
  });
});

describe('checkSheet', () => {
  const sheet = 'nodes:\n  a: {}\n  b: {}\nlinks:\n  - [a, b]\n  - [b, a]\n';
  const describe_ = (error: unknown): string => `ERROR ${(error as Error).message}`;

  it('reports a sheet that cannot be read as one written line, so the run goes on', async () => {
    const read = (): string => { throw new Error('ENOENT: no such file'); };
    expect(await checkSheet({ read, lay: async () => ({}), describe: describe_ })).toEqual({ lines: [['written', 'ERROR ENOENT: no such file']], bad: 1 });
    expect(await checkSheet({ read: () => sheet, lay: async () => ({}), describe: describe_ })).toEqual({ lines: [['links', 'SAME'], ['nodes', 'SAME']], bad: 0 });
  });

  it('prints the first differing path of the links reversal, and SAME with a note for the member order alone', async () => {
    // A layout that follows the order of the links, and lists the group members in node order.
    const lay = async (text: string) => ({ links: text.indexOf('[b, a]') < text.indexOf('[a, b]') ? 1 : 0, groups: { g: { nodes: text.indexOf('b: {}') < text.indexOf('a: {}') ? ['b', 'a'] : ['a', 'b'] } } });
    const result = await checkSheet({ read: () => sheet, lay, describe: describe_ });
    expect(result.lines).toEqual([['links', '$.links: 0 != 1'], ['nodes', 'SAME (group member order only)']]);
    expect(result.bad).toBe(1);
  });

  it('skips a reversal that cannot be made, with its reason, and counts a failed layout', async () => {
    expect((await checkSheet({ read: () => 'nodes:\n  a: {}\nlinks:\n  - [a, a]\n', lay: async () => ({}), describe: describe_ })).lines.map(([, text]) => text.slice(0, 4))).toEqual(['SKIP', 'SKIP']);
    let calls = 0;
    const lay = async () => { if (calls++ === 1) throw new Error('boom'); return {}; };
    expect(await checkSheet({ read: () => sheet, lay, describe: describe_ })).toEqual({ lines: [['links', 'ERROR boom'], ['nodes', 'SAME']], bad: 1 });
  });
});
