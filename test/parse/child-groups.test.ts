import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parse, parseWithDiagnostics } from '../../src/parse/index.js';

const source = (groups: Record<string, unknown>) => stringify({
  portograph: 2, groups,
  nodes: { a: { group: 'site' }, b: { group: 'zone' }, c: { group: 'other' } },
});
const codes = (groups: Record<string, unknown>) => parseWithDiagnostics(source(groups)).diagnostics.filter(d => d.severity === 'error').map(d => d.code);

describe('ranked groups: parent and shape', () => {
  it('a group is ranked unless it says otherwise', () => {
    const doc = parse(source({ site: { tier: 0 }, zone: { parent: 'site' }, other: { tier: 1, shape: 'row' } }));
    expect(doc.groups.site!.shape).toBe('ranked');
    expect(doc.groups.other!.shape).toBe('row');
  });

  it('a child takes the tier of its parent and keeps its own members', () => {
    const doc = parse(source({ site: { tier: 3 }, zone: { parent: 'site' }, other: { tier: 5 } }));
    expect(doc.groups.zone).toMatchObject({ parent: 'site', tier: 0 });
    expect(doc.groups.site!.tier).toBe(0);
    expect(doc.groups.other!.tier).toBe(1);
    expect(doc.nodes.b!.group).toBe('zone');
  });

  it('the classes of a child count for the tier inference of its parent', () => {
    const text = stringify({
      portograph: 2, groups: { site: {}, zone: { parent: 'site' }, mid: {} },
      nodes: { w: { group: 'zone', class: 'wan' }, m: { group: 'mid', class: 'router' }, s: { group: 'site', class: 'router' } },
    });
    const doc = parse(text);
    expect(doc.groups.site!.tier).toBe(0);
    expect(doc.groups.zone!.tier).toBe(0);
    expect(doc.groups.mid!.tier).toBe(1);
  });

  it.each([
    ['CHILD_TIER', { site: { tier: 0 }, zone: { parent: 'site', tier: 1 } }],
    ['CHILD_FLANK', { site: { tier: 0 }, zone: { parent: 'site', align: 'left', of: 'site' } }],
    ['UNKNOWN_REFERENCE', { site: { tier: 0 }, zone: { parent: 'missing' } }],
    ['NESTED_CHILD', { site: { tier: 0 }, zone: { parent: 'site' }, deep: { parent: 'zone' } }],
    ['NESTED_CHILD', { site: { parent: 'site' } }],
    ['PARENT_SHAPE', { site: { tier: 0, shape: 'row' }, zone: { parent: 'site' } }],
    ['PARENT_FLANK', { site: { tier: 0 }, side: { align: 'left', of: 'site' }, zone: { parent: 'side' } }],
  ])('%s is a parse error', (code, groups) => {
    expect(codes({ other: { tier: 9 }, ...groups })).toContain(code);
  });
});
