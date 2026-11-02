import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { isDiagonal } from '../../src/layout/diagonal-text.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 162 and architecture-2 ticket 54: a chord is held on the geometry of 7e and published on the geometry 7f leaves. 7f turns the feed
 * of the fixture near the vertical, across the title edge of `w-site-b`. No title refuses a chord (ticket 54): the title is placed last,
 * yields to the chord with its halo and records it (`crossedBy`), and G3 reads the record.
 */
const FIXTURE = 'a-chord-that-turns-onto-an-axis-meets-a-title';
const text = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');
const lay = (): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('a held chord whose angle class 7f changes keeps its chord, and the title yields', () => {
  it('publishes the feed as one segment on an axis across the title, which records it, and passes every gate', async () => {
    const model = await lay();
    const link = model.links.find(item => item.from.node === 'w2' && item.to.node === 'wb1')!;
    expect(model.frozenChords).toContain(link.id);
    expect(link.path!.segments).toHaveLength(1);
    expect(isDiagonal(link.path!.segments[0]!)).toBe(false);
    const title = model.labels.find(label => label.id === 'label:group:w-site-b#0')!;
    expect(title.yield).toBe('halo');
    expect(title.crossedBy).toContain(link.id);
    expect(model.diagnostics.some(item => item.code === 'ROUTED_CHORD_REFUSED' && item.message.endsWith(': title.'))).toBe(false);
    expect(Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id)).toEqual([]);
  }, 120000);
});
