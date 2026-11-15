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
// Architecture-2 ticket 57 re-baselined both: every published model gains `stemDepths` (the hash without that key is the old one:
// 745d3f2f... and 0c8f01d5...).
// Architecture-2 ticket 68 re-baselined m1-sip-edge (4ae81293... before): the end trim narrows its stretched bodies, pending the
// maintainer's approval of the regenerated golden.
// Architecture-2 ticket 73 re-baselined both: every published model gains `feedSplits: []` and its freeze copy (the hash without that key is
// the old one: 724ccda3... and 95beda34...).
// Architecture-2 ticket 74 re-baselined synthetic/drawio-constructs: its bundle gains only `lead` (the hash without that key is the old
// one: b956d053...).
// DR-04 re-baselined m1-sip-edge (70e112a3... before): link ids and anonymous port ordinals follow the canonical link order; every
// node box, port, path and the canvas are byte-identical (user approval, 2026-11-09). The parser fix for structured endpoints changed the ids
// once more (e124d93a... before), again with the same geometry (user approval).
// ADR-0027 seat addendum (dense-16x9 ticket 02) re-baselined both: every published model gains `alignmentTargets` and `alignmentSeats` (the hash
// without those two keys is the old one: 44413304... and 2f8dee6c...).
const baselines = {
  'm1-sip-edge': 'b3d5335a329dcf4758fc36c605f46b8832f44ec5dada723721f0bab6911a4456',
  'synthetic/drawio-constructs': '2796ac17db97defbbf3792c1cc09218a8acf95d019a5c1309acf8f89d9f9137e',
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
