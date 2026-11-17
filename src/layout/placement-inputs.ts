/**
 * The predicates of the placement inputs (`PlacementInputs`, dense-16x9 ticket 04, slice 3), one per field. Their readers are named in
 * `FIELD_CHECKS` (`reservations.ts`). The module imports nothing that reads a layout, so the restore tables can read it.
 */
import type { LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';

/**
 * What a validator checks on `model.flatBlockGaps` (R5): one entry per family, each a finite gap of 0 or more. Where the block records stand
 * (`reserveBlockGaps`, from the placement stage that writes them): each entry names a flat record; the entries of one tier gap ask one value
 * (the aspect choice shares a gap, it never splits it); and each record honours its entry: its chosen gap stands within [its floor, the
 * demand of its tier gap] (the largest 34 degree target of the gap's flat blocks) and takes the asked gap as far as that demand allows
 * (`reserveBlockGaps` clamps the asked gap to the gap's floor and its demand). An entry of a block a later probe declined has no record.
 */
export function flatBlockGapsFault(model: LayoutModel): string | undefined {
  const record = model.flatBlockGaps;
  if (record === undefined) return undefined;
  if (!Array.isArray(record) || !record.length) return 'the flat block gaps are recorded empty';
  const seen = new Set<string>();
  for (const item of record) {
    if (typeof item !== 'object' || item === null || typeof item.family !== 'string' || !Number.isFinite(item.gap) || item.gap < 0) return 'a flat block gap is unreadable';
    if (seen.has(item.family)) return `the flat block gap of ${item.family} is recorded twice`;
    seen.add(item.family);
  }
  const records = model.blockReservations;
  if (records === undefined) return undefined;
  const asked = new Map<number, number>();
  for (const item of record) {
    const entry = records.find(candidate => candidate.family === item.family);
    // A block a later probe declined keeps its entry and has no record: `reserveBlockGaps` reads no entry without a block.
    if (entry === undefined && model.declinedSolidBlocks?.some(declined => declined.family === item.family)) continue;
    if (entry === undefined || entry.mode !== 'flat' || entry.floor === undefined) return `the flat block gap of ${item.family} names no flat block`;
    const before = asked.get(entry.below);
    if (before !== undefined && Math.abs(before - item.gap) > EPS) return `the flat block gaps of tier gap ${entry.below} differ`;
    asked.set(entry.below, item.gap);
  }
  for (const entry of records) {
    if (entry.mode !== 'flat' || !asked.has(entry.below)) continue;
    const demand = Math.max(...records.filter(other => other.below === entry.below && other.mode === 'flat').map(other => other.target));
    // The gap is shared: it stands at the floor of each record and at most at the largest 34 degree demand of the gap's flat blocks.
    if (entry.chosen + EPS < entry.floor! || entry.chosen > demand + EPS) return `the flat block ${entry.family} stands outside its floor and its demand`;
    if (entry.chosen + EPS < Math.min(asked.get(entry.below)!, demand)) return `the flat block ${entry.family} does not take its chosen gap`;
  }
  return undefined;
}

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
