import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, PathSegment } from '../../src/index.js';
import { allocateGapRuns, layout, parse, score } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const NAME = 'a-link-inside-one-frame-is-a-straight-segment';
const source = readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const linkOf = (model: LayoutModel, from: string, to: string) =>
  model.links.find(link => link.attachments && link.attachments.from.node === from && link.attachments.to.node === to)!;
const straightLine = (segment: PathSegment): boolean => segment.from.x !== segment.to.x && segment.from.y !== segment.to.y;
const bottomOf = (model: LayoutModel, node: string): number => model.nodes[node]!.bounds!.y + model.nodes[node]!.bounds!.height;

describe('a link inside one frame is a straight segment', () => {
  it('takes the straight technique for a clear chord, vertical or diagonal, and keeps the blocked one orthogonal', async () => {
    const model = await run(source);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    const straight = [['gw1', 'west'], ['gw1', 'mid'], ['gw2', 'mid'], ['gw3', 'east'], ['mid', 'access']]
      .map(([from, to]) => linkOf(model, from!, to!));
    for (const link of straight) {
      expect(link.technique).toBe('straight');
      expect(link.path!.segments).toHaveLength(1);
      expect(link.path!.fixed).toBe(true);
    }
    // Two are diagonal and two are vertical: the rule does not need the faces to line up.
    expect(straight.filter(link => straightLine(link.path!.segments[0]!))).toHaveLength(3);
    expect(straight.filter(link => !straightLine(link.path!.segments[0]!))).toHaveLength(2);
    // The chord runs from one port face to the other, not from anchor to anchor.
    const chord = linkOf(model, 'gw1', 'west').path!.segments[0]!;
    const from = model.nodes['gw1']!.ports.find(port => port.ref.name === undefined && port.anchor!.x === chord.from.x)!;
    expect(chord.from.y).toBeGreaterThanOrEqual(from.anchor!.y);
    // West and East face each other and Middle stands on the chord, so the link keeps its route.
    const blocked = linkOf(model, 'west', 'east');
    expect(blocked.technique).toBe('orthogonal');
    expect(blocked.path!.segments.length).toBeGreaterThan(1);
    // The link that leaves the frame is unchanged.
    expect(linkOf(model, 'isp', 'gw1').technique).toBeUndefined();
  });

  it('reserves no lane, no gap run and no stem for a straight link', async () => {
    const model = await run(source);
    const ids = new Set(['gw1:west', 'gw1:mid', 'gw2:mid', 'gw3:east', 'mid:access']
      .map(key => linkOf(model, key.split(':')[0]!, key.split(':')[1]!).id));
    expect(model.lanes.filter(lane => lane.owner.kind === 'link' && ids.has(lane.owner.id))).toEqual([]);
    expect(allocateGapRuns(model).filter(item => ids.has(item.link))).toEqual([]);
    for (const link of model.links.filter(item => ids.has(item.id))) expect(link.fixedSegments).toBeUndefined();
  });

  it('does not grow the tier gaps for a straight link', async () => {
    const straight = await run(source);
    // The same links authored orthogonal keep today's route and today's gaps.
    const links = source.slice(source.indexOf('links:'));
    const inside = links.replace(/ {2}- \[(gw\d|mid), (\w+)\]/g, '  - { from: $1, to: $2, route: orthogonal }');
    const orthogonal = await run(source.replace(links, inside));
    const gap = (model: LayoutModel, upper: string, lower: string): number =>
      model.nodes[lower]!.bounds!.y - bottomOf(model, upper);
    expect(linkOf(orthogonal, 'gw1', 'west').technique).toBe('orthogonal');
    expect(gap(straight, 'gw1', 'west')).toBeLessThanOrEqual(gap(orthogonal, 'gw1', 'west'));
    expect(gap(straight, 'mid', 'access')).toBeLessThanOrEqual(gap(orthogonal, 'mid', 'access'));
    expect(straight.nodes['access']!.bounds!.y).toBeLessThanOrEqual(orthogonal.nodes['access']!.bounds!.y);
  });

  it('passes every gate with the straight links in place', async () => {
    const model = await run(source);
    const result = score(model);
    expect(result.snapshot.gates.G2.violations).toEqual([]);
    expect(result.snapshot.gates.G4.violations).toEqual([]);
    expect(result.snapshot.gates.G5.violations).toEqual([]);
    expect(result.snapshot.gates.G6.violations).toEqual([]);
    expect(result.snapshot.gates.G7.violations).toEqual([]);
    expect(result.snapshot.passed).toBe(true);
  });
});
