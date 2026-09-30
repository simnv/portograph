import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { COMMAND_DEADLINE_MS, createBudget, layout, parse } from '../../src/index.js';
import { BANDS_MS, FAN_RERUN_MS, POST_PLACEMENT_RESERVE_MS, RERUN_GATE_MS } from '../../src/pipeline/budget.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket 137 (side-faces.md, Section 19.5). The real pipeline runs on a fake clock: `testTiming` fires after every stage, and there the
// clock advances by the stage's time (ms, the private sheet quiet: first placement 4.0 s, re-run 2.7 s, 7f 6.5 s, route and labels
// 0.55 s) times the speed factor. Every later gate reads the advanced clock through the budget. Nothing waits and nothing reads real time.
const PAST_SIBLING = 'an-overlay-leaves-a-lateral-side-past-a-sibling-body'; // one placement run, then one side trial
const FAN = 'a-fan-spreads-its-ports-so-its-chords-hold-clearance'; // one fan re-run
const QUIET: Record<string, number> = { place: 4000, 'rerun-fan': 2700, 'rerun-side': 2700, bands: 6500, route: 300, 'link-labels': 250 };
const yaml = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

async function at(name: string, quiet: Record<string, number>, speed: number): Promise<{ model: LayoutModel; gates: Record<string, number> }> {
  let clock = 0;
  const gates: Record<string, number> = {};
  const model = await layout(parse(yaml(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    budget: createBudget(COMMAND_DEADLINE_MS, () => clock),
    testTiming: (label, _duration, remaining) => {
      if (label.startsWith('gate-')) gates[label] = remaining; else clock += speed * (quiet[label] ?? 0);
    } });
  return { model, gates };
}
const cuts = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code).filter(code => code.endsWith('_CUT'));

describe('the command deadline and the one re-run gate', () => {
  it('states the constants in one place', () => {
    expect(COMMAND_DEADLINE_MS).toBe(60000);
    expect([FAN_RERUN_MS, BANDS_MS, POST_PLACEMENT_RESERVE_MS]).toEqual([6000, 14000, 4000]);
    expect(RERUN_GATE_MS).toBe(POST_PLACEMENT_RESERVE_MS + FAN_RERUN_MS + BANDS_MS);
  });

  it('cuts no re-run at 2x of the sheet times: the fan gate and the side gate both read the far deadline', async () => {
    const side = await at(PAST_SIBLING, QUIET, 2);
    expect(cuts(side.model)).toEqual([]);
    expect(side.model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(true); // the side trial ran and was kept
    expect(side.gates['gate-side']).toBe(COMMAND_DEADLINE_MS - 2 * QUIET['place']!);
    expect(side.gates['gate-side']).toBeGreaterThanOrEqual(RERUN_GATE_MS);
    const fan = await at(FAN, QUIET, 2);
    expect(cuts(fan.model)).toEqual([]);
    expect(fan.gates['gate-fan']).toBe(COMMAND_DEADLINE_MS - 2 * QUIET['place']!);
  }, 60000);

  // Boundary of the side gate: the first placement takes exactly the time that leaves the gate value, and one second more or less.
  it('the side gate admits a trial with RERUN_GATE_MS + 1000 left and cuts it with RERUN_GATE_MS - 1000 left', async () => {
    const place = (left: number): Record<string, number> => ({ place: COMMAND_DEADLINE_MS - left });
    const over = await at(PAST_SIBLING, place(RERUN_GATE_MS + 1000), 1), under = await at(PAST_SIBLING, place(RERUN_GATE_MS - 1000), 1);
    expect(over.gates['gate-side']).toBe(RERUN_GATE_MS + 1000);
    expect(cuts(over.model)).toEqual([]);
    expect(over.model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(true);
    expect(under.gates['gate-side']).toBe(RERUN_GATE_MS - 1000);
    expect(cuts(under.model)).toEqual(['SIDE_ROUND_CUT']);
    expect(under.model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(false);
  }, 60000);

  // On this code 7f runs once, after every re-run, so the side gate reads 60 s less the first placement: it closes when that time passes 36 s.
  it('cuts the side trial when the first placement is slow enough, and still publishes a layout', async () => {
    const { model } = await at(PAST_SIBLING, { place: 37000 }, 1);
    expect(cuts(model)).toEqual(['SIDE_ROUND_CUT']);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
  }, 60000);
});
