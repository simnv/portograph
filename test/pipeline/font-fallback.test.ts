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
// Dense-16x9 ticket 45 (the move-before-grow default) re-baselined both: the centring moves a node before it grows one, so the bodies and the
// paths change (44413304... and 2f8dee6c... before). The m1-sip-edge geometry waits for the owner's re-approval, as its golden does. On ticket 56
// both layouts gain the record `moveBeforeGrowRun` and the document echo `layout.moveBeforeGrow: true` of ticket 56 (07a7f1bf... and 2796ac17... before).
const baselines = {
  'm1-sip-edge': '7437eded032a9cf026ce17948f878e476b66bb0e3769fdde25f89d087332cc61',
  'synthetic/drawio-constructs': 'c8f4a56a213c0640de420ee70e1a60d163a9da4d388c6d3a3321a6976a1912c6',
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
