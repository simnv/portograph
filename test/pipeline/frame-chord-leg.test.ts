import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { expectedFramePath, isFrameStraight, orthogonalLeg } from '../../src/layout/frame-paths.js';
import { findPort } from '../../src/layout/row-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ranked-groups ticket 91: the chord check read the 15 px stem of an orthogonal neighbour, not the vertical leg that runs on from it
 * to its gap row. A fan at 12 px pitch with a chord slanting 1.74 px toward a long leg passed the stem and stood at 8.8 px along the leg.
 */
const yaml = readFileSync(new URL('../../goldens/synthetic/a-chord-holds-clearance-along-a-neighbours-whole-leg.yaml', import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

/** The published model, with the core's bottom ports at 12 px pitch: chord port, then the transit's port beside it, and the chord's far port slanted. */
async function crowded(slant: number): Promise<{ model: LayoutModel; chord: string }> {
  const model = structuredClone(await run()) as LayoutModel;
  delete model.frozenChords;
  const core = model.nodes['core']!;
  const chord = model.links.find(link => link.attachments!.from.node === 'core' && link.attachments!.to.node === 'edge')!;
  const transit = model.links.find(link => link.attachments!.from.node === 'core' && link.attachments!.to.node === 'deep')!;
  const at = (ref: { node: string; ordinal?: number; name?: string }) => model.nodes[ref.node]!.ports.find(port => port.ref.ordinal === ref.ordinal && port.ref.name === ref.name)!;
  const near = at(chord.attachments!.from), leg = at(transit.attachments!.from), far = at(chord.attachments!.to);
  near.anchor!.x = 40; leg.anchor!.x = 52; far.anchor!.x = 40 + slant;
  // The other ports of the face stand well apart, and the other link is no held chord, so the pair under test is alone.
  core.ports.filter(port => port.side === 'bottom' && port !== near && port !== leg).forEach((port, i) => { port.anchor!.x = 300 + 60 * i; });
  for (const link of model.links) if (link !== chord && link.technique === 'straight') { delete link.technique; delete link.path; }
  return { model, chord: chord.id };
}

describe('a frame chord holds its clearance along a neighbour\'s whole leg', () => {
  it("reads a lane link's leg to its lane mouth, not the 15 px stem", async () => {
    const { model } = await crowded(0);
    const transit = model.links.find(link => link.attachments!.to.node === 'deep' && link.attachments!.from.node === 'core')!;
    const leg = orthogonalLeg(model, transit, 'from')!;
    // The transit leaves by a lane, so its part ends at the lane mouth, a stem short of the lane top (330 - 10.75 - 15).
    expect(leg.to.y).toBeCloseTo(304.25, 6);
    expect(leg.to.x).toBe(leg.from.x);
  });

  it('admits an exactly vertical chord beside the leg', async () => {
    const { model, chord } = await crowded(0);
    expect(expectedFramePath(model, model.links.find(link => link.id === chord)!)).toBeDefined();
  });

  it('refuses a chord that slants 1.74 px toward the leg: it passes the stem and fails the leg', async () => {
    const { model, chord } = await crowded(1.74);
    expect(expectedFramePath(model, model.links.find(link => link.id === chord)!)).toBeUndefined();
  });

  it('publishes the fixture with no G6 violation', async () => {
    const model = await run();
    expect(score(model).snapshot.gates.G6.violations).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  });

  // Review of ticket 91, finding 1: the bound must be an upper bound on every leg the plan seats. Each published first or last vertical run of a
  // routed link that is not a chord is compared with `orthogonalLeg` on the same published model.
  it('bounds every published end leg of the synthetic inputs', async () => {
    const names = readdirSync(new URL('../../goldens/synthetic/', import.meta.url)).filter(name => /fan|gap|row|leg|chord|tier|canton|held|leaf|lateral|title|narrow/.test(name) && name.endsWith('.yaml'));
    expect(names.length).toBeGreaterThan(20);
    let checked = 0;
    for (const name of names) {
      let model: LayoutModel;
      try { model = await layout(parse(readFileSync(new URL(`../../goldens/synthetic/${name}`, import.meta.url), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }); } catch { continue; }
      for (const link of model.links) {
        if (link.layer !== 'routed' || link.technique === 'straight' || link.technique === 'stub' || !link.path || link.path.segments.length < 2) continue;
        for (const end of ['from', 'to'] as const) {
          const port = findPort(model, link.attachments![end]);
          if (!port?.anchor || (port.side !== 'top' && port.side !== 'bottom')) continue;
          const segments = end === 'from' ? link.path.segments : [...link.path.segments].reverse().map(s => ({ from: s.to, to: s.from }));
          let y = port.anchor.y;
          for (const segment of segments) {
            if (Math.abs(segment.from.x - port.anchor.x) > 1e-6 || Math.abs(segment.to.x - port.anchor.x) > 1e-6 || Math.abs(segment.from.y - y) > 1e-6) break;
            y = segment.to.y;
          }
          // Runs inside the gap the port faces only: a run that goes on through a band (a lane run, a straight drop) is clipped at the band edge. A chord
          // of a canton frame does not cross it (ticket 95, asserted below).
          const sign = port.side === 'bottom' ? 1 : -1;
          const edges = model.tierBands.map(band => (sign > 0 ? band.bounds!.y : band.bounds!.y + band.bounds!.height) - port.anchor!.y).filter(d => d * sign > 1e-6).map(Math.abs);
          const published = Math.min(Math.abs(y - port.anchor.y), edges.length ? Math.min(...edges) : Infinity);
          const bound = orthogonalLeg(model, link, end)!;
          expect(published, `${name} ${link.id}.${end}`).toBeLessThanOrEqual(Math.abs(bound.to.y - bound.from.y) + 1e-6);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  }, 120000);

  // Ticket 95: a frame chord never leaves its tier gap. `standaloneChord` refuses a link that spans a tier band it does not end in, so no chord meets
  // a lane run or a drop in a band: the runs the leg bound clips at the band edge cannot come near a chord. Measured over every synthetic input.
  it('keeps every published frame chord out of the tier bands its ends do not stand in', async () => {
    const names = readdirSync(new URL('../../goldens/synthetic/', import.meta.url)).filter(name => name.endsWith('.yaml'));
    let checked = 0;
    for (const name of names) {
      let model: LayoutModel;
      try { model = await layout(parse(readFileSync(new URL(`../../goldens/synthetic/${name}`, import.meta.url), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }); } catch { continue; }
      for (const link of model.links) {
        if (!isFrameStraight(model, link)) continue;
        const s = link.path!.segments[0]!;
        const ends = [link.attachments!.from.node, link.attachments!.to.node].map(id => model.groups[model.document.nodes[id]!.group]!.tier!);
        for (const band of model.tierBands) {
          const b = band.bounds;
          if (!b || ends.includes(band.tier)) continue;
          for (let t = 0.02; t < 1; t += 0.02) {
            const x = s.from.x + (s.to.x - s.from.x) * t, y = s.from.y + (s.to.y - s.from.y) * t;
            expect(x > b.x && x < b.x + b.width && y > b.y + 0.5 && y < b.y + b.height - 0.5, `${name} ${link.id} in band ${band.tier}`).toBe(false);
          }
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  }, 300000);
});
