import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { bands } from '../../src/layout/bands.js';
import { measureSides, type SideOffer } from '../../src/layout/side-measure.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 15, phase 3b: the side round reads the offer of the unmoved 7f baseline when a kept 7f move removed it. The state is the settled
 * copy 7f judged its first move against, kept by the attempt; the pipeline rebuilds it with `bands(…, moves = false)` only when that copy is absent.
 * The reused state must give the same offer as the rebuild.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

interface Offer { ev: string; offer: SideOffer; kept7e: LayoutModel; unmoved: boolean; reused: boolean }

it.each([
  'a-cross-link-with-another-label-keeps-two-buses',
  'an-overlay-that-7f-straightens-needs-more-than-four-pixels-of-slack',
])('the reused unmoved state offers what the rebuilt one offers: %s', async name => {
  const offers: Offer[] = [];
  await layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    testSideTrace: (event: Record<string, unknown>) => { if (event.ev === 'offer') offers.push(event as unknown as Offer); } } as never);
  const found = offers.find(item => item.unmoved);
  expect(found).toBeDefined();
  expect(found!.reused).toBe(true);
  const rebuilt = measureSides(bands(found!.kept7e, undefined, undefined, false), found!.kept7e, new Set());
  expect([...found!.offer.hints]).toEqual([...rebuilt.hints]);
  expect([...found!.offer.promised]).toEqual([...rebuilt.promised]);
}, 120000);
