import { DEFAULT_ASPECT } from '../model/index.js';
import type { NormalisedDocument } from '../model/index.js';

/**
 * The aspect aim of a document (ADR-0025): the ratio W/H that a free placement choice aims at. `layout.aspect` when the author wrote one,
 * else 16:9. A soft aim, never a gate (stagger, lift and grid read it; the score does not).
 */
export function aspectAim(document: Pick<NormalisedDocument, 'layout'>): number {
  const aim = document.layout?.aspect ?? DEFAULT_ASPECT;
  // A document built in code can carry any number: a bad aim would give NaN gaps and a silent floor choice (R6), so it throws, as `layout.maxWidth` does.
  if (!Number.isFinite(aim) || aim <= 0) throw new Error('layout.aspect must be positive and finite');
  return aim;
}

/** The aspect gap of a box: `|ln((W/H) / aim)|`, 0 on the aim, Infinity for a box with no area. A candidate wins when its gap is smaller by more than `ASPECT_EPS`. */
export const aspectGap = (width: number, height: number, aim: number): number =>
  width > 0 && height > 0 ? Math.abs(Math.log(width / height / aim)) : Infinity;
