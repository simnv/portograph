import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Budget, LayoutLink, LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { systemElkClock } from '../../src/layout/elk-worker.js';
import { measureFans } from '../../src/layout/fan-spread.js';
import { standaloneChord, isFrameStraight } from '../../src/layout/frame-paths.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ranked-groups ticket 89: two nodes each linked to four nodes on the rank below, one frame. Neighbouring
 * chords of a fan stand closer than the chord clearance at the base pitch, so on main only the two outer links
 * take the chord. Placement measures the fan on the placed chords and runs again with the pitch that holds
 * the clearance; all eight links are then one straight segment.
 */
const yaml = readFileSync(new URL('../../goldens/synthetic/a-fan-spreads-its-ports-so-its-chords-hold-clearance.yaml', import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const fan = (model: LayoutModel): LayoutLink[] => model.links.filter(link => link.attachments!.from.node.startsWith('core-'));

describe('a fan spreads its ports so its diagonals hold clearance', () => {
  it('takes the frame chord on all eight links and removes none', async () => {
    const model = await run();
    expect(fan(model)).toHaveLength(8);
    for (const link of fan(model)) {
      expect(link.technique, link.id).toBe('straight');
      expect(link.path!.segments, link.id).toHaveLength(1);
    }
    expect(model.removedLinks ?? []).toEqual([]);
  });

  it('spreads the ports of a core face past the base pitch and grows the body around them', async () => {
    const model = await run();
    const core = model.nodes['core-1']!;
    const xs = core.ports.filter(port => port.side === 'bottom').map(port => port.anchor!.x).sort((a, b) => a - b);
    expect(xs).toHaveLength(4);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThan(12 + 1e-6);
    const [first, last] = [xs[0]!, xs[3]!];
    expect(core.bounds!.x).toBeLessThan(first);
    expect(core.bounds!.x + core.bounds!.width).toBeGreaterThan(last);
  });

  it('orders the ports of a face by the x of the far end, so no two chords of a face cross', async () => {
    const model = await run();
    for (const id of ['core-1', 'core-2']) {
      const ports = model.nodes[id]!.ports.filter(port => port.side === 'bottom').sort((a, b) => a.anchor!.x - b.anchor!.x);
      const far = ports.map(port => {
        const link = fan(model).find(item => item.attachments!.from.node === id && item.attachments!.from.ordinal === port.ref.ordinal
          && item.attachments!.from.name === port.ref.name)!;
        return model.nodes[link.attachments!.to.node]!.ports.find(item => item.ref.ordinal === link.attachments!.to.ordinal
          && item.ref.name === link.attachments!.to.name)!.anchor!.x;
      });
      expect(far, id).toEqual([...far].sort((a, b) => a - b));
    }
  });

  it('measures nothing more on the published placement: every fan pair holds the clearance', async () => {
    const model = await run();
    const measured = measureFans(model);
    expect([...measured.floors]).toEqual([]);
    expect(measured.declined).toEqual([]);
  });

  // Review of ticket 89, finding 1: a probe run only while the budget could pay for it, and the first placement is published otherwise.
  it('publishes the first placement when the budget cannot pay for a probe', async () => {
    const budget: Budget = { remainingMs: () => 3000, share: stageMs => Math.min(stageMs, 3000) };
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, budget });
    expect(fan(model).filter(link => link.technique === 'straight')).toHaveLength(2);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.nodes['core-1']!.sidePitch!.bottom).toBe(12);
    expect(model.diagnostics.filter(item => item.code === 'FAN_SPREAD_CUT')).toHaveLength(1);
  });

  // Ticket 112: machine speed must not change the layout. A clock that makes every stage look slow, with a deadline far away, cuts nothing.
  it('gives the same layout on a slow clock at a normal deadline, with no cut warning', async () => {
    let tick = 0;
    const clock = { ...systemElkClock, now: () => (tick += 4000) };
    const budget: Budget = { remainingMs: () => 600_000, share: stageMs => stageMs };
    const slow = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, budget, clock });
    const fast = await run();
    const shape = (model: LayoutModel): unknown => model.links.map(link => [link.id, link.technique, link.path!.segments]);
    expect(shape(slow)).toEqual(shape(fast));
    expect(slow.nodes['core-1']!.sidePitch).toEqual(fast.nodes['core-1']!.sidePitch);
    expect(slow.diagnostics.filter(item => item.code === 'FAN_SPREAD_CUT')).toEqual([]);
  });

  // Finding 2: two chord ports k pitch steps apart with a port between them that carries no chord. The floor is the pitch plus the share of
  // the slide, and the face is not declined for a span that is not a pitch.
  it('measures a face with an orthogonal link between two chords by the pitch, not by the gap', async () => {
    const model = structuredClone(await run()) as LayoutModel;
    const core = model.nodes['core-1']!;
    const ports = core.ports.filter(port => port.side === 'bottom').sort((a, b) => a.anchor!.x - b.anchor!.x);
    ports.forEach((port, i) => { port.anchor!.x = ports[0]!.anchor!.x + 12 * i; });
    core.sidePitch!.bottom = 12;
    const all = measureFans(model).floors.get('core-1')!.bottom!;
    const middle = fan(model).find(link => link.attachments!.from.node === 'core-1' && link.attachments!.from.ordinal === ports[1]!.ref.ordinal)!;
    model.document.links[middle.sourceIndex]!.route = 'orthogonal';
    const measured = measureFans(model);
    expect(measured.declined).toEqual([]);
    expect(measured.floors.get('core-1')?.bottom ?? 0).toBeLessThanOrEqual(all);
    expect(all).toBeLessThan(60);
  });

  // Finding 3: a link no other link can free is no reason to widen a face; on the published fixture every chord that holds passes the check.
  it('offers only links that can hold alone', async () => {
    const model = await run();
    for (const link of fan(model)) {
      if (isFrameStraight(model, link)) expect(standaloneChord(model, link), link.id).toBeDefined();
    }
  });
});
