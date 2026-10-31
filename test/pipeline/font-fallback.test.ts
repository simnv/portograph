import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { drawio, layout, parse, render } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// These hashes pin the pre-fallback layout, with runtime and font family strings excluded.
const baselines = {
  'm1-sip-edge': 'dc8812848890f96711d80797ddbb2081cf60f1feb0fdc11e3d31d56e74ccdfdf',
  'synthetic/drawio-constructs': 'c2856e36284f8bcc0fe0ec7dfddf467092f7e167cbd6a9756868670b8fccd11c',
};

for (const [fixture, baseline] of Object.entries(baselines)) {
  it(`${fixture}: emits generic font fallbacks without a geometry change`, async () => {
    const source = readFileSync(new URL(`../../goldens/${fixture}.yaml`, import.meta.url), 'utf8');
    const model = await layout(parse(source), {
      createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    });
    const geometry = JSON.stringify(model, (key, value: unknown) =>
      key === 'runtime' || key === 'fontFamily' ? undefined : value);
    expect(createHash('sha256').update(geometry).digest('hex')).toBe(baseline);
    for (const [output, pattern] of [
      [render(model), /font-family:([^;!}]+)/g],
      [drawio(model), /fontFamily=([^;]+)/g],
    ] as const) {
      const families = [...output.matchAll(pattern)].map(match => match[1]!);
      expect(families.length).toBeGreaterThan(0);
      for (const family of families) expect(family).toMatch(/(?:^|,)\s*(?:sans-serif|serif|monospace)\s*$/);
    }
  }, 60000);
}
