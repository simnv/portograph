import type { Side } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { faceKey } from './turn-order.js';
import { guardRoutedTrialKind, trialCounts, unifiedOrder, type UnifiedTally } from './turn-measure.js';
import type { FarEndDeclineReason } from './reservations.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { proposeFarEndOrder, staleFaces, type FarEndFace, type FarEndProposal } from './far-end-order.js';
import type { FarEndDecisionEntry } from './far-end-faults.js';

/**
 * The far-end round (dense-16x9 ticket 07): the offer and the judge. The offer is the order of the ports of every face that fails G5 on the published geometry of a
 * completed placement, read from the final far ends (`proposeFarEndOrder`). The trial reserves it, places again (a fresh stage 5 seats it, every later stage re-reserves around it),
 * and the judge keeps the trial only when the final ranges agree.
 */

/** The proposal on the kept result; `decisions` are the far-end decisions the command holds (default: those of the model's ledger, `readFace`). */
export const measureFarEndOrder = (routedBase: LayoutModel, decisions?: ReadonlyMap<string, FarEndDecisionEntry>): FarEndProposal => proposeFarEndOrder(routedBase, [], decisions);

export interface FarEndVerdict {
  kept: boolean;
  reason: string;
  /** The trial left a proposed face stale: the proposal read from the trial's own final positions (the settled faces kept), for the next trial of the round. */
  next?: FarEndFace[];
  /** The faces that fail G5 on the baseline and on the trial. */
  before?: number;
  after?: number;
  /** The published canvas of the baseline and of the kept trial, when the trial grows it (named in the note of a kept trial). */
  canvas?: { from: { width: number; height: number }; to: { width: number; height: number } };
  /**
   * The clause that refused a trial: `unified` (worse by the unified order), `guard` (a guard of the routed trial), `fresh` (a face the baseline had in
   * order is out of order on the trial) or `open` (the final far ends disagree with the proposed order).
   */
  clause?: 'unified' | 'guard' | 'fresh' | 'open';
  /**
   * The refusal as a decision of the whole-sheet measure (dense-16x9 ticket 49, review 1), when it is one: a completed comparison worse by the unified order
   * (`unified`, with both tallies), a new error-gate finding of the routed trial (`gate-finding`) or the canvas cap (`canvas-cap`). Any other refusal
   * (an unscored trial, a removed link, a guard of courses, walls, constraints or separations, a fresh face, an open face) decides nothing.
   */
  decline?: FarEndDeclineReason;
  /** The tallies of the baseline and of the trial, when both score. */
  tallies?: { base: UnifiedTally; trial: UnifiedTally };
}

/**
 * The most the published canvas may grow, as a ratio of its area, for a trial that settles a face (dense-16x9 ticket 07 review): a port order is a gate, and the gates outrank the canvas
 * in `gate:compare`, but a new order that doubles the sheet is no repair. 1.25 admits the 1.15 and 1.08 of the two corpus sheets that widen by a body or a gap, and nothing larger is measured.
 * The growth that is kept is named in the note of the kept trial.
 */
export const FAR_END_CANVAS_GROWTH = 1.25;

/** What a canvas reader answers: the published canvas of a routed model (stage 9 refits it with the labels and the legend), or `undefined` when it has none. */
export type PublishedCanvas = (model: LayoutModel) => { width: number; height: number } | undefined;

const names = (faces: readonly { node: string; side: Side }[]): Set<string> => new Set(faces.map(face => faceKey(face.node, face.side)));

/**
 * The judge of a far-end trial. Kept only when: no face fails G5 on the trial that did not fail on the baseline; the guards every judged re-run holds (`guardRoutedTrial`: no removed
 * link, no new gate or constraint finding, no broken separation, no kept course over its turns, no larger canvas); the published result is not worse by the unified order (bent links,
 * turns, crossings): the repair buys a port order, and may not pay for it with a bend; and the final ranges agree on every proposed face, or on some of them and on no fewer faces
 * than the baseline. A refused trial that left a face stale carries the next proposal, which reads the trial's own final positions.
 */
