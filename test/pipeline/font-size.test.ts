import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { drawio, layout, parse, render } from '../../src/index.js';
import { THEME_IDS } from '../../src/profiles/network/themes.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

it('measures and emits fixture text at 9 px or larger in every content style and theme', async () => {
  for (const fixture of [
    'm1-sip-edge',
    'synthetic/drawio-node-text',
    'synthetic/drawio-constructs',
    'synthetic/a-mesh-over-two-rows-joins-its-bars-with-one-riser',
    'synthetic/a-card-node-holds-its-ports-on-every-face',
    'synthetic/a-theme-paints-and-moves-nothing',
  ]) {
    const source = readFileSync(new URL(`../../goldens/${fixture}.yaml`, import.meta.url), 'utf8');
    for (const nodeContent of ['stacked', 'card'] as const) {
      const document = parse(source);
      document.layout = { ...document.layout, nodeContent };
      const model = await layout(document, {
        createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
      });
      for (const label of model.labels) {
        expect(label.fontSize ?? 9, `${fixture}: ${nodeContent}: ${label.id}`).toBeGreaterThanOrEqual(9);
      }
      for (const theme of THEME_IDS) {
        const themed = { ...model, document: { ...model.document, theme } };
        for (const mode of ['light', 'dark', 'print'] as const) {
          for (const [format, output, pattern, familyPattern] of [
            ['SVG', render(themed), /font-size:([\d.]+)px/g, /font-family:([^;!}]+)/g],
            ['draw.io', drawio(themed, { theme: mode }), /fontSize=([\d.]+)/g, /fontFamily=([^;]+)/g],
          ] as const) {
            const context = `${fixture}: ${nodeContent}: ${theme}: ${mode}: ${format}`;
            const sizes = [...output.matchAll(pattern)].map(match => Number(match[1]));
            expect(sizes.length, context).toBeGreaterThan(0);
            expect(Math.min(...sizes), context).toBeGreaterThanOrEqual(9);
            const families = [...output.matchAll(familyPattern)].map(match => match[1]!);
            expect(families.length, context).toBeGreaterThan(0);
            for (const family of families) expect(family, context).toMatch(/(?:^|,)\s*(?:sans-serif|serif|monospace)\s*$/);
          }
        }
      }
    }
  }
}, 60000);
