import { describe, expect, it } from 'vitest';
import type { LayoutLink, LayoutModel, PathSegment } from '../../src/model/layout.js';
import { chordBoxRefusal } from '../../src/layout/chord-boxes.js';

/**
 * A member of a flat solid block may leave or enter its own box by the side edge toward its other end, at least the margin from each corner
 * (`chordBoxRefusal` with `sideExit`, dense-16x9 ticket 04 slice 3; owner drawing rules 2026-11-03). Without it the chord must use the facing edge.
 */
function model(): LayoutModel {
  const port = (node: string, side: string, x: number, y: number) => ({ ref: { node, name: 'p' }, side, anchor: { x, y } });
  return {
    document: { nodes: { hub: { group: 'up' }, far: { group: 'down' } }, groups: { up: {}, down: {} } },
    groups: { up: { nodes: ['hub'], bounds: { x: 0, y: 0, width: 200, height: 100 } }, down: { nodes: ['far'], bounds: { x: 1000, y: 400, width: 200, height: 100 } } },
    nodes: { hub: { ports: [port('hub', 'bottom', 180, 60)] }, far: { ports: [port('far', 'top', 1020, 440)] } },
  } as unknown as LayoutModel;
}
const link = { id: 'l', attachments: { from: { node: 'hub', name: 'p' }, to: { node: 'far', name: 'p' } } } as unknown as LayoutLink;
const segment: PathSegment = { from: { x: 180, y: 60 }, to: { x: 1020, y: 440 }, owner: { kind: 'link', id: 'l' } };

describe('chordBoxRefusal: the side exit of a flat block member', () => {
  it('lets the chord leave and enter its own boxes by the side edges toward the other end', () => {
    // From (180, 60) the chord reaches the right wall of `up` at y 69 and the left wall of `down` at y 431: both within the corner margins.
    expect(chordBoxRefusal(model(), link, segment)).toBe('edge');
    expect(chordBoxRefusal(model(), link, segment, 0, true)).toBeUndefined();
  });
  it('still refuses a chord that passes a corner within the margin', () => {
    const near: PathSegment = { ...segment, from: { x: 180, y: 92 } };
    const m = model();
    m.nodes.hub!.ports[0]!.anchor = { x: 180, y: 92 };
    expect(chordBoxRefusal(m, link, near, 0, true)).toBe('edge');
  });
});
