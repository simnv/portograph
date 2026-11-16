import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 17: the rows rule shifts a non-row group vertically and no more. The transaction rebuilds every box from its nodes, which writes an
 * unmoved width as `(x + width) - x`, one ULP off; the check reads x, width and height within the placement tolerance, as it does for a flank.
 */
const NAME = 'an-unmoved-grid-group-rebuilt-one-ulp-wide-is-no-rows-change';
const text = readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8');

describe('the rows rule and a grid group the rebuild leaves one ULP off', () => {
  it('lays the sheet out, keeps every link and passes every gate', async () => {
    const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.links.filter(link => link.removed)).toEqual([]);
    const gates = Object.entries(score(model).snapshot.gates).flatMap(([id, gate]) => gate.violations.map(item => `${id}:${item.code}`));
    expect(gates).toEqual([]);
  });
});
