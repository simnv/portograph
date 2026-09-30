import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { labelRuns, LINK_LABEL_GEOMETRY } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 142 (docs/design/side-faces.md, Section 19.12, note 5): a lane link's label stands on the whole vertical run. */
const NAME = 'a-side-lane-label-spans-the-collinear-pieces';
const run = (): Promise<LayoutModel> => layout(parse(readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8')),
  { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const length = (s: { from: { x: number; y: number }; to: { x: number; y: number } }): number => Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);

describe('a side-lane link label stands on the run whose room was reserved (ticket 142)', () => {
  it('is whole, and supported by every collinear piece of the vertical run', async () => {
    const model = await run();
    const link = model.links.find(item => item.fixedSegments !== undefined)!, segments = link.path!.segments;
    const label = model.labels.find(item => item.owner.kind === 'link' && item.owner.id === link.id)!;
    const text = model.document.links[link.sourceIndex]!.label!;
    const need = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
    // The fixture: the text is longer than every single piece and than the side run, and shorter than the run.
    const pieces = segments.filter(s => Math.abs(s.to.x - s.from.x) < 1e-6), side = segments[segments.length - 1]!;
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const piece of [...pieces, side]) expect(length(piece)).toBeLessThan(need);
    expect(pieces.reduce((sum, s) => sum + length(s), 0)).toBeGreaterThanOrEqual(need - 1e-6);
    expect(label.text).toBe(text);
    expect(label.omitted).toBeUndefined();
    expect(model.diagnostics.some(item => item.code === 'LINK_LABEL_SHORTENED' || item.code === 'LINK_LABEL_OMITTED')).toBe(false);
    expect(label.textRotation).toBe(LINK_LABEL_GEOMETRY.verticalRotation);
    const first = segments.indexOf(pieces[0]!), last = segments.indexOf(pieces[pieces.length - 1]!);
    expect(label.support).toEqual({ kind: 'link-segment', link: link.id, segment: first, through: last });
    // The box stands beside the vertical run, inside the run's extent.
    const x = pieces[0]!.from.x, top = Math.min(...pieces.map(s => Math.min(s.from.y, s.to.y))), bottom = Math.max(...pieces.map(s => Math.max(s.from.y, s.to.y)));
    expect(label.bounds!.y).toBeGreaterThanOrEqual(top - 1e-6);
    expect(label.bounds!.y + label.bounds!.height).toBeLessThanOrEqual(bottom + 1e-6);
    expect(label.bounds!.x + label.bounds!.width <= x || label.bounds!.x >= x).toBe(true);
    // The gates read the merged support: G3 passes.
    expect(score(model).snapshot.gates['G3']?.passed).toBe(true);
  }, 120000);

  it('merges only collinear consecutive pieces of a link that holds a lane piece', () => {
    const owner = { kind: 'link' as const, id: 'l' };
    const seg = (x1: number, y1: number, x2: number, y2: number, lane?: string) => ({ from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, owner, ...(lane ? { lane } : {}) });
    const path = [seg(0, 0, 0, 10), seg(0, 10, 0, 50, 'a'), seg(0, 50, 0, 60, 'a'), seg(0, 60, -5, 60, 'a')];
    expect(labelRuns(path).map(item => [item.first, item.last])).toEqual([[0, 2], [3, 3]]);
    expect(labelRuns(path.map(item => ({ from: item.from, to: item.to, owner: item.owner }))).map(item => [item.first, item.last])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
    // A reversal is not collinear continuation.
    expect(labelRuns([seg(0, 0, 0, 10, 'a'), seg(0, 10, 0, 0, 'a')]).map(item => [item.first, item.last])).toEqual([[0, 0], [1, 1]]);
  });
});
