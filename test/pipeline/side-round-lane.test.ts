import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { LINK_LABEL_GEOMETRY } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
import { judgeTrial, pathBends } from '../../src/layout/side-judge.js';
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

  it('never offers a lane hint in a batch that holds a chord hint (a lane wall can cost the chord its hold at 7e)', async () => {
    const mixed = readFileSync(new URL('../../goldens/synthetic/a-chord-hint-and-a-lane-hint-never-share-a-batch.yaml', import.meta.url), 'utf8');
    const batches: string[][] = [];
    await run({ testSideTrace: (event: { ev: string; offer?: { promised: Map<string, { shape: string }> } }) => { if (event.ev === 'offer') batches.push([...event.offer!.promised.values()].map(item => item.shape)); } } as never, mixed);
    // Ticket 22: a chord joins opposite faces only. The router's bottom face and the provider's lateral face stand at 90 degrees, so this fixture no longer
    // gets a chord hint, and the guard holds here without a test of its own. The lane hint is still offered.
    expect(batches.some(shapes => shapes.includes('straight'))).toBe(false);
    expect(batches.some(shapes => shapes.includes('lane'))).toBe(true);
    expect(batches.filter(shapes => shapes.includes('straight') && shapes.includes('lane'))).toEqual([]);
  }, 120000);

  it('keeps a lane trial only when the lane link has fewer bends, the total does not rise and no neighbour is worse (ticket 119 rule)', async () => {
    const off = await run({ testMaxReruns: 0 }), on = await run();
    const id = described(on).id;
    const input = (routedBase: LayoutModel, routedTrial: LayoutModel) => ({ routedBase, routedTrial, kept7e: routedBase, trial7e: routedTrial, hinted: new Map([[id, 1]]), lanes: new Set([id]) });
    expect(judgeTrial(input(off, on)).kept).toBe(true);
    // No fewer bends on the lane link: the same model twice.
    expect(judgeTrial(input(on, on))).toMatchObject({ kept: false, reason: expect.stringContaining('no fewer bends') });
    // A neighbour without a hint gets a jog: refused although the lane link gained (and the total may rise).
    const jogged = structuredClone(on) as LayoutModel;
    const other = jogged.links.find(link => link.id !== id && link.path !== undefined && link.removed !== true && link.path.segments.length === 1 && pathBends(off.links.find(item => item.id === link.id)!) === 0)!;
    const seg = other.path!.segments[0]!, mid = { x: (seg.from.x + seg.to.x) / 2 + 60, y: (seg.from.y + seg.to.y) / 2 - 60 };
    other.path = { ...other.path!, segments: [{ ...seg, to: mid }, { ...seg, from: mid, to: seg.to }] };
    expect(judgeTrial(input(off, jogged))).toMatchObject({ kept: false, reason: expect.stringMatching(/raises the total|worse/) });
  }, 120000);

  it('refuses what the old judge kept: the lane link 2 to 1, one neighbour 1 to 0, another 1 to 3 (ticket 119 review, L1)', async () => {
    const on = await run();
    const id = described(on).id;
    const others = on.links.filter(link => link.id !== id && link.path !== undefined && link.removed !== true && link.path.segments.length === 1).slice(0, 2);
    expect(others).toHaveLength(2);
    const bent = (model: LayoutModel, link: LayoutModel['links'][number], turns: number): void => {
      const seg = model.links.find(item => item.id === link.id)!.path!.segments[0]!;
      const points = [seg.from, { x: seg.from.x + 60, y: seg.from.y + 40 }, { x: seg.from.x + 120, y: seg.from.y }, { x: seg.from.x + 180, y: seg.from.y + 40 }, seg.to].slice(0, turns + 2);
      points[points.length - 1] = seg.to;
      model.links.find(item => item.id === link.id)!.path = { ...model.links.find(item => item.id === link.id)!.path!, segments: points.slice(1).map((to, i) => ({ ...seg, from: points[i]!, to })) };
    };
    // Base: the lane link has two turns, the first neighbour one, the second one. Trial: 1, 0 and 3.
    const base = structuredClone(on) as LayoutModel, trial = structuredClone(on) as LayoutModel;
    bent(base, described(base), 2); bent(base, others[0]!, 1); bent(base, others[1]!, 1);
    bent(trial, described(trial), 1); bent(trial, others[1]!, 3);
    const input = (lanes?: Set<string>) => ({ routedBase: base, routedTrial: trial, kept7e: base, trial7e: trial, hinted: new Map([[id, 1]]), ...(lanes === undefined ? {} : { lanes }) });
    // Without the lane rule (the old judge) the bent links fall or the total falls, and the trial is kept.
    expect(judgeTrial(input()).kept).toBe(true);
    expect(judgeTrial(input(new Set([id])))).toMatchObject({ kept: false, reason: expect.stringMatching(/raises the total|worse/) });
  }, 120000);

  it('two runs give byte-identical layout JSON', async () => {
    const strip = (model: LayoutModel): string => JSON.stringify(model, (key, value: unknown) => key === 'runtime' ? undefined : value);
    expect(strip(await run())).toBe(strip(await run()));
  }, 120000);
});
