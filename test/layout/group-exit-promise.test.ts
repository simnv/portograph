import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GroupExit, LayoutModel } from '../../src/index.js';
import { layout, parse, serializeLayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import { exitNeeds, exitSide, reserveGroupExits } from '../../src/layout/group-exits.js';
import { groupExitViolations, missingGroupExits } from '../../src/layout/group-exit-check.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from './joint-off.js';

const fixture = (name: string): string => withoutJointOrder(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
const run = (name: string): Promise<LayoutModel> => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const copy = (model: LayoutModel): LayoutModel => JSON.parse(serializeLayoutModel(model)) as LayoutModel;
const key = (exit: { link: string; end: string }): string => `${exit.link}:${exit.end}`;

/** The model as the reservation read it: every reserved exit run taken off its shared run, the record kept as the held promise. */
function preExit(model: LayoutModel, frozen: boolean): LayoutModel {
  const view = copy(model);
  for (const exit of view.groupExits ?? []) view.links.find(link => link.id === exit.link)!.sharedRuns![exit.end]!.pop();
  if (!frozen && view.freeze !== undefined) delete view.freeze.placement;
  return view;
}
/** The exit `exit` turned to leave by `side`, with the same length. */
function turned(exit: GroupExit, side: 'top' | 'bottom' | 'left' | 'right'): GroupExit {
  const length = Math.abs(exit.to.x - exit.from.x) + Math.abs(exit.to.y - exit.from.y);
  const [dx, dy] = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }[side];
  return { ...exit, to: { x: exit.from.x + dx! * length, y: exit.from.y + dy! * length } };
}
/** Remove the reserved exit `exit` from a published model: its record and its run. */
function withoutExit(model: LayoutModel, exit: GroupExit): LayoutModel {
  const forged = copy(model);
  forged.groupExits = forged.groupExits!.filter(item => key(item) !== key(exit));
  if (!forged.groupExits.length) delete forged.groupExits;
  forged.links.find(link => link.id === exit.link)!.sharedRuns![exit.end]!.pop();
  return forged;
}
const blocked = (link: string) => ({ stage: 'placement' as const, severity: 'error' as const, code: 'GROUP_EXIT_BLOCKED', owners: [{ kind: 'link' as const, id: link }], message: `${link} has no free direction (forged)` });

describe('the group exit is a held promise (DR-11)', () => {
  it('a held direction stays while it is free; only the coordinates are derived again', async () => {
    const model = await run('a-link-leaves-its-group-through-a-door');
    const exits = model.groupExits!;
    expect(exits.length).toBeGreaterThan(0);
    // Without a promise the derivation gives the published exits; with the published promise it gives them again.
    const fresh = preExit(model, false);
    delete fresh.groupExits;
    reserveGroupExits(fresh);
    expect(fresh.groupExits).toEqual(exits);
    const held = preExit(model, false);
    reserveGroupExits(held);
    expect(held.groupExits).toEqual(exits);
    // A promise of another free direction is kept, though the derivation alone would rank it lower.
    let kept = 0, refusedSide: { exit: GroupExit; side: 'top' | 'bottom' | 'left' | 'right' } | undefined;
    for (const exit of exits) for (const side of (['top', 'bottom', 'left', 'right'] as const).filter(item => item !== exitSide(exit))) {
      const trial = preExit(model, false);
      trial.groupExits = trial.groupExits!.map(item => key(item) === key(exit) ? turned(item, side) : item);
      reserveGroupExits(trial);
      const now = trial.groupExits?.find(item => key(item) === key(exit));
      if (now !== undefined && exitSide(now) === side) kept++;
      else refusedSide ??= { exit, side };
    }
    expect(kept, 'no held direction other than the first-ranked one is free on this sheet').toBeGreaterThan(0);
    // A held direction that is not free is a replan: allowed before the final freeze, refused after it.
    expect(refusedSide).toBeDefined();
    const frozen = preExit(model, true);
    expect(frozen.freeze?.placement).toBeDefined();
    frozen.groupExits = frozen.groupExits!.map(item => key(item) === key(refusedSide!.exit) ? turned(item, refusedSide!.side) : item);
    expect(() => reserveGroupExits(frozen)).toThrow(/cannot be replanned after the final freeze/);
  }, 120000);

  it('a required exit that is missing fails the geometric check with GROUP_EXIT_BLOCKED absent or forged (R5)', async () => {
    const model = await run('a-hemmed-fan-branch-keeps-its-stem');
    expect(missingGroupExits(model)).toEqual([]);
    expect(groupExitViolations(model)).toEqual([]);
    const exit = model.groupExits![0]!;
    const absent = withoutExit(model, exit);
    expect(absent.diagnostics.some(item => item.code === 'GROUP_EXIT_BLOCKED')).toBe(false);
    expect(missingGroupExits(absent)).toContainEqual({ link: exit.link, end: exit.end });
    const forged = withoutExit(model, exit);
    forged.diagnostics.push(blocked(exit.link));
    expect(missingGroupExits(forged)).toContainEqual({ link: exit.link, end: exit.end });
    // Publication, the second boundary, refuses the forged model too.
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow();
  }, 120000);

  it('a blocked exit is the advisory outcome: the geometry proves it, with or without its diagnostic', async () => {
    const model = await run('a-canton-column-is-not-pulled-into-a-flank');
    expect(model.diagnostics.some(item => item.code === 'GROUP_EXIT_BLOCKED')).toBe(true);
    const reserved = new Set((model.groupExits ?? []).map(key));
    const view = preExit(model, false);
    expect(exitNeeds(view).filter(need => !reserved.has(key({ link: need.link.id, end: need.end }))).length).toBeGreaterThan(0);
    expect(missingGroupExits(model)).toEqual([]);
    const silent = copy(model);
    silent.diagnostics = silent.diagnostics.filter(item => item.code !== 'GROUP_EXIT_BLOCKED');
    expect(missingGroupExits(silent)).toEqual([]);
  }, 120000);
});
