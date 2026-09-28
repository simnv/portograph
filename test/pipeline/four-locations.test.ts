import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/index.js';
import { layout, parse, render, score } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const overlaps = (a: Rect, b: Rect): boolean => a.x < right(b) - 1e-6 && b.x < right(a) - 1e-6 && a.y < bottom(b) - 1e-6 && b.y < bottom(a) - 1e-6;

describe('four locations, each with a zone', () => {
  it('the frames stay disjoint columns, no frame holds a foreign node, G9 passes and the sheet renders', async () => {
    const model = await layout(parse(fixture('four-locations-each-with-a-zone')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const frames = model.frames!, tops = frames.filter(frame => frame.parent === undefined);
    expect(tops.map(frame => frame.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    const ownCells = (top: string): Set<string> => new Set(frames.filter(frame => frame.id === top || frame.parent === top).flatMap(frame => frame.cells));
    for (const [i, frame] of tops.entries()) {
      for (const other of tops.slice(i + 1)) expect(overlaps(frame.box, other.box), `${frame.id} and ${other.id} overlap`).toBe(false);
      const own = ownCells(frame.id);
      for (const group of Object.values(model.groups)) {
        if (own.has(group.id)) continue;
        for (const node of group.nodes) expect(overlaps(frame.box, model.nodes[node]!.bounds!), `${node} inside ${frame.id}`).toBe(false);
      }
    }
    const report = score(model);
    expect(report.snapshot.gates.G9.violations).toEqual([]);
    expect(report.snapshot.gates.G9.passed).toBe(true);
    expect(render(model)).toContain('<svg');
  }, 60000);

  it('a grid group of the same tier stands fixed: layout does not throw', async () => {
    const model = await layout(parse(fixture('a-grid-group-stands-fixed-beside-frames')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(model.groups.spares!.nodes).toEqual(['sp1', 'sp2']);
  }, 60000);
});
