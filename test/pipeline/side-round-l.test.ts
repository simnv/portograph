import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { reserveLinkLabelRoom } from '../../src/layout/bands.js';
import { crosses, overlayPath } from '../../src/layout/overlay-paths.js';
import { LABEL_BORDER_REACH, LINK_LABEL_GEOMETRY } from '../../src/layout/link-labels.js';
import { measureText } from '../../src/text/index.js';
import { measureSides } from '../../src/layout/side-measure.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 116 (docs/design/side-faces.md, Q109): an overlay link turns once into a lateral side. */
const L_FIXTURE = 'an-overlay-turns-once-into-a-lateral-side';
const yaml = readFileSync(new URL(`../../goldens/synthetic/${L_FIXTURE}.yaml`, import.meta.url), 'utf8');
const run = (extra: Partial<Parameters<typeof layout>[1]> = {}, text = yaml): Promise<LayoutModel> =>
  layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...extra });
const copy = (model: LayoutModel): LayoutModel => JSON.parse(JSON.stringify(model)) as LayoutModel;
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);
const overlay = (model: LayoutModel) => model.links.find(link => link.layer === 'overlay')!;
const moveNode = (model: LayoutModel, id: string, dx: number, dy: number): void => {
  const node = model.nodes[id]!;
  node.bounds!.x += dx; node.bounds!.y += dy;
  for (const port of node.ports) { port.anchor!.x += dx; port.anchor!.y += dy; if (port.pill) { port.pill.bounds.x += dx; port.pill.bounds.y += dy; } }
};

describe('the side round offers the L shape for an overlay link', () => {
  it('turns once into the left face of the outlet, above the flank port, with every gate passing', async () => {
    const model = await run();
    const link = overlay(model), segments = link.path!.segments;
    expect(segments).toHaveLength(2);
    const [down, across] = segments;
    expect(down!.from.x).toBe(down!.to.x);
    expect(across!.from.y).toBe(across!.to.y);
    const lb = model.nodes['lb']!, lbPort = lb.ports[0]!;
    expect(lbPort.side).toBe('bottom');
    expect(down!.from.y).toBe(lb.bounds!.y + lb.bounds!.height);
    const outlet = model.nodes['outlet']!;
    const hinted = outlet.ports.find(port => port.sideHint === true)!, flank = outlet.ports.find(port => port.side === 'left' && port.sideHint !== true)!;
    expect(hinted.side).toBe('left');
    expect(hinted.naturalSide).toBe('top');
    expect(hinted.anchor!.y).toBeLessThan(flank.anchor!.y);
    expect(across!.to.x).toBe(outlet.bounds!.x);
    expect(codes(model)).toContain('SIDE_HINT_TAKEN');
    expect(model.diagnostics.find(item => item.code === 'SIDE_HINT_TAKEN')!.message).toContain('L shape');
    expect(codes(model)).not.toContain('SIDE_SHAPE_LOST');
    expect(codes(model)).not.toContain('LINK_LABEL_ROOM_UNRESERVED');
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed)).toEqual([]);
    // The label stands on the longest run, in the room reserved for it.
    const label = model.labels.find(item => item.role === 'link' && item.owner.kind === 'link' && item.owner.id === link.id)!;
    expect(label.omitted).toBeUndefined();
    const longest = [down!, across!].sort((a, b) => Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y) - Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y))[0]!;
    const box = label.bounds!, centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (longest.from.x === longest.to.x) expect(centre.y).toBeCloseTo((longest.from.y + longest.to.y) / 2, 6);
    else expect(centre.x).toBeCloseTo((longest.from.x + longest.to.x) / 2, 6);
  }, 60000);

  it('on the natural sides the same link goes round the cache with two turns or more', async () => {
    const model = await run({ testMaxReruns: 0 });
    expect(overlay(model).path!.segments.length).toBeGreaterThan(2);
    expect(codes(model)).toContain('SIDE_ROUND_SKIPPED');
  }, 60000);

  it('two runs give byte-identical layout JSON', async () => {
    const strip = (model: LayoutModel): string => JSON.stringify(model, (key, value: unknown) => key === 'runtime' ? undefined : value);
    expect(strip(await run())).toBe(strip(await run()));
  }, 60000);

  it('with both corners clear, the lateral port is at the lower end (tie-break 4)', async () => {
    // Natural sides, then the cache moves to the middle of the square the two ends span and the pad chain leaves it: both L shapes are clear.
    const model = copy(await run({ testMaxReruns: 0 }));
    expect(overlay(model).path!.segments.length).toBeGreaterThan(2);
    moveNode(model, 'pad', 0, 3000); moveNode(model, 'mid', 0, 3000);
    const outlet = model.nodes['outlet']!, lb = model.nodes['lb']!;
    // No other port on the outlet's left face, so neither shape needs node growth and the tie goes to the lower end.
    outlet.ports = outlet.ports.filter(port => port.side !== 'left');
    const cache = model.nodes['cache']!;
    const target = { x: lb.ports[0]!.anchor!.x + 40, y: (lb.bounds!.y + lb.bounds!.height + outlet.bounds!.y) / 2 };
    moveNode(model, 'cache', target.x - cache.bounds!.x, target.y - cache.bounds!.y - cache.bounds!.height / 2);
    cache.bounds!.width = 200;
    const offer = measureSides(model, model, new Set());
    expect(offer.hints.size).toBe(1);
    const [key, side] = [...offer.hints][0]!;
    expect(JSON.parse(key)[0]).toBe('outlet');
    expect(side).toBe('left');
    expect([...offer.promised.values()]).toEqual([expect.objectContaining({ bends: 1, shape: 'L' })]);
  }, 60000);
});

