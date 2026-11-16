import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { blockReservationsFault } from '../../src/layout/block-checks.js';
import { blockBoxPadsAsked, blockRowGapsAsked } from '../../src/layout/block-pads.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import type { LayoutModel } from '../../src/model/layout.js';
import type { LayoutOptions } from '../../src/pipeline/options.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 04, slice 3, step 2, review 1: the room rounds run to the fixed point and name what is left (finding 1); a forged room
// record is refused at early and at final restore (finding 2); the room of a hub frame is held by `deriveFrames` (the reviewer's frame probe).
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const lay = (source: string, options: Partial<LayoutOptions> = {}): Promise<LayoutModel> =>
  layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...options });
const straight = (model: LayoutModel): number => (model.fanAdmissions ?? []).filter(item => item.mode === 'straight').length;
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);

describe('the room rounds run to the fixed point (finding 1)', () => {
  it('gives a tall hub its row gap in as many placements as it takes, and every member stands straight', async () => {
    const model = await lay(fixture('a-tall-hub-takes-its-row-gap-at-the-fixed-point'));
    expect(straight(model)).toBe(14);
    expect(model.blockRowGaps?.map(item => [item.left, item.right])).toEqual([['core-a', 'core-b']]);
    // The fixed point: the published model asks for no more room than the records hold.
    expect(blockRowGapsAsked(model)).toEqual(model.blockRowGaps);
    expect(blockBoxPadsAsked(model)).toEqual(model.blockBoxPads);
    expect(codes(model)).not.toContain('BLOCK_ROOM_UNSETTLED');
  }, 180000);

  it('names the room still short when the bound runs out', async () => {
    // Three placements leave the row gap short (the reviewer's state: 1724.52 px held, 1735.04 px asked).
    const model = await lay(fixture('a-tall-hub-takes-its-row-gap-at-the-fixed-point'), { testBlockRoomBound: 3 });
    const note = model.diagnostics.find(item => item.code === 'BLOCK_ROOM_UNSETTLED');
    expect(note?.severity).toBe('warning');
    expect(note?.message).toMatch(/core-a to core-b gap \d+\.\d\d px/);
    expect(note?.owners).toEqual(expect.arrayContaining([{ kind: 'node', id: 'core-a' }, { kind: 'node', id: 'core-b' }]));
  }, 180000);
});

describe('a forged room record is refused at restore (finding 2)', () => {
  const forged = [
    ['blockBoxPads', [{ box: 'core', side: 'left', pad: -100 }]],
    ['blockRowGaps', [{ left: 'core-a', right: 'core-b', gap: -100 }]],
    ['blockBoxPads', [null]],
  ] as const;
  it.each(forged)('refuses %s %j on a model before the freeze', (field, record) => {
    const model = JSON.parse(JSON.stringify(sizeNodes(sidesOne(resolve(parse(fixture('a-flat-block-member-at-its-box-corner-takes-side-room'))))))) as Record<string, unknown>;
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    model[field] = record;
    expect(() => restoreLayoutModel(JSON.stringify(model))).toThrow(/placement input/);
  });
  it('refuses a forged record on a published model', async () => {
    const model = await lay(fixture('a-flat-block-member-at-its-box-corner-takes-side-room'));
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    for (const [field, record] of forged) {
      const copy = JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
      copy[field] = record;
      expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow(/placement input/);
    }
  }, 180000);
});

describe('the room of a hub frame (the reviewer\'s frame probe)', () => {
  it('widens the frame by its room on each side; a frame without it loses a member\'s box clearance, and restore refuses it', async () => {
    const model = await lay(fixture('a-flat-block-hub-frame-takes-side-room'));
    expect(straight(model)).toBe(14);
    const frame = model.frames!.find(item => item.id === 'core')!;
    const pads = model.blockBoxPads!.filter(item => item.box === 'core');
    expect(pads.map(item => item.side)).toEqual(['left', 'right']);
    const withoutRoom = { ...model };
    delete withoutRoom.blockBoxPads;
    const bare = deriveFrames(withoutRoom)!, unpadded = bare.find(item => item.id === 'core')!;
    expect(unpadded.box.x - frame.box.x).toBeCloseTo(pads[0]!.pad, 6);
    expect(frame.box.width - unpadded.box.width).toBeCloseTo(pads[0]!.pad + pads[1]!.pad, 6);
    const broken = { ...model, frames: bare };
    expect(blockReservationsFault(broken)).toMatch(/box clearance/);
    expect(() => restoreLayoutModel(JSON.stringify(broken))).toThrow();
  }, 180000);
});
