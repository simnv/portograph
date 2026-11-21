import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { FLAT_PREMISE, flatBlockGapsFault, unheldFlatBlocks } from '../../src/layout/placement-inputs.js';
import { postconditionSink, postconditionViolations, type PostconditionViolation } from '../../src/layout/postconditions.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Field 2026-11 ticket 01: the input `flatBlockGaps` is copied unchanged into every placement run, and each run decides the mode of its blocks
// again from its own geometry. A round trial that takes a block of the input under the cap is refused at 7e by name, not published.
const text = readFileSync(new URL('../../goldens/synthetic/a-round-that-takes-a-flat-block-under-the-cap-is-withdrawn.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const ASPECTS = ['3:2', '16:9', '2:1', '21:10', '23:10', '5:2', '3:1'];
const at = (aspect: string): string => text.replace('layout: {aspect: "23:10"}', `layout: {aspect: "${aspect}"}`);

afterEach(() => { delete postconditionSink.hook; });

describe('a round trial that takes a flat block under the cap is withdrawn (field 2026-11 ticket 01)', () => {
  it.each(ASPECTS)('publishes at %s with every flat-gap entry on a flat block, no removed link, and restores', async aspect => {
    const model = await layout(parse(at(aspect)), options);
    expect(unheldFlatBlocks(model)).toEqual([]);
    expect(flatBlockGapsFault(model)).toBeUndefined();
    expect(model.diagnostics.filter(item => / was removed/.test(item.message)).map(item => item.message)).toEqual([]);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  });

  it('refuses the trial at its producer boundary, by the premise, at 23:10', async () => {
    const found: PostconditionViolation[] = [];
    postconditionSink.hook = violation => { if (violation.kind === FLAT_PREMISE) found.push(violation); };
    const model = await layout(parse(text), options);
    // The trial took pod-6 under the cap; the published placement holds pod-6 flat.
    expect(found.map(item => [item.rule, item.subject])).toContainEqual(['bundles', 'block:pod-6:0:']);
    expect(model.flatBlockGaps?.map(item => item.family)).toContain('block:pod-6:0:');
    expect(model.blockReservations?.find(item => item.family === 'block:pod-6:0:')?.mode).toBe('flat');
  });
});

describe('the flat-block premise is one reader (R1, R5)', () => {
  let model: LayoutModel;
  const draft = async (): Promise<LayoutModel> => (model ??= await layout(parse(text), options));

  it('names a block of the input that the records hold under the cap, and a block with no record and no decline', async () => {
    const copy = structuredClone(await draft());
    const record = copy.blockReservations!.find(item => item.family === 'block:pod-6:0:')!;
    delete record.mode; delete record.floor;
    expect(unheldFlatBlocks(copy)).toEqual(['block:pod-6:0:']);
    expect(flatBlockGapsFault(copy)).toMatch(/block:pod-6:0: names no flat block/);
    expect(postconditionViolations(await draft(), copy, 'bundles').filter(item => item.kind === FLAT_PREMISE).map(item => item.subject)).toEqual(['block:pod-6:0:']);
    // The same restore check refuses the forged model (the validator reads the record, not a diagnostic).
    expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow(/flatBlockGaps/);
    const gone = structuredClone(await draft());
    gone.blockReservations = gone.blockReservations!.filter(item => item.family !== 'block:pod-1:0:');
    expect(unheldFlatBlocks(gone)).toEqual(['block:pod-1:0:']);
  });

  it('holds a block a later probe declined, and judges nothing before the record owner ran', async () => {
    const declined = structuredClone(await draft());
    declined.blockReservations = declined.blockReservations!.filter(item => item.family !== 'block:pod-1:0:');
    declined.declinedSolidBlocks = [...(declined.declinedSolidBlocks ?? []), { family: 'block:pod-1:0:', reason: 'a controlled refusal' }];
    expect(unheldFlatBlocks(declined)).toEqual([]);
    const early = structuredClone(await draft());
    delete early.blockReservations;
    expect(unheldFlatBlocks(early)).toEqual([]);
    expect(unheldFlatBlocks(await draft(), false)).toEqual([]);
  });
});
