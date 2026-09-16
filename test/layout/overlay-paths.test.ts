import { describe, expect, it } from 'vitest';
import type { LayoutModel, Point } from '../../src/model/index.js';
import { OVERLAY_PILL_CLEARANCE, overlayPath } from '../../src/layout/overlay-paths.js';
import { retraces } from '../../src/route/validate.js';
import { scene, type Scene } from '../render/fixture.js';

/**
 * Stress ticket 20: an overlay link is a short stub straight out of each port and **one straight
 * segment** between the two stub ends, at whatever angle that is. The orthogonal staircase of
 * synthetics review ticket 01 is gone, and with it the eight ways round the shapes in between: a
 * diagonal draws through a body and the renderer's mask keeps the body readable. The geometry is
 * still the model's, so both renderers draw the same line.
 *
 * `scene` centres a port's pill on its anchor — 10 × 26 on a top or bottom side, 26 × 10 on a left
 * or right one — so a pill straddles the node edge exactly as placement leaves it. A stub therefore
 * reaches 13 + `OVERLAY_PILL_CLEARANCE` = 17 px from the anchor in these scenes.
 */
describe('overlay paths', () => {
  const CLEARANCE = OVERLAY_PILL_CLEARANCE;

  /** The polyline `overlayPath` states for the one overlay link of a hand-built scene. */
  const path = (input: Scene): Point[] => {
    const model: LayoutModel = scene(input);
    const link = model.links.find(item => item.layer === 'overlay')!;
    const built = overlayPath(model, link);
    // Every segment is the link's own and claims no reserved geometry.
    for (const segment of built.segments) {
      expect(segment.owner).toEqual({ kind: 'link', id: link.id });
      expect(segment.lane).toBeUndefined();
      expect(segment.barCross).toBeUndefined();
      expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThan(1e-9);
    }
    // Two stubs and one segment between them, or less where a stub collapses onto it.
    expect(built.segments.length).toBeLessThanOrEqual(3);
    expect(built.layer).toBe('overlay');
    expect(built.fixed).toBe(false);
    // Ticket 04 A: the rule may not state a path its own validator throws on. `retraces` reads every
    // published overlay path, so every case here is measured by it as well.
    retraces(link.id, built.segments);
    const points = [built.segments[0]!.from, ...built.segments.map(segment => segment.to)];
    // G7 `endpoint-anchor`: a path starts and ends at its two port anchors, an overlay included.
    expect(points[0]).toEqual(model.nodes[link.attachments!.from.node]!.ports
      .find(port => port.ref.name === link.attachments!.from.name)!.anchor);
    expect(points[points.length - 1]).toEqual(model.nodes[link.attachments!.to.node]!.ports
      .find(port => port.ref.name === link.attachments!.to.name)!.anchor);
    return points;
  };

  it('crosses above two ports that both face up, on one axis, when the two stub ends are level', () => {
    // Both stubs reach the same height, so the segment between them is horizontal and the shape is
    // the one the maintainer drew by hand in draw.io. `goldens/synthetic/drawio-constructs.yaml` is
    // the fixture for it, and it is the case the new rule leaves exactly where it was.
    expect(path({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 120, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'top', anchor: { x: 20, y: 100 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: 140, y: 100 } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 20, y: 100 }, { x: 140, y: 100 }] }],
    })).toEqual([{ x: 20, y: 100 }, { x: 20, y: 83 }, { x: 140, y: 83 }, { x: 140, y: 100 }]);
  });

  it('draws one diagonal between the two stub ends when the two ports face different ways', () => {
    // `goldens/synthetic/drawio-overlay-sides.yaml`. A left-side port and a top-side port put their
    // stub ends on two different lines, so the segment between them is angled — three segments where
    // the staircase drew four, and no run inside a body has to be routed round.
    expect(path({
      nodes: [{ id: 'c', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'd', bounds: { x: 100, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'c', name: 'up', side: 'top', anchor: { x: 30, y: 100 } },
        { node: 'd', name: 'west', side: 'left', anchor: { x: 100, y: 120 } }],
      links: [{ id: 'flow', from: 'd', to: 'c', layer: 'overlay',
        points: [{ x: 100, y: 120 }, { x: 30, y: 100 }] }],
    })).toEqual([{ x: 100, y: 120 }, { x: 83, y: 120 }, { x: 30, y: 83 }, { x: 30, y: 100 }]);
  });

  it('keeps each stub on its own port normal when the two ports face away from each other', () => {
    // Each stub leaves by the side its port states, whatever is on the other end: the upward port
    // reaches up and the downward port reaches down, and the diagonal joins the two ends. The
    // staircase used to run down the middle of the gap the two boxes leave.
    expect(path({
      nodes: [{ id: 'e', bounds: { x: 95, y: 112, width: 40, height: 30 } },
        { id: 'f', bounds: { x: 25, y: 62, width: 40, height: 30 } }],
      ports: [{ node: 'e', name: 'up', side: 'top', anchor: { x: 105, y: 112 } },
        { node: 'f', name: 'down', side: 'bottom', anchor: { x: 45, y: 92 } }],
      links: [{ id: 'flow', from: 'e', to: 'f', layer: 'overlay',
        points: [{ x: 105, y: 112 }, { x: 45, y: 92 }] }],
    })).toEqual([{ x: 105, y: 112 }, { x: 105, y: 95 }, { x: 45, y: 109 }, { x: 45, y: 92 }]);
  });

  it('stays one straight segment when the two ports face each other on a clear axis', () => {
    // The pair that lines up. Both stubs are collinear with the segment between them and add
    // nothing, `straighten` drops them, and the path is the one segment it always was: a diagram
    // whose overlay ports face each other does not move (stress ticket 20, question 2).
    expect(path({
      nodes: [{ id: 'g', bounds: { x: 0, y: 0, width: 60, height: 40 } },
        { id: 'h', bounds: { x: 0, y: 120, width: 60, height: 40 } }],
      ports: [{ node: 'g', name: 'down', side: 'bottom', anchor: { x: 30, y: 40 } },
        { node: 'h', name: 'up', side: 'top', anchor: { x: 30, y: 120 } }],
      links: [{ id: 'flow', from: 'g', to: 'h', layer: 'overlay',
        points: [{ x: 30, y: 40 }, { x: 30, y: 120 }] }],
    })).toEqual([{ x: 30, y: 40 }, { x: 30, y: 120 }]);
  });

  it('draws through a body in the way of the diagonal and leaves it to the mask', () => {
    // Stress ticket 20, question 3. The maintainer's direction is not to make the diagonal dodge:
    // "may try, but better to try positioning nodes first so there is nothing to go through", which
    // is stress ticket 21. Here a whole node body sits on the diagonal and the path is unchanged by
    // it — the renderer's mask cuts the overlay out of the body, as it always has.
    const blocked = (blocker?: { id: string; bounds: { x: number; y: number; width: number; height: number } }): Point[] => path({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 200, y: 200, width: 60, height: 40 } }, ...(blocker ? [blocker] : [])],
      ports: [{ node: 'a', name: 'p', side: 'top', anchor: { x: 20, y: 100 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: 220, y: 200 } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 20, y: 100 }, { x: 220, y: 200 }] }],
    });
    const clear = [{ x: 20, y: 100 }, { x: 20, y: 83 }, { x: 220, y: 183 }, { x: 220, y: 200 }];
    expect(blocked()).toEqual(clear);
    // The body straddles the diagonal at its midpoint; the polyline does not move by a pixel.
    expect(blocked({ id: 'c', bounds: { x: 100, y: 110, width: 40, height: 40 } })).toEqual(clear);
  });

  it('never walks back the way it came, however little the two stub ends differ', () => {
    // Review finding 1 of ticket 01, kept: the two stubs leave two ports that both face down, and
    // the segment between them stays a segment however small the difference between the two ends —
    // it never doubles back along a stub, and the polyline is the same whichever end the author
    // wrote first.
    for (const gap of [0, 2, 3.9, 4, 6]) {
      const ports = [{ node: 'a', name: 'p', side: 'bottom', anchor: { x: 20, y: 140 } },
        { node: 'b', name: 'q', side: 'bottom', anchor: { x: 140, y: 140 + gap } }] as const;
      const nodes = [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 120, y: 100, width: 60, height: 40 + gap } }];
      const one = 140 + 13 + CLEARANCE, two = 140 + gap + 13 + CLEARANCE;
      expect(path({ nodes, ports: [...ports],
        links: [{ id: 'flow', from: 'b', to: 'a', layer: 'overlay',
          points: [{ x: 140, y: 140 + gap }, { x: 20, y: 140 }] }] }))
        .toEqual([{ x: 140, y: 140 + gap }, { x: 140, y: two }, { x: 20, y: one }, { x: 20, y: 140 }]);
      expect(path({ nodes, ports: [...ports],
        links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
          points: [{ x: 20, y: 140 }, { x: 140, y: 140 + gap }] }] }))
        .toEqual([{ x: 20, y: 140 }, { x: 20, y: one }, { x: 140, y: two }, { x: 140, y: 140 + gap }]);
    }
  });

  /**
   * Ticket 04 A, kept under the new rule. Two ports that face each other across a gap narrower than
   * their two stubs put the stub ends the wrong way round, and the segment between them would walk
   * back along both stubs. Both ends ride their own face instead, and the whole thing then collapses
   * onto the line the two anchors already share.
   */
  const facingPair = (blocker?: { id: string; bounds: { x: number; y: number; width: number; height: number } }): Scene => ({
    nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
      { id: 'b', bounds: { x: 90, y: 100, width: 60, height: 40 } }, ...(blocker ? [blocker] : [])],
    ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 60, y: 120 } },
      { node: 'b', name: 'q', side: 'left', anchor: { x: 90, y: 120 } }],
    links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
      points: [{ x: 60, y: 120 }, { x: 90, y: 120 }] }],
  });

  it('stays one straight segment when a facing pair is closer than its two stubs', () => {
    // The two pill faces are 4 px apart and each stub is 4 px, so the stub ends cross. Riding the
    // faces keeps the two ends in order and the pair draws the one segment a pair that lines up
    // always drew — exactly what it draws when the gap is wide.
    expect(path(facingPair())).toEqual([{ x: 60, y: 120 }, { x: 90, y: 120 }]);
  });

  it('draws through a thin body between two faces that are too close for their stubs', () => {
    // The same pair with a 2 px body in the 4 px window between the two faces. The staircase went
    // over both pills to keep clear of it; the diagonal — here a straight run — draws through it and
    // the mask carries the body, so the pair still states one segment.
    expect(path(facingPair({ id: 'c', bounds: { x: 74, y: 112, width: 2, height: 16 } })))
      .toEqual([{ x: 60, y: 120 }, { x: 90, y: 120 }]);
  });

  it('gives up the stubs rather than double back along one', () => {
    // Two ports on the same side of two nodes standing side by side: each stub points away from the
    // other end, and on one line the segment between the two stub ends covers both of them. A path
    // that retraces is not a path — `route/validate` throws on one — so the link keeps the straight
    // anchor-to-anchor line and the mask carries the bodies it crosses.
    // `goldens/synthetic/overlay-blocked-by-a-body.yaml` is the fixture for it.
    expect(path({
      nodes: [{ id: 'i', bounds: { x: 200, y: 30, width: 60, height: 40 } },
        { id: 'j', bounds: { x: 100, y: 30, width: 60, height: 40 } }],
      ports: [{ node: 'i', name: 'west', side: 'left', anchor: { x: 200, y: 50 } },
        { node: 'j', name: 'west', side: 'left', anchor: { x: 100, y: 50 } }],
      links: [{ id: 'flow', from: 'i', to: 'j', layer: 'overlay',
        points: [{ x: 200, y: 50 }, { x: 100, y: 50 }] }],
    })).toEqual([{ x: 200, y: 50 }, { x: 100, y: 50 }]);
  });

  it('keeps both stubs when two ports on the same side sit on two different lines', () => {
    // The same pair of sides, 6 px apart on the other axis. The two stubs are then on two lines and
    // neither can cover the other, so the rule keeps them and the segment between them doubles back
    // as a diagonal. It is the shape the author's own port sides ask for; moving the nodes so that
    // no port faces away from its peer is stress ticket 21.
    expect(path({
      nodes: [{ id: 'i', bounds: { x: 200, y: 30, width: 60, height: 40 } },
        { id: 'j', bounds: { x: 100, y: 30, width: 60, height: 46 } }],
      ports: [{ node: 'i', name: 'west', side: 'left', anchor: { x: 200, y: 50 } },
        { node: 'j', name: 'west', side: 'left', anchor: { x: 100, y: 56 } }],
      links: [{ id: 'flow', from: 'i', to: 'j', layer: 'overlay',
        points: [{ x: 200, y: 50 }, { x: 100, y: 56 }] }],
    })).toEqual([{ x: 200, y: 50 }, { x: 183, y: 50 }, { x: 83, y: 56 }, { x: 100, y: 56 }]);
  });

  it('leaves a port that draws no pill by the stub beyond its node body', () => {
    // An anonymous port has no pill, so the box the link leaves is the node itself and the anchor is
    // already on its face. draw.io pins such an end to the same point, so the two renderers agree.
    const points = path({
      nodes: [{ id: 'k', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'l', bounds: { x: 120, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'k', name: 'p', side: 'top', anchor: { x: 20, y: 100 }, pill: false },
        { node: 'l', name: 'q', side: 'top', anchor: { x: 140, y: 100 }, pill: false }],
      links: [{ id: 'flow', from: 'k', to: 'l', layer: 'overlay',
        points: [{ x: 20, y: 100 }, { x: 140, y: 100 }] }],
    });
    expect(points).toEqual([{ x: 20, y: 100 }, { x: 20, y: 100 - CLEARANCE },
      { x: 140, y: 100 - CLEARANCE }, { x: 140, y: 100 }]);
  });

  it('keeps the straight segment when an end states no side to leave by', () => {
    // The fall-back of last resort. A stub is read off a port's own side, so an end that states none
    // cannot be left outward at all, and the link keeps the straight anchor-to-anchor line every
    // release before the staircase drew. The renderer's mask carries it, as it always did.
    const model = scene({
      nodes: [{ id: 'm', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'n', bounds: { x: 120, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'm', name: 'p', side: 'top', anchor: { x: 20, y: 100 } },
        { node: 'n', name: 'q', side: 'top', anchor: { x: 140, y: 100 } }],
      links: [{ id: 'flow', from: 'm', to: 'n', layer: 'overlay',
        points: [{ x: 20, y: 100 }, { x: 140, y: 100 }] }],
    });
    delete model.nodes['n']!.ports[0]!.side;
    const link = model.links.find(item => item.layer === 'overlay')!;
    expect(overlayPath(model, link).segments).toEqual([{ from: { x: 20, y: 100 }, to: { x: 140, y: 100 },
      owner: { kind: 'link', id: 'flow' } }]);
  });
});
