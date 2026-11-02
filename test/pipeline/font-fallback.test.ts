import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { drawio, layout, parse, render } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// These hashes exclude runtime and font family strings. Ticket 156 remeasures corner margins and fan rows at 9 px.
// Architecture-2 ticket 51 re-baselined m1-sip-edge (8c7995ca... before): the document gains only `shapeAuthored` on `backbone`
// (approved 2026-11-02); the hash without that key is the old one.
// Architecture-2 ticket 54 re-baselined both: each group title gains only `crossedBy` (the hash without that key is the old one:
// b19c42d7... and b20890c8...).
const baselines = {
  'm1-sip-edge': '745d3f2f3c2e043e90912615e11ea2f616f508c2d51df838ddb60b30f5a822fd',
  'synthetic/drawio-constructs': '0c8f01d534570b643c44f5675ea3c5d6265c447f3eda4a57fc9e57f1f7694a5a',
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
