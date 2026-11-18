/**
 * The flat-gap choice (ADR-0025, amendments of 2026-11-16 and 2026-11-18; dense-16x9 tickets 04 and 42): the gaps of the flat solid blocks that
 * stand a placement nearest the aspect aim. One function for the first choice (`initial.ts`) and the final one (`driver.ts`), so the two
 * cannot differ (R1). Both read the sheet through `canvasExtent` (`link-labels.ts`).
 */
import type { BlockReservation, FlatBlockGap } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { aspectGap } from './aspect.js';
import { ASPECT_EPS } from './tolerance.js';

/** A sheet size, as `canvasExtent` reads it. */
export interface SheetSize { width: number; height: number }

/**
 * The flat gaps that move the sheet `size` toward the height W / aim, or `undefined` when no gap moves. `records` are the block records of
 * the placement read (`blockReservations`); `asked` is the flat-gap input that placement had (`env.flatBlockGaps`).
 * - A sheet lower than W / aim: the flat tier gaps share the missing height equally. Each tier gap can grow to the largest 34 degree demand
 *   of its flat blocks, and a gap that reaches its demand passes the rest of its share on.
 * - A sheet higher than W / aim: the tier gaps that an earlier choice raised (`asked`) share the excess height in the same way. Each can drop
 *   to the largest floor of its flat blocks. A tier gap that no choice raised stands at its mandatory height and cannot drop.
 * Placement clamps each asked gap to [the mandatory gap, the largest demand] of its tier gap (`reserveBlockGaps`); the caller keeps the result
 * only when the placement at those gaps stands nearer the aim (`nearerAim`).
 */
export function aspectFlatGaps(records: readonly BlockReservation[], size: SheetSize, aim: number, asked: readonly FlatBlockGap[] | undefined): FlatBlockGap[] | undefined {
  const flat = records.filter(record => record.mode === 'flat');
  if (!flat.length) return undefined;
  const missing = size.width / aim - size.height, sign = missing < 0 ? -1 : 1;
  let extra = Math.abs(missing);
  // The room of each flat tier gap toward the aim: up to its largest 34 degree demand, or down to its largest floor when a choice raised it.
  const room = new Map<number, number>();
  for (const record of flat) {
    const raised = asked?.some(item => item.family === record.family) === true;
    const reach = sign > 0 ? record.target - record.chosen : raised ? record.chosen - (record.floor ?? record.chosen) : 0;
    room.set(record.below, sign > 0 ? Math.max(room.get(record.below) ?? 0, reach) : Math.min(room.get(record.below) ?? Infinity, reach));
  }
  const open = [...room].filter(([, value]) => value > EPS).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const share = new Map<number, number>();
  for (const [index, [below, value]] of open.entries()) {
    const part = Math.min(value, extra / (open.length - index));
    share.set(below, part); extra -= part;
  }
  if (![...share.values()].some(value => value > EPS)) return undefined;
  return flat.map(record => ({ family: record.family, gap: record.chosen + sign * (share.get(record.below) ?? 0) }));
}

/** Whether the sheet `candidate` stands nearer the aspect aim than `earlier`, by more than `ASPECT_EPS`: the one judge of both flat-gap choices. */
export const nearerAim = (candidate: SheetSize, earlier: SheetSize, aim: number): boolean =>
  aspectGap(candidate.width, candidate.height, aim) < aspectGap(earlier.width, earlier.height, aim) - ASPECT_EPS;
