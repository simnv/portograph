import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { layout, parse, resolve, restoreFinalLayout, serializeLayoutModel } from '../../src/index.js';
import { groupShape } from '../../src/layout/grid.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const tiers = (model: ReturnType<typeof resolve>) => Object.fromEntries(Object.values(model.groups).map(group => [group.id, group.tier]));

/** The tier-0 uplink `isp`, then whatever `groups` and `nodes` add below it. */
const source = (groups: Record<string, unknown>, nodes: Record<string, unknown>, links: unknown[]) => stringify({
  portograph: 2,
  groups: { upstream: { tier: 0 }, ...groups },
  nodes: { isp: { group: 'upstream', class: 'provider' }, ...nodes },
  links,
});

describe('rank cells (stage 1)', () => {
  it('replaces a two-rank group by two row cells on two sub-tiers, each framed by the group', async () => {
    const model = await run(fixture('a-ranked-group-lays-out-on-two-sub-tiers'));
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(Object.keys(model.groups)).toEqual(['upstream', 'site#0', 'site#1']);
    expect(tiers(model)).toEqual({ upstream: 0, 'site#0': 1, 'site#1': 2 });
    expect(model.groups['site#0']).toMatchObject({ nodes: ['gw'], frame: 'site' });
    expect(model.groups['site#1']).toMatchObject({ nodes: ['dist'], frame: 'site' });
    expect(model.groups['upstream']!.frame).toBeUndefined();
    expect(model.document.groups['site#0']).toMatchObject({ shape: 'row', tier: 1, frame: 'site' });
    expect(model.document.frames).toEqual({ site: { label: 'Site', cells: ['site#0', 'site#1'] } });
    expect(model.tierBands.map(band => ({ tier: band.tier, groups: band.groups }))).toEqual([
      { tier: 0, groups: ['upstream'] }, { tier: 1, groups: ['site#0'] }, { tier: 2, groups: ['site#1'] },
    ]);
    // The links keep their node endpoints, and every cell is placed under the one before it.
    expect(model.links.map(link => [link.attachments!.from.node, link.attachments!.to.node])).toEqual([['isp', 'gw'], ['gw', 'dist']]);
    const y = (id: string) => model.groups[id]!.bounds!.y;
    expect(y('upstream')).toBeLessThan(y('site#0'));
    expect(y('site#0')).toBeLessThan(y('site#1'));
    // The snapshot restores with its frames: mutation.ts validates the cells against the expanded document.
    const restored = restoreFinalLayout(serializeLayoutModel(model));
    expect(restored.groups['site#1']!.frame).toBe('site');
  }, 60000);

  it('leaves a one-rank group as it is: same id, same tier, a row, no frame', () => {
    const model = resolve(parse(source({ site: { tier: 1 } }, { a: { group: 'site' }, b: { group: 'site' } }, [['isp', 'a'], ['isp', 'b']])));
    expect(tiers(model)).toEqual({ upstream: 0, site: 1 });
    expect(model.document.groups['site']!.shape).toBe('ranked');
    expect(groupShape(model, 'site')).toBe('row');
    expect(model.document.frames).toBeUndefined();
    expect(model.groups['site']!.frame).toBeUndefined();
  });

  it('reads `shape: row` as one rank even where a routed link joins two members', () => {
    const groups = { site: { tier: 1, shape: 'row' } };
    const nodes = { a: { group: 'site', class: 'router' }, b: { group: 'site', class: 'switch' } };
    const model = resolve(parse(source(groups, nodes, [['isp', 'a'], ['a', 'b']])));
    expect(tiers(model)).toEqual({ upstream: 0, site: 1 });
    expect(model.document.frames).toBeUndefined();
  });

  it('gives a tier the sub-tiers of its deepest group and aligns a group anchored only from below to the bottom', () => {
    const groups = { tall: { tier: 1 }, low: { tier: 1 }, floor: { tier: 2 } };
    const nodes = {
      t1: { group: 'tall', class: 'router' }, t2: { group: 'tall', class: 'switch' }, t3: { group: 'tall', class: 'server' },
      l1: { group: 'low', class: 'router' }, l2: { group: 'low', class: 'switch' },
      f1: { group: 'floor', class: 'router' },
    };
    // `low` has no link to the tier above, only one to the tier below, so its last rank stands last.
    const model = resolve(parse(source(groups, nodes, [['isp', 't1'], ['t1', 't2'], ['t2', 't3'], ['l1', 'l2'], ['l2', 'f1']])));
    expect(tiers(model)).toEqual({
      upstream: 0, 'tall#0': 1, 'tall#1': 2, 'tall#2': 3, 'low#0': 2, 'low#1': 3, floor: 4,
    });
  });

  it('makes a child group its own cells inside the parent frame, on the rank numbers of the parent', () => {
    const groups = { site: { tier: 1 }, zone: { parent: 'site' } };
    const nodes = {
      gw: { group: 'site', class: 'router' }, spare: { group: 'site', class: 'switch' },
      z1: { group: 'zone', class: 'switch' }, z2: { group: 'zone', class: 'access' }, tail: { group: 'site', class: 'server' },
    };
    // The zone feeds tail, a deeper parent member, so it is not a leaf child and keeps its rank (ticket 19).
    const model = resolve(parse(source(groups, nodes, [['isp', 'gw'], ['gw', 'z1'], ['z1', 'z2'], ['gw', 'spare'], ['z2', 'tail']])));
    expect(tiers(model)).toEqual({ upstream: 0, 'site#0': 1, 'zone#1': 2, 'zone#2': 3, 'site#3': 4 });
    expect(model.document.frames).toEqual({
      site: { label: 'site', cells: ['site#0', 'site#3'] },
      zone: { label: 'zone', parent: 'site', cells: ['zone#1', 'zone#2'] },
    });
    expect(model.groups['zone#1']).toMatchObject({ nodes: ['z1'], frame: 'zone' });
    expect(model.groups['site#3']).toMatchObject({ nodes: ['spare', 'tail'], frame: 'site' });
    expect(model.document.nodes['z2']!.group).toBe('zone#2');
  });

  it('reads a link to a replaced group as a link to every node of its cells', () => {
    const groups = { site: { tier: 1 }, floor: { tier: 2 } };
    const nodes = { gw: { group: 'site', class: 'router' }, dist: { group: 'site', class: 'switch' }, f1: { group: 'floor' } };
    const model = resolve(parse(source(groups, nodes, [['isp', 'gw'], ['gw', 'dist'], ['f1', 'site']])));
    expect(Object.keys(model.groups)).toEqual(['upstream', 'site#0', 'site#1', 'floor']);
    expect(model.links.filter(link => link.sourceIndex === 2).map(link => link.attachments!.to.node)).toEqual(['gw', 'dist']);
  });

  it('resolves its own document back to the same model', () => {
    const groups = { site: { tier: 1 }, zone: { parent: 'site' } };
    const nodes = { gw: { group: 'site', class: 'router' }, z1: { group: 'zone', class: 'switch' }, z2: { group: 'zone', class: 'access' } };
    const model = resolve(parse(source(groups, nodes, [['isp', 'gw'], ['gw', 'z1'], ['z1', 'z2']])));
    expect(resolve(model.document)).toEqual(model);
  });

  it('never expands an expanded document again: a neighbour that gains an anchor from the sub-tier numbers stays one rank', () => {
    const groups = { Q: { tier: 1 }, P: { tier: 1 } };
    const nodes = {
      q1: { group: 'Q', class: 'router' }, q2: { group: 'Q', class: 'switch' }, q3: { group: 'Q', class: 'server' },
      p1: { group: 'P', class: 'router' }, p2: { group: 'P', class: 'switch' },
    };
    const model = resolve(parse(source(groups, nodes, [['isp', 'q1'], ['q1', 'q2'], ['q2', 'q3'], ['p1', 'q3'], ['p1', 'p2']])));
    expect(tiers(model)).toEqual({ upstream: 0, 'Q#0': 1, 'Q#1': 2, 'Q#2': 3, P: 1 });
    expect(resolve(model.document)).toEqual(model);
  });

  it('points a flank of a two-rank group at the first cell, on the first sub-tier of the group', () => {
    const groups = { B: { tier: 1 }, F: { align: 'left', of: 'B' } };
    const nodes = { b1: { group: 'B', class: 'router' }, b2: { group: 'B', class: 'switch' }, f1: { group: 'F' } };
    const model = resolve(parse(source(groups, nodes, [['isp', 'b1'], ['b1', 'b2']])));
    expect(Object.keys(model.groups).filter(id => id.startsWith('B#'))).toEqual(['B#0', 'B#1']);
    expect(model.document.groups['F']).toMatchObject({ align: 'left', of: 'B#0' });
    expect(model.groups['F']!.tier).toBe(model.groups['B#0']!.tier);
  });
});
