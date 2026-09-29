import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ranked-groups ticket 73 (Q104): a signal link (drawn dashed) joins the overlay family. */
const yaml = readFileSync(new URL('../../goldens/synthetic/a-dashed-signal-feed-is-one-straight-segment.yaml', import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a signal feed', () => {
  it('draws every signal link as one straight overlay segment', async () => {
    const model = await run();
    const signals = model.links.filter(link => model.document.links[link.sourceIndex]!.class === 'signal');
    expect(signals).toHaveLength(4);
    for (const link of signals) {
      expect(link.layer).toBe('overlay');
      expect(link.technique).toBe('overlay'); // the overlay family's technique; one segment is the straight branch
      expect(link.path!.segments).toHaveLength(1);
    }
    expect(model.links.filter(link => link.layer === 'routed')).toHaveLength(3);
  }, 30000);

  it('removes no link and fails neither G2 nor G3', async () => {
    const model = await run();
    expect(model.removedLinks ?? []).toEqual([]);
    const { gates } = score(model).snapshot;
    expect(gates.G2.passed).toBe(true);
    expect(gates.G3.passed).toBe(true);
  }, 30000);
});
