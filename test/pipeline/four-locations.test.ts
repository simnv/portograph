import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/index.js';
import { layout, parse, render, score } from '../../src/index.js';
import { separateFrameColumns } from '../../src/layout/columns.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { rows } from '../../src/layout/rows.js';
import { placed } from '../layout/phase-two-fixture.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const overlaps = (a: Rect, b: Rect): boolean => a.x < right(b) - 1e-6 && b.x < right(a) - 1e-6 && a.y < bottom(b) - 1e-6 && b.y < bottom(a) - 1e-6;

const placedThroughRows = async (yaml: string) => rows(await placed(yaml));

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

  it('a second column pass on the separated model moves nothing', async () => {
    const model = await placedThroughRows(fixture('four-locations-each-with-a-zone'));
    const again = structuredClone(model);
    // Rows runs its repack twice and bundles once, and a replay must not move by float dust: put every
    // frame but the leftmost 1e-9 px short of where the pass left it, as a rounding error would.
    const tops = again.frames!.filter(frame => frame.parent === undefined).sort((a, b) => a.box.x - b.box.x);
    for (const frame of tops.slice(1)) {
      const ids = new Set(again.frames!.filter(item => item.id === frame.id || item.parent === frame.id).flatMap(item => item.cells));
      for (const id of ids) moveGroup(again, again.groups[id]!, -1e-9, 0);
    }
    expect(separateFrameColumns(again)).toBe(false);
    for (const [id, group] of Object.entries(again.groups)) expect(Math.abs(group.bounds!.x - model.groups[id]!.bounds!.x), id).toBeLessThan(1e-6);
  }, 60000);
});
