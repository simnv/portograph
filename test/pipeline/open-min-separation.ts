import type { score } from '../../src/index.js';

type Snapshot = ReturnType<typeof score>['snapshot'];

/**
 * Every gate violation of a score, as a name: `G9:min-separation:<owner>,<owner>` for a minimum-separation finding (architecture ticket 17), `<gate>:<code>` for the rest.
 * Some sheets publish a minimum-separation break today that a required pass writes and no ticket has fixed. A test of another rule on such a sheet pins the exact open
 * entries (owner pair), like `KNOWN_OPEN` in `constraints.test.ts`: a new break fails the test, and so does one that is fixed (delete it from the list).
 */
export const gateFailures = (snapshot: Snapshot): string[] =>
  Object.entries(snapshot.gates).flatMap(([id, gate]) => gate.violations.map(item => (item.code === 'min-separation' ? `${id}:${item.code}:${item.elements.join(',')}` : `${id}:${item.code}`)));
