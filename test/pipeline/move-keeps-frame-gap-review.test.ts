import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as readYaml, stringify as writeYaml } from 'yaml';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { resolve } from '../../src/resolve/index.js';
import { holdColumnsAfterPush } from '../../src/layout/bands.js';
import { derivedShortfalls, worseSeparations } from '../../src/layout/constraints/separation.js';
import { deriveFrames, FRAME_TO_FRAME_GAP } from '../../src/layout/frames.js';
import { lanes } from '../../src/layout/lanes.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { rows } from '../../src/layout/rows.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sidesTwo } from '../../src/layout/sides-two.js';
import { sizeNodes } from '../../src/layout/size.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 48, review 1: a move reads the separations of every unit it does not move.
// - stage 5: the chain of units that gives way to a frame a held lane grew carries the flanks of its groups, is bounded by every unit it does
//   not move (a grid, a unit that holds a lane source), and commits whole or not at all;
// - 7f: the pack of the beside rows reads the gaps a canton owns, and its warning goes when a later pack finds the child packed.
type Sheet = { groups: Record<string, Record<string, unknown>>; nodes: Record<string, Record<string, unknown>>; links: unknown[]; layout?: Record<string, unknown> };
const sheet = (name: string): Sheet => readYaml(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')) as Sheet;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** The model after the lanes stage (7a), and the reading of the separations before it (after the rows rule). */
const throughLanes = async (input: Sheet): Promise<{ before: ReturnType<typeof derivedShortfalls>; after: ReturnType<typeof derivedShortfalls>; model: LayoutModel }> => {
  const model = sizeNodes(sidesOne(resolve(parse(writeYaml(input)))));
  await skeleton(model, { createAttempt });
  const placed = rows(sidesTwo(model)), before = derivedShortfalls(clone(placed));
  const done = lanes(placed);
  return { before, after: derivedShortfalls(clone(done)), model: done };
};
const reversed = (input: Sheet): Sheet => ({ ...input, nodes: Object.fromEntries(Object.entries(input.nodes).reverse()) });
const withSeats = (input: Sheet, on: boolean): Sheet => ({ ...input, layout: { ...(input.layout ?? {}), moveBeforeGrow: on } });

describe('a chain of units that gives way to a grown frame reads every unit it does not move (dense-16x9 ticket 48, review 1)', () => {
  // A flank beside `midc`: it goes with the group it flanks, so the chain moves `midc`, `mid` and the flank together and no gap stays short.
  // Before the fix the chain moved `midc` and `mid` alone and the gap of the flank to `mid` fell 18.76 px short.
  const flanked = (): Sheet => {
    const input = sheet('a-held-lane-is-reserved-before-a-foreign-lane');
    input.groups.extra = { align: 'left', of: 'midc' };
    input.nodes.x = { group: 'extra' };
    return input;
  };
  for (const [form, on] of [['as written', true], ['nodes reversed', true], ['nodes reversed', false]] as const) {
    it(`a flank moves with the group it flanks: ${form}, moveBeforeGrow ${on}`, async () => {
      const input = withSeats(flanked(), on), run = await throughLanes(form === 'as written' ? input : reversed(input));
      expect([...run.after.keys()]).toEqual([]);
      const moved = run.model.diagnostics.filter(item => item.code === 'LANE_FRAME_GAP_KEPT').flatMap(item => item.owners ?? []).map(owner => 'id' in owner ? owner.id : '');
      expect(moved.sort()).toEqual(['extra', 'mid', 'midc']);
    }, 60000);
  }

  // `westg` also links to `l2`. The chain beyond `west` reaches `east`, which holds a lane source and cannot move: no unit of the chain moves
  // (before the fix `midc` and `mid` moved 52.76 px and the gap of `east` to `mid` fell short by as much), and the warning names what stays short.
  it('a blocked chain commits nothing it cannot take whole', async () => {
    for (const on of [false, true]) {
      const input = withSeats(sheet('a-refused-reseat-restores-its-frames'), on);
      input.links.push(['westg', 'l2']);
      const run = await throughLanes(input);
      expect(worseSeparations(run.after, run.before).filter(id => !run.after.get(id)!.owners.includes('frame:west'))).toEqual([]);
      expect(run.model.diagnostics.filter(item => item.code === 'LANE_FRAME_GAP_KEPT')).toEqual([]);
      expect(run.model.diagnostics.filter(item => item.code === 'LANE_FRAME_GAP_HELD').map(item => item.message)).toEqual([
        'midc stays 52.76 px nearer than the beside gap to frame west, which a lane it holds grew: east cannot move (it holds a lane source, stands in a sub-tier no link crosses or would reach a reserved lane).',
      ]);
    }
  }, 120000);

  // A grid group of the tier stands fixed. With the nodes reversed the chain beyond `east` reaches `west`, which holds a lane source; no unit moves
  // into the grid or toward it.
  it('a grid bounds the room of the chain, nodes reversed', async () => {
    const input = withSeats(sheet('a-refused-reseat-restores-its-frames'), true);
    input.groups.extra = { tier: 1, shape: 'grid' };
    input.nodes.x = { group: 'extra', size: { width: 32, height: 50 } };
    input.nodes.y = { group: 'extra' };
    input.links.push(['u0', 'x'], ['y', 'l1']);
    const run = await throughLanes(reversed(input));
    expect(worseSeparations(run.after, run.before).filter(id => !run.after.get(id)!.owners.includes('frame:east'))).toEqual([]);
    expect(run.model.diagnostics.filter(item => item.code === 'LANE_FRAME_GAP_KEPT')).toEqual([]);
  }, 60000);
});

describe('the slot of a held lane reads the gaps its frame would leave short (dense-16x9 ticket 48, review 2)', () => {
  // The grid variant with `midg` also linked to `l1`: two slots of link-11 stand at one offset from its source and move no cell. Before the fix both read
  // as clear and the first won; there frame `mid` stands 18.76 px nearer than the beside gap to the fixed grid `extra`, a gap no chain asks for.
  const input = (): Sheet => {
    const base = withSeats(sheet('a-refused-reseat-restores-its-frames'), true);
    base.groups.extra = { tier: 1, shape: 'grid' };
    base.nodes.x = { group: 'extra', size: { width: 32, height: 50 } };
    base.nodes.y = { group: 'extra' };
    base.links.push(['u0', 'x'], ['y', 'l1'], ['midg', 'l1']);
    return base;
  };
  for (const form of ['as written', 'nodes reversed'] as const) {
    it(`takes the slot that keeps the gap to a fixed grid: ${form}`, async () => {
      const yaml = writeYaml(form === 'as written' ? input() : reversed(input()));
      const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
      const gates = score(model).snapshot.gates;
      expect(gates.G9.violations.map(item => item.message)).toEqual([]);
      expect(Object.entries(gates).filter(([, gate]) => !gate.passed && gate.severity === 'error').map(([id]) => id)).toEqual([]);
    }, 120000);
  }
});

describe('the 7f pack of the beside rows (dense-16x9 ticket 48, review 1)', () => {
  /** The grid sheet after the rows rule: the frames, the child frame `d-zone` of `d`, and the fixed grid `spares`. */
  const placed = async (canton: boolean, members: readonly string[] = ['d']): Promise<LayoutModel> => {
    const input = withSeats(sheet('a-grid-group-stands-fixed-beside-frames'), true);
    if (canton) { input.groups.town = { label: 'Town' }; for (const id of members) input.groups[id] = { ...input.groups[id], canton: 'town' }; }
    const model = sizeNodes(sidesOne(resolve(parse(writeYaml(input)))));
    await skeleton(model, { createAttempt });
    return clone(rows(sidesTwo(model)));
  };
  const shift = (model: LayoutModel, id: string, dx: number): void => {
    const group = model.groups[id]!;
    moveGroup(model, group, dx, 0);
    rebuildNodeGeometry(model, group.nodes, 'current');
  };
  const box = (model: LayoutModel, id: string) => deriveFrames(model)!.find(frame => frame.id === id)!.box;
  /** The child `d-zone` stands 50 px off its packed place, and the grid stands 80 px (the root band gap) before the outer frame. */
  const staged = (model: LayoutModel, outer: string): void => {
    for (const group of Object.values(model.groups).filter(item => item.frame === 'd-zone')) shift(model, group.id, 50);
    const grid = model.groups.spares!;
    shift(model, 'spares', box(model, outer).x - grid.bounds!.width - 80 - grid.bounds!.x);
  };
  const held = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === 'FRAME_PACK_SEPARATION_HELD').map(item => item.message);

  it('refuses a pack that breaks a separation, keeps the boxes, and drops the warning once the child stands packed', async () => {
    const model = await placed(false);
    staged(model, 'd');
    const before = derivedShortfalls(model), cells = Object.values(model.groups).filter(item => item.frame === 'd-zone').map(item => item.id);
    const boxes = clone(cells.map(id => model.groups[id]!.bounds));
    holdColumnsAfterPush(model);
    expect(worseSeparations(derivedShortfalls(model), before)).toEqual([]);
    expect(held(model)).toHaveLength(1);
    expect(held(model)[0]).toMatch(/^Frame d-zone stays 50 px from its packed place: the move would break or deepen the minimum separation separation-root/);
    expect(cells.map(id => model.groups[id]!.bounds)).toEqual(boxes);
    // The grid moves clear and the child stands at its packed place: a later pack moves nothing and the warning goes.
    shift(model, 'spares', -500);
    for (const id of cells) shift(model, id, -50);
    holdColumnsAfterPush(model);
    expect(held(model)).toEqual([]);
  }, 60000);

  // Review 2: `c` and `d` stand in one canton, frame `c` exactly the sibling gap before frame `d`. The pack of `d-zone` toward the cells of `d` would grow
  // `d` 33.11 px into that gap (6.89 px left); the pack sets the gaps of its own row only, and the sibling's gap is kept.
  it('keeps the gap of a sibling frame in a canton', async () => {
    const model = await placed(true, ['c', 'd']);
    for (const group of Object.values(model.groups).filter(item => item.frame === 'd-zone')) shift(model, group.id, 50);
    const c = box(model, 'c'), d = box(model, 'd');
    for (const group of Object.values(model.groups).filter(item => item.frame === 'c' || item.frame === 'c-zone')) shift(model, group.id, d.x - FRAME_TO_FRAME_GAP - c.x - c.width);
    const before = derivedShortfalls(model);
    expect([...before.keys()]).not.toContain('separation-frame-frames:frame:c|frame:d');
    holdColumnsAfterPush(model);
    expect(worseSeparations(derivedShortfalls(model), before)).toEqual([]);
    expect(held(model)).toHaveLength(1);
    expect(held(model)[0]).toMatch(/^Frame d-zone stays 33.11 px from its packed place: the move would break or deepen the minimum separation separation-frame-frames:frame:c\|frame:d\.$/);
  }, 60000);

  it('reads the gaps a canton owns', async () => {
    const model = await placed(true);
    staged(model, 'town');
    const before = derivedShortfalls(model);
    holdColumnsAfterPush(model);
    expect(worseSeparations(derivedShortfalls(model), before)).toEqual([]);
    expect(held(model)).toHaveLength(1);
  }, 60000);
});
