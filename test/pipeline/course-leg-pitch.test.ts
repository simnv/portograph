import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { pairPitchFault } from '../../src/layout/pair-pitch.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import { courseLegPitchFault, courseLegPitches, reservedBlockAngle } from '../../src/layout/solid-blocks.js';
import { BLOCK_ANGLE, BLOCK_FLOOR_ANGLE } from '../../src/layout/block-checks.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

// Dense-16x9 ticket 29: a u-turn course port on a face with solid-block member ports keeps the `leg` pair pitch at which a member chord at the
// angle its block reserves passes the tip of the course's stem. On main 906de428 the member beside the course port stood 21 px from it, its
// chord crossed the U's stem, and 8 of the 12 block members fell back.
const yaml = readFileSync(new URL('../../goldens/synthetic/a-u-course-port-keeps-the-pitch-a-block-chord-needs-past-its-stem.yaml', import.meta.url), 'utf8');
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const legs = (model: LayoutModel): { node: string; min: number }[] => Object.values(model.nodes)
  .flatMap(node => (['top', 'bottom'] as const).flatMap(side => (node.pairPitch?.[side] ?? []).filter(entry => entry.rule === 'leg').map(entry => ({ node: node.id, min: entry.min }))));
const orthogonalMembers = (model: LayoutModel): string[] => (model.fanAdmissions ?? []).filter(item => item.mode === 'orthogonal').map(item => item.link);

describe('a u-turn course port keeps the pitch a block chord needs past its stem (dense-16x9 ticket 29)', () => {
  it('reserves a leg pitch on each course port and keeps every block member straight', async () => {
    const model = await run(yaml);
    const course = (model.courses ?? []).find(item => item.kind === 'u-turn');
    expect(course?.from.face).toBe('top');
    expect(legs(model)).toEqual([{ node: 'a-hub-1', min: 43 }, { node: 'b-hub-1', min: 43 }]);
    expect((model.fanAdmissions ?? []).length).toBe(12);
    expect(orthogonalMembers(model)).toEqual([]);
    expect(courseLegPitchFault(model)).toBeUndefined();
  }, 180000);

  it('keeps every member straight with the nodes or the links declared the other way round (R3)', async () => {
    for (const part of ['nodes', 'links'] as const) {
      const model = await run(reversed(yaml, part));
      expect(orthogonalMembers(model)).toEqual([]);
      expect(legs(model).map(item => item.min)).toEqual([43, 43]);
    }
  }, 360000);

  it('refuses a forged, a missing or a stray leg pitch at restore (R5: the validator reads the producer)', async () => {
    const model = await run(yaml);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    const forge = (change: (copy: LayoutModel) => void): string => { const copy = JSON.parse(JSON.stringify(model)) as LayoutModel; change(copy); return JSON.stringify(copy); };
    const leg = (copy: LayoutModel, node: string) => copy.nodes[node]!.pairPitch!.top!.find(entry => entry.rule === 'leg')!;
    expect(() => restoreLayoutModel(forge(copy => { leg(copy, 'a-hub-1').min = 30; }))).toThrow(/a-hub-1 has a leg pitch of 30 px on top, not 43 px/);
    expect(() => restoreLayoutModel(forge(copy => { copy.nodes['a-hub-1']!.pairPitch!.top = copy.nodes['a-hub-1']!.pairPitch!.top!.filter(entry => entry.rule !== 'leg'); })))
      .toThrow(/a-hub-1 lacks the leg pitch of its course port on top/);
    expect(() => restoreLayoutModel(forge(copy => {
      const port = copy.nodes['a-hub-2']!.ports.find(item => item.side === 'top')!;
      copy.nodes['a-hub-2']!.pairPitch!.top!.push({ rule: 'leg', ports: [portId(port.ref)], min: 43 });
    }))).toThrow(/a-hub-2 has a leg pitch on top that no course port asks for/);
  }, 180000);

  it('reads a leg entry as one port that binds both neighbours', () => {
    const node = { id: 'n', ports: [{ ref: { node: 'n', name: 'p', ordinal: 1 } }], pairPitch: { top: [{ rule: 'leg', ports: ['port:["n",false,"p",1]'], min: 43 }] } };
    expect(pairPitchFault(node as never)).toBeUndefined();
    expect(pairPitchFault({ ...node, pairPitch: { top: [{ rule: 'leg', ports: [], min: 43 }] } } as never)).toMatch(/unreadable/);
  });

  it('takes the floor angle for a flat block, whose leg pitch passes the cap and is not reserved', async () => {
    const model = await run(yaml);
    const family = model.fanFamilies!.find(item => item.kind === 'solid')!.id;
    expect(reservedBlockAngle(model, family)).toBe(BLOCK_ANGLE);
    const flat = { ...model, flatBlockGaps: model.fanFamilies!.filter(item => item.kind === 'solid').map(item => ({ family: item.id, gap: 300 })) } as LayoutModel;
    expect(reservedBlockAngle(flat, family)).toBe(BLOCK_FLOOR_ANGLE);
    // At 15 degrees the pitch is about 100 px, past the 60 px cap of a face pair: the face keeps its pitch and the member falls back by name.
    expect(courseLegPitches(flat)).toEqual([]);
    expect(courseLegPitches(model).map(([node, , entry]) => [node, entry.min])).toEqual([['a-hub-1', 43], ['b-hub-1', 43]]);
  }, 180000);
});
