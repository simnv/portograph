import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, PathSegment } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { allocateGapRuns } from '../../src/internal.js';
import { chordsHold } from '../../src/layout/frame-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const NAME = 'a-link-inside-one-frame-is-a-straight-segment';
const source = readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const linkOf = (model: LayoutModel, from: string, to: string) =>
  model.links.find(link => link.attachments && link.attachments.from.node === from && link.attachments.to.node === to)!;
const straightLine = (segment: PathSegment): boolean => segment.from.x !== segment.to.x && segment.from.y !== segment.to.y;
const bottomOf = (model: LayoutModel, node: string): number => model.nodes[node]!.bounds!.y + model.nodes[node]!.bounds!.height;

describe('a held chord is a wall from stage 7f on', () => {
  const load = (name: string) => layout(parse(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')),
    { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

  it('keeps every chord it held, and the router removes nothing', async () => {
    for (const name of ['a-re-seated-band-carries-its-bar-and-flank', NAME]) {
      const model = await load(name);
      expect(model.frozenChords?.length ?? 0).toBeGreaterThan(0);
      expect(model.removedLinks ?? []).toEqual([]);
      for (const id of model.frozenChords!) {
        const link = model.links.find(item => item.id === id)!;
        expect(link.technique, `${name} ${id}`).toBe('straight');
        expect(link.path!.segments).toHaveLength(1);
      }
      expect(model.diagnostics.filter(item => item.code === 'STRAIGHT_LINK_BLOCKED')).toEqual([]);
    }
  });

  it('refuses a move that puts a body on a held chord, and names the link', async () => {
    const model = await run(source);
    const id = model.frozenChords![0]!, link = model.links.find(item => item.id === id)!;
    const chord = link.path!.segments[0]!, ends = new Set([link.attachments!.from.node, link.attachments!.to.node]);
    const other = Object.values(model.nodes).find(node => !ends.has(node.id))!;
    const box = other.bounds!, mid = { x: (chord.from.x + chord.to.x) / 2, y: (chord.from.y + chord.to.y) / 2 };
    const moved = { x: mid.x - box.width / 2, y: mid.y - box.height / 2, width: box.width, height: box.height };
    const draft = structuredClone(model);
    expect(chordsHold(draft, [{ group: { nodes: [other.id], bounds: box }, bounds: moved }])).toBe(false);
    expect(draft.diagnostics.some(item => item.code === 'STRAIGHT_LINK_HELD' && item.owners?.some(owner => owner.kind === 'link' && owner.id === id))).toBe(true);
    // A move that leaves the chord clear is not refused.
    expect(chordsHold(structuredClone(model), [{ group: { nodes: [other.id], bounds: box }, bounds: { ...box, x: box.x + 1 } }])).toBe(true);
  });
});

describe('a stem blocks a chord only while its link stays orthogonal (ticket 88)', () => {
  const name = 'a-stem-of-a-link-that-turns-straight-does-not-block-a-chord';
  it('turns both links straight where the greedy order refused the earlier one', async () => {
    const model = await run(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
    for (const [from, to] of [['n1', 'n4'], ['n1', 'n3']]) {
      const link = linkOf(model, from!, to!);
      expect(link.technique, link.id).toBe('straight');
      expect(link.path!.segments).toHaveLength(1);
      expect(model.frozenChords).toContain(link.id);
    }
    expect(model.removedLinks ?? []).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'STRAIGHT_LINK_BLOCKED')).toEqual([]);
  });
});

describe('a link inside one frame is a straight segment', () => {
  it('with the feed order on, Middle stands first (fed by Gateways 1 and 2) and every link is straight, the West-East peer link too (ticket 25)', async () => {
    const model = await run(source);
    expect(model.groups['site#1']!.rowOrder).toEqual(['mid', 'west', 'east']);
    expect(linkOf(model, 'west', 'east').technique).toBe('straight');
    const { counts, metrics } = score(model).snapshot;
    expect([counts.routed.bent, metrics.crossings.count]).toEqual([0, 1]);
  }, 60000);

  it('takes the straight technique for a clear chord, vertical or diagonal, and keeps the blocked one orthogonal', async () => {
    // The feed order is off here (ticket 25): the subject is Middle standing on the West-East chord, which the feed order takes away.
    const model = await run(source.replace('portograph: 2\n', 'portograph: 2\nlayout: { feedOrder: false }\n'));
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
    // The link that leaves the frame, between the ISP and a frame on the next tier, is a cross-frame chord since Q108 (ticket 99): the
    // gateway stands on the top sub-tier and its port faces the ISP's.
    expect(linkOf(model, 'isp', 'gw1').technique).toBe('straight');
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

describe('a group-link member inside one frame takes the chord', () => {
  const name = 'a-group-link-member-inside-one-frame-is-straight';
  const yaml = readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

  const check = async (source: string): Promise<void> => {
    const model = await run(source);
    expect(model.groupLinks).toHaveLength(1);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
    const members = model.links.filter(link => link.groupLink !== undefined);
    expect(members).toHaveLength(4);
    for (const link of members) {
      expect(link.technique).toBe('straight');
      expect(link.path!.segments).toHaveLength(1);
      expect(link.path!.fixed).toBe(true);
      expect(link.removed).not.toBe(true);
    }
    expect(model.lanes.filter(lane => lane.owner.kind === 'link' && members.some(link => link.id === (lane.owner as { id: string }).id))).toEqual([]);
    expect(allocateGapRuns(model).filter(item => members.some(link => link.id === item.link))).toEqual([]);
    expect(score(model).snapshot.passed).toBe(true);
  };

  it('draws every member between a parent and its child frame as one straight segment', () => check(yaml));

  it('draws every member between two rank cells of one frame as one straight segment', () => check(readFileSync(
    new URL('../../goldens/synthetic/a-group-link-member-between-two-rank-cells-is-straight.yaml', import.meta.url), 'utf8')));
});
