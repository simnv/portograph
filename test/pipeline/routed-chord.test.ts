import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { routerEntryPoints } from '../../src/layout/bands.js';
import { chordKind, chordVerdict, chordsHold, edgeLeavers, expectedFramePath } from '../../src/layout/frame-paths.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { segmentRectDistance } from '../../src/score/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from '../layout/joint-off.js';
// The group lift (ticket 08) is off in these tests: it moves a group of their sheets (a group fed from directly above rises to a level side
// entry beside its feeder), which changes the subject they pin. `lift.test.ts` tests the lift, and the corpus gate measures it on every sheet.

/**
 * Ranked-groups ticket 99 (Q108, docs/design/routed-chords.md): a routed link between two frames or free groups on consecutive
 * document tiers takes one straight segment from face to face when that segment is clear.
 */
const fixture = (name: string): string => withoutJointOrder(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });
const STRAIGHT = 'a-routed-link-between-frames-draws-straight';
const FOREIGN = 'a-routed-link-between-frames-keeps-orthogonal-past-a-foreign-frame';
const refusals = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'ROUTED_CHORD_REFUSED')
  .map(item => `${item.owners?.map(owner => 'id' in owner ? owner.id : owner.kind).join(',')}:${item.message.replace(/^.*: /, '').replace('.', '')}`);
const crossLinks = (model: LayoutModel) => model.links.filter(link => chordKind(model, link) === 'cross');

