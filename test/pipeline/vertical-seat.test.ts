import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { findPort } from '../../src/layout/row-paths.js';
import { chordNearPairs } from '../../src/layout/frame-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder, withoutJointOrderOn } from '../layout/joint-off.js';
import { reversed } from '../../scripts/r3-lib.mjs';

/**
 * Architecture-2 ticket 65: a feed that owes a vertical keeps a vertical it has reached. A centring step that would stand fewer verticals than it found
 * keeps the geometry it found; a frame chord takes the parent-port move before the freeze; one settle of the centring follows the 7f rounds; a step
 * leaves no held chord under the chord clearance where it stood clear; a face the clamp left a fraction off its feeds is snapped onto them.
 */
const source = (name: string): string => withoutJointOrderOn(name, readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
const pinned = (name: string): string => withoutJointOrder(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const bends = (model: LayoutModel): number => { const { routed, overlay } = score(model).snapshot.counts; return routed.turns + overlay.turns; };
const violations = (model: LayoutModel, gate: 'G6'): number => score(model).snapshot.gates[gate].violations.length;
const count = (model: LayoutModel, code: string): number => model.diagnostics.filter(item => item.code === code).length;
/** How far the two ports of a link stand apart in x. */
const lean = (model: LayoutModel, id: string): number => {
  const link = model.links.find(item => item.id === id)!;
  return Math.abs(findPort(model, link.attachments!.from)!.anchor!.x - findPort(model, link.attachments!.to)!.anchor!.x);
};

describe('a step keeps the vertical it reached', () => {
  const text = source('a-step-keeps-the-vertical-it-reached');
  it('keeps link-12 vertical once reached: 6 bends, one gap growth, no gap short', async () => {
    const model = await run(text);
    expect(lean(model, 'link-12')).toBeLessThanOrEqual(0.5);
    // 8 bends before ticket DR-04; in the canonical link order the sheet has 6.
    expect(bends(model)).toBe(6);
    expect(count(model, 'TIER_GAP_GROWN')).toBe(1);
    expect(count(model, 'TIER_GAP_PART_UNFIT')).toBe(0);
    expect(count(model, 'TIER_GAP_SOLVE_SHORT')).toBe(0);
  }, 120000);
  it('keeps the feed of zone3-wan1 vertical on reversed links, and lays the sheet out with reversed nodes (R3)', async () => {
    const texts = [text, reversed(text, 'links'), reversed(text, 'nodes')];
    expect(new Set(texts).size).toBe(3);
    const [plain, links, nodes] = await Promise.all(texts.map(run));
    // Link order is never input (ticket DR-04), so the reversed links give the same layout, and the feed the step reached stays vertical in both.
    // The link is found by its ends.
    for (const model of [plain!, links!]) {
      const link = model.links.find(item => [item.attachments!.from.node, item.attachments!.to.node].sort().join('-') === 'edge-cloud-zone3-wan1')!;
      expect(lean(model, link.id)).toBeLessThanOrEqual(0.5);
      expect(bends(model)).toBeLessThanOrEqual(10);
    }
    // The order of the nodes inside a group is no meaningful order (decision review D-Q1, revised by the roworder PoC): `nodes` reversed is
    // gated on feasibility only. The sheet publishes, nothing refuses it, and no link is removed; the feed of zone3-wan1 may lean there.
    expect(nodes!.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(nodes!.removedLinks ?? []).toEqual([]);
    for (const link of nodes!.links) expect([link.id, (link.path?.segments.length ?? 0) > 0]).toEqual([link.id, true]);
  }, 240000);
});

describe('a frame chord stands over its child before the freeze (ticket 55)', () => {
  it('holds link-3 as a chord with no lean', async () => {
    const model = await run(source('drawio-nested-groups'));
    expect(model.frozenChords).toContain('link-3');
    // Bends cannot see a lean: a chord is one segment at any angle.
    expect(lean(model, 'link-3')).toBeLessThanOrEqual(0.5);
  }, 120000);
});

describe('the chord clearance reader (chordNearPairs)', () => {
  it('names a foreign body moved next to a held chord, and only a pair the move can change', async () => {
    const model = await run(source('drawio-nested-groups'));
    const link = model.links.find(item => item.id === 'link-3')!;
    const ends = new Set([link.attachments!.from.node, link.attachments!.to.node]);
    const foreign = Object.keys(model.nodes).find(id => !ends.has(id))!;
    expect(chordNearPairs(model, new Set([foreign])).has(`link-3@${foreign}`)).toBe(false);
    // The body moved to stand 4 px beside the middle of the chord, under the 10 px clearance.
    const one = findPort(model, link.attachments!.from)!.anchor!, two = findPort(model, link.attachments!.to)!.anchor!;
    const box = model.nodes[foreign]!.bounds!;
    const moved = { ...model, nodes: { ...model.nodes, [foreign]: { ...model.nodes[foreign]!, bounds: { ...box, x: (one.x + two.x) / 2 + 4, y: (one.y + two.y) / 2 - box.height / 2 } } } };
    expect(chordNearPairs(moved, new Set([foreign])).has(`link-3@${foreign}`)).toBe(true);
    // A move of no node changes no body pair: the pair is not read.
    expect(chordNearPairs(moved, new Set()).has(`link-3@${foreign}`)).toBe(false);
  }, 120000);
});

describe('the settle after the 7f rounds and the kept verticals', () => {
  it('holds link-29 of a-band-holds-the-group-that-set-its-edge as a chord', async () => {
    const model = await run(source('a-band-holds-the-group-that-set-its-edge'));
    expect(model.frozenChords).toContain('link-29');
  }, 180000);
  // Ticket DR-04: the two sheets below are the copies of `a-group-shift-leaves-a-chord-clear-of-a-lane` and
  // `a-face-aligns-one-port-and-leaves-a-chord-port-in-place` whose canonical link order gives each node its links in the written order. They are read with
  // the joint order off, as their originals are (`JOINT_REORDERED`).
  it('leaves the transit port of src0 on its lane in a-group-shift-leaves-a-chord-clear-of-a-lane (5 bends)', async () => {
    const model = await run(pinned('a-group-shift-leaves-a-chord-clear-of-a-lane-lower-groups-first'));
    expect(bends(model)).toBe(5);
    // src0 to snk1, the transit link.
    const link = model.links.find(item => item.id === 'link-12')!;
    const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-12')!;
    expect(findPort(model, link.attachments!.from)!.anchor!.x).toBeCloseTo(lane.x, 6);
    expect(lane.x).toBeCloseTo(93, 6);
  }, 120000);
  it('keeps a-face-aligns-one-port-and-leaves-a-chord-port-in-place at no more than one G6 and 12 bends (the chord clearance)', async () => {
    const model = await run(pinned('a-face-aligns-one-port-and-leaves-a-chord-port-in-place-lower-groups-first'));
    expect(violations(model, 'G6')).toBeLessThanOrEqual(1);
    expect(bends(model)).toBeLessThanOrEqual(12);
  }, 120000);
  it('snaps a face the clamp left a fraction off its feed: r2 to s3 of a-jogged-drop-beside-a-canton-title-stays-in-its-gap is one segment', async () => {
    const model = await run(source('a-jogged-drop-beside-a-canton-title-stays-in-its-gap'));
    const link = model.links.find(item => [item.attachments!.from.node, item.attachments!.to.node].sort().join('-') === 'r2-s3')!;
    expect(lean(model, link.id)).toBeLessThanOrEqual(1e-6);
    expect(link.path!.segments).toHaveLength(1);
  }, 120000);
});
