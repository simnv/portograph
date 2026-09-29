import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, resolveBeforeExpansion } from '../../src/index.js';
import { deriveRanks } from '../../src/layout/ranks.js';
import { rankInputOf } from '../../src/layout/rank-input.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const ranksOf = (name: string, group: string) => deriveRanks(rankInputOf(resolveBeforeExpansion(parse(fixture(name))), group));

describe('a peer link joins members of equal depth, not of equal class rank (ranked-groups ticket 27)', () => {
  const SIX = 'a-peer-link-joins-members-of-equal-depth-six-bodies';

  it('the six-body collapse: sixteen members of one class take the reference six ranks', () => {
    const result = ranksOf(SIX, 'loc');
    const byRank = (rank: number) => [...result.ranks].filter(([, value]) => value === rank).map(([id]) => id).sort();
    expect([0, 1, 2, 3, 4, 5].map(byRank)).toEqual([
      ['crt1', 'crt2'], ['crt3', 'crt4'], ['rrt1', 'rrt2', 'srt1', 'srt2'], ['rsw1', 'rsw2', 'ssw1', 'ssw2'], ['ntp1', 'ntp2'], ['rlb1', 'slb1'],
    ]);
    expect(result.rankCount).toBe(6);
    expect(result.anchoredFrom).toBe('above');
  });

  it('the triangle puts the two members that are not the anchor on one rank', () => {
    const result = ranksOf('a-peer-link-triangle', 'loc');
    expect(Object.fromEntries(result.ranks)).toEqual({ a: 0, b: 1, c: 1 });
    expect(result.rankCount).toBe(2);
  });

  it('the twin quad keeps its depths: no twin lift moves w4 to the rank of w3', () => {
    const result = ranksOf('a-peer-link-twin-quad', 'loc');
    expect(Object.fromEntries(result.ranks)).toEqual({ wan: 0, sw: 1, w3: 2, w1: 3, w2: 3, w4: 3 });
    expect(result.rankCount).toBe(4);
  });

  it('the six-body location lays out as six rank cells on six sub-tiers, the pairs side by side', async () => {
    const model = await layout(parse(fixture(SIX)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const cells = Object.keys(model.groups).filter(id => id.startsWith('loc#'));
    expect(cells).toEqual(['loc#0', 'loc#1', 'loc#2', 'loc#3', 'loc#4', 'loc#5']);
    const cellOf = (id: string) => model.document.nodes[id]!.group;
    expect(['crt1', 'crt3', 'srt1', 'rrt2', 'ssw1', 'rsw2', 'ntp1', 'rlb1'].map(cellOf))
      .toEqual(['loc#0', 'loc#1', 'loc#2', 'loc#2', 'loc#3', 'loc#3', 'loc#4', 'loc#5']);
    // No row is six bodies wide: the widest cell holds four.
    expect(Math.max(...cells.map(id => model.groups[id]!.nodes.length))).toBe(4);
    const y = (id: string) => model.nodes[id]!.bounds!.y;
    expect(y('crt1')).toBeLessThan(y('crt3'));
    expect(y('crt3')).toBeLessThan(y('srt1'));
    expect(y('srt1')).toBe(y('rrt1'));
    expect(y('srt1')).toBeLessThan(y('ssw1'));
    expect(y('ssw1')).toBeLessThan(y('ntp1'));
    expect(y('ntp1')).toBeLessThan(y('slb1'));
  }, 120000);
});
