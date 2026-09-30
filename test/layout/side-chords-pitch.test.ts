import { describe, expect, it, vi } from 'vitest';
import type { LayoutModel, LayoutNode } from '../../src/model/layout.js';
import { chordTrace, measureChordSides } from '../../src/layout/side-chords.js';

/**
 * Ticket 140 (review of 117, M2): the chord pass reads every chord accepted earlier, on any node. The pass is run whole on a hand-made model. The chord verdicts
 * are fixed (`frame-paths` and the hint refusal are replaced), so the test reads the pitch check and nothing else.
 */
vi.mock('../../src/layout/frame-paths.js', async importOriginal => {
  const segments: Record<string, { from: { x: number; y: number }; to: { x: number; y: number } }> = {
    'link-a': { from: { x: 0, y: 0 }, to: { x: 500, y: 100 } },
    'link-b': { from: { x: 0, y: 6 }, to: { x: 500, y: 106 } },
  };
  return {
    ...await importOriginal<typeof import('../../src/layout/frame-paths.js')>(),
    isRoutedChord: () => false,
    chordKind: () => 'cross',
    chordVerdict: (_model: unknown, link: { id: string; owner: unknown }) => ({ segment: { ...segments[link.id]!, owner: link.owner } }),
    fixedPointRefusal: () => undefined,
    edgeMisses: () => [],
  };
});
vi.mock('../../src/layout/side-hints.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/layout/side-hints.js')>(),
  hintRefusal: () => undefined,
}));

const box = (x: number, y: number) => ({ x, y, width: 50, height: 40 });
const node = (id: string, bounds: ReturnType<typeof box>, side: 'top' | 'bottom'): LayoutNode => ({ id, bounds, ports: [{ ref: { node: id, ordinal: 1 }, side, anchor: { x: bounds.x + 25, y: bounds.y } }] }) as unknown as LayoutNode;
const link = (id: string, from: string, to: string) => ({ id, layer: 'routed', attachments: { from: { node: from, ordinal: 1 }, to: { node: to, ordinal: 1 } }, owner: { kind: 'link', id } });
/** Two routed links on four nodes: link-a from n1 to n2, link-b from n3 to n4. Both would be one chord to the right, 6 px apart. */
const model = {
  document: { nodes: { n1: { group: 'up' }, n2: { group: 'down' }, n3: { group: 'up' }, n4: { group: 'down' } } },
  groups: { up: { tier: 1 }, down: { tier: 2 } },
  links: [link('link-a', 'n1', 'n2'), link('link-b', 'n3', 'n4')],
  nodes: { n1: node('n1', box(0, 0), 'bottom'), n2: node('n2', box(500, 100), 'top'), n3: node('n3', box(0, 6), 'bottom'), n4: node('n4', box(500, 106), 'top') },
} as unknown as LayoutModel;

describe('the chord pass keeps the chord clearance to a chord accepted on another node', () => {
  it('refuses the second chord for its pitch, and takes the first', () => {
    const events: Record<string, unknown>[] = [];
    chordTrace.on = event => events.push(event);
    try {
      const pass = measureChordSides(model, model.nodes, model.nodes, new Set(), target => ({ node: target, grows: false }), 0,
        (key, side) => `${key}|${side}`, () => 1, 0, 100);
      // link-a is taken on its lower end, n2. link-b has its ends on n3 and n4, so only a check over every node refuses it.
      expect([...pass.promised.values()].map(item => item.link)).toEqual(['link-a']);
      const pitch = events.filter(event => event['ev'] === 'attempt' && event['link'] === 'link-b' && event['why'] === 'pitch');
      expect(pitch.length).toBeGreaterThan(0);
      expect(events.some(event => event['ev'] === 'none' && event['link'] === 'link-b')).toBe(true);
    } finally { delete chordTrace.on; }
  });
});
