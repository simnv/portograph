import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { holdsMove } from '../../src/layout/move-reservations.js';
import { reserveGroupExits, standsIn } from '../../src/layout/group-exits.js';
import { routeObstacles } from '../../src/route/obstacles.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

async function check(name: string, only?: string[]) {
  const model = await run(fixture(name));
  // `only` names the gate and keeps the violations that name a group: fan rows of two ports are another rule's.
  for (const [id, gate] of Object.entries(score(model).snapshot.gates)) {
    if (!only) expect([id, gate.violations]).toEqual([id, []]);
    else if (only.includes(id)) expect([id, gate.violations.filter(item => item.elements.some(element => model.groups[element] !== undefined))]).toEqual([id, []]);
  }
  if (!only) for (const link of model.links) expect(link.path, link.id).toBeDefined();
  expect(model.diagnostics.filter(item => item.code === 'GROUP_EXIT_BLOCKED')).toEqual([]);
  return model;
}

describe('a link leaves its own group through a reserved exit (architecture ticket 13)', () => {
  it.each([['a-link-leaves-its-group-through-a-door', 'home'], ['a-claimed-run-clears-a-shared-run', 'hub']])('%s: no gate fails and every link is routed', async (name, group) => {
    const model = await check(name);
    // The exit is part of the link's shared run: it ends outside the group box, past its edge margin.
    const box = model.groups[group]!.bounds!;
    const out = model.links.filter(link => (link.sharedRuns?.from ?? []).at(-1)?.to.y !== undefined
      && (link.sharedRuns!.from!.at(-1)!.to.x < box.x - 10 || link.sharedRuns!.from!.at(-1)!.to.x > box.x + box.width + 10));
    expect(out.map(link => link.id)).toContain('link-1');
  }, 60000);

  it('a ranked group: a branch that turns short of the clearance off the stem is its own tread, so no gate fails', async () => {
    const model = await check('a-link-leaves-a-ranked-group-through-its-frame');
    // link-1 turns off the stem by less than the clearance and rises; the stem is also link-2's run.
    const [stem, tread] = model.links.find(link => link.id === 'link-1')!.path!.segments;
    expect(model.frames!.map(frame => frame.id)).toEqual(['home']);
    expect(tread!.owner).toEqual(stem!.owner);
    expect(Math.abs(tread!.to.x - tread!.from.x)).toBeLessThan(10);
  }, 60000);

  it('a link into a child group is not walled out of the parent (finding 1)', async () => {
    const model = await check('a-link-from-a-parent-group-into-its-child');
    const link = model.links.find(item => item.id === 'link-1')!;
    // Both ends stand in the parent box by ancestry, so no run is extended out of it.
    const box = model.frames!.find(frame => frame.id === 'site')!.box;
    for (const end of link.sharedRuns?.from ?? []) {
      for (const point of [end.from, end.to]) expect(point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height).toBe(true);
    }
  }, 60000);

  it('two terminals on one row each keep an exit of their own (finding 3)', async () => {
    const model = await check('two-fans-leave-their-group-on-one-row', ['G6']);
    const box = model.groups.hub!.bounds!;
    // Each fan ends outside the group on the junction row, and the two exits stand on one y: bands of different owners are not one.
    const ends = model.links.flatMap(link => { const last = (link.sharedRuns?.from ?? []).at(-1); return last ? [{ id: link.id, to: last.to }] : []; })
      .filter(item => item.to.y > box.y && (item.to.x < box.x - 10 || item.to.x > box.x + box.width + 10));
    expect(ends.map(item => item.id).sort()).toEqual(['link-1', 'link-4']);
    expect(ends[0]!.to.y).toBe(ends[1]!.to.y);
  }, 60000);
});

const norm = (model: LayoutModel): string[] => (model.groupExits ?? []).map(item => JSON.stringify([item.from, item.to, item.exited, item.end])).sort();

/** The model as 7e leaves it before the exits: the exit runs and the promises taken off. */
function unexited(model: LayoutModel): LayoutModel {
  const copy = structuredClone(model);
  for (const exit of copy.groupExits ?? []) copy.links.find(link => link.id === exit.link)!.sharedRuns![exit.end]!.pop();
  delete copy.groupExits;
  copy.diagnostics = copy.diagnostics.filter(item => item.code !== 'GROUP_EXIT_BLOCKED');
  return copy;
}

