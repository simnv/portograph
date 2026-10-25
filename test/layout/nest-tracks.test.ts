import { describe, expect, it } from 'vitest';
import type { LayoutModel, Point, Rect } from '../../src/index.js';
import { nestTracks } from '../../src/layout/overlay-paths.js';
import type { NestHeld, NestMover, OverlayShape } from '../../src/layout/overlay-paths.js';
import { RectangleIndex } from '../../src/layout/rectangle-index.js';

/**
 * Architecture-2 ticket 24, review items: `nestTracks` trades the offsets of two crossing detours that the separation moved apart off
 * one track. The scene is the ticket's own face, drawn by hand: node A's right face holds two ports, A→D leaves the upper one (y 60)
 * and A→C the lower one (y 70); both rise beside A and run over the row to C and D. The separation gave the shorter A→C the inner
 * riser (x 107.75) and the inner run (y 40), and A→D the outer of both (x 113.25, y 34.5), so A→D's stub crosses A→C's riser and A→C's
 * run crosses A→D's riser: two crossing points, one pair. The trade of the two risers nests them (no crossing); the trade of the two
 * runs does not.
 */
const model = { document: { groups: {}, nodes: {}, links: [] }, groups: {}, nodes: {}, links: [] } as unknown as LayoutModel;
const bodies: Rect[] = [
  { x: 40, y: 45, width: 60, height: 40 }, // A
  { x: 270, y: 50, width: 60, height: 40 }, // C
  { x: 370, y: 50, width: 60, height: 40 }, // D
];
const shapesOf = (extra: Rect[] = []) => new RectangleIndex<OverlayShape>([...bodies, ...extra].map(box => ({ bounds: box, value: box })));

const baseC: Point[] = [{ x: 100, y: 70 }, { x: 107.75, y: 70 }, { x: 107.75, y: 40 }, { x: 300, y: 40 }, { x: 300, y: 50 }];
const baseD: Point[] = [{ x: 100, y: 60 }, { x: 107.75, y: 60 }, { x: 107.75, y: 40 }, { x: 400, y: 40 }, { x: 400, y: 50 }];
const drawnC: Point[] = baseC.map(point => ({ ...point }));
const drawnD: Point[] = [{ x: 100, y: 60 }, { x: 113.25, y: 60 }, { x: 113.25, y: 34.5 }, { x: 400, y: 34.5 }, { x: 400, y: 50 }];
/** After the trade of the risers: A→C on the outer riser, A→D on the inner one; the runs over the row keep their tracks. */
const nestedC: Point[] = [{ x: 100, y: 70 }, { x: 113.25, y: 70 }, { x: 113.25, y: 40 }, { x: 300, y: 40 }, { x: 300, y: 50 }];
const nestedD: Point[] = [{ x: 100, y: 60 }, { x: 107.75, y: 60 }, { x: 107.75, y: 34.5 }, { x: 400, y: 34.5 }, { x: 400, y: 50 }];

type Transform = (point: Point) => Point;
const identity: Transform = point => ({ ...point });
/** The scene mirrored below the row (the detours run under it), and turned onto a column face (a bottom face, the detours run beside a column). */
const below: Transform = point => ({ x: point.x, y: 200 - point.y });
const column: Transform = point => ({ x: point.y, y: point.x });
const boxBy = (box: Rect, transform: Transform): Rect => {
  const one = transform({ x: box.x, y: box.y }), two = transform({ x: box.x + box.width, y: box.y + box.height });
  return { x: Math.min(one.x, two.x), y: Math.min(one.y, two.y), width: Math.abs(two.x - one.x), height: Math.abs(two.y - one.y) };
};

interface Scene {
  transform?: Transform;
  reverse?: { c?: boolean; d?: boolean };
  labelled?: { c?: boolean; d?: boolean };
  fixed?: Point[][];
  shapes?: Rect[];
  labels?: Rect[];
  swap?: boolean;
}

