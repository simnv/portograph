import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { CommandDeadlineError, createBudget, layout, parse } from '../../src/index.js';
import { COMMAND_DEADLINE_MS } from '../../src/internal.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket 141 (side-faces.md, Section 19.5). The choice between layouts never reads the clock. The real pipeline runs on a fake clock:
// `testTiming` fires after every stage, and there the clock advances by the stage's time (ms, the private sheet quiet) times the speed
// factor. Nothing waits and nothing reads real time. The layout is the same at every speed; only a clock past the deadline ends the command.
const PAST_SIBLING = 'an-overlay-leaves-a-lateral-side-past-a-sibling-body'; // one placement run, then one side trial
const FAN = 'a-fan-spreads-its-ports-so-its-chords-hold-clearance'; // one fan re-run
const QUIET: Record<string, number> = { place: 4000, 'rerun-fan': 2700, 'rerun-side': 2700, bands: 6500, 'bands-trial': 6500, route: 300, 'route-trial': 300, 'link-labels': 250 };
const yaml = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const bytes = (model: LayoutModel): string => JSON.stringify(model, (key, value: unknown) => key === 'runtime' ? undefined : value);

const at = (name: string, quiet: Record<string, number>, speed: number): Promise<LayoutModel> => {
  let clock = 0;
  return layout(parse(yaml(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    budget: createBudget(COMMAND_DEADLINE_MS, () => clock),
    testTiming: label => { clock += speed * (quiet[label] ?? 0); } });
};
const cuts = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code).filter(code => code.endsWith('_CUT'));

describe('the command deadline and the layout', () => {
  it('states the deadline', () => { expect(COMMAND_DEADLINE_MS).toBe(120000); });

  it('gives byte-identical layouts at speeds 0, 1 and 2 (the side trial, kept)', async () => {
    const [free, quiet, slow] = [await at(PAST_SIBLING, QUIET, 0), await at(PAST_SIBLING, QUIET, 1), await at(PAST_SIBLING, QUIET, 2)];
    expect(free.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(true);
    expect(bytes(quiet)).toBe(bytes(free));
    expect(bytes(slow)).toBe(bytes(free));
    expect(cuts(slow)).toEqual([]);
  }, 60000);

  it('gives byte-identical layouts at speeds 0, 1 and 2 (the fan re-run)', async () => {
    const [free, quiet, slow] = [await at(FAN, QUIET, 0), await at(FAN, QUIET, 1), await at(FAN, QUIET, 2)];
    expect(bytes(quiet)).toBe(bytes(free));
    expect(bytes(slow)).toBe(bytes(free));
    expect(cuts(slow)).toEqual([]);
  }, 60000);

  // The old fan gate cut a re-run when the first placement took 37 s; now the re-run runs and the bytes are the same.
  it('a slow first placement that still fits the deadline does not cut a fan re-run', async () => {
    const slow = await at(FAN, { place: 37000 }, 1), free = await at(FAN, {}, 0);
    expect(cuts(slow)).toEqual([]);
    expect(bytes(slow)).toBe(bytes(free));
  }, 60000);

  // A time that used to close the old gate (a first placement of 37 s) no longer picks another layout: the trial still runs and is kept.
  it('a slow first placement that still fits the deadline does not cut a side round', async () => {
    const slow = await at(PAST_SIBLING, { place: 37000 }, 1), free = await at(PAST_SIBLING, {}, 0);
    expect(cuts(slow)).toEqual([]);
    expect(bytes(slow)).toBe(bytes(free));
  }, 60000);

  it('a clock past the deadline ends the whole command with the deadline error and publishes no other layout', async () => {
    await expect(at(PAST_SIBLING, { place: COMMAND_DEADLINE_MS + 1 }, 1)).rejects.toBeInstanceOf(CommandDeadlineError);
    await expect(at(PAST_SIBLING, { bands: COMMAND_DEADLINE_MS + 1 }, 1)).rejects.toBeInstanceOf(CommandDeadlineError);
  }, 60000);
});
