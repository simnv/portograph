import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { checkReadCaches, readCacheCounts } from '../../src/model/read-cache.js';
import { attemptCounters, resetAttemptCounters } from '../../src/layout/attempt-counters.js';
import { linkByEnds, linkById } from '../../src/layout/peers.js';
import { standPortsOverChildren, type StepReader } from '../../src/layout/parent-stand.js';
import { centreContext } from '../../src/layout/centre.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const multiChildSheet = readFileSync(new URL('../../goldens/synthetic/a-feed-port-moves-over-its-child-at-a-wall.yaml', import.meta.url), 'utf8');

const threeTierRow = `portograph: 2
profile: network
groups:
  top: {tier: 0, label: TOP}
  low: {tier: 1, label: LOW}
  deep: {tier: 2, label: DEEP}
nodes:
${[1, 2, 3, 4, 5, 6].map(i => `  t${i}: {group: top, label: t${i}, ports: [{name: o}]}`).join('\n')}
${[1, 2, 3, 4, 5, 6].map(i => `  b${i}: {group: low, label: b${i}, ports: [{name: i}, {name: o}]}`).join('\n')}
${[1, 2, 3, 4, 5, 6].map(i => `  c${i}: {group: deep, label: c${i}, ports: [{name: i}]}`).join('\n')}
links:
${[1, 2, 3, 4, 5, 6].map(i => `- [t${i}.o, b${i}.i, {id: r${i}, route: orthogonal}]\n- [b${i}.o, c${i}.i, {id: s${i}, route: orthogonal}]`).join('\n')}
`;

const spineLeafYaml = readFileSync(new URL('../../goldens/real/private-datacenter-spine-leaf.yaml', import.meta.url), 'utf8');

const ref = (node: string, name: string, ordinal = 1) => ({ node, name, ordinal });
const syntheticLink = (id: string, from: string, to: string, solidBlock = false) => ({
  id,
  layer: 'routed',
  technique: 'orthogonal',
  solidBlock,
  attachments: { from: ref(from, 'p'), to: ref(to, 'p') },
});

describe('linkById and linkByEnds read caches (ticket 02)', () => {
  it('preserves first-match find semantics, detects replaced or appended arrays, and checks under checkReadCaches', async () => {
    const firstDup = syntheticLink('dup', 'a', 'b', false);
    const secondDup = syntheticLink('dup', 'c', 'd', true);
    const model = {
      links: [firstDup, secondDup],
    } as unknown as LayoutModel;

    const before = readCacheCounts().linkById ?? { hits: 0, misses: 0, checked: 0 };
    const map1 = linkById(model);
    expect(map1.get('dup')).toBe(firstDup);
    expect(readCacheCounts().linkById!.misses).toBe(before.misses + 1);

    // Hit on same array reference and length.
    const map2 = linkById(model);
    expect(map2).toBe(map1);
    expect(readCacheCounts().linkById!.hits).toBe(before.hits + 1);

    // Miss on replaced array of identical length.
    const replacement = syntheticLink('dup', 'x', 'y', true);
    model.links = [replacement, secondDup] as unknown as LayoutModel['links'];
    expect(linkById(model).get('dup')).toBe(replacement);
    expect(readCacheCounts().linkById!.misses).toBe(before.misses + 2);

    // Miss on in-place push (length key).
    const third = syntheticLink('l3', 'm', 'n');
    model.links.push(third as unknown as LayoutModel['links'][number]);
    expect(linkById(model).get('l3')).toBe(third);
    expect(readCacheCounts().linkById!.misses).toBe(before.misses + 3);

    // Checked hit succeeds when unmutated, and throws when mutated in place.
    const checkedBefore = readCacheCounts().linkById!.checked;
    await checkReadCaches(async () => {
      expect(linkById(model).get('dup')).toBe(replacement);
    });
    expect(readCacheCounts().linkById!.checked).toBe(checkedBefore + 1);

    model.links[0] = syntheticLink('dup', 'mutated', 'z') as unknown as LayoutModel['links'][number];
    await expect(checkReadCaches(async () => linkById(model))).rejects.toThrow(/Stale read cache linkById/);
  });

  it('caches linkByEnds with first-match semantics and checks under checkReadCaches', async () => {
    const l1 = syntheticLink('l1', 'a', 'b');
    const l2 = syntheticLink('l2', 'b', 'a');
    const model = { links: [l1, l2] } as unknown as LayoutModel;

    const map = linkByEnds(model);
    expect(map.get('port:["a",false,"p",1]\0port:["b",false,"p",1]')).toBe(l1);
    await checkReadCaches(async () => {
      expect(linkByEnds(model).get('port:["a",false,"p",1]\0port:["b",false,"p",1]')).toBe(l1);
    });
    model.links[0] = syntheticLink('l1-replaced', 'a', 'b') as unknown as LayoutModel['links'][number];
    await expect(checkReadCaches(async () => linkByEnds(model))).rejects.toThrow(/Stale read cache linkByEnds/);
  });
});

