import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parse, parseWithDiagnostics } from '../../src/parse/index.js';

const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const defaultNodes = { a: { group: 'site' }, b: { group: 'clients' } };
const source = (groups: Record<string, unknown>, nodes: Record<string, unknown> = defaultNodes) =>
  stringify({ portograph: 2, groups, nodes });
const errors = (groups: Record<string, unknown>, nodes?: Record<string, unknown>) =>
  parseWithDiagnostics(source(groups, nodes)).diagnostics.filter(d => d.severity === 'error').map(d => d.code);
const base = { west: { label: 'West' }, site: { tier: 0, canton: 'west' }, clients: { tier: 1, canton: 'west' } };

describe('canton groups: schema (canton-groups ticket 1)', () => {
  it('fixture 1 parses with the canton on its members', () => {
    const doc = parse(fixture('a-canton-group-frames-two-tiers'));
    expect(doc.groups.site).toMatchObject({ canton: 'west', tier: 0 });
    expect(doc.groups.clients).toMatchObject({ canton: 'west', tier: 1 });
    expect(doc.groups.west).toMatchObject({ label: 'West', members: ['site', 'clients'] });
    expect(doc.groups.west!.tier).toBeUndefined();
  });

  it('a canton takes no tier and does not shift the tiers of the others', () => {
    const doc = parse(source({ west: {}, site: { canton: 'west' }, clients: { canton: 'west' } }));
    expect(doc.groups.site!.tier).toBe(0);
    expect(doc.groups.clients!.tier).toBe(1);
    const codes = parseWithDiagnostics(source({ west: {}, site: { canton: 'west' }, clients: { canton: 'west' } })).diagnostics.map(d => d.code);
    expect(codes).not.toContain('EMPTY_TIER');
  });

  it('a document without canton normalises as before', () => {
    const doc = parse(fixture('a-child-frame-stands-inside-its-parent'));
    expect(JSON.stringify(doc)).not.toMatch(/canton|members/);
  });

  it('a member may hold a child group, and two members may share a tier', () => {
    const groups = { west: {}, site: { tier: 0, canton: 'west' }, zone: { parent: 'site' }, clients: { tier: 0, canton: 'west' } };
    expect(errors(groups)).toEqual([]);
    expect(parse(source(groups)).groups.zone).toMatchObject({ parent: 'site' });
  });

  it('a member with the row shape is legal', () => {
    expect(errors({ ...base, clients: { tier: 1, canton: 'west', shape: 'row' } })).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>?]>([
    ['CANTON_KEYS', { ...base, west: { tier: 0 } }],
    ['CANTON_KEYS', { ...base, west: { shape: 'row' } }],
    ['CANTON_KEYS', { ...base, west: { layout: {} } }],
    ['CANTON_KEYS', { ...base, west: { parent: 'site' } }],
    ['CANTON_KEYS', { ...base, west: { align: 'left', of: 'site' } }],
    ['CANTON_KEYS', base, { a: { group: 'west' }, b: { group: 'clients' } }],
    ['CANTON_MEMBER_KIND', { ...base, zone: { parent: 'site', canton: 'west' } }],
    ['CANTON_MEMBER_KIND', { ...base, side: { align: 'left', of: 'site', canton: 'west' } }],
    ['CANTON_MEMBER_SHAPE', { ...base, clients: { tier: 1, canton: 'west', shape: 'bar' } }],
    ['CANTON_MEMBER_SHAPE', { ...base, clients: { tier: 1, canton: 'west', shape: 'grid' } }],
    ['CANTON_MEMBER_FLANK', { ...base, side: { align: 'left', of: 'site' } }],
    ['CANTON_TIER_GAP', { west: {}, site: { tier: 0, canton: 'west' }, clients: { tier: 2, canton: 'west' }, mid: { tier: 1 } }],
    ['CANTON_NESTED', { ...base, east: { canton: 'west' }, site: { tier: 0, canton: 'east' } }],
    ['CANTON_NESTED', { ...base, west: { canton: 'west' } }],
    ['CANTON_EMPTY', { west: {}, site: { tier: 0, canton: 'west', shape: 'bar' }, clients: { tier: 1 } }],
    ['UNKNOWN_REFERENCE', { site: { tier: 0, canton: 'missing' }, clients: { tier: 1 } }],
  ])('%s is a parse error', (code, groups, nodes) => {
    expect(errors(groups, nodes)).toContain(code);
  });

  it('NESTED_CHILD still refuses a child of a child', () => {
    expect(errors({ ...base, zone: { parent: 'site' }, deep: { parent: 'zone' } })).toContain('NESTED_CHILD');
  });
});
