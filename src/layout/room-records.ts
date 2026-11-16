/**
 * The predicates of the room records (dense-16x9 ticket 04, slice 3, step 2): the placement inputs `model.blockBoxPads` and `model.blockRowGaps`
 * (`block-pads.ts` reads them), one per field. Their readers are named in `FIELD_CHECKS` (`reservations.ts`). The module imports types only, so
 * the restore tables can read it.
 */
import type { LayoutModel } from '../model/layout.js';

/** What a validator checks on `model.blockBoxPads` (R5): sorted by box then side, one entry per pair, a finite positive pad. */
export function blockBoxPadsFault(model: LayoutModel): string | undefined {
  const record = model.blockBoxPads;
  if (record === undefined) return undefined;
  if (!Array.isArray(record) || !record.length) return 'the block box paddings are recorded empty';
  for (const [index, item] of record.entries()) {
    if (typeof item !== 'object' || item === null) return 'a block box padding is unreadable';
    if (typeof item.box !== 'string' || (item.side !== 'left' && item.side !== 'right') || !Number.isFinite(item.pad) || item.pad <= 0) return `the block box padding of ${item.box} is unreadable`;
    const previous = record[index - 1];
    if (previous !== undefined && (previous.box > item.box || (previous.box === item.box && previous.side >= item.side))) return 'the block box paddings are out of order';
  }
  return undefined;
}

/** What a validator checks on `model.blockRowGaps` (R5): sorted by the left node then the right one, one entry per pair, a finite positive gap. */
export function blockRowGapsFault(model: LayoutModel): string | undefined {
  const record = model.blockRowGaps;
  if (record === undefined) return undefined;
  if (!Array.isArray(record) || !record.length) return 'the block row gaps are recorded empty';
  for (const [index, item] of record.entries()) {
    if (typeof item !== 'object' || item === null) return 'a block row gap is unreadable';
    if (typeof item.left !== 'string' || typeof item.right !== 'string' || !Number.isFinite(item.gap) || item.gap <= 0) return `the block row gap of ${item.left} and ${item.right} is unreadable`;
    const previous = record[index - 1];
    if (previous !== undefined && (previous.left > item.left || (previous.left === item.left && previous.right >= item.right))) return 'the block row gaps are out of order';
  }
  return undefined;
}
