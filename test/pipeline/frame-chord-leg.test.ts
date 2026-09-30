import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { expectedFramePath, orthogonalLeg } from '../../src/layout/frame-paths.js';
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
  it('reads the leg to a stem short of the tier gap it faces, not the 15 px stem', async () => {
    const { model } = await crowded(0);
    const transit = model.links.find(link => link.attachments!.to.node === 'deep' && link.attachments!.from.node === 'core')!;
    const leg = orthogonalLeg(model, transit, 'from')!;
    expect(Math.abs(leg.to.y - leg.from.y)).toBeGreaterThan(15);
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
});
