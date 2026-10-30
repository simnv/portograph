import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';

/**
 * Architecture-2 ticket 40: the fan family is decided in stage 1, from the document only (user rulings Q124 to Q126): the faint (dashed or dotted)
 * routed links of one tier group's hubs to framed units elsewhere, two hubs or more, three units or more, every hub to every unit.
 */
const FIXTURE = 'a-hub-tiers-fan-draws-straight-and-crosses-itself';
const fixture = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');

/** Two hubs on tier 1 and `sites` sites on tier 2, each site linked to each hub by its own router; `edit` rewrites one link line. */
function sheet(sites: number, klass = 'dashed', options: { hubs?: number; skip?: string; extra?: string[] } = {}): string {
  const hubs = Array.from({ length: options.hubs ?? 2 }, (_, i) => `h${i + 1}`);
  const ids = Array.from({ length: sites }, (_, i) => `s${i + 1}`);
  const lines = ['portograph: 2', 'groups:', '  core: { tier: 1 }', ...ids.map(id => `  ${id}: { tier: 2 }`), 'nodes:',
    ...hubs.map(hub => `  ${hub}: { group: core }`),
    ...ids.flatMap(id => hubs.map((_, i) => `  ${id}r${i + 1}: { group: ${id} }`)), 'links:'];
  for (const id of ids) for (const [i, hub] of hubs.entries()) {
    const name = `${hub}-${id}`;
    if (name !== options.skip) lines.push(`  - [${hub}, ${id}r${i + 1}, { class: ${klass} }]`);
  }
  lines.push(...(options.extra ?? []).map(line => `  - ${line}`));
  return `${lines.join('\n')}\n`;
}

describe('the fan family is decided in stage 1', () => {
  it('records the fixture family: two hubs, four sites, eight members, and marks each member link', () => {
    const model = resolve(parse(fixture));
    expect(model.fanFamilies).toHaveLength(1);
    const [family] = model.fanFamilies!;
    expect(family!.id).toBe('fan:core:dashed');
    expect(family!.hubs).toEqual(['hub-a', 'hub-b']);
    expect(family!.units).toEqual(['site-a', 'site-b', 'site-c', 'site-d']);
    expect(family!.members).toHaveLength(8);
    const members = new Set(family!.members.map(member => member.link));
    for (const link of model.links) expect(link.fanFamily, link.id).toBe(members.has(link.id) ? family!.id : undefined);
    expect(model.diagnostics.filter(item => item.code === 'FAN_FAMILY')).toHaveLength(1);
  });

  it('reproduces the record from the document (R1: resolving the document gives the same families)', () => {
    const model = resolve(parse(fixture));
    expect(resolve(model.document).fanFamilies).toEqual(model.fanFamilies);
  });

  it('takes a dotted class too, and no solid class (Q124: dashed or dotted classes only)', () => {
    expect(resolve(parse(sheet(3, 'dotted'))).fanFamilies).toHaveLength(1);
    expect(resolve(parse(sheet(3, 'dashed'))).fanFamilies).toHaveLength(1);
    const solid = resolve(parse(sheet(3, 'default')));
    expect(solid.fanFamilies).toBeUndefined();
    expect(solid.links.some(link => link.fanFamily !== undefined)).toBe(false);
  });

  it('needs two hubs and three far units, and complete incidence', () => {
    expect(resolve(parse(sheet(2))).fanFamilies).toBeUndefined();
    expect(resolve(parse(sheet(4, 'dashed', { hubs: 1 }))).fanFamilies).toBeUndefined();
    // One hub misses one site: the incidence is not complete.
    expect(resolve(parse(sheet(4, 'dashed', { skip: 'h2-s3' }))).fanFamilies).toBeUndefined();
  });

  it('leaves a dashed link between two units of one tier out', () => {
    const extra = ['[s1r1, s2r1, { class: dashed }]'];
    const model = resolve(parse(sheet(3, 'dashed', { extra })));
    const [family] = model.fanFamilies!;
    expect(family!.members).toHaveLength(6);
    const lateral = model.links.find(link => link.attachments?.from.node === 's1r1' && link.attachments.to.node === 's2r1')!;
    expect(lateral.fanFamily).toBeUndefined();
  });

  it('leaves out a hub of another tier group: the trigger counts per tier group, not per hub node', () => {
    // e1 in its own group on tier 3 feeds three sites too, but alone in its tier group: one hub is no family.
    const text = sheet(3).replace('nodes:\n', '  edge: { tier: 3 }\nnodes:\n  e1: { group: edge }\n')
      + ['s1r1', 's2r1', 's3r1'].map(node => `  - [e1, ${node}, { class: dashed }]\n`).join('');
    const model = resolve(parse(text));
    expect(model.fanFamilies!.map(family => [family.id, family.members.length])).toEqual([['fan:core:dashed', 6]]);
    expect(model.links.filter(link => link.attachments?.from.node === 'e1').every(link => link.fanFamily === undefined)).toBe(true);
  });

  it('declines both families that claim one link, and names the member links (FAN_FAMILY_DECLINED)', () => {
    // A (a1, a2) fans to B, C and D below; B (b1, b2) fans to A, P and Q above. The links a1-b1 and a2-b2 belong to both.
    const text = ['portograph: 2', 'groups:', '  ga: { tier: 1 }', '  gp: { tier: 1 }', '  gq: { tier: 1 }', '  gb: { tier: 2 }', '  gc: { tier: 2 }', '  gd: { tier: 2 }',
      'nodes:', ...['a1: ga', 'a2: ga', 'p1: gp', 'q1: gq', 'b1: gb', 'b2: gb', 'c1: gc', 'd1: gd'].map(item => `  ${item.replace(': ', ': { group: ')} }`),
      'links:', ...['a1, b1', 'a2, b2', 'a1, c1', 'a2, c1', 'a1, d1', 'a2, d1', 'b1, p1', 'b2, p1', 'b1, q1', 'b2, q1'].map(pair => `  - [${pair}, { class: dashed }]`)].join('\n');
    const model = resolve(parse(`${text}\n`));
    expect(model.fanFamilies).toBeUndefined();
    expect(model.links.some(link => link.fanFamily !== undefined)).toBe(false);
    const declined = model.diagnostics.filter(item => item.code === 'FAN_FAMILY_DECLINED');
    expect(declined.map(item => item.message.match(/fan:\w+:dashed/)![0])).toEqual(['fan:ga:dashed', 'fan:gb:dashed']);
    const id = (a: string, b: string): string => model.links.find(link => link.attachments?.from.node === a && link.attachments.to.node === b)!.id;
    const shared = [id('a1', 'b1'), id('a2', 'b2')];
    for (const item of declined) {
      expect(item.owners).toHaveLength(6);
      for (const link of shared) expect(item.owners!.map(owner => (owner as { id: string }).id)).toContain(link);
      expect(item.message).toContain(shared.sort().join(', '));
    }
  });

  it('writes nothing on a sheet with no family, so its model keeps its bytes', () => {
    const model = resolve(parse(sheet(2)));
    expect('fanFamilies' in model).toBe(false);
    expect(model.links.some(link => 'fanFamily' in link)).toBe(false);
  });
});
