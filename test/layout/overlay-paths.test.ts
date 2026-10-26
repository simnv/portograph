import { describe, expect, it } from 'vitest';
import type { LayoutModel, Point } from '../../src/model/index.js';
import { OVERLAY_PILL_CLEARANCE, overlayEndpoint, overlayPath, straightChord } from '../../src/layout/overlay-paths.js';
import { retraces } from '../../src/route/validate.js';
import { linkLayer } from '../../src/layout/link-layer.js';
import { scene, type Scene } from '../render/fixture.js';

/**
 * Stress ticket 20, the maintainer's rule: **straight by default, orthogonal by exception, and the
 * exception is a node in the way.** An overlay link is a stub straight out of each port and one
 * straight segment between the two stub ends, at whatever angle; where a node body or a pill stands
 * on that segment, the orthogonal derivation of synthetics review ticket 01 answers instead, and
 * that derivation is unchanged. The geometry is the model's, so both renderers draw the same line.
 *
 * Stress ticket 30 moved the two ends: the path begins and ends on the port's own outward **face**,
 * not on the anchor at the pill's centre — *"path should also start on the point"* (maintainer,
 * 2026-09-16). Every shape between the two stub ends is the same as it was; what the two ends lost
 * is the run inside the pill that the overlay mask never drew.
 *
 * `scene` centres a port's pill on its anchor — 10 × 26 on a top or bottom side, 26 × 10 on a left
 * or right one — so a pill straddles the node edge exactly as placement leaves it, and a face is
 * 13 px outward of its anchor on every side.
 */