describe('an L is offered only when both runs are clear', () => {
  it('sanity: offers nothing when a body of the middle rank stands on the horizontal run', async () => {
    const model = copy(await run({ testMaxReruns: 0 }));
    const outlet = model.nodes['outlet']!, cache = model.nodes['cache']!, lb = model.nodes['lb']!;
    // Put the cache on the only two-segment way: the horizontal run into the outlet's left face, a little above the flank port.
    const y = outlet.bounds!.y + outlet.bounds!.height / 2 - 12;
    moveNode(model, 'cache', lb.ports[0]!.anchor!.x + 40 - cache.bounds!.x, y - cache.bounds!.height / 2 - cache.bounds!.y);
    expect(measureSides(model, model, new Set()).hints.size).toBe(0);
  }, 60000);

  it('sanity: publishes no overlay run through a node body on a golden that once did (review H1)', async () => {
    // The derivation falls back to paths that ignore bodies when every way round is blocked; such a path has two segments and is no L.
    const text = readFileSync(new URL('../../goldens/synthetic/a-refused-close-up-keeps-the-node-labels-in-order.yaml', import.meta.url), 'utf8');
    const model = await run({}, text);
    const through = model.links.filter(link => link.layer === 'overlay' && link.path !== undefined).flatMap(link => link.path!.segments
      .filter(({ from, to }) => Object.values(model.nodes).some(node => node.bounds !== undefined && crosses(from, to, node.bounds))).map(() => link.id));
    expect(through).toEqual([]);
  }, 120000);
});

