/**
 * The predicates of the placement inputs (`PlacementInputs`, dense-16x9 ticket 04, slice 3), one per field. Their readers are named in
 * `FIELD_CHECKS` (`reservations.ts`). The module imports nothing that reads a layout, so the restore tables can read it.
 */
import { stageReached, type LayoutModel } from '../model/layout.js';
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

/**
 * The solid blocks a placement recorded under the cap: the families of `blockReservations` with no `mode: 'flat'` (`reserveBlockGaps` decides the
 * mode from the 34 degree demand against `BLOCK_CAP`), sorted. The one reader of that fact for the leg pitch: `initial.ts` writes it as the placement
 * input `steepBlocks` from a complete placement, and stage 6 of every later run reads the input (`reservedBlockAngle`).
 */
export function steepFamilies(model: LayoutModel): string[] {
  return (model.blockReservations ?? []).filter(record => record.mode !== 'flat').map(record => record.family).sort();
}

/** The finding kind of a 7e transaction refused for a steep block it does not hold (`postconditions.ts`; `PostconditionRefusal`). */
export const STEEP_PREMISE = 'steepBlocks';

/**
 * The families of the input `steepBlocks` that the block records of `model` do not hold steep: a family with no record, or with `mode: 'flat'`
 * (dense-16x9 ticket 29, reviews 2 and 3). The one premise of the input, read wherever the record owner has run: the 7e postconditions (they
 * refuse a placement run that breaks it before publication, so the run the input came from and every later run hold it), the leg-pitch rounds of
 * `initial.ts` (their exit), and the restore of a model (`steepBlocksFault`).
 *
 * `recorded` says whether the record owner (`reserveBlockGaps`, stage 7e `bundles`) has run on the model: by default, whether the model has
 * completed 7e. The 7e postconditions judge the net draft before its stage is written, and pass `true`. Before 7e no record can stand and nothing
 * is compared. From 7e on an absent list is a record too: a placement that declined every solid block, or has none, holds no block steep, so it
 * holds none of the input (review 3).
 */
export function unheldSteepBlocks(model: LayoutModel, recorded = stageReached(model.stage, 'bundles')): string[] {
  if (model.steepBlocks === undefined || !recorded) return [];
  const steep = new Set(steepFamilies(model));
  return model.steepBlocks.filter(family => !steep.has(family));
}

/**
 * What a validator checks on `model.steepBlocks` (R5, dense-16x9 ticket 29): a sorted list of distinct family ids, not empty, each naming a solid
 * family of the model once the families stand, and, from 7e on, each held steep by its record (`unheldSteepBlocks`, reviews 2 and 3: the premise
 * of the 34 degree leg pitch, the same reader the 7e postconditions refuse a run by; an absent record list holds none). A model before 7e holds no
 * fact to compare: the families are checked where they stand, and the premise once the record owner has run (R6: what exists is checked).
 */
export function steepBlocksFault(model: LayoutModel): string | undefined {
  const record = model.steepBlocks;
  if (record === undefined) return undefined;
  if (!Array.isArray(record) || !record.length) return 'the steep blocks are recorded empty';
  if (record.some((item, index) => typeof item !== 'string' || (index > 0 && record[index - 1]! >= item))) return 'the steep blocks are unreadable or out of order';
  const solid = model.fanFamilies?.filter(family => family.kind === 'solid').map(family => family.id);
  if (solid !== undefined) {
    const stray = record.find(item => !solid.includes(item) && !model.declinedSolidBlocks?.some(declined => declined.family === item));
    if (stray !== undefined) return `the steep block ${stray} names no solid block`;
  }
  const unheld = unheldSteepBlocks(model);
  if (unheld.length) return `the steep block ${unheld[0]} is not recorded under the cap`;
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
