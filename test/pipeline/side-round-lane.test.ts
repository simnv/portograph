import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { LINK_LABEL_GEOMETRY } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
import { pathBends } from '../../src/layout/side-judge.js';
import { measureSides, plannedBends } from '../../src/layout/side-measure.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 119 (docs/design/side-faces.md, Q109 and Q109a): the side round offers a routed L through a source-aligned side lane. */
const FIXTURE = 'a-routed-link-turns-once-into-an-outlets-lateral-side';
const yaml = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');
const run = (extra: Partial<Parameters<typeof layout>[1]> = {}, text = yaml): Promise<LayoutModel> =>
  layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...extra });
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);
const portOf = (link: LayoutModel['links'][number], ordinal: number): boolean => link.attachments!.from.node === 'outlet' ? link.attachments!.from.ordinal === ordinal : link.attachments!.to.node === 'outlet' && link.attachments!.to.ordinal === ordinal;
const described = (model: LayoutModel) => model.links.find(link => model.document.links[link.sourceIndex]?.label !== undefined)!;

describe('the side round offers a routed L through a side lane', () => {
  it('turns once into the right side of the outlet, its label room on the vertical run, every gate passing', async () => {
    const model = await run();
    const link = described(model), lane = model.lanes.find(item => item.kind === 'side' && item.owner.kind === 'link' && item.owner.id === described(model).id)!;
    expect(lane).toBeDefined();
    expect(lane.aligned).toBe(true);
    expect(pathBends(link)).toBe(1);
    const port = model.nodes['outlet']!.ports.find(item => portOf(link, item.ref.ordinal))!;
    expect(port).toMatchObject({ side: 'right', sideHint: true, laneHint: true, naturalSide: 'top' });
    // The path is one vertical run (the drop and the lane) and the side run into the port.
    const segments = link.path!.segments, across = segments[segments.length - 1]!;
    const down = { from: segments[0]!.from, to: segments[segments.length - 2]!.to };
    expect(segments.slice(0, -1).every(item => item.from.x === lane.x && item.to.x === lane.x)).toBe(true);
    expect(across.to).toEqual(port.anchor);
    const notes = model.diagnostics.filter(item => item.code === 'SIDE_HINT_TAKEN');
    expect(notes.map(item => item.message).join(' ')).toContain('lane shape');
    expect(codes(model)).not.toContain('SIDE_SHAPE_LOST');
    expect(codes(model)).not.toContain('LINK_LABEL_ROOM_UNRESERVED');
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed)).toEqual([]);
    // The label room is reserved on the vertical run (the drop and the lane): the run from the load balancer to the port's y holds the label and its margins.
    // The label is drawn on the longest single segment (stage 9), which here is the side run: the vertical run is three collinear pieces (ticket 119, comments).
    const label = model.labels.find(item => item.role === 'link' && item.owner.kind === 'link' && item.owner.id === link.id)!;
    expect(label.omitted).toBeUndefined();
    const text = model.document.links[link.sourceIndex]!.label!;
    const required = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
    expect(down.to.y - down.from.y).toBeGreaterThanOrEqual(required - 1e-6);
  }, 120000);

  it('on the natural sides the same link is stepped (three segments or more)', async () => {
    const model = await run({ testMaxReruns: 0 });
    expect(described(model).path!.segments.length).toBeGreaterThanOrEqual(3);
    expect(pathBends(described(model))).toBeGreaterThanOrEqual(2);
    expect(model.lanes.some(item => item.kind === 'side')).toBe(false);
  }, 120000);

  it('plannedBends reads a side lane: 1 when source-aligned, and more than 1 with none', async () => {
    const model = await run();
    const link = described(model);
    expect(plannedBends(model, link)).toBe(1);
    const stripped = { ...model, lanes: model.lanes.filter(item => item.kind !== 'side') };
    expect(plannedBends(stripped, link)).toBeGreaterThanOrEqual(2);
  }, 120000);

  it('offers no hint when the source-aligned corridor is blocked (an exterior corridor would give three bends)', async () => {
    let first: { base: LayoutModel; kept7e: LayoutModel } | undefined;
    await run({ testSideTrace: (event: { ev: string; base: LayoutModel; kept7e: LayoutModel }) => { if (event.ev === 'offer') first ??= { base: event.base, kept7e: event.kept7e }; } } as never);
    const { base, kept7e } = first!;
    const link = described(base);
    const offered = (probe: LayoutModel): { hint: string | undefined; shape: string | undefined } => {
      const offer = measureSides(base, probe, new Set());
      const entry = [...offer.promised].find(([, item]) => item.link === link.id);
      return { hint: entry === undefined ? undefined : offer.hints.get(entry[0]), shape: entry?.[1].shape };
    };
    expect(offered(kept7e)).toEqual({ hint: 'right', shape: 'lane' });
    // A body of the row on the side run: the outlet is no longer the outermost node of its row, and no lane stands there.
    const blocked = structuredClone(kept7e) as LayoutModel;
    const node = blocked.nodes['tail']!, target = blocked.nodes['outlet']!.bounds!;
    const dx = target.x + target.width + 60 - node.bounds!.x, dy = target.y - node.bounds!.y;
    node.bounds!.x += dx; node.bounds!.y += dy;
    for (const port of node.ports) { port.anchor!.x += dx; port.anchor!.y += dy; if (port.pill) { port.pill.bounds.x += dx; port.pill.bounds.y += dy; } }
    expect(offered(blocked)).toEqual({ hint: undefined, shape: undefined });
  }, 120000);

  it('two runs give byte-identical layout JSON', async () => {
    const strip = (model: LayoutModel): string => JSON.stringify(model, (key, value: unknown) => key === 'runtime' ? undefined : value);
    expect(strip(await run())).toBe(strip(await run()));
  }, 120000);
});
