import { describe, expect, it } from 'vitest';
import { COMMAND_DEADLINE_MS } from '../../src/cli.js';
import { BANDS_MS, FAN_RERUN_MS, POST_PLACEMENT_RESERVE_MS, RERUN_GATE_MS } from '../../src/pipeline/budget.js';
import { MAX_RERUNS } from '../../src/pipeline/index.js';

// Ticket 137 (side-faces.md, Section 19.5). A fake clock runs the worst path of the private sheet from its measured quiet stage times
// (seconds): first placement 4.0, fan re-run 2.7, 7f 6.5, route + link labels + score 0.55, a side trial = one re-run + one 7f.
// The gate is read before every re-run, as the pipeline does; the tail always runs.
const QUIET = { place: 4.0, rerun: 2.7, bands: 6.5, tail: 0.55 } as const;

function simulate(speed: number): { cuts: string[]; end: number; gates: number[] } {
  let clock = 0;
  const left = (): number => COMMAND_DEADLINE_MS - clock;
  const cuts: string[] = [], gates: number[] = [];
  const run = (seconds: number): void => { clock += seconds * 1000 * speed; };
  run(QUIET.place);
  let reruns = 0;
  for (let fan = 0; fan < 2; fan++) {
    gates.push(left());
    if (left() < RERUN_GATE_MS) { cuts.push('FAN_SPREAD_CUT'); break; }
    reruns++; run(QUIET.rerun);
  }
  run(QUIET.bands); // baseline 7f
  gates.push(left());
  if (reruns < MAX_RERUNS) {
    if (left() < RERUN_GATE_MS) cuts.push('SIDE_ROUND_CUT');
    else { run(QUIET.rerun); run(QUIET.bands); }
  }
  run(QUIET.tail);
  return { cuts, end: clock, gates };
}

describe('the command deadline and the one re-run gate', () => {
  it('states the constants in one place', () => {
    expect(COMMAND_DEADLINE_MS).toBe(60000);
    expect([FAN_RERUN_MS, BANDS_MS, POST_PLACEMENT_RESERVE_MS]).toEqual([6000, 14000, 4000]);
    expect(RERUN_GATE_MS).toBe(POST_PLACEMENT_RESERVE_MS + FAN_RERUN_MS + BANDS_MS);
  });

  it('cuts nothing at 2x and ends 2 s or more before the deadline, with the side trial run', () => {
    const { cuts, end, gates } = simulate(2);
    expect(cuts).toEqual([]);
    expect(end).toBeLessThanOrEqual(COMMAND_DEADLINE_MS - 2000);
    for (const reading of gates) expect(reading).toBeGreaterThanOrEqual(RERUN_GATE_MS);
  });

  it('cuts the side trial at 3x and still ends before the deadline', () => {
    const { cuts, end } = simulate(3);
    expect(cuts).toEqual(['SIDE_ROUND_CUT']);
    expect(end).toBeLessThan(COMMAND_DEADLINE_MS);
  });
});
