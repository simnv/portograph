import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { bands } from '../../src/layout/bands.js';
import { measureSides, type SideOffer } from '../../src/layout/side-measure.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 15, phase 3b: the side round reads the offer of the unmoved 7f baseline when a kept 7f move removed it. The settled copy that 7f
 * judged its first move against is only a filter (the round-0 state plus one settle; no later round, no held-axis or reseat pass): when it offers nothing the
 * trial is skipped, and when it offers something the true baseline is rebuilt with `bands(…, moves = false)` and the trial starts from the rebuilt offer.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

interface Offer { ev: string; offer: SideOffer; kept7e: LayoutModel; unmoved: boolean; filtered: boolean | undefined }

// `a-cross-link-with-another-label-keeps-two-buses` took this path too until architecture-2 ticket 23 (the overlay ports of a face nest
// at the end of 7f): its side trace has no offer from the unmoved baseline any more, so it tests nothing here.
it.each([
  'an-overlay-that-7f-straightens-needs-more-than-four-pixels-of-slack',
])('the filter passes and the trial starts from the rebuilt baseline offer: %s', async name => {
  const offers: Offer[] = [];
  await layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    testSideTrace: (event: Record<string, unknown>) => { if (event.ev === 'offer') offers.push(event as unknown as Offer); } } as never);
  const found = offers.find(item => item.unmoved);
  expect(found).toBeDefined();
  expect(found!.filtered).toBe(true);
  const rebuilt = measureSides(bands(found!.kept7e, undefined, undefined, false), found!.kept7e, new Set());
  expect([...found!.offer.hints]).toEqual([...rebuilt.hints]);
  expect([...found!.offer.promised]).toEqual([...rebuilt.promised]);
}, 120000);
