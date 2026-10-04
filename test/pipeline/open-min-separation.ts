import type { score } from '../../src/index.js';

type Snapshot = ReturnType<typeof score>['snapshot'];

/**
 * The gate violations of a score that are not a `min-separation` finding (G9, architecture ticket 17). That final check reports the minimum-separation
 * breaks that some sheets publish today and no ticket has fixed; a test of another rule on such a sheet asserts that nothing else fails, and the finding stays
 * visible in the score, in the corpus line and in the ticket 17 fix note.
 */
export const failuresBesidesMinSeparation = (snapshot: Snapshot): string[] =>
  Object.entries(snapshot.gates).flatMap(([id, gate]) => gate.violations.filter(item => item.code !== 'min-separation').map(item => `${id}:${item.code}`));
