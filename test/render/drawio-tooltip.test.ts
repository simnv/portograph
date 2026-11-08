import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse } from '../../src/index.js';
import type { LayoutLabel, LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Full text survives in draw.io as a `tooltip` attribute (ticket DX-11); the `pg-*` binding stays as the contract says. */

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const decode = (value: string): string => value.replace(/&#(\d+);|&(amp|lt|gt|quot|apos);/g, (_, code: string | undefined, name: string | undefined) =>
  code !== undefined ? String.fromCharCode(Number(code)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name!]!);
const objects = (xml: string): Record<string, string>[] => [...xml.matchAll(/<object\b([^>]*)>/g)].map(match => {
  const found: Record<string, string> = {};
  for (const pair of match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) found[pair[1]!] = decode(pair[2]!);
  return found;
});
/** The model with each link label changed by `edit`; a layout model is frozen, so the labels are copies. */
const edited = (model: LayoutModel, edit: (label: LayoutLabel) => Partial<LayoutLabel>, only: (label: LayoutLabel) => boolean = () => true): LayoutModel =>
  ({ ...model, labels: model.labels.map(label => only(label) ? { ...label, ...edit(label) } : label) });
const linkOnly = (label: LayoutLabel): boolean => label.role === 'link';
const FULL = 'This link label must survive in its tooltip even when every visible placement collides';

describe('draw.io tooltips', () => {
  it('keeps the text of an omitted link label on the link object and leaves its binding alone', async () => {
    const xml = drawio(edited(await run(fixture('unfittable-link-label')), () => ({ omitted: true, tooltip: FULL }), linkOnly));
    const link = objects(xml).find(item => item['pg-kind'] === 'link')!;
    expect(link['tooltip']).toBe(FULL);
    expect(link['pg-id']).toBeDefined();
    expect(link['pg-from']).toBeDefined();
  }, 60000);

  it('puts generated text after an author tooltip, not instead of it', async () => {
    const yaml = fixture('unfittable-link-label').replace('{ label: This', '{ meta: {tooltip: Mine}, label: This');
    const link = objects(drawio(edited(await run(yaml), () => ({ omitted: true, tooltip: FULL }), linkOnly))).find(item => item['pg-kind'] === 'link')!;
    expect(link['tooltip']).toBe(`Mine\n${FULL}`);
  }, 60000);

  it('puts the full text of a shortened label on its own cell', async () => {
    const base = await run(fixture('fitting-link-label'));
    const full = base.labels.find(linkOnly)!.text;
    const model = edited(base, () => ({ text: 'Sh…', lines: ['Sh…'], tooltip: full }), linkOnly);
    const bound = objects(drawio(model)).filter(item => item['tooltip'] === full);
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.every(item => item['pg-kind'] === 'link' || item['pg-kind'] === 'link-label')).toBe(true);
  }, 60000);

  it('writes the bus tooltip of the SVG on the pieces of a mesh bus', async () => {
    const xml = drawio(await run(fixture('a-full-mesh-on-one-row-draws-as-one-bus')));
    const tips = objects(xml).filter(item => (item['id'] ?? '').startsWith('pg-bus') && item['tooltip'] !== undefined);
    expect(tips.length).toBeGreaterThan(0);
    expect(tips[0]!['tooltip']).toContain('mesh:');
    expect(tips[0]!['pg-kind']).toBeUndefined();
  }, 60000);

  it('reads the font family of the label model', async () => {
    const xml = drawio(edited(await run(fixture('fitting-link-label')), () => ({ fontFamily: 'Courier, monospace' })));
    expect(xml).toContain('fontFamily=Courier, monospace');
    expect(xml).not.toContain('fontFamily=Verdana');
  }, 60000);
});
