import { describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { centre, flanks, lanes, rows } from '../../src/internal.js';
import { centreViolations } from '../../src/layout/centre.js';
import { attemptCounters } from '../../src/layout/attempt-counters.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { checkReadCaches, readCacheCounts } from '../../src/model/read-cache.js';
import { placed } from './phase-two-fixture.js';

/**
 * Architecture-2 ticket 63. The centring check keeps its answer per model, with the text of the model it read; a later check on a model with the same text
 * gives that answer again and does not replay the steps. A model whose text changed is replayed again.
 */
// When `write.on` is set, a replayed step that reads the feeds of a trial whose diagnostics are frozen (a part the trials share) writes to them,
// as a step that writes a shared part would: the trial must run again on a full copy, where the diagnostics are its own and nothing is written.
const write = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/layout/read/feeds.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/read/feeds.js')>();
  return { ...original, centringFeeds: (...args: Parameters<typeof original.centringFeeds>) => {
    const model = args[0];
    if (write.on && Object.isFrozen(model.diagnostics)) model.diagnostics.push({ stage: 'placement', severity: 'info', code: 'TEST_WRITE', message: 'a write to a shared part' });
    return original.centringFeeds(...args);
  } };
});

const sheet = `portograph: 2
groups: {up: {tier: 0}, down: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  c: {group: down, ports: [{name: p, side: top}]}
links: [[a.p, c.p]]`;

const answers = (): { hits: number; misses: number } => readCacheCounts().centreCheckAnswer ?? { hits: 0, misses: 0 };
/** The centred sheet, with the child group moved off its feed by `dx`: a model the check replays a step on (asked `ahead`, as the producer asks at stage `centre`). */
async function offFeed(dx: number): Promise<LayoutModel> {
  const model = JSON.parse(JSON.stringify(centre(flanks(lanes(rows(await placed(sheet))))))) as LayoutModel;
  moveGroup(model, model.groups.down!, dx, 0);
  return model;
}

describe('the centring check reuses its answer only on the same model text (ticket 63)', () => {
  it('a second check on an unchanged model is a hit; a moved node is read again and gives the answer of a fresh copy', async () => {
    const model = await offFeed(40);
    const first = answers();
    const found = centreViolations(model, true);
    expect(found.length).toBeGreaterThan(0);
    expect(answers().misses).toBe(first.misses + 1);
    expect(centreViolations(model, true)).toEqual(found);
    expect(answers().hits).toBe(first.hits + 1);
    // The check of a hit computes the answer again in full and finds it the same.
    expect(await checkReadCaches(async () => centreViolations(model, true))).toEqual(found);
    // A node whose text changed: the answer is read again, and it is the answer a copy that never had a check gives.
    moveGroup(model, model.groups.down!, 20, 0);
    const before = answers();
    const moved = centreViolations(model, true);
    expect(answers()).toMatchObject({ hits: before.hits, misses: before.misses + 1 });
    expect(moved).not.toEqual(found);
    expect(moved).toEqual(centreViolations(JSON.parse(JSON.stringify(model)) as LayoutModel, true));
    // A change to one node alone (no group box moves), and one to a shared part alone (the diagnostics): each is read again.
    for (const change of [
      (item: LayoutModel): void => { (item.nodes.c as unknown as Record<string, unknown>).note = 'changed'; },
      (item: LayoutModel): void => { item.diagnostics.push({ stage: 'placement', severity: 'info', code: 'TEST_NOTE', message: 'a shared part changed' }); },
    ]) {
      centreViolations(model, true);
      change(model);
      const was = answers();
      expect(centreViolations(model, true)).toEqual(moved);
      expect(answers()).toMatchObject({ hits: was.hits, misses: was.misses + 1 });
    }
    // `ahead` is part of the key: the same model asked for the stage it stands at is read again.
    const ahead = answers();
    expect(centreViolations(model, false)).toEqual(centreViolations(JSON.parse(JSON.stringify(model)) as LayoutModel, false));
    expect(answers().hits).toBe(ahead.hits);
  }, 60000);

  it('a step that writes a shared part runs again on a full copy and gives the full-copy answer', async () => {
    const model = await offFeed(40);
    const plain = centreViolations(JSON.parse(JSON.stringify(model)) as LayoutModel, true);
    const fallbacks = attemptCounters.centreCheckFallbacks;
    write.on = true;
    try {
      expect(centreViolations(model, true)).toEqual(plain);
    } finally { write.on = false; }
    expect(attemptCounters.centreCheckFallbacks).toBeGreaterThan(fallbacks);
    expect(model.diagnostics.some(item => item.code === 'TEST_WRITE')).toBe(false);
  }, 60000);
});