/** Runs `nestTracks` on the scene; returns the drawn points of A→C and A→D, each from A's face, untransformed. */
function nest(scene: Scene = {}): { c: Point[]; d: Point[] } {
  const transform = scene.transform ?? identity;
  const by = (points: readonly Point[], reverse = false) => {
    const moved = points.map(transform);
    return reverse ? moved.reverse() : moved;
  };
  const back = (points: readonly Point[], reverse = false) => {
    const inverse = transform === below ? below : transform === column ? column : identity;
    const moved = points.map(inverse);
    return reverse ? moved.reverse() : moved;
  };
  const mover = (points: Point[], way: Point[], key: 'c' | 'd', order: number): NestMover => ({
    points: by(points, scene.reverse?.[key]), way: by(way, scene.reverse?.[key]), stroke: 1.5, labelled: scene.labelled?.[key] === true,
    ports: scene.reverse?.[key] ? [`${key}/0`, `a/${key}`] : [`a/${key}`, `${key}/0`], order,
  });
  const placed = [mover(drawnC, baseC, 'c', 1), mover(drawnD, baseD, 'd', 2)];
  if (scene.swap) placed.reverse();
  const fixed: NestHeld[] = (scene.fixed ?? []).map((points, index) => ({ points: by(points), strokeWidth: 1.5, ports: [`f${index}/0`, `f${index}/1`] }));
  const shapes = shapesOf((scene.shapes ?? []).map(box => boxBy(box, transform)));
  nestTracks(model, placed, fixed, shapes, [], (scene.labels ?? []).map(box => boxBy(box, transform)));
  const c = placed.find(item => item.ports.includes('a/c'))!, d = placed.find(item => item.ports.includes('a/d'))!;
  return { c: back(c.points, scene.reverse?.c), d: back(d.points, scene.reverse?.d) };
}

describe('nestTracks (architecture-2 ticket 24, review items)', () => {
  it('trades the two risers: A→C takes the outer riser, A→D the inner one, and the two no longer cross', () => {
    expect(nest()).toEqual({ c: nestedC, d: nestedD });
  });

  it('gives the same trade below a row and on a column face (mirrored and turned scenes)', () => {
    for (const transform of [below, column]) expect(nest({ transform })).toEqual({ c: nestedC, d: nestedD });
  });

  it('does not depend on the direction of a link (point order) or on the order of the movers (R3)', () => {
    for (const reverse of [{ c: true }, { d: true }, { c: true, d: true }]) {
      for (const transform of [identity, below, column]) {
        expect(nest({ reverse, transform })).toEqual({ c: nestedC, d: nestedD });
        expect(nest({ reverse, transform, swap: true })).toEqual({ c: nestedC, d: nestedD });
      }
    }
  });

  it('does not trade a labelled detour: its label keeps the outer side and the room 7f reserved', () => {
    expect(nest({ labelled: { d: true } })).toEqual({ c: drawnC, d: drawnD });
    expect(nest({ labelled: { c: true } })).toEqual({ c: drawnC, d: drawnD });
  });

  it('refuses a trade that uncrosses the pair but adds crossing points with the rest of the layer', () => {
    // A held diagonal zigzag beside A, between y 61 and 69: the outer riser A→C would take crosses it four times. The pair goes from
    // two crossing points to none, the layer from two to four.
    const zigzag = [{ x: 110, y: 61 }, { x: 117, y: 63 }, { x: 110, y: 65 }, { x: 117, y: 67 }, { x: 110, y: 69 }];
    expect(nest({ fixed: [zigzag] })).toEqual({ c: drawnC, d: drawnD });
    // The same zigzag out of the way of both risers: the trade stands.
    expect(nest({ fixed: [zigzag.map(point => ({ x: point.x + 100, y: point.y }))] })).toEqual({ c: nestedC, d: nestedD });
  });

  it('refuses a trade a moved run cannot keep the rules for (runRules): a body nearer than the clearance to the outer riser', () => {
    // A body 4.75 px right of x 113.25, beside the stretch of A→C's riser that A→D's riser does not cover (y 62 to 68).
    expect(nest({ shapes: [{ x: 118, y: 62, width: 12, height: 6 }] })).toEqual({ c: drawnC, d: drawnD });
    for (const transform of [below, column]) expect(nest({ transform, shapes: [{ x: 118, y: 62, width: 12, height: 6 }] })).toEqual({ c: drawnC, d: drawnD });
  });

  it('refuses a trade whose moved run enters the room of a link label (runRules)', () => {
    // A label box over x 111 to 125, y 62 to 68: the outer riser of A→C would run through it; the inner riser stood clear of it.
    expect(nest({ labels: [{ x: 111, y: 62, width: 14, height: 6 }] })).toEqual({ c: drawnC, d: drawnD });
    // The same box further right leaves the trade free.
    expect(nest({ labels: [{ x: 131, y: 62, width: 14, height: 6 }] })).toEqual({ c: nestedC, d: nestedD });
  });
});

