import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, parseWithDiagnostics, render, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { anonymousDotRadius } from '../../src/theme/geometry.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/an-anonymous-end-is-closed-by-a-dot.yaml', import.meta.url), 'utf8');
const withOption = (value: string): string => fixture.replace('portograph: 2\n', `portograph: 2\nrender: { anonymousPortMarker: ${value} }\n`);
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
/** The layout JSON without the echoed document, which carries the option itself, and without the wall-clock timings. */
const geometry = (model: LayoutModel): string => JSON.stringify({ ...model, document: undefined, runtime: undefined });
const edgeStyle = (xml: string): string => /<mxCell [^>]*style="([^"]*)"[^>]*edge="1"/.exec(xml)![1]!;

describe('render.anonymousPortMarker', () => {
  it('draws a dot on the bare end only, in the link stroke width, after the nodes', async () => {
    const model = await run(fixture);
    const svg = render(model);
    const dots = [...svg.matchAll(/<circle class="link-dot"[^>]*>/g)];
    expect(dots).toHaveLength(1);
    expect(dots[0]![0]).toContain('data-end="to"');
    expect(dots[0]![0]).toContain(`r="${anonymousDotRadius(1.5)}"`);
    expect(svg.indexOf('class="link-dots"')).toBeGreaterThan(svg.indexOf('class="nodes"'));
  });

  it('states oval end arrows on the anonymous end of the edge and none on the port end', async () => {
    const style = edgeStyle(drawio(await run(fixture)));
    expect(style).toContain('endArrow=oval;');
    expect(style).toContain('endFill=1;endSize=6;');
    expect(style).toContain('startArrow=none;');
    expect(style).not.toContain('startSize');
  });

  it('is the default: an explicit dot is the same output', async () => {
    const [plain, explicit] = await Promise.all([run(fixture), run(withOption('dot'))]);
    expect(render(explicit)).toContain('link-dot');
    expect(edgeStyle(drawio(explicit))).toBe(edgeStyle(drawio(plain)));
  });

  it('none draws neither a dot nor an oval, and the output equals the output without the dot code', async () => {
    const model = await run(withOption('none'));
    const svg = render(model), xml = drawio(model);
    expect(svg).not.toContain('link-dots');
    expect(svg).not.toContain('<circle');
    expect(xml).not.toContain('oval');
    // The dot adds one group and one rule per class and nothing else: removing them from the dot output gives the none output.
    const dotted = await run(fixture);
    const rules = (text: string): string => text.replace(/\n *\.link-dot[^\n]*/g, '').replace(/\n@media [^\n]*\{\n\}/g, '');
    expect(rules(render(dotted).replace(/<g class="link-dots">.*?<\/g>/, ''))).toBe(svg);
    expect(drawio(dotted).replace('endArrow=oval;', 'endArrow=none;').replace('endFill=1;endSize=6;', '')).toBe(xml);
  });

  it('changes neither the layout nor the score', async () => {
    const [on, off] = await Promise.all([run(fixture), run(withOption('none'))]);
    expect(geometry(on)).toBe(geometry(off));
    expect(JSON.stringify(score(on).snapshot)).toBe(JSON.stringify(score(off).snapshot));
  });

  it('refuses a value that is not dot or none, and a key it does not know', () => {
    const errors = (value: string) => parseWithDiagnostics(value).diagnostics.filter(d => d.severity === 'error');
    expect(errors(withOption('square'))).toEqual([expect.objectContaining({ code: 'INVALID_TYPE', path: '$.render.anonymousPortMarker' })]);
    expect(errors(fixture.replace('portograph: 2\n', 'portograph: 2\nrender: { dots: dot }\n')))
      .toEqual([expect.objectContaining({ code: 'UNKNOWN_KEY', path: '$.render.dots' })]);
  });
});
