import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel, Point } from '../../src/index.js';
import { overlayBasePath, publishedOverlayPath, sharedBlockers } from '../../src/layout/overlay-paths.js';
import { sharedTrackPairs } from '../../src/layout/overlay-tracks.js';
import { OVERLAY_SEAT_CUT, SEAT_TRIALS, seatMoves, seatOverlayEnds } from '../../src/layout/overlay-seat.js';
import { freeOverlayPorts } from '../../src/layout/overlay-nest.js';
import { portEndInsets } from '../../src/layout/port-insets.js';
import { linkStrokeWidth, overlayTrackPitch } from '../../src/theme/geometry.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { withLayoutEntry } from '../aspect-fixture.js';

// Dense-16x9 ticket 26: two overlay end runs of different nodes never stand on one track where a free port can take a seat.
const yaml = readFileSync(new URL('../../goldens/synthetic/an-overlay-end-run-seats-its-port-a-track-pitch-off-a-foreign-end-run.yaml', import.meta.url), 'utf8');
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const pointsOf = (segments: readonly { from: Point; to: Point }[]): Point[] => (segments.length ? [segments[0]!.from, ...segments.map(segment => segment.to)] : []);
const overlays = (model: LayoutModel) => model.links.filter(link => link.layer === 'overlay' || link.family === 'overlay');
const shares = (model: LayoutModel, path: (link: LayoutModel['links'][number]) => Point[]): number =>
  sharedTrackPairs(overlays(model).map(link => ({ points: path(link), strokeWidth: linkStrokeWidth(link) }))).length;
const errorGates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => gate.severity === 'error' && gate.violations.length).map(([id]) => id);
const linkOf = (model: LayoutModel, from: string) => overlays(model).find(link => link.attachments!.from.node === from)!;
const portOf = (model: LayoutModel, from: string) => {
  const end = linkOf(model, from).attachments!.from;
  return model.nodes[from]!.ports.find(port => port.ref.ordinal === end.ordinal && port.ref.name === end.name)!;
};

