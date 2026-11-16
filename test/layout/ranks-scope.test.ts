import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/index.js';
import { resolveBeforeExpansion } from '../../src/internal.js';
import { deriveRanks, type RankInput } from '../../src/layout/ranks.js';
import { rankInputOf } from '../../src/layout/rank-input.js';
import { deriveRanksAdr0019 } from './ranks-adr0019.ref.js';

/**
 * ADR-0026 scope (dense-16x9 ticket 01): the two-pole rule applies to a group in which a routed path inside the group joins an upward anchor with
 * a downward-only anchor. Every other group keeps the ranks of ADR-0019 exactly. Ranking the components that no path joins from their own pole
 * cost the approved golden 20 bends and a link (931x960 to 810x1112) and changed 26 more sheets, so the rule stops where the pole distance stops.
 */
function joinsPoles(input: RankInput): boolean {
  const members = new Set([...input.members, ...input.children.flatMap(child => child.members)]);
  const lower = [...members].filter(id => input.linksBelow.has(id) && !input.linksAbove.has(id));
  if (!lower.length || !input.linksAbove.size) return false;
  const next = new Map<string, string[]>();
  for (const link of input.routedLinks) {
    if (link.from === link.to || !members.has(link.from) || !members.has(link.to)) continue;
    next.set(link.from, [...(next.get(link.from) ?? []), link.to]);
    next.set(link.to, [...(next.get(link.to) ?? []), link.from]);
  }
  const seen = new Set<string>(), queue = [...input.linksAbove].filter(id => members.has(id));
  queue.forEach(id => seen.add(id));
  for (let at = 0; at < queue.length; at += 1) for (const other of next.get(queue[at]!) ?? []) if (!seen.has(other)) { seen.add(other); queue.push(other); }
  return lower.some(id => seen.has(id));
}

const plain = (result: ReturnType<typeof deriveRanks>) => ({
  ranks: [...result.ranks].sort(([a], [b]) => (a < b ? -1 : 1)), rankCount: result.rankCount, anchoredFrom: result.anchoredFrom,
  spans: [...result.spans].sort(([a], [b]) => (a < b ? -1 : 1)),
});

function* corpus(): Generator<string> {
  const walk = function* (dir: URL): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) yield* walk(new URL(`${entry.name}/`, dir));
      else if (entry.name.endsWith('.yaml') && entry.name !== 'stage-inputs.yaml') yield new URL(entry.name, dir).pathname;
    }
  };
  yield* walk(new URL('../../goldens/', import.meta.url));
  yield* walk(new URL('../fixtures/staged/', import.meta.url));
}

describe('the two-pole rule stops where the pole distance stops', () => {
  it('every corpus group with no routed path from an upward anchor to a downward-only anchor ranks exactly as ADR-0019 did on main', () => {
    let compared = 0, anchoredBothSides = 0, joined = 0, sheets = 0;
    const files = [...corpus()], failures: string[] = [];
    for (const path of files) {
      let model;
      try { model = resolveBeforeExpansion(parse(readFileSync(path, 'utf8'))); } catch (error) { failures.push(`${path}: ${(error as Error).message.slice(0, 120)}`); continue; }
      sheets += 1;
      const groups = Object.entries(model.document.groups).filter(([, group]) => group.shape === 'ranked' && group.parent === undefined && group.align === undefined && group.tier !== undefined);
      for (const [id] of groups) {
        const children = Object.keys(model.document.groups).filter(child => model.document.groups[child]!.parent === id);
        const input = rankInputOf(model, id, children);
        if (input.linksAbove.size && input.linksBelow.size) anchoredBothSides += 1;
        if (joinsPoles(input)) { joined += 1; continue; }
        compared += 1;
        expect(plain(deriveRanks(input)), `${path} group ${id}`).toEqual(plain(deriveRanksAdr0019(input)));
      }
    }
    // A sheet that fails to parse or resolve is named, never skipped: the compared set is the whole corpus.
    expect(failures).toEqual([]);
    expect(sheets).toBe(files.length);
    expect(compared).toBeGreaterThan(100);
    expect(anchoredBothSides).toBeGreaterThan(joined);
    expect(joined).toBeGreaterThan(0);
  }, 180000);

  it('the boundary: poles joined only through a fixed peer link are joined, the classifier and the code agree', () => {
    const peer: RankInput = {
      group: 'g', members: ['u', 'd', 'leaf'], linksAbove: new Set(['u']), linksBelow: new Set(['d']), overlayPartners: new Map(), children: [],
      routedLinks: [{ from: 'u', to: 'd', fromSide: 'right', toSide: 'left' }, { from: 'd', to: 'leaf' }],
    };
    expect(joinsPoles(peer)).toBe(true);
    expect(Object.fromEntries(deriveRanksAdr0019(peer).ranks)).toEqual({ u: 0, d: 0, leaf: 1 });
    expect(Object.fromEntries(deriveRanks(peer).ranks)).toEqual({ u: 0, d: 0, leaf: 0 });
    const apart: RankInput = { ...peer, routedLinks: [{ from: 'd', to: 'leaf' }] };
    expect(joinsPoles(apart)).toBe(false);
    expect(plain(deriveRanks(apart))).toEqual(plain(deriveRanksAdr0019(apart)));
  });

  it('the reviewer inputs of ticket 01 give the result of main', () => {
    const base: RankInput = { group: 'g', members: ['u', 'm', 'd'], routedLinks: [{ from: 'u', to: 'm' }], linksAbove: new Set(['u']), linksBelow: new Set(['d']), overlayPartners: new Map([['d', ['u']]]), children: [] };
    expect(plain(deriveRanks(base))).toEqual(plain(deriveRanksAdr0019(base)));
    expect(Object.fromEntries(deriveRanks(base).ranks)).toEqual({ u: 0, m: 1, d: 0 });
    const both: RankInput = { group: 'g', members: ['u', 'leaf', 'd'], routedLinks: [{ from: 'u', to: 'leaf' }], linksAbove: new Set(['u']), linksBelow: new Set(['u', 'd']), overlayPartners: new Map(), children: [] };
    expect(plain(deriveRanks(both))).toEqual(plain(deriveRanksAdr0019(both)));
    expect(Object.fromEntries(deriveRanks(both).ranks)).toEqual({ u: 0, leaf: 1, d: 1 });
  });
});
