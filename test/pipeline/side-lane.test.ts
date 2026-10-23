import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreLayoutModel, validateLanes, rebuildLaneExtents } from '../../src/internal.js';
import type { Lane, LayoutModel } from '../../src/index.js';
import { reseatLanes, sideLaneExtent } from '../../src/layout/lanes.js';
import { LABEL_BORDER_REACH, LINK_LABEL_GEOMETRY } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 118 (docs/design/side-faces.md, Section 10, Q109): 7a reserves a side lane into a lateral port; the extent follows the port. */
const FIXTURE = 'a-link-drops-beside-a-frame-into-a-lateral-side';
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const sideLanes = (model: LayoutModel): Lane[] => model.lanes.filter(lane => lane.kind === 'side');
const refusals = (model: LayoutModel) => model.diagnostics.filter(item => item.code === 'SIDE_LANE_REFUSED');
const copy = (model: LayoutModel): LayoutModel => structuredClone(model) as LayoutModel;
const outletAnchor = (model: LayoutModel) => model.nodes['outlet']!.ports.find(port => port.ref.name === 'feed')!.anchor!;

describe('placement reserves a side lane into a lateral port (ticket 118)', () => {
  it('holds one side lane at the far port x, ends it at the port y and reserves the label room on the vertical run', async () => {
    const model = await run(source(FIXTURE));
    const [lane] = sideLanes(model);
    expect(sideLanes(model)).toHaveLength(1);
    const link = model.links.find(item => item.id === (lane!.owner as { id: string }).id)!;
    expect(lane).toMatchObject({ id: `side-lane:${link.id}`, kind: 'side', side: 'right', group: model.document.nodes['outlet']!.group, port: { node: 'outlet', name: 'feed' } });
    const far = model.nodes['lb']!.ports.find(port => port.ref.ordinal === link.attachments!.from.ordinal)!.anchor!, port = outletAnchor(model);
    expect(lane!.x).toBe(far.x);
    expect(lane!.bounds.y + lane!.bounds.height).toBeCloseTo(port.y, 6);
    // The lane is outside the frame of the outlet, on the port's side.
    expect(lane!.bounds.x).toBeGreaterThanOrEqual(model.frames![0]!.box.x + model.frames![0]!.box.width - 1e-6);
    const [vertical, side] = link.fixedSegments!;
    expect(link.fixedSegments).toHaveLength(2);
    expect(vertical).toMatchObject({ from: { x: lane!.x, y: lane!.bounds.y }, to: { x: lane!.x, y: port.y }, lane: lane!.id });
    expect(side).toMatchObject({ from: { x: lane!.x, y: port.y }, to: { x: port.x, y: port.y }, lane: lane!.id });
    // The description asks for room on the vertical run (the drop and the lane): it is longer than the label and its margins.
    const text = model.document.links[link.sourceIndex]!.label!;
    const required = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
    // The vertical run ends at the port's y, not at the top of the outlet. The label stays in one region (ticket 19): the window of
    // the run below the border of `front`, 8 px clear of it, holds the label and no more.
    const drop = port.y - (model.nodes['lb']!.bounds!.y + model.nodes['lb']!.bounds!.height);
    expect(drop).toBeGreaterThanOrEqual(required - 1e-6);
    const front = model.groups['front']!.bounds!, width = required - 2 * LINK_LABEL_GEOMETRY.shortenMargin;
    const window = port.y - LINK_LABEL_GEOMETRY.shortenMargin - (front.y + front.height + LABEL_BORDER_REACH);
    expect(window).toBeGreaterThanOrEqual(width - 1e-6);
    expect(window).toBeLessThan(width + 1);
    expect(model.diagnostics.some(item => item.code === 'LINK_LABEL_ROOM_UNRESERVED')).toBe(false);
    // The short label needs no move in y: the same document with a short label has a smaller gap.
    const short = await run(source(FIXTURE).replace(/label: Health checks.*\}/, 'label: Check }'));
    expect(outletAnchor(short).y).toBeLessThan(port.y - 100);
    expect(refusals(model)).toEqual([]);
    expect(restoreLayoutModel(JSON.stringify(model)).lanes.map(item => item.id)).toEqual([lane!.id]);
  }, 120000);

  it('a move in y that shifts the outlet down moves the lower end of the lane with the port, and a second replay changes nothing', async () => {
    const model = copy(await run(source(FIXTURE)));
    const lane = sideLanes(model)[0]!, before = structuredClone(lane), link = model.links.find(item => item.id === (lane.owner as { id: string }).id)!;
    const node = model.nodes['outlet']!;
    node.bounds!.y += 30;
    for (const port of node.ports) { port.anchor!.y += 30; if (port.pill) port.pill.bounds.y += 30; }
    rebuildLaneExtents(model);
    expect(lane.x).toBe(before.x);
    expect(lane.bounds.y).toBe(before.bounds.y);
    expect(lane.bounds.height).toBeCloseTo(before.bounds.height + 30, 6);
    expect(lane.bounds).toEqual({ ...lane.bounds, ...sideLaneExtent(model, lane, link) });
    expect(link.fixedSegments![1]!.from.y).toBeCloseTo(outletAnchor(model).y, 6);
    const once = JSON.stringify([model.lanes, model.links.map(item => item.fixedSegments)]);
    rebuildLaneExtents(model);
    expect(JSON.stringify([model.lanes, model.links.map(item => item.fixedSegments)])).toBe(once);
    expect(lane.owner).toEqual(before.owner);
    expect(lane.id).toBe(before.id);
  }, 120000);

  it('validateLanes rejects a side lane with the full band as its extent, a foreign id and a second lane', async () => {
    const model = await run(source(FIXTURE));
    expect(() => validateLanes(copy(model))).not.toThrow();
    const band = copy(model);
    const tier = band.tierBands.find(item => item.tier === sideLanes(band)[0]!.tier)!.bounds!, pad = 10 + 1;
    Object.assign(sideLanes(band)[0]!.bounds, { y: tier.y - pad, height: tier.height + 2 * pad });
    expect(() => validateLanes(band)).toThrow(/extent/);
    // The candidacy is frozen at 7a: a neighbour that stands beyond the outlet later is a warning of 7f (side-lane-route.test.ts), not a throw.
    // A side lane with a foreign id, and a second side lane for the same link.
    const renamed = copy(model);
    sideLanes(renamed)[0]!.id = 'side-lane:other';
    expect(() => validateLanes(renamed)).toThrow();
    const twice = copy(model);
    twice.lanes.push(structuredClone(sideLanes(twice)[0]!));
    expect(() => validateLanes(twice)).toThrow();
  }, 120000);

  it('a body between the face and the lane gives no side lane (SIDE_LANE_REFUSED, body)', async () => {
    // A third node of the outlet's row stands beyond the outlet, between its face and the lane.
    const yaml = source(FIXTURE).replace('  tail: {', '  extra: { group: bank, class: server, label: Extra }\n  tail: {')
      .replace('links:\n', 'links:\n  - [fe, extra]\n  - [extra, tail]\n');
    const model = await run(yaml);
    expect(sideLanes(model)).toEqual([]);
    expect(refusals(model)).toEqual([expect.objectContaining({ severity: 'info', owners: [{ kind: 'link', id: expect.any(String) }], message: expect.stringContaining('(body)') })]);
    expect(model.links.every(item => item.fixedSegments === undefined)).toBe(true);
  }, 120000);

  it('reseatLanes leaves a side lane alone and the replay never rebuilds it as a transit lane', async () => {
    const model = copy(await run(source(FIXTURE)));
    const before = structuredClone(model.lanes), segments = structuredClone(model.links.map(item => item.fixedSegments));
    expect(reseatLanes(model)).toBe(false);
    rebuildLaneExtents(model);
    expect(model.lanes).toEqual(before);
    expect(model.links.map(item => item.fixedSegments)).toEqual(segments);
    expect(sideLanes(model)[0]).toMatchObject({ kind: 'side' });
  }, 120000);

  it('an old layout JSON with no kind on its lanes restores, and a transit lane keeps no kind', async () => {
    const model = await run(source('a-transit-inside-a-canton'));
    expect(model.lanes.length).toBeGreaterThan(0);
    const json = JSON.stringify(model);
    expect(json.includes('"kind":"side"')).toBe(false);
    for (const lane of model.lanes) expect(Object.keys(lane)).not.toContain('kind');
    expect(restoreLayoutModel(json).lanes).toHaveLength(model.lanes.length);
  }, 120000);

  // A document with no side lane stays as it was: no lane carries a kind or a port and nothing is refused.
  it.each(['a-transit-inside-a-canton', 'a-foreign-lane-stands-outside-the-frame', 'a-side-hint-moves-a-port-to-a-lateral-side'])(
    'a document with no lateral port with a lane is unchanged: %s', async name => {
      const model = await run(source(name));
      expect(model.lanes.some(lane => 'kind' in lane || 'port' in lane || lane.id.startsWith('side-lane:'))).toBe(false);
      expect(refusals(model)).toEqual([]);
      expect(model.links.flatMap(item => item.fixedSegments ?? []).every(segment => !segment.lane?.startsWith('side-lane:'))).toBe(true);
    }, 120000);
});
