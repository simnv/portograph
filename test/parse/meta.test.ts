import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parse, parseWithDiagnostics } from '../../src/parse/index.js';

const doc = (value: Record<string, unknown> = {}): string => stringify({
  portograph: 2,
  groups: { g: { tier: 0 } },
  nodes: { a: { group: 'g', ports: ['p', 'q'] }, b: { group: 'g', ports: ['p'] } },
  links: [['a.p', 'b.p']],
  ...value,
});
const errors = (text: string) => parseWithDiagnostics(text).diagnostics.filter(d => d.severity === 'error');
const nodesWith = (extra: Record<string, unknown>) => ({ a: { group: 'g', ports: ['p', 'q'], ...extra }, b: { group: 'g', ports: ['p'] } });

describe('meta: accepted', () => {
  it('on the root', () => {
    expect(parse(doc({ meta: { site: 'north', rack: 7 } })).meta).toEqual({ site: 'north', rack: 7 });
  });

  it('on a node', () => {
    expect(parse(doc({ nodes: nodesWith({ meta: { owner: 'ops', critical: true } }) })).nodes['a']!.meta)
      .toEqual({ owner: 'ops', critical: true });
  });

  it('on a port in map form', () => {
    const document = parse(doc({ nodes: nodesWith({ ports: [{ name: 'p', meta: { speed: 100.5 } }, 'q'] }) }));
    expect(document.nodes['a']!.ports[0]!.meta).toEqual({ speed: 100.5 });
    expect(document.nodes['a']!.ports[1]).not.toHaveProperty('meta');
  });

  it('on a link in map form', () => {
    expect(parse(doc({ links: [{ from: 'a.p', to: 'b.p', meta: { vlan: 20 } }] })).links[0]!.meta).toEqual({ vlan: 20 });
  });

  it('on a link in the array form, in its options', () => {
    const document = parse(doc({ links: [['a.p', 'b.p', { label: 'x', id: 'wan', meta: { vlan: '20' } }]] }));
    expect(document.links[0]).toMatchObject({ id: 'wan', label: 'x', meta: { vlan: '20' } });
  });

  it('keeps the author order of the keys', () => {
    const document = parse(doc({ meta: { zeta: 1, alpha: 2, mid: 3 } }));
    expect(Object.keys(document.meta!)).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('accepts underscores, digits and hyphens after the first character', () => {
    expect(parse(doc({ meta: { _a: 1, 'b-2_c': 2, X9: 3 } })).meta).toEqual({ _a: 1, 'b-2_c': 2, X9: 3 });
  });

  it('keeps a false, a zero and an empty string', () => {
    expect(parse(doc({ meta: { off: false, zero: 0, empty: '' } })).meta).toEqual({ off: false, zero: 0, empty: '' });
  });

  it('leaves no meta key for an empty map', () => {
    expect(parse(doc({ meta: {} }))).not.toHaveProperty('meta');
  });
});

describe('meta: absent', () => {
  it('leaves no meta or id key anywhere in the document', () => {
    const text = JSON.stringify(parse(doc()));
    expect(text).not.toMatch(/"meta"/);
    expect(text).not.toMatch(/"id"/);
  });

  it('parses a document without meta and id to the same object as one with empty maps', () => {
    expect(parse(doc({ meta: {}, nodes: nodesWith({ meta: {} }), links: [{ from: 'a.p', to: 'b.p', meta: {} }] })))
      .toEqual(parse(doc({ links: [{ from: 'a.p', to: 'b.p' }] })));
  });
});

describe('meta: diagnostics', () => {
  it.each([
    ['$.meta', doc({ meta: { 'bad key': 1 } }), 'BAD_META_KEY', '$.meta.bad key'],
    ['$.meta', doc({ meta: { '1st': 1 } }), 'BAD_META_KEY', '$.meta.1st'],
    ['$.meta', doc({ meta: { 'a.b': 1 } }), 'BAD_META_KEY', '$.meta.a.b'],
    ['node', doc({ nodes: nodesWith({ meta: { 'x y': 1 } }) }), 'BAD_META_KEY', '$.nodes.a.meta.x y'],
    ['link', doc({ links: [['a.p', 'b.p', { meta: { '-x': 1 } }]] }), 'BAD_META_KEY', '$.links[0].meta.-x'],
  ])('%s: %#', (_name, text, code, path) => {
    expect(errors(text)).toEqual([expect.objectContaining({ code, path, stage: 'parse' })]);
  });

  it.each(['pg-x', 'PG-Kind', 'pg-', 'id', 'ID', 'label', 'Label', 'placeholders', 'xmlns', 'xml', 'XMLfoo', 'xml-lang'])(
    'reserves %s without regard to case', key => {
      expect(errors(doc({ links: [{ from: 'a.p', to: 'b.p', meta: { [key]: 'v' } }] })))
        .toEqual([expect.objectContaining({ code: 'RESERVED_META_KEY', path: `$.links[0].meta.${key}` })]);
    });

  it('reports a reserved key on each carrier with its path', () => {
    expect(errors(doc({ meta: { id: 1 } })).map(d => [d.code, d.path])).toEqual([['RESERVED_META_KEY', '$.meta.id']]);
    expect(errors(doc({ nodes: nodesWith({ meta: { label: 1 } }) })).map(d => [d.code, d.path]))
      .toEqual([['RESERVED_META_KEY', '$.nodes.a.meta.label']]);
    expect(errors(doc({ nodes: nodesWith({ ports: [{ name: 'p', meta: { 'pg-x': 1 } }, 'q'] }) })).map(d => [d.code, d.path]))
      .toEqual([['RESERVED_META_KEY', '$.nodes.a.ports[0].meta.pg-x']]);
  });

  it('allows keys that only start like a reserved one', () => {
    expect(errors(doc({ meta: { pgx: 1, identity: 2, labels: 3, placeholder: 4, xm: 5 } }))).toEqual([]);
  });

  it.each([
    ['a list', ['x']],
    ['a map', { deep: 1 }],
    ['null', null],
  ])('refuses %s as a value with INVALID_TYPE', (_name, value) => {
    expect(errors(doc({ links: [{ from: 'a.p', to: 'b.p', meta: { x: value } }] })))
      .toEqual([expect.objectContaining({ code: 'INVALID_TYPE', path: '$.links[0].meta.x' })]);
  });

  it('refuses a non-finite number', () => {
    expect(errors('portograph: 2\ngroups: {g: {tier: 0}}\nnodes: {a: {group: g, meta: {x: .inf}}}\nlinks: []\n'))
      .toEqual([expect.objectContaining({ code: 'INVALID_TYPE', path: '$.nodes.a.meta.x' })]);
  });

  it('refuses a meta that is not a map', () => {
    expect(errors(doc({ meta: ['x'] })).map(d => d.path)).toContain('$.meta');
  });

  it('fails the document when one key is wrong', () => {
    expect(parseWithDiagnostics(doc({ meta: { ok: 1, 'pg-x': 2 } })).ok).toBe(false);
  });
});

describe('link id', () => {
  it('is kept in map form and in the options of the array form', () => {
    expect(parse(doc({ links: [{ id: 'one', from: 'a.p', to: 'b.p' }, ['a.q', 'b.p', { id: 'two' }]] })).links.map(l => l.id))
      .toEqual(['one', 'two']);
  });

  it('reports DUPLICATE_LINK_ID at the second link', () => {
    const text = doc({ links: [{ id: 'one', from: 'a.p', to: 'b.p' }, ['a.q', 'b.p', { id: 'one' }]] });
    expect(errors(text)).toEqual([expect.objectContaining({ code: 'DUPLICATE_LINK_ID', path: '$.links[1].id' })]);
  });

  it.each(['has space', '', 'a.b', 3])('refuses the bad id %j', value => {
    const found = errors(doc({ links: [{ id: value, from: 'a.p', to: 'b.p' }] }));
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe('$.links[0].id');
    expect(found[0]!.code).not.toBe('DUPLICATE_LINK_ID');
  });
});
