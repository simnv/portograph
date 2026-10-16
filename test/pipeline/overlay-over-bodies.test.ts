import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse, score } from '../../src/index.js';
import type { LayoutModel, Point } from '../../src/index.js';
import { flatCells, inFile } from '../render/drawio-cells.js';
import { linkIds } from '../../src/model/index.js';
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
    // The segment crosses the middle body in y and starts and ends on the port faces (a right and a left face).
    expect(from.y).toBeGreaterThan(body.y);
    expect(from.y).toBeLessThan(body.y + body.height);
    expect(to.y).toBeGreaterThan(body.y);
    expect(to.y).toBeLessThan(body.y + body.height);
    const a = model.nodes.a!.bounds!, c = model.nodes.c!.bounds!;
    const [left, right] = from.x < to.x ? [from, to] : [to, from];
    // The faces stand just outside the two end bodies (the pill sticks out of the body), and not past the middle one.
    expect(left.x).toBeGreaterThanOrEqual(a.x + a.width);
    expect(left.x).toBeLessThan(body.x);
    expect(right.x).toBeLessThanOrEqual(c.x);
    expect(right.x).toBeGreaterThan(body.x + body.width);
    const found = model.diagnostics.filter(item => item.code === 'OVERLAY_OVER_BODY');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('info');
    expect(found[0]!.message).toContain(overlay(model).id);
    expect(found[0]!.message).toContain(' m ');
    expect(score(model).snapshot.passed).toBe(true);
  }, 60000);

  const BASE = read(MIDDLE);
  const withMiddlePort = BASE.replace('  m: { group: row, class: server, label: m }', '  m: { group: row, class: server, label: m, ports: [{ name: q, side: left }] }');
  const awayFromEachOther = BASE.replace('{ name: p, side: right }', '{ name: p, side: left }');

  it.each([
    ['a foreign pill stands on the chord', withMiddlePort],
    ['an own port faces away, so its own end body stands on the chord', awayFromEachOther],
  ])('keeps the link bent and says nothing when %s', async (_name, yaml) => {
    expect(yaml).not.toBe(BASE);
    const model = await run(yaml + ON);
    expect(segments(model)).toBeGreaterThan(1);
    expect(model.diagnostics.some(item => item.code === 'OVERLAY_OVER_BODY')).toBe(false);
  }, 60000);

  it('does not publish an empty layout object', () => {
    expect(parse(`${read(MIDDLE)}\nlayout: {}\n`).layout).toBeUndefined();
  });

  it.each([
    'an-overlay-turns-once-into-a-lateral-side',
    'overlay-links-reorder-an-indifferent-tier',
    'an-overlay-reorder-is-refused-when-a-link-would-bend',
    MIDDLE.slice('synthetic/'.length),
  ])('places %s alike with the setting on and off (placement does not know it)', async name => {
    const path = `synthetic/${name}`;
    const off = await run(read(path)), on = await run(read(path) + ON);
    expect(on.nodes).toEqual(off.nodes);
    expect(on.groups).toEqual(off.groups);
  }, 120000);

  it('pins the draw.io export of an over-body link: one straight edge, drawn over the body (draw.io has no mask)', async () => {
    const model = await run(read(MIDDLE) + ON);
    const xml = drawio(model);
    const link = overlay(model), id = inFile(linkIds(model.document)[link.sourceIndex]!);
    const cell = flatCells(xml).split('<mxCell').find(part => part.includes(`pg-link~${id}"`));
    expect(cell).toBeDefined();
    expect(cell).toContain('edge="1"');
    expect(cell).not.toContain('<mxPoint as="points"');
    expect(cell).not.toMatch(/as="points"/);
  }, 60000);

  it('refuses a value that is not a boolean', () => {
    expect(() => parse(`${read(MIDDLE)}\nlayout:\n  overlayOverBodies: 1\n`)).toThrow();
  });
});
