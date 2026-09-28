import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, orderedNodeIds, parse, render, resolve } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { deriveRanks, type RankInput } from '../../src/layout/ranks.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

/**
 * The network profile carries a tier-inference table for groups only (`inferTiers` in
 * `src/parse`: provider, internet and wan on top, backbone and core at the bottom). It has no class
 * rank per node class, so the test states the small table the derivation is given: each row is one
 * class rank, and a class that no row names has none.
 */
const CLASS_ROWS = [['provider', 'internet', 'wan'], ['router', 'tbr', 'rr'], ['switch'], ['server']];

/** Build the derivation input of one group from the resolved model, the way ticket 02 will. */
function inputOf(model: LayoutModel, group: string, childGroups: string[] = []): RankInput {
  const own = new Set([group, ...childGroups]);
  const groupOf = (node: string) => model.document.nodes[node]!.group;
  const members = orderedNodeIds(model.document).filter(node => groupOf(node) === group);
  const tier = model.groups[group]!.tier!;
  const routedLinks: RankInput['routedLinks'] = [];
  const linksAbove = new Set<string>(), linksBelow = new Set<string>();
  const overlayPartners = new Map<string, string[]>();
  const sideOf = (ref: NonNullable<LayoutModel['links'][number]['attachments']>['from']) =>
    model.nodes[ref.node]!.ports.find(port => JSON.stringify(port.ref) === JSON.stringify(ref))?.side;
  for (const link of model.links) {
    const { from, to } = link.attachments!;
    const ends = [from.node, to.node];
    if (link.layer === 'overlay') {
      for (const [one, other] of [ends, [...ends].reverse()] as [string, string][]) {
        if (own.has(groupOf(one))) overlayPartners.set(one, [...(overlayPartners.get(one) ?? []), other]);
      }
      continue;
    }
    const inside = ends.map(node => own.has(groupOf(node)));
    if (inside[0] && inside[1]) {
      const fromSide = sideOf(from), toSide = sideOf(to);
      routedLinks.push({ from: from.node, to: to.node, ...(fromSide ? { fromSide } : {}), ...(toSide ? { toSide } : {}) });
    } else if (inside[0] || inside[1]) {
      const [mine, other] = inside[0] ? ends : [...ends].reverse();
      const otherTier = model.groups[groupOf(other!)]!.tier!;
      if (otherTier < tier) linksAbove.add(mine!); else if (otherTier > tier) linksBelow.add(mine!);
    }
  }
  const classRank = (node: string): number | undefined => {
    const index = CLASS_ROWS.findIndex(row => row.includes(model.document.nodes[node]!.class ?? ''));
    return index < 0 ? undefined : index;
  };
  return {
    group, members, routedLinks, linksAbove, linksBelow, overlayPartners, classRank,
    children: childGroups.map(child => ({ group: child, members: orderedNodeIds(model.document).filter(node => groupOf(node) === child) })),
  };
}

const ranksOf = (name: string, group: string, childGroups: string[] = []) =>
  deriveRanks(inputOf(resolve(parse(fixture(name))), group, childGroups));

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
    expect(Object.fromEntries(result.ranks)).toEqual({ gw: 0, z1: 1, z2: 2, spare: 3 });
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
