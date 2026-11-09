import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { chordKind, chordVerdict, edgeLeavers, SIDE_EDGE_SLACK } from '../../src/layout/frame-paths.js';
import { chordTrace, pitchRefused, tooClose } from '../../src/layout/side-chords.js';
import { measureSides } from '../../src/layout/side-measure.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
// The group lift (ticket 08) is off in these tests: every lift trial of `providers` is declined, but each trial is one more whole run,
// and the tests count the side-round runs of one command. `lift.test.ts` tests the lift.

/** Ticket 117 (docs/design/side-faces.md, Section 9; docs/design/routed-chords.md, Section 3): a routed chord leaves a lateral side. */
const FAR = 'a-location-router-leaves-a-lateral-side-toward-a-far-provider';
const source = readFileSync(new URL(`../../goldens/synthetic/${FAR}.yaml`, import.meta.url), 'utf8');
type Link = LayoutModel['links'][number];
interface Counted { model: LayoutModel; places: number }
async function run(extra: Partial<Parameters<typeof layout>[1]> = {}): Promise<Counted> {
  let places = 0;
  const model = await layout(parse(source), { createElkAttempt: () => { places++; return createAttempt(); }, createRouteAttempt: createAvoidAttempt, testLiftOff: true, ...extra });
  return { model, places };
}
const strip = (model: LayoutModel): string => JSON.stringify(model, (key, value: unknown) => key === 'runtime' || key === 'reservations' ? undefined : value);
const refusals = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'ROUTED_CHORD_REFUSED').map(item => item.message);
const toProvider = (model: LayoutModel, node: string): Link => model.links.find(link => link.attachments!.from.node === node && link.attachments!.to.node === 'provider')!;

/**
 * The far link with both ends on a lateral face: the router's bottom port on its `left` face at height `y`, and the provider's top port on its `right` face
 * (a copy of the model's nodes; the links are shared). The chord runs from the router's left face, leftward and down, to the provider's right face.
 */
function lateralPair(model: LayoutModel, above = 12): { model: LayoutModel; link: Link } {
  const link = toProvider(model, 'west-router'), end = link.attachments!.to;
  const nodes = { ...model.nodes };
  const router = nodes['west-router']!.bounds!, provider = nodes['provider']!.bounds!, frame = model.frames!.find(item => item.id === 'west')!.box;
  // The provider's lateral port stands near its top; the router's face is set so that the chord crosses the frame's left edge `above` px above the frame's bottom corner.
  const toX = provider.x + provider.width, toY = provider.y + 10;
  const s = (frame.x - router.x) / (toX - router.x), y = (frame.y + frame.height - above - s * toY) / (1 - s);
  nodes['west-router'] = { ...nodes['west-router']!, ports: nodes['west-router']!.ports.map(port => port.side === 'bottom'
    ? { ...port, side: 'left' as const, sideHint: true, anchor: { x: router.x, y } } : port) };
  nodes['provider'] = { ...nodes['provider']!, ports: nodes['provider']!.ports.map(port => port.ref.ordinal === end.ordinal && port.ref.name === end.name
    ? { ...port, side: 'right' as const, sideHint: true, anchor: { x: toX, y: toY } } : port) };
  return { model: { ...model, nodes }, link };
}