describe('an overlay end run seats its port a track pitch off a foreign end run (dense-16x9 ticket 26)', () => {
  it('seats T2\'s overlay port one track pitch from T1\'s riser: no track shared, no bend, turn or crossing more', async () => {
    const model = await run(yaml);
    expect(shares(model, link => pointsOf(link.path!.segments))).toBe(0);
    expect(shares(model, link => pointsOf(overlayBasePath(model, link).segments))).toBe(0);
    // T1's link comes down into B1 by its last run; T2's link leaves T2 by its first run, now one track pitch beside it.
    const one = pointsOf(linkOf(model, 't1').path!.segments), two = pointsOf(linkOf(model, 't2').path!.segments);
    const pitch = overlayTrackPitch(linkStrokeWidth(linkOf(model, 't1')), linkStrokeWidth(linkOf(model, 't2')));
    expect(Math.abs(two[0]!.x - one.at(-1)!.x)).toBeCloseTo(pitch, 6);
    expect(two[0]!.x).toBeCloseTo(portOf(model, 't2').anchor!.x, 6);
    expect(one.length).toBe(4);
    expect(two.length).toBe(4);
    expect(errorGates(model)).toEqual([]);
  }, 120000);

  it('moves nothing when the layer holds no such pair, and seats a pair again from the shared place', async () => {
    const model = structuredClone(await run(yaml));
    expect(seatOverlayEnds(model)).toEqual([]);
    // Put T2's port back 1.1 px beside T1's riser: the seat takes it to the same place again, and only that port moves.
    const port = portOf(model, 't2'), seated = port.anchor!.x, riser = pointsOf(linkOf(model, 't1').path!.segments).at(-1)!.x;
    port.anchor = { ...port.anchor!, x: riser - 1.1 };
    const others = Object.values(model.nodes).flatMap(node => node.ports.filter(item => item !== port).map(item => ({ ...item.anchor! })));
    expect(seatOverlayEnds(model)).toHaveLength(1);
    expect(port.anchor!.x).toBeCloseTo(seated, 6);
    expect(Object.values(model.nodes).flatMap(node => node.ports.filter(item => item !== port).map(item => ({ ...item.anchor! })))).toEqual(others);
    const shapes = sharedBlockers(model);
    expect(shares(model, link => pointsOf(publishedOverlayPath(model, link, shapes).segments))).toBe(0);
  }, 120000);

  it('pushes the neighbours on the side it moves to by their pitch, and refuses a push past the end inset', async () => {
    const model = structuredClone(await run(yaml));
    const node = model.nodes.t2!, port = portOf(model, 't2'), all = () => true;
    const face = node.ports.filter(item => item.side === 'bottom').sort((a, b) => a.engineOrder! - b.engineOrder!);
    const right = node.bounds!.x + node.bounds!.width - portEndInsets(node, 'bottom').high, pitch = node.sidePitch!.bottom!;
    const [, , next, last] = face.map(item => item.anchor!.x);
    expect(face[1]).toBe(port);
    // The last port stands on the end inset already.
    expect(last).toBeCloseTo(right, 6);
    // The neighbours on the right are routed ports: none of them is free, so a move that reaches one is refused.
    expect(seatMoves(model, 't2', port, next! - 1, freeOverlayPorts(model).free)).toBeUndefined();
    // Read as free, they move on by the face pitch, in face order, and a neighbour already a pitch away stays; the last that moves may
    // reach the end inset and no further.
    const reach = last! - 2 * pitch;
    expect(seatMoves(model, 't2', port, reach, all)?.map(item => item.to)).toEqual([reach, reach + pitch]);
    expect(seatMoves(model, 't2', port, reach + 0.5, all)).toBeUndefined();
    // A move that keeps the pitch to the neighbour moves the port alone.
    expect(seatMoves(model, 't2', port, next! - pitch, all)?.map(item => item.to)).toEqual([next! - pitch]);
  }, 120000);

  it('decides the same seat when the links are listed the other way round (R3)', async () => {
    const [model, links] = await Promise.all([run(yaml), run(reversed(yaml, 'links'))]);
    expect(portOf(links, 't2').anchor).toEqual(portOf(model, 't2').anchor);
    expect(shares(links, link => pointsOf(link.path!.segments))).toBe(0);
  }, 180000);
  // Review 1 of ticket 26: the straight test reads the published path, under every option. With `overlayOverBodies` both links publish as
  // one segment over the bodies, though their base paths still detour and stand 1.1 px apart: no port takes a seat for a share the
  // published layer does not have.
  it('leaves the port of an overlay that publishes straight where it stands, under overlayOverBodies', async () => {
    const model = await run(withLayoutEntry(yaml, 'overlayOverBodies: true'));
    expect(overlays(model).map(link => link.path!.segments.length)).toEqual([1, 1]);
    const base = (link: LayoutModel['links'][number]) => pointsOf(overlayBasePath(model, link).segments);
    const one = base(linkOf(model, 't1')), two = base(linkOf(model, 't2'));
    expect(Math.abs(two[0]!.x - one.at(-1)!.x)).toBeLessThan(overlayTrackPitch(1.5, 1.5));
    expect(portOf(model, 't2').anchor!.x).toBeCloseTo(two[0]!.x, 6);
    expect(shares(model, base)).toBe(1);
    expect(shares(model, link => pointsOf(link.path!.segments))).toBe(0);
  }, 120000);

  // Review 1 of ticket 26 (R4, R6): twenty copies of the pair, side by side, and a guard that declines every seat. The seat stops at
  // SEAT_TRIALS and names the pairs it left untried.
  it('names the pairs left untried when the trials run out', async () => {
    const placed = structuredClone(await run(yaml));
    const port = portOf(placed, 't2');
    port.anchor = { ...port.anchor!, x: pointsOf(linkOf(placed, 't1').path!.segments).at(-1)!.x - 1.1 };
    const COPIES = 20;
    const ids = new Set([...Object.keys(placed.nodes), ...Object.keys(placed.groups), ...placed.links.map(link => link.id)]);
    const copyOf = (index: number): LayoutModel => {
      const name = (value: string): string => (ids.has(value) ? `c${String(index).padStart(2, '0')}-${value}` : value);
      const walk = (value: unknown, parent = ''): unknown => {
        if (Array.isArray(value)) return value.map(item => walk(item, parent));
        if (typeof value === 'string') return name(value);
        if (value === null || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [parent === 'nodes' || parent === 'groups' ? name(key) : key,
          key === 'x' && typeof item === 'number' ? item + 1000 * index : ['side', 'sizingSide'].includes(key) ? item : walk(item, key)]));
      };
      return walk({ nodes: placed.nodes, groups: placed.groups, links: placed.links, labels: placed.labels, document: placed.document }) as LayoutModel;
    };
    const model = structuredClone(placed);
    model.nodes = {}; model.groups = {}; model.links = []; model.labels = [];
    model.document = { ...placed.document, nodes: {}, groups: {}, links: [] };
    for (let index = 0; index < COPIES; index++) {
      const copy = copyOf(index);
      Object.assign(model.nodes, copy.nodes); Object.assign(model.groups, copy.groups);
      model.links.push(...copy.links); model.labels.push(...copy.labels);
      Object.assign(model.document.nodes, copy.document.nodes); Object.assign(model.document.groups, copy.document.groups);
      model.document.links.push(...copy.document.links);
    }
    const before = model.diagnostics.length;
    let trials = 0;
    expect(seatOverlayEnds(model, () => { trials++; return false; })).toEqual([]);
    expect(trials).toBe(SEAT_TRIALS);
    const cut = model.diagnostics.slice(before);
    expect(cut.map(item => item.code)).toEqual([OVERLAY_SEAT_CUT]);
    const named = cut[0]!.owners!.flatMap(owner => ('id' in owner ? [owner.id] : []));
    // The first copies were tried in full; the last one was not.
    expect(named.some(id => id.startsWith('c00-'))).toBe(false);
    expect(named.some(id => id.startsWith(`c${COPIES - 1}-`))).toBe(true);
    // With a guard that keeps each seat, one trial seats each pair: the first SEAT_TRIALS copies take a seat, and the cut names the rest.
    const kept = structuredClone(model);
    kept.diagnostics = [];
    expect(seatOverlayEnds(kept)).toHaveLength(SEAT_TRIALS);
    const left = [...new Set(kept.diagnostics.filter(item => item.code === OVERLAY_SEAT_CUT).flatMap(item => item.owners!.flatMap(owner => ('id' in owner ? [owner.id.slice(0, 3)] : []))))];
    expect(left).toEqual(Array.from({ length: COPIES - SEAT_TRIALS }, (_, index) => `c${SEAT_TRIALS + index}`));
  }, 120000);
});