describe('the exits are allocated together (architecture ticket 13, round 3)', () => {
  it('give the same exits when the links are listed in the other order', async () => {
    const model = await run(fixture('two-fans-leave-their-group-on-one-row'));
    expect((model.groupExits ?? []).length).toBe(2);
    const a = unexited(model), b = unexited(model);
    b.links.reverse();
    reserveGroupExits(a); reserveGroupExits(b);
    expect(norm(b)).toEqual(norm(a));
    expect(norm(a)).toEqual(norm(model));
  }, 60000);

  it('give the same exits when a sibling group closes the first direction of one of them', async () => {
    const model = await run(fixture('two-fans-leave-their-group-on-one-row'));
    const first = model.groupExits![0]!;
    const a = unexited(model);
    // A sibling box over the run the first choice of that exit takes: its candidates are no longer the other exit's.
    const box = { x: Math.min(first.from.x, first.to.x) - 2, y: first.from.y - 5, width: Math.abs(first.to.x - first.from.x) + 4, height: 10 };
    a.groups['low']!.bounds = box;
    const b = structuredClone(a);
    b.links.reverse();
    reserveGroupExits(a); reserveGroupExits(b);
    expect(norm(b)).toEqual(norm(a));
    // Never through the sibling, whatever each exit took.
    const margin = 10 + 1.25;
    for (const exit of a.groupExits ?? []) {
      const strip = { x: Math.min(exit.from.x, exit.to.x), y: Math.min(exit.from.y, exit.to.y), width: Math.abs(exit.to.x - exit.from.x), height: Math.abs(exit.to.y - exit.from.y) };
      expect(strip.x < box.x + box.width + margin && box.x - margin < strip.x + strip.width && strip.y < box.y + box.height + margin && box.y - margin < strip.y + strip.height).toBe(false);
    }
  }, 60000);

  it('refuses an exit with no free direction, as a typed placement error', async () => {
    const model = await run(fixture('a-claimed-run-clears-a-shared-run'));
    const a = unexited(model);
    const hub = a.groups['hub']!.bounds!;
    a.groups['low']!.bounds = { x: hub.x - 300, y: hub.y - 60, width: 700, height: 70 };
    reserveGroupExits(a);
    const refused = a.diagnostics.filter(item => item.code === 'GROUP_EXIT_BLOCKED');
    expect(refused.length + (a.groupExits ?? []).length).toBe((model.groupExits ?? []).length);
    for (const item of refused) expect(item.severity).toBe('error');
  }, 60000);

  it('reads nested frames by ancestry', async () => {
    const model = await run(fixture('a-child-frame-stands-inside-its-parent'));
    expect(standsIn(model, 'site', 'z1')).toBe(true);
    expect(standsIn(model, 'zone', 'z2')).toBe(true);
    expect(standsIn(model, 'zone', 'gw')).toBe(false);
    expect(standsIn(model, 'site', 'isp')).toBe(false);
  }, 60000);

  it('hands the route over outside the boxes it left: their margin is a wall for it', async () => {
    const model = await run(fixture('a-claimed-run-clears-a-shared-run'));
    const exit = model.groupExits![0]!;
    const obstacle = routeObstacles(model).find(item => item.id === `group:${exit.exited[0]}`)!;
    expect(obstacle.consumers).not.toContain(exit.link);
    const path = model.links.find(link => link.id === exit.link)!.path!.segments;
    for (const segment of path.slice(path.findIndex(item => item.to.x === exit.to.x && item.to.y === exit.to.y) + 1)) {
      expect(Math.min(segment.from.x, segment.to.x) < obstacle.bounds.x + obstacle.bounds.width && Math.max(segment.from.x, segment.to.x) > obstacle.bounds.x
        && Math.min(segment.from.y, segment.to.y) < obstacle.bounds.y + obstacle.bounds.height && Math.max(segment.from.y, segment.to.y) > obstacle.bounds.y).toBe(false);
    }
  }, 60000);

  it('guards the exit in a move: growing the exited box over its end is refused', async () => {
    const model = await run(fixture('a-claimed-run-clears-a-shared-run'));
    const exit = model.groupExits![0]!, group = model.groups[exit.exited[0]!]!, box = group.bounds!;
    expect(holdsMove(model, [{ group, bounds: box }], false, ['groupExit'])).toBe(true);
    const grown = { x: box.x - 30, y: box.y - 30, width: box.width + 60, height: box.height + 60 };
    expect(holdsMove(model, [{ group, bounds: grown }], false, ['groupExit'])).toBe(false);
  }, 60000);
});

describe('parallel links and the search cap (architecture ticket 13, round 4)', () => {
  /** The door fixture with a second link between the same two ports, labelled so the two differ in content only. */
  async function parallel(): Promise<LayoutModel> {
    const model = unexited(await run(fixture('a-claimed-run-clears-a-shared-run')));
    const first = model.links.find(link => link.id === 'link-1')!;
    const twin = structuredClone(first);
    twin.id = 'link-9'; twin.sourceIndex = model.document.links.length;
    model.document.links.push({ ...structuredClone(model.document.links[first.sourceIndex]!), label: 'beta' });
    model.document.links[first.sourceIndex] = { ...model.document.links[first.sourceIndex]!, label: 'alpha' };
    model.links.push(twin);
    return model;
  }
  const labelOf = (model: LayoutModel, id: string): string | undefined => model.document.links[model.links.find(link => link.id === id)!.sourceIndex]!.label;

  it('give the strip to the same link whichever way the links are listed', async () => {
    const a = await parallel(), b = await parallel();
    b.links.reverse();
    reserveGroupExits(a); reserveGroupExits(b);
    const kept = (model: LayoutModel): string[] => (model.groupExits ?? []).map(item => labelOf(model, item.link)!).sort();
    const refused = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'GROUP_EXIT_BLOCKED').flatMap(item => item.owners ?? []).map(owner => labelOf(model, (owner as { id: string }).id)!).sort();
    expect(kept(a).length + refused(a).length).toBe(2);
    expect(kept(b)).toEqual(kept(a));
    expect(refused(b)).toEqual(refused(a));
  }, 60000);

  it('names a search that hit its cap', async () => {
    const model = await parallel();
    reserveGroupExits(model, 2);
    const capped = model.diagnostics.filter(item => item.code === 'GROUP_EXIT_SEARCH_CAPPED');
    expect(capped.length).toBe(1);
    expect((capped[0]!.owners ?? []).length).toBeGreaterThanOrEqual(2);
  }, 60000);
});
