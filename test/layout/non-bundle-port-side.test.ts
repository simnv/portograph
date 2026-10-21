import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket 09 (architecture-2): a port outside every bundle keeps the side of the bundle block that stage 7b gave it. "Install all
// blocks jointly" used to sort by planned x alone, so a free port that 7b seated before the pills landed behind them, and its
// overlay chord ran through a pill.
const fixture = readFileSync(new URL('../../goldens/synthetic/a-port-outside-a-bundle-keeps-its-side-of-the-block.yaml', import.meta.url), 'utf8');

describe('a port outside a bundle keeps its side of the block', () => {
  it('seats the overlay ports left of the bundle block, and no chord crosses a pill', async () => {
    const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const top = model.nodes['core']!.ports.filter(port => port.side === 'top');
    const key = (ref: { node: string; name?: string | undefined; ordinal: number }): string => `${ref.node}/${ref.name}/${ref.ordinal}`;
    const bundled = new Set(model.links.filter(link => link.bundle).flatMap(link => [link.attachments!.from, link.attachments!.to]).map(key));
    const isBundled = (port: (typeof top)[number]): boolean => bundled.has(key(port.ref));
    const free = top.filter(port => !isBundled(port)), block = top.filter(isBundled);
    expect(free).toHaveLength(2);
    expect(block).toHaveLength(3);
    // The far ends lie to the left, and 7b seated the free ports first; they stay there, in their 7b order.
    expect(Math.max(...free.map(port => port.anchor!.x))).toBeLessThan(Math.min(...block.map(port => port.anchor!.x)));
    expect(free.every(port => port.engineOrder! < Math.min(...block.map(item => item.engineOrder!)))).toBe(true);
    const pills = model.labels.filter(label => label.role === 'pill');
    expect(pills.length).toBeGreaterThanOrEqual(3);
    for (const link of model.links.filter(item => item.layer === 'overlay')) {
      for (const segment of link.path!.segments) for (const pill of pills) {
        for (let t = 0; t <= 1; t += 1 / 400) {
          const x = segment.from.x + (segment.to.x - segment.from.x) * t, y = segment.from.y + (segment.to.y - segment.from.y) * t;
          const b = pill.bounds!, inside = x > b.x && x < b.x + b.width && y > b.y && y < b.y + b.height;
          expect(inside, `${link.id} crosses pill ${pill.text}`).toBe(false);
        }
      }
    }
  });

  it('keeps the members straight when a long node label puts the free ports far right in stage 7b', async () => {
    const wide = fixture.replace('label: core', 'label: a-core-node-with-a-very-long-label-that-widens-the-box-a-lot');
    const model = await layout(parse(wide), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const members = model.links.filter(link => link.bundle);
    expect(members).toHaveLength(3);
    for (const link of members) {
      expect(link.path!.segments, link.id).toHaveLength(1);
      expect(link.path!.segments[0]!.from.x, link.id).toBeCloseTo(link.path!.segments[0]!.to.x, 3);
    }
  });
});
