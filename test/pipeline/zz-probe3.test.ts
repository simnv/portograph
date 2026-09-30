import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
it('probe', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-link-drops-beside-a-frame-into-a-lateral-side.yaml', import.meta.url), 'utf8')
    .replace('  bank: { tier: 1, label: Bank }\n', '  bank: { tier: 1, label: Bank }\n  wing: { tier: 1, label: Wing }\n')
    .replace('  tail: {', '  wing-a: { group: wing, class: server, label: Wing of the building with a very long name for a wide body }\n  tail: {')
    .replace('  fe4:','  fe5: { group: front, class: router, label: FE5 }\n  fe4:').replace('links:\n', 'links:\n  - [lb, wing-a]\n  - [fe5, spare]\n');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  console.log('N', JSON.stringify(Object.values(model.nodes).map(n => [n.id, n.bounds?.x, n.bounds?.width])));
  console.log('L', JSON.stringify(model.lanes.filter(l => l.kind === 'side').map(l => [l.x, l.aligned])), JSON.stringify(model.frames?.map(f => f.box)));
  console.log('D', JSON.stringify(model.diagnostics.filter(d => /SIDE/.test(d.code)).map(d => d.message)));
}, 120000);