describe('a routed chord leaves a lateral side', () => {
  it('on the far location fixture one link is refused for its edge, and the side round frees it as an L into the lateral face (ticket 22)', async () => {
    const before = await run({ testMaxReruns: 0 });
    expect(refusals(before.model).filter(message => message.endsWith('edge.'))).toHaveLength(1);
    const { model, places } = await run();
    expect(places).toBe(2);
    expect(refusals(model)).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'SIDE_HINT_TAKEN')).toHaveLength(1);
    // Ticket 22 (routed-chords.md, Section 15.1): a long, flat chord never joins perpendicular faces. The router's bottom face and the provider's right face stand at 90 degrees,
    // so the freed link is an orthogonal L into the lateral face, not the chord of ticket 117. The east link joins bottom to top and stays a chord.
    const east = toProvider(model, 'east-router');
    expect(east.technique).toBe('straight');
    expect(east.path!.segments).toHaveLength(1);
    const freed = toProvider(model, 'west-router');
    const port = model.nodes['provider']!.ports.find(item => item.sideHint === true)!;
    expect(port.side).toBe('right');
    expect(port.naturalSide).toBe('top');
    expect(freed.technique).not.toBe('straight');
    for (const segment of freed.path!.segments) expect(segment.from.x === segment.to.x || segment.from.y === segment.to.y).toBe(true);
    expect(freed.path!.segments.at(-1)!.to).toEqual(port.anchor);
    expect(Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed)).toEqual([]);
  }, 60000);

  it('two runs give byte-identical layout JSON', async () => {
    expect(strip((await run()).model)).toBe(strip((await run()).model));
  }, 60000);

  it('a diagram with no routed candidate for a side is the layout the round makes when it is switched off', async () => {
    const name = 'a-routed-link-between-frames-draws-straight';
    const text = readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
    const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true };
    const one = await layout(parse(text), options), two = await layout(parse(text), { ...options, testMaxReruns: 0 });
    expect(strip(one)).toBe(strip(two));
  }, 60000);
});

describe('the facing edge is read per port face', () => {
  it('a lateral chord that leaves through the side edge its port faces is a chord', async () => {
    const { model } = await run({ testMaxReruns: 0 });
    const pair = lateralPair(model, 12);
    expect(chordKind(pair.model, pair.link)).toBe('cross');
    expect(chordVerdict(pair.model, pair.link, 0)).toHaveProperty('segment');
  }, 60000);

  it('a steep chord from a lateral port that reaches the frame bottom edge first is refused for its edge', async () => {
    const { model } = await run({ testMaxReruns: 0 });
    const link = toProvider(model, 'east-router');
    const east = model.nodes['east-router']!.bounds!;
    // The peer end is moved to the right of the router, so the chord runs out of the right face and down: it reaches the frame's bottom edge first.
    const nodes = { ...model.nodes };
    nodes['east-router'] = { ...nodes['east-router']!, ports: nodes['east-router']!.ports.map(port => port.side === 'bottom'
      ? { ...port, side: 'right' as const, sideHint: true, anchor: { x: east.x + east.width, y: east.y + 25 } } : port) };
    nodes['provider'] = { ...nodes['provider']!, ports: nodes['provider']!.ports.map(port => port.side === 'top' ? { ...port, anchor: { x: east.x + east.width + 120, y: port.anchor!.y } } : port) };
    // Right face to top face stand at 90 degrees, but the chord is shorter than the straight-link limit, so the faces do not refuse it (ticket 22).
    const steep = { ...model, nodes };
    expect(chordKind(steep, link)).toBe('cross');
    expect(chordVerdict(steep, link, SIDE_EDGE_SLACK)).toEqual({ reason: 'edge' });
    steep.frozenChords = [link.id];
    expect(edgeLeavers(steep)).toEqual([link.id]);
  }, 60000);

  it('a chord that meets a foreign frame in the column slack is refused for its frame', async () => {
    const { model } = await run({ testMaxReruns: 0 });
    const pair = lateralPair(model, 12);
    // The other location frame grows down over the chord.
    const frames = model.frames!.map(frame => frame.id === 'east' ? { ...frame, box: { ...frame.box, height: 330 } } : frame);
    expect(chordVerdict({ ...pair.model, frames }, pair.link, 0)).toEqual({ reason: 'frame' });
  }, 60000);

  it('the fixed point and the freeze keep the corner margin plus the slack at a side edge, edgeLeavers keeps the margin alone', async () => {
    const { model } = await run({ testMaxReruns: 0 });
    // The chord crosses the frame's left edge 12 px above the frame's bottom corner: inside the margin (10 px), outside margin plus slack (14 px).
    const near = lateralPair(model, 12);
    expect(chordVerdict(near.model, near.link, 0)).toHaveProperty('segment');
    expect(chordVerdict(near.model, near.link, SIDE_EDGE_SLACK)).toEqual({ reason: 'edge' });
    near.model.frozenChords = [near.link.id];
    expect(edgeLeavers(near.model)).toEqual([]);
  }, 60000);
});

