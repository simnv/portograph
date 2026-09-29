import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, render, resolveBeforeExpansion } from '../../src/index.js';
import { deriveRanks } from '../../src/layout/ranks.js';
import { rankInputOf } from '../../src/layout/rank-input.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

const ranksOf = (name: string, group: string, childGroups: string[] = []) =>
  deriveRanks(rankInputOf(resolveBeforeExpansion(parse(fixture(name))), group, childGroups));

describe('goldens/synthetic group-ranks fixtures', () => {
  it('a plain chain has one rank per link, from the member that links to the tier above', () => {
    const result = ranksOf('a-group-ranks-a-plain-chain', 'site');
    expect(Object.fromEntries(result.ranks)).toEqual({ gw: 0, dist: 1, access: 2 });
    expect(result.rankCount).toBe(3);
    expect(result.anchoredFrom).toBe('above');
  });

  it('a peer pair under one uplink shares one rank', () => {
    const result = ranksOf('a-group-ranks-a-peer-pair-under-one-uplink', 'site');
    expect(Object.fromEntries(result.ranks)).toEqual({ rt: 0, sw1: 1, sw2: 1 });
    expect(result.rankCount).toBe(2);
  });

  it('a skip link leaves the two servers on one rank below the switches', () => {
    const result = ranksOf('a-group-ranks-skip-link', 'site');
    expect(Object.fromEntries(result.ranks)).toEqual({ rt1: 0, rt2: 0, sw1: 1, sw2: 1, ntp1: 2, ntp2: 2 });
    expect(result.rankCount).toBe(3);
  });

  it('a cycle sw-sw-rt-rt layers as two peer pairs', () => {
    const result = ranksOf('a-group-ranks-a-cycle-of-peers', 'site');
    expect(Object.fromEntries(result.ranks)).toEqual({ rt1: 0, rt2: 0, sw1: 1, sw2: 1 });
    expect(result.rankCount).toBe(2);
  });

  it('a child span pushes the parent member that stands inside it to the rank after it', () => {
    const result = ranksOf('a-group-ranks-a-child-span-past-a-parent-member', 'site', ['zone']);
    expect(Object.fromEntries(result.ranks)).toEqual({ gw: 0, z1: 1, z2: 2, spare: 3, tail: 3 });
    expect(result.spans.get('zone')).toEqual([1, 2]);
    expect(result.rankCount).toBe(4);
  });

  it('a parent member between two child members is held out of the span and the rank it left closes up', () => {
    const result = ranksOf('a-child-span-holds-a-parent-member-out', 'site', ['zone']);
    expect(Object.fromEntries(result.ranks)).toEqual({ z1: 0, z2: 1, bridge: 2 });
    expect(result.spans.get('zone')).toEqual([0, 1]);
    expect(result.rankCount).toBe(3);
  });

  it('an overlay-only member takes the rank of its overlay partner, else the last rank', () => {
    const result = ranksOf('a-group-ranks-an-overlay-only-member', 'site');
    expect(Object.fromEntries(result.ranks)).toEqual({ gw: 0, sw: 1, ntp: 1, 'far-ntp': 1 });
    expect(result.rankCount).toBe(2);
  });

  it.each([
    'a-group-ranks-a-plain-chain', 'a-group-ranks-a-peer-pair-under-one-uplink', 'a-group-ranks-a-cycle-of-peers', 'a-group-ranks-skip-link',
    'a-group-ranks-a-child-span-past-a-parent-member', 'a-child-span-holds-a-parent-member-out', 'a-group-ranks-an-overlay-only-member',
  ])('%s parses, lays out and renders with today\'s pipeline', async name => {
    const model = await run(fixture(name));
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(render(model)).toContain('<svg');
  });
});
