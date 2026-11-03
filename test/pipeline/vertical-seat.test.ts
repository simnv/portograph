import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { findPort } from '../../src/layout/row-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 65: a feed that owes a vertical keeps a vertical it has reached. A centring step that would stand fewer verticals than it found
 * keeps the geometry it found; a frame chord takes the parent-port move before the freeze; one settle of the centring follows the 7f rounds; a step
 * leaves no held chord under the chord clearance where it stood clear; a face the clamp left a fraction off its feeds is snapped onto them.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const bends = (model: LayoutModel): number => { const { routed, overlay } = score(model).snapshot.counts; return routed.turns + overlay.turns; };
const violations = (model: LayoutModel, gate: 'G6'): number => score(model).snapshot.gates[gate].violations.length;
const count = (model: LayoutModel, code: string): number => model.diagnostics.filter(item => item.code === code).length;
/** How far the two ports of a link stand apart in x. */
const lean = (model: LayoutModel, id: string): number => {
  const link = model.links.find(item => item.id === id)!;
  return Math.abs(findPort(model, link.attachments!.from)!.anchor!.x - findPort(model, link.attachments!.to)!.anchor!.x);
};
/** The document with its `links` (or `nodes`) entries in reverse order. */
const reversed = (text: string, key: 'links' | 'nodes'): string => {
  const lines = text.split('\n'), start = lines.indexOf(`${key}:`);
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith('  ')) end++;
  return [...lines.slice(0, start + 1), ...lines.slice(start + 1, end).reverse(), ...lines.slice(end)].join('\n');
};

describe('a step keeps the vertical it reached', () => {
  const text = source('a-step-keeps-the-vertical-it-reached');
  it('keeps link-11 vertical once reached: 8 bends, one gap growth, no gap short', async () => {
    const model = await run(text);
    expect(lean(model, 'link-11')).toBeLessThanOrEqual(0.5);
    expect(bends(model)).toBe(8);
    expect(count(model, 'TIER_GAP_GROWN')).toBe(1);
    expect(count(model, 'TIER_GAP_PART_UNFIT')).toBe(0);
    expect(count(model, 'TIER_GAP_SOLVE_SHORT')).toBe(0);
  }, 120000);
  it('keeps the feed of zone3-wan1 vertical on reversed links and reversed nodes (R3)', async () => {
    const texts = [text, reversed(text, 'links'), reversed(text, 'nodes')];
    expect(new Set(texts).size).toBe(3);
    // The stages before the centring read the input order (ELK), so the three layouts differ: measured on main before ticket 65, 12, 10 and 8 bends,
    // and here 8, 10 and 8. What the step decides is the same on each: the feed it reached stays vertical. The link ids follow the document order, so
    // the link is found by its ends.
    for (const model of await Promise.all(texts.map(run))) {
      const link = model.links.find(item => [item.attachments!.from.node, item.attachments!.to.node].sort().join('-') === 'edge-cloud-zone3-wan1')!;
      expect(lean(model, link.id)).toBeLessThanOrEqual(0.5);
      expect(bends(model)).toBeLessThanOrEqual(10);
    }
  }, 240000);
});

describe('a frame chord stands over its child before the freeze (ticket 55)', () => {
  it('holds link-2 as a chord with no lean', async () => {
    const model = await run(source('drawio-nested-groups'));
    expect(model.frozenChords).toContain('link-2');
    // Bends cannot see a lean: a chord is one segment at any angle.
    expect(lean(model, 'link-2')).toBeLessThanOrEqual(0.5);
  }, 120000);
});

describe('the settle after the 7f rounds and the kept verticals', () => {
  it('holds link-28 of a-band-holds-the-group-that-set-its-edge as a chord', async () => {
    const model = await run(source('a-band-holds-the-group-that-set-its-edge'));
    expect(model.frozenChords).toContain('link-28');
  }, 180000);
  it('leaves the transit port of src0 on its lane in a-group-shift-leaves-a-chord-clear-of-a-lane (5 bends)', async () => {
    const model = await run(source('a-group-shift-leaves-a-chord-clear-of-a-lane'));
    expect(bends(model)).toBe(5);
    const link = model.links.find(item => item.id === 'link-12')!;
    const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-12')!;
    expect(findPort(model, link.attachments!.from)!.anchor!.x).toBeCloseTo(lane.x, 6);
    expect(lane.x).toBeCloseTo(93, 6);
  }, 120000);
  it('keeps a-face-aligns-one-port-and-leaves-a-chord-port-in-place at no more than one G6 and 12 bends (the chord clearance)', async () => {
    const model = await run(source('a-face-aligns-one-port-and-leaves-a-chord-port-in-place'));
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
