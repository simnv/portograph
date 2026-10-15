import { describe, expect, it, vi } from 'vitest';

/**
 * A class that extends another across modules breaks when the import cycle runs through its module first (`Class extends value undefined`). The order of evaluation depends on the
 * entry, so a run of one test file never sees a cycle that another entry meets. Each entry below loads first in a fresh module graph (architecture 2, ticket 03).
 */
const ENTRIES: Record<string, () => Promise<unknown>> = {
  score: () => import('../../src/score/index.js'),
  'reservation-checks': () => import('../../src/layout/reservation-checks.js'),
  reservations: () => import('../../src/layout/reservations.js'),
  'move-reservations': () => import('../../src/layout/move-reservations.js'),
  'overlay-paths': () => import('../../src/layout/overlay-paths.js'),
  'placement-attempt': () => import('../../src/layout/placement-attempt.js'),
  mutation: () => import('../../src/layout/mutation.js'),
  route: () => import('../../src/route/index.js'),
  pipeline: () => import('../../src/pipeline/index.js'),
};

describe('the module graph loads from every entry', () => {
  it.each(Object.keys(ENTRIES))('%s loads first', async name => {
    vi.resetModules();
    await expect(ENTRIES[name]!()).resolves.toBeDefined();
  });
});
