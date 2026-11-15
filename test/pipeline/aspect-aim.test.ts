import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { pathBends } from '../../src/layout/objective.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { aspectGap } from '../../src/layout/aspect.js';
import { DEFAULT_ASPECT } from '../../src/model/index.js';
import { withAspect, withLayoutEntry } from '../aspect-fixture.js';

// ADR-0025, dense-16x9 ticket 03 slice A: stage 5 staggers a plain row only on a sheet wider than the aspect aim, and only toward it.
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
// The group lift (ticket 08) is off, as in `auto-stagger.test.ts`: a lift changes the canvas the stagger rules read.
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });
const lines = (model: LayoutModel, group: string): number => new Set(model.groups[group]!.nodes.map(id => model.nodes[id]!.bounds!.y)).size;
const failedGates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
const reason = (model: LayoutModel, group: string): string | undefined => {
  const entry = model.groupArrangements?.[group];
  return entry?.chosen === 'row' ? entry.reason : undefined;
};

const NARROW = 'a-row-on-a-sheet-narrower-than-the-aim-stays-one-line';
const OVERRIDE = 'a-document-aspect-overrides-the-aim';

describe('a plain row staggers only on a sheet wider than the aspect aim', () => {
  it('keeps one line on a sheet narrower than 16:9, and names the aim', async () => {
    const model = await run(source(NARROW));
    expect(model.canvas!.width / model.canvas!.height).toBeLessThan(DEFAULT_ASPECT);
    expect(model.staggerRows).toBeUndefined();
    expect(lines(model, 'leaves')).toBe(1);
    expect(reason(model, 'leaves')).toMatch(/^aspect: the sheet is [\d.]+ x [\d.]+ px, not wider than the aim 1\.778$/);
    for (const link of model.links.filter(item => item.layer === 'routed')) expect(pathBends(link), link.id).toBe(0);
    expect(failedGates(model)).toEqual([]);
  }, 60000);

  it('a document aspect overrides the aim: the same row staggers under 1:1 and keeps one line without it', async () => {
    const square = await run(source(OVERRIDE));
    expect(square.document.layout?.aspect).toBe(1);
    expect(square.groupArrangements!.leaves).toEqual({ chosen: 'stagger' });
    expect(lines(square, 'leaves')).toBe(2);
    for (const link of square.links.filter(item => item.layer === 'routed')) {
      expect(pathBends(link), link.id).toBe(0);
      for (const segment of link.path!.segments) expect(segment.from.x, link.id).toBeCloseTo(segment.to.x, 6);
    }
    expect(failedGates(square)).toEqual([]);
    expect(() => restoreLayoutModel(JSON.stringify(square))).not.toThrow();
    const plain = await run(source(OVERRIDE).replace('layout: { aspect: "1:1" }\n', ''));
    expect(plain.document.layout).toBeUndefined();
    expect(lines(plain, 'leaves')).toBe(1);
    expect(reason(plain, 'leaves')).toMatch(/^aspect: the sheet is [\d.]+ x [\d.]+ px, not wider than the aim 1\.778$/);
  }, 120000);

  it('staggers a plain row on a sheet wider than the aim when two lines come nearer it, with no override', async () => {
    const leaves = 20;
    const yaml = `portograph: 2
groups:
  top: { tier: 0 }
  feeds: { tier: 1 }
  leaves: { tier: 2 }
nodes:
  t: { group: top, class: router }
  p: { group: feeds, class: switch }
${Array.from({ length: leaves }, (_, i) => `  n${i + 1}: { group: leaves, class: server }`).join('\n')}
links:
  - [t, p]
${Array.from({ length: leaves }, (_, i) => `  - [p, n${i + 1}]`).join('\n')}
`;
    const model = await run(yaml);
    expect(model.groupArrangements!.leaves).toEqual({ chosen: 'stagger' });
    expect(lines(model, 'leaves')).toBe(2);
    const gap = (m: LayoutModel): number => aspectGap(m.canvas!.width, m.canvas!.height, DEFAULT_ASPECT);
    const one = await run(withLayoutEntry(yaml, 'autoArrange: false'));
    expect(one.canvas!.width / one.canvas!.height).toBeGreaterThan(DEFAULT_ASPECT);
    expect(gap(model)).toBeLessThan(gap(one));
    expect(failedGates(model)).toEqual([]);
  }, 120000);

  it('a stated 16:9 is the default: the layout does not change', async () => {
    const stated = await run(withAspect(source(NARROW), '16:9'));
    const absent = await run(source(NARROW));
    expect(stated.document.layout).toBeUndefined();
    expect(JSON.stringify(stated.nodes)).toBe(JSON.stringify(absent.nodes));
  }, 120000);

  it('does not follow the order of the links or of the nodes (R3)', async () => {
    const base = await run(source(OVERRIDE));
    for (const block of ['links', 'nodes'] as const) {
      const model = await run(reversed(source(OVERRIDE), block));
      expect(model.groupArrangements!.leaves, block).toEqual({ chosen: 'stagger' });
      expect(model.canvas, block).toEqual(base.canvas);
    }
  }, 120000);
});
