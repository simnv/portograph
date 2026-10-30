import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutOptions } from '../../src/index.js';
import { ElkDeadlineError } from '../../src/layout/elk-worker.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture 2, ticket 04: the span round answers the placement's own refusals (`PlacementRefusal`) and nothing else. A defect (a TypeError) and an ELK deadline, in the
 * trial's placement or in its judge, end the command; main refused such a trial silently as `error`.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const SHEET = 'a-chord-and-a-lane-share-a-middle-tier';

/**
 * A span lane that contradicts its chord, forged inside the span trial: while `skew.on` is set, each replay of a span lane (`replaySpanLane`) stands
 * the lane 1 px off the corridor its chord derives, so the lane validator (`validateSpanLane`) refuses the trial's placement.
 */
const skew = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/layout/span-lanes.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/span-lanes.js')>();
  return { ...original, replaySpanLane: (...args: Parameters<typeof original.replaySpanLane>): boolean => {
    const placed = original.replaySpanLane(...args);
    if (placed && skew.on) { const [, lane] = args; lane.x += 1; lane.bounds = { ...lane.bounds, x: lane.bounds.x + 1 }; }
    return placed;
  } };
});

/** Layout options that call `fault` at the first moment inside the span trial: after the span round has an offer, `place` and the judge are the span's. */
const MESH = 'a-mesh-across-a-middle-tier-draws-straight-chords-beside-its-frame';
const faulty = (fault: (where: 'place' | 'elk' | 'judge') => void): LayoutOptions => {
  let armed = false;
  return {
    createRouteAttempt: createAvoidAttempt,
    createElkAttempt: () => { if (armed) fault('elk'); return createAttempt(); },
    onProgress: progress => { if (armed && progress.stage === 'sides-two') fault('place'); },
    testSideTrace: event => {
      if (event.ev === 'spans' && ((event.offer as { links: string[] }).links.length > 0)) armed = true;
      if (event.ev === 'span-trial') fault('judge');
    },
  };
};

describe('the span round and the errors it does not own', () => {
  it('lets a TypeError inside the trial placement end the command', async () => {
    await expect(layout(parse(source(SHEET)), faulty(where => { if (where === 'place') throw new TypeError('injected defect'); }))).rejects.toThrow(TypeError);
  }, 60000);

  it('lets an ELK deadline inside the trial placement end the command', async () => {
    await expect(layout(parse(source(SHEET)), faulty(where => { if (where === 'elk') throw new ElkDeadlineError(1); }))).rejects.toThrow(ElkDeadlineError);
  }, 60000);

  it('lets a TypeError in the judge of the trial end the command', async () => {
    await expect(layout(parse(source(MESH)), faulty(where => { if (where === 'judge') throw new TypeError('injected defect'); }))).rejects.toThrow(TypeError);
  }, 60000);

  it('refuses a trial whose ELK attempt fails (the fallback run is a typed refusal), and still publishes a layout', async () => {
    const refused: string[] = [];
    let armed = false, attempts = 0;
    const model = await layout(parse(source(SHEET)), { createRouteAttempt: createAvoidAttempt,
      createElkAttempt: () => { if (armed && ++attempts === 1) throw new (class extends Error {})('x'); return createAttempt(); },
      testSideTrace: event => {
        if (event.ev === 'spans' && ((event.offer as { links: string[] }).links.length > 0)) armed = true;
        if (event.ev === 'span-refused') refused.push(String(event.why));
      } });
    // The factory error becomes the ELK fallback, and the round refuses a trial that used it.
    expect(model.links.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
  }, 60000);

  // The contradiction is forged (snack-theme ticket 157). The sheet produced one by itself: its lane extents were replayed before the node geometry
  // rebuilt the port pills, which the corridor reads, so a lane stood where the old pill put it. The replay now follows the pills (b1ab0774, ticket 157,
  // "lane extents replay on the pills the node geometry rebuilds"), and that lane agrees with its chord. Measured on 2026-10-31: the unforged test passes
  // with the src of b1ab0774~1 and fails with the src of 82f80e67 (the span trial is refused only for a wall in the corridor of link-1); no ticket 159 fix
  // is involved. The rule pinned here is unchanged: a span lane that contradicts its chord is a typed refusal of the trial, and the sheet
  // still publishes, without the span.
  it('refuses a trial whose span lane contradicts its chord (a typed refusal of the lane validator) and publishes the sheet', async () => {
    const refused: string[] = [];
    let model;
    try {
      model = await layout(parse(source('a-tier-gap-grows-to-its-rows')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
        testSideTrace: event => {
          if (event.ev === 'spans' && ((event.offer as { links: string[] }).links.length > 0)) skew.on = true;
          if (event.ev === 'span-refused') { skew.on = false; refused.push(String(event.detail)); }
        } });
    } finally { skew.on = false; }
    expect(model.links.length).toBeGreaterThan(0);
    expect(refused.some(detail => detail.includes('contradicts the chord'))).toBe(true);
    expect(model.lanes.some(lane => lane.kind === 'span')).toBe(false);
  }, 60000);
});
