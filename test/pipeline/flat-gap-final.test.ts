import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { canvasExtent } from '../../src/layout/link-labels.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createEnv } from '../../src/pipeline/env.js';
import { firstState } from '../../src/pipeline/initial.js';
import { chooseFlatGapsAgain, drive, FLAT_BLOCK_GAP_FINAL, refuseCrowdedChords } from '../../src/pipeline/driver.js';
import { publish } from '../../src/pipeline/publish.js';
import { pathBends } from '../../src/layout/objective.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 42: an aspect choice reads the sheet it is judged by, after the last step that changes it.
const text = readFileSync(new URL('../../goldens/synthetic/a-flat-gap-is-chosen-again-after-the-fan-round.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const AIM = 3;
// The production bend reader (`pathBends`, review 1 P3): a link with no path is no straight link, so every link must have one.
const bent = (model: LayoutModel): string[] => model.links.filter(link => (pathBends(link) ?? Infinity) > 0).map(link => link.id);

describe('the flat-gap choice after the rounds', () => {
  it('publishes the sheet at the aim, every link straight, and restores', async () => {
    const model = await layout(parse(text), options);
    expect(model.canvas!.height).toBeCloseTo(model.canvas!.width / AIM, 1);
    expect(model.diagnostics.map(item => item.code)).toContain(FLAT_BLOCK_GAP_FINAL);
    expect(model.links.every(link => link.path !== undefined && link.path.segments.length > 0)).toBe(true);
    expect(bent(model)).toEqual([]);
    // The one reader reads the published sheet as stage 9 fitted it.
    const sheet = canvasExtent(model);
    expect(sheet.width).toBeCloseTo(model.canvas!.width, 6);
    expect(sheet.height).toBeCloseTo(model.canvas!.height, 6);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 120000);

  it('runs because the fan round changed the sheet after the first choice, and places once, outside the cap', async () => {
    const env = createEnv(parse(text), options);
    const state = await firstState(env);
    const first = state.flatGapSheet!;
    expect(first.height).toBeCloseTo(first.width / AIM, 1);
    const gap = (model: LayoutModel): number => { const [upper, lower] = [1, 2].map(tier => model.tierBands.find(band => band.tier === tier)!.bounds!); return lower!.y - upper!.y - upper!.height; };
    const was = gap((await env.bands(state.kept7e, true)).model);
    await drive(env, state);
    // The fan round kept pair floors: the core ports spread, the tier gap under the cores drops, and the sheet is lower than the first choice read.
    expect(state.kept.some(entry => entry.kind === 'pairFloor')).toBe(true);
    expect(gap(state.base)).toBeLessThan(was - 20);
    const after = canvasExtent(state.base);
    expect(first.height - after.height).toBeGreaterThan(20);
    await refuseCrowdedChords(env, state);
    const placements = env.placements, gateRuns = env.gateRuns;
    await chooseFlatGapsAgain(env, state);
    expect(state.sideNotes.map(item => item.code)).toContain(FLAT_BLOCK_GAP_FINAL);
    const published = (await publish(env, state)).canvas!;
    expect(published.height).toBeCloseTo(published.width / AIM, 1);
    expect(env.placements - placements).toBe(1);
    expect(env.gateRuns - gateRuns).toBe(1);
    expect(env.exemptPlacing ?? 0).toBe(0);
    // Its own result is read nowhere: a second call on the kept state places nothing.
    await chooseFlatGapsAgain(env, state);
    expect(env.placements - placements).toBe(1);
  }, 120000);
});