describe('two chords from one lateral face keep the chord clearance', () => {
  const chord = (from: [number, number], to: [number, number]) => ({ from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] }, owner: { kind: 'link' as const, id: 'a' } });
  const other = (segment: ReturnType<typeof chord>) => ({ node: 'n', side: 'right', segment, stroke: 1 });
  it('refuses a second chord closer than 10 px, accepts one at 14 px, and excuses a strict crossing', () => {
    const first = other(chord([100, 50], [400, 150]));
    expect(tooClose(chord([100, 58], [400, 158]), 1, first)).toBe(true);
    expect(tooClose(chord([100, 64], [400, 164]), 1, first)).toBe(false);
    expect(tooClose(chord([100, 70], [400, 110]), 1, first)).toBe(false);
  });
  it('reads a chord accepted on any node or face, not only on the same one (review M2)', () => {
    const first = { node: 'router-a', side: 'left', segment: chord([100, 50], [400, 150]), stroke: 1 };
    expect(tooClose(chord([100, 56], [400, 156]), 1, first)).toBe(true);
  });
  it('pitchRefused reads every accepted chord: one on another node refuses a near chord, and a far one does not', () => {
    const near = { node: 'router-a', side: 'left', segment: chord([100, 50], [400, 150]), stroke: 1 };
    const far = { node: 'router-b', side: 'right', segment: chord([100, 300], [400, 400]), stroke: 1 };
    // The candidate belongs to router-b; the near chord stands on router-a (another node), and it is the first of the list.
    expect(pitchRefused(chord([100, 56], [400, 156]), 1, [near, far])).toBe(true);
    expect(pitchRefused(chord([100, 56], [400, 156]), 1, [far])).toBe(false);
    expect(pitchRefused(chord([100, 56], [400, 156]), 1, [])).toBe(false);
  });
});

describe('a chord is offered only when the fixed point of placement would hold it (ticket 117, sheet finding)', () => {
  it('offers the far link no chord at 90 degrees, and offers nothing when a held chord stands 3 px from the chord it would draw', async () => {
    const on = await run();
    // Ticket 22: the router's bottom face and the provider's right face stand at 90 degrees, so the hint gives an L, not a chord.
    expect(toProvider(on.model, 'west-router').technique).not.toBe('straight');
    const off = await run({ testMaxReruns: 0 });
    // The chord the probe draws: the router's bottom face to the middle of the provider's right face (`moved` puts a lone lateral port at the face centre).
    const end = toProvider(off.model, 'west-router').attachments!, router = off.model.nodes['west-router']!, provider = off.model.nodes['provider']!.bounds!;
    const drawn = { from: router.ports.find(port => port.side === 'bottom')!.anchor!, to: { x: provider.x + provider.width, y: provider.y + provider.height / 2 } };
    expect(end.to.node).toBe('provider');
    const plain = structuredClone(off.model) as LayoutModel;
    expect(measureSides(plain, plain, new Set()).hints.size).toBe(1);
    // The other provider link is a held chord in the way: its segment runs 3 px from the chord the hint would give, so the fixed point of placement refuses
    // that chord (`chord`), although `chordVerdict` alone accepts it.
    const blocked = structuredClone(off.model) as LayoutModel;
    const other = toProvider(blocked, 'east-router');
    other.path = { ...other.path!, segments: [{ ...other.path!.segments[0]!, from: { x: drawn.from.x, y: drawn.from.y + 3 }, to: { x: drawn.to.x, y: drawn.to.y + 3 } }] };
    expect(other.technique).toBe('straight');
    const events: Record<string, unknown>[] = [];
    chordTrace.on = event => events.push(event);
    try {
      // A routed L through a side lane (ticket 119) may take the link the chord cannot: only the chord shape is counted here.
      const offer = measureSides(blocked, blocked, new Set());
      expect([...offer.promised.values()].filter(item => item.shape === 'straight')).toEqual([]);
    } finally { delete chordTrace.on; }
    // A configuration with opposite faces is refused for the chord clearance to the held chord, named by
    // the fixed point of placement (not the offer logic, not `chordVerdict`).
    const refused = events.filter(event => event['ev'] === 'attempt' && event['offered'] === false).map(event => event['why'] as string);
    const held = refused.filter(why => why.startsWith('the fixed point'));
    expect(held.length).toBeGreaterThan(0);
    expect(held.every(why => why.endsWith(': chord'))).toBe(true);
  }, 60000);
});
