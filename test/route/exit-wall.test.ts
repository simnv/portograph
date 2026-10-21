import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
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