describe('parentFeedReads memo and R4 counters (ticket 02)', () => {
  it('resets parentFeedReads in resetAttemptCounters, hits memo on a multi-child parent layout, and passes checkCaches: true', async () => {
    resetAttemptCounters();
    expect(attemptCounters.parentFeedReads).toEqual({ calls: 0, computes: 0 });
    const checkedBefore = readCacheCounts().parentFeedReads?.checked ?? 0;
    const linkCheckedBefore = readCacheCounts().linkById?.checked ?? 0;

    const model = await layout(parse(multiChildSheet), {
      createElkAttempt: createAttempt,
      createRouteAttempt: createAvoidAttempt,
      checkCaches: true,
    });
    expect(model.stage).toBe('link-labels');
    expect(attemptCounters.parentFeedReads.calls).toBeGreaterThan(0);
    expect(attemptCounters.parentFeedReads.computes).toBeGreaterThan(0);
    expect(attemptCounters.parentFeedReads.computes).toBeLessThan(attemptCounters.parentFeedReads.calls);
    expect(readCacheCounts().parentFeedReads!.checked).toBeGreaterThan(checkedBefore);
    expect(readCacheCounts().linkById!.checked).toBeGreaterThan(linkCheckedBefore);
  }, 60000);

  it('hits parentFeedReads memo on goldens/real/private-datacenter-spine-leaf.yaml', async () => {
    resetAttemptCounters();

    const model = await layout(parse(spineLeafYaml), {
      createElkAttempt: createAttempt,
      createRouteAttempt: createAvoidAttempt,
    });
    expect(model.stage).toBe('link-labels');
    expect(attemptCounters.parentFeedReads.calls).toBeGreaterThan(0);
    expect(attemptCounters.parentFeedReads.computes).toBeLessThan(attemptCounters.parentFeedReads.calls);
  }, 60000);

  it('detects stale parentFeedReads under checkReadCaches when reader.feeds changes between calls', async () => {
    const model = JSON.parse(JSON.stringify(await layout(parse(threeTierRow), {
      createElkAttempt: createAttempt,
      createRouteAttempt: createAvoidAttempt,
    }))) as LayoutModel;
    // Offset parent ports on tier 0 and tier 1 so standPortsOverChildren calls offset() multiple times on the same (step, group).
    for (let i = 1; i <= 6; i++) {
      model.nodes[`t${i}`]!.ports[0]!.anchor!.x += 4;
      model.nodes[`b${i}`]!.ports[1]!.anchor!.x += 4;
    }
    const context = centreContext(model, model.anchorTier!);
    let call = 0;
    const unstableReader: StepReader = {
      feeds: (_tier, list) => {
        call++;
        return call <= 1 ? list : list.slice(0, 1);
      },
      takes: () => true,
    };
    await expect(checkReadCaches(async () => {
      standPortsOverChildren(model, context.steps, unstableReader);
    })).rejects.toThrow(/Stale read cache parentFeedReads/);
  }, 60000);
});
