import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, rebuildRowPaths } from '../../src/index.js';
import { centreContext, centreViolations } from '../../src/layout/centre.js';
import { chordKind, orthogonalLeg, withLinkFacts } from '../../src/layout/frame-paths.js';
import { findPort } from '../../src/layout/row-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 01. Two caches that must not change output: the centring context shared by the verification trials of
 * `centreViolations`, and the `chordKind` / `orthogonalLeg` cache scoped to one `rebuildRowPaths` call.
 */
const golden = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = async (name: string): Promise<LayoutModel> =>
  structuredClone(await layout(parse(golden(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt })) as LayoutModel;

describe('a centring trial leaves the shared context unchanged', () => {
  it('deep-equals the context before and after centreViolations on a sheet with frame columns', async () => {
    const model = await run('a-canton-group-frames-two-tiers');
    const context = centreContext(model, model.anchorTier!);
    expect(context.columns.length).toBeGreaterThan(0);
    const before = structuredClone(context);
    const shared = centreViolations(model, false, context);
    expect(context).toEqual(before);
    expect(centreViolations(model, true, context)).toEqual(centreViolations(model, true));
    expect(context).toEqual(before);
    expect(shared).toEqual(centreViolations(model));
  }, 60000);
});

describe('the link-facts cache', () => {
  const chordSheet = 'a-chord-holds-clearance-along-a-neighbours-whole-leg';

  it('answers undefined from the cache when the first answer was undefined', async () => {
    const model = await run(chordSheet);
    const link = model.links.find(item => chordKind(model, item) !== undefined)!;
    const outside = chordKind(model, link);
    link.bundle = 'x';
    withLinkFacts(model, () => {
      expect(chordKind(model, link)).toBeUndefined();
      delete link.bundle;
      expect(chordKind(model, link)).toBeUndefined();
    });
    expect(chordKind(model, link)).toBe(outside);
    const routed = model.links.find(item => item.attachments && orthogonalLeg(model, item, 'from') !== undefined)!;
    const port = findPort(model, routed.attachments!.from)!, anchor = port.anchor!;
    delete port.anchor;
    withLinkFacts(model, () => {
      expect(orthogonalLeg(model, routed, 'from')).toBeUndefined();
      port.anchor = anchor;
      expect(orthogonalLeg(model, routed, 'from')).toBeUndefined();
    });
    expect(orthogonalLeg(model, routed, 'from')).toBeDefined();
  }, 60000);

  it('hands each caller its own leg, so a write to one cannot reach the cache', async () => {
    const model = await run(chordSheet);
    const link = model.links.find(item => item.attachments && orthogonalLeg(model, item, 'from') !== undefined)!;
    withLinkFacts(model, () => {
      const first = orthogonalLeg(model, link, 'from')!;
      first.straight = true;
      expect(orthogonalLeg(model, link, 'from')!.straight).toBeUndefined();
    });
  }, 60000);

  it('never nests: a second scope throws and the outer scope still ends', async () => {
    const model = await run(chordSheet);
    expect(() => withLinkFacts(model, () => withLinkFacts(model, () => undefined))).toThrow(/cannot nest/);
    expect(() => withLinkFacts(model, () => undefined)).not.toThrow();
  }, 60000);

  it('ends after the call, also when the call throws', async () => {
    const model = await run(chordSheet);
    const link = model.links.find(item => chordKind(model, item) !== undefined)!;
    const kind = chordKind(model, link);
    expect(() => withLinkFacts(model, () => { chordKind(model, link); link.bundle = 'x'; throw new Error('boom'); })).toThrow('boom');
    expect(chordKind(model, link)).toBeUndefined();
    delete link.bundle;
    expect(chordKind(model, link)).toBe(kind);
  }, 60000);

  it('rebuildRowPaths leaves no cache behind, after it returns or throws', async () => {
    const model = await run(chordSheet);
    delete model.frozenChords;
    const link = model.links.find(item => chordKind(model, item) !== undefined)!;
    const kind = chordKind(model, link);
    rebuildRowPaths(model);
    link.bundle = 'x';
    expect(chordKind(model, link)).toBeUndefined();
    delete link.bundle;
    expect(chordKind(model, link)).toBe(kind);
    // A rebuild that throws part-way: the scope must still end, so a new scope opens without the nesting error.
    const broken = structuredClone(model) as LayoutModel;
    delete (broken as { tierBands?: unknown }).tierBands;
    expect(() => rebuildRowPaths(broken)).toThrow();
    expect(() => withLinkFacts(broken, () => undefined)).not.toThrow();
  }, 60000);
});
