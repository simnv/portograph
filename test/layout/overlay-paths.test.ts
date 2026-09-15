import { describe, expect, it } from 'vitest';
import type { LayoutModel, Point } from '../../src/model/index.js';
import { OVERLAY_PILL_CLEARANCE, overlayPath } from '../../src/layout/overlay-paths.js';
import { scene, type Scene } from '../render/fixture.js';

/**
 * Synthetics review ticket 01: an overlay link is an orthogonal path that leaves each port outward
 * and goes round the shapes it would otherwise cross. The geometry is the model's, so both renderers
 * draw the same line; these are the cases the two renderers used to disagree about.
 *
 * `scene` centres a port's pill on its anchor — 10 × 26 on a top or bottom side, 26 × 10 on a left
 * or right one — so a pill straddles the node edge exactly as placement leaves it.
 */
describe('overlay paths', () => {
  const CLEARANCE = OVERLAY_PILL_CLEARANCE;

  /** The polyline `overlayPath` states for the one overlay link of a hand-built scene. */
  const path = (input: Scene): Point[] => {
    const model: LayoutModel = scene(input);
    const link = model.links.find(item => item.layer === 'overlay')!;
    const built = overlayPath(model, link);
    // Every segment is the link's own, claims no reserved geometry, and follows one axis.
    for (const segment of built.segments) {
      expect(segment.owner).toEqual({ kind: 'link', id: link.id });
      expect(segment.lane).toBeUndefined();
      expect(segment.barCross).toBeUndefined();
      expect(Math.abs(segment.to.x - segment.from.x) < 1e-9 || Math.abs(segment.to.y - segment.from.y) < 1e-9).toBe(true);
      expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThan(1e-9);
    }
    expect(built.layer).toBe('overlay');
    expect(built.fixed).toBe(false);
    const points = [built.segments[0]!.from, ...built.segments.map(segment => segment.to)];
    // G7 `endpoint-anchor`: a path starts and ends at its two port anchors, an overlay included.
    expect(points[0]).toEqual(model.nodes[link.attachments!.from.node]!.ports
      .find(port => port.ref.name === link.attachments!.from.name)!.anchor);
    expect(points[points.length - 1]).toEqual(model.nodes[link.attachments!.to.node]!.ports
      .find(port => port.ref.name === link.attachments!.to.name)!.anchor);
    return points;
  };

  it('crosses above two ports that both face up, in three segments', () => {
    // The shape the maintainer drew by hand in draw.io: out of each pill head by the clearance, and
    // one run across. `goldens/synthetic/drawio-constructs.yaml` is the fixture for it.
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
    // `goldens/synthetic/drawio-overlay-sides.yaml`. The single turn that carries on the way the
    // source faces runs straight through the target's node, so the other one wins.
    expect(path({
      nodes: [{ id: 'c', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'd', bounds: { x: 100, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'c', name: 'up', side: 'top', anchor: { x: 30, y: 100 } },
        { node: 'd', name: 'west', side: 'left', anchor: { x: 100, y: 120 } }],
      links: [{ id: 'flow', from: 'd', to: 'c', layer: 'overlay',
        points: [{ x: 100, y: 120 }, { x: 30, y: 100 }] }],
    })).toEqual([{ x: 100, y: 120 }, { x: 83, y: 120 }, { x: 83, y: 83 }, { x: 30, y: 83 }, { x: 30, y: 100 }]);
  });

  it('goes down the middle of the gap when the two ports face away from each other', () => {
    // Neither single turn clears its own pill and no way round the outside reaches either, so the
    // route runs down the middle of the gap the two boxes leave on x. The geometry is codex's, from
    // round 2 of the draw.io export ticket, where the exporter still owned this route.
    expect(path({
      nodes: [{ id: 'e', bounds: { x: 95, y: 112, width: 40, height: 30 } },
        { id: 'f', bounds: { x: 25, y: 62, width: 40, height: 30 } }],
      ports: [{ node: 'e', name: 'up', side: 'top', anchor: { x: 105, y: 112 } },
        { node: 'f', name: 'down', side: 'bottom', anchor: { x: 45, y: 92 } }],
      links: [{ id: 'flow', from: 'e', to: 'f', layer: 'overlay',
        points: [{ x: 105, y: 112 }, { x: 45, y: 92 }] }],
    })).toEqual([{ x: 105, y: 112 }, { x: 105, y: 95 }, { x: 75, y: 95 },
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

  it('keeps clear of the two pills when a node body blocks every way round', () => {
    // The fall-back of the rule. Both ports face left, and the target's own body sits on the line
    // between them, so nothing the two boxes offer clears every shape. Going round the pill is the
    // principle that survives: the shortest route clear of the two end boxes is taken, and the body
    // it crosses is what the renderer's mask is still there for.
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
