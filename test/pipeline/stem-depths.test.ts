import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, restoreFinalLayout } from '../../src/index.js';
import { validateGroupLabelBands } from '../../src/layout/bands.js';
import { stemDepth, stemDepthsFault } from '../../src/layout/sides-two.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 57, step 3: the stem depths of a nested node side are decided once, at the end of 7f, with no read of the tier
 * across the gap, and recorded (`stemDepths`). Stage 8, the plan and the validator read the record (R1); a forged record is refused (R5).
 * [] = decided, no side nests; absent = not decided (an older layout): the readers derive.
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('the stem depths are decided once and recorded (architecture-2 ticket 57)', () => {
  it('records the nested sides, and the readers take the record over a derivation', async () => {
    const model = await run(fixture('a-nested-tip-row-holds-no-allocated-row'));
    const record = model.stemDepths!;
    expect(record.length).toBeGreaterThan(0);
    expect(stemDepthsFault(model)).toBeUndefined();
    const entry = record[0]!, ref = entry.ports.find(item => item.depth > 15)!;
    const port = model.nodes[entry.node]!.ports.find(item => JSON.stringify(item.ref) === JSON.stringify(ref.port))!;
    expect(stemDepth(model, port)).toBe(ref.depth);
    // [] is a decision: no side nests, so every stem keeps its plain reach, whatever the geometry would derive.
    const none = structuredClone(model);
    none.stemDepths = [];
    expect(stemDepth(none, none.nodes[entry.node]!.ports.find(item => JSON.stringify(item.ref) === JSON.stringify(ref.port))!)).toBeLessThan(ref.depth);
    // Absent: not decided, the reader derives the same nesting from the geometry.
    const absent = structuredClone(model);
    delete absent.stemDepths;
    expect(stemDepth(absent, absent.nodes[entry.node]!.ports.find(item => JSON.stringify(item.ref) === JSON.stringify(ref.port))!)).toBe(ref.depth);
    expect(stemDepthsFault(absent)).toBeUndefined();
  }, 120000);

  it('records [] on a sheet where no side nests', async () => {
    const model = await run(fixture('a-tier-gap-grows-to-its-rows'));
    expect(model.stemDepths).toEqual([]);
    expect(stemDepthsFault(model)).toBeUndefined();
  }, 120000);

  it('a restore and the validator refuse a forged record (R5)', async () => {
    const model = await run(fixture('a-nested-tip-row-holds-no-allocated-row'));
    const json = JSON.stringify(model);
    const forged = (edit: (copy: LayoutModel) => void): LayoutModel => {
      const copy = JSON.parse(json) as LayoutModel; edit(copy);
      expect(() => restoreFinalLayout(JSON.stringify(copy))).toThrow();
      return copy;
    };
    const deeper = forged(copy => { copy.stemDepths![0]!.ports[0]!.depth += 17.5; });
    expect(() => validateGroupLabelBands(deeper)).toThrow(/stem depth record is forged/);
    const emptied = forged(copy => { copy.stemDepths = []; });
    expect(() => validateGroupLabelBands(emptied)).toThrow(/stem depth record is forged/);
    expect(stemDepthsFault({ ...model, stemDepths: 'x' as unknown as NonNullable<LayoutModel['stemDepths']> })).toMatch(/not a list/);
  }, 120000);
});
