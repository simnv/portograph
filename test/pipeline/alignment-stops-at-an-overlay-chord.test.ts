import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { SKELETON_SPACING } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ranked-groups ticket 29: an alignment growth stops short of a straight overlay chord that the
 * ungrown body does not already cross. The provider's four bottom ports each want to sit over a site
 * spread wide below it; the sync link from the clock to the lab node crosses the provider's row to
 * the left of the provider's own width and inside the spread of its feeds.
 */
const yaml = readFileSync(new URL('../../goldens/synthetic/alignment-stops-at-an-overlay-chord.yaml', import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const overlayOf = (model: LayoutModel): LayoutLink => model.links.find(link => link.layer === 'overlay')!;

describe('alignment growth stops at an overlay chord', () => {
  it('keeps the sync link one straight segment and the provider clear of it', async () => {
    const model = await run();
    const sync = overlayOf(model), segments = sync.path!.segments;
    expect(segments).toHaveLength(1);
    const chordX = segments[0]!.from.x;
    expect(segments[0]!.to.x).toBeCloseTo(chordX, 6);
    const provider = model.nodes['provider']!.bounds!;
    // The growth stops the node clearance short of the chord; the left edge never reaches it.
    expect(provider.x).toBeGreaterThanOrEqual(chordX + SKELETON_SPACING.nodeClearance - 1e-6);
    // The right side has no chord, so the body still grows toward the feeds it can reach.
    const site4 = model.nodes['site-4']!.ports[0]!.anchor!.x;
    expect(provider.x + provider.width).toBeGreaterThan(site4);
  });

  it('leaves the port outside its feed at pitch from the edge and jogs its link', async () => {
    const model = await run();
    const provider = model.nodes['provider']!;
    const first = provider.ports.find(port => port.ref.name === 'p1')!, second = provider.ports.find(port => port.ref.name === 'p2')!;
    const feed = model.nodes['site-1']!.ports[0]!.anchor!.x;
    expect(first.anchor!.x).toBeGreaterThan(provider.bounds!.x);
    expect(first.anchor!.x).toBeLessThan(second.anchor!.x);
    expect(Math.abs(first.anchor!.x - feed)).toBeGreaterThan(0.5);
    // The ports the cap leaves alone stay under their feeds.
    for (const [name, site] of [['p2', 'site-2'], ['p3', 'site-3'], ['p4', 'site-4']] as const) {
      const port = provider.ports.find(item => item.ref.name === name)!;
      expect(port.anchor!.x).toBeCloseTo(model.nodes[site]!.ports[0]!.anchor!.x, 6);
    }
    const jog = model.links.find(link => link.attachments?.from.node === 'provider' && link.attachments.from.name === 'p1')!;
    expect(jog.path!.segments.length).toBeGreaterThan(1);
  });

  it('reports the cap once for the provider, naming the link, and every routed link publishes', async () => {
    const model = await run();
    const stopped = model.diagnostics.filter(item => item.code === 'ALIGNMENT_STOPPED_AT_OVERLAY');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.owners).toEqual([{ kind: 'link', id: overlayOf(model).id }]);
    expect(stopped[0]!.message.startsWith('provider ')).toBe(true);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const routed = model.links.filter(link => link.layer === 'routed');
    expect(routed).toHaveLength(4);
    for (const link of routed) {
      expect(link.path?.segments.length ?? 0).toBeGreaterThan(0);
      // A published path ends on both attachment anchors.
      const ends = [link.path!.segments[0]!.from, link.path!.segments[link.path!.segments.length - 1]!.to];
      const anchors = [link.attachments!.from, link.attachments!.to].map(ref => model.nodes[ref.node]!.ports.find(port => port.ref.name === ref.name && port.ref.ordinal === ref.ordinal)!.anchor!);
      for (const anchor of anchors) expect(ends.some(end => Math.hypot(end.x - anchor.x, end.y - anchor.y) < 1e-6)).toBe(true);
    }
  });
});