export function judgeFarEndTrial(routedBase: LayoutModel, routedTrial: LayoutModel, keptPromises: ReadonlyMap<string, number>, proposed: readonly FarEndFace[], published: PublishedCanvas,
  decisions?: ReadonlyMap<string, FarEndDecisionEntry>): FarEndVerdict {
  const was = names(staleFaces(routedBase, undefined, decisions)), now = names(staleFaces(routedTrial)), asked = names(proposed);
  const before = was.size, after = now.size;
  const open = [...asked].filter(face => now.has(face));
  const fresh = [...now].filter(face => !was.has(face));
  // What the next trial reads: the faces of this trial that settled, kept, and every face that is stale on the trial's own final positions, sorted again from them.
  const refuse = (reason: string, clause: NonNullable<FarEndVerdict['clause']>, decline?: FarEndDeclineReason): FarEndVerdict => {
    const next = open.length > 0 || fresh.length > 0 ? proposeFarEndOrder(routedTrial, proposed.filter(face => !now.has(faceKey(face.node, face.side)))).faces : [];
    const tallies = clause === 'unified' || clause === 'guard' ? trialCounts(routedBase, routedTrial) : undefined;
    // A unified decline is a completed comparison: it decides only with both tallies read.
    const decides = decline !== undefined && (decline !== 'unified' || tallies !== undefined);
    return { kept: false, reason, clause, ...(decides ? { decline } : {}), ...(next.length > 0 ? { next } : {}), before, after, ...(tallies === undefined ? {} : { tallies }) };
  };
  if (fresh.length > 0) return refuse(`the trial leaves faces out of far-end order that the baseline had in order (${fresh.join(', ')})`, 'fresh');
  // The published canvas of both candidates, labels and legend included (R1: the extent that publishes, not the one the route leaves).
  let grown: FarEndVerdict['canvas'], capped = false;
  const canvasRefusal = (base: LayoutModel, trial: LayoutModel): string | undefined => {
    const was = published(base), now = published(trial);
    if (was === undefined || now === undefined || !(was.width * was.height > 0)) return 'the published canvas of a candidate cannot be read';
    const ratio = (now.width * now.height) / (was.width * was.height);
    if (ratio > 1 + PLACEMENT_EPS) grown = { from: { width: was.width, height: was.height }, to: { width: now.width, height: now.height } };
    capped = ratio > FAR_END_CANVAS_GROWTH + PLACEMENT_EPS;
    return capped ? `the published canvas grows from ${Math.round(was.width)}x${Math.round(was.height)} to ${Math.round(now.width)}x${Math.round(now.height)} px` : undefined;
  };
  const guarded = guardRoutedTrialKind(routedBase, routedTrial, keptPromises, canvasRefusal);
  if ('kind' in guarded) return refuse(guarded.reason, 'guard', guarded.kind === 'gate-finding' ? 'gate-finding' : guarded.kind === 'canvas' && capped ? 'canvas-cap' : undefined);
  const { before: was3, after: now3, order } = unifiedOrder(guarded);
  if (order > 0) return refuse(`the routed trial is worse by the unified order (${now3.bent} bent links, ${now3.turns} turns, ${now3.crossings} crossings, against ${was3.bent}, ${was3.turns} and ${was3.crossings})`, 'unified', 'unified');
  // A face the new order did not settle stays out of order as it was on the baseline: the trial is kept when it settles more faces than it leaves (no face is worse), and the round
  // goes on with the faces left. A trial that settles none is refused.
  if (open.length > 0 && after >= before) return refuse(`the final far ends of ${open.join(', ')} disagree with the proposed order`, 'open');
  return { kept: true, reason: '', before, after, ...(grown === undefined ? {} : { canvas: grown }) };
}