describe('overlay paths', () => {
  const CLEARANCE = OVERLAY_PILL_CLEARANCE;

  /** The polyline `overlayPath` states for the one overlay link of a hand-built scene. */
  const path = (input: Scene, straight = false): Point[] => {
    const model: LayoutModel = scene(input);
    const link = model.links.find(item => item.layer === 'overlay')!;
    const built = overlayPath(model, link);
    // Every segment is the link's own and claims no reserved geometry. The orthogonal branch follows
    // one axis throughout; the straight branch is one segment at whatever angle it likes.
    for (const segment of built.segments) {
      expect(segment.owner).toEqual({ kind: 'link', id: link.id });
      expect(segment.lane).toBeUndefined();
      expect(segment.barCross).toBeUndefined();
      if (!straight) {
        expect(Math.abs(segment.to.x - segment.from.x) < 1e-9 || Math.abs(segment.to.y - segment.from.y) < 1e-9).toBe(true);
      }
      expect(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y)).toBeGreaterThan(1e-9);
    }
    // The straight branch is the whole link: two points, no stub (stress ticket 30).
    if (straight) expect(built.segments).toHaveLength(1);
    expect(built.layer).toBe('overlay');
    expect(built.fixed).toBe(false);
    // Ticket 04 A: the rule may not state a path its own validator throws on. `retraces` reads every
    // published overlay path, so every case here is measured by it as well.
    retraces(link.id, built.segments);
    const points = [built.segments[0]!.from, ...built.segments.map(segment => segment.to)];
    // G7 `endpoint-anchor`: an overlay path starts and ends on its two ports' own outward **faces**
    // — *"path should also start on the point"* (maintainer, 2026-09-16, ticket 30) — which is what
    // `overlayEndpoint` names and what the gate and `route/validate` both read. The pill is 26 deep
    // along every side here, so a face is 13 px outward of its anchor.
    for (const [point, ref] of [[points[0], link.attachments!.from],
      [points[points.length - 1], link.attachments!.to]] as const) {
      const node = model.nodes[ref.node]!;
      expect(point).toEqual(overlayEndpoint(node, node.ports.find(port => port.ref.name === ref.name)!));
    }
    return points;
  };

  it('takes a U one clearance above two level pills on one side (ticket 34)', () => {
    // Architecture-2 ticket 34, the user's word on `drawio-constructs` (2026-10-25: "purple line looks wrong, no margins"): an
    // overlay never rides along a face. The segment between two level faces on one side runs **along** both pills' outward edges,
    // so the straight branch refuses it and the path is a U whose run stands one overlay port clearance beyond the pill tips. This
    // reverses the 2026-09-16 reading "level counts as leaving" (decisions log Q121), under which this case was the one horizontal
    // segment at y 87. `goldens/synthetic/drawio-constructs.yaml` is the fixture.
    expect(path({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 120, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'top', anchor: { x: 20, y: 100 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: 140, y: 100 } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 20, y: 100 }, { x: 140, y: 100 }] }],
    })).toEqual([{ x: 20, y: 87 }, { x: 20, y: 87 - CLEARANCE }, { x: 140, y: 87 - CLEARANCE }, { x: 140, y: 87 }]);
  });

  it('refuses a line on, or a stroke width off, the edge of a foreign pill, and goes round it one clearance out (ticket 34)', () => {
    // Two ports that face each other on one horizontal line, and between them the pill of a third node whose top edge lies on that
    // line, or 0.5 px or 1.5 px below it. `crosses` is open, so such a line entered nothing and the straight branch kept it, a
    // fraction of a pixel from a pill that is not its own. Ticket 34: a segment that rides along a face, within one stroke width
    // (1.5 px), is not straight-clear (review 2026-10-26: 0.5 px off the tip still reads as on it), so the orthogonal branch answers,
    // and its run stands one clearance above the two end pills. 2 px off, the line stays straight (riding, not nearness; ticket 41).
    const scenery = (gap: number): Scene => ({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 200, y: 100, width: 60, height: 40 } },
        { id: 'c', bounds: { x: 110, y: 133 + gap, width: 40, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 60, y: 120 } },
        { node: 'b', name: 'q', side: 'left', anchor: { x: 200, y: 120 } },
        { node: 'c', name: 'up', side: 'top', anchor: { x: 130, y: 133 + gap } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 60, y: 120 }, { x: 200, y: 120 }] }],
    });
    const run = 115 - CLEARANCE;
    for (const gap of [0, 0.5, 1.5]) {
      expect(path(scenery(gap))).toEqual([{ x: 73, y: 120 }, { x: 73 + CLEARANCE, y: 120 }, { x: 73 + CLEARANCE, y: run },
        { x: 187 - CLEARANCE, y: run }, { x: 187 - CLEARANCE, y: 120 }, { x: 187, y: 120 }]);
    }
    expect(path(scenery(2), true)).toEqual([{ x: 73, y: 120 }, { x: 187, y: 120 }]);
  });

  it('puts the U run one clearance beyond a taller pill between the two level ends (ticket 34 review)', () => {
    // A middle node whose pill tip stands 5 px above the two own tips. A run at one clearance above the own tips would pass 2.75 px
    // above that foreign pill; the run steps out to one clearance beyond the furthest shape across its span instead.
    expect(path({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 120, y: 100, width: 60, height: 40 } },
        { id: 'm', bounds: { x: 70, y: 95, width: 40, height: 45 } }],
      ports: [{ node: 'a', name: 'p', side: 'top', anchor: { x: 20, y: 100 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: 140, y: 100 } },
        { node: 'm', name: 'up', side: 'top', anchor: { x: 90, y: 95 } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 20, y: 100 }, { x: 140, y: 100 }] }],
    })).toEqual([{ x: 20, y: 87 }, { x: 20, y: 82 - CLEARANCE }, { x: 140, y: 82 - CLEARANCE }, { x: 140, y: 87 }]);
  });

  it('guard, passes on main too: the segment that leaves its own pill and an angled line stay straight (ticket 34)', () => {
    // A guard against an over-wide rule, not a red test: main passed it too. The exemption cannot be broken by the face test as
    // built (the leaving segment overlaps neither its own pill nor its body on its axis); this pins that.
    // The incident-segment exemption: the points just after an end are nearer than the clearance to their own pill and body, so the
    // segment that leaves its own pill perpendicular to the face is not refused for them; it meets them only at its end point. Here
    // the line runs 5 px from the flanks of both own pills (10 px wide) and stays the one segment.
    expect(path({
      nodes: [{ id: 'g', bounds: { x: 0, y: 0, width: 60, height: 40 } },
        { id: 'h', bounds: { x: 0, y: 120, width: 60, height: 40 } }],
      ports: [{ node: 'g', name: 'down', side: 'bottom', anchor: { x: 30, y: 40 } },
        { node: 'h', name: 'up', side: 'top', anchor: { x: 30, y: 120 } }],
      links: [{ id: 'flow', from: 'g', to: 'h', layer: 'overlay',
        points: [{ x: 30, y: 40 }, { x: 30, y: 120 }] }],
    }, true)).toEqual([{ x: 30, y: 53 }, { x: 30, y: 107 }]);
    // Angled segments are out of ticket 34: a line that leaves both faces outward at an angle keeps today's verdict.
    expect(path({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 120, y: 180, width: 60, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'bottom', anchor: { x: 30, y: 140 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: 150, y: 180 } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 30, y: 140 }, { x: 150, y: 180 }] }],
    }, true)).toEqual([{ x: 30, y: 153 }, { x: 150, y: 167 }]);
  });

  it('guard, passes on main too: nearness is not refused, and a routed chord along a face is kept (ticket 34)', () => {
    // The same facing pair as above, with a third body whose bottom edge stands 5 px above the line: nearer than the clearance, but
    // not on it. The ruling refuses riding along a face; refusing nearness bent lines whose detour then ran at the same gap (the
    // corpus, 2026-10-26), so that wider clause is ticket 41 and the line stays straight.
    const near: Scene = {
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 200, y: 100, width: 60, height: 40 } },
        { id: 'c', bounds: { x: 110, y: 75, width: 40, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'right', anchor: { x: 60, y: 120 } },
        { node: 'b', name: 'q', side: 'left', anchor: { x: 200, y: 120 } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 60, y: 120 }, { x: 200, y: 120 }] }],
    };
    expect(path(near, true)).toEqual([{ x: 73, y: 120 }, { x: 187, y: 120 }]);
    // The routed straight technique reads the same test through `straightChord`; the ruling names the overlay alone, so a routed
    // link between two level top pills keeps the chord along their tips.
    const level = scene({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 120, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'top', anchor: { x: 20, y: 100 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: 140, y: 100 } }],
      links: [{ id: 'cable', from: 'a', to: 'b', points: [{ x: 20, y: 100 }, { x: 140, y: 100 }] }],
    });
    const routed = level.links[0]!;
    expect(linkLayer(routed)).toBe('routed');
    expect(straightChord(level, routed)).toEqual({ from: { x: 20, y: 87 }, to: { x: 140, y: 87 } });
    expect(straightChord(level, { ...routed, layer: 'overlay' })).toBeUndefined();
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
    })).toEqual([{ x: 87, y: 120 }, { x: 79.25, y: 120 }, { x: 79.25, y: 79.25 }, { x: 30, y: 79.25 }, { x: 30, y: 87 }]);
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

  it('goes round when a port faces away from its partner', () => {
    // The straight branch's own condition: the segment has to **leave each port outward**. These two
    // ports face away from each other, so the line from face to face turns back inward at both ends
    // — leaving (105, 99) it drops away from the way that port faces — and a line that leaves a port
    // inward runs back under that port's own pill, where the overlay mask would cut it away from its
    // own endpoint mark. The orthogonal branch answers, stepping one clearance outward before it
    // turns: the shape this same pair takes when a body stands on the segment, one test below, and
    // the reason the clearance survives on that branch.
    //
    // The stub used to lift the line clear before it turned, so this is the one shape stress
    // ticket 30 moved.
    expect(path(facingAway()))
      .toEqual([{ x: 105, y: 99 }, { x: 105, y: 91.25 }, { x: 75, y: 91.25 },
        { x: 75, y: 112.75 }, { x: 45, y: 112.75 }, { x: 45, y: 105 }]);
  });

  it('tilts as far as level and no further, and its own pills never decide it', () => {
    // What bounds the straight branch (maintainer, 2026-09-16: a link's own two pills do not block
    // its own straight segment; the outward-leave condition is the real one, so they carry nothing
    // it does not already have).
    //
    // A facing pair takes **any** tilt. The target slides 5 000 px sideways across a 94 px drop —
    // a line 2 px off horizontal over 5 000 — and it is still the one segment, because both ends
    // still leave outward.
    const facing = (x: number, y: number): Point[] => path({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x, y, width: 60, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'bottom', anchor: { x: 30, y: 140 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: x + 30, y } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 30, y: 140 }, { x: x + 30, y }] }],
    }, true);
    expect(facing(5000, 260)).toEqual([{ x: 30, y: 153 }, { x: 5030, y: 247 }]);
    // It stops one stroke width before the two faces come level: the source's face is at y 153 and the
    // target's is at y − 13. At y 168 the line drops 2 px over 300 and leaves both faces outward at an
    // angle, so it stays the one segment. At y 167.4 it drops 1.4 px, less than the 1.5 px stroke, so it
    // lies on both pills' faces within a stroke's width and ticket 34 refuses it (user, 2026-10-25;
    // review 2026-10-26: a line a fraction of a pixel off the tips reads as on them). Level, at y 166,
    // it was the one segment under the 2026-09-16 reading "level counts as leaving". y 165.9 puts the
    // target's face above the source's and the line would leave a downward port upward. Each refused
    // case takes the Z down the middle of the gap the two boxes leave on x.
    expect(facing(300, 168)).toEqual([{ x: 30, y: 153 }, { x: 330, y: 155 }]);
    const z = (y: number): Point[] => path({
      nodes: [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 300, y, width: 60, height: 40 } }],
      ports: [{ node: 'a', name: 'p', side: 'bottom', anchor: { x: 30, y: 140 } },
        { node: 'b', name: 'q', side: 'top', anchor: { x: 330, y } }],
      links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
        points: [{ x: 30, y: 140 }, { x: 330, y }] }],
    });
    for (const y of [167.4, 166, 165.9]) {
      const face = y - 13, run = face - CLEARANCE;
      expect(z(y)).toEqual([{ x: 30, y: 153 }, { x: 30, y: 153 + CLEARANCE }, { x: 180, y: 153 + CLEARANCE },
        { x: 180, y: run }, { x: 330, y: run }, { x: 330, y: face }]);
    }
  });

  it('routes orthogonally when a node stands on that straight segment', () => {
    // The exception, and the maintainer's words for it: "only if link goes through node, we route it
    // orthogonally". A 6 × 6 body at (88, 96) sits on the segment above — which passes (91, 98.27) —
    // and on none of the eight orthogonal ways. The link therefore takes the derivation of
    // synthetics review ticket 01 unchanged: neither single turn clears its own pill and no way
    // round the outside reaches, so the route runs down the middle of the gap the two boxes leave on
    // x. The geometry is codex's, from round 2 of the draw.io export ticket.
    expect(path(facingAway({ id: 'g', bounds: { x: 88, y: 96, width: 6, height: 6 } })))
      .toEqual([{ x: 105, y: 99 }, { x: 105, y: 91.25 }, { x: 75, y: 91.25 },
        { x: 75, y: 112.75 }, { x: 45, y: 112.75 }, { x: 45, y: 105 }]);
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
    })).toEqual([{ x: 30, y: 53 }, { x: 30, y: 107 }]);
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
      .toEqual([{ x: 30, y: 53 }, { x: 30, y: 60.75 }, { x: 17.25, y: 60.75 },
        { x: 17.25, y: 99.25 }, { x: 30, y: 99.25 }, { x: 30, y: 107 }]);
  });

  it('goes round a body wider than the pair itself (ticket 86)', () => {
    // The eight ways are read off the two end boxes alone, so a body wider than the pair's own extent
    // plus a stub lands on every one of them, and the ends-only fall-back used to take the level
    // "single turn" that is one straight anchor-to-anchor line through the body. Two level ports with
    // a body between them are the case ticket 86 names. The orthogonal branch now also tries runs
    // outside every shape they pass, and one of them clears the body: x -4: one clearance left of the pair's own end boxes (here the two node bodies at x 0), which the hull starts from, since a run outside the pair must clear them too.
    expect(path(facingColumn({ id: 'x', bounds: { x: 10, y: 70, width: 40, height: 20 } })))
      .toEqual([{ x: 30, y: 53 }, { x: 30, y: 60.75 }, { x: -7.75, y: 60.75 }, { x: -7.75, y: 99.25 },
        { x: 30, y: 99.25 }, { x: 30, y: 107 }]);
  });

  it('keeps clear of the two pills when a node body blocks every way round', () => {
    // Two ports on the same side of two nodes standing side by side, anchors on one line. The
    // straight branch refuses itself twice over: the segment between the two stub ends runs through
    // both bodies, and it covers both stubs, which `route/validate` would throw on. The orthogonal
    // derivation finds nothing the two boxes offer that clears every shape, and takes the shortest run
    // outside every shape in the hull of the pair instead (ticket 86): over the top of both bodies,
    // where it used to cross one and leave the renderer's mask to cut it. `overlay-blocked-by-a-body`
    // is the fixture.
    expect(path({
      nodes: [{ id: 'i', bounds: { x: 200, y: 30, width: 60, height: 40 } },
        { id: 'j', bounds: { x: 100, y: 30, width: 60, height: 40 } }],
      ports: [{ node: 'i', name: 'west', side: 'left', anchor: { x: 200, y: 50 } },
        { node: 'j', name: 'west', side: 'left', anchor: { x: 100, y: 50 } }],
      links: [{ id: 'flow', from: 'i', to: 'j', layer: 'overlay',
        points: [{ x: 200, y: 50 }, { x: 100, y: 50 }] }],
    })).toEqual([{ x: 187, y: 50 }, { x: 179.25, y: 50 }, { x: 179.25, y: 22.25 },
      { x: 79.25, y: 22.25 }, { x: 79.25, y: 50 }, { x: 87, y: 50 }]);
  });

  it('never walks back the way it came, and reads the same both ways round', () => {
    // Review finding 1 of ticket 01, under the straight branch, and what stress ticket 30 did to it.
    // Two ports that both face **down**, with the gap below them clear. Level, the line between the
    // two faces is horizontal and runs along both faces, which ticket 34 refuses (user, 2026-10-25;
    // it was the one segment under "level counts as leaving"). Off level by anything at all, that
    // same line tilts back **into** the lower pill — at a gap of 0.5 px it reaches 0.02 px inside
    // it — and a pill in the way is the rule's own exception. Either way the orthogonal branch
    // answers with a run one clearance below the lower face. The stub used to hold the line 4 px
    // clear of both pills and absorb the tilt; there is no stub now.
    //
    // What the finding asked for still holds: the polyline never doubles back, and it is the same
    // polyline whichever end the author wrote first.
    for (const gap of [0, 0.5, 2, 3.9, 4, 6]) {
      const ports = [{ node: 'a', name: 'p', side: 'bottom', anchor: { x: 20, y: 140 } },
        { node: 'b', name: 'q', side: 'bottom', anchor: { x: 140, y: 140 + gap } }] as const;
      const nodes = [{ id: 'a', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'b', bounds: { x: 120, y: 100, width: 60, height: 40 + gap } }];
      const faceOne = 140 + 13, faceTwo = 140 + gap + 13;
      const below = faceTwo + CLEARANCE;
      const fromA = [{ x: 20, y: faceOne }, { x: 20, y: below }, { x: 140, y: below }, { x: 140, y: faceTwo }];
      expect(path({ nodes, ports: [...ports],
        links: [{ id: 'flow', from: 'a', to: 'b', layer: 'overlay',
          points: [{ x: 20, y: 140 }, { x: 140, y: 140 + gap }] }] }))
        .toEqual(fromA);
      expect(path({ nodes, ports: [...ports],
        links: [{ id: 'flow', from: 'b', to: 'a', layer: 'overlay',
          points: [{ x: 140, y: 140 + gap }, { x: 20, y: 140 }] }] }))
        .toEqual([...fromA].reverse());
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
    // The two pill faces are 4 px apart and each clearance is 7.75 px (ticket 23), so the cleared ends cross: the
    // old candidate test let a way round win and it drew two stubs over each other. The axis between
    // the two faces is clear, so the pair keeps the one segment the maintainer's direct-line rule asks
    // for — exactly what it draws when the gap is wide.
    expect(path(facingPair())).toEqual([{ x: 73, y: 120 }, { x: 77, y: 120 }]);
  });

  it('goes round a facing pair that is too close when the axis between the faces is blocked', () => {
    // The window between two faces closer than the two clearances is narrower than 8 px by
    // definition, so the only shape that blocks the axis and leaves a way round is a thin one. The
    // route then rides each face outward, goes over both pills one clearance above them, and comes
    // back down: it enters no box and no run covers another.
    expect(path(facingPair({ id: 'c', bounds: { x: 74, y: 112, width: 2, height: 16 } })))
      .toEqual([{ x: 73, y: 120 }, { x: 73, y: 107.25 }, { x: 77, y: 107.25 }, { x: 77, y: 120 }]);
  });

  it('takes a U one clearance above the body edges for two ports that draw no pill (ticket 34)', () => {
    // An anonymous port has no pill, so the box the link leaves is the node itself and the anchor is
    // already on its face: the face **is** the anchor and this end never moved. The two faces are
    // level, so the segment would run along both node bodies' top edges. Ticket 34 (user,
    // 2026-10-25): an overlay never rides along a face, so the path is a U one clearance above the
    // two body edges; it was the one segment at y 100. draw.io pins such an end to the same point,
    // so the two renderers agree.
    const points = path({
      nodes: [{ id: 'k', bounds: { x: 0, y: 100, width: 60, height: 40 } },
        { id: 'l', bounds: { x: 120, y: 100, width: 60, height: 40 } }],
      ports: [{ node: 'k', name: 'p', side: 'top', anchor: { x: 20, y: 100 }, pill: false },
        { node: 'l', name: 'q', side: 'top', anchor: { x: 140, y: 100 }, pill: false }],
      links: [{ id: 'flow', from: 'k', to: 'l', layer: 'overlay',
        points: [{ x: 20, y: 100 }, { x: 140, y: 100 }] }],
    });
    expect(points).toEqual([{ x: 20, y: 100 }, { x: 20, y: 100 - CLEARANCE }, { x: 140, y: 100 - CLEARANCE }, { x: 140, y: 100 }]);
  });

  it('has no stub on the straight branch, and one clearance on the orthogonal one', () => {
    // Stress ticket 30. The maintainer looked at the re-render and said *"no point in stub then"*:
    // with the path starting on the pill face and the endpoint mark drawn there, a 4 px stub only
    // put a kink under the dot. The straight branch is now two points and one segment, whatever the
    // angle — measure the whole link, not a nub.
    const straightPair = path({
      nodes: [{ id: 'g', bounds: { x: 0, y: 0, width: 60, height: 40 } },
        { id: 'h', bounds: { x: 0, y: 120, width: 60, height: 40 } }],
      ports: [{ node: 'g', name: 'down', side: 'bottom', anchor: { x: 30, y: 40 } },
        { node: 'h', name: 'up', side: 'top', anchor: { x: 30, y: 120 } }],
      links: [{ id: 'flow', from: 'g', to: 'h', layer: 'overlay',
        points: [{ x: 30, y: 40 }, { x: 30, y: 120 }] }],
    }, true);
    expect(straightPair).toHaveLength(2);

    // The orthogonal branch keeps the clearance: it has to step outward before it can turn, so its
    // first and last run are `OVERLAY_PILL_CLEARANCE` and the turn is one clearance outside the face.
    const round = path(facingAway({ id: 'g', bounds: { x: 88, y: 96, width: 6, height: 6 } }));
    for (const [at, next] of [[round[0]!, round[1]!],
      [round[round.length - 1]!, round[round.length - 2]!]] as const) {
      expect(Math.hypot(next.x - at.x, next.y - at.y)).toBeCloseTo(CLEARANCE, 9);
    }
  });

  it('keeps the straight segment when an end states no side to leave by', () => {
    // The fall-back of last resort. Every way round is read off a port's own side, so an end that
    // states none cannot be left outward at all, and the link keeps the one straight segment every
    // release before this one drew. The end that does state a side still starts on its own face, so
    // `overlayEndpoint` and the path agree at both ends; the renderer's mask carries the rest.
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
    expect(overlayPath(model, link).segments).toEqual([{ from: { x: 20, y: 87 }, to: { x: 140, y: 100 },
      owner: { kind: 'link', id: 'flow' } }]);
  });
});