describe('the label room of an overlay L', () => {
  const LONG = 'a considerably longer description of this health probe, sent across the site and back through the outlet to the relay that reports it';
  // The published L, with its vertical run shortened so that the horizontal run is the longest, and a label longer than that run.
  async function shortDrop(): Promise<{ model: LayoutModel; split: number }> {
    const model = copy(await run());
    const link = overlay(model);
    model.document.links[link.sourceIndex]!.label = LONG;
    for (const id of ['lb', 'shim', 'pad', 'mid', 'cache']) moveNode(model, id, 0, 100);
    expect(overlayPath(model, link).segments).toHaveLength(2);
    const outlet = model.nodes['outlet']!, lb = model.nodes['lb']!;
    const split = (lb.bounds!.x + lb.bounds!.width + outlet.bounds!.x) / 2;
    return { model, split };
  }

  it('reserves the room at the split of a horizontal run', async () => {
    const { model, split } = await shortDrop();
    const before = model.nodes['outlet']!.bounds!.x;
    expect(reserveLinkLabelRoom(model)).toBe(true);
    expect(model.nodes['outlet']!.bounds!.x).toBeGreaterThan(before);
    expect(model.nodes['lb']!.bounds!.x + model.nodes['lb']!.bounds!.width).toBeLessThan(split);
    expect(codes(model)).not.toContain('LINK_LABEL_ROOM_UNRESERVED');
    // A fixed point: the room is reserved, a second pass asks for nothing more.
    expect(reserveLinkLabelRoom(model)).toBe(false);
  }, 60000);

  it('reserves the room when the peer that holds the vertical run is wide and stands over the middle of the run (review H2)', async () => {
    const { model } = await shortDrop();
    const lb = model.nodes['lb']!, before = model.nodes['outlet']!.bounds!.x, lbRight = lb.bounds!.x + lb.bounds!.width;
    lb.bounds!.width += 220; // the balancer now reaches past the middle of the run; its port stays where it is
    model.groups['west']!.bounds!.width += 220;
    expect(overlayPath(model, overlay(model)).segments).toHaveLength(2);
    const widened = lb.bounds!.x + lb.bounds!.width;
    expect(widened).toBeGreaterThan((lb.ports[0]!.anchor!.x + before) / 2);
    expect(widened).toBeLessThan(before);
    expect(reserveLinkLabelRoom(model)).toBe(true);
    expect(model.nodes['outlet']!.bounds!.x).toBeGreaterThan(before);
    expect(lb.bounds!.x + lb.bounds!.width).toBe(widened);
    expect(lbRight).toBeLessThan(widened);
    expect(reserveLinkLabelRoom(model)).toBe(false);
    expect(codes(model)).not.toContain('LINK_LABEL_ROOM_UNRESERVED');
  }, 60000);

  it('reports the room as unreserved when the peer leaves no gap before the lateral face (review H2)', async () => {
    const { model } = await shortDrop();
    const lb = model.nodes['lb']!, outlet = model.nodes['outlet']!;
    lb.bounds!.width = outlet.bounds!.x - lb.bounds!.x + 5;
    expect(reserveLinkLabelRoom(model)).toBe(false);
    expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ROOM_UNRESERVED').map(item => item.message)).toEqual([expect.stringMatching(/no gap/)]);
  }, 60000);

  it('refuses when a lane stands beyond the split, and names the link', async () => {
    const { model, split } = await shortDrop();
    model.lanes.push({ id: 'lane:"transit":9', owner: { kind: 'link', id: 'transit' }, layer: 'routed', group: 'back', tier: 9, side: 'right', x: split + 10,
      bounds: { x: split - 7, y: 0, width: 34, height: 10 } });
    const before = model.nodes['outlet']!.bounds!.x;
    expect(reserveLinkLabelRoom(model)).toBe(false);
    expect(model.nodes['outlet']!.bounds!.x).toBe(before);
    expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ROOM_UNRESERVED').map(item => item.message)).toEqual([expect.stringMatching(/beyond a reserved lane/)]);
    expect(model.diagnostics.find(item => item.code === 'LINK_LABEL_ROOM_UNRESERVED')!.owners).toEqual([{ kind: 'link', id: overlay(model).id }]);
  }, 60000);

  // The shortened published L reflected in x: the lateral face of the outlet now looks east and the balancer stands to the east of it.
  async function mirrored(): Promise<LayoutModel> {
    const { model } = await shortDrop(), width = 4000;
    const flip = (box: { x: number; width: number }): void => { box.x = width - box.x - box.width; };
    for (const node of Object.values(model.nodes)) {
      flip(node.bounds!);
      for (const port of node.ports) {
        port.anchor!.x = width - port.anchor!.x;
        if (port.pill) flip(port.pill.bounds);
        if (port.side === 'left') port.side = 'right'; else if (port.side === 'right') port.side = 'left';
      }
    }
    for (const group of Object.values(model.groups)) if (group.bounds) flip(group.bounds);
    return model;
  }

  it('reserves the room on a west lateral face when the peer overhangs the face by 10 px, with no diagnostic (re-check)', async () => {
    const model = await mirrored();
    const lb = model.nodes['lb']!, outlet = model.nodes['outlet']!;
    expect(overlayPath(model, overlay(model)).segments).toHaveLength(2);
    // The balancer reaches 10 px past the outlet's right face; its port stays where it is.
    const edge = lb.bounds!.x + lb.bounds!.width, next = outlet.bounds!.x + outlet.bounds!.width - 10;
    lb.bounds!.x = next; lb.bounds!.width = edge - next;
    const west = model.groups['west']!.bounds!;
    west.width += west.x - next; west.x = next;
    expect(overlayPath(model, overlay(model)).segments).toHaveLength(2);
    expect(reserveLinkLabelRoom(model)).toBe(true);
    expect(lb.bounds!.x).toBeGreaterThan(next);
    expect(codes(model)).not.toContain('LINK_LABEL_ROOM_UNRESERVED');
    expect(reserveLinkLabelRoom(model)).toBe(false);
  }, 60000);

  it('reserves a vertical run of an L to the lateral anchor, no more (review L1)', async () => {
    const model = copy(await run());
    const link = overlay(model);
    model.document.links[link.sourceIndex]!.label = LONG;
    const required = measureText(LONG, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
    expect(reserveLinkLabelRoom(model)).toBe(true);
    const anchor = model.nodes['outlet']!.ports.find(port => port.sideHint === true)!.anchor!.y;
    const lb = model.nodes["lb"]!, drop = anchor - (lb.bounds!.y + lb.bounds!.height);
    // Measured to the node top the run would end one port depth short and the tier gap would grow by that much too much.
    expect(drop).toBeGreaterThanOrEqual(required - 1e-6);
    // The label stays in one region (ticket 19): the window of the run below the border of the upper end's group, 8 px clear of it,
    // holds the label and no more.
    const upper = model.groups[model.document.nodes['lb']!.group]!.bounds!, width = required - 2 * LINK_LABEL_GEOMETRY.shortenMargin;
    const window = anchor - LINK_LABEL_GEOMETRY.shortenMargin - (upper.y + upper.height + LABEL_BORDER_REACH);
    expect(window).toBeGreaterThanOrEqual(width - 1e-6);
    expect(window).toBeLessThan(width + 1);
    expect(reserveLinkLabelRoom(model)).toBe(false);
  }, 60000);

  it('keeps the old answer for an overlay link that has no hinted end', async () => {
    const { model } = await shortDrop();
    for (const node of Object.values(model.nodes)) for (const port of node.ports) delete port.sideHint;
    expect(reserveLinkLabelRoom(model)).toBe(false);
    expect(codes(model)).toContain('LINK_LABEL_ROOM_UNRESERVED');
  }, 60000);
});
