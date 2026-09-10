import { createRequire } from 'node:module';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { createWorkerElkAttempt, type ElkWorker } from '../../src/layout/elk-worker.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
const require = createRequire(import.meta.url);
const Worker = require('web-worker') as new (url: string) => ElkWorker;
export const createAttempt = () => createWorkerElkAttempt(new Worker(require.resolve('elkjs/lib/elk-worker.min.js')));
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
