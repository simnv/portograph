import { describe, expect, it } from 'vitest';
import type { Diagnostic, LayoutModel } from '../../src/model/layout.js';
import { adoptSettled } from '../../src/layout/placement-attempt.js';

// Architecture ticket 13, phase 2: a draft that takes a settled copy must end with the diagnostics a replay of the draft would give, in the same order.
// A replay filters the list (a withdrawn warning) and appends to it, so the test stands a model-shaped object and a replay of that kind, and compares.
const note = (code: string, message = code): Diagnostic => ({ stage: 'placement', severity: 'warning', code, message });
const codes = (list: readonly Diagnostic[]): string[] => list.map(item => `${item.code}:${item.message}`);
type Model = LayoutModel & Record<string, unknown>;
const model = (diagnostics: Diagnostic[], extra: Record<string, unknown> = {}): Model => ({ diagnostics, ...extra }) as unknown as Model;
const clone = (value: Model): Model => JSON.parse(JSON.stringify(value)) as Model;

/** A replay in the manner of `alignLinkedGroupGridAndPack` and `produceGroupLabelBands`: withdraw one code, raise it again with a new message, add one more. */
function replay(target: Model, withdraw: string | undefined): void {
  if (withdraw !== undefined) {
    target.diagnostics = target.diagnostics.filter(item => item.code !== withdraw);
    target.diagnostics.push(note(withdraw, 'raised again'));
  }
  target.diagnostics.push(note('REPLAY_NEW'));
  delete target.busBands;
}
/** Settle a copy of the draft, let the draft gain `added`, adopt; and compare with the draft replayed directly. */
function run(prefix: Diagnostic[], added: Diagnostic[], withdraw: string | undefined) {
  const draft = model([...prefix], { busBands: [1] });
  const copy = clone(draft);
  const original = new Set(copy.diagnostics);
  replay(copy, withdraw);
  draft.diagnostics.push(...added);
  const direct = clone(draft);
  replay(direct, withdraw);
  const taken = adoptSettled(draft, copy, prefix.length, original);
  return { taken, draft, direct };
}

describe('the draft takes a settled copy only when the replay would give the same diagnostics', () => {
  it('takes the copy\'s list when the draft added nothing, whatever the replay withdrew', () => {
    const { taken, draft, direct } = run([note('KEEP'), note('MESH_BUS_RISER_KEEP_OUT'), note('LAST')], [], 'MESH_BUS_RISER_KEEP_OUT');
    expect(taken).toBe(true);
    expect(codes(draft.diagnostics)).toEqual(codes(direct.diagnostics));
    expect(codes(draft.diagnostics)).toEqual(['KEEP:KEEP', 'LAST:LAST', 'MESH_BUS_RISER_KEEP_OUT:raised again', 'REPLAY_NEW:REPLAY_NEW']);
  });

  it('puts what the draft added after the survivors and before what the replay raised', () => {
    const { taken, draft, direct } = run([note('KEEP'), note('LAST')], [note('RANK_STEPPED_OFF_CHORD')], undefined);
    expect(taken).toBe(true);
    expect(codes(draft.diagnostics)).toEqual(codes(direct.diagnostics));
    expect(codes(draft.diagnostics)).toEqual(['KEEP:KEEP', 'LAST:LAST', 'RANK_STEPPED_OFF_CHORD:RANK_STEPPED_OFF_CHORD', 'REPLAY_NEW:REPLAY_NEW']);
  });

  it('declines when the replay withdrew a warning and the draft added one: the replay runs instead', () => {
    const { taken, draft } = run([note('KEEP'), note('GROUP_GRID_NON_CONVERGENCE')], [note('RANK_STEPPED_OFF_CHORD')], 'GROUP_GRID_NON_CONVERGENCE');
    expect(taken).toBe(false);
    expect(codes(draft.diagnostics)).toEqual(['KEEP:KEEP', 'GROUP_GRID_NON_CONVERGENCE:GROUP_GRID_NON_CONVERGENCE', 'RANK_STEPPED_OFF_CHORD:RANK_STEPPED_OFF_CHORD']);
    expect(draft.busBands).toEqual([1]);
  });

  it('declines when an added warning has a code the replay reads or raises', () => {
    expect(run([note('KEEP')], [note('MESH_BUS_TITLE_ON_STUB')], undefined).taken).toBe(false);
    expect(run([note('KEEP')], [note('REPLAY_NEW', 'other')], undefined).taken).toBe(false);
  });

  it('deletes a key the copy deleted', () => {
    const { taken, draft } = run([note('KEEP')], [], undefined);
    expect(taken).toBe(true);
    expect('busBands' in draft).toBe(false);
  });
});