describe('a routed link between frames draws straight', () => {
  it('draws each of the four provider links as one straight segment, and every gate passes', async () => {
    const model = await run(fixture(STRAIGHT));
    const links = crossLinks(model);
    expect(links).toHaveLength(4);
    for (const link of links) {
      expect(link.technique, link.id).toBe('straight');
      expect(link.path!.segments, link.id).toHaveLength(1);
      expect(link.path!.fixed).toBe(true);
      expect(model.frozenChords, link.id).toContain(link.id);
    }
    expect(refusals(model)).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
    const report = score(model).snapshot;
    for (const [id, gate] of Object.entries(report.gates)) expect([id, gate.violations]).toEqual([id, []]);
  }, 60000);

  it('keeps the orthogonal route where a foreign box stands on the chord, and names the check', async () => {
    const model = await run(fixture(FOREIGN));
    const byNodes = (from: string, to: string) => model.links.find(link => link.attachments!.from.node === from && link.attachments!.to.node === to)!;
    expect(byNodes('w1', 'a1').technique).toBe('straight');
    expect(byNodes('w1', 'b3').technique).toBe('straight');
    const refused = byNodes('m1', 'b1');
    expect(refused.technique).toBe('orthogonal');
    expect(refused.path!.segments.length).toBeGreaterThan(1);
    expect(refusals(model)).toContain(`${refused.id}:frame`);
    // One diagnostic for each cross-frame candidate that is not held, and none for a held one.
    expect(refusals(model)).toHaveLength(crossLinks(model).filter(link => !model.frozenChords!.includes(link.id)).length);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);
});

describe('what is a cross-frame candidate', () => {
  it('takes a link whose upper port is on the bottom and whose lower port is on the top, and nothing else', async () => {
    const plain = parse(fixture(STRAIGHT));
    const base = await run(fixture(STRAIGHT));
    expect(crossLinks(base).map(link => link.id)).toEqual(['link-3', 'link-4', 'link-5', 'link-6']);
    // A side port is no candidate: the router of the east frame leaves by its left side.
    const side = await run(fixture(STRAIGHT).replace('east-router: { group: east, class: router, label: East router }',
      'east-router: { group: east, class: router, label: East router, ports: [{ name: w, side: left }] }').replace('[east-router, provider-1,', '[east-router.w, provider-1,'));
    expect(chordKind(side, side.links[2]!)).toBeUndefined();
    expect(side.links[2]!.technique).not.toBe('straight');
    // `route: orthogonal` is no candidate; the other links of the pair still are.
    const orthogonal = await run(fixture(STRAIGHT).replace('[east-router, provider-1, { class: dashed }]', '[east-router, provider-1, { class: dashed, route: orthogonal }]'));
    expect(chordKind(orthogonal, orthogonal.links[2]!)).toBeUndefined();
    expect(orthogonal.links[2]!.path!.segments.length).toBeGreaterThan(1);
    expect(crossLinks(orthogonal)).toHaveLength(3);
    expect(plain.links.length).toBe(6);
  }, 120000);

  it('refuses a link whose ends stand a sub-tier band apart (transit): it needs a lane', async () => {
    // `y` links up as well as down, so it stands on the top sub-tier of its document tier; the frame `x` beside it takes three.
    const yaml = `portograph: 2
profile: network
groups:
  top: { tier: 0, label: Top }
  y-group: { tier: 1, label: Y }
  x: { tier: 1, label: X }
  low: { tier: 2, label: Low }
nodes:
  t: { group: top, class: router, label: T }
  y: { group: y-group, class: router, label: Y }
  x1: { group: x, class: router, label: X1 }
  x2: { group: x, class: router, label: X2 }
  x3: { group: x, class: router, label: X3 }
  p1: { group: low, class: provider, label: P1 }
  p2: { group: low, class: provider, label: P2 }
links:
  - [t, y]
  - [x1, x2]
  - [x2, x3]
  - [x3, p2, { class: dashed }]
  - [y, p1, { class: dashed }]`;
    const model = await run(yaml);
    const link = model.links[4]!;
    expect(chordKind(model, link)).toBe('cross');
    expect(link.technique).toBe('orthogonal');
    expect(refusals(model)).toContain(`${link.id}:transit`);
    expect(chordVerdict(model, link)).toEqual({ reason: 'transit' });
  }, 60000);

  it('refuses a chord that would leave its frame through a side edge (edge)', async () => {
    const model = structuredClone(await run(fixture(STRAIGHT)));
    delete model.frozenChords;
    const link = crossLinks(model)[0]!;
    expect(chordVerdict(model, link)).toHaveProperty('segment');
    // Narrow the frame that holds the upper end until the chord meets its bottom edge inside the corner margin.
    const from = link.attachments!.from.node, frame = model.frames!.find(item => item.cells.some(cell => model.groups[cell]!.nodes.includes(from)))!;
    const segment = (chordVerdict(model, link) as { segment: { from: { x: number; y: number }; to: { x: number; y: number } } }).segment;
    const edge = frame.box.y + frame.box.height, t = (edge - segment.from.y) / (segment.to.y - segment.from.y);
    const exit = segment.from.x + t * (segment.to.x - segment.from.x);
    frame.box = { ...frame.box, x: exit - 3, width: 200 };
    expect(chordVerdict(model, link)).toEqual({ reason: 'edge' });
  }, 60000);

  it('refuses a chord within 10 px of the mouth leg of a lane that ends on its gap (leg)', async () => {
    const model = structuredClone(await run(fixture(STRAIGHT)));
    delete model.frozenChords;
    for (const link of model.links) if (link.technique === 'straight') { delete link.technique; delete link.path; }
    const link = crossLinks(model)[0]!;
    expect(expectedFramePath(model, link)).toBeDefined();
    const segment = chordVerdict(model, link) as { segment: { from: { x: number; y: number }; to: { x: number; y: number } } };
    const tier = model.groups[model.document.nodes[link.attachments!.from.node]!.group]!.tier!;
    const band = model.tierBands.find(item => item.tier === tier)!.bounds!;
    const x = (segment.segment.from.x + segment.segment.to.x) / 2;
    // A lane of the upper sub-tier, whose mouth leg runs down through the chord's gap at the chord's mid x.
    model.lanes.push({ id: 'lane:test', owner: { kind: 'link', id: 'other' }, layer: 'routed', group: model.document.nodes[link.attachments!.from.node]!.group,
      tier, side: 'right', x, bounds: { x: x - 17, y: band.y - 10.75, width: 34, height: band.height + 21.5 } });
    expect(expectedFramePath(model, link)).toBeUndefined();
  }, 60000);
});

describe('a held cross-frame chord is a chord to every stage', () => {
  it('has no router entry point and no planned gap part', async () => {
    const model = await run(fixture(STRAIGHT));
    const held = new Set(model.frozenChords);
    for (const link of crossLinks(model)) expect(held.has(link.id)).toBe(true);
    expect(routerEntryPoints(model).filter(point => held.has(point.link))).toEqual([]);
    const parts = tierGapPlans(model).flatMap(({ plan }) => [...plan.parts.map(part => part.link), ...plan.residual.map(item => item.link)]);
    expect(parts.filter(id => held.has(id))).toEqual([]);
  }, 60000);

  it('refuses a 7f move that puts only a foreign frame box on it, and names the link (STRAIGHT_LINK_HELD)', async () => {
    const model = await run(fixture(STRAIGHT));
    const link = model.links.find(item => model.frozenChords!.includes(item.id) && chordKind(model, item) === 'cross' && item.attachments!.from.node === 'east-router'
      && item.attachments!.to.node === 'provider-1')!;
    const chord = link.path!.segments[0]!;
    const cells = model.document.frames!['west']!.cells.map(cell => model.groups[cell]!);
    const box = model.frames!.find(item => item.id === 'west')!.box;
    const bodies = cells.flatMap(group => group.nodes.map(id => model.nodes[id]!.bounds!));
    const move = (dx: number, dy: number) => cells.map(group => ({ id: group.id, bounds: { ...group.bounds!, x: group.bounds!.x + dx, y: group.bounds!.y + dy } }));
    // A move that leaves the frame box 2 to 8 px from the chord, and every body of the frame 12 px or more from it: the chord is clear of every body
    // and pill (the corridor keeps 10 px) and only the frame wall (10 px and half the stroke) is broken. The stale `model.frames` is clear.
    let found: { dx: number; dy: number } | undefined;
    for (const dy of [0, 40, 80, 120]) for (let dx = -100; dx <= 500 && !found; dx++) {
      const shifted = { ...box, x: box.x + dx, y: box.y + dy };
      const near = segmentRectDistance(chord, shifted);
      if (near > 2 && near < 8 && bodies.every(body => segmentRectDistance(chord, { ...body, x: body.x + dx, y: body.y + dy }) >= 12)) found = { dx, dy };
    }
    expect(found).toBeDefined();
    expect(segmentRectDistance(chord, box)).toBeGreaterThan(10.75);
    const draft = structuredClone(model);
    const proposed = (target: LayoutModel) => move(found!.dx, found!.dy).map(item => ({ group: target.groups[item.id]!, bounds: item.bounds }));
    expect(chordsHold(draft, proposed(draft))).toBe(false);
    expect(draft.diagnostics.some(item => item.code === 'STRAIGHT_LINK_HELD' && item.owners?.some(owner => owner.kind === 'link' && owner.id === link.id))).toBe(true);
    // The same cells one pitch away from the chord are not refused for this link: the frames are derived from the proposed cells, not read stale.
    const clear = structuredClone(model);
    chordsHold(clear, cells.map(group => ({ group: clear.groups[group.id]!, bounds: { ...group.bounds!, x: group.bounds!.x + found!.dx - 40, y: group.bounds!.y + found!.dy } })));
    expect(clear.diagnostics.some(item => item.code === 'STRAIGHT_LINK_HELD' && item.owners?.some(owner => owner.kind === 'link' && owner.id === link.id))).toBe(false);
  }, 60000);
});

describe('what a chord leaves to its neighbours', () => {
  it('leaves link-1 of a shared port a route that clears the neighbour group (main text of the fixture, no gate fails)', async () => {
    const model = await run(fixture('a-claimed-run-clears-a-shared-run'));
    expect(model.links.find(link => link.id === 'link-3')!.technique).toBe('straight');
    // The fan branch of link-1 ran along the tip row through `low`; it is released to the router, as main released it by chance.
    const report = score(model).snapshot;
    for (const [id, gate] of Object.entries(report.gates)) expect([id, gate.violations]).toEqual([id, []]);
    expect(model.diagnostics.some(item => item.code === 'FAN_BRANCH_THROUGH_GROUP')).toBe(true);
  }, 60000);

  it('names a held chord that leaves its frame by a side edge after 7f (edge)', async () => {
    const model = structuredClone(await run(fixture(STRAIGHT)));
    expect(edgeLeavers(model)).toEqual([]);
    const link = model.links.find(item => model.frozenChords!.includes(item.id) && chordKind(model, item) === 'cross')!;
    const from = link.attachments!.from.node, frame = model.frames!.find(item => item.cells.some(cell => model.groups[cell]!.nodes.includes(from)))!;
    frame.box = { ...frame.box, x: frame.box.x + frame.box.width - 5, width: 40 };
    expect(edgeLeavers(model)).toContain(link.id);
  }, 60000);

  it('emits STRAIGHT_LINK_EDGE when 7f leaves a held chord leaving by a side edge', async () => {
    const model = await run(fixture('a-bus-leaves-a-title-edge-with-more-legs'));
    const named = model.diagnostics.filter(item => item.code === 'STRAIGHT_LINK_EDGE');
    expect(named.length).toBeGreaterThan(0);
    for (const item of named) {
      expect(item.severity).toBe('warning');
      expect(item.message).toMatch(/after placement\.$/);
      expect(edgeLeavers(model)).toContain((item.owners![0] as { id: string }).id);
    }
  }, 60000);
});
