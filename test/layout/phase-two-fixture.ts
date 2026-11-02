import { createRequire } from 'node:module';
import { afterAll, afterEach } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { createWorkerElkAttempt, type CreateElkAttempt, type ElkAttempt, type ElkWorker } from '../../src/layout/elk-worker.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
const require = createRequire(import.meta.url);
const Worker = require('web-worker') as new (url: string) => ElkWorker;
const { createWarmElk } = require('../../runtime/warm-elk.cjs') as {
  createWarmElk: (create: typeof createWorkerElkAttempt, make: () => ElkWorker) => { attempt: () => ElkAttempt; warm(): void; close(): void };
};
const makeWorker = () => new Worker(require.resolve('elkjs/lib/elk-worker.min.js'));

// Vitest loads this module once per test file, so a file shares one warm worker. A warm worker serves one layout at a time
// (`runtime/warm-elk.cjs`): a test that starts two layouts together (`Promise.all`) takes `createColdAttempt`.
const warm = createWarmElk(createWorkerElkAttempt, makeWorker);
afterAll(() => warm.close());
// A test that failed (a timeout, say) may leave its layout running on the shared worker; the next test must not queue behind it.
afterEach(context => { if (context.task.result?.state === 'fail') warm.close(); });
export const createAttempt: CreateElkAttempt = () => warm.attempt();
/** A new worker per attempt, for a test that runs two layouts at the same time. */
export const createColdAttempt: CreateElkAttempt = () => createWorkerElkAttempt(makeWorker());
export async function placed(yaml: string) {
  const model = sizeNodes(sidesOne(resolve(parse(yaml))));
  await skeleton(model, { createAttempt });
  return sidesTwo(model);
}
export const simple = `portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, class: router, description: hello, ports: [{name: p, side: right, order: -2}, {name: q, side: right}, {name: r, side: right, order: 4}]}
  b: {group: g, ports: [p]}
links: [[a.q, b.p]]`;
