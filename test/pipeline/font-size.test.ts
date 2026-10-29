import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { drawio, layout, parse, render } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

it('measures and emits fixture text at 9 px or larger in SVG and draw.io', async () => {
  for (const fixture of [
    'm1-sip-edge',
    'synthetic/drawio-node-text',
    'synthetic/drawio-constructs',
    'synthetic/a-mesh-over-two-rows-joins-its-bars-with-one-riser',
  ]) {
    const model = await layout(parse(readFileSync(new URL(`../../goldens/${fixture}.yaml`, import.meta.url), 'utf8')), {
      createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    });
    for (const label of model.labels) {
      expect(label.fontSize ?? 9, `${fixture}: ${label.id}`).toBeGreaterThanOrEqual(9);
    }
    for (const [format, output, pattern] of [
      ['SVG', render(model), /font-size:([\d.]+)px/g],
      ['draw.io', drawio(model), /fontSize=([\d.]+)/g],
    ] as const) {
      const sizes = [...output.matchAll(pattern)].map(match => Number(match[1]));
      expect(sizes.length, `${fixture}: ${format}`).toBeGreaterThan(0);
      expect(Math.min(...sizes), `${fixture}: ${format}`).toBeGreaterThanOrEqual(9);
    }
  }
}, 60000);
