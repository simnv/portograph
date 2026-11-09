import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
// The side round is off: a chord it frees is a diagonal, and this test reads the column axis (ticket 117).
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
  ...(name === 'a-column-centres-under-two-feeds' ? { testMaxReruns: 0 } : {}) });
const codes = (model: LayoutModel): string[] => model.diagnostics.map(diagnostic => diagnostic.code);
/** The x of the first port of a node on a side. */
const portX = (model: LayoutModel, node: string, side: 'top' | 'bottom'): number => model.nodes[node]!.ports.find(port => port.side === side)!.anchor!.x;
/** How far the two ports of a link stand apart in x: the jog its two ends force. */
const jog = (model: LayoutModel, from: string, to: string): number => Math.abs(portX(model, from, 'bottom') - portX(model, to, 'top'));
const frame = (model: LayoutModel, id: string) => model.frames!.find(item => item.id === id)!;
const axis = (model: LayoutModel, id: string): number => frame(model, id).box.x + frame(model, id).box.width / 2;

describe('a column axis lands on its feed', () => {
  it('locations stacked as columns over columns: every feed a column can reach is vertical', async () => {
    const model = await run('locations-stack-as-columns-over-columns');
    expect(codes(model)).not.toContain('CENTRE_INVARIANT_UNVERIFIED');
    // `c` is the one column whose feed is alone: its ports stand at one x. The drawn path may still leave it
    // to clear the title of the frame it enters, which is a routing matter, so the ports are compared.
    expect(jog(model, 'c-edge', 'y-gw')).toBeLessThanOrEqual(0.5);
    // `a` and `b` are fed by two neighbour gateways of one row, 94.5 px apart, and their frames cannot stand
    // closer than a frame width and a band gap. That gap between the two feeds is the least the two links
    // can jog, and the columns take it and no more: a column never widens to meet a feed.
    const forced = (frame(model, 'a').box.width + frame(model, 'b').box.width) / 2 + bandGap(model) - (portX(model, 'x-gw2', 'top') - portX(model, 'x-gw', 'top'));
    expect(jog(model, 'a-edge', 'x-gw') + jog(model, 'b-edge', 'x-gw2')).toBeLessThanOrEqual(forced + 1);
    // The alignment nothing can hold is reported for that column alone: the two others converge.
    const unresolved = model.diagnostics.filter(diagnostic => diagnostic.code === 'PLACEMENT_NON_CONVERGENCE').flatMap(diagnostic => (diagnostic.owners ?? []).flatMap(owner => 'id' in owner ? [owner.id] : []));
    expect(unresolved).not.toContain('b-zone#1');
    expect(unresolved).not.toContain('c-zone#1');
    const report = score(model);
    expect(report.snapshot.gates.G9.violations).toEqual([]);
    expect(report.snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  it('a column stands at the mean of two feeds far apart, and no link bends past its own feed', async () => {
    const model = await run('a-column-centres-under-two-feeds');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const feeds = (portX(model, 'west-gw', 'bottom') + portX(model, 'east-gw', 'bottom')) / 2;
    // The column is packed before later stages widen the two rows by a few px, so the axis lands within
    // half a column slack of the mean, not further.
    expect(Math.abs(axis(model, 'hub') - feeds)).toBeLessThanOrEqual(10);
    // Each link runs from its feed to its port and back nowhere: its path holds no x beyond the two ports.
    for (const [id, from, to] of [['link-1', 'west-gw', 'hub-a'], ['link-2', 'east-gw', 'hub-b']] as const) {
      const xs = model.links.find(link => link.id === id)!.path!.segments.flatMap(segment => [segment.from.x, segment.to.x]);
      const ends = [portX(model, from, 'bottom'), portX(model, to, 'top')];
      expect(Math.max(...xs) - Math.min(...xs), `${id} overshoots`).toBeLessThanOrEqual(Math.abs(ends[0]! - ends[1]!) + 0.5);
    }
    // The two feeds are further apart than the hub is wide, so both links bend, and by nearly the same amount.
    const left = jog(model, 'west-gw', 'hub-a'), right = jog(model, 'east-gw', 'hub-b');
    expect(left).toBeGreaterThan(100);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(20);
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  it('a transit between two adjacent frames keeps both feeds one vertical segment and G6 clean', async () => {
    const model = await run('a-middle-transit-keeps-the-neighbour-feed-straight');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    // The transit link runs in the gap between the two frames, so it is what the feeds must not come near.
    const gates = score(model).snapshot.gates;
    expect(gates.G6.violations).toEqual([]);
    expect(gates.G9.violations).toEqual([]);
    for (const [id, source, gateway] of [['link-1', 'as0', 'aw'], ['link-3', 'bs0', 'bw']] as const) {
      const link = model.links.find(item => item.id === id)!;
      expect([link.attachments!.from.node, link.attachments!.to.node]).toEqual([source, gateway]);
      const xs = link.path!.segments.flatMap(segment => [segment.from.x, segment.to.x]);
      expect(Math.max(...xs) - Math.min(...xs), `${id} is one vertical segment`).toBeLessThanOrEqual(0.5);
    }
    // The transit stands between the frames.
    const transit = model.links.find(item => item.attachments!.from.node === 'm0')!.path!.segments;
    const between = transit.every(segment => segment.from.x > frame(model, 'a').box.x + frame(model, 'a').box.width && segment.to.x < frame(model, 'b').box.x);
    expect(between, 'the transit link runs between the frames').toBe(true);
  }, 60000);
});
