import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel, Point } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket 152: the opt-in `layout.overlayOverBodies` setting.
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const read = (path: string): string => readFileSync(new URL(`../../goldens/${path}.yaml`, import.meta.url), 'utf8');
const MIDDLE = 'synthetic/an-overlay-link-passes-over-a-middle-body-when-the-user-opts-in';
const ON = '\nlayout:\n  overlayOverBodies: true\n';
const OFF = '\nlayout:\n  overlayOverBodies: false\n';
/** The published model without the clock and without the stated setting, which is the only thing the two inputs differ by. */
const stable = (model: LayoutModel): string => JSON.stringify({ ...model, runtime: undefined, document: { ...model.document, layout: undefined } });
const overlay = (model: LayoutModel) => model.links.find(link => (link.layer ?? link.family) === 'overlay')!;
const segments = (model: LayoutModel): number => overlay(model).path!.segments.length;

describe('layout.overlayOverBodies (ticket 152)', () => {
  it.each(['m1-sip-edge', MIDDLE])('draws %s byte for byte as the default when the setting is false', async name => {
    const plain = await run(read(name)), off = await run(read(name) + OFF);
    expect(stable(off)).toBe(stable(plain));
    expect(off.diagnostics.some(item => item.code === 'OVERLAY_OVER_BODY')).toBe(false);
  }, 120000);

  it('bends a link blocked by a middle body when the setting is off', async () => {
    const model = await run(read(MIDDLE));
    expect(segments(model)).toBeGreaterThan(1);
    expect(model.diagnostics.some(item => item.code === 'OVERLAY_OVER_BODY')).toBe(false);
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('draws one segment over the body, names it in an info diagnostic and fails no gate when the setting is on', async () => {
    const model = await run(read(MIDDLE) + ON);
    expect(segments(model)).toBe(1);
    const { from, to } = overlay(model).path!.segments[0]!;
    const body = model.nodes.m!.bounds!;
    const inside = (point: Point): boolean => point.x > body.x && point.x < body.x + body.width;
    expect(Math.min(from.x, to.x)).toBeLessThan(body.x);
    expect(Math.max(from.x, to.x)).toBeGreaterThan(body.x + body.width);
    expect(inside(from) || inside(to)).toBe(false);
    const found = model.diagnostics.filter(item => item.code === 'OVERLAY_OVER_BODY');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('info');
    expect(found[0]!.message).toContain(overlay(model).id);
    expect(found[0]!.message).toContain(' m ');
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  it('refuses a value that is not a boolean', () => {
    expect(() => parse(`${read(MIDDLE)}\nlayout:\n  overlayOverBodies: 1\n`)).toThrow();
  });
});
