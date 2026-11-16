import type { LayoutModel } from '../model/index.js';

/**
 * What a validator checks on `model.refusedChords` (R5), the chords the publication step refused (dense-16x9 ticket 14, slice 3): sorted, unique ids
 * of links, and, once the freeze is taken, no entry is a frozen chord (7f seeds its refusals from the record, so a refused chord falls back).
 * Before the freeze (the 7e replay input) the record only names links. One check for the round (`validateGroupLabelBands`, `validateRoutedPaths`)
 * and for restore (`restoreLayoutModel`, and `validateEarlyReservations` before `sides-two`), so a record that says 7f refused a chord the freeze held
 * stops at both (review 1 of slice 2, finding 3), and a malformed one stops on the early path too (review 2).
 */
export function refusedChordsFault(model: LayoutModel): string | undefined {
  const record = model.refusedChords as unknown;
  if (record === undefined) return undefined;
  if (!Array.isArray(record)) return 'the record is no list';
  const frozen = new Set(model.frozenChords ?? []);
  for (const [index, id] of (record as unknown[]).entries()) {
    if (typeof id !== 'string' || !model.links.some(link => link.id === id)) return `${String(id)} is no link`;
    if (index > 0 && (record as string[])[index - 1]! >= id) return `${id} is out of order or named twice`;
    if (frozen.has(id)) return `${id} is refused, but the freeze held it`;
  }
  return undefined;
}
