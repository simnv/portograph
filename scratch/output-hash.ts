// vite-node scratch/output-hash.ts > out.txt : sha256 of the SVG and of the layout JSON (runtime excluded) for the NTP sheet and 5 goldens.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { layout, parse, render } from '../src/index.js';
import type { LayoutModel } from '../src/index.js';
import { createAttempt } from '../test/layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../test/route/fixture.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);
const files = ['/tmp/ntp-diag/ntp-signal.yaml', 'goldens/m1-sip-edge.yaml',
  ...['a-canton-group-frames-two-tiers', 'a-straight-gap-needs-no-router', 'transit-fan', 'four-locations-each-with-a-zone'].map(n => `goldens/synthetic/${n}.yaml`)];
for (const file of files) {
  const model = await layout(parse(readFileSync(file, 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const copy: Partial<LayoutModel> = { ...model };
  delete copy.runtime;
  console.log(file.split('/').pop(), 'layout', sha(JSON.stringify(copy)), 'svg', sha(render(model)));
}
