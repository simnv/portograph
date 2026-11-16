import { expect, it } from 'vitest';
import { takenTrial } from '../../src/pipeline/initial.js';
import type { LayoutModel } from '../../src/model/layout.js';

// The 7f trial the stagger gate ran is taken for the flat-gap floor trial of the same frozen placement (dense-16x9 ticket 21).
const placed = (): LayoutModel => Object.freeze({ stage: 'bundles' }) as unknown as LayoutModel;
const banded = { stage: 'bands' } as unknown as LayoutModel;

it('takes the trial that ran on the same frozen model, a refusal as no banded model', () => {
  const model = placed();
  expect(takenTrial({ model, banded }, model)).toEqual({ banded });
  expect(takenTrial({ model, banded }, model)!.banded).toBe(banded);
  expect(takenTrial({ model, banded: new Error('refused') }, model)).toEqual({ banded: undefined });
});

it('runs the trial when none ran, when it ran on another model, or when the model is not frozen', () => {
  const model = placed();
  expect(takenTrial(undefined, model)).toBeUndefined();
  // Another model object with the same content: the identity is the key, so a copy is a miss.
  expect(takenTrial({ model: placed(), banded }, model)).toBeUndefined();
  const open = { stage: 'bundles' } as unknown as LayoutModel;
  expect(takenTrial({ model: open, banded }, open)).toBeUndefined();
});
