import { DEFAULT_ASPECT } from '../model/index.js';
import type { NormalisedDocument } from '../model/index.js';

/**
 * The aspect aim of a document (ADR-0025): the ratio W/H that a free placement choice aims at. `layout.aspect` when the author wrote one,
 * else 16:9. A soft aim, never a gate (stagger, lift and grid read it; the score does not).
 */
export const aspectAim = (document: Pick<NormalisedDocument, 'layout'>): number => document.layout?.aspect ?? DEFAULT_ASPECT;

/** The aspect gap of a box: `|ln((W/H) / aim)|`, 0 on the aim, Infinity for a box with no area. A candidate wins when its gap is smaller by more than `ASPECT_EPS`. */
export const aspectGap = (width: number, height: number, aim: number): number =>
  width > 0 && height > 0 ? Math.abs(Math.log(width / height / aim)) : Infinity;
