import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse as readYaml, stringify as writeYaml } from 'yaml';
import { parse } from '../../src/index.js';
import type { LayoutLink, LayoutModel } from '../../src/model/layout.js';
import type { Reservations } from '../../src/layout/reservations.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { PlacementRefusal } from '../../src/layout/placement-refusal.js';
import { holdsRouted } from '../../src/layout/reservation-checks.js';
import { createEnv, type Env } from '../../src/pipeline/env.js';
import { firstState } from '../../src/pipeline/initial.js';
import { chooseFlatGapsAgain, drive, FLAT_BLOCK_GAP_FINAL_DECLINED, refuseCrowdedChords } from '../../src/pipeline/driver.js';
import { publish } from '../../src/pipeline/publish.js';
import type { State } from '../../src/pipeline/state.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 42, review 1: the guards of the final flat-gap choice, on the fixture of the ticket (reproductions of the reviewer). A
// routed model must stay a protected model, because stage 9 labels it, so a fault is drawn into a copy that only the guard under test reads:
// the candidate route (`inject.model`, caught at `env.route`) bends `inject.bend` for the bend reader, or carries a stair on `inject.stair` for
// the course reader. The readers themselves are the production ones.
const inject = vi.hoisted(() => ({ model: undefined as unknown, bend: undefined as string | undefined, stair: undefined as string | undefined }));
vi.mock('../../src/layout/objective.js', async original => {
  const real = await original<typeof import('../../src/layout/objective.js')>();
  return { ...real, pathBends: (link: LayoutLink) => {
    const model = inject.model as LayoutModel | undefined;
    if (model === undefined || link.id !== inject.bend || !model.links.includes(link)) return real.pathBends(link);
    const { from, to } = link.path!.segments[0]!, corner = { x: to.x, y: from.y };
    return real.pathBends({ ...link, path: { ...link.path!, segments: [{ ...link.path!.segments[0]!, to: corner }, { ...link.path!.segments[0]!, from: corner }] } });
  } };
});
vi.mock('../../src/layout/reservation-checks.js', async original => {
  const real = await original<typeof import('../../src/layout/reservation-checks.js')>();
  return { ...real, holdsRouted: (ledger: Reservations, routed: LayoutModel) => routed !== inject.model || inject.stair === undefined
    ? real.holdsRouted(ledger, routed) : real.holdsRouted(ledger, stair(routed, inject.stair)) };
});
/** A copy of `model` whose link `id` takes a 0.01 px orthogonal stair at its first corner: two more turns. */
function stair(model: LayoutModel, id: string): LayoutModel {
  const copy = JSON.parse(JSON.stringify(model)) as LayoutModel, link = copy.links.find(item => item.id === id)!, segments = link.path!.segments, d = 0.01;
  const a = segments[0]!, b = segments[1]!, corner = a.to;
  const ax = corner.x - a.from.x, ay = corner.y - a.from.y, bx = b.to.x - corner.x, by = b.to.y - corner.y, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  const p = { x: corner.x - d * ax / la, y: corner.y - d * ay / la }, q = { x: corner.x + d * bx / lb, y: corner.y + d * by / lb };
  const points = [a.from, p, { x: p.x + d * bx / lb, y: p.y + d * by / lb }, q, b.to];
  link.path!.segments = [...points.slice(1).map((to, j) => ({ ...a, from: points[j]!, to })), ...segments.slice(2)];
  return copy;
}
/** Catches the candidate route: the only route of the final choice (the baseline's publication route is the kept one). */
function catchRoute(env: Env): void {
  const route = env.route;
  env.route = async (...args) => { const routed = await route(...args); inject.model = routed; return routed; };
}
type Sheet = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sheet = (name: string): Sheet => readYaml(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')) as Sheet;
const plain = sheet('a-flat-gap-is-chosen-again-after-the-fan-round');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
/** The command up to the final choice: the first state, the rounds and the crowded-chord replay. */
async function start(input: Sheet): Promise<{ env: Env; s: State }> {
  const env = createEnv(parse(writeYaml(input)), options), s = await firstState(env);
  await drive(env, s); await refuseCrowdedChords(env, s);
  return { env, s };
}
const last = (s: State) => s.sideNotes.at(-1);

describe('the guards of the final flat-gap choice (review 1)', () => {
  it('declines a candidate whose kept course publishes more turns than it promised (P2)', async () => {
    // The fixture with a kept course beside it: the port with two peers in two directions, its group renamed.
    const input = structuredClone(plain), course = sheet('a-port-with-two-peers-in-two-directions-takes-a-side-per-link');
    course.groups.remote = course.groups.site; delete course.groups.site; course.nodes.sw.group = 'remote'; course.groups.dmz.of = 'remote';
    Object.assign(input.groups, course.groups); Object.assign(input.nodes, course.nodes); input.links.push(...course.links);
    const { env, s } = await start(input);
    const entry = s.kept.find(item => item.kind === 'course' && item.payload.maxTurns !== undefined);
    expect(entry).toBeDefined();
    const id = (entry as Extract<State['kept'][number], { kind: 'course' }>).payload.course.link;
    const before = s.routedFinal ?? s.routedBase!;
    expect(holdsRouted(s.kept, before)).toEqual([]);
    expect(holdsRouted(s.kept, stair(before, id))).not.toEqual([]);
    inject.model = undefined; inject.bend = undefined; inject.stair = id;
    catchRoute(env);
    expect(await chooseFlatGapsAgain(env, s)).toBe(true);
    expect(last(s)?.code).toBe(FLAT_BLOCK_GAP_FINAL_DECLINED);
    expect(last(s)?.message).toMatch(new RegExp(`the course of ${id} breaks its promise`));
    inject.stair = undefined;
    expect(holdsRouted(s.kept, s.routedFinal ?? s.routedBase!)).toEqual([]);
  }, 120000);

  it('declines a candidate on which a straight link bends, and keeps the placement before it', async () => {
    const { env, s } = await start(plain);
    const before = { base: s.base, kept7e: s.kept7e, routed: s.routedFinal, gaps: env.flatBlockGaps };
    const diagonal = (s.routedFinal ?? s.routedBase!).links.find(link => link.path?.segments.length === 1
      && link.path.segments[0]!.from.x !== link.path.segments[0]!.to.x && link.path.segments[0]!.from.y !== link.path.segments[0]!.to.y)!;
    inject.model = undefined; inject.stair = undefined; inject.bend = diagonal.id;
    catchRoute(env);
    expect(await chooseFlatGapsAgain(env, s)).toBe(true);
    inject.bend = undefined;
    expect(last(s)?.code).toBe(FLAT_BLOCK_GAP_FINAL_DECLINED);
    expect(last(s)?.message).toMatch(new RegExp(`the links ${diagonal.id} are no longer straight`));
    expect(s.base).toBe(before.base);
    expect(s.kept7e).toBe(before.kept7e);
    expect(s.routedFinal).toBe(before.routed);
    expect(env.flatBlockGaps).toEqual(before.gaps);
  }, 120000);

  it('declines a candidate whose ledger lost a standing seat set with no withdrawal entry (P2)', async () => {
    const input = structuredClone(plain); input.layout.moveBeforeGrow = true;
    const { env, s } = await start(input);
    const sets = (s.base.reservations ?? []).filter(item => item.kind === 'seatSet');
    expect(sets.length).toBeGreaterThan(0);
    const row = (sets[0] as Extract<State['kept'][number], { kind: 'seatSet' }>).payload.row;
    const bands = env.bands;
    env.bands = async (...args) => {
      const banded = await bands(...args);
      return { ...banded, model: restoreLayoutModel(JSON.stringify({ ...banded.model, reservations: banded.model.reservations!.filter(item => item.kind !== 'seatSet' || item.payload.row !== row) })) };
    };
    const base = s.base;
    await chooseFlatGapsAgain(env, s);
    expect(last(s)?.code).toBe(FLAT_BLOCK_GAP_FINAL_DECLINED);
    expect(last(s)?.message).toMatch(new RegExp(`the seat sets of ${row.replace(/[#]/g, '\\$&')} do not stand`));
    expect(s.base).toBe(base);
  }, 120000);

  it('lets the centring invariant of the command propagate from 7f (P2)', async () => {
    const { env, s } = await start(plain);
    env.bands = async () => { throw new PlacementRefusal('centring', 'The alignment target record contradicts its replay', { stage: 'bands' }); };
    await expect(chooseFlatGapsAgain(env, s)).rejects.toThrow(/alignment target record/);
  }, 120000);

  it('keeps the geometry before it on a declined candidate and credits the started placement', async () => {
    const { env, s } = await start(plain);
    const before = await publish(env, s), { placements, gateRuns } = env;
    const bands = env.bands;
    env.bands = async () => { throw new PlacementRefusal('postcondition', 'trial refusal'); };
    expect(await chooseFlatGapsAgain(env, s)).toBe(true);
    env.bands = bands;
    const after = await publish(env, s);
    const strip = (model: LayoutModel) => ({ ...model, runtime: undefined, diagnostics: model.diagnostics.filter(item => item.code !== FLAT_BLOCK_GAP_FINAL_DECLINED) });
    expect(strip(after)).toEqual(strip(before));
    expect(env.placements - placements).toBe(1);
    expect(env.gateRuns - gateRuns).toBe(1);
  }, 120000);
});
