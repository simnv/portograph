import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { chooseStart, drive } from '../../src/pipeline/driver.js';
import type { Env } from '../../src/pipeline/env.js';
import type { AnyRound, RoundId } from '../../src/pipeline/round.js';
import type { State } from '../../src/pipeline/state.js';

/**
 * Architecture 2, ticket 04: the admission rule of the driver, driven by synthetic descriptors. A descriptor measures a scripted offer, takes a start when it runs and writes
 * `run:<id>` when it is kept and `skip:<id>` when it is found without a start.
 */
interface Spec {
  id: RoundId; offer?: () => boolean; gain?: number[]; tie?: number; protects?: RoundId[]; reopens?: boolean; live?: () => boolean;
  children?: AnyRound[]; commit?: () => void;
}
const model = { fallbackUsed: false } as LayoutModel;
const round = (log: string[], spec: Spec): AnyRound => ({
  id: spec.id, label: `rerun-${spec.id}`, routed: false, children: spec.children ?? [],
  budget: { protects: spec.protects ?? [], tie: spec.tie ?? 0, visits: 1, again: false, retries: [], reopens: spec.reopens ?? false, floor: 0 },
  enabled: () => true,
  ...(spec.live === undefined ? {} : { live: async () => spec.live!() }),
  gain: () => spec.gain ?? [0, 0, 0],
  skip: () => { log.push(`skip:${spec.id}`); },
  tolerates: () => false,
  measure: async () => (spec.offer === undefined || spec.offer() ? {} : undefined),
  reserve: () => [],
  holdsAt7e: () => undefined,
  judge: () => undefined,
  commit: () => { log.push(`run:${spec.id}`); spec.commit?.(); },
  refuse: () => { log.push(`refused:${spec.id}`); },
});
const run = async (maxReruns: number, plan: AnyRound[][]): Promise<number> => {
  const env = { maxReruns, reruns: 0, placements: 0, options: {}, timed: <T>(_label: string, work: () => T) => work(), trialAbort: () => undefined,
    place: async () => model, bands: async (m: LayoutModel) => ({ model: m, moved: false, unmoved: undefined }), route: async (m: LayoutModel) => m } as unknown as Env;
  const state = { kept7e: model, base: model, kept: [] } as unknown as State;
  await drive(env, state, plan);
  return env.reruns;
};

describe('the admission rule (chooseStart)', () => {
  it('runs everything that fits, nothing without a start, and the best of a scarce group; a tie goes to the higher tie', () => {
    const a = { gain: [0, 1, 0], tie: 0 }, b = { gain: [0, 0, 0], tie: 1 };
    expect(chooseStart(2, [a, b])).toBe(0);
    expect(chooseStart(0, [a, b])).toBe(-1);
    expect(chooseStart(1, [a, b])).toBe(0);
    expect(chooseStart(1, [{ ...a, gain: [0, 0, 0] }, b])).toBe(1);
  });
});

describe('the driver', () => {
  it('does not measure a round again after a kept sibling when it had no offer before (a course main never offered)', async () => {
    const log: string[] = [];
    let courseOffered = false;
    const side = round(log, { id: 'side', tie: 1, commit: () => { courseOffered = true; } });
    const course = round(log, { id: 'course', offer: () => courseOffered });
    await run(5, [[side, course]]);
    expect(log).toEqual(['run:side']);
  });

  it('measures it again when the round declares reopens (the side round after a course)', async () => {
    const log: string[] = [];
    let sideOffered = false;
    const side = round(log, { id: 'side', tie: 1, reopens: true, offer: () => sideOffered });
    const course = round(log, { id: 'course', commit: () => { sideOffered = true; } });
    // The side round has no offer at first; the course runs, and the side round is measured again and runs.
    await run(5, [[side, course]]);
    expect(log).toEqual(['run:course', 'run:side']);
  });

  it('defers a sibling that lost a scarce start, and runs it when the kept trial removed the turn offer', async () => {
    const log: string[] = [];
    let turnLive = true;
    const side = round(log, { id: 'side', tie: 1, protects: ['turn'], commit: () => { turnLive = false; } });
    const course = round(log, { id: 'course', protects: ['turn'] });
    const turn = round(log, { id: 'turn', live: () => turnLive, offer: () => false });
    const reruns = await run(2, [[side, course], [turn]]);
    expect(log).toEqual(['run:side', 'run:course']);
    expect(reruns).toBe(2);
  });

  it('skips the deferred sibling when the turn offer stays, and only then', async () => {
    const log: string[] = [];
    const side = round(log, { id: 'side', tie: 1, protects: ['turn'] });
    const course = round(log, { id: 'course', protects: ['turn'] });
    const turn = round(log, { id: 'turn', live: () => true, offer: () => false });
    expect(await run(2, [[side, course], [turn]])).toBe(1);
    expect(log).toEqual(['run:side', 'skip:course']);
  });

  it('gives a scarce start to the course whose gain beats the side offer, and to the side on a tie', async () => {
    const better: string[] = [];
    await run(1, [[round(better, { id: 'side', tie: 1 }), round(better, { id: 'course', gain: [0, 1, 2] })]]);
    expect(better).toEqual(['run:course', 'skip:side']);
    const tie: string[] = [];
    await run(1, [[round(tie, { id: 'side', tie: 1 }), round(tie, { id: 'course' })]]);
    expect(tie).toEqual(['run:side', 'skip:course']);
  });

  it('leaves a start to each live offer of the rounds it protects (reservedFor)', async () => {
    const held: string[] = [];
    await run(1, [[round(held, { id: 'span', protects: ['course'] })], [round(held, { id: 'course', live: () => true })]]);
    expect(held).toEqual(['skip:span', 'run:course']);
    const free: string[] = [];
    await run(1, [[round(free, { id: 'span', protects: ['course'] })], [round(free, { id: 'course', live: () => false })]]);
    expect(free).toEqual(['run:span', 'skip:course']);
  });

  it('checks a start for each child round of a trial, with the parent\'s reservation, and runs at most two', async () => {
    const reserved: string[] = [];
    const fanReserved = round(reserved, { id: 'fan' });
    await run(3, [[round(reserved, { id: 'span', protects: ['course'], children: [fanReserved] })], [round(reserved, { id: 'course', live: () => true, offer: () => false })]]);
    // 3 starts, 1 reserved for the course: the span takes one, and one child fan fits.
    expect(reserved.filter(entry => entry === 'run:fan')).toHaveLength(1);
    const open: string[] = [];
    await run(3, [[round(open, { id: 'span', protects: ['course'], children: [round(open, { id: 'fan' })] })], [round(open, { id: 'course', live: () => false, offer: () => false })]]);
    expect(open.filter(entry => entry === 'run:fan')).toHaveLength(2);
    expect(open.at(-1)).toBe('run:span');
  });
});
