import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, render, score } from '../../src/index.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { rows } from '../../src/layout/rows.js';
import { drawio } from '../../src/render/drawio.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const centreX = (box: Rect): number => box.x + box.width / 2;
const holds = (outer: Rect, inner: Rect): boolean => outer.x <= inner.x + 1e-6 && right(outer) >= right(inner) - 1e-6 && outer.y <= inner.y + 1e-6 && bottom(outer) >= bottom(inner) - 1e-6;
const frameOf = (model: LayoutModel, id: string) => model.frames!.find(frame => frame.id === id)!;

describe('canton frames and the unit (canton-groups ticket 2)', () => {
  it('a canton is a frame of kind canton that holds every member frame; each member is a frame', async () => {
    const model = await run('a-canton-group-frames-two-tiers');
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const west = frameOf(model, 'west'), site = frameOf(model, 'site'), clients = frameOf(model, 'clients');
    expect(west).toMatchObject({ kind: 'canton', cells: [] });
    expect(site.parent).toBe('west');
    expect(clients.parent).toBe('west');
    expect(site.kind).toBeUndefined();
    // A canton is a frame, not a layout group; its members are frames of cells.
    expect(model.groups['west']).toBeUndefined();
    expect(site.cells).toEqual(['site#0', 'site#1']);
    expect(clients.cells).toEqual(['clients#0']);
    expect(model.groups['clients#0']!.nodes).toEqual(['cl']);
    // The canton frame is the union of its member frames grown by group padding.
    expect(holds(west.box, site.box)).toBe(true);
    expect(holds(west.box, clients.box)).toBe(true);
    const union = { x: Math.min(site.box.x, clients.box.x), y: Math.min(site.box.y, clients.box.y) };
    expect(west.box.x).toBeCloseTo(union.x - 20, 6);
    expect(west.box.y).toBeCloseTo(union.y - 20, 6);
    expect(right(west.box)).toBeCloseTo(Math.max(right(site.box), right(clients.box)) + 20, 6);
    expect(bottom(west.box)).toBeCloseTo(Math.max(bottom(site.box), bottom(clients.box)) + 20, 6);
    // Members on distinct tiers stand on the canton axis (Section 2 rule 4).
    expect(Math.abs(centreX(clients.box) - centreX(site.box))).toBeLessThan(2);
    expect(Math.abs(centreX(site.box) - centreX(west.box))).toBeLessThan(2);
    expect(west.tier).toBe(site.tier);
    // No canton title yet, and so no unhosted-title warning.
    expect(model.diagnostics.map(d => d.code)).not.toContain('FRAME_TITLE_UNHOSTED');
    const report = score(model);
    expect(report.snapshot.gates.G9.violations).toEqual([]);
    expect(report.snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  it('two members of one tier stand beside each other, 40 px apart, in declaration order', async () => {
    const model = await run('a-canton-holds-two-members-on-one-tier');
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const alpha = frameOf(model, 'alpha'), beta = frameOf(model, 'beta'), lab = frameOf(model, 'lab'), west = frameOf(model, 'west');
    // A `row` member is a one-cell frame too.
    expect(beta.cells).toEqual(['beta#0']);
    expect(alpha.parent).toBe('west');
    expect(beta.parent).toBe('west');
    expect(alpha.box.x).toBeLessThan(beta.box.x);
    expect(beta.box.x - right(alpha.box)).toBeCloseTo(40, 3);
    expect(Math.abs(centreX(lab.box) - (alpha.box.x + right(beta.box)) / 2)).toBeLessThan(2);
    expect(holds(west.box, alpha.box) && holds(west.box, beta.box) && holds(west.box, lab.box)).toBe(true);
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  it('two cantons are disjoint columns a band gap plus two slacks apart at rows time', async () => {
    const model = await run('two-canton-groups-are-disjoint-columns');
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const west = frameOf(model, 'west'), east = frameOf(model, 'east');
    expect(west.kind).toBe('canton');
    expect(east.kind).toBe('canton');
    expect(frameOf(model, 'w-site').parent).toBe('west');
    expect(frameOf(model, 'e-lab').parent).toBe('east');
    const [left, next] = west.box.x <= east.box.x ? [west, east] : [east, west];
    // Finished layout: the cantons stand at least a band gap apart.
    expect(next.box.x - right(left.box)).toBeGreaterThanOrEqual(bandGap(model) - 1e-6);
    for (const [member, canton] of [['w-site', west], ['w-lab', west], ['e-site', east], ['e-lab', east]] as const) {
      expect(holds(canton.box, frameOf(model, member).box), `${member} inside ${canton.id}`).toBe(true);
    }
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  it('an anchor tier inside the canton span keeps the members centred and G9 clean', async () => {
    const model = await run('an-anchor-tier-inside-a-canton-span');
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const west = frameOf(model, 'west');
    for (const id of ['edge', 'core', 'lab']) {
      expect(frameOf(model, id).parent).toBe('west');
      expect(Math.abs(centreX(frameOf(model, id).box) - centreX(west.box)), `${id} on the canton axis`).toBeLessThan(2);
    }
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  it('G9 fails when a member frame lies outside its canton frame (negative test on a clone)', async () => {
    const model = await run('a-canton-group-frames-two-tiers');
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
    const broken = structuredClone(model);
    const clients = broken.frames!.find(frame => frame.id === 'clients')!;
    clients.box.x += 2000;
    const violations = score(broken).snapshot.gates.G9.violations;
    expect(score(broken).snapshot.gates.G9.passed).toBe(false);
    expect(violations).toContainEqual(expect.objectContaining({ code: 'frame-contains', elements: ['west', 'clients'] }));
  }, 60000);

  it('a grandchild does not overlap-fail against a canton, and a child frame stays inside its member', async () => {
    const source = fixture('a-canton-group-frames-two-tiers').replace('  clients: {', '  zone: { parent: site, label: Zone }\n  clients: {')
      .replace('  cl: {', '  z1: { group: zone, class: access, label: Zone access }\n  cl: {').replace('  - { from: srv', '  - [srv, z1]\n  - { from: srv');
    const model = await layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(frameOf(model, 'zone').parent).toBe('site');
    expect(holds(frameOf(model, 'west').box, frameOf(model, 'zone').box)).toBe(true);
    expect(score(model).snapshot.gates.G9.violations).toEqual([]);
  }, 60000);

  it('the canton frame is drawn in the SVG and in the drawio output', async () => {
    const model = await run('a-canton-group-frames-two-tiers');
    const west = frameOf(model, 'west');
    const svg = render(model);
    expect(svg).toContain('data-id="west"');
    expect(svg).toContain(`width="${west.box.width}"`);
    const xml = drawio(model);
    expect(xml).toMatch(/id="[^"]*west/);
  }, 60000);

  it('at rows time the canton frames stand a band gap plus two column slacks apart', async () => {
    const model = await rows(await placed(fixture('two-canton-groups-are-disjoint-columns')));
    const frames = deriveFrames(model)!, west = frames.find(frame => frame.id === 'west')!, east = frames.find(frame => frame.id === 'east')!;
    const [left, next] = west.box.x <= east.box.x ? [west, east] : [east, west];
    expect(next.box.x - right(left.box)).toBeCloseTo(bandGap(model) + 2 * 20, 3);
    for (const member of ['w-site', 'w-lab', 'e-site', 'e-lab']) {
      const box = frames.find(frame => frame.id === member)!.box, canton = frames.find(frame => frame.id === (member.startsWith('w') ? 'west' : 'east'))!;
      expect(holds(canton.box, box)).toBe(true);
    }
  }, 60000);

  // `placed` runs the stages after the pack (alignment moves a cell up to 12 px, ticket 29), so the bound is 12 px.
  it('members on distinct tiers stand on the canton axis when the placement is done', async () => {
    const model = await placed(fixture('two-canton-groups-are-disjoint-columns'));
    const frames = deriveFrames(model)!, byId = (id: string) => frames.find(frame => frame.id === id)!;
    for (const [member, canton] of [['w-site', 'west'], ['w-lab', 'west'], ['e-site', 'east'], ['e-lab', 'east']] as const) {
      expect(Math.abs(centreX(byId(member).box) - centreX(byId(canton).box)), `${member} on the axis of ${canton}`).toBeLessThan(12);
    }
  }, 60000);
});

describe('a canton entry never survives stage 1 (ticket 54 review, B1)', () => {
  it('a canton whose members hold no node lays out; the entry is dropped and no frame stands', async () => {
    // Parse refuses a nodeless member (CANTON_MEMBER_EMPTY); the layout must not crash on one that got through.
    const doc = parse(fixture('a-canton-group-frames-two-tiers'));
    for (const [id, node] of Object.entries(doc.nodes)) if (node.group === 'site' || node.group === 'clients') delete doc.nodes[id];
    doc.links = [];
    const model = await layout(doc, { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(model.document.groups['west']).toBeUndefined();
    expect(model.frames ?? []).toEqual([]);
  }, 60000);
});
