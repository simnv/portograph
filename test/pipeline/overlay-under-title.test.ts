import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/index.js';
import { layout, parse, render } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const text = readFileSync(new URL('../../goldens/synthetic/an-overlay-chord-runs-under-a-title.yaml', import.meta.url), 'utf8');

/** Whether the segment from a to b meets the rectangle (Liang-Barsky). */
function meets(a: { x: number; y: number }, b: { x: number; y: number }, box: Rect): boolean {
  let lo = 0, hi = 1;
  for (const [p, q] of [[a.x - b.x, a.x - box.x], [b.x - a.x, box.x + box.width - a.x], [a.y - b.y, a.y - box.y], [b.y - a.y, box.y + box.height - a.y]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
  }
  return lo <= hi;
}

describe('an overlay chord under a title (canton-groups ticket 60)', () => {
  it('stays one straight segment under the titles it meets, and every group title carries a halo instead of a mask cutout', async () => {
    const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const titles = model.labels.filter(label => label.role === 'group' && label.bounds);
    const overlay = model.links.filter(link => link.layer === 'overlay');
    expect(overlay).toHaveLength(2);
    const met = new Set<string>();
    for (const link of overlay) {
      // The title is no blocker: the derived path is the one straight segment, whatever text it meets.
      expect(link.path!.segments).toHaveLength(1);
      const [segment] = link.path!.segments;
      for (const title of titles) if (meets(segment!.from, segment!.to, title.bounds!)) met.add(title.owner.kind === 'group' ? title.owner.id : '');
    }
    // The canton title is one of them: the case the ticket found.
    expect(met.has('west')).toBe(true);
    expect(met.size).toBeGreaterThanOrEqual(3);
    // Ticket 162: the overlay mask no longer cuts a group title out. The title carries a halo in the colour behind it (`paint-order`),
    // so the line breaks under its letters, as a routed diagonal does.
    const svg = render(model);
    const cutouts = [...svg.matchAll(/<rect class="pg-mask-hide"[^>]*>/g)].map(item => item[0]);
    for (const title of titles) {
      const box = title.bounds!;
      expect(cutouts.some(rect => (['x', 'y', 'width', 'height'] as const).every(key =>
        Math.abs(Number(new RegExp(` ${key}="([^"]+)"`).exec(rect)![1]) - box[key]) < 0.01)), title.id).toBe(false);
    }
    const groupTexts = [...svg.matchAll(/<text class="([^"]*group-label[^"]*)"/g)].map(item => item[1]!);
    expect(groupTexts).toHaveLength(titles.length);
    for (const classes of groupTexts) expect(classes).toMatch(/\bpg-halo\b.*\bpg-halo-\d+\b/);
    expect(svg).toContain('paint-order:stroke fill');
  }, 60000);
});
