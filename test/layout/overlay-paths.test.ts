import { describe, expect, it } from 'vitest';
import type { LayoutModel, Point } from '../../src/model/index.js';
import { OVERLAY_PILL_CLEARANCE, overlayPath } from '../../src/layout/overlay-paths.js';
import { retraces } from '../../src/route/validate.js';
import { scene, type Scene } from '../render/fixture.js';

/**
 * Stress ticket 20, the maintainer's rule: **straight by default, orthogonal by exception, and the
 * exception is a node in the way.** An overlay link is a stub straight out of each port and one
 * straight segment between the two stub ends, at whatever angle; where a node body or a pill stands
 * on that segment, the orthogonal derivation of synthetics review ticket 01 answers instead, and
 * that derivation is unchanged. The geometry is the model's, so both renderers draw the same line.
 *
 * `scene` centres a port's pill on its anchor — 10 × 26 on a top or bottom side, 26 × 10 on a left
 * or right one — so a pill straddles the node edge exactly as placement leaves it.
 */
describe('overlay paths', () => {
  const CLEARANCE = OVERLAY_PILL_CLEARANCE;

  /** The polyline `overlayPath` states for the one overlay link of a hand-built scene. */
  const path = (input: Scene, straight = false): Point[] => {
    const model: LayoutModel = scene(input);
    const link = model.links.find(item => item.layer === 'overlay')!;
    const built = overlayPath(model, link);
    // Every segment is the link's own and claims no reserved geometry. The orthogonal branch follows
    // one axis throughout; the straight branch's two stubs do, and the segment between them need not.
    for (const [index, segment] of built.segments.entries()) {
      expect(segment.owner).toEqual({ kind: 'link', id: link.id });
      expect(segment.lane).toBeUndefined();
      expect(segment.barCross).toBeUndefined();
      const stub = index === 0 || index === built.segments.length - 1;
      if (!straight || stub) {
        expect(Math.abs(segment.to.x - segment.from.x) < 1e-9 || Math.abs(segment.to.y - segment.from.y) < 1e-9).toBe(true);
      }
      expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThan(1e-9);
    }
    // Straight is a stub, one segment and a stub, or less where a stub collapses onto the segment.
    if (straight) expect(built.segments.length).toBeLessThanOrEqual(3);
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

  it('crosses above two ports that both face up, in three segments', () => {
    // Two stub ends that are level: the straight segment between them is horizontal, so the straight
    // branch and the orthogonal one state the same thing. The shape the maintainer drew by hand in
    // draw.io. `goldens/synthetic/drawio-constructs.yaml` is the fixture for it.
    expect(path({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 120, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'top', anchor: { x: 20, y: 100 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: 140, y: 100 } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 20, y: 100 }, { x: 140, y: 100 }] }],
    })).toEqual([{ x: 20, y: 100 }, { x: 20, y: 83 }, { x: 140, y: 83 }, { x: 140, y: 100 }]);
  });

  it('turns once when the two ports face different ways, and clears the far node body', () => {
    // `goldens/synthetic/drawio-overlay-sides.yaml`. The straight segment between the two stub ends
    // enters the target's own body at (60, 103.94), so this pair is routed orthogonally, and there
    // the single turn that carries on the way the source faces runs straight through that same node
    // — so the other one wins.
    expect(path({
      nodes: [{ id: 'c', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'd', bounds: { x: 100, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'c', name: 'up', side: 'top', anchor: { x: 30, y: 100 } },
        { node: 'd', name: 'west', side: 'left', anchor: { x: 100, y: 120 } }],
      links: [{ id: 'flow', from: 'd', to: 'c', layer: 'overlay',
        points: [{ x: 100, y: 120 }, { x: 30, y: 100 }] }],
    })).toEqual([{ x: 100, y: 120 }, { x: 83, y: 120 }, { x: 83, y: 83 }, { x: 30, y: 83 }, { x: 30, y: 100 }]);
  });

  /**
   * Two ports that face away from each other, with the gap between the two nodes clear. Each stub
   * leaves by the side its own port states, and what joins the two stub ends is the thing the
   * blocking test decides.
   */
  const facingAway = (blocker?: { id: string; bounds: { x: number; y: number; width: number; height: number } }): Scene => ({
    nodes: [{ id: 'e', bounds: { x: 95, y: 112, width: 40, height: 30 } },
      { id: 'f', bounds: { x: 25, y: 62, width: 40, height: 30 } }, ...(blocker ? [blocker] : [])],
    ports: [{ node: 'e', name: 'up', side: 'top', anchor: { x: 105, y: 112 } },
      { node: 'f', name: 'down', side: 'bottom', anchor: { x: 45, y: 92 } }],
    links: [{ id: 'flow', from: 'e', to: 'f', layer: 'overlay',
      points: [{ x: 105, y: 112 }, { x: 45, y: 92 }] }],
  });

  it('draws one straight segment between the two stub ends when nothing stands on it', () => {
    // The default branch. The two ports face away from each other, so each stub points away from the
    // other end, and the segment between the two stub ends passes above the source pill and below
    // the target's — it enters no body and no pill, so it is drawn as it is, at its own angle.
    expect(path(facingAway(), true))
      .toEqual([{ x: 105, y: 112 }, { x: 105, y: 95 }, { x: 45, y: 109 }, { x: 45, y: 92 }]);
  });

  it('routes orthogonally when a node stands on that straight segment', () => {
    // The exception, and the maintainer's words for it: "only if link goes through node, we route it
    // orthogonally". A 6 × 6 body at (88, 96) sits on the segment above — which passes (91, 98.27) —
    // and on none of the eight orthogonal ways. The link therefore takes the derivation of
    // synthetics review ticket 01 unchanged: neither single turn clears its own pill and no way
    // round the outside reaches, so the route runs down the middle of the gap the two boxes leave on
    // x. The geometry is codex's, from round 2 of the draw.io export ticket.
    expect(path(facingAway({ id: 'g', bounds: { x: 88, y: 96, width: 6, height: 6 } })))
      .toEqual([{ x: 105, y: 112 }, { x: 105, y: 95 }, { x: 75, y: 95 },
        { x: 75, y: 109 }, { x: 45, y: 109 }, { x: 45, y: 92 }]);
  });

  it('stays one straight segment when the two ports face each other on a clear axis', () => {
    // The maintainer's own rule for a direct line: horizontal or vertical. Every turn the eight ways
    // offer collapses onto the line the two anchors already share, and the path is one segment.
    expect(path({
      nodes: [{ id: 'g', bounds: { x: 0, y: 0, width: 60, height: 40 } },
        { id: 'h', bounds: { x: 0, y: 120, width: 60, height: 40 } }],
      ports: [{ node: 'g', name: 'down', side: 'bottom', anchor: { x: 30, y: 40 } },
        { node: 'h', name: 'up', side: 'top', anchor: { x: 30, y: 120 } }],
      links: [{ id: 'flow', from: 'g', to: 'h', layer: 'overlay',
        points: [{ x: 30, y: 40 }, { x: 30, y: 120 }] }],
    })).toEqual([{ x: 30, y: 40 }, { x: 30, y: 120 }]);
  });

  /** A facing pair on one clear axis, with an optional body standing on the line between them. */
  const facingColumn = (blocker?: { id: string; bounds: { x: number; y: number; width: number; height: number } }): Scene => ({
    nodes: [{ id: 'g', bounds: { x: 0, y: 0, width: 60, height: 40 } },
      { id: 'h', bounds: { x: 0, y: 120, width: 60, height: 40 } }, ...(blocker ? [blocker] : [])],
    ports: [{ node: 'g', name: 'down', side: 'bottom', anchor: { x: 30, y: 40 } },
      { node: 'h', name: 'up', side: 'top', anchor: { x: 30, y: 120 } }],
    links: [{ id: 'flow', from: 'g', to: 'h', layer: 'overlay',
      points: [{ x: 30, y: 40 }, { x: 30, y: 120 }] }],
  });

  it('goes round a node standing on the line between two ports that face each other', () => {
    // The headline case of the maintainer's rule, on the shape a reader meets most: two ports facing
    // each other in column with a body on the line between them. The straight segment is refused and
    // the orthogonal branch takes the way round the pair on its left, one stub outside the pair's own
    // extent at x 21.
    expect(path(facingColumn({ id: 'x', bounds: { x: 26, y: 70, width: 8, height: 20 } })))
      .toEqual([{ x: 30, y: 40 }, { x: 30, y: 57 }, { x: 21, y: 57 },
        { x: 21, y: 103 }, { x: 30, y: 103 }, { x: 30, y: 120 }]);
  });

  it('draws through a body wider than the pair itself, as it always did', () => {
    // The honest limit of "orthogonal by exception", unchanged from the derivation and pre-existing
    // (ticket 01, open item 1): the eight ways are read off the two end boxes alone, so a body wider
    // than the pair's own extent plus a stub lands on every one of them. The straight branch is
    // refused, the orthogonal branch clears nothing, and its own fall-back — the shortest way clear
    // of the link's two end boxes — is the straight anchor-to-anchor line, which the mask carries.
    // A real overlay router that reads ways round the bodies it must pass is the fix, and it is not
    // this ticket. Measured identical on `main`.
    expect(path(facingColumn({ id: 'x', bounds: { x: 10, y: 70, width: 40, height: 20 } })))
      .toEqual([{ x: 30, y: 40 }, { x: 30, y: 120 }]);
  });

  it('keeps clear of the two pills when a node body blocks every way round', () => {
    // Two ports on the same side of two nodes standing side by side, anchors on one line. The
    // straight branch refuses itself twice over: the segment between the two stub ends runs through
    // both bodies, and it covers both stubs, which `route/validate` would throw on. The orthogonal
    // derivation then reaches its own fall-back — nothing the two boxes offer clears every shape, so
    // the shortest route clear of the link's own two end boxes is taken and the body it crosses is
    // what the renderer's mask is still there for. `overlay-blocked-by-a-body` is the fixture.
    expect(path({
      nodes: [{ id: 'i', bounds: { x: 200, y: 30, width: 60, height: 40 } },
        { id: 'j', bounds: { x: 100, y: 30, width: 60, height: 40 } }],
      ports: [{ node: 'i', name: 'west', side: 'left', anchor: { x: 200, y: 50 } },
        { node: 'j', name: 'west', side: 'left', anchor: { x: 100, y: 50 } }],
      links: [{ id: 'flow', from: 'i', to: 'j', layer: 'overlay',
        points: [{ x: 200, y: 50 }, { x: 100, y: 50 }] }],
    })).toEqual([{ x: 200, y: 50 }, { x: 183, y: 50 }, { x: 183, y: 41 },
      { x: 83, y: 41 }, { x: 83, y: 50 }, { x: 100, y: 50 }]);
  });

  it('never walks back the way it came, however little the two stub ends differ', () => {
    // Review finding 1 of ticket 01, under the straight branch. Two ports that both face down, with
    // the gap below them clear: the segment between the two stub ends is drawn as it is, and it
    // stays a segment however small the difference between the two ends — it never doubles back
    // along a stub, and the polyline is the same whichever end the author wrote first.
    for (const gap of [0, 2, 3.9, 4, 6]) {
      const ports = [{ node: 'a', name: 'p', side: 'bottom', anchor: { x: 20, y: 140 } },
        { node: 'b', name: 'q', side: 'bottom', anchor: { x: 140, y: 140 + gap } }] as const;
      const nodes = [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 120, y: 100, width: 60, height: 40 + gap } }];
      const one = 140 + 13 + CLEARANCE, two = 140 + gap + 13 + CLEARANCE;
      // Below both heads, and the same polyline whichever end the author wrote first.
      expect(path({ nodes, ports: [...ports],
        links: [{ id: 'flow', from: 'b', to: 'a', layer: 'overlay',
          points: [{ x: 140, y: 140 + gap }, { x: 20, y: 140 }] }] }, true))
        .toEqual([{ x: 140, y: 140 + gap }, { x: 140, y: two }, { x: 20, y: one }, { x: 20, y: 140 }]);
      expect(path({ nodes, ports: [...ports],
        links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
          points: [{ x: 20, y: 140 }, { x: 140, y: 140 + gap }] }] }, true))
        .toEqual([{ x: 20, y: 140 }, { x: 20, y: one }, { x: 140, y: two }, { x: 140, y: 140 + gap }]);
    }
  });


  /**
   * Ticket 04 A. Two ports that face each other across a gap narrower than their two clearances put
   * the cleared ends the wrong way round, and every one of the eight ways then walks back along a
   * stub. `reverses` read one corner at a time and passed such a way; `retraces` sweeps the whole
   * polyline and refuses it, as `route/validate` does. Both ends clear their own face instead.
   */
  const facingPair = (blocker?: { id: string; bounds: { x: number; y: number; width: number; height: number } }): Scene => ({
    nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
      { id: 'b', bounds: { x: 90, y: 100, width: 60, height: 40 } }, ...(blocker ? [blocker] : [])],
    ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 60, y: 120 } },
      { node: 'b', name: 'q', side: 'left', anchor: { x: 90, y: 120 } }],
    links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
      points: [{ x: 60, y: 120 }, { x: 90, y: 120 }] }],
  });

  it('stays one straight segment when a facing pair is closer than its two clearances', () => {
    // The two pill faces are 4 px apart and each clearance is 4 px, so the cleared ends cross: the
    // old candidate test let a way round win and it drew two stubs over each other. The axis between
    // the two faces is clear, so the pair keeps the one segment the maintainer's direct-line rule asks
    // for — exactly what it draws when the gap is wide.
    expect(path(facingPair())).toEqual([{ x: 60, y: 120 }, { x: 90, y: 120 }]);
  });

  it('goes round a facing pair that is too close when the axis between the faces is blocked', () => {
    // The window between two faces closer than the two clearances is narrower than 8 px by
    // definition, so the only shape that blocks the axis and leaves a way round is a thin one. The
    // route then rides each face outward, goes over both pills one clearance above them, and comes
    // back down: it enters no box and no run covers another.
    expect(path(facingPair({ id: 'c', bounds: { x: 74, y: 112, width: 2, height: 16 } })))
      .toEqual([{ x: 60, y: 120 }, { x: 73, y: 120 }, { x: 73, y: 111 },
        { x: 77, y: 111 }, { x: 77, y: 120 }, { x: 90, y: 120 }]);
  });

  it('leaves a port that draws no pill by the clearance beyond its node body', () => {
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
    // The fall-back of last resort. Every way round is read off a port's own side, so an end that
    // states none cannot be left outward at all, and the link keeps the straight anchor-to-anchor
    // line every release before this one drew. The renderer's mask carries it, as it always did.
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
