import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * A seat that a later rule withdraws names the alignment it opens (dense-16x9 ticket 02, ADR-0027; ticket 75). While a seat stands, its body
 * pulls only through its kept feeds, so a feed it left out is not open; when the seat is withdrawn the replay reads every feed again. The open
 * alignments are named on the record the rule publishes, after the withdrawal, so the record and its replay read one seat record (R1).
 */
const NAME = 'a-withdrawn-seat-names-the-alignment-it-opens';
const source = readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8');

describe('a withdrawn seat names the alignment it opens', () => {
  it('publishes, names link-1 and link-2 open, and restores', async () => {
    const model = await layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.alignmentSeats?.['n1']).toBeUndefined();
    const open = model.diagnostics.filter(item => item.code === 'CENTRE_ALIGNMENT_OPEN').flatMap(item => (item.owners ?? []).flatMap(owner => owner.kind === 'link' ? [owner.id] : []));
    expect(open).toEqual(expect.arrayContaining(['link-1', 'link-2']));
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 120000);
});
