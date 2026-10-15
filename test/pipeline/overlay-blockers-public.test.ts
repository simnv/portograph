import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, render } from '../../src/index.js';
import { overlayBlockers } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const NAME = 'synthetic/an-overlay-link-passes-over-a-middle-body-when-the-user-opts-in';
const yaml = readFileSync(new URL(`../../goldens/${NAME}.yaml`, import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('the public overlayBlockers index', () => {
  it('is the caller\'s own: adding to it changes no later layout', async () => {
    const first = await run();
    const before = render(first);
    // A rectangle over every body, added to a public index, must not reach the layout's own reads.
    const index = overlayBlockers(first);
    const huge = { x: -1e6, y: -1e6, width: 2e6, height: 2e6 };
    index.add(huge, huge);
    expect(overlayBlockers(first)).not.toBe(index);
    expect(render(await run())).toBe(before);
  }, 120000);
});
